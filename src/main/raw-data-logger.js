// Diagnostic-only: appends the raw output of player-detection sources
// (GSI payload, Steam coplay calls) to JSONL files for inspection across
// game modes. Not gated by a flag. Delete this module once it's served
// its purpose.

const fs = require('fs');
const path = require('path');
const { logsDir } = require('./logger');

function logRaw(sourceName, payload) {
  const dir = logsDir();
  if (!dir) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n';
    fs.appendFileSync(path.join(dir, `raw-${sourceName}.jsonl`), line);
  } catch {}
}

module.exports = { logRaw };
