# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A web UI for an Xtream Codes IPTV subscription: live TV in one or two tiles,
films, TV series, catch-up, and a phone remote. Single user, home network, no
authentication. See `webui/README.md` for the user-facing view.

## Running it

```bash
cd webui
make dev            # installs deps, starts on http://localhost:8090
make run            # Docker
```

There are **no tests and no lint step**, and the frontend has **no build step** —
`public/` is served as-is, so a browser reload is the whole edit cycle. Verify
changes by driving the real app (Playwright works well) and reading the network
and console output; assertions against the DOM alone have missed real bugs here
(see *Testing gotchas*).

Two dependencies beyond Express: `ws` (remote relay) and `qrcode` (pairing QR).
`ffmpeg`/`ffprobe` are external binaries, optional but needed for half the film
and episode catalogue.

## Settings

Everything reads `process.env`. Two loaders run first, in this order, and
neither overwrites what's already set:

```
require('./env')     # webui/.env
require('./config')  # $IPTV_CONFIG, webui/config.json, ~/.config/iptv/config.json
```

That yields **env vars > .env > config file > code defaults**. `config.js` maps
nested JSON keys (`provider.username`) onto the env names the rest of the code
already uses, so nothing else needs to know a config file exists. Adding a
setting means: read it from `process.env` where it's used, add a line to `MAP` in
`config.js`, and list it in `config.example.json` and `.env.example`.

## Layout

```
webui/
  server/                  Node + Express, CommonJS
    index.js               Routes, static host, artwork proxy (SSRF-guarded, cached)
    env.js                 Loads .env before anything reads it
    config.js              Optional config.json, filling any gaps .env left
    iptv.js                Credentials, live catalogue, account info, stream proxy
    vod.js                 Films: catalogue cache, search, detail, container probe
    series.js              Series: shows, seasons, episodes (reuses vod's probe)
    catchup.js             Archive channels, EPG, timeshift URLs
    remux.js               ffmpeg container swap -> fMP4 on stdout
    remote.js              Pairing, QR, LAN address ranking, WebSocket relay
  public/                  Frontend, vanilla ES modules
    js/app.js              App class — owns all state, layout, players, controls
    js/player.js           One <video> tile: live via mpegts.js, on-demand natively
    js/films.js            Film browser + detail
    js/series.js           Series browser + seasons/episodes
    js/catchup.js          Catch-up channel list + EPG guide
    js/profile.js          Subscription panel
    js/history.js          WatchHistory — continue watching, localStorage
    js/presets.js          Saved setups in slots 1-9
    js/layout.js           Pure geometry for the three layout modes
    js/search.js           Per-player live channel search overlay
    js/shortcuts.js        Global keyboard handler, delegates to App
    js/remote-link.js      Registers this screen, runs remote commands, reports state
    remote/                Phone UI — separate page, deliberately contains no <video>
    vendor/mpegts.js       Vendored, not from npm
```

`App` is the only orchestrator. Browsers (films/series/catchup) are self-contained
and talk to it through callbacks; `Player` owns everything about one tile.

## The provider is the hard part

Most of the non-obvious code exists because of the portal, not the browser. Don't
"simplify" these away:

- **`container_extension` is `"vod"` for everything** and says nothing about the
  file. Roughly half are MKV or AVI, which no browser plays. `vod.probeStream()`
  sniffs the first bytes and returns a `mode`: `direct` (MP4/H.264), `remux`
  (ffmpeg) or `unsupported` (non-MP4 with no ffmpeg installed).
- **Search doesn't work.** `&search=` is ignored and returns the whole catalogue,
  so catalogues are cached locally and filtered here.
- **There is no year field.** Film years are parsed from titles (`"Love (2015)"`,
  ~86% of them); `get_vod_info` has the real `releasedate` for the detail view.
- **The account endpoint sits behind an HTTP cache** keyed on the exact URL.
  Without a cache-busting parameter it replays a minutes-old response, which
  freezes `active_cons` and `time_now`. `getAccount()` adds one.
- **The portal echoes your password back** in `user_info`. It is stripped
  server-side and must never reach the browser.
- **Catch-up times are in the portal's timezone**, from `server_info.timezone` —
  never the server's local zone. In Docker that's UTC and you'd silently fetch
  the wrong hour.
- **The artwork CDN truncates responses** mid-transfer under load, reproducibly,
  even on direct fetches. `/api/poster` retries once and caches in memory.
- **MKV chapters survive `-sn`** and the MP4 muxer rewrites them as a text track,
  leaving a stray data stream. `-map_chapters -1` is what removes it.

## Browser constraints that shaped the design

- **Fullscreen needs transient user activation.** A remote command can never
  enter fullscreen (`requestFullscreen()` throws "Permissions check failed");
  `exitFullscreen()` is allowed. Audio only needs *sticky* activation, so remote
  volume works.
