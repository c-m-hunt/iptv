// remote-link.js — the desktop half of phone remote control.
//
// Registers this screen with the server, executes commands arriving from a
// paired phone, and reports back what's on screen so the phone can render a
// status line. No video ever leaves here: the phone is a control surface.
//
// Commands are matched against an explicit table below. A phone can only invoke
// what's listed — never an arbitrary method name off the App.

const SESSION_KEY = 'iptv-screen-session';
const STATE_MS = 1000; // how often we look for a change worth reporting
const RECONNECT_MS = 2000;

export class RemoteLink {
  constructor(app) {
    this.app = app;
    this.ws = null;
    this.lastSent = '';
    this.sessionId = this._sessionId();
    this._commands = this._buildCommands();
    this._connect();
    setInterval(() => this._reportState(), STATE_MS);
  }

  // sessionStorage, not localStorage: a reload should keep controlling the same
  // screen, but a second tab is genuinely a second screen.
  _sessionId() {
    let id = null;
    try {
      id = sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()).replace(
          /[^a-zA-Z0-9-]/g,
          ''
        );
        sessionStorage.setItem(SESSION_KEY, id);
      }
    } catch {
      id = 'screen-' + Date.now(); // private mode: still works for this session
    }
    return id;
  }

  // -- socket -------------------------------------------------------------
  _connect() {
    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws/screen?s=${encodeURIComponent(this.sessionId)}`);
    } catch {
      setTimeout(() => this._connect(), RECONNECT_MS);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.lastSent = ''; // force a full state push on (re)connect
      this._reportState();
    });
    ws.addEventListener('message', (e) => this._onMessage(e.data));
    ws.addEventListener('close', () => {
      this.ws = null;
      setTimeout(() => this._connect(), RECONNECT_MS);
    });
    ws.addEventListener('error', () => {
      /* close follows, which schedules the retry */
    });
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || msg.type !== 'cmd') return;
    const fn = this._commands[msg.name];
    if (!fn) {
      this._send({ type: 'ack', name: msg.name, ok: false, error: 'unknown command' });
      return;
    }
    try {
      fn(msg.args || {});
      this._send({ type: 'ack', name: msg.name, ok: true });
      this._reportState(true);
    } catch (err) {
      console.warn('[remote] command failed:', msg.name, err);
      this._send({ type: 'ack', name: msg.name, ok: false, error: String(err.message || err) });
    }
  }

  // -- commands -----------------------------------------------------------
  _buildCommands() {
    const app = this.app;
    const focused = () => app.players.find((p) => p.num === app.focusedNum) || app.players[0];
    const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

    return {
      playPause: () => app.togglePlayPause(),
      seek: ({ position }) => focused()?._seekFilm(num(position)),
      nudge: ({ delta }) => {
        const p = focused();
        if (p && p.isOnDemand()) p._seekFilm(p._filmPosition() + num(delta, 0));
      },
      setVolume: ({ value }) => focused()?.setVolume(num(value, 1)),
      adjustVolume: ({ delta }) => app.adjustVolume(num(delta, 0)),
      mute: ({ muted }) => focused()?.setVolume(muted ? 0 : 1),

      focusPlayer: ({ number }) => app.focusPlayer(num(number, 1)),
      addPlayer: () => app.addPlayer(),
      removePlayer: () => app.removePlayer(),
      swapPlayers: () => app.swapPlayers(),
      cycleLayout: () => app.cycleLayout(),
      setSplit: ({ x, y }) => app.setSplit(num(x, 0.5), num(y, 0.5)),
      toggleInfo: () => app.toggleInfo(),

      // Entering fullscreen needs a user gesture on the desktop itself, which a
      // network message can never be — but leaving it is allowed.
      exitFullscreen: () => app.exitFullscreen(),

      loadPreset: ({ slot }) => app.loadPreset(num(slot, 1)),
      savePreset: ({ slot }) => app.savePresetToSlot(num(slot, 1)),

      // Playback targets, so phase 2's phone browser is UI only.
      playChannel: ({ id, name }) => focused()?.setChannel({ id: num(id), name: String(name || '') }),
      playMovie: ({ film, playback, startAt }) => app.playMovie(film || {}, playback || {}, { startAt: num(startAt) }),
      playEpisode: ({ episode, startAt }) =>
        app.playEpisode(episode || {}, startAt == null ? {} : { startAt: num(startAt) }),
      playCatchup: ({ programme }) => app.playCatchup(programme || {}),
    };
  }

  // -- state --------------------------------------------------------------
  // Polled rather than hooked into every mutation: one small message a second is
  // nothing, and it can't drift out of sync with the real player state.
  _reportState(force = false) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const state = this._snapshot();
    const json = JSON.stringify(state);
    if (!force && json === this.lastSent) return;
    this.lastSent = json;
    this._send({ type: 'state', state });
  }

  _snapshot() {
    const app = this.app;
    return {
      layoutMode: app.effectiveMode,
      split: { x: app.split.x, y: app.split.y },
      focusedNum: app.focusedNum,
      canUnmute: !!app._canUnmute,
      fullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement),
      showInfo: !!app.showInfo,
      presets: app.presets ? app.presets.list?.() || null : null,
      players: app.players.map((p) => {
        const c = p.channel || {};
        const onDemand = p.isOnDemand();
        return {
          num: p.num,
          kind: p.kind,
          type: c.type || null,
          title: c.name || null,
          showName: c.showName || null,
          season: c.season ?? null,
          episode: c.episode ?? null,
          channelName: c.channelName || null,
          onDemand,
          // Rounded: a fractional position would push a message every tick.
          position: onDemand ? Math.floor(p._filmPosition()) : null,
          duration: onDemand ? Math.floor(p._filmDuration()) : null,
          paused: !!p.video.paused,
          volume: Math.round(p.volume * 100) / 100,
          muted: !!p.video.muted,
          loading: p.el.classList.contains('is-loading'),
          error: p.el.classList.contains('is-error'),
        };
      }),
    };
  }
}
