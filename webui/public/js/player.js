// player.js — one video player tile: <video> + mpegts.js + its search overlay.

import { SearchController } from './search.js';
import { applyRect } from './layout.js';

// Stuck-stream watchdog tuning.
const WATCHDOG_MS = 2000; // how often to check that playback is progressing
const STUCK_MS = 8000; // playing stream frozen this long => restart
const INITIAL_LOAD_TIMEOUT = 20000; // never-started stream: failsafe before reload
const RELOAD_COOLDOWN = 8000; // min gap between watchdog restarts
const MAX_STUCK_RELOADS = 6; // give up after this many fruitless restarts
const MAX_ERROR_RETRIES = 5; // consecutive hard errors before giving up
const ERROR_RETRY_DELAY = 2000;

export class Player {
  constructor(num, { onSelect, onFocus, onProgress }) {
    this.onProgress = onProgress;
    this.num = num;
    this.channel = null; // { id, name, kind: 'live' | 'movie' }
    this.kind = 'live';
    this.mp = null;
    this.muted = true;
    this.volume = 1.0;

    this.el = document.createElement('div');
    this.el.className = 'player';
    this.el.dataset.num = String(num);
    this.el.innerHTML = `
      <video playsinline muted></video>
      <div class="status"></div>
      <div class="badge"><span class="num">${num}</span><span class="label"></span></div>
      <div class="vol-overlay">
        <span class="vol-icon">🔊</span>
        <input class="vol-slider" type="range" min="0" max="1" step="0.05" value="1">
      </div>
      <div class="film-bar">
        <button class="fb-play" title="Play / pause">⏸</button>
        <input class="fb-seek" type="range" min="0" max="1000" step="1" value="0" />
        <span class="fb-time">0:00 / 0:00</span>
      </div>
      <div class="search"></div>`;

    this.video = this.el.querySelector('video');
    this.statusEl = this.el.querySelector('.status');
    this.labelEl = this.el.querySelector('.badge .label');
    this.volSlider = this.el.querySelector('.vol-slider');
    this.volIcon = this.el.querySelector('.vol-icon');
    this.fbPlay = this.el.querySelector('.fb-play');
    this.fbSeek = this.el.querySelector('.fb-seek');
    this.fbTime = this.el.querySelector('.fb-time');

    // Film transport. Remuxed films have no seekable timeline of their own —
    // seeking restarts the ffmpeg stream at an offset — so both film modes get
    // the same bar rather than native controls that would behave differently.
    this._remuxOffset = 0;
    this._scrubbing = false;
    this.fbPlay.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.video.paused) this.video.play()?.catch(() => {});
      else this.video.pause();
      this._syncFilmBar();
    });
    this.fbSeek.addEventListener('mousedown', (e) => e.stopPropagation());
    this.fbSeek.addEventListener('input', () => {
      this._scrubbing = true;
      this._renderFilmTime(Number(this.fbSeek.value));
    });
    this.fbSeek.addEventListener('change', () => {
      this._scrubbing = false;
      this._seekFilm(Number(this.fbSeek.value));
    });
    this.video.addEventListener('timeupdate', () => {
      this._syncFilmBar();
      this._reportProgress();
    });
    this.video.addEventListener('play', () => this._syncFilmBar());
    this.video.addEventListener('pause', () => {
      this._syncFilmBar();
      this._reportProgress(true); // pausing is exactly when to save the point
    });

    this.volSlider.addEventListener('input', (e) => {
      this.setVolume(parseFloat(e.target.value));
    });
    // Prevent slider interactions from bubbling to the player mousedown focus handler.
    this.volSlider.addEventListener('mousedown', (e) => e.stopPropagation());

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

    // Stuck-stream watchdog state.
    this._lastTime = 0;
    this._lastProgressAt = 0;
    this._loadStartedAt = 0;
    this._started = false; // has this stream ever produced a frame?
    this._errorCount = 0;
    this._stuckReloads = 0;
    this._reloadAt = 0;
    this._watchdog = setInterval(() => this._tick(), WATCHDOG_MS);

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
    this.saveProgress(); // capture where the outgoing film got to
    this.channel = { ...channel, kind: 'live' };
    this.kind = 'live';
    this._errorCount = 0;
    this._stuckReloads = 0;
    this.closeSearch();
    this._updateBadge();
    this._loadStream(channel.id);
  }

  // Films play through the browser's own MP4 support: `direct` streams the file
  // as-is, `remux` streams it through ffmpeg because the source is MKV or AVI.
  // `startAt` resumes a part-watched film; the two modes reach the offset by
  // different routes, so _loadMovie owns that difference.
  setMovie(movie, playback = {}, { startAt = 0 } = {}) {
    this.saveProgress(); // ...including when one film replaces another
    this.channel = {
      id: movie.id,
      name: movie.title || movie.name,
      kind: 'movie',
      mode: playback.mode === 'remux' ? 'remux' : 'direct',
      durationSecs: movie.durationSecs || playback.durationSecs || null,
      poster: movie.poster || '',
    };
    this.kind = 'movie';
    this._errorCount = 0;
    this._stuckReloads = 0;
    this._remuxOffset = 0;
    this._lastReport = 0;
    this.closeSearch();
    this._updateBadge();
    this._loadMovie(this.channel.id, startAt);
  }

  _loadMovie(id, offset = 0) {
    this._destroyMp();
    this._remuxOffset = offset;
    const remux = this.channel?.mode === 'remux';
    this.el.classList.add('is-loading', 'is-movie');
    this.el.classList.toggle('is-remux', remux);
    this.el.classList.remove('is-error');
    this.statusEl.textContent = remux ? 'Remuxing…' : 'Loading film…';
    this._started = false;

    const video = this.video;
    // Our own bar drives both modes; native controls would offer a timeline
    // that can't work for a remuxed stream.
    video.controls = false;
    video.src = remux
      ? `/api/stream/movie/${id}/remux?t=${Math.floor(offset)}`
      : `/api/stream/movie/${id}`;
    video.load();

    // A remuxed stream already starts at the offset; a direct one has the whole
    // file, so seek once the browser knows how long it is.
    if (!remux && offset > 0) {
      video.addEventListener(
        'loadedmetadata',
        () => {
          try {
            video.currentTime = offset;
          } catch {
            /* seek unavailable — playback just starts from the beginning */
          }
        },
        { once: true }
      );
    }

    video.addEventListener(
      'playing',
      () => {
        this.el.classList.remove('is-loading', 'is-error');
        this.statusEl.textContent = '';
        this._started = true;
      },
      { once: true }
    );
    video.addEventListener(
      'error',
      () => {
        if (this.kind !== 'movie') return;
        this._fail('Could not play this film');
      },
      { once: true }
    );

    const p = video.play();
    if (p && p.catch) p.catch(() => {}); // autoplay rejection is fine; controls are up
    this._applyMute();
    this._syncFilmBar();
  }

  // -- film transport ------------------------------------------------------
  // Total runtime comes from the film's metadata; for a direct stream the
  // element's own duration is better, but a remuxed stream doesn't have one.
  _filmDuration() {
    const v = this.video;
    if (this.channel?.mode !== 'remux' && Number.isFinite(v.duration) && v.duration > 0) {
      return v.duration;
    }
    return this.channel?.durationSecs || 0;
  }

  _filmPosition() {
    const t = this.video.currentTime || 0;
    return this.channel?.mode === 'remux' ? this._remuxOffset + t : t;
  }

  _syncFilmBar() {
    if (this.kind !== 'movie') return;
    this.fbPlay.textContent = this.video.paused ? '▶' : '⏸';
    if (this._scrubbing) return;
    const dur = this._filmDuration();
    const pos = this._filmPosition();
    this.fbSeek.max = String(Math.max(1, Math.floor(dur)));
    this.fbSeek.value = String(Math.floor(pos));
    this._renderFilmTime(pos);
  }

  _renderFilmTime(pos) {
    this.fbTime.textContent = `${fmtTime(pos)} / ${fmtTime(this._filmDuration())}`;
  }

  // Report where we are every few seconds so the resume point survives a tab
  // close. Forced on pause and when the film is swapped out.
  _reportProgress(force = false) {
    if (this.kind !== 'movie' || !this.channel || !this.onProgress) return;
    const now = Date.now();
    if (!force && now - (this._lastReport || 0) < 5000) return;
    this._lastReport = now;
    this.onProgress({
      id: this.channel.id,
      title: this.channel.name,
      poster: this.channel.poster,
      mode: this.channel.mode,
      durationSecs: this._filmDuration() || this.channel.durationSecs,
      position: this._filmPosition(),
    });
  }

  _seekFilm(seconds) {
    if (this.kind !== 'movie') return;
    const dur = this._filmDuration();
    const target = Math.max(0, Math.min(seconds, dur ? dur - 1 : seconds));
    if (this.channel.mode === 'remux') {
      // No byte ranges to seek within — restart ffmpeg at the new offset. The
      // old process dies when the browser drops the previous request.
      this._loadMovie(this.channel.id, target);
    } else {
      this.video.currentTime = target;
    }
  }

  _updateBadge() {
    this.labelEl.textContent = this.channel ? this.channel.name : '(no channel)';
  }

  _loadStream(streamId) {
    this._destroyMp();
    // Coming back from a film: drop the native source and controls, or mpegts
    // would be attaching to an element that's still playing an MP4.
    this.video.removeAttribute('src');
    this.video.controls = false;
    this.video.load();
    this.el.classList.remove('is-movie', 'is-remux');
    this.el.classList.add('is-loading');
    this.el.classList.remove('is-error');
    this.statusEl.textContent = 'Loading…';
    this._lastTime = 0;
    this._lastProgressAt = Date.now();
    this._loadStartedAt = Date.now();
    this._started = false;

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
      this._onError(`${type}${detail ? ': ' + detail : ''}`);
    });
    this.video.addEventListener(
      'playing',
      () => {
        this.el.classList.remove('is-loading', 'is-error');
        this.statusEl.textContent = '';
        this._lastProgressAt = Date.now();
        this._started = true;
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

  // Watchdog: a live stream that freezes often emits no error — currentTime
  // just stops advancing. Detect that and restart the stream.
  _tick() {
    // Films are on-demand: pausing and seeking are normal, and a restart would
    // throw the viewer back to the start. The watchdog is for live only.
    if (this.kind === 'movie') return;
    if (!this.channel || !this.mp) return;
    const v = this.video;
    const now = Date.now();

    if (v.currentTime > this._lastTime + 0.1) {
      // Healthy: playback is progressing.
      this._lastTime = v.currentTime;
      this._lastProgressAt = now;
      this._started = true;
      this._errorCount = 0;
      this._stuckReloads = 0;
      if (this.el.classList.contains('is-loading')) {
        this.el.classList.remove('is-loading');
        this.statusEl.textContent = '';
      }
      return;
    }

    if (v.paused) return;

    // Before the first frame the stream is still connecting/buffering — be
    // patient (the stash buffer can take several seconds). Only restart if it
    // never starts at all after a generous failsafe; otherwise let mpegts'
    // own error handling deal with load failures.
    if (!this._started) {
      const loadingFor = now - this._loadStartedAt;
      if (loadingFor > INITIAL_LOAD_TIMEOUT && now - this._reloadAt > RELOAD_COOLDOWN) {
        if (this._stuckReloads >= MAX_STUCK_RELOADS) {
          this._fail('Stream unavailable');
          return;
        }
        this._stuckReloads++;
        this._reload('never started');
      }
      return;
    }

    // Was playing, now frozen.
    const stalled = now - this._lastProgressAt;
    if (stalled > STUCK_MS && now - this._reloadAt > RELOAD_COOLDOWN) {
      if (this._stuckReloads >= MAX_STUCK_RELOADS) {
        this._fail('Stream unavailable');
        return;
      }
      this._stuckReloads++;
      this._reload(`stuck ${Math.round(stalled / 1000)}s`);
    } else if (stalled > STUCK_MS * 0.5) {
      this.el.classList.add('is-loading');
      this.statusEl.textContent = 'Reconnecting…';
    }
  }

  _reload(reason) {
    if (!this.channel) return;
    this._reloadAt = Date.now();
    console.warn(`[player ${this.num}] auto-restart (${reason})`);
    this._loadStream(this.channel.id);
  }

  _onError(msg) {
    this._errorCount++;
    if (this._errorCount > MAX_ERROR_RETRIES) {
      this._fail(`Stream error: ${msg}`);
      return;
    }
    console.warn(`[player ${this.num}] stream error ${this._errorCount}/${MAX_ERROR_RETRIES}: ${msg}`);
    this.el.classList.remove('is-error');
    this.el.classList.add('is-loading');
    this.statusEl.textContent = 'Reconnecting…';
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._reload(`error: ${msg}`), ERROR_RETRY_DELAY);
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

  // allowAudio is false until the user has interacted with the page — browsers
  // block (and pause) unmuted autoplay without a gesture, so we keep everything
  // muted on load and unmute the focused player on the first click/keypress.
  setFocused(focused, multi, allowAudio = true) {
    this.el.classList.toggle('focused', focused);
    this.el.classList.toggle('multi', multi);
    // Single player is audible; with two, only the focused one — but never
    // before a user gesture.
    this.muted = allowAudio ? (multi ? !focused : false) : true;
    this._applyMute();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.volSlider.value = String(this.volume);
    const icon = this.volume === 0 ? '🔇' : this.volume < 0.4 ? '🔈' : this.volume < 0.7 ? '🔉' : '🔊';
    this.volIcon.textContent = icon;
    this._applyMute();
  }

  _applyMute() {
    this.video.muted = this.muted;
    this.video.volume = this.volume;
    // Ensure the element is actually playing (muted autoplay is always allowed;
    // a previous unmute attempt may have left it paused). Never for a film —
    // the viewer may have paused it deliberately.
    if (this.video.paused && this.kind !== 'movie') {
      const p = this.video.play?.();
      if (p && p.catch) p.catch(() => {});
    }
  }

  setShowInfo(show) {
    this.el.classList.toggle('show-info', show);
  }

  // Re-number this player (used when swapping screen positions). The mpegts
  // stream stays attached — only the badge label changes.
  setNum(n) {
    this.num = n;
    this.el.dataset.num = String(n);
    const numEl = this.el.querySelector('.badge .num');
    if (numEl) numEl.textContent = String(n);
  }

  // Flush the resume point now, whatever the throttle says.
  saveProgress() {
    this._reportProgress(true);
  }

  destroy() {
    this.saveProgress();
    clearInterval(this._watchdog);
    clearTimeout(this._retryTimer);
    this._destroyMp();
    this.el.remove();
  }
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
