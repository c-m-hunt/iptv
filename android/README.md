# IPTV Live (Android)

A native Android app for the live TV part of an **Xtream Codes** subscription.
It talks to the provider directly, so the Node server in `../webui` is not
needed. Built for phones first, and kept usable with a D-pad so a TV box can
run the same APK later.

Status: **phase 1** — log in, download and search the channel list, play a
channel. Categories, presets, recents, favourites, EPG and the account panel
follow.

## Stack

| | |
|---|---|
| UI | Kotlin, Jetpack Compose, Material 3 (always dark) |
| Playback | Media3 ExoPlayer, streams fetched through OkHttp |
| Storage | Room for the channel catalogue, DataStore for settings |
| Secrets | Password encrypted with an Android Keystore AES-GCM key |
| Images | Coil 3, sharing the OkHttp client |
| Wiring | Hand-rolled `AppContainer`, no DI framework |

minSdk 26, targetSdk 36. AGP 8.13, Kotlin 2.2, Gradle 8.14.

## Build

Needs the Android SDK (Android Studio installs it) and JDK 17 or newer.

```bash
cd android
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # JVM tests: URL handling, search
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

## Layout

```
app/src/main/java/com/cmhunt/iptvlive/
  IptvApp.kt, AppContainer.kt   Application and dependency wiring
  MainActivity.kt               The only activity
  data/
    xtream/XtreamUrls.kt        Portal URL clean-up, stream host, stream URLs
    xtream/XtreamClient.kt      player_api.php: login, categories, streams
    db/Catalogue.kt             Room entities, DAO, database
    CatalogueRepository.kt      Cached catalogue, refreshed after 6 hours
    CredentialStore.kt          Saved login (password encrypted)
    SecretBox.kt                Keystore AES-GCM
    ChannelSearch.kt            Local all-words search
  ui/
    AppRoot.kt                  Login vs. main screens, navigation
    login/                      Login form
    channels/                   Channel list and search
    player/                     Full-screen player, StreamPlayer (ExoPlayer)
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
