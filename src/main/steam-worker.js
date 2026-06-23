// Isolated process for SteamAPI_Init(730): holding that session means Steam
// may TerminateProcess us on close of CS2. Keeping it out of main
// means only this disposable worker dies; main re-forks it on next CS2 detect.
//
// Protocol (see steam-client.js):
//   parent → child: cs2Detected, cs2Closed, setMap, shutdown
//   child → parent: ready, snapshot, result

process.on('uncaughtException', (err) => {
  console.error('[SteamWorker] Uncaught:', err.message);
});

// If the parent goes away (crash, kill) the IPC channel disconnects. Exit
// instead of lingering as an orphan still holding the Steam session open.
process.on('disconnect', () => {
  try { process.exit(0); } catch {}
});

const { initSteam, cleanupSteam, getRecentPlayers, getFriendsInGame, isInitialized } = require('./steam-lifecycle');
const { getLobbyTeams } = require('./coplay');

const SNAPSHOT_INTERVAL_MS = 2000;

let currentMap = '';
let snapshotInterval = null;

function safeSend(msg) {
  try { if (process.connected) process.send(msg); }
  catch { /* parent closed */ }
}

// Friends-in-game plus recent coplay, deduped with friends taking priority.
function computeSnapshot() {
  if (!isInitialized()) return;
  try {
    const friends = (currentMap && getFriendsInGame) ? (getFriendsInGame(currentMap) || []) : [];
    const coplay = getRecentPlayers ? (getRecentPlayers(0) || []) : [];
    const seen = new Set(friends.map(f => f.steamId));
    const players = [...friends];
    for (const p of coplay) {
      if (!seen.has(p.steamId)) {
        seen.add(p.steamId);
        players.push(p);
      }
    }
    let lobby = null;
    try { lobby = getLobbyTeams ? getLobbyTeams() : null; } catch {}
    // Unmerged, uncapped (limit=0) — match-detector.js's exact-9 coplayTime
    // clustering needs the full list, not the friends-priority/15-cap mix above.
    const recentPlayersRaw = getRecentPlayers ? (getRecentPlayers(0, 0) || []) : [];
    safeSend({ type: 'snapshot', data: { players, lobby, recentPlayersRaw } });
  } catch (err) {
    console.error('[SteamWorker] Snapshot failed:', err.message);
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { type, id } = msg;

  if (type === 'cs2Detected') {
    initSteam();
    if (!snapshotInterval) snapshotInterval = setInterval(computeSnapshot, SNAPSHOT_INTERVAL_MS);
    computeSnapshot();
    return;
  }

  if (type === 'cs2Closed') {
    if (snapshotInterval) { clearInterval(snapshotInterval); snapshotInterval = null; }
    cleanupSteam();
    safeSend({ type: 'snapshot', data: { players: [], lobby: null, recentPlayersRaw: [] } });
    return;
  }

  if (type === 'setMap') {
    currentMap = msg.map || '';
    return;
  }

  if (type === 'shutdown') {
    if (snapshotInterval) { clearInterval(snapshotInterval); snapshotInterval = null; }
    cleanupSteam();
    safeSend({ type: 'result', id, ok: true, data: true });
    setTimeout(() => { try { process.exit(0); } catch {} }, 50);
    return;
  }
});

safeSend({ type: 'ready' });
