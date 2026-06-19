// worldcup.js — 2026 FIFA World Cup live scores + group standings.
//
// Source: ESPN's public (unofficial) site API. No key required, free, and
// CORS is avoided because we fetch it server-side and cache it. If ESPN ever
// changes shape or goes away, swap SCOREBOARD_URL / STANDINGS_URL or move to
// football-data.org (needs a free API key) — see README.

const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings';

const TTL_MS = Number(process.env.WORLDCUP_TTL || 30) * 1000; // live data: 30s

let cache = { at: 0, data: null };

const GROUP_RE = /Group\s+[A-L]/i;

async function fetchJson(url) {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function pickGroup(competition) {
  // ESPN tucks the group label in different places depending on round.
  const notes = competition?.notes || [];
  for (const n of notes) {
    const m = GROUP_RE.exec(n?.headline || '');
    if (m) return m[0].replace(/\s+/, ' ');
  }
  const m = GROUP_RE.exec(competition?.groups?.name || '');
  return m ? m[0] : '';
}

function teamFrom(competitor) {
  const t = competitor?.team || {};
  return {
    name: t.shortDisplayName || t.displayName || t.name || '?',
    abbr: t.abbreviation || '',
    logo: t.logo || '',
    score: competitor?.score != null ? String(competitor.score) : '',
    winner: !!competitor?.winner,
  };
}

function parseScoreboard(json) {
  const events = json?.events || [];
  return events.map((ev) => {
    const comp = ev?.competitions?.[0] || {};
    const competitors = comp.competitors || [];
    const home = competitors.find((c) => c.homeAway === 'home') || competitors[0] || {};
    const away = competitors.find((c) => c.homeAway === 'away') || competitors[1] || {};
    const status = ev?.status || comp?.status || {};
    const state = status?.type?.state || 'pre'; // 'pre' | 'in' | 'post'
    return {
      id: ev.id,
      date: ev.date,
      state,
      detail: status?.type?.shortDetail || status?.type?.detail || '',
      clock: status?.displayClock || '',
      group: pickGroup(comp),
      home: teamFrom(home),
      away: teamFrom(away),
    };
  });
}

function statOf(entry, names) {
  for (const n of names) {
    const s = (entry.stats || []).find(
      (x) => x.name === n || x.type === n || x.abbreviation === n
    );
    if (s) {
      const num = typeof s.value === 'number' ? s.value : Number(s.value);
      return { num: Number.isFinite(num) ? num : 0, disp: s.displayValue ?? String(s.value ?? '') };
    }
  }
  return { num: 0, disp: '' };
}

function teamLogo(team) {
  return team?.logos?.[0]?.href || team?.logo || '';
}

function fmtGd(n) {
  return n > 0 ? '+' + n : String(n);
}

// Sort a group's teams (points, GD, GF, name) and refresh display strings + rank
// from the numeric fields. Used for both the official table and the live one.
function finalizeGroup(g) {
  g.teams.sort(
    (a, b) => b._pts - a._pts || b._gd - a._gd || b._gf - a._gf || a.name.localeCompare(b.name)
  );
  g.teams.forEach((t, i) => {
    t.rank = i + 1;
    t.p = String(t._p);
    t.w = String(t._w);
    t.d = String(t._d);
    t.l = String(t._l);
    t.gd = fmtGd(t._gd);
    t.pts = String(t._pts);
  });
}

function parseStandings(json) {
  // ESPN nests groups under children[]; each child has standings.entries[].
  const groups = [];
  const children = json?.children || [];
  for (const child of children) {
    const entries = child?.standings?.entries || [];
    const teams = entries.map((e) => ({
      name: e?.team?.shortDisplayName || e?.team?.displayName || e?.team?.name || '?',
      abbr: e?.team?.abbreviation || '',
      logo: teamLogo(e?.team),
      _p: statOf(e, ['gamesPlayed']).num,
      _w: statOf(e, ['wins']).num,
      _d: statOf(e, ['ties']).num,
      _l: statOf(e, ['losses']).num,
      _gd: statOf(e, ['pointDifferential', 'goalDifference']).num,
      _gf: statOf(e, ['pointsFor', 'goalsFor']).num,
      _pts: statOf(e, ['points']).num,
    }));
    const g = { name: child?.name || child?.abbreviation || 'Group', teams };
    finalizeGroup(g);
    groups.push(g);
  }
  // Order the groups themselves (Group A, B, ... L).
  groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return groups;
}

const norm = (s) => String(s || '').toLowerCase().trim();

// Cross-reference matches and standings: derive each match's group from the
// standings (ESPN often omits it on the scoreboard) and flag which groups have
// a live game right now.
function linkMatchesAndGroups(matches, groups) {
  const teamToGroup = new Map();
  for (const g of groups) {
    for (const t of g.teams) {
      if (t.abbr) teamToGroup.set(norm(t.abbr), g);
      if (t.name) teamToGroup.set(norm(t.name), g);
    }
  }

  for (const m of matches) {
    const g =
      teamToGroup.get(norm(m.home.abbr)) ||
      teamToGroup.get(norm(m.home.name)) ||
      teamToGroup.get(norm(m.away.abbr)) ||
      teamToGroup.get(norm(m.away.name));
    if (g) m.group = g.name;
  }

  const liveTeams = new Set();
  for (const m of matches) {
    if (m.state === 'in') {
      for (const t of [m.home, m.away]) {
        liveTeams.add(norm(t.abbr));
        liveTeams.add(norm(t.name));
      }
    }
  }
  for (const g of groups) {
    g.live = false;
    for (const t of g.teams) {
      t.live = liveTeams.has(norm(t.abbr)) || liveTeams.has(norm(t.name));
      if (t.live) g.live = true;
    }
  }
}

function applyResult(t, gf, ga) {
  t._p += 1;
  t._gf += gf;
  t._gd += gf - ga;
  if (gf > ga) {
    t._w += 1;
    t._pts += 3;
  } else if (gf < ga) {
    t._l += 1;
  } else {
    t._d += 1;
    t._pts += 1;
  }
  t.provisional = true;
}

// Apply in-progress match scores to the standings so the table reflects the
// live state (Played +1, points/GD adjusted, re-sorted) — a "live table".
function applyProvisional(matches, groups) {
  const lookup = new Map();
  for (const g of groups) {
    for (const t of g.teams) {
      if (t.abbr) lookup.set(norm(t.abbr), { t, g });
      if (t.name) lookup.set(norm(t.name), { t, g });
    }
  }

  const touched = new Set();
  for (const m of matches) {
    if (m.state !== 'in') continue;
    const home = lookup.get(norm(m.home.abbr)) || lookup.get(norm(m.home.name));
    const away = lookup.get(norm(m.away.abbr)) || lookup.get(norm(m.away.name));
    if (!home || !away) continue;
    const hs = parseInt(m.home.score, 10) || 0;
    const as = parseInt(m.away.score, 10) || 0;
    applyResult(home.t, hs, as);
    applyResult(away.t, as, hs);
    touched.add(home.g);
    touched.add(away.g);
  }
  for (const g of touched) finalizeGroup(g);
}

async function getWorldCup({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) {
    return cache.data;
  }

  // Fetch both in parallel; degrade gracefully if either fails.
  const [sbRes, stRes] = await Promise.allSettled([
    fetchJson(SCOREBOARD_URL),
    fetchJson(STANDINGS_URL),
  ]);

  let matches = [];
  let groups = [];
  const errors = [];

  if (sbRes.status === 'fulfilled') {
    try {
      matches = parseScoreboard(sbRes.value);
    } catch (e) {
      errors.push(`scoreboard parse: ${e.message}`);
    }
  } else {
    errors.push(`scoreboard: ${sbRes.reason?.message || sbRes.reason}`);
  }

  if (stRes.status === 'fulfilled') {
    try {
      groups = parseStandings(stRes.value);
    } catch (e) {
      errors.push(`standings parse: ${e.message}`);
    }
  } else {
    errors.push(`standings: ${stRes.reason?.message || stRes.reason}`);
  }

  // Link matches to groups, flag live groups, and overlay live scores so the
  // standings reflect in-progress games.
  try {
    linkMatchesAndGroups(matches, groups);
    applyProvisional(matches, groups);
  } catch (e) {
    errors.push(`link: ${e.message}`);
  }

  const data = { matches, groups, errors, fetchedAt: new Date().toISOString() };

  // Only cache a result that actually carries data, so transient failures retry.
  if (matches.length || groups.length) {
    cache = { at: Date.now(), data };
  }
  return data;
}

module.exports = { getWorldCup };
