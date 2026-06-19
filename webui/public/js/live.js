// live.js — World Cup scores + standings panels for the diagonal black corners.
//
// Data comes from /api/worldcup (server-proxied ESPN). Panels are only shown
// when (a) the user has toggled live data on (L) AND (b) the current layout has
// free corners (i.e. a diagonal layout). Polling runs only while visible.

const POLL_MS = 60000; // refresh once a minute — live enough, not noisy

export class LivePanels {
  constructor(scoresEl, standingsEl) {
    this.scoresEl = scoresEl;
    this.standingsEl = standingsEl;
    this.visible = false;
    this.corners = { scores: null, standings: null };
    this.data = null;
    this.timer = null;
    this.inFlight = false;
  }

  // Toggle from the L key.
  setVisible(on) {
    this.visible = on;
    this._sync();
  }

  isVisible() {
    return this.visible;
  }

  // Called whenever the layout changes; corners are rects (percent) or null.
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
      this._renderInto();
      this._startPolling();
    } else {
      this._stopPolling();
    }
  }

  _place(el, rect) {
    if (!rect) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    // Inset slightly so the panel doesn't touch the video edges.
    const pad = 1.2;
    el.style.left = rect.x + pad + '%';
    el.style.top = rect.y + pad + '%';
    el.style.width = Math.max(0, rect.w - pad * 2) + '%';
    el.style.height = Math.max(0, rect.h - pad * 2) + '%';
  }

  _startPolling() {
    if (this.timer) return;
    this._fetch();
    this.timer = setInterval(() => this._fetch(), POLL_MS);
  }

  _stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _fetch() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const resp = await fetch('/api/worldcup');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      this.data = await resp.json();
      this._renderInto();
    } catch (err) {
      this._renderError(err.message);
    } finally {
      this.inFlight = false;
    }
  }

  _renderInto() {
    if (!this.data) {
      this.scoresEl.innerHTML = panelShell('Live Scores', '<div class="panel-error">Loading…</div>');
      this.standingsEl.innerHTML = panelShell('Group Standings', '<div class="panel-error">Loading…</div>');
      return;
    }
    this.scoresEl.innerHTML = panelShell('Live Scores', renderScores(this.data.matches || []));
    this.standingsEl.innerHTML = panelShell('Group Standings', renderStandings(this.data.groups || []));
  }

  _renderError(msg) {
    const body = `<div class="panel-error">Couldn't load World Cup data: ${escapeHtml(msg)}</div>`;
    if (!this.scoresEl.classList.contains('hidden')) this.scoresEl.innerHTML = panelShell('Live Scores', body);
    if (!this.standingsEl.classList.contains('hidden'))
      this.standingsEl.innerHTML = panelShell('Group Standings', body);
  }
}

function panelShell(title, bodyHtml) {
  return `<div class="panel-title">${title}</div><div class="panel-body">${bodyHtml}</div>`;
}

// Only currently in-progress matches.
function renderScores(matches) {
  const live = (matches || []).filter((m) => m.state === 'in');
  if (!live.length) return '<div class="panel-error">No live matches right now.</div>';
  const sorted = [...live].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return sorted.map(renderMatch).join('');
}

function renderMatch(m) {
  const live = m.state === 'in';
  const stateClass = live ? 'live' : m.state === 'pre' ? 'pre' : 'post';
  const stateText = live ? m.clock || 'LIVE' : m.state === 'pre' ? timeLabel(m.date) : m.detail || 'FT';
  const grp = m.group ? `<div class="grp">${escapeHtml(m.group)}</div>` : '';
  return (
    `<div class="match">` +
    `<div class="teams">` +
    teamRow(m.home) +
    teamRow(m.away) +
    `</div>` +
    `<div class="state ${stateClass}">${escapeHtml(stateText)}</div>` +
    grp +
    `</div>`
  );
}

function teamRow(t) {
  const name = t.abbr || t.name || '?';
  return (
    `<div class="team">` +
    `<span class="nm">${escapeHtml(name)}</span>` +
    `<span class="sc">${escapeHtml(t.score ?? '')}</span>` +
    `</div>`
  );
}

function renderStandings(groups) {
  if (!groups.length) return '<div class="panel-error">No standings yet.</div>';
  return groups.map(renderGroup).join('');
}

function renderGroup(g) {
  const rows = (g.teams || [])
    .map(
      (t) =>
        `<tr>` +
        `<td class="name">${escapeHtml(t.abbr || t.name)}</td>` +
        `<td>${cell(t.p)}</td><td>${cell(t.w)}</td><td>${cell(t.d)}</td>` +
        `<td>${cell(t.l)}</td><td>${cell(t.gd)}</td><td><b>${cell(t.pts)}</b></td>` +
        `</tr>`
    )
    .join('');
  return (
    `<div class="group">` +
    `<h4>${escapeHtml(g.name)}</h4>` +
    `<table class="table"><thead><tr>` +
    `<th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `</div>`
  );
}

function cell(v) {
  return v === '' || v == null ? '–' : escapeHtml(String(v));
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
