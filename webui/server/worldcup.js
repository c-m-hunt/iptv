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

function parseStandings(json) {
  // ESPN nests groups under children[]; each child has standings.entries[].
  const groups = [];
  const children = json?.children || [];
  for (const child of children) {
    const entries = child?.standings?.entries || [];
    const teams = entries.map((e) => {
      const stat = (name) => {
        const s = (e.stats || []).find((x) => x.name === name || x.type === name);
        return s ? (s.displayValue ?? String(s.value ?? '')) : '';
      };
      return {
        name: e?.team?.shortDisplayName || e?.team?.displayName || e?.team?.name || '?',
        abbr: e?.team?.abbreviation || '',
        p: stat('gamesPlayed'),
        w: stat('wins'),
        d: stat('ties'),
        l: stat('losses'),
        gd: stat('pointDifferential') || stat('goalDifference'),
        pts: stat('points'),
      };
    });
    groups.push({ name: child?.name || child?.abbreviation || 'Group', teams });
  }
  return groups;
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

  const data = { matches, groups, errors, fetchedAt: new Date().toISOString() };

  // Only cache a result that actually carries data, so transient failures retry.
  if (matches.length || groups.length) {
    cache = { at: Date.now(), data };
  }
  return data;
}

module.exports = { getWorldCup };
