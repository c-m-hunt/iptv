// series.js — the TV series browser: search, categories, and a detail view
// with seasons and episodes.
//
// Shares the film browser's card styling and the same /api/poster proxy.
// Episodes are VOD files, so playing one goes through the same direct/remux
// route a film does — the detail view just has to pick the right episode.

const DEBOUNCE_MS = 200;
const PAGE = 60;

const SORTS = [
  ['added', 'Recently updated'],
  ['rating', 'Highest rated'],
  ['year', 'Newest first'],
  ['title', 'A–Z'],
];

export class Series {
  constructor(rootEl, { onPlayEpisode, history }) {
    this.root = rootEl;
    this.onPlayEpisode = onPlayEpisode;
    this.history = history;
    this.items = [];
    this.total = 0;
    this.offset = 0;
    this.seq = 0;
    this.detail = null;
    this.season = null;

    this.root.innerHTML = `
      <div class="films-head">
        <span class="films-title">Series</span>
        <input class="films-search" type="text" placeholder="Search series…"
               autocomplete="off" autocapitalize="off" spellcheck="false" />
        <select class="films-cat"><option value="">All categories</option></select>
        <select class="films-sort">${SORTS.map(
          ([v, l]) => `<option value="${v}">${l}</option>`
        ).join('')}</select>
        <span class="films-count"></span>
        <button class="films-close" title="Close (V / Esc)">×</button>
      </div>
      <div class="films-continue"></div>
      <div class="films-grid"></div>
      <div class="films-more"></div>
      <div class="films-detail"></div>`;

    this.searchEl = this.root.querySelector('.films-search');
    this.catEl = this.root.querySelector('.films-cat');
    this.sortEl = this.root.querySelector('.films-sort');
    this.countEl = this.root.querySelector('.films-count');
    this.gridEl = this.root.querySelector('.films-grid');
    this.continueEl = this.root.querySelector('.films-continue');
    this.moreEl = this.root.querySelector('.films-more');
    this.detailEl = this.root.querySelector('.films-detail');

    this.searchEl.addEventListener('input', () => {
      clearTimeout(this._t);
      this._t = setTimeout(() => this.load({ reset: true }), DEBOUNCE_MS);
    });
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.catEl.addEventListener('change', () => this.load({ reset: true }));
    this.sortEl.addEventListener('change', () => this.load({ reset: true }));
    this.root.querySelector('.films-close').addEventListener('click', () => this.close());
    this.gridEl.addEventListener('click', (e) => {
      const card = e.target.closest('.film-card');
      if (card) this.openDetail(Number(card.dataset.id));
    });
    this.moreEl.addEventListener('click', (e) => {
      if (e.target.closest('.films-more-btn')) this.load({ reset: false });
    });
    this.detailEl.addEventListener('click', (e) => this._onDetailClick(e));
    this.continueEl.addEventListener('click', (e) => this._onContinueClick(e));
  }

  // -- continue watching (one card per show) -------------------------------
  renderContinue() {
    const filtering = !!this.searchEl.value.trim() || !!this.catEl.value;
    const shows = this.history ? this.history.listShows() : [];
    if (filtering || !shows.length) {
      this.continueEl.innerHTML = '';
      this.continueEl.classList.remove('open');
      return;
    }
    this.continueEl.classList.add('open');
    this.continueEl.innerHTML =
      '<div class="cw-title">Continue watching</div><div class="cw-row">' +
      shows.map(showCard).join('') +
      '</div>';
  }

  _onContinueClick(e) {
    const del = e.target.closest('[data-delshow]');
    if (del) {
      e.stopPropagation();
      this.history.removeShow(Number(del.dataset.delshow));
      this.renderContinue();
      return;
    }
    const card = e.target.closest('.cw-card');
    if (!card) return;
    const entry = this.history.list().find(
      (x) => String(x.id) === card.dataset.id && (x.type || 'movie') === 'episode'
    );
    if (!entry) return;
    this.root.classList.remove('open');
    this.onPlayEpisode?.(
      {
        id: entry.id,
        type: 'episode',
        title: entry.title,
        showId: entry.showId,
        showName: entry.showName,
        showCover: entry.showCover,
        season: entry.season,
        episode: entry.episode,
        poster: entry.poster,
        durationSecs: entry.durationSecs,
      },
      { startAt: entry.finished ? 0 : entry.position || 0 }
    );
  }

  // -- open/close ---------------------------------------------------------
  isOpen() {
    return this.root.classList.contains('open');
  }

  open() {
    this.root.classList.add('open');
    if (!this._catsLoaded) this._loadCategories();
    if (!this.items.length) this.load({ reset: true });
    this.renderContinue();
    requestAnimationFrame(() => this.searchEl.focus());
  }

