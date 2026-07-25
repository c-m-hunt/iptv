// iptv.js — credentials, catalogue fetch/cache, and stream URL building.
// Xtream Codes compatible. Live channels only.
//
// Credentials come from (highest priority first):
//   1. IPTV_* environment variables (see .env / .env.example)
//   2. An optional desktop IPTV app's localStorage profile, when IPTV_LS_DB
//      points at its `file__0.localstorage` (read via the `sqlite3` CLI)
// Nothing provider-specific is hardcoded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const CACHE_DIR =
  process.env.CACHE_DIR ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'iptv');
const CACHE_TTL = Number(process.env.CACHE_TTL || 21600) * 1000; // ms (6h default)
const CACHE_JSON = path.join(CACHE_DIR, 'live_streams.json');
// Account info is small and `active_cons` moves in real time — cache it briefly
// in memory only, so it never touches disk.
const ACCOUNT_TTL = Number(process.env.ACCOUNT_TTL || 15) * 1000; // ms (15s default)

// Optional path to a desktop IPTV app's localStorage DB; empty = don't read one.
const LS_DB = process.env.IPTV_LS_DB || '';

let cachedCreds = null;

// -- credentials ------------------------------------------------------------
function readProfileFromLocalStorage() {
  if (!LS_DB || !fs.existsSync(LS_DB)) return null;
  let tmp;
  try {
    // Copy first: the DB may be locked while the IPTV app is running.
    tmp = path.join(os.tmpdir(), `iptv-ls-${process.pid}-${Date.now()}.localstorage`);
    fs.copyFileSync(LS_DB, tmp);
    const raw = execFileSync(
      'sqlite3',
      [tmp, "SELECT value FROM ItemTable WHERE key='profile';"],
      { encoding: 'utf8' }
    );
    // localStorage values can carry stray NUL bytes (UTF-16 storage) — strip them.
    const clean = raw.split(String.fromCharCode(0)).join('').trim();
    if (!clean) return null;
    return JSON.parse(clean);
  } catch (err) {
    console.warn('[iptv] could not read localStorage profile:', err.message);
    return null;
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

function resolveCredentials() {
  if (cachedCreds) return cachedCreds;

  let fromLs = {};
  const profile = readProfileFromLocalStorage();
  if (profile) {
    fromLs = {
      U: profile?.user_info?.username || '',
      P: profile?.user_info?.password || '',
      LOGIN: profile?.user_info?.login_url || '',
      SERVER: profile?.server_info?.url || '',
      PORT: profile?.server_info?.port || '',
    };
  }

  const creds = {
    U: process.env.IPTV_USERNAME || fromLs.U || '',
    P: process.env.IPTV_PASSWORD || fromLs.P || '',
    LOGIN: process.env.IPTV_LOGIN_URL || fromLs.LOGIN || '',
    SERVER: process.env.IPTV_SERVER || fromLs.SERVER || '',
    PORT: process.env.IPTV_PORT || fromLs.PORT || '80',
  };

  if (!creds.U || !creds.P || !creds.LOGIN || !creds.SERVER) {
    throw new Error(
      'IPTV not configured. Set IPTV_USERNAME, IPTV_PASSWORD, IPTV_LOGIN_URL and ' +
        'IPTV_SERVER (see .env.example), or point IPTV_LS_DB at a desktop IPTV ' +
        "app's localStorage."
    );
  }

  cachedCreds = creds;
  return creds;
}

function hasCredentials() {
  try {
    resolveCredentials();
    return true;
  } catch {
    return false;
  }
}

// Build a player_api.php URL with credentials applied. Shared with vod.js so
// there's one place that knows how the portal is addressed.
function apiUrl(action = '', params = {}) {
  const { U, P, LOGIN } = resolveCredentials();
  const url = new URL(`${LOGIN.replace(/\/$/, '')}/player_api.php`);
  url.searchParams.set('username', U);
  url.searchParams.set('password', P);
  if (action) url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url;
}

// -- catalogue --------------------------------------------------------------
function cacheAgeMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

async function refreshCatalogue() {
  const { U, P, LOGIN } = resolveCredentials();
  const url = new URL(`${LOGIN.replace(/\/$/, '')}/player_api.php`);
  url.searchParams.set('username', U);
  url.searchParams.set('password', P);
  url.searchParams.set('action', 'get_live_streams');

  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`catalogue fetch failed: HTTP ${resp.status}`);
  const data = await resp.json();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_JSON, JSON.stringify(data));
  return data;
}

