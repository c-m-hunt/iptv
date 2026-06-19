// presets.js — save/restore "preset" setups to localStorage slots 1–9, with a
// slide-in panel from the right edge.
//
// A preset captures: channels (per player), split dimensions, layout mode, the
// focused/sound player, and whether the World Cup live panels are on.

const STORE_KEY = 'iptv-presets-v1';
const SLOTS = 9;

const LAYOUT_LABELS = {
  horizontal: 'horizontal',
  'diag-tlbr': 'diag ↖↘',
  'diag-bltr': 'diag ↙↗',
};

export class Presets {
  constructor(panelEl, { onLoad, onSaveRequest }) {
    this.panel = panelEl;
    this.onLoad = onLoad;
    this.onSaveRequest = onSaveRequest;
    this.data = this._read();
    this.pinned = false;

    this.panel.innerHTML = `
      <div class="presets-title">Presets</div>
      <div class="presets-list"></div>
      <div class="presets-foot">
        Click / press <b>1–9</b> to load · <b>S</b> then <b>1–9</b> to save · <b>P</b> toggles
      </div>`;
    this.listEl = this.panel.querySelector('.presets-list');
    this.listEl.addEventListener('click', (e) => this._onClick(e));
    this.render();
  }

  // -- storage ------------------------------------------------------------
  _read() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      return {};
    }
  }
  _write() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
    } catch {
      /* storage full / disabled — presets just won't persist */
    }
  }

  get(slot) {
    return this.data[slot] || null;
  }

  save(slot, setup) {
    this.data[slot] = { ...setup, label: labelFor(setup) };
    this._write();
    this.render();
  }

  remove(slot) {
    delete this.data[slot];
    this._write();
    this.render();
  }

  // -- open/close ---------------------------------------------------------
  isOpen() {
    return this.panel.classList.contains('open');
  }
  open() {
    this.panel.classList.add('open');
  }
  close() {
    if (!this.pinned) this.panel.classList.remove('open');
  }
  forceClose() {
    this.pinned = false;
    this.panel.classList.remove('open');
  }
  toggle() {
    if (this.isOpen()) this.forceClose();
    else {
      this.pinned = true;
      this.open();
    }
  }

  // Load by number (digit shortcut while open). Returns true if a preset existed.
  selectByNumber(n) {
    const p = this.get(n);
    if (!p) return false;
    this.onLoad?.(p);
    this.forceClose();
    return true;
  }

  // -- render -------------------------------------------------------------
  render() {
    let html = '';
    for (let i = 1; i <= SLOTS; i++) {
      const p = this.data[i];
      if (p) {
        html +=
          `<div class="preset filled" data-slot="${i}">` +
          `<span class="pnum">${i}</span>` +
          `<span class="pbody"><span class="pname">${esc(p.label || '(preset)')}</span>` +
          `<span class="pmeta">${esc(metaFor(p))}</span></span>` +
          `<button class="pdel" data-del="${i}" title="Delete preset ${i}">×</button>` +
          `</div>`;
      } else {
        html +=
          `<div class="preset empty" data-save="${i}" title="Save current setup to slot ${i}">` +
          `<span class="pnum">${i}</span>` +
          `<span class="pbody"><span class="pname empty-label">empty — click to save</span></span>` +
          `</div>`;
      }
    }
    this.listEl.innerHTML = html;
  }

  _onClick(e) {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      this.remove(Number(del.dataset.del));
      return;
    }
    const filled = e.target.closest('.preset.filled');
    if (filled) {
      this.selectByNumber(Number(filled.dataset.slot));
      return;
    }
    const empty = e.target.closest('.preset.empty');
    if (empty) {
      this.onSaveRequest?.(Number(empty.dataset.save));
    }
  }
}

function cleanName(n) {
  // Strip trailing quality/source suffixes like " | FHD |" for a tidy label.
  return String(n).replace(/\s*\|.*$/, '').trim() || String(n);
}

function labelFor(setup) {
  const chs = (setup.channels || []).filter(Boolean).map((c) => cleanName(c.name));
  return chs.length ? chs.join('  +  ') : '(no channels)';
}

function metaFor(p) {
  const n = (p.channels || []).filter(Boolean).length;
  const bits = [n < 2 ? 'single' : LAYOUT_LABELS[p.layoutMode] || p.layoutMode];
  if (n === 2) bits.push('🔊 P' + (p.focusedNum || 1));
  if (p.live) bits.push('live');
  return bits.join(' · ');
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
