// remote.js — the phone side. Sends commands, renders the screen's reported
// state. Never plays anything: the picture stays on the main screen.
//
// Pairing details arrive in the URL fragment (#s=…&t=…) because fragments are
// never sent to a server — the token stays out of access logs and Referer
// headers. They're moved into sessionStorage so a reload keeps working.

const STORE = 'iptv-remote-pairing';
const RECONNECT_MS = 1500;

const el = (id) => document.getElementById(id);
const dot = el('dot');
const statusEl = el('status');
const screensEl = el('screens');

let pairing = readPairing();
let ws = null;
let state = null;
let scrubbing = false;
let volumeHeld = false;

// -- pairing ----------------------------------------------------------------
function readPairing() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const s = hash.get('s');
  const t = hash.get('t');
  if (s && t) {
    const next = { session: s, token: t };
    try {
      sessionStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      /* private mode: keep it in memory for this page only */
    }
    // Drop the token from the address bar so it isn't left in plain sight.
    history.replaceState(null, '', location.pathname);
    return next;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE));
    if (saved && saved.session && saved.token) return saved;
  } catch {
    /* fall through */
  }
  return null;
}

// -- socket -----------------------------------------------------------------
function connect() {
  if (!pairing) {
    setStatus('not paired', false);
    toast('Scan the QR code on your main screen to pair', 6000);
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url =
    `${proto}//${location.host}/ws/remote` +
    `?s=${encodeURIComponent(pairing.session)}&t=${encodeURIComponent(pairing.token)}`;
  try {
    ws = new WebSocket(url);
  } catch {
    setTimeout(connect, RECONNECT_MS);
    return;
  }

  ws.addEventListener('open', () => {
    setStatus('connected', true);
    send({ type: 'screens' });
  });
  ws.addEventListener('message', (e) => onMessage(e.data));
  ws.addEventListener('close', (e) => {
    ws = null;
    // 403 on upgrade shows up as an immediate close: the link has expired.
    setStatus(e.code === 4004 ? 'screen gone' : 'reconnecting…', false);
    setTimeout(connect, RECONNECT_MS);
  });
  ws.addEventListener('error', () => {});
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function cmd(name, args = {}) {
  if (!ws || ws.readyState !== 1) return toast('Not connected');
  send({ type: 'cmd', name, args });
}

function onMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.type === 'state') {
    state = msg.state;
    render();
  } else if (msg.type === 'screens') {
    renderScreens(msg.screens || []);
  } else if (msg.type === 'screen') {
    setStatus(msg.online ? 'connected' : 'screen offline', !!msg.online);
  } else if (msg.type === 'ack' && msg.ok === false) {
    toast(msg.error || 'That did not work');
  } else if (msg.type === 'error') {
    toast(msg.error);
  }
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  dot.classList.toggle('ok', !!ok);
}

// -- rendering --------------------------------------------------------------
function focusedPlayer() {
  if (!state || !state.players) return null;
  return state.players.find((p) => p.num === state.focusedNum) || state.players[0] || null;
}

