# IPTV Player Grid

A single-tab web UI for arranging one or two live IPTV players, full-screening
them, and overlaying **2026 FIFA World Cup** live scores & group standings in the
empty corners of a diagonal layout.

Works with any **Xtream Codes** compatible IPTV provider. Live channels only.
Nothing provider-specific is hardcoded — configure it via `.env`.

```
webui/
  server/      Node + Express API (credentials, catalogue, stream proxy, World Cup)
  public/      Frontend (no credentials ever reach the browser)
  Dockerfile   Containerised app (API + static frontend)
  Makefile     build / run / dev helpers
```

## Configure

Copy `.env.example` to `.env` (gitignored) and fill in your provider:

```bash
cd webui
cp .env.example .env && $EDITOR .env   # IPTV_USERNAME / PASSWORD / LOGIN_URL / SERVER
```

Alternatively, if you use a desktop IPTV app that stores an Xtream "profile" in
its localStorage, point `IPTV_LS_DB` at its `file__0.localstorage` and the
credentials are read from there (via `sqlite3`) — no need to set the others.

## Quick start (local, no Docker)

```bash
cd webui
make dev          # installs deps, starts on http://localhost:8090
```

## Run in Docker

```bash
cd webui
make run           # builds the image and starts the container
# open http://localhost:8090
```

`make run` resolves credentials in this order:

1. **`.env`** — passed to the container via `--env-file .env` (the default).
2. **Mounted localStorage** — if you pass `LS_DB=/path/to/file__0.localstorage`,
   it's copied to `.iptv-creds.localstorage` and mounted read-only:
   ```bash
   make run LS_DB="$HOME/Library/Application Support/<YourApp>/Local Storage/file__0.localstorage"
   ```

Other targets: `make build`, `make logs`, `make stop`, `make clean`,
`make clean-cache` (drops the cached catalogue volume).

## Using it

- Opens with **one player** showing a centred search box — type to filter the
  live catalogue, ↑/↓ to move, Enter/click to play.
- **+ Player** adds a second player. Cycle the arrangement with **Layout**:
  horizontal, diagonal ↖↘, diagonal ↙↗.
- Drag the handle between players to change proportions.
- **Profile** shows the subscription: expiry date and days left, connections in
  use, and portal details.
- **Films** browses the ~21k VOD catalogue by search, category and sort, with
  posters, plot, cast and ratings. Play loads the film into the focused player
  with a seek bar.
- **Continue watching** remembers where you got to in the last 30 films and
  offers them as a row at the top of the browser — click one to pick it up, or
  hover and press **×** to drop it from the list. The detail view offers both
  *Resume* and *Play from start*.

### Shortcuts

| Key | Action |
| --- | --- |
| `F` | Toggle fullscreen |
| `← / →` | Adjust split proportion (`↑ / ↓` too, in diagonal) |
| `D` | Toggle player # / channel info overlay |
| `1` / `2` | Focus a player and (re)open its channel search |
| `A` | Toggle the profile panel (subscription / expiry) |
| `M` | Toggle the film browser |
| `?` | Toggle the help panel |

Only the **focused** player plays audio (click a player or press its number to
switch). Anything not covered by a video is black.

## How it works

- **Live playback**: IPTV live streams are MPEG-TS, which browsers can't play
  natively, so the frontend uses [mpegts.js](https://github.com/xqq/mpegts.js)
  (vendored in `public/vendor/`). The server proxies the `.ts` stream at
  `/api/stream/live/:id` so credentials stay server-side and CORS is avoided.
- **Catalogue**: fetched from the Xtream `player_api.php` endpoint and cached for
  6h under `~/.cache/iptv` (override with `CACHE_DIR`).
- **Films**: the catalogue (~21k) is cached like the live one. The portal has no
  working search (`&search=` returns everything) and no year field — the year is
  parsed from the title, and `get_vod_info` provides the real release date on the
  detail view. `container_extension` is `"vod"` for every film regardless of what
  the file actually is, so the first bytes are sniffed to tell MP4 from MKV/AVI.
  MP4/H.264 plays natively and seeks by byte range; MKV and AVI are remuxed
  through ffmpeg on the fly (video copied, audio converted only if it isn't
  AAC). Remuxed films seek by restarting the stream at an offset, so both cases
  get a working scrub bar. Without ffmpeg installed the app still runs — the
  non-MP4 films just say so instead of offering Play.
- **Account / profile**: the bare `player_api.php` call (no `action`) is the
  Xtream auth endpoint and returns `user_info` + `server_info` — expiry,
  connection limits, portal details. The server strips the password the provider
  echoes back, and cache-busts the request: the portal sits behind an HTTP cache
  that otherwise replays a stale response, freezing the live connection count.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | `{ ok, credentials }` |
| `GET /api/channels?q=sky+sports` | Live channels matching ALL words: `[{ id, name }]` |
| `GET /api/stream/live/:id` | Proxied `.ts` live stream |
| `GET /api/account` | `{ user, server, fetchedAt }` — subscription info, never the password |
| `GET /api/movies?q=&category=&sort=` | `{ total, items }` — film catalogue search |
| `GET /api/movies/categories` | `[{ id, name, count }]` |
| `GET /api/movies/:id` | Full film metadata (plot, cast, genre, year…) |
| `GET /api/movies/:id/playback` | `{ container, mode, reason, size, ffmpeg }` — `mode` is `direct`, `remux` or `unsupported` |
| `GET /api/stream/movie/:id` | Proxied film, byte-range capable |
| `GET /api/stream/movie/:id/remux?t=` | MKV/AVI remuxed to fMP4, starting at `t` seconds |
| `GET /api/poster?u=` | Proxied poster image |
| `GET /api/refresh` | Force-refresh the catalogue cache |
