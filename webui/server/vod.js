// vod.js — the film (VOD) catalogue: fetch/cache, search, per-film detail.
//
// Xtream exposes films through three calls on player_api.php:
//   get_vod_categories  -> 52 categories
//   get_vod_streams     -> the whole catalogue (~21k films, ~6MB, ~1.3s)
//   get_vod_info&vod_id -> full metadata for one film
//
// Two things the provider does NOT give us, which shape the code below:
//   * No year field. The year lives in the title ("Love (2015)") for ~86% of
//     the catalogue; get_vod_info has a real `releasedate` for the rest.
//   * No working search. `&search=` is ignored and returns everything, so we
//     filter the cached list ourselves, exactly like live channels.

const fs = require('fs');
const path = require('path');

const { CACHE_DIR, resolveCredentials, apiUrl } = require('./iptv');

const CACHE_TTL = Number(process.env.VOD_CACHE_TTL || 21600) * 1000; // 6h
const FILMS_JSON = path.join(CACHE_DIR, 'vod_streams.json');
const CATS_JSON = path.join(CACHE_DIR, 'vod_categories.json');

// get_vod_info is small and per-film; keep a bounded in-memory cache so
// reopening the same film doesn't hit the portal again.
const INFO_TTL = Number(process.env.VOD_INFO_TTL || 3600) * 1000; // 1h
const INFO_MAX = 500;
const infoCache = new Map(); // id -> { at, data }

let memo = null; // { at, films, cats }

// -- fetching ---------------------------------------------------------------
async function apiCall(action, params = {}) {
  const url = apiUrl(action, params);
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
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
  const [films, cats] = await Promise.all([
    apiCall('get_vod_streams'),
    apiCall('get_vod_categories'),
  ]);
  if (!Array.isArray(films) || !Array.isArray(cats)) throw new Error('unexpected VOD response');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(FILMS_JSON, JSON.stringify(films));
  fs.writeFileSync(CATS_JSON, JSON.stringify(cats));
  return { films, cats };
}

async function loadCatalogue({ force = false } = {}) {
  const stale = cacheAgeMs(FILMS_JSON) > CACHE_TTL || cacheAgeMs(CATS_JSON) > CACHE_TTL;
  if (memo && !force && !stale) return memo;

  let raw;
  if (force || stale) {
    try {
      raw = await refreshCatalogue();
    } catch (err) {
      if (!fs.existsSync(FILMS_JSON) || !fs.existsSync(CATS_JSON)) throw err;
      console.warn('[vod] refresh failed, using stale cache:', err.message);
    }
  }
  if (!raw) {
    raw = {
      films: JSON.parse(fs.readFileSync(FILMS_JSON, 'utf8')),
      cats: JSON.parse(fs.readFileSync(CATS_JSON, 'utf8')),
    };
  }

  // Normalise once at load; searching then touches only cheap fields.
  const films = raw.films.map(shapeFilm);
  memo = { at: Date.now(), films, cats: raw.cats };
  return memo;
}

// -- shaping ----------------------------------------------------------------
// Titles carry decoration the provider never separates out:
//   "4K | Thunderbolts* (2025)" -> title "Thunderbolts*", year 2025, tag "4K"
const YEAR_RE = /\s*\((19|20)\d{2}\)\s*$/;
const TAG_RE = /^\s*(4K|UHD|HD|FHD|SD|ESP|MULTI|VOD)\s*\|\s*/i;

function shapeFilm(f) {
  const name = String(f.name || '').trim();
  let title = name;
  let tag = '';

  const tagMatch = title.match(TAG_RE);
  if (tagMatch) {
    tag = tagMatch[1].toUpperCase();
    title = title.replace(TAG_RE, '');
  }

  let year = null;
  const yearMatch = title.match(YEAR_RE);
  if (yearMatch) {
    year = Number(yearMatch[0].replace(/[()\s]/g, ''));
    title = title.replace(YEAR_RE, '');
  }

  const rating = Number(f.rating);
  return {
    id: f.stream_id,
    name,
    title: title.trim() || name,
    year,
    tag,
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    poster: f.stream_icon || '',
    added: Number(f.added) || 0,
    categoryId: String(f.category_id || ''),
    ext: f.container_extension || 'vod',
    // Lowercased once so search doesn't re-lowercase 21k names per keystroke.
    _hay: name.toLowerCase(),
  };
}

function publicFilm(f) {
  return {
    id: f.id,
    name: f.name,
    title: f.title,
    year: f.year,
    tag: f.tag,
    rating: f.rating,
    poster: f.poster,
    added: f.added,
    categoryId: f.categoryId,
  };
}

// -- search -----------------------------------------------------------------
const SORTS = {
  added: (a, b) => b.added - a.added,
  rating: (a, b) => (b.rating || 0) - (a.rating || 0),
  year: (a, b) => (b.year || 0) - (a.year || 0),
  title: (a, b) => a.title.localeCompare(b.title),
};

async function searchMovies({
  q = '',
  category = '',
  yearFrom = null,
  yearTo = null,
  sort = 'added',
  limit = 60,
  offset = 0,
  force = false,
} = {}) {
  const { films } = await loadCatalogue({ force });
  const tokens = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const cat = String(category || '');

  let out = films;
  if (cat) out = out.filter((f) => f.categoryId === cat);
  if (tokens.length) out = out.filter((f) => tokens.every((t) => f._hay.includes(t)));
  if (yearFrom != null) out = out.filter((f) => f.year != null && f.year >= yearFrom);
  if (yearTo != null) out = out.filter((f) => f.year != null && f.year <= yearTo);

  const total = out.length;
  const cmp = SORTS[sort] || SORTS.added;
  // Copy before sorting: `out` may still be the cached array when no filter ran.
  out = out.slice().sort(cmp);

  return {
    total,
    items: out.slice(offset, offset + limit).map(publicFilm),
  };
}

