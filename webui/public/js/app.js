// app.js — application orchestrator: state, layout rendering, controls.

import { Player } from './player.js';
import { Presets } from './presets.js';
import { Profile } from './profile.js';
import { Films } from './films.js';
import { WatchHistory } from './history.js';
import { Catchup } from './catchup.js';
import { Series } from './series.js';
import { RemoteLink } from './remote-link.js';
import { computeLayout, clampSplit, MODES, MODE_LABELS } from './layout.js';
import { installShortcuts } from './shortcuts.js';

class App {
  constructor() {
    this.stage = document.getElementById('stage');
    this.handleEl = document.getElementById('handle');
    this.toolbar = document.getElementById('toolbar');
    this.helpEl = document.getElementById('help');

    this.toastEl = document.getElementById('toast');
    this.presets = new Presets(document.getElementById('presets'), {
      onLoad: (setup) => this.applySetup(setup),
      onSaveRequest: (slot) => this.savePresetToSlot(slot),
    });
    this.profile = new Profile(document.getElementById('profile'));
    this.history = new WatchHistory();
    this.films = new Films(document.getElementById('films'), {
      history: this.history,
      onPlay: (film, playback, opts) => this.playMovie(film, playback, opts),
    });

    this.catchup = new Catchup(document.getElementById('catchup'), {
      onPlay: (programme) => this.playCatchup(programme),
    });
    this.series = new Series(document.getElementById('series'), {
      history: this.history,
      onPlayEpisode: (episode) => this.playEpisode(episode),
    });

    // Registers this screen so a phone can control it. Control surface only —
    // no video is ever sent anywhere.
    this.remote = new RemoteLink(this);

    // A closing tab gets no timeupdate, so flush the resume point on the way out.
    window.addEventListener('pagehide', () => this.players.forEach((p) => p.saveProgress()));
    this._awaitingSave = false;
    // v2: entries gained `type`. A v1 entry saved while an episode was playing
    // is indistinguishable from a film, and restoring it as one 502s — so drop
    // the old key rather than guess.
    this._lastKey = 'iptv-last-setup-v2';
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
      onProgress: (info) => this.history.record(info),
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

  // Swap the two players' screen positions (X). Instant — streams stay live;
  // numbering stays tied to position (1 = big) so the focused screen keeps its
  // sound and the swapped-in content takes the larger screen.
  swapPlayers() {
    if (this.players.length < 2) return;
    this.players.reverse();
    this.players.forEach((p, i) => p.setNum(i + 1));
    this.render();
    this.toast('Switched screens');
    this._scheduleSaveLast();
  }

  // This is also the way back to live from a film or a catch-up programme.
  // Only prefill from a live channel: seeding the box with a film title would
  // search the live catalogue for it and turn up nothing.
  openSearchFor(num) {
    const p = this.players.find((x) => x.num === num);
    if (!p) return;
    this.focusPlayer(num);
    const live = p.channel && (p.channel.kind || 'live') === 'live';
    p.openSearch(live ? p.channel.name : '');
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

  // Absolute split, for a slider on the phone remote.
  setSplit(x, y) {
    if (this.players.length < 2) return;
    this.split = clampSplit({ x, y });
    this.render();
  }

  loadPreset(slot) {
    const p = this.presets.get(slot);
    if (!p) {
      this.toast(`Slot ${slot} is empty`, 1200);
      return;
    }
    this.applySetup(p);
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

  // Space: pause/resume the focused film.
  togglePlayPause() {
    const p = this.players.find((x) => x.num === this.focusedNum) || this.players[0];
    if (!p) return;
    if (!p.togglePlay()) this.toast('Live TV can’t be paused', 1200);
  }

  adjustVolume(delta) {
    const p = this.players.find((x) => x.num === this.focusedNum);
    if (p) p.setVolume(p.volume + delta);
  }

  toggleInfo() {
    this.showInfo = !this.showInfo;
    this._applyInfo();
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

  // In fullscreen the browser claims Escape for itself, so opening the films,
  // series or catch-up browser and pressing Esc dropped you out of fullscreen
  // with the overlay still up — the wrong one of the two closed.
  //
  // Keyboard Lock (Chrome, Edge) hands Escape to the page instead, so Esc closes
  // the overlay and fullscreen survives; holding Esc still exits, which is the
  // browser's own escape hatch and can't be taken away.
  _onFullscreenChange(on) {
    if (on) {
      navigator.keyboard?.lock?.(['Escape']).catch(() => {
        /* not permitted here — the fallback below covers it */
      });
      return;
    }
    navigator.keyboard?.unlock?.();
    // Without Keyboard Lock (Safari, Firefox) that first Escape always exits
    // fullscreen. Close whatever was open as well, so one press gets you back to
    // watching instead of stranding the overlay on screen.
    if (!navigator.keyboard?.lock) this.cancelTransient();
  }

  // Leaving fullscreen needs no user gesture, so a remote can do this even
  // though it can never put the page *into* fullscreen.
  exitFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  }

  // -- controls + handle --------------------------------------------------
  _wireControls() {
    const fsBtn = document.getElementById('btn-fs');
    fsBtn.addEventListener('click', () => this.toggleFullscreen());
    const syncFs = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      fsBtn.textContent = on ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
      this._onFullscreenChange(on);
    };
    document.addEventListener('fullscreenchange', syncFs);
    document.addEventListener('webkitfullscreenchange', syncFs);

    document.getElementById('btn-add').addEventListener('click', () => this.addPlayer());
    document.getElementById('btn-remove').addEventListener('click', () => this.removePlayer());
    document.getElementById('btn-swap').addEventListener('click', () => this.swapPlayers());
    document.getElementById('btn-layout').addEventListener('click', () => this.cycleLayout());
    document.getElementById('btn-profile').addEventListener('click', () => this.toggleProfile());
    document
      .getElementById('btn-live')
      .addEventListener('click', () => this.openSearchFor(this.focusedNum));
    document.getElementById('btn-films').addEventListener('click', () => this.toggleFilms());
    document.getElementById('btn-catchup').addEventListener('click', () => this.toggleCatchup());
    document.getElementById('btn-series').addEventListener('click', () => this.toggleSeries());
    document.getElementById('btn-help').addEventListener('click', () => this.toggleHelp());
    document.getElementById('btn-remote').addEventListener('click', () => this.toggleRemoteLink());
    // The alternative-address buttons re-render the QR for a different host.
    document.getElementById('remote-pair').addEventListener('click', async (e) => {
      if (e.target.closest('.rp-close') || e.target.id === 'remote-pair') {
        this.closeRemoteLink();
        return;
      }
      const alt = e.target.closest('.rp-alt');
      if (alt) {
        const url = alt.dataset.url;
        const qr = document.querySelector('#remote-pair .rp-qr');
        const label = document.querySelector('#remote-pair .rp-url');
        try {
          const resp = await fetch('/api/remote/qr?url=' + encodeURIComponent(url));
          const data = await resp.json();
          if (resp.ok) {
            qr.innerHTML = data.qrSvg;
            label.textContent = url.replace(/#.*$/, '');
          }
        } catch {
          /* leave the current QR in place */
        }
      }
    });

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
      // Film/catch-up transport bars follow the same idle timer (see CSS).
      document.body.classList.remove('chrome-idle');
      clearTimeout(idle);
      if (!this._pinned) {
        idle = setTimeout(() => {
          this.toolbar.classList.add('faded');
          this.handleEl.classList.add('faded');
          document.body.classList.add('chrome-idle');
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
    document.getElementById('btn-swap').classList.toggle('hidden', !two);

    const layoutBtn = document.getElementById('btn-layout');
    layoutBtn.classList.toggle('hidden', !two);
    layoutBtn.textContent = 'Layout: ' + (MODE_LABELS[this.layoutMode] || this.layoutMode);
  }

  // Double-click the video to toggle fullscreen — a guaranteed user gesture on
  // a visible element, so it always engages (unlike a key that can be typed
  // into the search box, or a faded toolbar button).
  _wireFullscreenGestures() {
    this.stage.addEventListener('dblclick', (e) => {
      // Ignore double-clicks on the search overlay, drag handle, or panels.
      if (e.target.closest('.search, #handle, .corner-panel, #films, #profile, #presets')) return;
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

  toggleProfile() {
    this.profile.toggle();
  }

  toggleFilms() {
    this.films.toggle();
  }

  toggleCatchup() {
    this.catchup.toggle();
  }

  toggleSeries() {
    this.series.toggle();
  }

  // -- remote control pairing ---------------------------------------------
  async toggleRemoteLink() {
    const panel = document.getElementById('remote-pair');
    if (!panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    panel.innerHTML = '<div class="rp-card"><div class="rp-loading">Preparing link…</div></div>';
    try {
      const resp = await fetch(
        '/api/remote/pair?session=' + encodeURIComponent(this.remote.sessionId)
      );
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      panel.innerHTML = renderPairing(data);
    } catch (err) {
      panel.innerHTML =
        `<div class="rp-card"><div class="rp-loading bad">Couldn't create a link: ${escapeHtml(
          err.message
        )}</div></div>`;
    }
  }

  closeRemoteLink() {
    document.getElementById('remote-pair')?.classList.add('hidden');
  }

  // Episodes play exactly like films; the probe decides direct vs remux.
  async playEpisode(episode, { startAt = null } = {}) {
    const p = this.players.find((x) => x.num === this.focusedNum) || this.players[0];
    if (!p) return;
    let playback = { mode: 'direct' };
    try {
      const resp = await fetch(`/api/episodes/${episode.id}/playback`);
      if (resp.ok) playback = await resp.json();
    } catch {
      /* fall back to a direct attempt rather than refusing to play */
    }
    if (playback.mode === 'unsupported') {
      this.toast(playback.reason || 'This episode can’t be played', 2600);
      return;
    }
    const resume = startAt == null ? this.history.resumeAt(episode.id, 'episode') : startAt;
    p.setMovie(episode, playback, { startAt: resume });
    this.history.record({
      ...episode,
      mode: playback.mode,
      position: resume,
    });
    const label = episodeLabel(episode);
    this.toast(resume > 0 ? `Resuming ${label} from ${fmtClock(resume)}` : `Playing ${label}`);
    this._scheduleSaveLast();
  }

  playCatchup(programme) {
    const p = this.players.find((x) => x.num === this.focusedNum) || this.players[0];
    if (!p) return;
    p.setCatchup(programme);
    this.toast(`${programme.title} — ${cleanChannel(programme.channelName)}`);
    this._scheduleSaveLast();
  }

  // Films load into the focused player, so a film can sit alongside live TV in
  // the same grid.
  playMovie(film, playback = {}, { startAt = 0 } = {}) {
    const p = this.players.find((x) => x.num === this.focusedNum) || this.players[0];
    if (!p) return;
    p.setMovie(film, playback, { startAt });

    // Record straight away so a film shows up in continue-watching even if it's
    // abandoned before the first progress report.
    this.history.record({
      id: film.id,
      title: film.title || film.name,
      poster: film.poster,
      durationSecs: film.durationSecs,
      mode: playback.mode,
      position: startAt,
    });

    const name = film.title || film.name;
    if (startAt > 0) this.toast(`Resuming ${name} from ${fmtClock(startAt)}`);
    else this.toast(playback.mode === 'remux' ? `Remuxing ${name}…` : `Playing ${name}`);
    this._scheduleSaveLast();
  }

  // Snapshot of everything a preset restores.
  getSetup() {
    return {
      channels: this.players.map((p) =>
        p.channel
          ? {
              id: p.channel.id,
              name: p.channel.name,
              kind: p.channel.kind || 'live',
              // Films remember how they were played so a restored setup doesn't
              // have to re-probe the container before it can start. Episodes
              // must also remember they ARE episodes — they stream from a
              // different path, and restoring one as a film 502s.
              ...(p.channel.kind === 'movie'
                ? {
                    mode: p.channel.mode,
                    durationSecs: p.channel.durationSecs,
                    type: p.channel.type || 'movie',
                    showId: p.channel.showId,
                    showName: p.channel.showName,
                    showCover: p.channel.showCover,
                    season: p.channel.season,
                    episode: p.channel.episode,
                  }
                : {}),
              // A catch-up programme is a channel plus a window in time.
              ...(p.channel.kind === 'catchup'
                ? {
                    start: p.channel.start,
                    durationSecs: p.channel.durationSecs,
                    channelName: p.channel.channelName,
                  }
                : {}),
            }
          : null
      ),
      layoutMode: this.layoutMode,
      split: { x: this.split.x, y: this.split.y },
      focusedNum: this.focusedNum,
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
      const same = p.channel && p.channel.id === ch.id && (p.channel.kind || 'live') === (ch.kind || 'live');
      if (same) p.closeSearch();
      else if (ch.kind === 'movie') {
        // Pick it up where it was left, not at the start — otherwise restoring
        // a setup would replay from zero and overwrite the very resume point we
        // saved.
        const type = ch.type || 'movie';
        p.setMovie(
          {
            id: ch.id,
            name: ch.name,
            title: ch.name,
            durationSecs: ch.durationSecs,
            type,
            showId: ch.showId,
            showName: ch.showName,
            showCover: ch.showCover,
            season: ch.season,
            episode: ch.episode,
          },
          { mode: ch.mode },
          { startAt: this.history.resumeAt(ch.id, type) }
        );
      } else if (ch.kind === 'catchup')
        p.setCatchup({
          channelId: ch.id,
          channelName: ch.channelName,
          title: ch.name,
          start: ch.start,
          durationSecs: ch.durationSecs,
        });
      else p.setChannel(ch);
    });

    if (s.layoutMode) this.layoutMode = s.layoutMode;
    if (s.split) this.split = clampSplit({ x: s.split.x, y: s.split.y });
    this.focusedNum = Math.min(s.focusedNum || 1, this.players.length);
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
    if (this.profile.isOpen()) {
      this.profile.forceClose();
      did = true;
    }
    if (this.films.isOpen()) {
      this.films.close(); // closes the detail view first, if one is up
      did = true;
    }
    if (this.catchup.isOpen()) {
      this.catchup.close();
      did = true;
    }
    if (this.series.isOpen()) {
      this.series.close();
      did = true;
    }
    if (!document.getElementById('remote-pair').classList.contains('hidden')) {
      this.closeRemoteLink();
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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

// The QR arrives as SVG from the server, which is where the reachable address is
// known. Alternatives are offered because a machine can have several addresses
// and only some are reachable from a phone.
function renderPairing(data) {
  const alts = (data.alternatives || [])
    .map(
      (a) =>
        `<li><button class="rp-alt" data-url="${escapeHtml(a.url)}">${escapeHtml(
          a.label
        )}</button></li>`
    )
    .join('');
  return `
    <div class="rp-card">
      <button class="rp-close" title="Close (Esc)">×</button>
      <div class="rp-title">Remote control</div>
      <div class="rp-qr">${data.qrSvg}</div>
      <div class="rp-url">${escapeHtml(data.url.replace(/#.*$/, ''))}</div>
      <p class="rp-note">
        Scan with your phone to control <b>this</b> screen. The phone shows controls
        only — the picture stays here. Fullscreen has to be started here (browsers
        refuse it remotely); after that the remote can drive everything.
      </p>
      ${alts ? `<details class="rp-alts"><summary>Phone can’t connect?</summary><ul>${alts}</ul></details>` : ''}
    </div>`;
}

function episodeLabel(e) {
  const code =
    e.season != null && e.episode != null
      ? `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`
      : '';
  return [e.showName, code, e.title].filter(Boolean).join(' · ');
}

function cleanChannel(n) {
  return String(n || '').replace(/\s*\|.*$/, '').trim();
}

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

window.addEventListener('DOMContentLoaded', () => {
  window.__app = new App();
});
