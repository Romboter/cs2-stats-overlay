// Main-process facade over the forked steam-worker. Replaces direct use of
// steam-lifecycle.js in index.js/gsi-server.js so this process never loads
// steam_api64.dll itself — see steam-worker.js for why that isolation
// matters (Steam can TerminateProcess anything holding AppID 730's session).
//
// The worker pushes a fresh coplay/lobby snapshot on its own interval;
// getCoplayPlayers/getLobbyTeams just read the latest one synchronously, so
// callers in gsi-server.js (which read these multiple times per GSI tick)
// don't need to change to async.

const path = require('path');
const { fork } = require('child_process');

let worker = null;
let initialized = false; // what main thinks the state should be
let nextReqId = 1;
const pending = new Map(); // id → { resolve, reject }
let lastSnapshot = { players: [], lobby: null };

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') { console.log('[SteamWorker] Ready'); return; }

  if (msg.type === 'snapshot') {
    if (msg.data) lastSnapshot = msg.data;
    return;
  }

  if (msg.type === 'result') {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error || 'steam worker error'));
  }
}

function startWorker() {
  const scriptPath = path.join(__dirname, 'steam-worker.js');
  worker = fork(scriptPath, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  worker.on('message', handleMessage);

  worker.on('error', (err) => {
    console.error('[SteamWorker] Error:', err.message);
  });

  worker.on('exit', (code, signal) => {
    console.log(`[SteamWorker] Exited code=${code} signal=${signal}`);
    worker = null;
    initialized = false;
    lastSnapshot = { players: [], lobby: null };
    for (const entry of pending.values()) {
      try { entry.reject(new Error('steam worker exited')); } catch {}
    }
    pending.clear();
  });
}

function ensureWorker() {
  if (!worker) startWorker();
}

function send(msg) {
  ensureWorker();
  try { worker.send(msg); } catch (err) { console.error('[SteamWorker] Send failed:', err.message); }
}

// ── Public API ────────────────────────────────────────────────

function initSteam() {
  initialized = true;
  send({ type: 'cs2Detected' });
}

function cleanupSteam() {
  initialized = false;
  lastSnapshot = { players: [], lobby: null };
  send({ type: 'cs2Closed' });
}

function isInitialized() { return initialized; }

function setMap(map) { send({ type: 'setMap', map: map || '' }); }

function getCoplayPlayers() { return lastSnapshot.players || []; }

function getLobbyTeams() { return lastSnapshot.lobby || null; }

async function shutdown() {
  if (!worker) return;
  const id = nextReqId++;
  try {
    await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.send({ type: 'shutdown', id }); } catch (err) { reject(err); }
    });
  } catch {}
  try { worker.kill(); } catch {}
  worker = null;
  initialized = false;
}

module.exports = {
  initSteam,
  cleanupSteam,
  isInitialized,
  setMap,
  getCoplayPlayers,
  getLobbyTeams,
  shutdown,
};
