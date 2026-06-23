# Raw Player-Source Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the unmodified output of every player-detection source (GSI's raw payload, plus `coplay.js`'s `getRecentPlayers`/`getFriendsInGame`/`getLobbyTeams`) to append-only JSONL files on disk, so the actual data shapes those sources provide can be inspected across game modes.

**Architecture:** One small new module, `src/main/raw-data-logger.js`, exposes `logRaw(sourceName, payload)` which appends a timestamped JSON line to `raw-<sourceName>.jsonl` in the same directory as the existing `app-*.log` files (reuses `logsDir()` from `src/main/logger.js`). Two call sites wire into it: `gsi-server.js` (one call per GSI tick, secret-stripped) and `coplay.js` (one call per player-discovery function, tagged by an `fn` field so all three share `raw-coplay.jsonl`).

**Tech Stack:** Plain Node.js (`fs`, `path`), Electron's `app.getPath` (via existing `logger.js`). No new dependencies.

## Global Constraints

- Never log secrets — GSI's `data.auth.token` (the shared-secret GSI token from `gsi-config.js`) must never appear in `raw-gsi.jsonl`. (CONTRIBUTING.md "Security ground rules")
- Match existing style: 2-space indent, semicolons; quote style follows whatever's already used immediately around each edit (the codebase mixes single/double quotes file-to-file). (CONTRIBUTING.md "Coding conventions")
- No test framework exists in this repo (CONTRIBUTING.md: "There's no formal test suite yet"). Verification below uses small throwaway Node scripts run via the `node` CLI with `electron` manually mocked in `require.cache` — these scripts are never committed.
- Small, focused commits — one per task. (CONTRIBUTING.md "Small PRs")
- This is a temporary diagnostic tool, not a shipped feature — no settings UI, no on/off flag, no rotation. (per approved design spec, `docs/superpowers/specs/2026-06-20-raw-player-source-logging-design.md`)

---

### Task 1: `raw-data-logger.js` module

**Files:**
- Create: `src/main/raw-data-logger.js`