function render() {
  const p = focusedPlayer();
  const kindEl = el('np-kind');
  const titleEl = el('np-title');
  const subEl = el('np-sub');
  const seek = el('seek');

  if (!p) {
    kindEl.textContent = '—';
    titleEl.textContent = 'Nothing playing';
    subEl.textContent = '';
    seek.disabled = true;
    seek.value = 0;
    el('t-pos').textContent = '0:00';
    el('t-dur').textContent = '0:00';
  } else {
    kindEl.textContent = describeKind(p);
    // A live channel's title carries its quality after pipes; show the name big
    // and the qualifiers underneath rather than one long run-on line.
    const live = p.kind === 'live';
    const { base, tags } = splitName(p.title || '');
    titleEl.textContent = (live ? base : p.title) || '(nothing)';
    subEl.textContent = [
      live ? tags.join(' · ') : '',
      p.showName && p.season != null ? `S${pad(p.season)}E${pad(p.episode)}` : '',
      p.channelName ? cleanName(p.channelName) : '',
      p.loading ? 'loading…' : '',
      p.error ? 'error' : '',
    ]
      .filter(Boolean)
      .join(' · ');

    // Live has no timeline; on-demand does.
    seek.disabled = !p.onDemand || !p.duration;
    if (p.onDemand && p.duration && !scrubbing) {
      seek.max = String(p.duration);
      seek.value = String(Math.min(p.position || 0, p.duration));
    }
    el('t-pos').textContent = p.onDemand ? fmt(p.position) : 'LIVE';
    el('t-dur').textContent = p.onDemand && p.duration ? fmt(p.duration) : '';
    el('pp').textContent = p.paused ? '▶︎' : '❙❙';
    el('pp').disabled = !p.onDemand; // live can't be paused
    if (!volumeHeld) {
      el('vol').value = String(Math.round((p.muted ? 0 : p.volume ?? 1) * 100));
      el('vol-val').textContent = p.muted ? 'muted' : `${Math.round((p.volume ?? 1) * 100)}%`;
    }
  }

  // Player focus buttons, one per tile on the screen.
  const focusRow = el('focus-row');
  const wanted = (state?.players || []).map((x) => x.num).join(',');
  if (focusRow.dataset.nums !== wanted) {
    focusRow.dataset.nums = wanted;
    focusRow.innerHTML = (state?.players || [])
      .map(
        (x) =>
          `<button class="btn" data-cmd="focusPlayer" data-number="${x.num}">Screen ${x.num}</button>`
      )
      .join('');
  }
  [...focusRow.children].forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.number) === state?.focusedNum);
  });

  el('layout-btn').textContent = 'Layout: ' + (state?.layoutMode || '—');
  const splitEl = el('split');
  if (document.activeElement !== splitEl && state?.split) {
    splitEl.value = String(Math.round(state.split.x * 100));
  }
  splitEl.disabled = (state?.players || []).length < 2;

  renderPresets(state?.presets || []);
  renderContinue(state?.history || []);
}

function renderPresets(list) {
  const box = el('presets');
  const sig = list.map((p) => p.slot + ':' + p.label).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = list.length
    ? list
        .map(
          (p) =>
            `<button class="btn preset" data-cmd="loadPreset" data-slot="${p.slot}">` +
            `<b>${p.slot}</b> ${escapeHtml(shorten(p.label))}</button>`
        )
        .join('')
    : '<span class="muted">No presets saved yet.</span>';
}

function renderScreens(screens) {
  const sig = screens.map((s) => s.id + ':' + s.label).join('|');
  if (screensEl.dataset.sig === sig) return;
  screensEl.dataset.sig = sig;
  screensEl.innerHTML = screens
    .map(
      (s) =>
        `<option value="${escapeHtml(s.id)}"${s.id === pairing?.session ? ' selected' : ''}>` +
        `${escapeHtml(shorten(s.label, 40))}</option>`
    )
    .join('');
  screensEl.style.display = screens.length > 1 ? '' : 'none';
}

// Switching screens re-pairs: a different screen needs its own token, so we ask
// the server for one rather than reusing this screen's.
screensEl.addEventListener('change', async () => {
  const id = screensEl.value;
  if (!id || id === pairing?.session) return;
  try {
    const resp = await fetch('/api/remote/pair?session=' + encodeURIComponent(id));
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'pairing failed');
    const t = new URLSearchParams(data.url.split('#')[1] || '').get('t');
    pairing = { session: id, token: t };
    try {
      sessionStorage.setItem(STORE, JSON.stringify(pairing));
    } catch {
      /* ignore */
    }
    if (ws) ws.close();
    else connect();
    toast('Switched screen');
  } catch (err) {
    toast('Could not switch: ' + err.message);
  }
});

// -- input ------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cmd]');
  if (!btn || btn.disabled) return;
  const name = btn.dataset.cmd;
  const args = {};
  if (btn.dataset.delta != null) args.delta = Number(btn.dataset.delta);
  if (btn.dataset.number != null) args.number = Number(btn.dataset.number);
  if (btn.dataset.slot != null) args.slot = Number(btn.dataset.slot);
  if (btn.dataset.muted != null) {
    const p = focusedPlayer();
    args.muted = !(p && p.muted); // toggle against reported state
  }
  cmd(name, args);
  if (navigator.vibrate) navigator.vibrate(8);
});

const seekEl = el('seek');
seekEl.addEventListener('input', () => {
  scrubbing = true;
  el('t-pos').textContent = fmt(Number(seekEl.value));
});
seekEl.addEventListener('change', () => {
  scrubbing = false;
  cmd('seek', { position: Number(seekEl.value) });
});

