# IPTV Player Grid

A single-tab web UI for watching an **Xtream Codes** IPTV subscription: live TV
in one or two tiles, a film library, TV series with seasons and episodes,
catch-up for the last week of broadcast telly, and a phone remote so you can
drive it all from the sofa.

Nothing provider-specific is hardcoded — point it at your own provider with a
config file, a `.env`, or environment variables. Credentials stay on the server;
the browser only ever talks to this app.

```
webui/
  server/          Node + Express (CommonJS)
    index.js         Routes, static host, artwork proxy
    env.js           Loads .env before anything reads it
    config.js        Optional config.json (lowest-priority settings)
    iptv.js          Credentials, live catalogue, account info, stream proxy
    vod.js           Film catalogue: search, detail, container probe
    series.js        Series catalogue: shows, seasons, episodes
    catchup.js       Archive channels, EPG, timeshift URLs
    remux.js         ffmpeg container swap for files browsers can't open
    remote.js        Phone pairing, QR, LAN address ranking, WebSocket relay
  public/          Frontend — vanilla ES modules, no build step
    js/              App, player, browsers, history, shortcuts
    remote/          Phone remote UI (a separate page, with no video in it)
    vendor/          mpegts.js
  Dockerfile       API + frontend in one image
  Makefile         build / run / dev helpers
```

## Requirements

- **Node 18+** (uses the built-in `fetch`)
- **ffmpeg** — optional but recommended. Roughly half the films and many
  episodes are MKV or AVI, which no browser can play; without ffmpeg those are
  browse-only and say so instead of failing silently.
- **sqlite3** CLI — only if you read credentials from a desktop app's
  localStorage rather than setting them directly.

## Configure

Settings can come from a config file, a `.env` file, or the environment. They
layer, highest priority first:

```
environment variables  >  webui/.env  >  webui/config.json  >  defaults
```

So keep your normal setup in a file and override one value for a single run:

```bash
PORT=9000 make dev
```

**Config file** (JSON, gitignored):

```bash
cd webui
cp config.example.json config.json && $EDITOR config.json
```

```json
{
  "provider": {
    "username": "you",
    "password": "secret",
    "loginUrl": "http://your-provider.example.com",
    "server": "your-stream-host.example.com"
  },
  "server": { "port": 8090 },
  "cache": { "live": 21600 },
  "remote": { "host": "192.168.1.20" }
}
```

Every key is optional — see `config.example.json` for the full set. It's looked
for at `$IPTV_CONFIG`, then `webui/config.json`, then
`~/.config/iptv/config.json`. A flat form using the environment variable names
directly (`{ "IPTV_USERNAME": "you" }`) works too.

**`.env` file** — same settings, shell syntax:

```bash
cp .env.example .env && $EDITOR .env
```

Whichever route you choose, the app needs `IPTV_USERNAME`, `IPTV_PASSWORD`,
`IPTV_LOGIN_URL` (the host serving `player_api.php`) and `IPTV_SERVER` (the host
serving streams).

Alternatively, if you use a desktop IPTV app that keeps an Xtream profile in
localStorage, point `IPTV_LS_DB` (or `provider.localStorageDb`) at its
`file__0.localstorage` and the credentials are read from there.

What else is configurable: cache lifetimes for each catalogue, the artwork cache
size, ffmpeg/ffprobe paths and the audio the remuxer produces, the user agent
sent to the portal, and the remote's advertised host and pairing timeout. See
`config.example.json` or `.env.example`.

## Run

```bash
cd webui
make dev            # installs deps, starts on http://localhost:8090
```

Docker:

```bash
make run            # builds the image and starts the container
make run LS_DB="$HOME/Library/Application Support/<YourApp>/Local Storage/file__0.localstorage"
```

Other targets: `make build`, `make logs`, `make stop`, `make clean`,
`make clean-cache` (drops the cached catalogue volume).

