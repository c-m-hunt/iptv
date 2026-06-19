// app.js — application orchestrator: state, layout rendering, controls.

import { Player } from './player.js';
import { LivePanels } from './live.js';
import { Presets } from './presets.js';
import { computeLayout, clampSplit, MODES, MODE_LABELS } from './layout.js';
import { installShortcuts } from './shortcuts.js';

class App {
  constructor() {
    this.stage = document.getElementById('stage');
    this.handleEl = document.getElementById('handle');
    this.toolbar = document.getElementById('toolbar');
    this.helpEl = document.getElementById('help');

    this.live = new LivePanels(
      document.getElementById('scores-panel'),
      document.getElementById('standings-panel')
    );

    this.toastEl = document.getElementById('toast');
    this.presets = new Presets(document.getElementById('presets'), {
      onLoad: (setup) => this.applySetup(setup),
      onSaveRequest: (slot) => this.savePresetToSlot(slot),
    });
    this._awaitingSave = false;
    this._lastKey = 'iptv-last-setup-v1';
    this._canUnmute = false; // becomes true after the first user gesture

    this.players = [];
    this.layoutMode = 'horizontal'; // arrangement used once there are 2 players
    this.split = { x: 0.5, y: 0.5 };
    this.focusedNum = 1;
    this.showInfo = false;

    this._addPlayer(); // start with a single player
    this._wireControls();
    this._wireHandle();
    this._wireFullscreenGestures();
    this._wirePresets();
    installShortcuts(this);
    this.render();

    // Restore the previous session's setup, or start with an empty search.
    const last = this._readLast();
    if (last && (last.channels || []).some(Boolean)) {
      this.applySetup(last, { toast: false });
    } else {
      this.players[0].openSearch();
    }
  }

  get effectiveMode() {
    return this.players.length === 1 ? 'single' : this.layoutMode;
  }

  // -- players ------------------------------------------------------------
  _addPlayer() {
    if (this.players.length >= 2) return;
    const num = this.players.length + 1;
    const player = new Player(num, {
      onSelect: (p) => this.focusPlayer(p.num),
      onFocus: (p) => this.focusPlayer(p.num),
    });
    this.players.push(player);
    this.stage.appendChild(player.el);
  }

  addPlayer() {
    if (this.players.length >= 2) return;
    this._addPlayer();
    this.focusedNum = 2;
    this.render();
    this.players[1].openSearch();
  }

  removePlayer() {
    if (this.players.length < 2) return;
    const p = this.players.pop();
    p.destroy();
    this.focusedNum = 1;
    this.render();
  }

  focusPlayer(num) {
    if (!this.players.some((p) => p.num === num)) return;
    this.focusedNum = num;
    this._applyFocus();
    this._scheduleSaveLast();
  }

  openSearchFor(num) {
    const p = this.players.find((x) => x.num === num);
    if (!p) return;
    this.focusPlayer(num);
    p.openSearch(p.channel ? p.channel.name : '');
  }

  // -- layout -------------------------------------------------------------
  cycleLayout() {
    if (this.players.length < 2) return;
    const i = MODES.indexOf(this.layoutMode);
    this.layoutMode = MODES[(i + 1) % MODES.length];
    this.render();
  }

  adjustSplit(dx, dy) {
    if (this.players.length < 2) return;
    this.split = clampSplit({ x: this.split.x + dx, y: this.split.y + dy });
    this.render();
  }

  render() {
    const mode = this.effectiveMode;
    const layout = computeLayout(mode, this.split);

    this.players.forEach((p, i) => {
      const rect = layout.rects[i] || layout.rects[0];
      p.setRect(rect);
    });

    // In diagonal modes player 2 is the smaller overlapping inset.
    const diagonal = mode === 'diag-tlbr' || mode === 'diag-bltr';
    this.players.forEach((p, i) => p.el.classList.toggle('inset', diagonal && i === 1));

    // Drag handle
    if (layout.handle) {
      this.handleEl.classList.remove('hidden', 'vertical', 'point');
      this.handleEl.classList.add(layout.handle.kind);
      this.handleEl.style.left = layout.handle.x + '%';
      this.handleEl.style.top = layout.handle.kind === 'point' ? layout.handle.y + '%' : '0';
    } else {
      this.handleEl.classList.add('hidden');
    }

    // World Cup corner panels (only diagonal modes expose corners)
    this.live.setCorners(layout.corners);

    this._applyFocus();
    this._applyInfo();
    this._updateToolbar();
    this._scheduleSaveLast();
  }

