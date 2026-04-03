(function () {
    let scene;

    // --- Configuration ---
    const STATE_KEY = "sinking_tiles_game_state";
    const USER_DATA_KEY_PREFIX = "st_user:";
    const GRID_SIZE = 8;
    const TILE_SIZE = 3;
    const GAME_ARENA_TOP_Y = 20;
    const LAYER_HEIGHT_OFFSET = 5;
    const LOBBY_POS_RAW = { x: 0, y: 0.1, z: -40 };

    const DEFAULT_NUM_LAYERS = 3;
    const DEFAULT_SINK_DELAY_MS = 700;
    const STEPPED_COLOR_VEC = [0.8, 0.8, 0.8, 1]; // Light grey

    const TIMINGS = {
        GAME_OVER_DELAY: 5000
    };

    // --- State Variables ---
    let gameState = {
        status: "LOBBY", // LOBBY, ACTIVE, GAME_OVER
        numLayers: DEFAULT_NUM_LAYERS,
        sinkDelay: DEFAULT_SINK_DELAY_MS,
        playersAlive: {}, // uid -> true
        lastPlayerStanding: null
    };

    let tiles = [];
    let ui = { root: null, displays: [] };
    let audio = { tick: null };
    let isLocalInArena = false;
    let isMuted = false;
    let scoreboardFalls = null;
    let scoreboardSurvival = null;
    let scoreboardWins = null;
    let lastFallTime = 0;

    // Local player game session tracking
    let localGameStartTime = 0;

    // --- Utils ---
    const isHost = () => {
        if (!scene || !scene.localUser || !scene.users) return false;
        const uids = Object.keys(scene.users).sort();
        return uids.length > 0 && uids[0] === scene.localUser.uid;
    };

    // --- Initialization ---
    async function init() {
        if (scene) return;
        scene = BS.BanterScene.GetInstance();

        console.log("Sinking Tiles: Calling setupSettings before Unity load check.");
        setupSettings();

        if (!scene.unityLoaded) {
            console.log("Sinking Tiles: Waiting for Unity...");
            await new Promise(resolve => {
                scene.On("unity-loaded", resolve);
                window.addEventListener("unity-loaded", resolve, { once: true });
            });
        }
        console.log("Sinking Tiles: Unity Loaded!");

        await buildEnvironment();
        await buildGrid();
        await setupUI();
        await setupAudio();

        setupNetworking();

        setInterval(update, 100);
        console.log("Sinking Tiles: Init Complete");
    }

    function setupSettings() {
        const settings = new BS.SceneSettings();
        settings.EnableTeleport = true;
        settings.EnableJump = true;
        settings.MaxOccupancy = 30;
        settings.RefreshRate = 72;
        settings.ClippingPlane = new BS.Vector2(0.05, 500);
        settings.SpawnPoint = new BS.Vector4(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z, 0);

        console.log("Sinking Tiles: Applying scene settings.");
        scene.SetSettings(settings);
        scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);

        setTimeout(() => {
            console.log("Sinking Tiles: Re-applying settings via timeout.");
            scene.SetSettings(settings);
            scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);
        }, 2000);
    }

    async function buildEnvironment() {
        const root = await new BS.GameObject({ name: "Environment" }).Async();

        // Lobby Floor
        const floor = await new BS.GameObject({ name: "SpectatorLobby", parent: root, localPosition: new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y - 0.05, LOBBY_POS_RAW.z) }).Async();
        await floor.AddComponent(new BS.BanterBox({ width: 30, height: 0.5, depth: 30 }));
        await floor.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(30, 0.5, 30) }));
        await floor.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(0.1, 0.1, 0.1, 1) }));

        // Rules Text
        const rulesObj = await new BS.GameObject({ name: "RulesText", parent: floor, localPosition: new BS.Vector3(-12, 2, 0), localEulerAngles: new BS.Vector3(0, -90, 0) }).Async();
        await rulesObj.AddComponent(new BS.BanterText({
            text: "<size=1.5><b>SINKING TILES</b></size>\n\n1. Click <b>JOIN GAME</b> to start.\n2. Tiles break when you step on them.\n3. Don't fall through all layers!\n4. Last one standing wins.\n\n<color=#ffcc00>Host can adjust layers and delay.</color>",
            fontSize: 0.6,
            color: new BS.Vector4(1, 1, 1, 1),
            horizontalAlignment: BS.HorizontalAlignment.Left
        }));

        // Scoreboard
        const boardRoot = await new BS.GameObject({ name: "Scoreboards", parent: floor, localPosition: new BS.Vector3(12, 3, 0), localEulerAngles: new BS.Vector3(0, 90, 0) }).Async();

        const createBoard = async (name, x, label) => {
            const obj = await new BS.GameObject({ name: name, parent: boardRoot, localPosition: new BS.Vector3(0, 0, x) }).Async();
            return await obj.AddComponent(new BS.BanterText({
                text: `<b>${label}</b>\n\nWaiting...`,
                fontSize: 0.5,
                color: new BS.Vector4(1, 1, 1, 1),
                horizontalAlignment: BS.HorizontalAlignment.Center
            }));
        };

        scoreboardFalls = await createBoard("FallsBoard", -6, "MOST FALLS");
        scoreboardSurvival = await createBoard("SurvivalBoard", 0, "BEST SURVIVAL");
        scoreboardWins = await createBoard("WinsBoard", 6, "MOST WINS");

        // Controls
        const buttonGroup = await new BS.GameObject({ name: "Controls", parent: floor, localPosition: new BS.Vector3(0, 1, 0) }).Async();

        const createBtn = async (name, xPos, color, text, handler) => {
            const btn = await new BS.GameObject({ name: name, parent: buttonGroup, localPosition: new BS.Vector3(xPos, 0, 0) }).Async();
            await btn.AddComponent(new BS.BanterBox({ width: 2.2, height: 0.8, depth: 1.2 }));
            await btn.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(2.2, 0.8, 1.2) }));
            await btn.AddComponent(new BS.BanterMaterial({ color: color }));
            btn.SetLayer(5);

            const t = await new BS.GameObject({ name: name + "Text", parent: btn, localPosition: new BS.Vector3(0, 0.5, 0), localEulerAngles: new BS.Vector3(0, 0, 0) }).Async();
            await t.AddComponent(new BS.BanterText({
                text: text, fontSize: 1, color: new BS.Vector4(1, 1, 1, 1),
                horizontalAlignment: BS.HorizontalAlignment.Center, verticalAlignment: BS.VerticalAlignment.Middle
            }));

            btn.On("click", handler);
            return btn;
        };

        await createBtn("SinkDelayBtn", -9, new BS.Vector4(0.8, 0.5, 0.1, 1), "SINK: 0.7s", () => {
            if (!isHost()) return;
            let d = gameState.sinkDelay === 700 ? 300 : (gameState.sinkDelay === 300 ? 1500 : 700);
            updateState({ sinkDelay: d });
        });

        await createBtn("LayersBtn", -6, new BS.Vector4(0.1, 0.5, 0.8, 1), "LAYERS: 3", () => {
            if (!isHost()) return;
            let l = gameState.numLayers === 3 ? 5 : (gameState.numLayers === 5 ? 1 : 3);
            updateState({ numLayers: l });
        });

        await createBtn("JoinBtn", -3, new BS.Vector4(0, 0.5, 1, 1), "JOIN GAME", () => {
            console.log("Join Game clicked.");
            scene.TeleportTo(new BS.Vector3(0, GAME_ARENA_TOP_Y + 2, 0), 0, true);
            localGameStartTime = Date.now();
            if (isHost() && gameState.status === "LOBBY") {
                updateState({ status: "ACTIVE" });
            }
        });

        await createBtn("MuteBtn", 0, new BS.Vector4(0.5, 0.2, 0.8, 1), "MUTE AUDIO", async (e) => {
            isMuted = !isMuted;
            const btnObj = e.detail.object || await scene.Find("MuteBtn");
            const txt = await btnObj.GetComponent(BS.CT.BanterText) || (await scene.Find("MuteBtnText")).GetComponent(BS.CT.BanterText);
            if (txt) txt.text = isMuted ? "UNMUTE AUDIO" : "MUTE AUDIO";
        });

        await createBtn("ResetBtn", 3, new BS.Vector4(0.5, 0.5, 0.5, 1), "RESET GAME", () => {
            if (!isHost()) return;
            updateState({ status: "LOBBY", playersAlive: {}, lastPlayerStanding: null });
            resetGrid();
        });

        // Arena Tracker
        const arenaTracker = await new BS.GameObject({ name: "ArenaTracker", localPosition: new BS.Vector3(0, GAME_ARENA_TOP_Y - 5, 0) }).Async();
        await arenaTracker.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(GRID_SIZE * TILE_SIZE, 30, GRID_SIZE * TILE_SIZE) }));
        await arenaTracker.AddComponent(new BS.BanterColliderEvents());
        arenaTracker.On("trigger-enter", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                console.log("Local player in arena.");
                isLocalInArena = true;
                if (isHost()) {
                    let alive = { ...gameState.playersAlive, [e.detail.user.uid]: true };
                    updateState({ playersAlive: alive });
                    if (gameState.status === "LOBBY") updateState({ status: "ACTIVE" });
                }
            }
        });
        arenaTracker.On("trigger-exit", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                console.log("Local player left arena.");
                isLocalInArena = false;
                if (isHost()) {
                    let alive = { ...gameState.playersAlive };
                    delete alive[e.detail.user.uid];
                    updateState({ playersAlive: alive });
                }
            }
        });

        // Dead Zone (below lowest possible layer)
        const deadZone = await new BS.GameObject({ name: "DeadZone", localPosition: new BS.Vector3(0, -10, 0) }).Async();
        await deadZone.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(100, 2, 100) }));
        await deadZone.AddComponent(new BS.BanterColliderEvents());
        deadZone.On("trigger-enter", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                const now = Date.now();
                if (now - lastFallTime > 1000) {
                    lastFallTime = now;
                    console.log("Local player fell!");
                    updateUserStats(localGameStartTime > 0 ? now - localGameStartTime : 0);
                    localGameStartTime = 0;
                    scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);
                }
            }
        });
    }

    async function buildGrid() {
        tiles.forEach(t => t.obj.Destroy());
        tiles = [];
        const gridRoot = await new BS.GameObject({ name: "GridRoot", localPosition: new BS.Vector3(0, GAME_ARENA_TOP_Y, 0) }).Async();
        const offset = (GRID_SIZE * TILE_SIZE) / 2 - (TILE_SIZE / 2);

        for (let l = 0; l < gameState.numLayers; l++) {
            const ly = -l * LAYER_HEIGHT_OFFSET;
            for (let x = 0; x < GRID_SIZE; x++) {
                for (let z = 0; z < GRID_SIZE; z++) {
                    const tileName = `Tile_L${l}_${x}_${z}`;
                    const tile = await new BS.GameObject({
                        name: tileName, parent: gridRoot,
                        localPosition: new BS.Vector3(x * TILE_SIZE - offset, ly, z * TILE_SIZE - offset)
                    }).Async();
                    await tile.AddComponent(new BS.BanterBox({ width: TILE_SIZE - 0.1, height: 0.4, depth: TILE_SIZE - 0.1 }));
                    await tile.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(TILE_SIZE - 0.1, 0.4, TILE_SIZE - 0.1) }));
                    const mat = await tile.AddComponent(new BS.BanterMaterial("Unlit/Diffuse", "", new BS.Vector4(0.2, 0.6, 1, 1), BS.MaterialSide.Front, false, tileName));
                    await tile.AddComponent(new BS.BanterColliderEvents());
                    tile.On("trigger-enter", (e) => handleTileStep(e, tile, mat));
                    tiles.push({ obj: tile, mat: mat, isSinking: false });
                }
            }
        }
    }

    async function resetGrid() {
        console.log("Resetting Grid.");
        await buildGrid();
    }

    async function handleTileStep(e, tile, mat) {
        if (e.detail.user && e.detail.user.isLocal && !tile.isSinking && gameState.status === "ACTIVE") {
            tile.isSinking = true;
            mat.color = new BS.Vector4(STEPPED_COLOR_VEC[0], STEPPED_COLOR_VEC[1], STEPPED_COLOR_VEC[2], STEPPED_COLOR_VEC[3]);
            if (!isMuted) audio.tick.PlayOneShotFromUrl("https://audiofiles.firer.at/mp3/Tick.mp3");
            await new Promise(resolve => setTimeout(resolve, gameState.sinkDelay));
            tile.obj.SetActive(false);
        }
    }

    async function setupUI() {
        const uiAnchor = await new BS.GameObject({ name: "UIAnchor", localPosition: new BS.Vector3(0, GAME_ARENA_TOP_Y + 12, 0) }).Async();
        const createDisplay = async (name, pos, rot) => {
            const panel = await new BS.GameObject({ name: name, parent: uiAnchor, localPosition: pos, localEulerAngles: rot }).Async();
            const textObj = await new BS.GameObject({ name: "Label", parent: panel, localPosition: new BS.Vector3(0, 0, 0) }).Async();
            const textComp = await textObj.AddComponent(new BS.BanterText({ text: "SINKING TILES", fontSize: 12, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));
            return { text: textComp, obj: panel };
        };
        ui.displays = [
            await createDisplay("DisplayN", new BS.Vector3(0, 0, 15), new BS.Vector3(0, 0, 0)),
            await createDisplay("DisplayS", new BS.Vector3(0, 0, -15), new BS.Vector3(0, 180, 0)),
            await createDisplay("DisplayE", new BS.Vector3(15, 0, 0), new BS.Vector3(0, 90, 0)),
            await createDisplay("DisplayW", new BS.Vector3(-15, 0, 0), new BS.Vector3(0, -90, 0))
        ];
    }

    async function setupAudio() {
        const audioRoot = await new BS.GameObject({ name: "Audio" }).Async();
        audio.tick = await audioRoot.AddComponent(new BS.BanterAudioSource({ volume: 0.3, loop: false, playOnAwake: false }));
    }

    function setupNetworking() {
        scene.On("space-state-changed", (e) => {
            if (e.detail.changes.some(c => c.property === STATE_KEY)) sync();
            updateScoreboard();
        });
        sync();
        updateScoreboard();
    }

    async function sync() {
        const raw = scene.spaceState.public[STATE_KEY];
        if (!raw) return;
        const oldStatus = gameState.status;
        const oldLayers = gameState.numLayers;
        gameState = JSON.parse(raw);

        const sinkTxt = await (await scene.Find("SinkDelayBtnText"))?.GetComponent(BS.CT.BanterText);
        if (sinkTxt) sinkTxt.text = `SINK: ${gameState.sinkDelay / 1000}s`;
        const layerTxt = await (await scene.Find("LayersBtnText"))?.GetComponent(BS.CT.BanterText);
        if (layerTxt) layerTxt.text = `LAYERS: ${gameState.numLayers}`;

        if (oldLayers !== gameState.numLayers || (oldStatus === "GAME_OVER" && gameState.status === "LOBBY")) {
            resetGrid();
        }
    }

    function updateScoreboard() {
        if (!scoreboardFalls || !scoreboardSurvival || !scoreboardWins) return;
        const state = scene.spaceState.public;
        const players = [];
        Object.keys(state).forEach(key => {
            if (key.startsWith(USER_DATA_KEY_PREFIX)) {
                try { players.push(JSON.parse(state[key])); } catch (e) {}
            }
        });

        const updateBoard = (comp, title, sorted, formatter) => {
            let str = `<size=1.2><b>${title}</b></size>\n\n`;
            if (sorted.length === 0) str += "No records!";
            else sorted.forEach((p, i) => str += `${i+1}. ${p.name}: ${formatter(p)}\n`);
            comp.text = str;
        };

        updateBoard(scoreboardFalls, "MOST FALLS", [...players].sort((a,b)=>b.falls-a.falls).slice(0,10), p=>p.falls);
        updateBoard(scoreboardSurvival, "BEST SURVIVAL", [...players].sort((a,b)=>b.bestSurvival-a.bestSurvival).slice(0,10), p=>(p.bestSurvival/1000).toFixed(1)+"s");
        updateBoard(scoreboardWins, "MOST WINS", [...players].sort((a,b)=>b.wins-a.wins).slice(0,10), p=>p.wins);
    }

    function updateUserStats(survivalTime) {
        const uid = scene.localUser.uid;
        const key = USER_DATA_KEY_PREFIX + uid;
        let stats = { uid: uid, name: scene.localUser.name.replace(/<[^>]*>/g, ''), falls: 0, bestSurvival: 0, wins: 0 };
        const raw = scene.spaceState.public[key];
        if (raw) { try { stats = JSON.parse(raw); } catch(e) {} }
        stats.falls++;
        stats.name = scene.localUser.name.replace(/<[^>]*>/g, '');
        if (survivalTime > stats.bestSurvival) stats.bestSurvival = survivalTime;
        scene.SetPublicSpaceProps({ [key]: JSON.stringify(stats) });
    }

    function updateWinnerStats(winnerUid) {
        const key = USER_DATA_KEY_PREFIX + winnerUid;
        let stats = { uid: winnerUid, name: "Winner", falls: 0, bestSurvival: 0, wins: 0 };
        const raw = scene.spaceState.public[key];
        if (raw) { try { stats = JSON.parse(raw); } catch(e) {} }
        stats.wins++;
        scene.SetPublicSpaceProps({ [key]: JSON.stringify(stats) });
    }

    function update() {
        const now = Date.now();
        let displayStr = "";
        if (gameState.status === "LOBBY") displayStr = "SINKING TILES";
        else if (gameState.status === "ACTIVE") displayStr = `PLAYERS: ${Object.keys(gameState.playersAlive).length}`;
        else displayStr = gameState.lastPlayerStanding ? `${scene.users[gameState.lastPlayerStanding]?.name || "PLAYER"} WINS!` : "GAME OVER";

        ui.displays.forEach(d => d.text.text = displayStr);
        if (isHost()) driveHostLogic(now);
    }

    function driveHostLogic(now) {
        if (gameState.status === "ACTIVE") {
            const alive = Object.keys(gameState.playersAlive);
            if (alive.length === 1 && Object.keys(scene.users).length > 1) {
                updateState({ status: "GAME_OVER", lastPlayerStanding: alive[0] });
                updateWinnerStats(alive[0]);
                setTimeout(() => updateState({ status: "LOBBY", playersAlive: {}, lastPlayerStanding: null }), TIMINGS.GAME_OVER_DELAY);
            } else if (alive.length === 0) {
                updateState({ status: "LOBBY", playersAlive: {}, lastPlayerStanding: null });
            }
        }
    }

    function updateState(patch) {
        const next = { ...gameState, ...patch };
        scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(next) });
    }

    if (window.BS) init();
    else window.addEventListener("bs-loaded", init);
})();
