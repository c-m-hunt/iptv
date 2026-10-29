@file:OptIn(UnstableApi::class)

package com.cmhunt.iptvlive.ui.player

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy.LoadErrorInfo
import androidx.media3.exoplayer.util.EventLogger
import androidx.media3.extractor.DefaultExtractorsFactory
import com.cmhunt.iptvlive.AppContainer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

data class PlaybackUi(
    val buffering: Boolean = true,
    val error: String? = null,
    /** True while an automatic retry is pending, so the UI says "retrying". */
    val retrying: Boolean = false,
    /** Set when the stream has audio this device can't decode (often AC-3). */
    val unsupportedAudio: String? = null,
)

/**
 * One ExoPlayer for one live stream, with the recovery a flaky IPTV source
 * needs: automatic retries after errors, and a watchdog for streams that
 * freeze without ever reporting an error.
 *
 * Owned by the player screen and released when it leaves the foreground, so
 * the app never holds one of the account's few connections in the background.
 */
class StreamPlayer(context: Context, http: OkHttpClient) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _ui = MutableStateFlow(PlaybackUi())
    val ui: StateFlow<PlaybackUi> = _ui

    val exo: ExoPlayer

    private var attempts = 0
    private var retryJob: Job? = null
    private var lastReloadAt = 0L

    // Declared before init, which registers it.
    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_READY) attempts = 0
            _ui.update { it.copy(buffering = state == Player.STATE_BUFFERING) }
        }

        override fun onPlayerError(error: PlaybackException) {
            val message = describe(error)
            attempts++
            // A missing channel stays missing; retrying only costs requests.
            if (attempts > MAX_AUTO_RETRIES || httpCode(error) == 404) {
                _ui.update { it.copy(buffering = false, error = message, retrying = false) }
                return
            }
            _ui.update { it.copy(buffering = false, error = message, retrying = true) }
            retryJob = scope.launch {
                delay(RETRY_BASE_MS * attempts)
                reload()
            }
        }

        override fun onTracksChanged(tracks: Tracks) {
            val audio = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
            val unsupported = audio.isNotEmpty() && audio.none { it.isSupported }
            val mime = audio.firstOrNull()?.getTrackFormat(0)?.sampleMimeType
            _ui.update { it.copy(unsupportedAudio = if (unsupported) mime ?: "unknown" else null) }
        }
    }

    init {
        val dataSource = OkHttpDataSource.Factory(http).setUserAgent(AppContainer.USER_AGENT)
        // Default TS flags on purpose. FLAG_ALLOW_NON_IDR_KEYFRAMES with
        // FLAG_DETECT_ACCESS_UNITS froze the video on its first frame (audio kept
        // going), and the default buffer sizes are kept for a similar reason: a
        // 1s start buffer re-buffered every few seconds on a real-time stream.
        val extractors = DefaultExtractorsFactory()

        exo = ExoPlayer.Builder(context)
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(dataSource, extractors).setLoadErrorHandlingPolicy(NoRetryOnHttp4xx)
            )
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .build()
        exo.playWhenReady = true
        exo.addListener(listener)
        // State, format and dropped-frame logs in debug builds only: they carry the stream URL.
        if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            exo.addAnalyticsListener(EventLogger("StreamPlayer"))
        }
        scope.launch { watchdog() }
    }

    fun play(url: String) {
        attempts = 0
        retryJob?.cancel()
        _ui.value = PlaybackUi()
        exo.setMediaItem(MediaItem.fromUri(url))
        exo.prepare()
    }

    /** User-initiated retry: resets the automatic retry budget. */
    fun retry() {
        attempts = 0
        reload()
    }

    fun release() {
        scope.cancel()
        exo.removeListener(listener)
        exo.release()
    }

    private fun reload() {
        retryJob?.cancel()
        lastReloadAt = System.currentTimeMillis()
        _ui.update { it.copy(buffering = true, error = null, retrying = false) }
        exo.stop()
        exo.prepare()
        exo.playWhenReady = true
    }

    // A live stream that freezes often raises no error: the position just stops.
    private suspend fun watchdog() {
        var lastPos = -1L
        var stuckSince = 0L
        while (scope.isActive) {
            delay(WATCHDOG_TICK_MS)
            val active = exo.playWhenReady && exo.playerError == null &&
                (exo.playbackState == Player.STATE_READY || exo.playbackState == Player.STATE_BUFFERING)
            val pos = exo.currentPosition
            val now = System.currentTimeMillis()
            if (!active || pos != lastPos) {
                lastPos = pos
                stuckSince = now
                continue
            }
            if (now - stuckSince >= STALL_MS && now - lastReloadAt >= RELOAD_COOLDOWN_MS) {
                stuckSince = now
                reload()
            }
        }
    }

    private fun httpCode(e: Throwable): Int? {
        var cause: Throwable? = e
        while (cause != null) {
            if (cause is HttpDataSource.InvalidResponseCodeException) return cause.responseCode
            cause = cause.cause
        }
        return null
    }

    private fun describe(e: PlaybackException): String {
        httpCode(e)?.let { code ->
            return when (code) {
                401, 403 -> "The provider refused the stream (HTTP $code). Are all your connections in use?"
                404 -> "This channel is not available (HTTP 404)."
                else -> "The stream server answered HTTP $code."
            }
        }
        return when (e.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "Cannot reach the stream server."
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
            PlaybackException.ERROR_CODE_DECODING_FAILED -> "This device cannot decode the stream."
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED -> "The stream is not in a format this app can play."
            else -> "Playback failed (${e.errorCodeName})."
        }
    }

    /**
     * ExoPlayer retries a failed load several times before it reports an error,
     * and [onPlayerError] retries again on top. For a 4xx that multiplies one
     * refusal into a dozen requests, and a 403 often means the account is at its
     * connection limit, so hand those straight to our own, slower retry.
     */
    private object NoRetryOnHttp4xx : DefaultLoadErrorHandlingPolicy() {
        override fun getRetryDelayMsFor(info: LoadErrorInfo): Long {
            val e = info.exception
            if (e is HttpDataSource.InvalidResponseCodeException && e.responseCode in 400..499) return C.TIME_UNSET
            return super.getRetryDelayMsFor(info)
        }
    }

    private companion object {
        const val MAX_AUTO_RETRIES = 3
        const val RETRY_BASE_MS = 2_000L
        const val WATCHDOG_TICK_MS = 2_000L
        const val STALL_MS = 12_000L
        const val RELOAD_COOLDOWN_MS = 8_000L
    }
}
