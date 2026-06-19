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
    this._renderStandings();
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

  _renderScores() {
    if (this.scoresEl.classList.contains('hidden')) return;
    if (!this.data) {
      this.scoresEl.innerHTML = titled('Live Scores', '<div class="panel-empty">Loading…</div>');
      return;
    }
    const matches = this.data.matches || [];
    const live = matches.filter((m) => m.state === 'in');
    if (live.length) {
      this.scoresEl.innerHTML = titled('Live Scores', renderMatchList(live));
      return;
    }
    // Nothing live — show the next few upcoming fixtures so the panel stays useful.
    const upcoming = matches
      .filter((m) => m.state === 'pre')
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(0, 5);
    const body = upcoming.length
      ? renderMatchList(upcoming)
      : '<div class="panel-empty">No matches scheduled</div>';
    this.scoresEl.innerHTML = titled(upcoming.length ? 'Up Next' : 'Live Scores', body);
  }

  _renderStandings() {
    if (this.standingsEl.classList.contains('hidden')) return;
    if (!this.data) {
      this.standingsEl.innerHTML = bodyOnly('<div class="panel-empty">Loading…</div>');
      return;
    }
    const list = this._rotationGroups();
    if (!list.length) {
      this.standingsEl.innerHTML = bodyOnly('<div class="panel-empty">No standings yet</div>');
      return;
    }
    if (this.groupIdx >= list.length) this.groupIdx = 0;
    const g = list[this.groupIdx];
    const liveMatches = (this.data.matches || []).filter(
      (m) => m.state === 'in' && m.group === g.name
    );
    this.standingsEl.innerHTML = bodyOnly(
      renderGroup(g, this.groupIdx, list.length, liveMatches)
    );
  }

  _renderError(msg) {
    const e = `<div class="panel-error">Couldn't load: ${esc(msg)}</div>`;
    if (!this.scoresEl.classList.contains('hidden')) this.scoresEl.innerHTML = titled('Live Scores', e);
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

// -- live scores / upcoming fixtures ------------------------------------
function renderMatchList(matches) {
  return '<div class="scores">' + matches.map(renderMatch).join('') + '</div>';
}

function renderMatch(m) {
  const live = m.state === 'in';
  const info = live ? m.clock || 'LIVE' : timeLabel(m.date);
  const head =
    `<div class="sgroup">${m.group ? esc(m.group) + ' · ' : ''}` +
    `<span class="${live ? 'sclock' : 'stime'}">${esc(info)}</span></div>`;
  return `<div class="smatch${live ? '' : ' pre'}">${head}${scoreRow(m.home, live)}${scoreRow(m.away, live)}</div>`;
}

function scoreRow(t, live) {
  const score = live ? `<span class="sscore">${esc(t.score ?? '')}</span>` : '';
  return (
    `<div class="srow">${flag(t.logo)}` +
    `<span class="sabbr">${esc(t.abbr || t.name)}</span>${score}</div>`
  );
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// -- group standings ----------------------------------------------------
function renderGroup(g, idx, total, liveMatches = []) {
  const liveBadge = g.live ? '<span class="live-badge">● LIVE</span>' : '';
  const liveScores = liveMatches.length
    ? '<div class="glives">' + liveMatches.map(liveLine).join('') + '</div>'
    : '';
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
    liveScores +
    `<table class="gtable"><thead><tr>` +
    `<th></th><th></th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `</div>`
  );
}

// Current live score line shown inside a live group's panel.
function liveLine(m) {
  return (
    `<div class="glive">` +
    `${flag(m.home.logo)}<span class="gl-ab">${esc(m.home.abbr || m.home.name)}</span>` +
    `<span class="gl-sc">${esc(m.home.score ?? '')}–${esc(m.away.score ?? '')}</span>` +
    `<span class="gl-ab">${esc(m.away.abbr || m.away.name)}</span>${flag(m.away.logo)}` +
    `<span class="gl-ck">${esc(m.clock || 'LIVE')}</span>` +
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
