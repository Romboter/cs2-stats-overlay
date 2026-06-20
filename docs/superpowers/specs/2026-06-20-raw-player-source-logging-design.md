# Raw player-source logging

## Purpose

Capture the unmodified output of every player-detection source so we can inspect what data each one actually provides across different CS2 game modes (comp, casual, retakes, community servers). This is a temporary diagnostic tool, not a shipped feature.

## Scope

"Sources used to find players in games" means the roster-detection mechanisms, not the stat-fetching APIs:

- **GSI** (`gsi-server.js`) — the raw JSON payload CS2 POSTs ~10x/second
- **Steam coplay** (`coplay.js`) — `getRecentPlayers()`, `getFriendsInGame()`, `getLobbyTeams()`

Stat-fetching sources (`csstats-scraper.js`, `faceit-api.js`, `leetify-api.js`, `steam-api.js`) are explicitly out of scope — they operate on an already-known SteamID and aren't part of "finding players."

## Design

### New module: `src/main/raw-data-logger.js`

```js
function logRaw(sourceName, payload)
```

- Lazily opens one append-mode `fs.createWriteStream` per `sourceName`, kept open for the process lifetime.
- Writes one JSON line per call: `{ ts: <ISO8601>, ...payload }\n` to `<logsDir>/raw-<sourceName>.jsonl`.
- Reuses `logsDir()` from the existing `logger.js` (same directory as `app-*.log`) rather than duplicating the `app.getPath('logs')` setup.
- No rotation, no throttling, no on/off flag — always on, appends forever. The existing `logger.js` rotation regex (`^app-\d{4}-\d{2}-\d{2}`) only matches `app-*.log`, so it won't touch these files.

### Call sites

**`gsi-server.js`** — in the HTTP server's `req.on('end')` handler, immediately after `JSON.parse(body)` succeeds and `authCheck` passes (before `processTick`):

```js
const { auth, ...safeData } = data;
logRaw('gsi', safeData);
```

Strips `data.auth` (carries the GSI shared-secret token) before logging — never log secrets, per CONTRIBUTING.md.

**`coplay.js`** — one call per player-discovery function, all writing to the same `raw-coplay.jsonl` file, tagged with an `fn` field so they're distinguishable in one stream:

- `getRecentPlayers()`: before return, log `{ fn: 'getRecentPlayers', withinSeconds, totalCount: count, allCs2Players: players, recentPlayers: recent }`
- `getFriendsInGame()`: before return, log `{ fn: 'getFriendsInGame', currentMap, localServerKey, localGroup, totalFriends: count, inCs2, passed, players }`
- `getLobbyTeams()`: inside the `if (members.length > 0)` branch, log `{ fn: 'getLobbyTeams', lobbyId: lobbyId.toString(), members }`

### Output files

Both land in the same directory as `app-*.log` (`app.getPath('logs')`):

- `raw-gsi.jsonl`
- `raw-coplay.jsonl`

## Out of scope

- No settings UI / toggle — always on.
- No rotation or size cap.
- No changes to stat-fetching sources.
- No changes to existing `console.log` diagnostic lines already in these files — this is additive raw capture alongside them.