The server binds `0.0.0.0` so other devices on your network can reach it — which
is what makes the phone remote work. See [Security](#security).

## Using it

Opens with one player and a centred search box: type to filter the live
catalogue, arrows to move, Enter to play.

| | |
|---|---|
| **Live TV** | 8,500+ channels. `1` / `2` opens the channel search for a tile — also how you get back to live from a film |
| **Films** (`M`) | ~21,000 films by search, category and sort, with posters, plot, cast and ratings |
| **Series** (`V`) | 6,500 shows with season tabs and episode lists; episodes remember where you got to |
| **Catch Up** (`T`) | The last 5–14 days from 137 archive-capable channels (BBC, ITV, Channel 4/5 and friends) |
| **Profile** (`A`) | Subscription expiry and days left, connections in use, portal details |
| **Remote** (`R`) | QR code to drive this screen from your phone |
| **Presets** (`P`) | Save and restore whole setups — channels, layout, split — in slots `1`–`9` |

**Continue watching** remembers the last 30 films and episodes. Films appear in
the film browser, series in the series browser grouped by show ("Breaking Bad ·
S01E02 · 36:31 left"), and both resume where you stopped.

**+ Player** adds a second tile. Cycle **Layout** between side-by-side and two
diagonal arrangements, and drag the handle between tiles to change proportions.
Only the focused tile plays audio.

### Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Pause / resume (films, episodes and catch-up — live can't pause) |
| `F` | Fullscreen (or double-click the video) |
| `Esc` | Close whatever is open, staying in fullscreen. Hold to leave fullscreen |
| `← / →` | Adjust the split (`↑ / ↓` too, in diagonal layouts) |
| `1` / `2` | Focus a tile and open its live channel search |
| `M` / `V` / `T` | Films / Series / Catch Up |
| `A` | Profile · `R` Remote · `P` Presets · `S` then `1`–`9` saves a preset |
| `D` | Info badge · `X` swap tiles · `C` pin the control bar |
| `+` / `−` | Volume on the focused tile |
| `?` | Help |

### Phone remote

Press **Remote** (or `R`) and scan the QR with a phone on the same network. The
phone gets transport controls, volume, tile focus, layout, presets, and browse
tabs for live, films, series and catch-up — tap anything and it plays **on the
main screen**. The phone never receives video.

Two things worth knowing:

- **Fullscreen must be started on the screen itself.** Browsers only allow
  fullscreen from a real user gesture, so a remote command can't do it. The
  remote can *leave* fullscreen, which is permitted.
- If the phone can't reach the first address, the pairing dialog offers the
  others it found, including the machine's `.local` name. A machine usually has
  several addresses and only some are reachable from a phone.

## How it works

- **Live playback** — IPTV live streams are MPEG-TS, which browsers can't play
  natively, so the frontend uses [mpegts.js](https://github.com/xqq/mpegts.js)
  (vendored). The server proxies streams so credentials stay server-side.
- **Films and episodes** — `container_extension` is `"vod"` for every item and
  says nothing about the actual file, so the server sniffs the first bytes.
  MP4/H.264 streams straight through and seeks by byte range; MKV and AVI go
  through ffmpeg, which copies the video and only re-encodes audio when it isn't
  already AAC. Remuxed items seek by restarting the stream at an offset, so both
  paths get a working scrub bar.
- **Catch-up** — channels advertise `tv_archive` and `tv_archive_duration`.
  Programmes come from the channel's EPG and play via `timeshift.php` as
  MPEG-TS. Start times are formatted in the *portal's* timezone, not the
  server's.
- **Search** — the portal ignores its own `&search=` parameter, so catalogues
  are cached locally (6h) and filtered here. There's no year field either: film
  years are parsed from titles, with `get_vod_info` supplying the real release
  date on the detail view.
- **Profile** — the bare `player_api.php` call is the Xtream auth endpoint. The
  server strips the password the provider echoes back, and cache-busts the
  request because the portal sits behind an HTTP cache that otherwise replays a
  stale response and freezes the live connection count.
- **Remote** — a phone can't connect to a browser directly, so the server
  relays. WebSocket rather than SSE, because each streaming player already holds
  one of the browser's ~6 HTTP/1.1 connections per origin.
- **Artwork** — proxied so the browser never talks to the provider's CDN, cached
  in memory and retried once, because that CDN regularly truncates responses
  mid-transfer.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | `{ ok, credentials }` |
| `GET /api/account` | Subscription info — never the password |
| `GET /api/channels?q=` | Live channels matching all words |
| `GET /api/stream/live/:id` | Proxied live stream |
| `GET /api/movies?q=&category=&sort=` | Film catalogue search |
| `GET /api/movies/categories` · `/api/movies/:id` | Categories · full metadata |
| `GET /api/movies/:id/playback` | `{ container, mode, reason }` — `direct`, `remux` or `unsupported` |
| `GET /api/stream/movie/:id[/remux?t=]` | Proxied / remuxed film |
| `GET /api/series?q=` · `/api/series/categories` · `/api/series/:id` | Series catalogue, categories, seasons + episodes |
| `GET /api/episodes/:id/playback` · `/api/stream/episode/:id[/remux?t=]` | Episode probe and stream |
| `GET /api/catchup/channels` · `/api/catchup/:id/epg` | Archive channels and their guide |
| `GET /api/stream/catchup/:id?start=&duration=` | Proxied archive stream |
| `GET /api/poster?u=` | Proxied artwork (public hosts only) |
| `GET /api/remote/pair?session=` · `/api/remote/qr?url=` | Pairing payload and QR |
| `GET /remote` | Phone remote UI |
| `WS /ws/screen?s=` · `WS /ws/remote?s=&t=` | Relay between a screen and its phones |
| `GET /api/refresh` | Force-refresh the live catalogue cache |

## Security

This is built for a home network and has **no authentication**. The server binds
`0.0.0.0`, so anyone on your LAN can watch your streams through it and, if they
scan or guess a pairing link, control a screen. That's the trade for having the
phone remote work at all. Don't expose the port to the internet.

Within that, the app avoids the obvious own-goals: provider credentials never
reach the browser, the password the portal echoes back is stripped server-side,
pairing tokens travel in the URL fragment (which browsers never send to a
server) and are stripped from the address bar after use, and the artwork proxy
refuses anything that isn't a public host so it can't be used to probe your
network.

`.env` is gitignored. Keep it that way.

## Troubleshooting

- **"IPTV not configured"** — none of the credential routes resolved. Check
  `.env`, or that `IPTV_LS_DB` points at a real file and `sqlite3` is installed.
- **A film says it needs ffmpeg** — it's MKV or AVI and ffmpeg isn't on the
  server. Install it, or set `FFMPEG_PATH`.
- **Phone can't reach the remote** — open "Phone can't connect?" in the pairing
  dialog and try another address. In Docker, set `REMOTE_HOST` to the host
  machine's LAN address; the container's own addresses are no use to a phone.
- **Artwork is patchy** — the provider's CDN truncates responses under load. The
  server retries once and caches what arrives, so it settles as you browse.
- **Streams stall** — each account has a connection limit (Profile shows it).
  Every open player and every running ffmpeg holds one.
