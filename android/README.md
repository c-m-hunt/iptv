# IPTV Live (Android)

A native Android app for the live TV part of an **Xtream Codes** subscription.
It talks to the provider directly, so the Node server in `../webui` is not
needed. Built for phones first, and kept usable with a D-pad so a TV box can
run the same APK later.

Status: **phase 3** — log in; Home with presets, favourites and recent
channels; Categories and Search tabs; channel up/down; play on the phone or
**on a TV** over DLNA. EPG and the account panel follow.

## Screens

- **Home** — nine preset tiles, favourites, and the last 20 channels watched.
  A channel counts as watched once it has *played* for 10 s (on the phone or
  the TV), so surfing doesn't fill the list.
- **Categories** — the provider's categories with channel counts, filtered by
  all the words typed; open one for its channels, with its own filter.
- **Search** — every channel, filtered the same way. The portal's own search
  ignores the query, so this is local.

Long-press any channel for its actions: add to or remove from favourites, save
to a preset slot (the grid shows what each slot holds), remove from Recent.

**In the player**: swipe up for the next channel and down for the previous
one, or use the arrows; up/down also step on the TV panel. They move through
the list the channel was opened from — its category, Favourites, Recent,
Presets or the search results — fixed when the player opens, so Recent doesn't
reorder under you. The star and bookmark save the current channel; the strip
at the bottom jumps to a preset. Keys work too: up/down, CH+/CH−, and 1–9 for
the presets.

The top bar (TV, refresh, log out) and the "playing on TV" banner are shared by
all tabs. The tab bar is a bottom bar on a phone and a side rail on a wider
screen, which is also what a TV box will get.

## Stack

| | |
|---|---|
| UI | Kotlin, Jetpack Compose, Material 3 (always dark) |
| Playback | Media3 ExoPlayer, streams fetched through OkHttp |
| Storage | Room: `iptv.db` (catalogue cache, rebuilt freely), `user.db` (recents, favourites, presets; migrated, schemas in `app/schemas`); DataStore for settings |
| Secrets | Password encrypted with an Android Keystore AES-GCM key |
| Images | Coil 3, sharing the OkHttp client |
| Play on TV | DLNA/UPnP: SSDP discovery, AVTransport SOAP, an optional relay |
| Wiring | Hand-rolled `AppContainer`, no DI framework |

minSdk 26, targetSdk 36. AGP 8.13, Kotlin 2.2, Gradle 8.14.

## Build

Needs the Android SDK (Android Studio installs it) and JDK 17 or newer.

