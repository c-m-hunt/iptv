// live.js — World Cup scores + standings panels for the diagonal corners.
//
// Built for a passive display (no scrolling): the standings panel shows one
// group at a time and auto-rotates, prioritising groups that have a live game.

const POLL_MS = 60000; // refresh data once a minute
const ROTATE_MS = 8000; // rotate the displayed group

export class LivePanels {
  constructor(scoresEl, standingsEl) {
    this.scoresEl = scoresEl;
    this.standingsEl = standingsEl;
    this.visible = false;
    this.corners = { scores: null, standings: null };
    this.data = null;
    this.pollTimer = null;
    this.rotateTimer = null;
    this.groupIdx = 0;
    this.inFlight = false;
  }

  setVisible(on) {
    this.visible = on;
    this._sync();
  }

  isVisible() {
    return this.visible;
  }

  setCorners(corners) {
    this.corners = corners || { scores: null, standings: null };
    this._sync();
  }

  _sync() {
    const showScores = this.visible && !!this.corners.scores;
    const showStandings = this.visible && !!this.corners.standings;
    this._place(this.scoresEl, showScores ? this.corners.scores : null);
    this._place(this.standingsEl, showStandings ? this.corners.standings : null);

    if (showScores || showStandings) {
      this._renderAll();
      this._startPolling();
      this._startRotation();
    } else {
      this._stopPolling();
      this._stopRotation();
    }
  }

  _place(el, rect) {
    if (!rect) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const pad = 1.2;
    el.style.left = rect.x + pad + '%';
    el.style.top = rect.y + pad + '%';
    el.style.width = Math.max(0, rect.w - pad * 2) + '%';
    el.style.height = Math.max(0, rect.h - pad * 2) + '%';
  }

  _startPolling() {
    if (this.pollTimer) return;
    this._fetch();
    this.pollTimer = setInterval(() => this._fetch(), POLL_MS);
  }
  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _startRotation() {
    if (this.rotateTimer) return;
    this.rotateTimer = setInterval(() => this._rotate(), ROTATE_MS);
  }
  _stopRotation() {
    if (this.rotateTimer) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = null;
    }
  }

  // Groups to rotate through: live groups if any are in play, else all of them.
  _rotationGroups() {
    const groups = (this.data && this.data.groups) || [];
    const live = groups.filter((g) => g.live);
    return live.length ? live : groups;
  }

  _rotate() {
    const list = this._rotationGroups();
    if (list.length <= 1) return;
    this.groupIdx = (this.groupIdx + 1) % list.length;
    this._renderAll(); // both panels follow the same group
  }

  // The group currently on display (shared by both panels).
  _currentGroup() {
    const list = this._rotationGroups();
    if (!list.length) return { group: null, idx: 0, total: 0 };
    if (this.groupIdx >= list.length) this.groupIdx = 0;
    return { group: list[this.groupIdx], idx: this.groupIdx, total: list.length };
  }

  async _fetch() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const resp = await fetch('/api/worldcup');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      this.data = await resp.json();
      this._renderAll();
    } catch (err) {
      this._renderError(err.message);
    } finally {
      this.inFlight = false;
    }
  }

  _renderAll() {
    this._renderScores();
    this._renderStandings();
  }

  // Scores panel: every fixture/result for the current group, live highlighted.
  _renderScores() {
    if (this.scoresEl.classList.contains('hidden')) return;
    if (!this.data) {
      this.scoresEl.innerHTML = titled('Fixtures', '<div class="panel-empty">Loading…</div>');
      return;
    }
    const { group } = this._currentGroup();
    if (!group) {
      this.scoresEl.innerHTML = titled('Fixtures', '<div class="panel-empty">No fixtures</div>');
      return;
    }
    const matches = (this.data.matches || [])
      .filter((m) => m.group === group.name)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const body = matches.length
      ? '<div class="fixtures">' + matches.map(renderMatchRow).join('') + '</div>'
      : '<div class="panel-empty">No fixtures</div>';
    this.scoresEl.innerHTML = titled(group.name, body);
  }

  _renderStandings() {
    if (this.standingsEl.classList.contains('hidden')) return;
    if (!this.data) {
      this.standingsEl.innerHTML = bodyOnly('<div class="panel-empty">Loading…</div>');
      return;
    }
    const { group, idx, total } = this._currentGroup();
    if (!group) {
      this.standingsEl.innerHTML = bodyOnly('<div class="panel-empty">No standings yet</div>');
      return;
    }
    this.standingsEl.innerHTML = bodyOnly(renderGroup(group, idx, total));
  }

  _renderError(msg) {
    const e = `<div class="panel-error">Couldn't load: ${esc(msg)}</div>`;
    if (!this.scoresEl.classList.contains('hidden')) this.scoresEl.innerHTML = titled('Fixtures', e);
    if (!this.standingsEl.classList.contains('hidden')) this.standingsEl.innerHTML = bodyOnly(e);
  }
}

function titled(title, body) {
  return `<div class="panel-title">${esc(title)}</div><div class="panel-body">${body}</div>`;
}

function bodyOnly(body) {
  return `<div class="panel-body">${body}</div>`;
}

function flag(url) {
  return url ? `<img class="flag" src="${esc(url)}" alt="" loading="lazy">` : '<span class="flag"></span>';
}

// -- a single fixture row (finished / live / upcoming) ------------------
function renderMatchRow(m) {
  const live = m.state === 'in';
  const done = m.state === 'post';
  const cls = live ? 'live' : done ? 'done' : 'pre';
  const mid =
    live || done
      ? `<span class="m-sc">${score(m.home.score)}<i>–</i>${score(m.away.score)}</span>`
      : `<span class="m-time">${esc(timeLabel(m.date))}</span>`;
  const tag = live
    ? `<span class="m-tag live">${esc(m.clock || 'LIVE')}</span>`
    : done
      ? '<span class="m-tag">FT</span>'
      : '';
  return (
    `<div class="mrow ${cls}">` +
    `<span class="m-home">${esc(m.home.abbr || m.home.name)}${flag(m.home.logo)}</span>` +
    `<span class="m-mid">${mid}${tag}</span>` +
    `<span class="m-away">${flag(m.away.logo)}${esc(m.away.abbr || m.away.name)}</span>` +
    `</div>`
  );
}

function score(v) {
  return v === '' || v == null ? '' : esc(String(v));
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// -- group standings ----------------------------------------------------
function renderGroup(g, idx, total) {
  const liveBadge = g.live ? '<span class="live-badge">● LIVE</span>' : '';
  const rows = (g.teams || [])
    .map((t, i) => {
      const cls = (i < 2 ? 'adv' : 'out') + (t.live ? ' tlive' : '');
      return (
        `<tr class="${cls}">` +
        `<td class="pos">${i + 1}</td>` +
        `<td class="tm">${flag(t.logo)}<span>${esc(t.abbr || t.name)}</span></td>` +
        `<td>${cell(t.p)}</td><td>${cell(t.w)}</td><td>${cell(t.d)}</td><td>${cell(t.l)}</td>` +
        `<td>${cell(t.gd)}</td><td class="ptsc"><b>${cell(t.pts)}</b></td>` +
        `</tr>`
      );
    })
    .join('');
  return (
    `<div class="gpanel">` +
    `<div class="gtitle">${esc(g.name)}${liveBadge}<span class="gcount">${idx + 1}/${total}</span></div>` +
    `<table class="gtable"><thead><tr>` +
    `<th></th><th></th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `</div>`
  );
}

function cell(v) {
  return v === '' || v == null ? '–' : esc(String(v));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