const volEl = el('vol');
volEl.addEventListener('input', () => {
  volumeHeld = true;
  el('vol-val').textContent = `${volEl.value}%`;
});
volEl.addEventListener('change', () => {
  volumeHeld = false;
  cmd('setVolume', { value: Number(volEl.value) / 100 });
});

const splitEl = el('split');
splitEl.addEventListener('change', () => {
  cmd('setSplit', { x: Number(splitEl.value) / 100, y: state?.split?.y ?? 0.5 });
});

// -- continue watching ------------------------------------------------------
// Sent by the screen, because the history lives in its localStorage. Tapping a
// card asks the screen to resume — the phone never plays anything itself.
function renderContinue(list) {
  const card = el('continue-card');
  const box = el('continue');
  if (!list || !list.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const sig = list.map((e) => `${e.type}:${e.id}:${e.position}`).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = list
    .map((e, i) => {
      const left = e.durationSecs ? `${fmt(e.durationSecs - e.position)} left` : fmt(e.position);
      const sub = e.finished ? 'Watched' : left;
      const name =
        e.type === 'episode' && e.showName
          ? `${e.showName} · S${pad(e.season)}E${pad(e.episode)}`
          : e.title;
      return (
        `<button class="rowitem" data-resume="${i}">` +
        thumb(e.showCover || e.poster) +
        `<span class="ri-body"><span class="ri-title">${escapeHtml(name)}</span>` +
        `<span class="ri-sub">${escapeHtml(sub)}</span></span></button>`
      );
    })
    .join('');
  box._items = list;
}

el('continue').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-resume]');
  if (!btn) return;
  const entry = (el('continue')._items || [])[Number(btn.dataset.resume)];
  if (!entry) return;
  resume(entry);
});

function resume(entry) {
  const startAt = entry.finished ? 0 : entry.position || 0;
  if (entry.type === 'episode') {
    cmd('playEpisode', {
      episode: {
        id: entry.id,
        type: 'episode',
        title: entry.title,
        showName: entry.showName,
        season: entry.season,
        episode: entry.episode,
        poster: entry.poster,
        showCover: entry.showCover,
        durationSecs: entry.durationSecs,
      },
      startAt,
    });
  } else {
    cmd('playMovie', {
      film: { id: entry.id, title: entry.title, poster: entry.poster, durationSecs: entry.durationSecs },
      playback: { mode: entry.mode },
      startAt,
    });
  }
  toast('Resuming on your screen');
}

// -- browse -----------------------------------------------------------------
// Every view is a picker: it reads the same REST API the main screen uses, and
// tapping a result sends a play command. No media is fetched here.
const views = { now: el('app'), browse: el('browse') };
const resultsEl = el('results');
const moreEl = el('more');
const qEl = el('q');
const backEl = el('back');

let view = 'now';
let browseState = { kind: null, items: [], offset: 0, total: 0, detail: null };

function setView(next) {
  view = next;
  views.now.hidden = next !== 'now';
  views.browse.hidden = next === 'now';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === next));
  if (next === 'now') return;

  if (browseState.kind !== next) {
    browseState = { kind: next, items: [], offset: 0, total: 0, detail: null };
    qEl.value = '';
    qEl.placeholder =
      next === 'live' ? 'Search channels…' : next === 'films' ? 'Search films…' : next === 'series' ? 'Search series…' : 'Filter channels…';
    qEl.hidden = false;
    backEl.hidden = true;
    load();
  }
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) setView(tab.dataset.view);
});

backEl.addEventListener('click', () => {
  browseState.detail = null;
  backEl.hidden = true;
  qEl.hidden = false;
  load();
});

let searchTimer;
qEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load(), 250);
});

