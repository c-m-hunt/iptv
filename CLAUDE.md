# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
# Local dev (Node, no Docker) — from webui/
make dev           # installs deps and starts on http://localhost:8090

# Docker
make build
make run           # reads creds from webui/.env
make run LS_DB="$HOME/Library/Application Support/<App>/Local Storage/file__0.localstorage"
```

There are no tests and no lint step. The frontend is vanilla JS ES modules served as static files — no build step.

## Configuration

Copy `webui/.env.example` to `webui/.env`. Two credential sources (first wins):

1. `IPTV_USERNAME` / `IPTV_PASSWORD` / `IPTV_LOGIN_URL` / `IPTV_SERVER` env vars
2. `IPTV_LS_DB` pointing at a desktop IPTV app's `file__0.localstorage` (SQLite, read via `sqlite3` CLI)

The server is Xtream Codes compatible. `IPTV_LOGIN_URL` hosts `player_api.php`; `IPTV_SERVER` hosts the streams.

## Architecture

```
webui/
  server/          Node/Express (CommonJS)
    index.js       Express routes + static host
    iptv.js        Credentials, catalogue fetch/cache, stream proxy
    vod.js         Film catalogue: fetch/cache, search, detail, container probe
    remux.js       ffmpeg container swap for MKV/AVI films (fMP4 on stdout)
  public/          Static frontend (ES modules, no bundler)
    js/
      app.js       App class — orchestrates all state, layout, players, controls
      player.js    Player class — one <video> tile: mpegts.js, watchdog, search overlay, volume
      layout.js    Pure geometry — computes % rects for the 3 layout modes
      search.js    SearchController — debounced channel search overlay per player
      presets.js   Presets — save/load setups in localStorage, slide-in panel
      profile.js   Profile — account/subscription panel (expiry, connections)
      films.js     Films — browse/search overlay, detail view, play
      shortcuts.js Global keyboard handler — delegates to App methods
    css/styles.css Single stylesheet for everything
```

### Key data flows

**Stream playback**: browser → `GET /api/stream/live/:id` → server proxies to Xtream provider (follows redirects, hides credentials) → mpegts.js demuxes the MPEG-TS in a Worker.

**Channel search**: `SearchController` debounces calls to `GET /api/channels?q=` → server AND-filters the in-memory catalogue (refreshed every 6h from `player_api.php`).

**Film lookup**: `GET /api/movies` filters the cached VOD catalogue (~21k films,
refreshed every 6h). The portal's own `&search=` is ignored by the server, and
there is no year field — the year is parsed out of the title (`"Love (2015)"`),
with `get_vod_info` supplying a real `releasedate` on the detail view.

**Film playback**: `container_extension` is `"vod"` for every film and means
nothing; the real files are a mix of MP4, MKV and AVI. `probeMovie()` sniffs the
first bytes and returns a `mode`:

| `mode` | Meaning |
|---|---|
| `direct` | MP4/H.264 — streamed as-is, seekable by byte range |
| `remux` | MKV/AVI — piped through ffmpeg (`server/remux.js`) |
| `unsupported` | Not MP4 and no ffmpeg on the server |

Video is H.264 across the catalogue, so a remux copies the video stream and only
re-encodes audio when it isn't already AAC (AC3/EAC3 → AAC stereo). Output is
fragmented MP4 on ffmpeg's stdout, ~100x realtime.

**Film seeking**: a piped fMP4 has no byte ranges, so remuxed films seek by
restarting ffmpeg at `?t=<seconds>` and offsetting the displayed position by it.
Both modes share one `.film-bar` transport in `player.js` (native controls would
offer a timeline that can't work for a remuxed stream). Runtime comes from
`get_vod_info`, so the scrub bar spans the whole film from the first frame.
Every live ffmpeg holds one of the account's limited connections, so the process
is SIGKILLed as soon as the client disconnects.

**Layout**: `computeLayout(mode, split)` in `layout.js` returns `{ rects, handle }` in percent units. Three modes: `horizontal` (side-by-side, vertical drag handle), `diag-tlbr` / `diag-bltr` (large + overlapping inset, point drag handle). `App.render()` calls this and positions players via `applyRect()`.

**Audio**: all videos start muted. `_canUnmute` becomes true on the first user gesture. In multi-player mode only the focused player is unmuted. Volume (`player.volume`, 0–1) is independent of muted state and persists across focus changes.

**Watchdog**: each `Player` runs a `setInterval` every 2s to detect frozen streams (currentTime not advancing). After 8s stuck → auto-restart. Gives up after 6 fruitless restarts.

### Layout modes

| `layoutMode` | Description |
|---|---|
| `horizontal` | Players split side-by-side at `split.x` |
| `diag-tlbr` | Player 1 large top-left, player 2 small bottom-right inset |
| `diag-bltr` | Player 1 large bottom-left, player 2 small top-right inset |

### Keyboard shortcuts

`F` fullscreen · `← → ↑ ↓` resize split · `D` info badge · `1 / 2` focus/search · `X` swap · `C` pin toolbar · `P` presets · `S` + `1–9` save preset · `+ / −` volume · `A` profile · `M` films · `?` help
