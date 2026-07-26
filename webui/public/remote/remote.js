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
    titleEl.textContent = p.title || '(nothing)';
    subEl.textContent = [
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

// -- helpers ----------------------------------------------------------------
function describeKind(p) {
  if (p.kind === 'catchup') return 'CATCH UP';
  if (p.kind === 'movie') return p.type === 'episode' ? 'EPISODE' : 'FILM';
  return 'LIVE TV';
}

function cleanName(n) {
  return String(n).replace(/\s*\|.*$/, '').trim();
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