async function load({ append = false } = {}) {
  const kind = browseState.kind;
  const q = qEl.value.trim();
  if (!append) {
    browseState.offset = 0;
    resultsEl.innerHTML = '<div class="hint">Loading…</div>';
    moreEl.innerHTML = '';
  }
  try {
    if (kind === 'live') {
      const list = await api(`/api/channels?q=${encodeURIComponent(q)}&limit=80`);
      browseState.items = list;
      resultsEl.innerHTML = list.length
        ? list
            .map((c, i) => {
              const { base, tags } = splitName(c.name);
              return (
                `<button class="rowitem" data-play="${i}"><span class="ri-body">` +
                `<span class="ri-title">${escapeHtml(base)}</span>` +
                (tags.length ? `<span class="ri-sub">${escapeHtml(tags.join(' · '))}</span>` : '') +
                `</span></button>`
              );
            })
            .join('')
        : '<div class="hint">No channels matched.</div>';
    } else if (kind === 'films' || kind === 'series') {
      const base = kind === 'films' ? '/api/movies' : '/api/series';
      const data = await api(`${base}?q=${encodeURIComponent(q)}&limit=40&offset=${browseState.offset}`);
      browseState.items = append ? browseState.items.concat(data.items) : data.items;
      browseState.total = data.total;
      browseState.offset = browseState.items.length;
      const html = data.items
        .map((m, i) => {
          const idx = append ? browseState.items.length - data.items.length + i : i;
          const art = m.poster || m.cover;
          const sub = [m.year, m.rating != null ? `★ ${m.rating}` : ''].filter(Boolean).join(' · ');
          return (
            `<button class="tile" data-open="${idx}">` +
            (art ? `<img loading="lazy" src="/api/poster?u=${encodeURIComponent(art)}" alt="" />` : '<span class="noart"></span>') +
            `<span class="tl-name">${escapeHtml(m.title || m.name)}</span>` +
            `<span class="tl-sub">${escapeHtml(sub)}</span></button>`
          );
        })
        .join('');
      if (append) {
        resultsEl.querySelector('.grid')?.insertAdjacentHTML('beforeend', html);
      } else {
        resultsEl.innerHTML = `<div class="grid">${html}</div>`;
      }
      moreEl.innerHTML =
        browseState.items.length < browseState.total
          ? `<button class="btn" id="more-btn">Load more (${(
              browseState.total - browseState.items.length
            ).toLocaleString()} left)</button>`
          : '';
    } else if (kind === 'catchup') {
      const list = await api('/api/catchup/channels');
      const filtered = q
        ? list.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
        : list;
      browseState.items = filtered;
      resultsEl.innerHTML = filtered.length
        ? filtered
            .map((c, i) => {
              const { base, tags } = splitName(c.name);
              const sub = [...tags, `${c.days} days`].join(' · ');
              return (
                `<button class="rowitem" data-guide="${i}">` +
                thumb(c.icon) +
                `<span class="ri-body"><span class="ri-title">${escapeHtml(base)}</span>` +
                `<span class="ri-sub">${escapeHtml(sub)}</span></span></button>`
              );
            })
            .join('')
        : '<div class="hint">No channels matched.</div>';
    }
  } catch (err) {
    resultsEl.innerHTML = `<div class="hint bad">${escapeHtml(err.message)}</div>`;
  }
}

moreEl.addEventListener('click', (e) => {
  if (e.target.closest('#more-btn')) load({ append: true });
});

resultsEl.addEventListener('click', async (e) => {
  const play = e.target.closest('[data-play]');
  if (play) {
    const c = browseState.items[Number(play.dataset.play)];
    cmd('playChannel', { id: c.id, name: c.name });
    toast(`${cleanName(c.name)} → your screen`);
    return;
  }

  const open = e.target.closest('[data-open]');
  if (open) {
    const item = browseState.items[Number(open.dataset.open)];
    if (browseState.kind === 'films') return playFilm(item);
    return showSeries(item);
  }

  const guide = e.target.closest('[data-guide]');
  if (guide) return showGuide(browseState.items[Number(guide.dataset.guide)]);

  const ep = e.target.closest('[data-episode]');
  if (ep) {
    const episode = browseState.detail.episodes[Number(ep.dataset.episode)];
    const show = browseState.detail.show;
    cmd('playEpisode', {
      episode: {
        id: episode.id,
        type: 'episode',
        title: episode.title,
        showId: show.id,
        showName: show.name,
        showCover: show.cover,
        season: episode.season,
        episode: episode.episode,
        poster: episode.still || show.cover,
        durationSecs: episode.durationSecs,
      },
    });
    toast('Playing on your screen');
    return;
  }

  const prog = e.target.closest('[data-prog]');
  if (prog) {
    const p = browseState.detail.programmes[Number(prog.dataset.prog)];
    const ch = browseState.detail.channel;
    cmd('playCatchup', {
      programme: {
        channelId: ch.id,
        channelName: ch.name,
        title: p.title,
        start: p.start,
        durationMins: p.durationMins,
        durationSecs: p.stop - p.start,
      },
    });
    toast('Playing on your screen');
    return;
  }

  const season = e.target.closest('[data-season]');
  if (season) {
    browseState.detail.season = Number(season.dataset.season);
    renderSeries();
  }
});

