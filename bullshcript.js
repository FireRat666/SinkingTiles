(function () {
    let scene;

    // --- Configuration ---
    const STATE_KEY = "sinking_tiles_state_v2";
    const STATS_PREFIX = "st_user:";   // per-user stats (kept from the old version)
    const JOIN_PREFIX = "st_join:";    // "1" = wants to play the next game
    const SUNK_PREFIX = "st_sunk:";    // {g: gameId, t: [tile indexes]} tiles this player sank
    const OUT_PREFIX = "st_out:";      // gameId the player fell out of

    // Both sizes cover the same 24 m square.
    const GRID_MODES = { normal: { n: 8, size: 3, label: "8x8" }, small: { n: 12, size: 2, label: "12x12" } };
    const FOOT_RADIUS = 0.45;  // how far from your centre a tile still counts as under you
    const TILE_THICKNESS = 0.4;
    const ARENA_TOP_Y = 20;
    const LAYER_GAP = 5;
    const HALF = 12;
    const LOBBY = { x: 0, y: 0.1, z: -40 };

    const LAYER_OPTIONS = [1, 3, 5];
    const SINK_OPTIONS = [500, 700, 1000];
    const LAYER_COLORS = [
        [0.2, 0.6, 1, 1], [0.2, 0.85, 0.4, 1], [1, 0.85, 0.2, 1], [1, 0.55, 0.15, 1], [0.9, 0.25, 0.3, 1]
    ];
    const STEPPED_COLOR = [0.85, 0.85, 0.85, 1];
    const TICK_URL = "https://audiofiles.firer.at/mp3/Tick.mp3";

    const TIMINGS = {
        LOBBY_COUNTDOWN: 10000,
        GET_READY: 4000,
        GAME_OVER: 6000,
        MAX_GAME: 10 * 60 * 1000,
        LEFT_ARENA: 2000
    };

    // --- State ---
    let gameState = { status: "LOBBY", phaseId: 0, gameId: 0, players: [], numLayers: 3, sinkDelay: 700, gridMode: "normal", host: null, winner: null };
    let lastPhaseId = -1;
    let phaseStartLocal = 0;
    let hostPending = null;

    const grids = {};          // mode -> { root, layerRoots, built, tiles: index -> { obj, mat, ... } }

    let localPose = null;      // { x, y, z } from pose-update
    let mySunk = [];           // tiles you sank this game
    let mySunkGame = 0;
    let wasOut = false;
    let outsideSince = 0;
    let arrived = false;       // seen standing in the arena since the teleport this game
    let activeStartLocal = 0;
    let creditedWinGame = 0;
    let isMuted = false;
    let audio = null;

    const ui = { statusLabels: [], sizeBtn: null, joinBtn: null, muteBtn: null, hostObj: null, hostRoot: null, layersBtn: null, sinkBtn: null, startBtn: null, board: null, tabs: {}, tab: "wins", hostVisible: null };
    const textCache = new Map();

    // --- Utils ---
    const now = () => Date.now();
    const v3 = (x, y, z) => new BS.Vector3(x, y, z);
    const v4 = (c) => new BS.Vector4(c[0], c[1], c[2], c[3]);
    const pub = () => (scene.spaceState && scene.spaceState.public) || {};
    const localUid = () => scene.localUser && scene.localUser.uid;
    const cleanName = (n) => String(n || "Someone").replace(/<[^>]*>/g, "");

    const hostUid = () => {
        if (!scene || !scene.users) return null;
        if (gameState.host && scene.users[gameState.host]) return gameState.host;
        const uids = Object.keys(scene.users).sort();
        return uids[0] || null;
    };
    const isHost = () => !!localUid() && hostUid() === localUid();
    const userName = (uid) => (scene.users[uid] ? cleanName(scene.users[uid].name) : "Someone");

    const layerTopY = (l) => ARENA_TOP_Y - l * LAYER_GAP + TILE_THICKNESS / 2;

    function setText(el, key, text) {
        if (!el || textCache.get(key) === text) return;
        textCache.set(key, text);
        el.text = text;
    }

    function play() {
        if (!isMuted && audio) audio.PlayOneShotFromUrl(TICK_URL);
    }

    // --- Initialization ---
    async function init() {
        if (scene) return;
        scene = BS.BanterScene.GetInstance();
        console.log("Sinking Tiles: starting");

        const settings = new BS.SceneSettings();
        settings.EnableTeleport = false;
        settings.EnableJump = true;
        settings.EnableHandHold = false;
        settings.MaxOccupancy = 30;
        settings.RefreshRate = 72;
        settings.ClippingPlane = new BS.Vector2(0.05, 500);
        settings.SpawnPoint = new BS.Vector4(LOBBY.x, LOBBY.y, LOBBY.z, 0);
        // A bit quicker than the defaults (3.25 / 4.6 / 2.4 / 1) so you can outrun the sinking tiles.
        settings.PhysicsMoveSpeed = 4.25;
        settings.PhysicsMoveAcceleration = 6;
        settings.PhysicsAirControlSpeed = 3.2;
        settings.PhysicsJumpStrength = 1.25;
        // Stop other scripts or menus changing these.
        settings.SettingsLocked = true;
        settings.PhysicsSettingsLocked = true;
        await scene.SetSettings(settings);

        if (!scene.unityLoaded) {
            await new Promise(resolve => {
                scene.On("unity-loaded", resolve);
                window.addEventListener("unity-loaded", resolve, { once: true });
            });
        }
        console.log("Sinking Tiles: Unity loaded");

        await buildLobby();
        await buildArenaUI();
        await ensureGrid();
        const audioRoot = await new BS.GameObject({ name: "STAudio" }).Async();
        audio = await audioRoot.AddComponent(new BS.BanterAudioSource({ volume: 0.3, loop: false, playOnAwake: false }));

        scene.On("pose-update", (e) => {
            const h = e && e.detail && e.detail.head;
            if (h && h.position) {
                // On desktop this is about foot height; in VR it's the real head (tilesUnder allows for both).
                localPose = { x: h.position.x, y: h.position.y, z: h.position.z };
            }
        });
        scene.On("space-state-changed", () => sync());

        while (!localUid()) await new Promise(r => setTimeout(r, 300));

        scene.TeleportTo(v3(LOBBY.x, LOBBY.y, LOBBY.z), 0, true);
        sync();
        setInterval(tick, 100);
        setInterval(() => { if (isHost()) hostTick(); }, 250);
        setInterval(updateUI, 250);
        console.log("Sinking Tiles: ready");
    }

    // --- Tiles ---
    // One grid per tile size, built the first time it's needed. Layers are built on demand too
    // (1, 3 or 5), each under its own parent so a whole layer can be hidden.
    const gridOf = (mode) => {
        const m = GRID_MODES[mode] ? mode : "normal";
        if (!grids[m]) grids[m] = { mode: m, ...GRID_MODES[m], root: null, layerRoots: [], built: 0, tiles: [] };
        return grids[m];
    };
    const grid = () => gridOf(gameState.gridMode);
    const tileIndex = (g, l, x, z) => l * g.n * g.n + x * g.n + z;
    const tileCentre = (g, x, z) => ({ x: x * g.size - HALF + g.size / 2, z: z * g.size - HALF + g.size / 2 });

    let buildQueue = Promise.resolve();
    function ensureGrid() {
        const g = grid(), count = gameState.numLayers;
        buildQueue = buildQueue.then(async () => {
            if (!g.root) g.root = await new BS.GameObject({ name: `STGrid_${g.mode}` }).Async();
            for (let l = g.built; l < count; l++) { await buildLayer(g, l); g.built = l + 1; }
            showGrid();
        }).catch(err => console.warn("Sinking Tiles: grid build failed", err));
        showGrid();
        return buildQueue;
    }

    async function buildLayer(g, l) {
        const root = await new BS.GameObject({ name: `STLayer_${g.mode}_${l}`, parent: g.root, localPosition: v3(0, ARENA_TOP_Y - l * LAYER_GAP, 0) }).Async();
        g.layerRoots[l] = root;
        const color = LAYER_COLORS[l % LAYER_COLORS.length];
        const w = g.size - 0.1;
        const jobs = [];
        for (let x = 0; x < g.n; x++) {
            for (let z = 0; z < g.n; z++) {
                jobs.push((async () => {
                    const idx = tileIndex(g, l, x, z);
                    const c = tileCentre(g, x, z);
                    const name = `STTile_${g.mode}_${l}_${x}_${z}`;
                    const obj = await new BS.GameObject({ name, parent: root, localPosition: v3(c.x, 0, c.z) }).Async();
                    await obj.AddComponent(new BS.BanterBox({ width: w, height: TILE_THICKNESS, depth: w }));
                    await obj.AddComponent(new BS.BoxCollider({ size: v3(w, TILE_THICKNESS, w) }));
                    // Unique cacheBust so each tile gets its own material and can change colour alone.
                    const mat = await obj.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: v4(color), cacheBust: name }));
                    // Stored by index, so the order the parallel creates finish in doesn't matter.
                    g.tiles[idx] = { obj, mat, layer: l, color, sunk: false, hidden: false, grey: false, timer: null };
                })());
            }
        }
        await Promise.all(jobs);
    }

    // Only the current tile size's grid, and only the layers in use, are shown.
    function showGrid() {
        const cur = grid();
        for (const g of Object.values(grids)) {
            const on = g === cur;
            if (g.root && g.root._stShown !== on) { g.root._stShown = on; g.root.SetActive(on); }
            g.layerRoots.forEach((root, l) => {
                const want = l < gameState.numLayers;
                if (root && root._stShown !== want) { root._stShown = want; root.SetActive(want); }
            });
        }
    }

    function resetTiles() {
        for (const g of Object.values(grids)) {
            g.tiles.forEach(t => {
                if (!t) return;
                if (t.timer) { clearTimeout(t.timer); t.timer = null; }
                t.sunk = false;
                if (t.grey) { t.grey = false; t.mat.color = v4(t.color); }
                if (t.hidden) { t.hidden = false; t.obj.SetActive(true); }
            });
        }
    }

    function sinkTile(idx, mine) {
        const t = grid().tiles[idx];
        if (!t || t.sunk) return false;
        t.sunk = true;
        t.grey = true;
        t.mat.color = v4(STEPPED_COLOR);
        if (mine) play();
        t.timer = setTimeout(() => {
            t.timer = null;
            if (t.sunk && !t.hidden) { t.hidden = true; t.obj.SetActive(false); }
        }, gameState.sinkDelay || 700);
        return true;
    }

    // Every tile your body could be resting on: all tiles within FOOT_RADIUS of your position, so
    // standing on a seam or corner sinks every tile you touch. Empty if you're not on a layer.
    function tilesUnder(p) {
        if (!p) return [];
        let layer = -1;
        for (let l = 0; l < gameState.numLayers; l++) {
            const above = p.y - layerTopY(l);
            if (above > -0.4 && above < 2.6) { layer = l; break; } // desktop reports ~feet, VR the real head
        }
        if (layer < 0) return [];
        const g = grid(), out = [];
        const lo = (v) => Math.max(0, Math.floor((v - FOOT_RADIUS + HALF) / g.size));
        const hi = (v) => Math.min(g.n - 1, Math.floor((v + FOOT_RADIUS + HALF) / g.size));
        for (let x = lo(p.x); x <= hi(p.x); x++) {
            for (let z = lo(p.z); z <= hi(p.z); z++) {
                // Distance from you to the nearest point of this tile's cell.
                const x0 = x * g.size - HALF, z0 = z * g.size - HALF;
                const dx = Math.max(x0 - p.x, 0, p.x - (x0 + g.size));
                const dz = Math.max(z0 - p.z, 0, p.z - (z0 + g.size));
                if (dx * dx + dz * dz <= FOOT_RADIUS * FOOT_RADIUS) out.push(tileIndex(g, layer, x, z));
            }
        }
        return out;
    }

    // --- Per-tick: sink the tile you're on (even if you never move), and detect falls ---
    function tick() {
        const me = localUid();
        if (!me || !localPose) return;
        const playing = (gameState.players || []).includes(me) && !wasOut;

        if (gameState.status === "ACTIVE" && playing) {
            if (mySunkGame !== gameState.gameId) { mySunkGame = gameState.gameId; mySunk = []; }
            let changed = false;
            for (const idx of tilesUnder(localPose)) {
                if (sinkTile(idx, !changed)) { mySunk.push(idx); changed = true; }
            }
            if (changed) scene.SetPublicSpaceProps({ [SUNK_PREFIX + me]: JSON.stringify({ g: gameState.gameId, t: mySunk }) });
        }

        if ((gameState.status === "ACTIVE" || gameState.status === "STARTING") && playing) {
            const bottom = layerTopY(gameState.numLayers - 1);
            const inside = Math.abs(localPose.x) < HALF + 2 && Math.abs(localPose.z) < HALF + 2;
            // Position updates lag the teleport, so only judge falls once you've been seen up there.
            if (!arrived) {
                if (inside && localPose.y > bottom) arrived = true;
                else if (gameState.status === "ACTIVE" && now() - activeStartLocal > 5000) localOut("never reached the arena");
                return;
            }
            if (localPose.y < bottom - 4) {
                localOut("fell");
            } else if (!inside && gameState.status === "ACTIVE") {
                if (!outsideSince) outsideSince = now();
                else if (now() - outsideSince > TIMINGS.LEFT_ARENA) localOut("left the arena");
            } else {
                outsideSince = 0;
            }
        } else if (localPose.y < -20) {
            // Anyone falling for any other reason goes back to the lobby.
            scene.TeleportTo(v3(LOBBY.x, LOBBY.y, LOBBY.z), 0, true);
        }
    }

    function localOut(why) {
        const me = localUid();
        if (wasOut) return;
        wasOut = true;
        outsideSince = 0;
        const survived = gameState.status === "ACTIVE" && activeStartLocal ? now() - activeStartLocal : 0;
        console.log(`Sinking Tiles: you ${why} after ${(survived / 1000).toFixed(1)}s`);
        scene.SetPublicSpaceProps({ [OUT_PREFIX + me]: String(gameState.gameId) });
        updateMyStats({ fall: true, survived });
        play();
        scene.TeleportTo(v3(LOBBY.x, LOBBY.y, LOBBY.z), 0, true);
    }

    function updateMyStats({ fall, win, survived, gameId }) {
        const me = localUid();
        const key = STATS_PREFIX + me;
        let stats = { uid: me, name: "", falls: 0, bestSurvival: 0, wins: 0 };
        try { if (pub()[key]) stats = { ...stats, ...JSON.parse(pub()[key]) }; } catch (e) { }
        if (win && stats.lastWin === gameId) return; // already counted (e.g. after a reload)
        stats.name = cleanName(scene.localUser.name);
        if (fall) stats.falls = (stats.falls || 0) + 1;
        if (win) { stats.wins = (stats.wins || 0) + 1; stats.lastWin = gameId; }
        if (survived > (stats.bestSurvival || 0)) stats.bestSurvival = survived;
        scene.SetPublicSpaceProps({ [key]: JSON.stringify(stats) });
    }

    // --- Shared state ---
    // newPhase=false changes settings/players without restarting the current phase's timer.
    function setState(patch, newPhase = true) {
        const next = { ...gameState, ...patch, rev: (gameState.rev || 0) + 1 };
        if (newPhase) next.phaseId = (gameState.phaseId || 0) + 1;
        // Every write is built from the last state the server confirmed, so wait for this one
        // to come back before the host decides anything else (the old version raced here).
        hostPending = { rev: next.rev, at: now() };
        scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(next) });
    }

    function sync() {
        const p = pub();
        const raw = p[STATE_KEY];
        if (raw) {
            let s = null;
            try { s = JSON.parse(raw); } catch (e) { }
            if (s) {
                const prev = gameState;
                if (!SINK_OPTIONS.includes(s.sinkDelay)) s.sinkDelay = 700; // old saved values (0.3s / 1.5s)
                gameState = s;
                if (s.numLayers !== prev.numLayers || s.gridMode !== prev.gridMode || grid().built < s.numLayers) ensureGrid();
                if (s.phaseId !== lastPhaseId) {
                    lastPhaseId = s.phaseId;
                    phaseStartLocal = now();
                    onPhase(prev, s);
                }
            }
        }
        // Tiles other players sank this game.
        if (gameState.status === "ACTIVE" || gameState.status === "GAME_OVER") {
            for (const key of Object.keys(p)) {
                if (!key.startsWith(SUNK_PREFIX) || key === SUNK_PREFIX + localUid()) continue;
                let d = null;
                try { d = JSON.parse(p[key]); } catch (e) { }
                if (d && d.g === gameState.gameId && Array.isArray(d.t)) d.t.forEach(i => sinkTile(i, false));
            }
        }
        updateUI();
    }

    async function onPhase(prev, s) {
        const me = localUid();
        const playing = (s.players || []).includes(me);

        if (s.status === "STARTING" && s.gameId !== prev.gameId) {
            resetTiles();
            wasOut = false;
            outsideSince = 0;
            arrived = false;
            mySunk = [];
            mySunkGame = s.gameId;
            if (playing) {
                const i = s.players.indexOf(me);
                const g = grid();
                const spot = spawnSpot(g, i);
                const c = tileCentre(g, spot.x, spot.z);
                const yaw = ((Math.atan2(-c.x, -c.z) * 180 / Math.PI) + 360) % 360; // face the middle
                scene.TeleportTo(v3(c.x, layerTopY(0) + 0.3, c.z), yaw, true);
                scene.SetPublicSpaceProps({ [JOIN_PREFIX + me]: "0" });
            }
            play();
        }
        if (s.status === "ACTIVE" && prev.status !== "ACTIVE") {
            activeStartLocal = now();
            play();
        }
        if (s.status === "GAME_OVER" && prev.status !== "GAME_OVER") {
            console.log("Sinking Tiles: game over, winner " + (s.winner ? userName(s.winner) : "none"));
            if (s.winner === me && creditedWinGame !== s.gameId) {
                creditedWinGame = s.gameId;
                updateMyStats({ win: true, gameId: s.gameId, survived: activeStartLocal ? now() - activeStartLocal : 0 });
            } else if (playing && !wasOut && activeStartLocal) {
                // Solo game ended or you were the last one up: keep your time.
                updateMyStats({ survived: now() - activeStartLocal });
            }
        }
        if (s.status === "LOBBY" && prev.status !== "LOBBY") {
            if ((prev.players || []).includes(me) && !wasOut) scene.TeleportTo(v3(LOBBY.x, LOBBY.y, LOBBY.z), 0, true);
            activeStartLocal = 0;
            resetTiles();
        }
    }

    // Spread players out over the top layer: every other tile first, then the gaps.
    function spawnSpot(g, i) {
        const spots = [];
        for (const off of [0, 1]) {
            for (let x = off; x < g.n; x += 2) for (let z = off; z < g.n; z += 2) spots.push({ x, z });
        }
        return spots[i % spots.length];
    }

    // --- Host: runs the phases ---
    function hostTick() {
        if (hostPending && (gameState.rev || 0) < hostPending.rev && now() - hostPending.at < 3000) return;
        hostPending = null;
        const p = pub();
        const elapsed = now() - phaseStartLocal;
        const present = Object.keys(scene.users);
        const joined = present.filter(uid => p[JOIN_PREFIX + uid] === "1").sort();

        switch (gameState.status) {
            case "LOBBY":
                if (joined.length > 0) setState({ status: "COUNTDOWN", players: joined, winner: null });
                break;
            case "COUNTDOWN":
                if (joined.length === 0) setState({ status: "LOBBY", players: [] });
                else if (elapsed >= TIMINGS.LOBBY_COUNTDOWN) startGame(joined);
                else if (joined.join() !== (gameState.players || []).join()) setState({ players: joined }, false); // keep the countdown running
                break;
            case "STARTING":
                if (elapsed >= TIMINGS.GET_READY) setState({ status: "ACTIVE" });
                break;
            case "ACTIVE": {
                const players = gameState.players || [];
                const alive = players.filter(uid => scene.users[uid] && p[OUT_PREFIX + uid] !== String(gameState.gameId));
                if (players.length >= 2 && alive.length === 1) setState({ status: "GAME_OVER", winner: alive[0] });
                else if (alive.length === 0) setState({ status: "GAME_OVER", winner: null });
                else if (elapsed > TIMINGS.MAX_GAME) setState({ status: "GAME_OVER", winner: null });
                break;
            }
            case "GAME_OVER":
                if (elapsed >= TIMINGS.GAME_OVER) setState({ status: "LOBBY", players: [], winner: null });
                break;
            default:
                setState({ status: "LOBBY", players: [] });
        }
    }

    function startGame(uids) {
        setState({ status: "STARTING", gameId: now(), players: uids.slice().sort(), winner: null });
        console.log("Sinking Tiles: game starting with " + uids.map(userName).join(", "));
    }

    // --- UI (BanterUI panels, same style as Drop and HaH) ---
    const PANEL_BG = '#1a1c29';
    const roundCorners = { borderTopLeftRadius: '10px', borderTopRightRadius: '10px', borderBottomRightRadius: '10px', borderBottomLeftRadius: '10px' };

    async function makePanel(name, parent, pos, rot, size, scale, rootStyles) {
        const obj = await new BS.GameObject({ name, parent, localPosition: pos, localEulerAngles: rot, localScale: scale || v3(1, 1, 1) }).Async();
        const panel = await obj.AddComponent(new BS.BanterUI(new BS.Vector2(size[0], size[1]), false));
        const root = panel.CreateVisualElement();
        await root.Async();
        root.SetStyles({
            width: '100%', height: '100%', backgroundColor: PANEL_BG, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            paddingTop: '16px', paddingRight: '16px', paddingBottom: '16px', paddingLeft: '16px',
            ...roundCorners, ...(rootStyles || {})
        });
        return { obj, panel, root };
    }

    async function makeLabel(panel, parent, text, styles) {
        const label = panel.CreateLabel(undefined, parent);
        await label.Async();
        label.text = text;
        label.SetStyles({ color: '#ffffff', backgroundColor: 'rgba(0,0,0,0)', textAlign: 'center', whiteSpace: 'normal', ...styles });
        return label;
    }

    async function makeButton(panel, parent, text, color, handler, styles) {
        const btn = panel.CreateButton(parent);
        await btn.Async();
        btn.text = text;
        btn.SetStyles({
            height: '60px', fontSize: '18px', backgroundColor: color, color: '#ffffff',
            marginRight: '6px', marginLeft: '6px', paddingTop: '0px', paddingRight: '14px', paddingBottom: '0px', paddingLeft: '14px',
            ...(styles || {})
        });
        btn.OnClick(() => {
            btn.SetStyles({ backgroundColor: '#555555' });
            setTimeout(() => btn.SetStyles({ backgroundColor: color }), 150);
            handler();
        });
        return btn;
    }

    async function buildLobby() {
        const floor = await new BS.GameObject({ name: "STLobby", localPosition: v3(LOBBY.x, LOBBY.y - 0.3, LOBBY.z) }).Async();
        await floor.AddComponent(new BS.BanterBox({ width: 30, height: 0.5, depth: 30 }));
        await floor.AddComponent(new BS.BoxCollider({ size: v3(30, 0.5, 30) }));
        await floor.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.1, 0.1, 0.1, 1) }));

        // Status
        const status = await makePanel("STStatusUI", floor, v3(0, 3.8, 8), v3(0, 0, 0), [800, 150]);
        ui.statusLabels.push(await makeLabel(status.panel, status.root, "SINKING TILES", { fontSize: '34px', color: '#ffcc00' }));

        // Rules
        const rules = await makePanel("STRulesUI", floor, v3(-12, 2.7, 0), v3(0, -90, 0), [630, 430], null, { justifyContent: 'flex-start' });
        await makeLabel(rules.panel, rules.root, "HOW TO PLAY", { fontSize: '28px', color: '#ffcc00', marginBottom: '14px' });
        await makeLabel(rules.panel, rules.root,
            "1. Press JOIN GAME. The game starts 10 seconds after the first player joins.\n" +
            "2. Every tile you stand on turns grey and drops away, even if you stand still.\n" +
            "3. Keep moving! Fall through a hole and you land on the layer below.\n" +
            "4. Fall through the bottom layer and you're out.\n" +
            "5. Last player standing wins. Playing alone? Survive as long as you can.\n\n" +
            "HOST CONTROLS (lobby only):\n" +
            "- Layers: 1, 3 or 5 layers of tiles.\n" +
            "- Tiles: big 8x8 tiles or small 12x12 tiles.\n" +
            "- Sink: how fast a stepped-on tile drops.\n" +
            "- Start Now: skip the countdown.  Reset: end the game.\n" +
            "- Claim Host: take over if the host has left.",
            { fontSize: '18px' });

        // Player controls
        const controls = await makePanel("STControlsUI", floor, v3(0, 1.1, 3), v3(0, 0, 0), [560, 90], null, { flexDirection: 'row' });
        ui.joinBtn = await makeButton(controls.panel, controls.root, "JOIN GAME", '#0080ff', () => {
            const me = localUid();
            const joined = pub()[JOIN_PREFIX + me] === "1";
            scene.SetPublicSpaceProps({ [JOIN_PREFIX + me]: joined ? "0" : "1" });
        });
        ui.muteBtn = await makeButton(controls.panel, controls.root, "SOUND: ON", '#8033cc', () => {
            isMuted = !isMuted;
            setText(ui.muteBtn, "mute", isMuted ? "SOUND: OFF" : "SOUND: ON");
        });
        await makeButton(controls.panel, controls.root, "CLAIM HOST", '#e69900', () => {
            const me = scene.localUser;
            const claimed = gameState.host && scene.users[gameState.host];
            if (!claimed || me.isSpaceAdmin) {
                gameState.host = me.uid; // so the panel shows straight away
                setState({ host: me.uid }, false);
            }
        });

        // Host controls (hidden unless you're the host)
        const host = await makePanel("STHostUI", floor, v3(0, 2.1, 3), v3(0, 0, 0), [880, 90], null, { flexDirection: 'row' });
        ui.hostObj = host.obj;
        ui.hostRoot = host.root;
        const inLobby = () => gameState.status === "LOBBY" || gameState.status === "COUNTDOWN";
        ui.layersBtn = await makeButton(host.panel, host.root, "LAYERS: 3", '#1180cc', () => {
            if (!isHost() || !inLobby()) return;
            const i = LAYER_OPTIONS.indexOf(gameState.numLayers);
            setState({ numLayers: LAYER_OPTIONS[(i + 1) % LAYER_OPTIONS.length] }, false);
        });
        ui.sizeBtn = await makeButton(host.panel, host.root, "TILES: 8x8", '#7a3dcc', () => {
            if (!isHost() || !inLobby()) return;
            setState({ gridMode: gameState.gridMode === "small" ? "normal" : "small" }, false);
        });
        ui.sinkBtn = await makeButton(host.panel, host.root, "SINK: 0.7s", '#cc7a11', () => {
            if (!isHost() || !inLobby()) return;
            const i = SINK_OPTIONS.indexOf(gameState.sinkDelay);
            setState({ sinkDelay: SINK_OPTIONS[(i + 1) % SINK_OPTIONS.length] }, false);
        });
        ui.startBtn = await makeButton(host.panel, host.root, "START NOW", '#1a801a', () => {
            if (!isHost()) return;
            const joined = Object.keys(scene.users).filter(uid => pub()[JOIN_PREFIX + uid] === "1").sort();
            if (inLobby() && joined.length > 0) startGame(joined);
        });
        await makeButton(host.panel, host.root, "RESET", '#808080', () => {
            if (!isHost()) return;
            setState({ status: "LOBBY", players: [], winner: null });
        });

        // Scoreboard
        const board = await makePanel("STScoreUI", floor, v3(12, 2.5, 0), v3(0, 90, 0), [500, 470], null, { justifyContent: 'flex-start', alignItems: 'stretch' });
        const tabsRow = board.panel.CreateVisualElement(board.root);
        await tabsRow.Async();
        tabsRow.SetStyles({ display: 'flex', flexDirection: 'row', justifyContent: 'center', marginBottom: '14px' });
        for (const [id, label] of [["wins", "MOST WINS"], ["survival", "BEST TIME"], ["falls", "MOST FALLS"]]) {
            ui.tabs[id] = await makeButton(board.panel, tabsRow, label, id === ui.tab ? '#0080ff' : '#333333', () => {
                ui.tab = id;
                for (const k of Object.keys(ui.tabs)) ui.tabs[k].SetStyles({ backgroundColor: k === id ? '#0080ff' : '#333333' });
                updateScoreboard();
            }, { height: '44px', fontSize: '15px' });
        }
        const content = board.panel.CreateVisualElement(board.root);
        await content.Async();
        content.SetStyles({ display: 'flex', flexDirection: 'column', flexGrow: '1', backgroundColor: '#0d0f17', paddingTop: '10px', paddingRight: '14px', paddingBottom: '10px', paddingLeft: '14px' });
        ui.board = await makeLabel(board.panel, content, "No records yet", { fontSize: '19px', textAlign: 'left' });
    }

    // Status panels high above the arena, one per side, readable from the tiles.
    async function buildArenaUI() {
        const anchor = await new BS.GameObject({ name: "STArenaUI", localPosition: v3(0, ARENA_TOP_Y + 7, 0) }).Async();
        const sides = [[v3(0, 0, 16), 0], [v3(0, 0, -16), 180], [v3(16, 0, 0), 90], [v3(-16, 0, 0), -90]];
        for (const [pos, yaw] of sides) {
            const p = await makePanel("STArenaStatus", anchor, pos, v3(0, yaw, 0), [800, 150], v3(3, 3, 3));
            ui.statusLabels.push(await makeLabel(p.panel, p.root, "SINKING TILES", { fontSize: '34px', color: '#ffcc00' }));
        }
    }

    function statusText() {
        const t = now();
        const players = gameState.players || [];
        const host = hostUid();
        const hostLine = host ? `Host: ${userName(host)}` : "";
        const names = players.map(userName).join(", ");
        switch (gameState.status) {
            case "COUNTDOWN": {
                const left = Math.max(0, Math.ceil((TIMINGS.LOBBY_COUNTDOWN - (t - phaseStartLocal)) / 1000));
                return `STARTING IN ${left}\n${names}`;
            }
            case "STARTING": {
                const left = Math.max(0, Math.ceil((TIMINGS.GET_READY - (t - phaseStartLocal)) / 1000));
                return `GET READY... ${left}\nEvery tile you touch will sink!`;
            }
            case "ACTIVE": {
                const p = pub();
                const alive = players.filter(uid => scene.users[uid] && p[OUT_PREFIX + uid] !== String(gameState.gameId));
                const secs = Math.floor((t - phaseStartLocal) / 1000);
                return `${alive.length} / ${players.length} STILL STANDING  (${secs}s)\n${alive.map(userName).join(", ")}`;
            }
            case "GAME_OVER":
                return gameState.winner ? `${userName(gameState.winner)} WINS!` : "GAME OVER";
            default:
                return `SINKING TILES\nPress JOIN GAME to play.  ${hostLine}`;
        }
    }

    function updateUI() {
        if (!scene || !ui.joinBtn) return;
        const s = statusText();
        ui.statusLabels.forEach((l, i) => setText(l, "status" + i, s));

        const me = localUid();
        const joined = pub()[JOIN_PREFIX + me] === "1";
        const inGame = (gameState.players || []).includes(me) && gameState.status !== "LOBBY" && gameState.status !== "COUNTDOWN";
        setText(ui.joinBtn, "join", inGame ? "IN GAME" : joined ? "LEAVE QUEUE" : "JOIN GAME");
        setText(ui.layersBtn, "layers", `LAYERS: ${gameState.numLayers}`);
        setText(ui.sizeBtn, "size", `TILES: ${GRID_MODES[gameState.gridMode]?.label || "8x8"}`);
        setText(ui.sinkBtn, "sink", `SINK: ${(gameState.sinkDelay / 1000)}s`);

        const host = isHost();
        if (ui.hostVisible !== host && ui.hostObj) {
            ui.hostVisible = host;
            // Moving + scaling is more reliable than SetActive for BanterUI (same as Drop).
            const tr = ui.hostObj.GetComponent(BS.CT.Transform);
            if (tr) {
                tr.localPosition = host ? v3(0, 2.1, 3) : v3(0, -100, 0);
                tr.localScale = host ? v3(1, 1, 1) : v3(0, 0, 0);
            }
            ui.hostRoot.SetStyles({ display: host ? 'flex' : 'none' });
        }
        updateScoreboard();
    }

    function updateScoreboard() {
        if (!ui.board) return;
        const p = pub();
        const rows = [];
        for (const key of Object.keys(p)) {
            if (!key.startsWith(STATS_PREFIX)) continue;
            try { rows.push(JSON.parse(p[key])); } catch (e) { }
        }
        const by = {
            wins: [(a, b) => (b.wins || 0) - (a.wins || 0), r => `${r.wins || 0}`, r => r.wins > 0],
            survival: [(a, b) => (b.bestSurvival || 0) - (a.bestSurvival || 0), r => `${((r.bestSurvival || 0) / 1000).toFixed(1)}s`, r => r.bestSurvival > 0],
            falls: [(a, b) => (b.falls || 0) - (a.falls || 0), r => `${r.falls || 0}`, r => r.falls > 0]
        }[ui.tab];
        const top = rows.filter(by[2]).sort(by[0]).slice(0, 12);
        const text = top.length ? top.map((r, i) => `${i + 1}. ${cleanName(r.name)}  -  ${by[1](r)}`).join("\n") : "No records yet";
        setText(ui.board, "board", text);
    }

    if (window.BS) init();
    else window.addEventListener("bs-loaded", init);
})();
