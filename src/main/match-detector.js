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

// Steam's coplayTime is a per-player "last played CS2 together" timestamp.
// All 9 players from the same match share an identical value, so grouping a
// single getRecentPlayers() snapshot by coplayTime recovers the full roster
// (minus yourself) even before GSI has revealed anyone.
function groupRecentPlayersByCoplayTime(players, mySteamId64) {
  const groups = new Map();
  for (const p of players || []) {
    if (!p?.steamId) continue;
    if (p.steamId === mySteamId64) continue;
    if (!p.coplayTime) continue;
    const key = String(p.coplayTime);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

function findNewestExactNineRecentGroup(players, mySteamId64) {
  const groups = groupRecentPlayersByCoplayTime(players, mySteamId64);
  const candidates = [...groups.entries()]
    .map(([coplayTime, group]) => ({
      coplayTime: Number(coplayTime),
      players: group,
      count: group.length,
    }))
    .filter(x => x.count === 9)
    .sort((a, b) => b.coplayTime - a.coplayTime);
  return candidates[0] ?? null;
}

function finalizeRosterFromRecentPlayers(match, exactNine, sourceIso) {
  match.roster = exactNine.players.map(p => ({
    steamId64: p.steamId,
    name: p.name,
    coplayTime: p.coplayTime,
    sources: ['recent_players_cluster'],
  }));
  match.rosterFinalized = true;
  match.rosterSource = 'recent_players_exact9_coplay_cluster';
  match.confidence = 'medium';
  match.evidence.recentPlayersChecked = true;
  match.evidence.exactNineCoplayTime = exactNine.coplayTime;
  match.evidence.exactNineFirstSeenIso ??= sourceIso ?? null;
  match.evidence.exactNineLastSeenIso = sourceIso ?? null;
  recomputeOpponentSet(match);
}

// Once cached, the roster survives the post-gameover coplayTime split (Steam
// re-stamps players individually as the post-match lobby breaks up) — only
// replaced when a brand new match is detected (gsi-server.js builds a fresh
// match candidate on map change / same-map rematch, see Task 4).
function shouldKeepCachedRoster(match, latestRecentPlayers) {
  if (!match.rosterFinalized || !match.roster.length) return false;
  const latestIds = new Set((latestRecentPlayers || []).map(p => p.steamId).filter(Boolean));
  const cachedIds = match.roster.map(p => p.steamId64);
  const stillPresent = cachedIds.filter(id => latestIds.has(id)).length;
  return stillPresent >= 7;
}

function onRecentPlayersSnapshot(match, players, sourceIso) {
  if (!match.rosterFinalized) {
    const exactNine = findNewestExactNineRecentGroup(players, match.mySteamId64);
    if (exactNine) {
      finalizeRosterFromRecentPlayers(match, exactNine, sourceIso);
    } else {
      match.confidence = 'low';
    }
    return;
  }

  if (shouldKeepCachedRoster(match, players)) {
    if (match.confidence !== 'ended' && match.confidence !== 'team_classified') {
      match.confidence = match.lifecycle.gameover ? 'ended' : 'high_cached';
    }
  } else if (!match.lifecycle.closed) {
    match.confidence = 'stale_or_uncertain';
  }

  const exactNine = findNewestExactNineRecentGroup(players, match.mySteamId64);
  if (exactNine?.coplayTime === match.evidence.exactNineCoplayTime) {
    match.evidence.exactNineLastSeenIso = sourceIso ?? null;
  }
}

module.exports = {
  isCompetitiveMatchGsi,
  createMatchCandidate,
  handleGsiLifecycle,
  groupRecentPlayersByCoplayTime,
  findNewestExactNineRecentGroup,
  finalizeRosterFromRecentPlayers,
  shouldKeepCachedRoster,
  onRecentPlayersSnapshot,
};