  close() {
    if (this.detail) {
      this.closeDetail();
      return;
    }
    this.root.classList.remove('open');
    document.getElementById('stage')?.focus();
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }

  // -- data ---------------------------------------------------------------
  async _loadCategories() {
    this._catsLoaded = true;
    try {
      const cats = await fetch('/api/series/categories').then((r) => r.json());
      if (!Array.isArray(cats)) return;
      this.catEl.innerHTML =
        '<option value="">All categories</option>' +
        cats
          .map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${c.count})</option>`)
          .join('');
    } catch {
      /* categories are a convenience; search still works */
    }
  }

  async load({ reset = true } = {}) {
    if (reset) {
      this.offset = 0;
      this.items = [];
      this.gridEl.innerHTML = '';
      this.renderContinue(); // hides itself once a filter is active
    }
    const seq = ++this.seq;
    this.countEl.textContent = 'Loading…';

    const params = new URLSearchParams({
      q: this.searchEl.value.trim(),
      category: this.catEl.value,
      sort: this.sortEl.value,
      limit: String(PAGE),
      offset: String(this.offset),
    });

    try {
      const resp = await fetch('/api/series?' + params);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      if (seq !== this.seq) return;

      this.total = data.total;
      this.items = this.items.concat(data.items);
      this.offset = this.items.length;
      const html = data.items.map(cardHtml).join('');
      if (reset) this.gridEl.innerHTML = html || '<div class="films-empty">No series matched.</div>';
      else this.gridEl.insertAdjacentHTML('beforeend', html);

      this.countEl.textContent = `${data.total.toLocaleString()} series`;
      this.moreEl.innerHTML =
        this.items.length < this.total
          ? `<button class="films-more-btn">Load more (${(
              this.total - this.items.length
            ).toLocaleString()} left)</button>`
          : '';
    } catch (err) {
      if (seq !== this.seq) return;
      this.countEl.textContent = 'Search failed: ' + err.message;
    }
  }

  // -- detail -------------------------------------------------------------
  async openDetail(id) {
    this.detail = { id };
    this.detailEl.classList.add('open');
    this.detailEl.innerHTML = '<div class="fd-loading">Loading…</div>';
    try {
      const show = await fetch(`/api/series/${id}`).then((r) => r.json());
      if (show.error) throw new Error(show.error);
      if (!this.detail || this.detail.id !== id) return;
      this.detail = { id, show };
      this.season = show.seasons.length ? show.seasons[0].season : null;
      this._renderDetail();
    } catch (err) {
      this.detailEl.innerHTML = `<div class="fd-loading bad">Couldn't load: ${esc(
        err.message
      )}</div>`;
    }
  }

  closeDetail() {
    this.detail = null;
    this.detailEl.classList.remove('open');
    this.detailEl.innerHTML = '';
  }

  _renderDetail() {
    const s = this.detail.show;
    const meta = [
      s.year,
      `${s.seasons.length} season${s.seasons.length === 1 ? '' : 's'}`,
      `${s.episodeCount} episodes`,
      s.genre,
      s.rating != null ? `★ ${s.rating}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const season = s.seasons.find((x) => x.season === this.season) || s.seasons[0];
    const tabs = s.seasons
      .map(
        (x) =>
          `<button class="sv-season${x.season === this.season ? ' active' : ''}" ` +
          `data-season="${x.season}">S${x.season}</button>`
      )
      .join('');

    const episodes = (season ? season.episodes : [])
      .map((ep) => {
        const resumeAt = this.history ? this.history.resumeAt(ep.id, 'episode') : 0;
        const pct =
          resumeAt && ep.durationSecs ? Math.min(100, (resumeAt / ep.durationSecs) * 100) : 0;
        return (
          `<div class="sv-ep" data-ep="${ep.id}">` +
          `<span class="sv-epnum">${ep.episode}</span>` +
          `<span class="sv-epbody">` +
          `<span class="sv-eptitle">${esc(stripPrefix(ep.title, s.name))}</span>` +
          (ep.plot ? `<span class="sv-epplot">${esc(ep.plot.slice(0, 150))}</span>` : '') +
          (pct ? `<span class="sv-epbar"><span style="width:${pct.toFixed(0)}%"></span></span>` : '') +
          `</span>` +
          `<span class="sv-epdur">${esc(ep.duration || '')}${
            resumeAt ? ` · resume ${fmtTime(resumeAt)}` : ''
          }</span>` +
          `</div>`
        );
      })
      .join('');

    this.detailEl.innerHTML = `
      <div class="fd-card">
        ${
          s.backdrop
            ? `<div class="fd-backdrop" style="background-image:url('${esc(
                posterUrl(s.backdrop)
              )}')"></div>`
            : ''
        }
        <button class="fd-close" title="Back (Esc)">×</button>
        <div class="fd-body">
          <img class="fd-poster" src="${esc(posterUrl(s.cover))}" alt="" />
          <div class="fd-info">
            <h2>${esc(s.name)}</h2>
            <div class="fd-meta">${esc(meta)}</div>
            <p class="fd-plot">${esc(s.plot || 'No description available.')}</p>
            ${s.cast ? `<div class="fd-row"><b>Cast</b> ${esc(s.cast)}</div>` : ''}
            ${
              s.trailer
                ? `<div class="fd-actions"><a class="fd-trailer" target="_blank" rel="noopener"
                     href="https://www.youtube.com/watch?v=${esc(s.trailer)}">Trailer ↗</a></div>`
                : ''
            }
          </div>
        </div>
        <div class="sv-seasons">${tabs}</div>
        <div class="sv-eps">${episodes || '<div class="films-empty">No episodes listed.</div>'}</div>
      </div>`;
  }

  _onDetailClick(e) {
    if (e.target.closest('.fd-close') || e.target === this.detailEl) {
      this.closeDetail();
      return;
    }
    const tab = e.target.closest('.sv-season');
    if (tab) {
      this.season = Number(tab.dataset.season);
      this._renderDetail();
      return;
    }
    const row = e.target.closest('.sv-ep');
    if (row && this.detail?.show) {
      const id = Number(row.dataset.ep);
      const show = this.detail.show;
      const season = show.seasons.find((x) => x.season === this.season) || show.seasons[0];
      const ep = season.episodes.find((x) => x.id === id);
      if (!ep) return;
      this.closeDetail();
      this.root.classList.remove('open');
      this.onPlayEpisode?.({
        id: ep.id,
        type: 'episode',
        title: stripPrefix(ep.title, show.name),
        showId: show.id,
        showName: show.name,
        season: ep.season,
        episode: ep.episode,
        poster: ep.still || show.cover,
        showCover: show.cover,
        durationSecs: ep.durationSecs,
      });
    }
  }
}

// -- helpers ----------------------------------------------------------------
function posterUrl(u) {
  return u ? '/api/poster?u=' + encodeURIComponent(u) : '';
}

// Episode titles repeat the show name: "Britannia - S01E01 - Episode 1".
function stripPrefix(title, showName) {
  let t = String(title || '');
  if (showName && t.toLowerCase().startsWith(showName.toLowerCase())) {
    t = t.slice(showName.length).replace(/^\s*[-–—]\s*/, '');
  }
  return t.replace(/^S\d+E\d+\s*[-–—]\s*/i, '').trim() || String(title || '');
}

function showCard(e) {
  const dur = e.durationSecs || 0;
  const pct = dur ? Math.min(100, Math.round((e.position / dur) * 100)) : 0;
  const code = `S${String(e.season ?? 0).padStart(2, '0')}E${String(e.episode ?? 0).padStart(
    2,
    '0'
  )}`;
  const sub = e.finished
    ? `${code} · watched`
    : dur
      ? `${code} · ${fmtTime(dur - e.position)} left`
      : `${code} · from ${fmtTime(e.position)}`;
  const art = e.showCover || e.poster;
  return (
    `<div class="cw-card" data-id="${e.id}" title="${esc(
      [e.showName, e.title].filter(Boolean).join(' — ')
    )}">` +
    (art
      ? `<img loading="lazy" src="${esc(posterUrl(art))}" alt="" />`
      : '<div class="film-noart">No artwork</div>') +
    `<button class="cw-del" data-delshow="${e.showId}" title="Remove this series">×</button>` +
    `<div class="cw-bar"><span style="width:${e.finished ? 100 : pct}%"></span></div>` +
    `<div class="film-name">${esc(e.showName || e.title)}</div>` +
    `<div class="film-sub">${esc(sub)}</div>` +
    `</div>`
  );
}

function cardHtml(s) {
  const sub = [s.year, s.rating != null ? `★ ${s.rating}` : ''].filter(Boolean).join(' · ');
  return (
    `<div class="film-card" data-id="${s.id}" title="${esc(s.name)}">` +
    (s.cover
      ? `<img loading="lazy" src="${esc(posterUrl(s.cover))}" alt="" />`
      : '<div class="film-noart">No artwork</div>') +
    `<div class="film-name">${esc(s.name)}</div>` +
    (sub ? `<div class="film-sub">${esc(sub)}</div>` : '') +
    `</div>`
  );
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
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
