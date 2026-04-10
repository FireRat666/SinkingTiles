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
        GAME_OVER_DELAY: 5000,
        STARTUP_DELAY: 5000,
        HOST_STEAL_DURATION: 30000
    };

    // --- State Variables ---
    let gameState = {
        status: "LOBBY", // LOBBY, STARTING, ACTIVE, GAME_OVER
        numLayers: DEFAULT_NUM_LAYERS,
        sinkDelay: DEFAULT_SINK_DELAY_MS,
        playersAlive: {}, // uid -> true
        lastPlayerStanding: null,
        multiplayerSession: false,
        currentHostUid: null,
        hostStealStartTime: 0,
        hostStealRequesterUid: null,
        endTime: 0
    };

    let tiles = [];
    let ui = { root: null, displays: [] };
    let audio = { tick: null };
    let isLocalInArena = false;
    let isMuted = false;
    let scoreboardFalls = null;
    let scoreboardSurvival = null;
    let scoreboardWins = null;
    let hostDisplay = null;
    let lastFallTime = 0;

    // Local player game session tracking
    let localGameStartTime = 0;

    // --- Utils ---
    const isHost = () => {
        if (!scene || !scene.localUser) return false;
        if (!gameState.currentHostUid) {
            const uids = Object.keys(scene.users || {}).sort();
            return uids.length > 0 && uids[0] === scene.localUser.uid;
        }
        return gameState.currentHostUid === scene.localUser.uid;
    };

    // --- Initialization ---
    async function init() {
        if (scene) return;
        scene = BS.BanterScene.GetInstance();

        console.log("Sinking Tiles: BS Ready. Building Environment...");

        const settings = new BS.SceneSettings();
        settings.EnableTeleport = false;
        settings.EnableJump = true;
        settings.MaxOccupancy = 30;
        settings.RefreshRate = 72;
        settings.ClippingPlane = new BS.Vector2(0.05, 500);
        settings.SpawnPoint = new BS.Vector4(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z, 0);
        scene.SetSettings(settings);

        console.log("Sinking Tiles: Building environment objects...");
        await buildEnvironment();
        console.log("Sinking Tiles: Building grid...");
        await buildGrid();
        console.log("Sinking Tiles: Building UI...");
        await setupUI();
        console.log("Sinking Tiles: Building audio...");
        await setupAudio();

        if (!scene.unityLoaded) {
            console.log("Sinking Tiles: Waiting for Unity for user functions...");
            await new Promise(resolve => {
                scene.On("unity-loaded", resolve);
                window.addEventListener("unity-loaded", resolve, { once: true });
            });
        }
        console.log("Sinking Tiles: Unity is LOADED!");

        console.log("Sinking Tiles: Performing initial teleport and starting network sync.");
        scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);
        setupNetworking();
        setInterval(update, 100);
        console.log("Sinking Tiles: Init Complete");
    }

    async function buildEnvironment() {
        const root = await new BS.GameObject({ name: "Environment" }).Async();

        // Lobby Floor
        const floor = await new BS.GameObject({ name: "SpectatorLobby", parent: root, localPosition: new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y - 0.05, LOBBY_POS_RAW.z) }).Async();
        await floor.AddComponent(new BS.BanterBox({ width: 30, height: 0.5, depth: 30 }));
        await floor.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(30, 0.5, 30) }));
        await floor.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.1, 0.1, 0.1, 1) }));

        // Rules Text
        const rulesObj = await new BS.GameObject({ name: "RulesText", parent: floor, localPosition: new BS.Vector3(-12, 2, 0), localEulerAngles: new BS.Vector3(0, -90, 0) }).Async();
        await rulesObj.AddComponent(new BS.BanterText({
            text: "<size=1.5><b>SINKING TILES</b></size>\n\n1. Click <b>JOIN GAME</b> to start.\n2. Tiles break when you step on them.\n3. Don't fall through all layers!\n4. Last one standing wins.\n\n<color=#ffcc00>Host can adjust layers and delay.</color>",
            fontSize: 0.6,
            color: new BS.Vector4(1, 1, 1, 1),
            horizontalAlignment: BS.HorizontalAlignment.Left
        }));

        // Host Display
        const hostObj = await new BS.GameObject({ name: "HostDisplay", parent: floor, localPosition: new BS.Vector3(0, 3.5, 12), localEulerAngles: new BS.Vector3(0, 0, 0) }).Async();
        hostDisplay = await hostObj.AddComponent(new BS.BanterText({
            text: "Waiting for Unity...",
            fontSize: 3,
            color: new BS.Vector4(1, 1, 0, 1),
            horizontalAlignment: BS.HorizontalAlignment.Center
        }));

        // Scoreboard
        const boardRoot = await new BS.GameObject({ name: "Scoreboards", parent: floor, localPosition: new BS.Vector3(12, 3, 0), localEulerAngles: new BS.Vector3(0, 90, 0) }).Async();
        const createBoard = async (name, x, label) => {
            const obj = await new BS.GameObject({ name: name, parent: boardRoot, localPosition: new BS.Vector3(x, 0, 0) }).Async();
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
        const buttonGroup = await new BS.GameObject({ name: "Controls", parent: floor, localPosition: new BS.Vector3(0, 1, 3) }).Async();
        const createBtn = async (name, xPos, color, text, handler) => {
            const btn = await new BS.GameObject({ name: name, parent: buttonGroup, localPosition: new BS.Vector3(xPos, 0, 0) }).Async();
            await btn.AddComponent(new BS.BanterBox({ width: 1, height: 0.4, depth: 0.5 }));
            await btn.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(1, 0.4, 0.5) }));
            await btn.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: color }));
            btn.SetLayer(5);
            const t = await new BS.GameObject({ name: name + "Text", parent: btn, localPosition: new BS.Vector3(0, 0.4, 0) }).Async();
            await t.AddComponent(new BS.BanterText({ text: text, fontSize: 1, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));
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

        await createBtn("ClaimHostBtn", -3, new BS.Vector4(1, 0.8, 0, 1), "CLAIM HOST", () => {
            const currentHostPresent = gameState.currentHostUid && scene.users[gameState.currentHostUid];
            if (!currentHostPresent) {
                updateState({ currentHostUid: scene.localUser.uid, hostStealStartTime: 0, hostStealRequesterUid: null });
            } else if (gameState.currentHostUid === scene.localUser.uid) {
                updateState({ hostStealStartTime: 0, hostStealRequesterUid: null });
            } else {
                updateState({ hostStealStartTime: Date.now(), hostStealRequesterUid: scene.localUser.uid });
            }
        });

        await createBtn("JoinBtn", 0, new BS.Vector4(0, 0.5, 1, 1), "JOIN GAME", () => {
            console.log("Join Game clicked.");
            scene.TeleportTo(new BS.Vector3(0, GAME_ARENA_TOP_Y + 2, 0), 0, true);
            if (gameState.status === "LOBBY") {
                updateState({ status: "STARTING", endTime: Date.now() + TIMINGS.STARTUP_DELAY });
            }
        });

        await createBtn("MuteBtn", 3, new BS.Vector4(0.5, 0.2, 0.8, 1), "MUTE AUDIO", async (e) => {
            isMuted = !isMuted;
            const btnObj = e.detail.object || await scene.Find("MuteBtn");
            const txt = await btnObj.GetComponent(BS.CT.BanterText) || (await scene.Find("MuteBtnText")).GetComponent(BS.CT.BanterText);
            if (txt) txt.text = isMuted ? "UNMUTE AUDIO" : "MUTE AUDIO";
        });

        await createBtn("ResetBtn", 6, new BS.Vector4(0.5, 0.5, 0.5, 1), "RESET GAME", () => {
            if (!isHost()) return;
            console.log("Host manually reset the game. Rebuilding grid...");
            updateState({ status: "LOBBY", playersAlive: {}, lastPlayerStanding: null, multiplayerSession: false, endTime: 0 });
            buildGrid();
        });

        // Arena Tracker
        const arenaTracker = await new BS.GameObject({ name: "ArenaTracker", localPosition: new BS.Vector3(0, GAME_ARENA_TOP_Y - 5, 0) }).Async();
        await arenaTracker.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(GRID_SIZE * TILE_SIZE, 30, GRID_SIZE * TILE_SIZE) }));
        await arenaTracker.AddComponent(new BS.BanterColliderEvents());
        arenaTracker.On("trigger-enter", (e) => {
            if (e.detail.user) {
                const user = e.detail.user;
                if (user.isLocal) isLocalInArena = true;
                if (isHost()) {
                    let alive = { ...gameState.playersAlive, [user.uid]: true };
                    updateState({ playersAlive: alive });
                    if (gameState.status === "LOBBY") {
                        updateState({ status: "STARTING", endTime: Date.now() + TIMINGS.STARTUP_DELAY });
                    }
                }
            }
        });
        arenaTracker.On("trigger-exit", (e) => {
            if (e.detail.user) {
                const user = e.detail.user;
                if (user.isLocal) isLocalInArena = false;
                if (isHost()) {
                    let alive = { ...gameState.playersAlive };
                    delete alive[user.uid];
                    updateState({ playersAlive: alive });
                }
            }
        });

        // Dead Zone
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
            const ringPromises = [];
            for (let x = 0; x < GRID_SIZE; x++) {
                for (let z = 0; z < GRID_SIZE; z++) {
                    ringPromises.push((async (lx, lz) => {
                        const tileName = `Tile_L${l}_${lx}_${lz}`;
                        const tile = await new BS.GameObject({
                            name: tileName, parent: gridRoot,
                            localPosition: new BS.Vector3(lx * TILE_SIZE - offset, ly, lz * TILE_SIZE - offset)
                        }).Async();
                        await tile.AddComponent(new BS.BanterBox({ width: TILE_SIZE - 0.1, height: 0.4, depth: TILE_SIZE - 0.1 }));
                        await tile.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(TILE_SIZE - 0.1, 0.4, TILE_SIZE - 0.1) }));
                        const mat = await tile.AddComponent(new BS.BanterMaterial("Standard", "", new BS.Vector4(0.2, 0.6, 1, 1), BS.MaterialSide.Front, false, tileName));
                        const triggerObj = await new BS.GameObject({ name: tileName + "_Trigger", parent: tile, localPosition: new BS.Vector3(0, 1.0, 0) }).Async();
                        await triggerObj.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(TILE_SIZE - 0.5, 2.0, TILE_SIZE - 0.5) }));
                        await triggerObj.AddComponent(new BS.BanterColliderEvents());
                        triggerObj.On("trigger-enter", (e) => handleTileStep(e, tile, mat));
                        tiles.push({ obj: tile, mat: mat, isSinking: false });
                    })(x, z));
                }
            }
            await Promise.all(ringPromises);
        }
    }

    async function handleTileStep(e, tile, mat) {
        if (!tile.isSinking && gameState.status === "ACTIVE") {
            tile.isSinking = true;
            mat.color = new BS.Vector4(STEPPED_COLOR_VEC[0], STEPPED_COLOR_VEC[1], STEPPED_COLOR_VEC[2], STEPPED_COLOR_VEC[3]);
            if (!isMuted) audio.tick.PlayOneShotFromUrl("https://audiofiles.firer.at/mp3/Tick.mp3");
            await new Promise(resolve => setTimeout(resolve, gameState.sinkDelay));
            tile.SetActive(false);
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
        scene.On("user-left", (e) => {
            if (isHost() && e.detail.uid === gameState.currentHostUid) {
                const uids = Object.keys(scene.users).filter(id => id !== e.detail.uid).sort();
                if (uids.length > 0) updateState({ currentHostUid: uids[0], hostStealStartTime: 0, hostStealRequesterUid: null });
            }
            if (isHost() && e.detail.uid === gameState.hostStealRequesterUid) {
                updateState({ hostStealStartTime: 0, hostStealRequesterUid: null });
            }
        });
        sync();
        updateScoreboard();
    }

    async function sync() {
        const raw = scene.spaceState.public[STATE_KEY];
        if (!raw) return;
        const oldLayers = gameState.numLayers;
        gameState = JSON.parse(raw);

        const sinkTxt = await (await scene.Find("SinkDelayBtnText"))?.GetComponent(BS.CT.BanterText);
        if (sinkTxt) sinkTxt.text = `SINK: ${gameState.sinkDelay / 1000}s`;
        const layerTxt = await (await scene.Find("LayersBtnText"))?.GetComponent(BS.CT.BanterText);
        if (layerTxt) layerTxt.text = `LAYERS: ${gameState.numLayers}`;

        // Only auto-rebuild if layers change
        if (oldLayers !== gameState.numLayers) {
            console.log("Layers changed via sync. Rebuilding grid...");
            await buildGrid();
        }
    }

    function updateScoreboard() {
        if (!scoreboardFalls || !scoreboardSurvival || !scoreboardWins) return;
        const state = scene.spaceState.public;
        const players = [];
        Object.keys(state).forEach(key => {
            if (key.startsWith(USER_DATA_KEY_PREFIX)) { try { players.push(JSON.parse(state[key])); } catch (e) {} }
        });
        const updateBoard = (comp, title, sorted, formatter) => {
            let str = `<size=1.2><b>${title}</b></size>\n\n`;
            if (sorted.length === 0) str += "No records!";
            else sorted.forEach((p, i) => str += `${i+1}. ${p.name}: ${formatter(p)}\n`);
            comp.text = str;
        };
        updateBoard(scoreboardFalls, "MOST FALLS", [...players].sort((a,b)=>b.falls-a.falls).slice(0,50), p=>p.falls);
        updateBoard(scoreboardSurvival, "BEST SURVIVAL", [...players].sort((a,b)=>b.bestSurvival-a.bestSurvival).slice(0,50), p=>(p.bestSurvival/1000).toFixed(1)+"s");
        updateBoard(scoreboardWins, "MOST WINS", [...players].sort((a,b)=>b.wins-a.wins).slice(0,50), p=>p.wins);
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
        else if (gameState.status === "STARTING") {
            const remaining = Math.max(0, Math.ceil((gameState.endTime - now) / 1000));
            displayStr = `GAME STARTING IN: ${remaining}`;
        }
        else if (gameState.status === "ACTIVE") displayStr = `PLAYERS: ${Object.keys(gameState.playersAlive).length}`;
        else displayStr = gameState.lastPlayerStanding ? `${scene.users[gameState.lastPlayerStanding]?.name || "PLAYER"} WINS!` : "GAME OVER";

        ui.displays.forEach(d => d.text.text = displayStr);

        if (hostDisplay) {
            const hostUser = scene.users[gameState.currentHostUid];
            const requester = scene.users[gameState.hostStealRequesterUid];
            if (gameState.hostStealStartTime > 0 && requester) {
                const elapsed = Date.now() - gameState.hostStealStartTime;
                const remaining = Math.max(0, Math.ceil((TIMINGS.HOST_STEAL_DURATION - elapsed) / 1000));
                hostDisplay.text = `<color=#ff0000>STEALING HOST: ${remaining}s</color>\n(Requested by: ${requester.name})`;
            } else {
                hostDisplay.text = hostUser ? `CURRENT HOST: ${hostUser.name}` : "NO HOST ASSIGNED";
            }
        }

        if (isHost()) driveHostLogic(now);
    }

    function driveHostLogic(now) {
        if (gameState.hostStealStartTime > 0) {
            if (now - gameState.hostStealStartTime >= TIMINGS.HOST_STEAL_DURATION) {
                updateState({ currentHostUid: gameState.hostStealRequesterUid, hostStealStartTime: 0, hostStealRequesterUid: null });
            }
        }

        if (gameState.status === "STARTING" && now >= gameState.endTime) {
            updateState({ status: "ACTIVE" });
            localGameStartTime = now;
        }

        if (gameState.status === "ACTIVE") {
            const alive = Object.keys(gameState.playersAlive);
            if (alive.length > 1 && !gameState.multiplayerSession) {
                updateState({ multiplayerSession: true });
            }
            if (gameState.multiplayerSession && alive.length === 1) {
                updateState({ status: "GAME_OVER", lastPlayerStanding: alive[0], multiplayerSession: false });
                updateWinnerStats(alive[0]);
                setTimeout(() => updateState({ status: "LOBBY", playersAlive: {}, lastPlayerStanding: null }), TIMINGS.GAME_OVER_DELAY);
            } else if (alive.length === 0) {
                updateState({ status: "LOBBY", playersAlive: {}, lastPlayerStanding: null, multiplayerSession: false });
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
