// config.js — optional JSON config file, the lowest-priority settings source.
//
// Everything in the app reads process.env. This module fills in anything that
// isn't set yet from a config file, which gives a clear precedence:
//
//   real environment variables  >  webui/.env  >  config file  >  code defaults
//
// So a config file can hold your normal setup, and a single env var can override
// one value for a run without editing anything:
//
//   PORT=9000 make dev
//
// Looked for in order: $IPTV_CONFIG, webui/config.json, ~/.config/iptv/config.json.
// Nothing here is required — the app runs on env vars alone, as before.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Nested config keys mapped to the environment variables the code already uses.
// Flat keys using the env var names directly work too, for anyone who prefers
// them (e.g. { "IPTV_USERNAME": "..." }).
const MAP = {
  'provider.username': 'IPTV_USERNAME',
  'provider.password': 'IPTV_PASSWORD',
  'provider.loginUrl': 'IPTV_LOGIN_URL',
  'provider.server': 'IPTV_SERVER',
  'provider.port': 'IPTV_PORT',
  'provider.userAgent': 'IPTV_USER_AGENT',
  'provider.localStorageDb': 'IPTV_LS_DB',

  'server.port': 'PORT',
  'server.host': 'HOST',
  'server.cacheDir': 'CACHE_DIR',

  'cache.live': 'CACHE_TTL',
  'cache.account': 'ACCOUNT_TTL',
  'cache.films': 'VOD_CACHE_TTL',
  'cache.filmInfo': 'VOD_INFO_TTL',
  'cache.filmProbe': 'VOD_PROBE_TTL',
  'cache.series': 'SERIES_CACHE_TTL',
  'cache.seriesInfo': 'SERIES_INFO_TTL',
  'cache.epg': 'EPG_TTL',
  'cache.posterMb': 'POSTER_CACHE_MB',

  'playback.ffmpegPath': 'FFMPEG_PATH',
  'playback.ffprobePath': 'FFPROBE_PATH',
  'playback.audioBitrate': 'REMUX_AUDIO_BITRATE',
  'playback.audioChannels': 'REMUX_AUDIO_CHANNELS',

  'remote.host': 'REMOTE_HOST',
  'remote.pairTtl': 'REMOTE_PAIR_TTL',
};

const KNOWN_ENV = new Set(Object.values(MAP));

function candidates() {
  const list = [];
  if (process.env.IPTV_CONFIG) list.push(process.env.IPTV_CONFIG);
  list.push(path.join(__dirname, '..', 'config.json'));
  list.push(path.join(os.homedir(), '.config', 'iptv', 'config.json'));
  return list;
}

function valueAt(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function apply(config, file) {
  let applied = 0;

  const set = (envKey, value) => {
    if (value === undefined || value === null || value === '') return;
    // Only fill gaps: a real env var or a .env line has already won.
    if (process.env[envKey] !== undefined) return;
    process.env[envKey] = String(value);
    applied++;
  };

  for (const [dotted, envKey] of Object.entries(MAP)) set(envKey, valueAt(config, dotted));
  // Flat form, for anyone who'd rather write the env names directly.
  for (const [key, value] of Object.entries(config)) {
    if (KNOWN_ENV.has(key)) set(key, value);
  }

  if (applied) console.log(`[config] ${applied} setting(s) loaded from ${file}`);
  return applied;
}

for (const file of candidates()) {
  try {
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') apply(parsed, file);
    break; // first file found wins; it isn't merged with the others
  } catch (err) {
    // A malformed config shouldn't stop the app booting — env vars may well be
    // enough on their own — but it should be loud.
    console.warn(`[config] ignoring ${file}: ${err.message}`);
    break;
  }
}

module.exports = { MAP };
