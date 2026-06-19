# IPTV Player Grid

A single-tab web UI for arranging one or two live IPTV players, full-screening
them, and overlaying **2026 FIFA World Cup** live scores & group standings in the
empty corners of a diagonal layout.

Built on the same invictusdedi.com IPTV catalogue that `../winx_find.sh`
uses. Live channels only.

```
webui/
  server/      Node + Express API (credentials, catalogue, stream proxy, World Cup)
  public/      Frontend (no credentials ever reach the browser)
  Dockerfile   Containerised app (API + static frontend)
  Makefile     build / run / dev helpers
```

## Quick start (local, no Docker)

```bash
cd webui
make dev          # installs deps, starts on http://localhost:8090
```

On a Mac with the IPTV player app installed, credentials are read automatically
from its localStorage (via `sqlite3`, exactly like `winx_find.sh`). Otherwise set
`IPTV_USERNAME` / `IPTV_PASSWORD` (see `.env.example`).

## Run in Docker

```bash
cd webui
make run           # builds the image and starts the container
# open http://localhost:8090
```

`make run` resolves credentials in this order:

1. **Mounted creds file** — if the IPTV app's localStorage file exists on the host
   (default macOS path), it's copied to `.iptv-creds.localstorage` and mounted
   read-only into the container. Override the path:
   ```bash
   make run LS_DB=/some/other/file__0.localstorage
   ```
2. **`.env` overrides** — if there's no creds file, `make run` passes `--env-file .env`:
   ```bash
   cp .env.example .env && $EDITOR .env
   make run
   ```

Environment variables always take precedence over the mounted file.

Other targets: `make build`, `make logs`, `make stop`, `make clean`,
`make clean-cache` (drops the cached catalogue volume).

## Using it

- Opens with **one player** showing a centred search box — type to filter the
  live catalogue, ↑/↓ to move, Enter/click to play.
- **+ Player** adds a second player. Cycle the arrangement with **Layout**:
  horizontal, diagonal ↖↘, diagonal ↙↗.
- Drag the handle between players to change proportions. In diagonal layouts the
  two empty corners hold the World Cup panels.

### Shortcuts

| Key | Action |
| --- | --- |
| `F` | Toggle fullscreen |
| `← / →` | Adjust split proportion (`↑ / ↓` too, in diagonal) |
| `D` | Toggle player # / channel info overlay |
| `1` / `2` | Focus a player and (re)open its channel search |
| `L` | Toggle World Cup live scores & standings (diagonal only) |
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
- **World Cup data**: ESPN's free, no-key site API, proxied at `/api/worldcup`
  and cached ~30s. If it changes or goes down during the tournament, swap the
  URLs in `server/worldcup.js` or move to
  [football-data.org](https://www.football-data.org/) (free tier needs an API key).

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | `{ ok, credentials }` |
| `GET /api/channels?q=sky+sports` | Live channels matching ALL words: `[{ id, name }]` |
| `GET /api/stream/live/:id` | Proxied `.ts` live stream |
| `GET /api/worldcup` | `{ matches, groups, errors, fetchedAt }` |
| `GET /api/refresh` | Force-refresh the catalogue cache |
