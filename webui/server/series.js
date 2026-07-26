// series.js — the TV series catalogue: 6,500 shows with seasons and episodes.
//
// Shaped like vod.js, with two differences worth knowing:
//   * `get_series` already carries plot, cast, genre, rating and artwork, so a
//     browse grid needs no per-show lookup — only the season/episode list does.
//   * Episodes are ordinary VOD files at /series/<user>/<pass>/<id>.<ext>, so
//     they reuse the film probe and the same direct/remux playback split.

const fs = require('fs');
const path = require('path');

const iptv = require('./iptv');
const vod = require('./vod');

const CACHE_TTL = Number(process.env.SERIES_CACHE_TTL || 21600) * 1000; // 6h
const SHOWS_JSON = path.join(iptv.CACHE_DIR, 'series.json');
const CATS_JSON = path.join(iptv.CACHE_DIR, 'series_categories.json');

const INFO_TTL = Number(process.env.SERIES_INFO_TTL || 3600) * 1000; // 1h
const INFO_MAX = 300;
const infoCache = new Map();

let memo = null;

// -- fetching ---------------------------------------------------------------
async function apiCall(action, params = {}) {
  const resp = await fetch(iptv.apiUrl(action, params), { signal: AbortSignal.timeout(60000) });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`${action} failed: HTTP ${resp.status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`portal unavailable: ${body.trim().slice(0, 60) || 'empty response'}`);
  }
}

function cacheAgeMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

async function refreshCatalogue() {
  const [shows, cats] = await Promise.all([
    apiCall('get_series'),
    apiCall('get_series_categories'),
  ]);
  if (!Array.isArray(shows) || !Array.isArray(cats)) throw new Error('unexpected series response');
  fs.mkdirSync(iptv.CACHE_DIR, { recursive: true });
  fs.writeFileSync(SHOWS_JSON, JSON.stringify(shows));
  fs.writeFileSync(CATS_JSON, JSON.stringify(cats));
  return { shows, cats };
}

async function loadCatalogue({ force = false } = {}) {
  const stale = cacheAgeMs(SHOWS_JSON) > CACHE_TTL || cacheAgeMs(CATS_JSON) > CACHE_TTL;
  if (memo && !force && !stale) return memo;

  let raw;
  if (force || stale) {
    try {
      raw = await refreshCatalogue();
    } catch (err) {
      if (!fs.existsSync(SHOWS_JSON) || !fs.existsSync(CATS_JSON)) throw err;
      console.warn('[series] refresh failed, using stale cache:', err.message);
    }
  }
  if (!raw) {
    raw = {
      shows: JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8')),
      cats: JSON.parse(fs.readFileSync(CATS_JSON, 'utf8')),
    };
  }

  const shows = raw.shows.map(shapeShow);
  memo = { at: Date.now(), shows, cats: raw.cats };
  return memo;
}

// -- shaping ----------------------------------------------------------------
function shapeShow(s) {
  const name = String(s.name || '').trim();
  const rating = Number(s.rating);
  const year = Number(String(s.releaseDate || '').slice(0, 4)) || null;
  return {
    id: s.series_id,
    name,
    year,
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    cover: s.cover || '',
    genre: s.genre || '',
    plot: s.plot || '',
    lastModified: Number(s.last_modified) || 0,
    categoryId: String(s.category_id || ''),
    _hay: name.toLowerCase(),
  };
}

function publicShow(s) {
  return {
    id: s.id,
    name: s.name,
    year: s.year,
    rating: s.rating,
    cover: s.cover,
    genre: s.genre,
    categoryId: s.categoryId,
  };
}

// -- search -----------------------------------------------------------------
const SORTS = {
  added: (a, b) => b.lastModified - a.lastModified,
  rating: (a, b) => (b.rating || 0) - (a.rating || 0),
  year: (a, b) => (b.year || 0) - (a.year || 0),
  title: (a, b) => a.name.localeCompare(b.name),
};

async function searchSeries({
  q = '',
  category = '',
  sort = 'added',
  limit = 60,
  offset = 0,
  force = false,
} = {}) {
  const { shows } = await loadCatalogue({ force });
  const tokens = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const cat = String(category || '');

  let out = shows;
  if (cat) out = out.filter((s) => s.categoryId === cat);
  if (tokens.length) out = out.filter((s) => tokens.every((t) => s._hay.includes(t)));

  const total = out.length;
  out = out.slice().sort(SORTS[sort] || SORTS.added);
  return { total, items: out.slice(offset, offset + limit).map(publicShow) };
}

async function getCategories({ force = false } = {}) {
  const { shows, cats } = await loadCatalogue({ force });
  const counts = {};
  for (const s of shows) counts[s.categoryId] = (counts[s.categoryId] || 0) + 1;
  return cats
    .map((c) => ({
      id: String(c.category_id),
      name: c.category_name,
      count: counts[String(c.category_id)] || 0,
    }))
    .filter((c) => c.count > 0);
}

// -- one show, with its episodes --------------------------------------------
function shapeEpisode(ep, seasonNum) {
  const info = ep.info || {};
  return {
    id: Number(ep.id),
    episode: Number(ep.episode_num) || 0,
    season: Number(ep.season ?? seasonNum) || Number(seasonNum) || 0,
    title: ep.title || '',
    plot: info.plot || '',
    still: info.movie_image || '',
    duration: info.duration || '',
    durationSecs: Number(info.duration_secs) || null,
    releaseDate: info.releasedate || '',
    ext: ep.container_extension || 'vod',
    added: Number(ep.added) || 0,
  };
}

async function getShow(id, { force = false } = {}) {
  const key = String(id);
  const hit = infoCache.get(key);
  if (!force && hit && Date.now() - hit.at < INFO_TTL) return hit.data;

  const raw = await apiCall('get_series_info', { series_id: key });
  const info = raw.info || {};
  const { shows } = await loadCatalogue();
  const listEntry = shows.find((s) => String(s.id) === key) || null;

  // `episodes` is keyed by season number; some shows also have a `seasons`
  // array with artwork, but it isn't always present.
  const seasons = Object.entries(raw.episodes || {})
    .map(([num, eps]) => ({
      season: Number(num),
      episodes: (Array.isArray(eps) ? eps : [])
        .map((e) => shapeEpisode(e, num))
        .sort((a, b) => a.episode - b.episode),
    }))
    .filter((s) => s.episodes.length)
    .sort((a, b) => a.season - b.season);

  const rating = Number(info.rating);
  const data = {
    id: Number(key),
    name: info.name || (listEntry && listEntry.name) || '',
    year:
      Number(String(info.releaseDate || '').slice(0, 4)) || (listEntry && listEntry.year) || null,
    plot: info.plot || (listEntry && listEntry.plot) || '',
    cast: info.cast || '',
    director: info.director || '',
    genre: info.genre || '',
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    cover: info.cover || (listEntry && listEntry.cover) || '',
    backdrop: Array.isArray(info.backdrop_path) ? info.backdrop_path[0] || '' : '',
    trailer: info.youtube_trailer || '',
    runtime: Number(info.episode_run_time) || null,
    seasons,
    episodeCount: seasons.reduce((n, s) => n + s.episodes.length, 0),
  };

  if (infoCache.size >= INFO_MAX) infoCache.delete(infoCache.keys().next().value);
  infoCache.set(key, { at: Date.now(), data });
  return data;
}

// -- episode playback -------------------------------------------------------
function episodeUrl(episodeId, ext = 'vod') {
  const { U, P, SERVER, PORT } = iptv.resolveCredentials();
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'vod';
  return `http://${SERVER}:${PORT}/series/${U}/${P}/${episodeId}.${safeExt}`;
}

function probeEpisode(episodeId, { force = false } = {}) {
  return vod.probeStream(episodeUrl(episodeId), `episode:${episodeId}`, {
    force,
    id: Number(episodeId),
  });
}

module.exports = {
  loadCatalogue,
  refreshCatalogue,
  searchSeries,
  getCategories,
  getShow,
  probeEpisode,
  episodeUrl,
};
