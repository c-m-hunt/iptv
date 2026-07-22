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
    worldcup.js    ESPN live scores + standings (server-side fetch, 30s cache)
  public/          Static frontend (ES modules, no bundler)
    js/
      app.js       App class — orchestrates all state, layout, players, controls
      player.js    Player class — one <video> tile: mpegts.js, watchdog, search overlay, volume
      layout.js    Pure geometry — computes % rects for the 3 layout modes
      live.js      LivePanels class — World Cup corner panels, polling, rotation
      search.js    SearchController — debounced channel search overlay per player
      presets.js   Presets — save/load setups in localStorage, slide-in panel
      shortcuts.js Global keyboard handler — delegates to App methods
    css/styles.css Single stylesheet for everything
```

### Key data flows

**Stream playback**: browser → `GET /api/stream/live/:id` → server proxies to Xtream provider (follows redirects, hides credentials) → mpegts.js demuxes the MPEG-TS in a Worker.

**Channel search**: `SearchController` debounces calls to `GET /api/channels?q=` → server AND-filters the in-memory catalogue (refreshed every 6h from `player_api.php`).

**Layout**: `computeLayout(mode, split, dataOn)` in `layout.js` returns `{ rects, handle, corners }` in percent units. Three modes: `horizontal` (side-by-side, vertical drag handle), `diag-tlbr` / `diag-bltr` (large + overlapping inset, point drag handle + World Cup corner panels). `App.render()` calls this and positions players via `applyRect()`.

**Audio**: all videos start muted. `_canUnmute` becomes true on the first user gesture. In multi-player mode only the focused player is unmuted. Volume (`player.volume`, 0–1) is independent of muted state and persists across focus changes.

**World Cup panels**: only appear in diagonal modes, in the two corners not occupied by video. `LivePanels` polls `/api/worldcup` (ESPN public API, proxied server-side) every 60s, auto-rotates groups every 8s prioritising live groups, and overlays in-progress scores on the standings ("live table").

**Watchdog**: each `Player` runs a `setInterval` every 2s to detect frozen streams (currentTime not advancing). After 8s stuck → auto-restart. Gives up after 6 fruitless restarts.

### Layout modes

| `layoutMode` | Description |
|---|---|
| `horizontal` | Players split side-by-side at `split.x` |
| `diag-tlbr` | Player 1 large top-left, player 2 small bottom-right inset |
| `diag-bltr` | Player 1 large bottom-left, player 2 small top-right inset |

### Keyboard shortcuts

`F` fullscreen · `← → ↑ ↓` resize split · `D` info badge · `1 / 2` focus/search · `X` swap · `L` live panels · `C` pin toolbar · `P` presets · `S` + `1–9` save preset · `+ / −` volume · `?` help