**Interfaces:**
- Produces: `logRaw(sourceName: string, payload: object): void` — appends `{ ts: <ISO8601 string>, ...payload }` as one JSON line to `<logsDir()>/raw-<sourceName>.jsonl`. Silently no-ops if `logsDir()` returns null (matches `logger.js`'s own failure-tolerant pattern) or if the write throws.
- Consumes: `logsDir()` from `src/main/logger.js` (already exported: `module.exports = { install, logFromRenderer, logsDir, currentPath: () => currentPath };`).

- [ ] **Step 1: Write the failing verification script**

Create a temporary file `tmp-verify-task1.js` at the repo root (NOT committed — deleted at the end of this task):

```js
// tmp-verify-task1.js — throwaway, deleted after this task
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-logger-test-'));

// Mock 'electron' so logger.js's logsDir() resolves to our temp dir.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => tmpDir } },
};

const { logRaw } = require('./src/main/raw-data-logger');

logRaw('test', { foo: 'bar' });
logRaw('test', { foo: 'baz' });

const filePath = path.join(tmpDir, 'raw-test.jsonl');
const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
assert.strictEqual(lines.length, 2, `expected 2 lines, got ${lines.length}`);

const first = JSON.parse(lines[0]);
assert.strictEqual(first.foo, 'bar');
assert.ok(typeof first.ts === 'string' && !isNaN(Date.parse(first.ts)), 'ts should be a valid ISO timestamp');

const second = JSON.parse(lines[1]);
assert.strictEqual(second.foo, 'baz');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('PASS');
```

- [ ] **Step 2: Run the script to verify it fails**

Run: `node tmp-verify-task1.js`
Expected: `Error: Cannot find module './src/main/raw-data-logger'` (module doesn't exist yet)

- [ ] **Step 3: Write the implementation**

Create `src/main/raw-data-logger.js`:

```js
// Diagnostic-only: appends the raw output of player-detection sources
// (GSI payload, Steam coplay calls) to JSONL files for inspection across
// game modes. Not gated by a flag. Delete this module once it's served
// its purpose.

const fs = require('fs');
const path = require('path');
const { logsDir } = require('./logger');

const streams = {};

function getStream(sourceName) {
  if (streams[sourceName]) return streams[sourceName];
  const dir = logsDir();
  if (!dir) return null;
  try {
    const stream = fs.createWriteStream(path.join(dir, `raw-${sourceName}.jsonl`), { flags: 'a' });
    streams[sourceName] = stream;
    return stream;
  } catch {
    return null;
  }
}

function logRaw(sourceName, payload) {
  const stream = getStream(sourceName);
  if (!stream) return;
  try {
    stream.write(JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n');
  } catch {}
}

module.exports = { logRaw };
```

- [ ] **Step 4: Run the script to verify it passes**

Run: `node tmp-verify-task1.js`
Expected: `PASS`

- [ ] **Step 5: Delete the verification script and commit**

```bash
rm tmp-verify-task1.js
git add src/main/raw-data-logger.js
git commit -m "feat: add raw-data-logger for diagnostic player-source capture"
```

---

### Task 2: Wire into `gsi-server.js`

**Files:**
- Modify: `src/main/gsi-server.js:19-26` (imports), `src/main/gsi-server.js:485-494` (`req.on('end', ...)` handler)

**Interfaces:**
- Consumes: `logRaw(sourceName, payload)` from Task 1 (`src/main/raw-data-logger.js`).

- [ ] **Step 1: Write the failing verification script**

Create a temporary file `tmp-verify-task2.js` at the repo root (NOT committed — deleted at the end of this task):

```js
// tmp-verify-task2.js — throwaway, deleted after this task
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsi-raw-test-'));

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => tmpDir } }, // serves both 'logs' and 'userData'
};

const { GSI_TOKEN } = require('./src/main/gsi-config');
const { createGSIServer } = require('./src/main/gsi-server');

const server = createGSIServer(
  () => {},        // onPlayersReady
  () => [],        // getCoplayPlayers
  () => {},        // onReset
  () => {},        // onLiveStats
);

const body = JSON.stringify({
  auth: { token: GSI_TOKEN },
  map: { name: 'de_dust2', phase: 'live', mode: 'competitive' },
  allplayers: { '76561198000000099': { name: 'Test', team: 'CT' } },
});

const req = http.request({ host: '127.0.0.1', port: 3000, method: 'POST', headers: { 'Content-Length': Buffer.byteLength(body) } }, (res) => {
  res.on('data', () => {});
  res.on('end', () => {
    setTimeout(() => {
      const filePath = path.join(tmpDir, 'raw-gsi.jsonl');
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      assert.strictEqual(last.map.name, 'de_dust2');
      assert.ok(last.allplayers && last.allplayers['76561198000000099'], 'allplayers should be present');
      assert.ok(!('auth' in last), 'auth/token must never be logged');

      server.destroyAll();
      server.close(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log('PASS');
        process.exit(0);
      });
    }, 100);
  });
});
req.write(body);
req.end();
```

- [ ] **Step 2: Run the script to verify it fails**

Run: `node tmp-verify-task2.js`
Expected: throws/times out reading `raw-gsi.jsonl` — `ENOENT: no such file or directory` (the file is never written because `gsi-server.js` doesn't call `logRaw` yet)

- [ ] **Step 3: Write the implementation**

In `src/main/gsi-server.js`, add the import alongside the existing requires (after line 21, `const { GSI_TOKEN } = require('./gsi-config');`):

```js
const { GSI_TOKEN } = require('./gsi-config');
const { logRaw } = require('./raw-data-logger');
```

Then in the `req.on('end', ...)` handler, insert the raw capture right after the auth check passes:

```js
      let data;
      try { data = JSON.parse(body); } catch { return; }
      if (!authCheck(data.auth?.token)) return;
      const { auth, ...safeData } = data;
      logRaw('gsi', safeData);
      gsiMessageCount++;
      try { processTick(data); } catch { /* malformed payload */ }
```

- [ ] **Step 4: Run the script to verify it passes**

Run: `node tmp-verify-task2.js`
Expected: `PASS`

- [ ] **Step 5: Delete the verification script and commit**

```bash
rm tmp-verify-task2.js
git add src/main/gsi-server.js
git commit -m "feat: capture raw GSI payload to raw-gsi.jsonl"
```

---

### Task 3: Wire into `coplay.js`

**Files:**
- Modify: `src/main/coplay.js:1-2` (imports), `coplay.js` inside `getRecentPlayers` (before its `return recent;`), inside `getFriendsInGame` (before its `return players;`), inside `getLobbyTeams` (inside the `if (members.length > 0)` block)

**Interfaces:**
- Consumes: `logRaw(sourceName, payload)` from Task 1 (`src/main/raw-data-logger.js`).

**Note on verification:** `coplay.js` loads a native DLL (`steamworks.js`'s `steam_api64.dll`) via `koffi`, and every function that needs wiring (`getRecentPlayers`, `getFriendsInGame`, `getLobbyTeams`) bails out early (`if (!iface) return [];` etc.) unless `initCoplay()` has already run against a live Steam client — that only happens for real inside the packaged app with Steam running (`steam-lifecycle.js:40`). There's no safe way to exercise the native call path from an automated script without a real Steam session, and CONTRIBUTING.md's own testing guidance for this kind of process-dependent code is manual verification ("launch the packaged app ... verify your change works"). So this task's automated check is a load-only smoke test (catches syntax/typo errors); the actual data capture is verified manually in Step 5.

- [ ] **Step 1: Write the failing verification script**

Create a temporary file `tmp-verify-task3.js` at the repo root (NOT committed — deleted at the end of this task):

```js
// tmp-verify-task3.js — throwaway, deleted after this task
// Smoke test only: confirms coplay.js still loads without a syntax/typo
// error after the logRaw wiring is added. Native-call behavior requires
// a live Steam session and is verified manually (see Task 3 Step 5).
const coplay = require('./src/main/coplay');
const assert = require('assert');
assert.strictEqual(typeof coplay.getRecentPlayers, 'function');
assert.strictEqual(typeof coplay.getFriendsInGame, 'function');
assert.strictEqual(typeof coplay.getLobbyTeams, 'function');
console.log('PASS');
```

- [ ] **Step 2: Run the script to verify it currently passes (baseline)**

Run: `node tmp-verify-task3.js`
Expected: `PASS` (the module already loads fine before this task's edits — this just establishes the pre-edit baseline so Step 4 proves the edits didn't break loading)

- [ ] **Step 3: Write the implementation**

In `src/main/coplay.js`, add the import after the existing requires (after line 2, `const koffi = require("koffi");`):

```js
const koffi = require("koffi");
const { logRaw } = require("./raw-data-logger");
```

In `getRecentPlayers`, immediately before its `return recent;` (currently the last line of the function, right after the existing `if (count > 0) console.log(...)` line):

```js
  if (count > 0) console.log(`[Coplay] ${recent.length} CS2 coplay (${players.length} total CS2, ${count} all games)`);
  logRaw('coplay', { fn: 'getRecentPlayers', withinSeconds, totalCount: count, allCs2Players: players, recentPlayers: recent });
  return recent;
```

In `getFriendsInGame`, immediately before its `return players;` (currently the last line of the function, right after the existing `if (inCS2 > 0) console.log(...)` line):

```js
  if (inCS2 > 0) console.log(`[Coplay] ${passed}/${inCS2} friends passed checks (map=${currentMap || '?'}) (of ${count} total)`);
  logRaw('coplay', { fn: 'getFriendsInGame', currentMap, localServerKey, localGroup, totalFriends: count, inCs2: inCS2, passed, players });
  return players;
```

In `getLobbyTeams`, inside the existing `if (members.length > 0) { ... }` block:

```js
        if (members.length > 0) {
          console.log(`[Lobby] Members:`, members.map(m => `${m.steamId} team=${m.team} slot=${m.slot}`).join(', '));
          logRaw('coplay', { fn: 'getLobbyTeams', lobbyId: lobbyId.toString(), members });
        }
        return { lobbyId: lobbyId.toString(), members };
```

- [ ] **Step 4: Run the script to verify it still passes**

Run: `node tmp-verify-task3.js`
Expected: `PASS`

- [ ] **Step 5: Delete the verification script, commit, and note manual follow-up**

```bash
rm tmp-verify-task3.js
git add src/main/coplay.js
git commit -m "feat: capture raw Steam coplay output to raw-coplay.jsonl"
```

Manual follow-up (do this once, outside this plan, with the packaged app running against a real CS2 + Steam session): start a match, then check `raw-coplay.jsonl` in the app's logs directory (same folder as `app-*.log`; check `logger.js`'s `currentPath()` or the Electron `logs` userData path) for lines with `fn: "getRecentPlayers"`, `fn: "getFriendsInGame"`, and `fn: "getLobbyTeams"`.

---

## Plan Self-Review

**Spec coverage:**
- "GSI raw payload, auth stripped" → Task 2 ✓
- "getRecentPlayers raw output" → Task 3 ✓
- "getFriendsInGame raw output" → Task 3 ✓
- "getLobbyTeams raw output" → Task 3 ✓
- "raw-data-logger.js reusing logsDir()" → Task 1 ✓
- "raw-gsi.jsonl / raw-coplay.jsonl naming, no rotation" → Tasks 1–3 ✓
- "Never log secrets" → Task 2 Step 3 strips `auth` before logging, and Step 1's test explicitly asserts `!('auth' in last)` ✓

**Placeholder scan:** No TBD/TODO; every step shows full code or an exact command + expected output.

**Type consistency:** `logRaw(sourceName, payload)` signature is identical across Task 1's definition and Tasks 2/3's call sites. Field names used in Task 3's `logRaw` calls (`fn`, `withinSeconds`, `totalCount`, `allCs2Players`, `recentPlayers`, `currentMap`, `localServerKey`, `localGroup`, `totalFriends`, `inCs2`, `passed`, `players`, `lobbyId`, `members`) match the variable names actually in scope at each call site in the current `coplay.js`.
