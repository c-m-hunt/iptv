// catchup.js — the catch-up TV guide: pick a channel, pick a programme that
// already aired, watch it.
//
// Only 137 of the ~8,500 live channels keep an archive (5-14 days), so the
// channel list here is the archive-capable subset rather than the full
// catalogue. Programmes come from the channel's EPG, filtered server-side to
// the ones still inside the window.

const DEBOUNCE_MS = 180;

export class Catchup {
  constructor(rootEl, { onPlay }) {
    this.root = rootEl;
    this.onPlay = onPlay;
    this.channels = [];
    this.selected = null;
    this.seq = 0;

    this.root.innerHTML = `
      <div class="cu-head">
        <span class="cu-title">Catch Up</span>
        <input class="cu-search" type="text" placeholder="Filter channels…"
               autocomplete="off" autocapitalize="off" spellcheck="false" />
        <span class="cu-meta"></span>
        <button class="cu-close" title="Close (T / Esc)">×</button>
      </div>
      <div class="cu-body">
        <div class="cu-channels"></div>
        <div class="cu-guide"><div class="cu-empty">Pick a channel to see what you missed.</div></div>
      </div>`;

    this.searchEl = this.root.querySelector('.cu-search');
    this.metaEl = this.root.querySelector('.cu-meta');
    this.listEl = this.root.querySelector('.cu-channels');
    this.guideEl = this.root.querySelector('.cu-guide');

    this.searchEl.addEventListener('input', () => {
      clearTimeout(this._t);
      this._t = setTimeout(() => this._renderChannels(), DEBOUNCE_MS);
    });
    // Global shortcuts stay out of text inputs, so handle Esc here.
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.root.querySelector('.cu-close').addEventListener('click', () => this.close());
    this.listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.cu-channel');
      if (row) this.selectChannel(Number(row.dataset.id));
    });
    this.guideEl.addEventListener('click', (e) => {
      const row = e.target.closest('.cu-prog');
      if (row) this._play(row.dataset.id);
    });
  }

  // -- open/close ---------------------------------------------------------
  isOpen() {
    return this.root.classList.contains('open');
  }

  open() {
    this.root.classList.add('open');
    if (!this.channels.length) this.load();
    requestAnimationFrame(() => this.searchEl.focus());
  }

  close() {
    this.root.classList.remove('open');
    document.getElementById('stage')?.focus();
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }

  // -- channels -----------------------------------------------------------
  async load() {
    this.metaEl.textContent = 'Loading channels…';
    try {
      const resp = await fetch('/api/catchup/channels');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      this.channels = data;
      this._renderChannels();
    } catch (err) {
      this.metaEl.textContent = 'Failed: ' + err.message;
    }
  }

  _visibleChannels() {
    const tokens = this.searchEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return this.channels;
    return this.channels.filter((c) => {
      const hay = c.name.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }

  _renderChannels() {
    const list = this._visibleChannels();
    this.metaEl.textContent = `${list.length} channel${list.length === 1 ? '' : 's'} with catch-up`;
    this.listEl.innerHTML = list
      .map(
        (c) =>
          `<div class="cu-channel${c.id === this.selected ? ' active' : ''}" data-id="${c.id}">` +
          (c.icon
            ? `<img loading="lazy" src="/api/poster?u=${encodeURIComponent(c.icon)}" alt="" />`
            : '<span class="cu-noicon"></span>') +
          `<span class="cu-cname">${esc(cleanName(c.name))}</span>` +
          `<span class="cu-days">${c.days}d</span>` +
          `</div>`
      )
      .join('');
  }

  // -- guide --------------------------------------------------------------
  async selectChannel(id) {
    this.selected = id;
    this._renderChannels();
    this.guideEl.innerHTML = '<div class="cu-empty">Loading guide…</div>';
    const seq = ++this.seq;
    try {
      const resp = await fetch(`/api/catchup/${id}/epg`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      if (seq !== this.seq) return;
      this.epg = data;
      this._renderGuide(data);
    } catch (err) {
      if (seq !== this.seq) return;
      this.guideEl.innerHTML = `<div class="cu-empty bad">Couldn't load the guide: ${esc(
        err.message
      )}</div>`;
    }
  }

  _renderGuide(data) {
    if (!data.programmes.length) {
      this.guideEl.innerHTML = '<div class="cu-empty">Nothing in this channel’s archive.</div>';
      return;
    }
    // Newest first, split by day so a week of listings stays readable.
    const days = new Map();
    for (const p of data.programmes) {
      const key = dayKey(p.start);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(p);
    }

    let html = `<div class="cu-guide-head">${esc(
      cleanName(data.channel ? data.channel.name : '')
    )} · last ${data.days} days · ${data.programmes.length} programmes</div>`;

    for (const [label, progs] of days) {
      html += `<div class="cu-day">${esc(label)}</div>`;
      html += progs
        .map(
          (p) =>
            `<div class="cu-prog" data-id="${p.id}">` +
            `<span class="cu-time">${esc(clockTime(p.start))}</span>` +
            `<span class="cu-ptitle">${esc(p.title || '(no title)')}` +
            (p.description
              ? `<span class="cu-desc">${esc(p.description.slice(0, 160))}</span>`
              : '') +
            `</span>` +
            `<span class="cu-dur">${p.durationMins}m</span>` +
            `</div>`
        )
        .join('');
    }
    this.guideEl.innerHTML = html;
  }

  _play(programmeId) {
    const p = (this.epg?.programmes || []).find((x) => String(x.id) === String(programmeId));
    if (!p) return;
    this.close();
    this.onPlay?.({
      channelId: this.epg.channel.id,
      channelName: this.epg.channel.name,
      title: p.title,
      start: p.start,
      durationMins: p.durationMins,
      durationSecs: p.stop - p.start,
    });
  }
}

// -- helpers ----------------------------------------------------------------
function cleanName(n) {
  // Channel names carry quality suffixes: "BBC One | HD | " -> "BBC One".
  return String(n).replace(/\s*\|.*$/, '').trim() || String(n);
}

function dayKey(unix) {
  const d = new Date(unix * 1000);
  const today = new Date();
  const isSame = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = new Date(today.getTime() - 86400000);
  if (isSame(d, today)) return 'Today';
  if (isSame(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

function clockTime(unix) {
  return new Date(unix * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
