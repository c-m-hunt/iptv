# IPTV Player Grid

A single-tab web UI for arranging one or two IPTV players and full-screening
them: live TV, films, TV series and catch-up, with a phone remote for driving it
all from the sofa.

Works with any **Xtream Codes** compatible IPTV provider. Nothing
provider-specific is hardcoded — configure it via `.env`.

```
webui/
  server/      Node + Express API (credentials, catalogue, stream proxy, remote)
  public/      Frontend (no credentials ever reach the browser)
  public/remote/  Phone remote-control UI
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
- **Series** browses 6,500 TV shows with seasons and episodes, plot, cast and
  ratings. Episodes remember where you got to, shown inline in the episode list.
- **Catch Up** replays the last 5–14 days from the 137 archive-capable channels
  (BBC, ITV, Channel 4/5 and similar): pick a channel, pick a programme from the
  guide, watch it with a working scrub bar.
- **Remote control** — press **Remote** (or `R`) for a QR code, scan it with your
  phone, and drive that screen from your hand: play/pause, seek, volume, focus,
  layout, split, presets — plus browse tabs for live channels, films, series and
  catch-up, and a continue-watching list, so you can pick what plays next from
  your hand. The phone shows controls only; the picture stays on the main screen. Fullscreen has to be started on the screen itself (browsers refuse
  it remotely) but the remote can leave it.
- **Continue watching** remembers where you got to in the last 30 films and
  offers them as a row at the top of the browser — click one to pick it up, or
  hover and press **×** to drop it from the list. The detail view offers both
  *Resume* and *Play from start*.

### Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Pause / resume the focused film (films only) |
| `F` | Toggle fullscreen |
| `← / →` | Adjust split proportion (`↑ / ↓` too, in diagonal) |
| `D` | Toggle player # / channel info overlay |
| `1` / `2` | Focus a player and (re)open its channel search |
| `A` | Toggle the profile panel (subscription / expiry) |
| `M` | Toggle the film browser |
| `R` | Remote-control QR for this screen |
| `V` | Toggle the series browser |
| `T` | Toggle the catch-up guide |
| `Esc` | Close the open browser/guide/panel — stays in fullscreen (hold `Esc` to leave fullscreen) |
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
- **Remote control**: a phone can't connect to a browser directly, so the server
  relays commands to the screen and state back. WebSocket rather than SSE, because
  a streaming player already uses one of the browser's ~6 HTTP/1.1 connections per
  origin. Pairing tokens travel in the URL fragment, which is never sent to a
  server. `lanCandidates()` ranks addresses (physical interfaces up, VM bridges and
  VPN tunnels down) since a machine usually has several and only some are reachable
  from a phone — set `REMOTE_HOST` when running in Docker.
- **Series**: `get_series` carries enough metadata for the browse grid on its
  own; `get_series_info` adds seasons and episodes. Episodes are VOD files, so
  they share the film probe and the direct/remux playback split.
- **Catch-up**: live channels advertise `tv_archive` and `tv_archive_duration`;
  only 137 here have it. Programmes come from the channel's EPG (base64 titles,
  `has_archive` per listing) and play via `timeshift.php` as MPEG-TS. Start times
  are formatted in the portal's own timezone, not the server's.
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
| `GET /api/series?q=&category=&sort=` | `{ total, items }` — series catalogue |
| `GET /api/series/categories` | `[{ id, name, count }]` |
| `GET /api/series/:id` | Show metadata plus seasons and episodes |
| `GET /api/episodes/:id/playback` | `{ container, mode, reason, ... }` |
| `GET /api/stream/episode/:id[/remux?t=]` | Proxied / remuxed episode |
| `GET /api/catchup/channels?q=` | Archive-capable channels: `[{ id, name, icon, days }]` |
| `GET /api/catchup/:id/epg` | Programmes still inside the archive window |
| `GET /api/stream/catchup/:id?start=&duration=` | Proxied archive stream (MPEG-TS) |
| `GET /api/poster?u=` | Proxied poster image |
| `GET /api/remote/pair?session=` | `{ url, qrSvg, alternatives }` for the phone |
| `GET /api/remote/screens` | Screens currently available to control |
| `GET /remote` | Phone remote-control UI |
| `WS /ws/screen?s=` · `WS /ws/remote?s=&t=` | Relay between screen and phone |
| `GET /api/refresh` | Force-refresh the catalogue cache |
