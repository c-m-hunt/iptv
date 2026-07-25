// films.js — the film browser: search, category/sort filters, poster grid and
// a detail view.
//
// Backed by /api/movies (a filtered view of the cached VOD catalogue) and
// /api/movies/:id (per-film metadata from get_vod_info). Posters go through
// /api/poster so the browser never talks to the provider's CDN.

const DEBOUNCE_MS = 200;
const PAGE = 60;

const SORTS = [
  ['added', 'Recently added'],
  ['rating', 'Highest rated'],
  ['year', 'Newest first'],
  ['title', 'A–Z'],
];

export class Films {
  constructor(rootEl, { onPlay }) {
    this.root = rootEl;
    this.onPlay = onPlay;
    this.items = [];
    this.total = 0;
    this.offset = 0;
    this.seq = 0;
    this.detail = null;

    this.root.innerHTML = `
      <div class="films-head">
        <span class="films-title">Films</span>
        <input class="films-search" type="text" placeholder="Search films…"
               autocomplete="off" autocapitalize="off" spellcheck="false" />
        <select class="films-cat"><option value="">All categories</option></select>
        <select class="films-sort">${SORTS.map(
          ([v, l]) => `<option value="${v}">${l}</option>`
        ).join('')}</select>
        <span class="films-count"></span>
        <button class="films-close" title="Close (M / Esc)">×</button>
      </div>
      <div class="films-grid"></div>
      <div class="films-more"></div>
      <div class="films-detail"></div>`;

    this.searchEl = this.root.querySelector('.films-search');
    this.catEl = this.root.querySelector('.films-cat');
    this.sortEl = this.root.querySelector('.films-sort');
    this.countEl = this.root.querySelector('.films-count');
    this.gridEl = this.root.querySelector('.films-grid');
    this.moreEl = this.root.querySelector('.films-more');
    this.detailEl = this.root.querySelector('.films-detail');

    this.searchEl.addEventListener('input', () => {
      clearTimeout(this._t);
      this._t = setTimeout(() => this.load({ reset: true }), DEBOUNCE_MS);
    });
    // Global shortcuts deliberately stay out of text inputs, so the overlay
    // handles its own Esc — otherwise there's no way out from the search box.
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
  }

  // -- open/close ---------------------------------------------------------
  isOpen() {
    return this.root.classList.contains('open');
  }

  open() {
    this.root.classList.add('open');
    if (!this._catsLoaded) this._loadCategories();
    if (!this.items.length) this.load({ reset: true });
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
      const resp = await fetch('/api/movies/categories');
      const cats = await resp.json();
      if (!Array.isArray(cats)) return;
      this.catEl.innerHTML =
        '<option value="">All categories</option>' +
        cats
          .map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${c.count})</option>`)
          .join('');
    } catch {
      /* categories are a convenience; search still works without them */
    }
  }

  async load({ reset = true } = {}) {
    if (reset) {
      this.offset = 0;
      this.items = [];
      this.gridEl.innerHTML = '';
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
      const resp = await fetch('/api/movies?' + params);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      if (seq !== this.seq) return; // superseded by a newer query

      this.total = data.total;
      this.items = this.items.concat(data.items);
      this.offset = this.items.length;
      this._renderGrid(data.items, !reset);
      this.countEl.textContent = `${data.total.toLocaleString()} film${
        data.total === 1 ? '' : 's'
      }`;
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

  _renderGrid(items, append) {
    const html = items.map((f) => cardHtml(f)).join('');
    if (append) this.gridEl.insertAdjacentHTML('beforeend', html);
    else this.gridEl.innerHTML = html || '<div class="films-empty">No films matched.</div>';
  }

  // -- detail -------------------------------------------------------------
  async openDetail(id) {
    this.detail = { id };
    this.detailEl.classList.add('open');
    this.detailEl.innerHTML = '<div class="fd-loading">Loading…</div>';
    try {
      const [infoResp, playResp] = await Promise.all([
        fetch(`/api/movies/${id}`),
        fetch(`/api/movies/${id}/playback`),
      ]);
      const info = await infoResp.json();
      if (!infoResp.ok) throw new Error(info.error || `HTTP ${infoResp.status}`);
      const play = playResp.ok ? await playResp.json() : { playable: false, reason: 'unknown' };
      if (!this.detail || this.detail.id !== id) return; // closed or switched
      this.detail = { id, info, play };
      this._renderDetail(info, play);
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

  _renderDetail(f, play) {
    const meta = [
      f.year,
      f.duration,
      f.genre,
      f.country,
      f.mpaa,
      f.rating != null ? `★ ${f.rating}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const playBtn = play.playable
      ? '<button class="fd-play">▶ Play</button>'
      : '<button class="fd-play" disabled>▶ Play</button>';
    const note = play.playable
      ? `<span class="fd-note ok">${esc((play.container || '').toUpperCase())} · plays natively</span>`
      : `<span class="fd-note warn">${esc(play.reason || 'not playable in a browser')}</span>`;

    this.detailEl.innerHTML = `
      <div class="fd-card">
        ${
          f.backdrop
            ? `<div class="fd-backdrop" style="background-image:url('${esc(
                posterUrl(f.backdrop)
              )}')"></div>`
            : ''
        }
        <button class="fd-close" title="Back (Esc)">×</button>
        <div class="fd-body">
          <img class="fd-poster" src="${esc(posterUrl(f.poster))}" alt="" />
          <div class="fd-info">
            <h2>${esc(f.title || f.name)}</h2>
            <div class="fd-meta">${esc(meta)}</div>
            <p class="fd-plot">${esc(f.plot || 'No description available.')}</p>
            ${f.director ? `<div class="fd-row"><b>Director</b> ${esc(f.director)}</div>` : ''}
            ${f.cast ? `<div class="fd-row"><b>Cast</b> ${esc(f.cast)}</div>` : ''}
            <div class="fd-actions">
              ${playBtn}
              ${
                f.trailer
                  ? `<a class="fd-trailer" href="https://www.youtube.com/watch?v=${esc(
                      f.trailer
                    )}" target="_blank" rel="noopener">Trailer ↗</a>`
                  : ''
              }
              ${note}
            </div>
          </div>
        </div>
      </div>`;
  }

  _onDetailClick(e) {
    if (e.target.closest('.fd-close') || e.target === this.detailEl) {
      this.closeDetail();
      return;
    }
    if (e.target.closest('.fd-play') && this.detail?.info) {
      const f = this.detail.info;
      this.closeDetail();
      this.root.classList.remove('open');
      this.onPlay?.(f);
    }
  }
}

// -- helpers ----------------------------------------------------------------
function posterUrl(u) {
  return u ? '/api/poster?u=' + encodeURIComponent(u) : '';
}

function cardHtml(f) {
  const sub = [f.year, f.rating != null ? `★ ${f.rating}` : ''].filter(Boolean).join(' · ');
  return (
    `<div class="film-card" data-id="${f.id}" title="${esc(f.name)}">` +
    (f.poster
      ? `<img loading="lazy" src="${esc(posterUrl(f.poster))}" alt="" />`
      : '<div class="film-noart">No artwork</div>') +
    (f.tag ? `<span class="film-tag">${esc(f.tag)}</span>` : '') +
    `<div class="film-name">${esc(f.title)}</div>` +
    (sub ? `<div class="film-sub">${esc(sub)}</div>` : '') +
    `</div>`
  );
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
