// search.js — the per-player channel search overlay.
//
// Lives inside a player's `.search` element. Debounced calls to /api/channels,
// keyboard-navigable results, Enter/click to select. Self-contained: the host
// player just provides an onSelect callback and an onClose callback.

const DEBOUNCE_MS = 180;

export class SearchController {
  constructor(rootEl, { onSelect, onClose }) {
    this.root = rootEl;
    this.onSelect = onSelect;
    this.onClose = onClose;
    this.results = [];
    this.active = -1;
    this.timer = null;
    this.seq = 0;

    this.root.innerHTML = `
      <div class="search-box">
        <input type="text" placeholder="Search channels…" autocomplete="off"
               autocapitalize="off" spellcheck="false" />
        <div class="meta"></div>
      </div>
      <div class="results"></div>`;

    this.input = this.root.querySelector('input');
    this.meta = this.root.querySelector('.meta');
    this.list = this.root.querySelector('.results');

    this.input.addEventListener('input', () => this._onInput());
    this.input.addEventListener('keydown', (e) => this._onKey(e));
    this.list.addEventListener('mousedown', (e) => this._onListClick(e));
  }

  open(prefill = '') {
    if (typeof prefill === 'string') this.input.value = prefill;
    this.root.classList.add('open');
    // Defer focus so the overlay is visible first.
    requestAnimationFrame(() => {
      this.input.focus();
      this.input.select();
    });
    if (this.input.value.trim()) this._search();
    else this.meta.textContent = 'Type to filter the live catalogue.';
  }

  close() {
    this.root.classList.remove('open');
  }

  isOpen() {
    return this.root.classList.contains('open');
  }

  _onInput() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._search(), DEBOUNCE_MS);
  }

  async _search() {
    const q = this.input.value.trim();
    if (!q) {
      this._render([]);
      this.meta.textContent = 'Type to filter the live catalogue.';
      return;
    }
    const seq = ++this.seq;
    this.meta.textContent = 'Searching…';
    try {
      const resp = await fetch(`/api/channels?q=${encodeURIComponent(q)}&limit=80`);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      if (seq !== this.seq) return; // a newer query superseded this one
      this._render(data);
      this.meta.textContent = data.length
        ? `${data.length} match${data.length === 1 ? '' : 'es'}`
        : 'No channels matched.';
    } catch (err) {
      if (seq !== this.seq) return;
      this._render([]);
      this.meta.textContent = 'Search failed: ' + err.message;
    }
  }

  _render(results) {
    this.results = results;
    this.active = results.length ? 0 : -1;
    this.list.innerHTML = results
      .map(
        (r, i) =>
          `<div class="result${i === this.active ? ' active' : ''}" data-i="${i}">` +
          `${escapeHtml(r.name)}</div>`
      )
      .join('');
  }

  _onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.active >= 0 && this.results[this.active]) {
        this._select(this.results[this.active]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.onClose?.();
    }
    // Other keys (incl. 1/2/f/d/l) are literal text while typing — do not steal.
  }

  _move(delta) {
    if (!this.results.length) return;
    this.active = (this.active + delta + this.results.length) % this.results.length;
    const nodes = this.list.querySelectorAll('.result');
    nodes.forEach((n, i) => n.classList.toggle('active', i === this.active));
    nodes[this.active]?.scrollIntoView({ block: 'nearest' });
  }

  _onListClick(e) {
    const node = e.target.closest('.result');
    if (!node) return;
    e.preventDefault(); // keep focus handling predictable
    const i = Number(node.dataset.i);
    if (this.results[i]) this._select(this.results[i]);
  }

  _select(channel) {
    this.onSelect?.(channel);
  }
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