  _applyFocus() {
    const multi = this.players.length > 1;
    this.players.forEach((p) =>
      p.setFocused(p.num === this.focusedNum, multi, this._canUnmute)
    );
  }

  _applyInfo() {
    this.players.forEach((p) => p.setShowInfo(this.showInfo));
  }

  toggleInfo() {
    this.showInfo = !this.showInfo;
    this._applyInfo();
  }

  toggleLive() {
    this.live.setVisible(!this.live.isVisible());
    this._updateToolbar();
    this._scheduleSaveLast();
  }

  toggleHelp() {
    this.helpEl.classList.toggle('hidden');
  }

  // -- fullscreen ---------------------------------------------------------
  // Fullscreen the whole document so the toolbar / panels stay visible.
  toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      const p = req?.call(el);
      if (p && p.catch) p.catch((e) => console.warn('[fullscreen] request failed:', e.message));
    }
  }

  // -- controls + handle --------------------------------------------------
  _wireControls() {
    const fsBtn = document.getElementById('btn-fs');
    fsBtn.addEventListener('click', () => this.toggleFullscreen());
    const syncFs = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      fsBtn.textContent = on ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
    };
    document.addEventListener('fullscreenchange', syncFs);
    document.addEventListener('webkitfullscreenchange', syncFs);

    document.getElementById('btn-add').addEventListener('click', () => this.addPlayer());
    document.getElementById('btn-remove').addEventListener('click', () => this.removePlayer());
    document.getElementById('btn-layout').addEventListener('click', () => this.cycleLayout());
    document.getElementById('btn-live').addEventListener('click', () => this.toggleLive());

    // First user gesture unlocks audio: unmute the focused player.
    const unlock = () => {
      if (this._canUnmute) return;
      this._canUnmute = true;
      this._applyFocus();
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);

    // Reveal the control bar AND the drag handle on mouse movement, then hide
    // both after the same idle period (unless pinned with C).
    this._pinned = false;
    let idle;
    this._wakeToolbar = () => {
      this.toolbar.classList.remove('faded');
      this.handleEl.classList.remove('faded');
      clearTimeout(idle);
      if (!this._pinned) {
        idle = setTimeout(() => {
          this.toolbar.classList.add('faded');
          this.handleEl.classList.add('faded');
        }, 4000);
      }
    };
    document.addEventListener('mousemove', this._wakeToolbar);
    this._wakeToolbar();
  }

  // Pin/unpin the control bar so it stays up (C). Pinned = always visible.
  toggleControls() {
    this._pinned = !this._pinned;
    this.toolbar.classList.toggle('faded', false);
    this._wakeToolbar();
  }

  _updateToolbar() {
    const two = this.players.length === 2;
    document.getElementById('btn-add').classList.toggle('hidden', two);
    document.getElementById('btn-remove').classList.toggle('hidden', !two);

    const layoutBtn = document.getElementById('btn-layout');
    layoutBtn.classList.toggle('hidden', !two);
    layoutBtn.textContent = 'Layout: ' + (MODE_LABELS[this.layoutMode] || this.layoutMode);

    const liveBtn = document.getElementById('btn-live');
    liveBtn.classList.toggle('hidden', !two);
    liveBtn.textContent = 'Live data: ' + (this.live.isVisible() ? 'on' : 'off');
  }

  // Double-click the video to toggle fullscreen — a guaranteed user gesture on
  // a visible element, so it always engages (unlike a key that can be typed
  // into the search box, or a faded toolbar button).
  _wireFullscreenGestures() {
    this.stage.addEventListener('dblclick', (e) => {
      // Ignore double-clicks on the search overlay, drag handle, or panels.
      if (e.target.closest('.search, #handle, .corner-panel')) return;
      if (this.players.some((p) => p.el.classList.contains('searching'))) return;
      this.toggleFullscreen();
    });
  }

  _wireHandle() {
    const onMove = (clientX, clientY) => {
      const r = this.stage.getBoundingClientRect();
      const x = (clientX - r.left) / r.width;
      const y = (clientY - r.top) / r.height;
      const kind = this.handleEl.classList.contains('point') ? 'point' : 'vertical';
      this.split = clampSplit({
        x,
        y: kind === 'point' ? y : this.split.y,
      });
      this.render();
    };

    let dragging = false;
    const down = (e) => {
      dragging = true;
      this.handleEl.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const move = (e) => {
      if (!dragging) return;
      onMove(e.clientX, e.clientY);
    };
    const up = (e) => {
      dragging = false;
      this.handleEl.releasePointerCapture?.(e.pointerId);
    };

    this.handleEl.addEventListener('pointerdown', down);
    this.handleEl.addEventListener('pointermove', move);
    this.handleEl.addEventListener('pointerup', up);
    this.handleEl.addEventListener('pointercancel', up);
  }

  // -- presets ------------------------------------------------------------
  _wirePresets() {
    // Open when the mouse reaches the right edge; close on leaving the panel
    // (unless pinned open via P).
    document.addEventListener('mousemove', (e) => {
      if (e.clientX >= window.innerWidth - 3) this.presets.open();
    });
    this.presets.panel.addEventListener('mouseleave', () => this.presets.close());
  }

  togglePresets() {
    this.presets.toggle();
  }

  // Snapshot of everything a preset restores.
  getSetup() {
    return {
      channels: this.players.map((p) =>
        p.channel ? { id: p.channel.id, name: p.channel.name } : null
      ),
      layoutMode: this.layoutMode,
      split: { x: this.split.x, y: this.split.y },
      focusedNum: this.focusedNum,
      live: this.live.isVisible(),
    };
  }

  applySetup(s, { toast = true } = {}) {
    if (!s) return;
    const want = Math.max(1, Math.min(2, (s.channels || []).length || 1));
    while (this.players.length > want) this._removeLastPlayer();
    while (this.players.length < want) this._addPlayer();

    (s.channels || []).forEach((ch, i) => {
      const p = this.players[i];
      if (!p || !ch) return;
      if (!p.channel || p.channel.id !== ch.id) p.setChannel(ch);
      else p.closeSearch();
    });

    if (s.layoutMode) this.layoutMode = s.layoutMode;
    if (s.split) this.split = clampSplit({ x: s.split.x, y: s.split.y });
    this.focusedNum = Math.min(s.focusedNum || 1, this.players.length);
    this.live.setVisible(!!s.live);
    this.render();
    if (toast) this.toast('Loaded preset');
  }

  // -- last-setup persistence (restored on next page load) ----------------
  _readLast() {
    try {
      return JSON.parse(localStorage.getItem(this._lastKey));
    } catch {
      return null;
    }
  }

  _scheduleSaveLast() {
    clearTimeout(this._saveLastTimer);
    this._saveLastTimer = setTimeout(() => {
      try {
        localStorage.setItem(this._lastKey, JSON.stringify(this.getSetup()));
      } catch {
        /* storage disabled — setup just won't persist */
      }
    }, 600);
  }

  _removeLastPlayer() {
    const p = this.players.pop();
    if (p) p.destroy();
  }

  // Save flow: S puts us in "awaiting slot", the next 1–9 saves there.
  beginSavePreset() {
    this._awaitingSave = true;
    this.toast('Save preset — press 1–9 (Esc to cancel)', 4000);
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._awaitingSave = false;
    }, 4000);
  }

  savePresetToSlot(slot) {
    this._awaitingSave = false;
    clearTimeout(this._saveTimer);
    this.presets.save(slot, this.getSetup());
    this.toast(`Saved preset ${slot}`);
  }

  // Routes 1–9: save-mode → save; panel open → load; else → focus player 1/2.
  handleDigit(n) {
    if (this._awaitingSave) {
      this.savePresetToSlot(n);
      return;
    }
    if (this.presets.isOpen()) {
      if (!this.presets.selectByNumber(n)) this.toast(`Slot ${n} is empty`, 1200);
      return;
    }
    if (n === 1 || n === 2) this.openSearchFor(n);
  }

  // Esc: cancel save-mode / close the panel. Returns true if it did something.
  cancelTransient() {
    let did = false;
    if (this._awaitingSave) {
      this._awaitingSave = false;
      clearTimeout(this._saveTimer);
      this.toast('Save cancelled', 1000);
      did = true;
    }
    if (this.presets.isOpen()) {
      this.presets.forceClose();
      did = true;
    }
    return did;
  }

  toast(message, ms = 1600) {
    const el = this.toastEl;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.__app = new App();
});