async function loadCatalogue({ force = false } = {}) {
  if (force || cacheAgeMs(CACHE_JSON) > CACHE_TTL) {
    try {
      return await refreshCatalogue();
    } catch (err) {
      // Fall back to a stale cache if the refresh failed but we have something.
      if (fs.existsSync(CACHE_JSON)) {
        console.warn('[iptv] refresh failed, using stale cache:', err.message);
      } else {
        throw err;
      }
    }
  }
  return JSON.parse(fs.readFileSync(CACHE_JSON, 'utf8'));
}

// Returns [{ id, name }] of live channels whose name contains ALL hint words
// (case-insensitive AND match).
async function getChannels(query = '', { force = false, limit = 200 } = {}) {
  const catalogue = await loadCatalogue({ force });
  const tokens = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);

  const out = [];
  for (const ch of catalogue) {
    const name = ch.name || '';
    const hay = name.toLowerCase();
    if (tokens.every((t) => hay.includes(t))) {
      out.push({ id: ch.stream_id, name });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// -- account / subscription -------------------------------------------------
// The bare player_api.php call (no `action`) is the Xtream auth endpoint: it
// returns `user_info` + `server_info`. That's what the desktop app's profile
// page is built from.
let accountCache = null; // { at, data }

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Reshape into camelCase and — deliberately — drop `user_info.password`, which
// the provider echoes back in cleartext. It must never reach the browser.
function shapeAccount(raw) {
  const u = (raw && raw.user_info) || {};
  const s = (raw && raw.server_info) || {};
  return {
    user: {
      username: u.username || '',
      status: u.status || 'Unknown',
      auth: toNum(u.auth),
      isTrial: u.is_trial === '1' || u.is_trial === 1,
      expDate: toNum(u.exp_date), // unix seconds; null = no expiry set
      createdAt: toNum(u.created_at),
      maxConnections: toNum(u.max_connections),
      activeConnections: toNum(u.active_cons),
      allowedFormats: Array.isArray(u.allowed_output_formats) ? u.allowed_output_formats : [],
      message: u.message || '',
    },
    server: {
      url: s.url || '',
      port: s.port || '',
      httpsPort: s.https_port || '',
      rtmpPort: s.rtmp_port || '',
      protocol: s.server_protocol || '',
      timezone: s.timezone || '',
      timeNow: s.time_now || '',
      // Provider's own clock — used to compute "days left" without trusting the
      // browser's clock or timezone.
      timestampNow: toNum(s.timestamp_now),
    },
    fetchedAt: Date.now(),
  };
}

async function fetchAccountOnce() {
  const { U, P, LOGIN } = resolveCredentials();
  const url = new URL(`${LOGIN.replace(/\/$/, '')}/player_api.php`);
  url.searchParams.set('username', U);
  url.searchParams.set('password', P);
  // The portal sits behind an HTTP cache that keys on the exact URL: repeat the
  // same request and it replays a response minutes old, which freezes
  // `active_cons` at whatever it was and `time_now` with it. A unique param
  // plus no-cache headers is what actually gets live numbers back.
  url.searchParams.set('_', `${Date.now()}${Math.random().toString(36).slice(2, 8)}`);

  const resp = await fetch(url, {
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`account fetch failed: HTTP ${resp.status}`);

  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    // The portal intermittently answers with a plain-text error ("Got 503
    // upstream") rather than JSON.
    throw new Error(`portal unavailable: ${body.trim().slice(0, 60) || 'empty response'}`);
  }
  if (!raw.user_info || !raw.user_info.auth) throw new Error('provider rejected the credentials');
  return shapeAccount(raw);
}

async function getAccount({ force = false } = {}) {
  if (!force && accountCache && Date.now() - accountCache.at < ACCOUNT_TTL) {
    return accountCache.data;
  }

  // The portal is flaky enough that one 503 shouldn't blank the panel: retry
  // once, then fall back to the last good answer, flagged as stale.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await fetchAccountOnce();
      accountCache = { at: Date.now(), data };
      return data;
    } catch (err) {
      if (attempt === 1) {
        if (accountCache) {
          console.warn('[iptv] account refresh failed, serving stale:', err.message);
          return { ...accountCache.data, stale: true };
        }
        throw err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function streamUrl(id) {
  const { U, P, SERVER, PORT } = resolveCredentials();
  return `http://${SERVER}:${PORT}/live/${U}/${P}/${id}.ts`;
}

// Pipe a live .ts stream from the IPTV server to the client. Credentials never
// leave the server; the browser only ever talks to /api/stream/live/:id.
const STREAM_UA = process.env.IPTV_USER_AGENT || 'VLC/3.0.20 LibVLC/3.0.20';
const MAX_REDIRECTS = 6;

function proxyStream(id, clientReq, clientRes) {
  let startUrl;
  try {
    startUrl = streamUrl(id);
  } catch (err) {
    clientRes.status(500).json({ error: err.message });
    return;
  }
  proxyFrom(startUrl, clientReq, clientRes);
}

// Pipe an arbitrary upstream media URL to the client. Used for live streams and
// for films, which live at a different path but behave the same way.
function proxyFrom(startUrl, clientReq, clientRes) {
  // Xtream servers 302-redirect to a token-authenticated edge node (often a
  // different host/port, sometimes https). Follow the chain, then pipe the
  // final 200/206 to the browser.
  const headers = { 'User-Agent': STREAM_UA, Accept: '*/*' };
  if (clientReq.headers.range) headers.Range = clientReq.headers.range;

  let active = null;
  let done = false;
  const stop = () => {
    done = true;
    if (active) active.destroy();
  };
  clientReq.on('close', stop);

  const fail = (code, msg) => {
    if (done) return;
    if (!clientRes.headersSent) clientRes.status(code).json({ error: msg });
    else clientRes.end();
  };

  const go = (url, hop) => {
    if (done) return;
    if (hop > MAX_REDIRECTS) return fail(502, 'too many redirects');

    let u;
    try {
      u = new URL(url);
    } catch {
      return fail(502, 'bad upstream URL');
    }
    const mod = u.protocol === 'https:' ? https : http;

    const req = mod.get(u, { headers }, (up) => {
      const sc = up.statusCode || 0;

      // Redirect — drain and follow.
      if (sc >= 300 && sc < 400 && up.headers.location) {
        up.resume();
        go(new URL(up.headers.location, u).toString(), hop + 1);
        return;
      }
      if (sc >= 400) {
        up.resume();
        return fail(502, `upstream HTTP ${sc}`);
      }

      // Final response — stream it through.
      active = up;
      if (!clientRes.headersSent) {
        clientRes.status(sc || 200);
        const ct = up.headers['content-type'] || '';
        clientRes.setHeader('Content-Type', ct.startsWith('video') ? ct : 'video/mp2t');
        clientRes.setHeader('Cache-Control', 'no-store');
        for (const h of ['content-length', 'content-range']) {
          if (up.headers[h]) clientRes.setHeader(h, up.headers[h]);
        }
        // The portal answers with a non-standard `accept-ranges: 0-1168479440`
        // (a byte count, where the spec wants a unit). Browsers read that as
        // "ranges unsupported" and disable seeking, so normalise it — the
        // server does honour ranges, as the 206 + content-range prove.
        if (up.headers['accept-ranges'] || up.headers['content-range']) {
          clientRes.setHeader('Accept-Ranges', 'bytes');
        }
      }
      up.on('error', () => clientRes.end());
      up.pipe(clientRes);
    });

    active = req;
    req.on('error', (err) => {
      if (done) return;
      console.warn('[iptv] stream upstream error:', err.message);
      fail(502, 'stream error');
    });
    req.setTimeout(15000, () => req.destroy(new Error('upstream timeout')));
  };

  go(startUrl, 0);
}

module.exports = {
  CACHE_DIR,
  hasCredentials,
  resolveCredentials,
  apiUrl,
  proxyFrom,
  getChannels,
  getAccount,
  refreshCatalogue,
  streamUrl,
  proxyStream,
};
