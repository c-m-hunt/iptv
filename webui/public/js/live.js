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
      this.scoresEl.innerHTML = wrap('<div class="panel-empty">Loading…</div>');
      return;
    }
    const { group } = this._currentGroup();
    if (!group) {
      this.scoresEl.innerHTML = wrap('<div class="panel-empty">No fixtures</div>');
      return;
    }
    const matches = (this.data.matches || [])
      .filter((m) => m.group === group.name)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    this.scoresEl.innerHTML = renderFixtures(group, matches);
  }

  _renderStandings() {
    if (this.standingsEl.classList.contains('hidden')) return;
    if (!this.data) {
      this.standingsEl.innerHTML = wrap('<div class="panel-empty">Loading…</div>');
      return;
    }
    const { group, idx, total } = this._currentGroup();
    if (!group) {
      this.standingsEl.innerHTML = wrap('<div class="panel-empty">No standings yet</div>');
      return;
    }
    this.standingsEl.innerHTML = renderGroup(group, idx, total);
  }

  _renderError(msg) {
    const e = `<div class="panel-error">Couldn't load: ${esc(msg)}</div>`;
    if (!this.scoresEl.classList.contains('hidden')) this.scoresEl.innerHTML = wrap(e);
    if (!this.standingsEl.classList.contains('hidden')) this.standingsEl.innerHTML = wrap(e);
  }
}

// -- broadcast card chrome (ported from the StandingsTable / FixtureCard design)
function accent() {
  return '<div class="bc-accent"><span class="bc-sheen"></span></div>';
}
function wrap(inner) {
  return accent() + inner;
}
function bcHead(name, pill) {
  return (
    '<div class="bc-head">' +
    `<div class="bc-title"><span class="bc-bar"></span><span class="bc-name">${esc(name)}</span></div>` +
    (pill
      ? `<div class="bc-pill"><span class="bc-pill-l">Matchday</span><span class="bc-pill-v">${esc(pill)}</span></div>`
      : '') +
    '</div>'
  );
}

function flag(url) {
  return url ? `<img class="flag" src="${esc(url)}" alt="" loading="lazy">` : '<span class="flag"></span>';
}

// -- fixtures: all of the group's matches, split into Live / Fixtures / Results
function renderFixtures(group, matches) {
  if (!matches.length) {
    return accent() + bcHead(group.name) + '<div class="panel-empty">No fixtures</div>';
  }
  const byDate = (a, b) => String(a.date).localeCompare(String(b.date));
  const live = matches.filter((m) => m.state === 'in').sort(byDate);
  const fixtures = matches.filter((m) => m.state === 'pre').sort(byDate);
  const results = matches.filter((m) => m.state === 'post').sort(byDate);

  let body = '';
  if (live.length) body += fxSection('Live', 'live', live);
  if (fixtures.length) body += fxSection('Fixtures', 'pre', fixtures);
  if (results.length) body += fxSection('Results', 'post', results);
  return accent() + bcHead(group.name) + `<div class="fix-wrap">${body}</div>`;
}

function fxSection(label, cls, matches) {
  return (
    `<div class="fx-sec ${cls}">` +
    `<div class="fx-sec-h">${esc(label)}</div>` +
    matches.map(renderMatchRow).join('') +
    '</div>'
  );
}

function renderMatchRow(m) {
  const live = m.state === 'in';
  const done = m.state === 'post';
  const cls = live ? 'live' : done ? 'done' : 'pre';
  const mid =
    live || done
      ? `<span class="fx-sc">${score(m.home.score)}<i>–</i>${score(m.away.score)}</span>`
      : '<span class="fx-v">v</span>';
  const tag = live
    ? `<span class="fx-tag live"><span class="fx-dot"></span>${esc(m.clock || 'LIVE')}</span>`
    : done
      ? '<span class="fx-tag">FT</span>'
      : `<span class="fx-tag">${esc(whenLabel(m.date))}</span>`;
  return (
    `<div class="fxrow ${cls}">` +
    `<span class="fx-home">${flag(m.home.logo)}<span class="fx-code">${esc(m.home.abbr || m.home.name)}</span></span>` +
    `<span class="fx-mid">${mid}</span>` +
    `<span class="fx-away"><span class="fx-code">${esc(m.away.abbr || m.away.name)}</span>${flag(m.away.logo)}</span>` +
    `<span class="fx-end">${tag}</span>` +
    `</div>`
  );
}

function score(v) {
  return v === '' || v == null ? '' : esc(String(v));
}

// Upcoming matches can be on any day, so show weekday + time.
function whenLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const day = d.toLocaleDateString([], { weekday: 'short' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

// -- group standings (StandingsTable design) ----------------------------
function gdClass(gd) {
  const n = parseInt(String(gd).replace('+', ''), 10);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}

function renderGroup(g, idx, total) {
  const head = bcHead(g.name, `${idx + 1}/${total}`);
  const header =
    '<div class="strow sthead">' +
    '<div></div><div class="st-team">Team</div>' +
    '<div class="st-n">P</div><div class="st-n">W</div><div class="st-n">D</div>' +
    '<div class="st-n">L</div><div class="st-n">GD</div><div class="st-pts">PTS</div>' +
    '</div>';
  const rows = (g.teams || [])
    .map((t, i) => {
      const qual = i < 2 ? ' qual' : '';
      const liveCls = t.live ? ' live' : '';
      return (
        `<div class="strow${qual}${liveCls}">` +
        `<div class="st-pos">${i + 1}</div>` +
        `<div class="st-team">${flag(t.logo)}<span class="st-code">${esc(t.abbr || t.name)}</span>` +
        `<span class="st-name">${esc(t.name)}</span></div>` +
        `<div class="st-n">${cell(t.p)}</div><div class="st-n">${cell(t.w)}</div>` +
        `<div class="st-n">${cell(t.d)}</div><div class="st-n">${cell(t.l)}</div>` +
        `<div class="st-n st-gd ${gdClass(t.gd)}">${cell(t.gd)}</div>` +
        `<div class="st-pts">${cell(t.pts)}</div>` +
        `</div>`
      );
    })
    .join('');
  return accent() + head + '<div class="stable">' + header + rows + '</div>';
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
