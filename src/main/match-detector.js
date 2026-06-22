// Player/team detection for competitive GSI matches.
//
// CS2 restricts the `allplayers` GSI block to the local player's own team in
// competitive/premier matches — opponents never appear in it. This module
// fills that gap using Steam's coplay data (which DOES see the full
// 10-player roster as a single `coplayTime`-stamped cluster) plus the
// `player`/`previously.player` blocks GSI always sends, to figure out which
// roster members GSI actually shows (teammates) vs never shows (opponents).
// Only meaningful for competitive mode — casual/community modes keep using
// the allplayers-based path in gsi-server.js, which already sees everyone
// there.
//
// Every function here is pure: it takes a match-candidate object (created by
// createMatchCandidate) and mutates it in place. No module-level state.

const crypto = require('crypto');

// GSI map.mode for Premier reports as "competitive" too, so this gate covers both.
function isCompetitiveMatchGsi(data) {
  return (
    data?.provider?.appid === 730 &&
    !!data?.provider?.steamid &&
    data?.map?.mode === 'competitive' &&
    !!data?.map?.name &&
    ['warmup', 'live', 'intermission'].includes(data?.map?.phase)
  );
}

function createMatchCandidate({ mySteamId64, map, mode, detectedAtIso }) {
  return {
    id: crypto.randomUUID(),
    appid: 730,
    map: map ?? null,
    mode: mode ?? null,
    mySteamId64,
    detectedAtIso: detectedAtIso ?? new Date().toISOString(),
    rosterFinalized: false,
    rosterSource: null,
    roster: [],
    localTeamSteamIds: new Set([mySteamId64]),
    opponentSteamIds: new Set(),
    gsiSeenSteamIds: new Set([mySteamId64]),
    gsiSeenPlayers: new Map(),
    lifecycle: {
      started: true,
      gameover: false,
      closed: false,
      gameoverAtIso: null,
      closedAtIso: null,
      closeReason: null,
    },
    finalScore: null,
    evidence: {
      recentPlayersChecked: false,
      exactNineCoplayTime: null,
      exactNineFirstSeenIso: null,
      exactNineLastSeenIso: null,
      gsiGameoverSeen: false,
    },
    confidence: 'pending',
  };
}

// Returns true the moment the map disappears after gameover — the caller's
// cue to persist the match record. Returns false every other tick.
function handleGsiLifecycle(match, { map, round }, tsIso) {
  if (map?.phase === 'gameover') {
    const wasGameover = match.lifecycle.gameover;
    match.lifecycle.gameover = true;
    if (!wasGameover) match.lifecycle.gameoverAtIso = tsIso;
    match.evidence.gsiGameoverSeen = true;
    match.finalScore = {
      ct: map.team_ct?.score ?? null,
      t: map.team_t?.score ?? null,
      winTeam: round?.win_team ?? null,
    };
    if (match.rosterFinalized) match.confidence = 'ended';
    return false;
  }

  if (!map && match.lifecycle.gameover && !match.lifecycle.closed) {
    match.lifecycle.closed = true;
    match.lifecycle.closedAtIso = tsIso;
    match.lifecycle.closeReason = 'gsi_map_removed_after_gameover';
    return true;
  }

  return false;
}

module.exports = {
  isCompetitiveMatchGsi,
  createMatchCandidate,
  handleGsiLifecycle,
};