- **Escape belongs to the browser in fullscreen.** `navigator.keyboard.lock(['Escape'])`
  on entering fullscreen hands it to the page so Esc closes an overlay instead of
  dropping fullscreen; holding Esc still exits. Chrome/Edge only — Safari and
  Firefox fall back to closing overlays on the way out of fullscreen.
- **In a container, nothing local is trustworthy for the remote's address.** The
  interfaces belong to a private bridge and the bound port isn't the published
  one. `buildUrls()` prefers the request's `Host` header — it carries a host and
  port that demonstrably reached us — then `REMOTE_HOST`/`REMOTE_PORT`, and skips
  its own interfaces entirely when `/.dockerenv` exists. `make run` passes the
  host's LAN address and published port in automatically.
- **~6 HTTP/1.1 connections per origin.** Each streaming player holds one. That's
  why the remote uses WebSocket rather than SSE: two screens with two players
  each would exhaust the budget and stall artwork and API calls.
- **`[hidden]` loses to `display: flex`** by specificity. The phone UI needs an
  explicit `[hidden] { display: none !important }`.

## Key flows

**Playback** — `direct` films stream through `proxyFrom()` and seek by byte range
(the proxy rewrites the portal's malformed `accept-ranges`). `remux` items pipe
through ffmpeg: video copied, audio re-encoded only when it isn't AAC. A piped
fMP4 has no byte ranges, so seeking restarts ffmpeg at `?t=`, and catch-up does
the same with a later `start`. All three on-demand modes share one transport bar
(`.player.on-demand`) and skip the live watchdog.

**Continue watching** — `Player` reports position every 5s and on pause, swap,
destroy and `pagehide`. `WatchHistory` keys entries by **`(id, type)`**: film and
episode ids come from different spaces on the portal and would otherwise collide
silently. Episodes carry show/season/episode so rows can be grouped by show. It
appears in the film browser (films), the series browser (one card per show), and
on the phone remote — on the Now tab and above the Films and Series grids.

**Remote** — `phone → server → screen`, state flowing back. Screens identify with
a UUID in **sessionStorage** (a reload keeps the same screen; a new tab is a new
screen). Pairing tokens ride in the URL **fragment**, which browsers never send
to a server. Commands are an explicit table in `remote-link.js` mapped onto `App`
methods — never a dispatched string. State is polled once a second, sent only on
change, and includes a trimmed watch history because that lives in the screen's
localStorage and the phone can't see it otherwise.

**Saved setups** — `getSetup()`/`applySetup()` must round-trip enough to restore
what was playing: for episodes that includes `type` (restoring one as a film hits
the wrong endpoint), and for catch-up the channel plus `start`/`duration`.
Restores resume via `history.resumeAt()`, or they replay from zero and overwrite
the resume point they just read.

## Conventions

- Server is CommonJS; frontend is ES modules. No transpiler, no bundler.
- Comments explain **why**, especially where the portal or a browser forced a
  choice. Density matches the surrounding file.
- Every new endpoint goes in the header comment of `server/index.js`, the README
  API table, and `.env.example` if it adds config.
- Errors return `{ error }` with a sensible status; the UI shows the reason
  rather than failing silently.
- Frontend helpers (`esc`, `fmtTime`, `cleanName`) are currently duplicated
  across modules. If you touch several at once, extracting a shared `util.js` is
  a reasonable tidy — it hasn't been done to avoid churn.

## Testing gotchas

- **Screenshot the UI, don't just assert on the DOM.** A tab switch once left the
  previous view stacked underneath: every DOM assertion passed because the
  elements existed and were populated. Only a screenshot showed it.
- **Hover state matters.** Controls keyed on `:hover` never hide, because the
  player tile fills the screen and the pointer is always over it. Synthetic
  `mousemove` events don't reproduce this — park the real pointer over the video.
- **Headless Chrome's fullscreen isn't real fullscreen.** Escape neither exits
  nor is swallowed, so the Esc-in-fullscreen behaviour can't be reproduced there.
- **Let the catalogue calls finish.** The film list is ~6MB; assertions made
  1.5s in report an empty grid that's actually fine a moment later.
- Kill test servers and check for stray `ffmpeg` processes afterwards — each one
  holds one of the account's limited connections.

## Shortcuts

`Space` pause/resume · `F` fullscreen · `Esc` close overlay (hold to leave
fullscreen) · `← → ↑ ↓` split · `D` info · `1 / 2` focus + live search · `X` swap
· `C` pin bar · `P` presets · `S` + `1–9` save · `+ / −` volume · `A` profile ·
`M` films · `V` series · `T` catch-up · `R` remote · `?` help

## Security posture

No authentication, binds `0.0.0.0`, home LAN only. Anyone on the network can
watch streams through it and, with a pairing link, control a screen. Within that:
credentials never reach the browser, the echoed password is stripped, pairing
tokens stay out of logs and the address bar, and `/api/poster` refuses non-public
hosts so it can't be used to probe the network. Don't expose the port publicly,
and keep `.env`, `REPORT.md` and `curl_examples.sh` out of git — the last two
contain real credentials.