async function playFilm(film) {
  toast('Checking…');
  try {
    const [info, playback] = await Promise.all([
      api(`/api/movies/${film.id}`),
      api(`/api/movies/${film.id}/playback`),
    ]);
    if (playback.mode === 'unsupported') return toast(playback.reason || 'Cannot play this film');
    cmd('playMovie', { film: info, playback, startAt: 0 });
    toast(`${info.title} → your screen`);
  } catch (err) {
    toast('Failed: ' + err.message);
  }
}

async function showSeries(show) {
  resultsEl.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const full = await api(`/api/series/${show.id}`);
    browseState.detail = { show: full, season: full.seasons[0]?.season ?? null, episodes: [] };
    qEl.hidden = true;
    backEl.hidden = false;
    renderSeries();
  } catch (err) {
    resultsEl.innerHTML = `<div class="hint bad">${escapeHtml(err.message)}</div>`;
  }
}

function renderSeries() {
  const { show, season } = browseState.detail;
  const current = show.seasons.find((s) => s.season === season) || show.seasons[0];
  browseState.detail.episodes = current ? current.episodes : [];
  const tabs = show.seasons
    .map(
      (s) =>
        `<button class="chip${s.season === season ? ' active' : ''}" data-season="${s.season}">S${s.season}</button>`
    )
    .join('');
  const eps = (current?.episodes || [])
    .map(
      (e, i) =>
        `<button class="rowitem" data-episode="${i}"><span class="ri-num">${e.episode}</span>` +
        `<span class="ri-body"><span class="ri-title">${escapeHtml(e.title)}</span>` +
        `<span class="ri-sub">${escapeHtml(e.duration || '')}</span></span></button>`
    )
    .join('');
  resultsEl.innerHTML =
    `<div class="detail-head">${escapeHtml(show.name)}</div>` +
    `<div class="chips">${tabs}</div>${eps}`;
  moreEl.innerHTML = '';
}

async function showGuide(channel) {
  resultsEl.innerHTML = '<div class="hint">Loading guide…</div>';
  try {
    const epg = await api(`/api/catchup/${channel.id}/epg`);
    browseState.detail = { channel: epg.channel || channel, programmes: epg.programmes };
    qEl.hidden = true;
    backEl.hidden = false;
    resultsEl.innerHTML =
      `<div class="detail-head">${escapeHtml(cleanName(channel.name))} · last ${epg.days} days</div>` +
      (epg.programmes.length
        ? epg.programmes
            .map(
              (p, i) =>
                `<button class="rowitem" data-prog="${i}">` +
                `<span class="ri-num">${escapeHtml(clock(p.start))}</span>` +
                `<span class="ri-body"><span class="ri-title">${escapeHtml(p.title)}</span>` +
                `<span class="ri-sub">${escapeHtml(day(p.start))} · ${p.durationMins}m</span></span></button>`
            )
            .join('')
        : '<div class="hint">Nothing in this channel’s archive.</div>');
    moreEl.innerHTML = '';
  } catch (err) {
    resultsEl.innerHTML = `<div class="hint bad">${escapeHtml(err.message)}</div>`;
  }
}

async function api(path) {
  const resp = await fetch(path);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function thumb(url) {
  return url
    ? `<img class="ri-art" loading="lazy" src="/api/poster?u=${encodeURIComponent(url)}" alt="" />`
    : '<span class="ri-art"></span>';
}

function clock(unix) {
  return new Date(unix * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function day(unix) {
  const d = new Date(unix * 1000);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// -- helpers ----------------------------------------------------------------
function describeKind(p) {
  if (p.kind === 'catchup') return 'CATCH UP';
  if (p.kind === 'movie') return p.type === 'episode' ? 'EPISODE' : 'FILM';
  return 'LIVE TV';
}

function cleanName(n) {
  return String(n).replace(/\s*\|.*$/, '').trim();
}

// Channel names carry their quality and source after pipes: "BBC One | FHD |".
// That suffix is the only thing telling four otherwise identical "BBC One"
// entries apart, so it's kept as a second line rather than thrown away.
function splitName(name) {
  const parts = String(name || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  return { base: parts[0] || String(name || ''), tags: parts.slice(1) };
}

function pad(n) {
  return String(n ?? 0).padStart(2, '0');
}

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function shorten(s, n = 22) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

let toastTimer;
function toast(message, ms = 2200) {
  const t = el('toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

connect();
render();