```bash
cd android
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # JVM tests: URLs, search, DLNA parsing, relay
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The debug build installs as `com.cmhunt.iptvlive.debug`, beside a release build.

## Try it without a subscription

`dev/mock-xtream.mjs` is a fake portal with 200 channels whose streams are
real live MPEG-TS from ffmpeg's test source, served through a 302 the way real
portals redirect to an edge server. Channel 1039 always answers 404.

```bash
node dev/mock-xtream.mjs          # needs ffmpeg with libx264
```

Log in from the emulator with server `10.0.2.2:8099`, username `test`,
password `test`.

`dev/mock-dlna-renderer.mjs` is a fake DLNA TV. It answers SSDP, so it shows
up in the TV picker (or add `10.0.2.2:8098/dmr` by address), and on Play it
really downloads the stream and logs the DLNA headers it got.

```bash
node dev/mock-dlna-renderer.mjs              # plays whatever URL it is given
node dev/mock-dlna-renderer.mjs --lan-only   # refuses the provider URL: tests the relay
adb forward tcp:8765 tcp:8765                # lets the mock reach the emulator's relay
```

## Play on TV (DLNA)

Your provider only serves raw MPEG-TS (`allowed_output_formats: ["ts"]`, no
HLS, no CORS), which rules out Chromecast's default receiver. DLNA TVs play
MPEG-TS natively — HEVC included on recent Samsungs — so the stream goes to
the TV untouched.

1. **Discovery.** SSDP M-SEARCH for `MediaRenderer` and `AVTransport`, under a
   Wi-Fi multicast lock. TVs can also be added by IP; a bare address is tried
   at Samsung's `:9197/dmr`.
2. **Direct first.** The app follows the portal's redirect itself and gives the
   TV the final edge URL, so once it plays the phone is free and can sleep.
3. **Relay if that fails.** If the TV won't start (it goes `TRANSITIONING` →
   `STOPPED`, or sits in `STOPPED` for 4 s), the phone serves the stream from
   a small HTTP server on port 8765, behind a random path token. A foreground
   service with Wi-Fi and wake locks keeps it alive with the screen off. That
   TV goes straight to the relay for the rest of the session.
4. **Watching.** The app polls `GetTransportInfo` every 5 s and notices when
   the TV stops on its own.

DLNA details that matter:

- **MIME type `video/mpeg`, not `video/mp2t`.** A Samsung QN700B's
  `GetProtocolInfo` lists no `video/mp2t` at all, but accepts `video/mpeg`
  with any profile.
- **Live flags:** `DLNA.ORG_OP=00` (no seeking) and streaming transfer mode,
  in both the DIDL metadata and the relay's response headers.
- **Resolve the redirect for the TV.** The portal answers a stream URL with a
  302 to a tokenised edge server, with an HTML body. A Samsung QN700B gives up
  on that, but plays the edge URL straight away.
- **No `Content-Length` on the relay's HEAD.** Samsungs send HEAD before every
  play; `Content-Length: 0` made one decide the stream was empty and stop.
- **Stop before SetAVTransportURI.** Many TVs refuse a new URI while playing.
- The relay answers `HEAD` without touching the provider, and a second `GET`
  for the same stream replaces the first, so a TV that probes before it plays
  costs one account connection, not two.
- The provider accepts a non-VLC user agent on stream URLs, and a Samsung
  sends none at all, so direct mode works once the redirect is resolved.

`TvLiveTest` sends a real stream to a real TV through the relay code, from
your machine. It puts a picture on the TV, so it runs only when asked:

```bash
DLNA_TV_CONTROL=http://<tv>:9197/upnp/control/AVTransport1 \
IPTV_TEST_STREAM_URL=<stream url> ./gradlew testDebugUnitTest --tests '*TvLiveTest*'
```

## Layout

```
app/src/main/java/com/cmhunt/iptvlive/
  IptvApp.kt, AppContainer.kt   Application and dependency wiring
  MainActivity.kt               The only activity
  data/
    xtream/XtreamUrls.kt        Portal URL clean-up, stream host, stream URLs
    xtream/XtreamClient.kt      player_api.php: login, categories, streams
    db/Catalogue.kt             Catalogue cache: entities, DAO, database
    user/UserDatabase.kt        What the user made: recents, favourites, presets
    RecentsRepository.kt        Recents, trimmed to 20
    FavouritesRepository.kt     Favourites, in catalogue order
    PresetsRepository.kt        Nine preset slots
    ChannelQueue.kt             Play context and the up/down list
    CatalogueRepository.kt      Cached catalogue, refreshed after 6 hours
    CredentialStore.kt          Saved login (password encrypted)
    SecretBox.kt                Keystore AES-GCM
    ChannelSearch.kt            Local all-words search
    dlna/Ssdp.kt                SSDP discovery
    dlna/DlnaDevice.kt          Device description parsing
    dlna/AvTransport.kt         SetAVTransportURI, Play, Stop, GetTransportInfo
    dlna/StreamRelay.kt         Phone-side HTTP relay for TVs
  tv/
    TvController.kt             Direct-then-relay playback on a TV, status
    RelayService.kt             Foreground service while the relay runs
  ui/
    AppRoot.kt                  Login vs. main screens, navigation
    login/                      Login form
    main/                       Tabs, shared top bar, catalogue refresh
    home/, categories/, search/ The tabs, and a category's channel list
    channels/                   Shared channel rows, search box, logos, long-press sheet
    presets/                    Preset tiles, slot grid, player strip
    player/                     Full-screen player, StreamPlayer (ExoPlayer)
    tv/                         TV picker, TV panel, "playing on TV" banner
```

## Things learned the hard way

- **Keep ExoPlayer's default TS flags.** `FLAG_ALLOW_NON_IDR_KEYFRAMES` with
  `FLAG_DETECT_ACCESS_UNITS` (common IPTV advice) froze the video on its first
  frame while audio played on.
- **A 1s start buffer is too small** for a stream that arrives in real time: it
  re-buffered every few seconds. The defaults are fine.
- **ExoPlayer retries failed loads itself.** On top of the app's own retries,
  one HTTP 403 turned into 16 requests. 4xx answers now skip the internal
  retries, and a 404 is not retried at all.
- **One connection at a time on a channel change.** `stop()` only asks the
  loader thread to close the stream, so the next one opened while the last
  was still connected. The player counts open connections in a wrapper data
  source and waits for zero before it prepares the next channel.
- **Snapshot state for effects.** An effect keyed on a nullable player read
  the player when its coroutine ran, so it played on the null key and again
  on the real one: every stream opened twice.
- **Release the player on stop.** Each stream is one of the account's few
  connections; the player screen frees it when the app leaves the foreground
  and reconnects on return.
- **The portal's user agent check.** Requests carry a VLC user agent, as the
  web app's server does.
- **The password is in every stream URL** (`/live/user/pass/id.ts`). Nothing
  logs URLs in release builds; Media3's `EventLogger` is debug-only for that
  reason.
- `allowBackup` is off: a backed-up password could not be decrypted on another
  device, because the Keystore key never leaves this one.
