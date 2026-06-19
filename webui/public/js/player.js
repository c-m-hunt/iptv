// player.js — one video player tile: <video> + mpegts.js + its search overlay.

import { SearchController } from './search.js';
import { applyRect } from './layout.js';

export class Player {
  constructor(num, { onSelect, onFocus }) {
    this.num = num;
    this.channel = null; // { id, name }
    this.mp = null;
    this.muted = true;

    this.el = document.createElement('div');
    this.el.className = 'player';
    this.el.dataset.num = String(num);
    this.el.innerHTML = `
      <video playsinline muted></video>
      <div class="status"></div>
      <div class="badge"><span class="num">${num}</span><span class="label"></span></div>
      <div class="search"></div>`;

    this.video = this.el.querySelector('video');
    this.statusEl = this.el.querySelector('.status');
    this.labelEl = this.el.querySelector('.badge .label');

    this.search = new SearchController(this.el.querySelector('.search'), {
      onSelect: (ch) => {
        this.setChannel(ch);
        onSelect?.(this);
      },
      onClose: () => {
        // Esc only dismisses if we already have something playing.
        if (this.channel) this.closeSearch();
      },
    });

    // Clicking a player focuses it (gives it audio).
    this.el.addEventListener('mousedown', () => onFocus?.(this));

    this._updateBadge();
  }

  setRect(rect) {
    applyRect(this.el, rect);
  }

  openSearch(prefill = '') {
    this.el.classList.add('searching');
    this.search.open(prefill);
  }

  closeSearch() {
    this.el.classList.remove('searching');
    this.search.close();
    // Hand focus back to the stage so single-key shortcuts (F, D, L, arrows)
    // work immediately instead of being swallowed by the search input.
    document.getElementById('stage')?.focus();
  }

  toggleSearch() {
    if (this.el.classList.contains('searching')) {
      if (this.channel) this.closeSearch();
    } else {
      this.openSearch(this.channel ? this.channel.name : '');
    }
  }

  setChannel(channel) {
    this.channel = channel;
    this.closeSearch();
    this._updateBadge();
    this._loadStream(channel.id);
  }

  _updateBadge() {
    this.labelEl.textContent = this.channel ? this.channel.name : '(no channel)';
  }

  _loadStream(streamId) {
    this._destroyMp();
    this.el.classList.add('is-loading');
    this.el.classList.remove('is-error');
    this.statusEl.textContent = 'Loading…';

    if (!window.mpegts || !window.mpegts.isSupported()) {
      this._fail('MPEG-TS playback not supported in this browser.');
      return;
    }

    const mp = window.mpegts.createPlayer(
      // Absolute URL: with enableWorker the fetch runs in a worker whose base
      // is a blob: URL, so a relative path can't be resolved.
      { type: 'mpegts', isLive: true, url: `${location.origin}/api/stream/live/${streamId}` },
      {
        // Tuned for SMOOTH playback over low latency (VLC-like). The defaults
        // here were previously latency-optimised, which caused stutter.
        enableWorker: true, // demux/remux off the main thread
        liveBufferLatencyChasing: false, // no seek-jumps to chase latency (was choppy)
        enableStashBuffer: true, // keep a cushion against network jitter
        stashInitialSize: 1024 * 1024, // ~1MB initial buffer
        lazyLoad: false, // keep the live connection open
        autoCleanupSourceBuffer: true, // avoid buffer bloat on long sessions
      }
    );
    mp.attachMediaElement(this.video);
    mp.on(window.mpegts.Events.ERROR, (type, detail) => {
      this._fail(`Stream error (${type}${detail ? ': ' + detail : ''}).`);
    });
    this.video.addEventListener(
      'playing',
      () => {
        this.el.classList.remove('is-loading', 'is-error');
        this.statusEl.textContent = '';
      },
      { once: true }
    );

    try {
      mp.load();
      const p = mp.play();
      if (p && p.catch) p.catch(() => {}); // ignore autoplay rejections
    } catch (err) {
      this._fail('Could not start stream: ' + err.message);
      return;
    }
    this.mp = mp;
    this._applyMute();
  }

  _fail(message) {
    this.el.classList.remove('is-loading');
    this.el.classList.add('is-error');
    this.statusEl.textContent = message + ' — press ' + this.num + ' to pick another channel.';
  }

  _destroyMp() {
    if (this.mp) {
      try {
        this.mp.destroy();
      } catch {
        /* ignore */
      }
      this.mp = null;
    }
  }

  setFocused(focused, multi) {
    this.el.classList.toggle('focused', focused);
    this.el.classList.toggle('multi', multi);
    // Single player is always audible; with two, only the focused one is.
    this.muted = multi ? !focused : false;
    this._applyMute();
  }

  _applyMute() {
    this.video.muted = this.muted;
    if (!this.muted) {
      const p = this.video.play?.();
      if (p && p.catch) p.catch(() => {});
    }
  }

  setShowInfo(show) {
    this.el.classList.toggle('show-info', show);
  }

  destroy() {
    this._destroyMp();
    this.el.remove();
  }
}
