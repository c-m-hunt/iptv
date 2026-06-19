// app.js — application orchestrator: state, layout rendering, controls.

import { Player } from './player.js';
import { LivePanels } from './live.js';
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

    this.players = [];
    this.layoutMode = 'horizontal'; // arrangement used once there are 2 players
    this.split = { x: 0.5, y: 0.5 };
    this.focusedNum = 1;
    this.showInfo = false;

    this._addPlayer(); // start with a single player
    this._wireControls();
    this._wireHandle();
    this._wireFullscreenGestures();
    installShortcuts(this);
    this.render();

    // Auto-select the first player's search on load.
    this.players[0].openSearch();
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
  }

  _applyFocus() {
    const multi = this.players.length > 1;
    this.players.forEach((p) => p.setFocused(p.num === this.focusedNum, multi));
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

    // Auto-hide the toolbar when the mouse is idle (unless pinned with C).
    this._pinned = false;
    let idle;
    this._wakeToolbar = () => {
      this.toolbar.classList.remove('faded');
      clearTimeout(idle);
      if (!this._pinned) idle = setTimeout(() => this.toolbar.classList.add('faded'), 4000);
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
}

window.addEventListener('DOMContentLoaded', () => {
  window.__app = new App();
});
