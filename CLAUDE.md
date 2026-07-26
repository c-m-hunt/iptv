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
    catchup.js     Archive-capable channels, their EPG, timeshift URLs
    series.js      TV series catalogue: shows, seasons, episodes
    remote.js      Phone remote: pairing, QR, LAN address ranking, WS relay
  public/          Static frontend (ES modules, no bundler)
    js/
      app.js       App class — orchestrates all state, layout, players, controls
      player.js    Player class — one <video> tile: mpegts.js, watchdog, search overlay, volume
      layout.js    Pure geometry — computes % rects for the 3 layout modes
      search.js    SearchController — debounced channel search overlay per player
      presets.js   Presets — save/load setups in localStorage, slide-in panel
      profile.js   Profile — account/subscription panel (expiry, connections)
      films.js     Films — browse/search overlay, detail view, play
      history.js   WatchHistory — recently played films + resume points
      catchup.js   Catch Up — channel list + EPG guide for the last 5–14 days
      series.js    Series — browse/search shows, seasons, episodes
      remote-link.js  Registers this screen, runs remote commands, reports state
  public/remote/   Phone remote-control UI (separate page, no <video> at all)
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

**Series**: `get_series` already carries plot, cast, genre, rating and artwork,
so the browse grid needs no per-show lookup — only `get_series_info` (seasons +
episodes) does. Episodes are ordinary VOD files at `/series/<user>/<pass>/<id>`,
so they reuse `vod.probeStream()` and the same direct/remux split as films;
`Player.setMovie()` takes `type: 'episode'` and swaps the stream base.

**Catch-up TV**: 137 of ~8,500 live channels carry `tv_archive` with 5–14 days
of history (mostly the UK terrestrials). `get_simple_data_table&stream_id=`
returns that channel's EPG with base64 title/description and a `has_archive`
flag; the server filters to programmes that have finished and are still inside
the window. Playback is `/streaming/timeshift.php?start=&duration=`, which
returns MPEG-TS — so catch-up goes through mpegts.js like live, not the film
path. Seeking asks for a later `start`, the same restart trick the remuxed films
use, and `Player` shares one transport bar across all on-demand modes
(`.player.on-demand`).

Times in timeshift URLs are in the **portal's** timezone, taken from
`server_info.timezone`, never the server's local zone — in Docker that's UTC and
you'd silently fetch the wrong hour.

**Continue watching**: `Player` reports its position every 5s (and on pause,
film swap, destroy and `pagehide`) to `WatchHistory`, which keeps the last 30
films and episodes in localStorage. Entries are keyed by `(id, type)` — films
and episodes come from different id spaces and would otherwise collide — and
episodes carry show/season/episode so the row can label them. Film entries store
the playback mode so resuming skips the probe; episodes re-probe via
`playEpisode()`. `applySetup()` restores a film via `history.resumeAt(id)` — restoring
at 0 would replay from the start and overwrite the saved point.

**Phone remote**: a phone can't reach the desktop browser directly (browsers take
no inbound connections), so the server relays: `phone → server → screen`, with
state flowing back. The phone is a **control surface only** — it never receives
video.

Each open tab registers a screen id from `crypto.randomUUID()` kept in
**sessionStorage**, so a reload keeps controlling the same screen but a second tab
is correctly a second screen. Pressing Remote (`R`) issues a fresh token and
returns a QR; the token lives in the URL **fragment**, which browsers never send
to a server, keeping it out of access logs and `Referer`.

WebSocket, not SSE: each streaming player already holds one of the browser's ~6
HTTP/1.1 connections per origin, so two screens running two players each would
exhaust the budget and stall artwork and API calls.

Commands are an explicit table in `remote-link.js` mapped onto `App` methods —
never a dispatched string. State is polled once a second and sent only when it
changes, and carries a trimmed watch history: continue-watching lives in the
screen's localStorage, so the phone can only see it if the screen sends it.

The phone's browse tabs (live, films, series, catch-up) read the same REST API
the desktop uses — the phone is on the same server — so a picker is UI only and
adds nothing server-side.

Two things worth knowing:
* **Fullscreen can't be entered remotely.** `requestFullscreen()` needs transient
  user activation, and a network message isn't one — verified: it throws
  "Permissions check failed". `exitFullscreen()` *is* allowed, so the remote can
  leave but not enter. Audio/unmute only needs *sticky* activation, so it works.
* **"The network IP" isn't one answer.** This machine reports a Wi-Fi address, a
  VM bridge and a VPN tunnel; only the first is reachable from a phone.
  `lanCandidates()` ranks physical interfaces up and bridges/tunnels down, and the
  pairing dialog offers the runners-up (plus the mDNS `.local` name) when the
  first doesn't work. In Docker, set `REMOTE_HOST` to the host's LAN address.

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

`Space` pause/resume film · `F` fullscreen · `← → ↑ ↓` resize split · `D` info badge · `1 / 2` focus/search · `X` swap · `C` pin toolbar · `P` presets · `S` + `1–9` save preset · `+ / −` volume · `A` profile · `M` films · `V` series · `T` catch-up · `R` remote · `?` help