async function getCategories({ force = false } = {}) {
  const { films, cats } = await loadCatalogue({ force });
  const counts = {};
  for (const f of films) counts[f.categoryId] = (counts[f.categoryId] || 0) + 1;
  return cats
    .map((c) => ({
      id: String(c.category_id),
      name: c.category_name,
      count: counts[String(c.category_id)] || 0,
    }))
    .filter((c) => c.count > 0);
}

// -- per-film detail --------------------------------------------------------
function shapeInfo(raw, listEntry) {
  const i = (raw && raw.info) || {};
  const m = (raw && raw.movie_data) || {};

  // `releasedate` is authoritative where present; fall back to the year parsed
  // out of the title (the ~14% of films whose titles carry no year).
  const relYear = Number(String(i.releasedate || '').slice(0, 4)) || null;
  const rating = Number(i.rating);

  return {
    id: m.stream_id || (listEntry && listEntry.id) || null,
    name: m.name || i.name || (listEntry && listEntry.name) || '',
    title: (listEntry && listEntry.title) || i.name || '',
    year: relYear || (listEntry && listEntry.year) || null,
    releaseDate: i.releasedate || '',
    plot: i.plot || i.description || '',
    genre: i.genre || '',
    cast: i.cast || i.actors || '',
    director: i.director || '',
    country: i.country || '',
    duration: i.duration || '',
    durationSecs: Number(i.duration_secs) || null,
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    mpaa: i.mpaa_rating || '',
    poster: i.cover_big || i.movie_image || (listEntry && listEntry.poster) || '',
    backdrop: Array.isArray(i.backdrop_path) ? i.backdrop_path[0] || '' : '',
    trailer: i.youtube_trailer || '',
    tmdbId: i.tmdb_id || '',
    ext: m.container_extension || (listEntry && listEntry.ext) || 'vod',
  };
}

async function getMovie(id, { force = false } = {}) {
  const key = String(id);
  const hit = infoCache.get(key);
  if (!force && hit && Date.now() - hit.at < INFO_TTL) return hit.data;

  const { films } = await loadCatalogue();
  const listEntry = films.find((f) => String(f.id) === key) || null;

  const raw = await apiCall('get_vod_info', { vod_id: key });
  const data = shapeInfo(raw, listEntry);
  if (!data.id) throw new Error('film not found');

  if (infoCache.size >= INFO_MAX) infoCache.delete(infoCache.keys().next().value);
  infoCache.set(key, { at: Date.now(), data });
  return data;
}

// -- container probe --------------------------------------------------------
// `container_extension` is "vod" for every film and tells us nothing: the
// actual files are a mix of MP4, MKV and AVI. Only MP4 plays in a browser, so
// sniff the first bytes to find out what we're dealing with before playing.
const probeCache = new Map(); // id -> { at, data }
const PROBE_TTL = Number(process.env.VOD_PROBE_TTL || 86400) * 1000; // 24h

function detectContainer(buf) {
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buf.slice(0, 4).toString('hex') === '1a45dfa3') return 'mkv';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 11).toString('latin1') === 'AVI')
    return 'avi';
  if (buf[0] === 0x47) return 'ts';
  return 'unknown';
}

async function probeMovie(id, { force = false } = {}) {
  return probeStream(movieUrl(id), `movie:${id}`, { force, id: Number(id) });
}

// Shared by films and series episodes: both are VOD files behind a URL whose
// extension says nothing about what's actually in it.
async function probeStream(url, key, { force = false, id = null } = {}) {
  const hit = probeCache.get(key);
  if (!force && hit && Date.now() - hit.at < PROBE_TTL) return hit.data;

  const resp = await fetch(url, {
    headers: { 'User-Agent': STREAM_UA, Range: 'bytes=0-65535' },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok && resp.status !== 206 && resp.status !== 200) {
    throw new Error(`probe failed: HTTP ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const head = buf.toString('latin1');
  const container = detectContainer(buf);
  const hevc = /hvc1|hev1|V_MPEGH\/ISO\/HEVC/.test(head);

  // MP4/H.264 plays natively; anything else goes through ffmpeg, which swaps
  // the container without re-encoding the video.
  const direct = container === 'mp4' && !hevc;
  let reason = '';
  if (direct) reason = 'MP4 · plays natively';
  else if (container === 'mp4' && hevc) reason = 'HEVC video — remuxed for playback';
  else if (container === 'unknown') reason = 'unrecognised file — attempting remux';
  else reason = `${container.toUpperCase()} · remuxed on the fly`;

  const sizeHeader = resp.headers.get('content-range') || '';
  const size = Number(sizeHeader.split('/')[1]) || null;

  const data = {
    id,
    container,
    hevc,
    direct,
    mode: direct ? 'direct' : 'remux',
    // Kept for older callers; `mode` is what the player switches on.
    playable: direct,
    reason,
    size,
  };
  if (probeCache.size >= 1000) probeCache.delete(probeCache.keys().next().value);
  probeCache.set(key, { at: Date.now(), data });
  return data;
}

// -- stream URL -------------------------------------------------------------
const STREAM_UA = process.env.IPTV_USER_AGENT || 'VLC/3.0.20 LibVLC/3.0.20';

function movieUrl(id, ext = 'vod') {
  const { U, P, SERVER, PORT } = resolveCredentials();
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'vod';
  return `http://${SERVER}:${PORT}/movie/${U}/${P}/${id}.${safeExt}`;
}

module.exports = {
  loadCatalogue,
  refreshCatalogue,
  searchMovies,
  getCategories,
  getMovie,
  probeMovie,
  probeStream,
  movieUrl,
};
