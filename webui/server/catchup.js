// catchup.js — replay programmes that have already aired.
//
// Xtream exposes this in two halves:
//   * live channels carry `tv_archive` (0/1) and `tv_archive_duration` (days).
//     Only 137 of ~8,500 channels here have it, mostly the UK terrestrials,
//     with 5-14 days of history.
//   * `get_simple_data_table&stream_id=` returns that channel's EPG, with
//     base64 title/description and a `has_archive` flag per programme.
//
// Playback is /streaming/timeshift.php with a start time and a duration in
// minutes. The response is MPEG-TS — the same format as live — so it goes
// through mpegts.js rather than the browser's own MP4 support.

const iptv = require('./iptv');

const EPG_TTL = Number(process.env.EPG_TTL || 600) * 1000; // 10 min
const epgCache = new Map(); // streamId -> { at, data }

// The portal reports its own timezone; times in timeshift URLs are expressed in
// it. Never assume the server's local zone — in Docker that's UTC, which would
// silently fetch the wrong hour of the day.
let portalTz = null;
async function timezone() {
  if (portalTz) return portalTz;
  try {
    const account = await iptv.getAccount();
    portalTz = account.server.timezone || 'UTC';
  } catch {
    portalTz = 'UTC';
  }
  return portalTz;
}

function formatPortalTime(unixSeconds, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(unixSeconds * 1000))
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
}

function decode(s) {
  try {
    return Buffer.from(String(s || ''), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

// -- channels ---------------------------------------------------------------
async function getChannels({ force = false, q = '' } = {}) {
  const catalogue = await iptv.loadCatalogue({ force });
  const tokens = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);

  return catalogue
    .filter((c) => String(c.tv_archive) === '1')
    .filter((c) => {
      if (!tokens.length) return true;
      const hay = String(c.name || '').toLowerCase();
      return tokens.every((t) => hay.includes(t));
    })
    .map((c) => ({
      id: c.stream_id,
      name: c.name,
      icon: c.stream_icon || '',
      days: Number(c.tv_archive_duration) || 0,
      categoryId: String(c.category_id || ''),
    }));
}

// -- EPG --------------------------------------------------------------------
// Returns programmes that have already finished and are still inside the
// channel's archive window — i.e. the ones actually watchable.
async function getEpg(streamId, { force = false } = {}) {
  const key = String(streamId);
  const hit = epgCache.get(key);
  if (!force && hit && Date.now() - hit.at < EPG_TTL) return hit.data;

  const [raw, channels] = await Promise.all([
    fetch(iptv.apiUrl('get_simple_data_table', { stream_id: key }), {
      signal: AbortSignal.timeout(30000),
    }).then(async (r) => {
      const body = await r.text();
      if (!r.ok) throw new Error(`EPG fetch failed: HTTP ${r.status}`);
      try {
        return JSON.parse(body);
      } catch {
        throw new Error(`portal unavailable: ${body.trim().slice(0, 60) || 'empty response'}`);
      }
    }),
    getChannels(),
  ]);

  const channel = channels.find((c) => String(c.id) === key) || null;
  const days = channel ? channel.days : 7;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - days * 86400;

  const listings = (raw.epg_listings || [])
    .map((p) => ({
      id: p.id,
      title: decode(p.title),
      description: decode(p.description),
      start: Number(p.start_timestamp),
      stop: Number(p.stop_timestamp),
      hasArchive: String(p.has_archive) === '1',
      nowPlaying: String(p.now_playing) === '1',
    }))
    .filter((p) => p.start && p.stop);

  const past = listings
    .filter((p) => p.stop <= now && p.stop >= windowStart && p.hasArchive)
    .sort((a, b) => b.start - a.start)
    .map((p) => ({ ...p, durationMins: Math.max(1, Math.round((p.stop - p.start) / 60)) }));

  const data = {
    channel,
    days,
    windowStart,
    now,
    total: listings.length,
    programmes: past,
  };
  if (epgCache.size >= 200) epgCache.delete(epgCache.keys().next().value);
  epgCache.set(key, { at: Date.now(), data });
  return data;
}

// -- stream -----------------------------------------------------------------
// `start` is a unix timestamp and `duration` is in minutes — the portal's own
// units. Seeking within a programme means asking for a later start.
async function archiveUrl(streamId, start, durationMins) {
  const { U, P, SERVER, PORT } = iptv.resolveCredentials();
  const tz = await timezone();
  const startStr = formatPortalTime(start, tz);
  const dur = Math.max(1, Math.round(durationMins));
  const url = new URL(`http://${SERVER}:${PORT}/streaming/timeshift.php`);
  url.searchParams.set('username', U);
  url.searchParams.set('password', P);
  url.searchParams.set('stream', String(streamId));
  url.searchParams.set('start', startStr);
  url.searchParams.set('duration', String(dur));
  return url.toString();
}

module.exports = { getChannels, getEpg, archiveUrl, formatPortalTime };
