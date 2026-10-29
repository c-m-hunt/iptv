package com.cmhunt.iptvlive.tv

import android.content.Context
import android.net.wifi.WifiManager
import com.cmhunt.iptvlive.data.CatalogueRepository
import com.cmhunt.iptvlive.data.CredentialStore
import com.cmhunt.iptvlive.data.dlna.AvTransport
import com.cmhunt.iptvlive.data.dlna.DlnaDevice
import com.cmhunt.iptvlive.data.dlna.DlnaException
import com.cmhunt.iptvlive.data.dlna.Ssdp
import com.cmhunt.iptvlive.data.dlna.StreamRelay
import com.cmhunt.iptvlive.data.xtream.XtreamUrls
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

enum class TvMode { Direct, Relay }

sealed interface TvStatus {
    data object Idle : TvStatus
    data class Starting(val step: String) : TvStatus
    data class Playing(val mode: TvMode) : TvStatus
    data object Stopped : TvStatus
    data class Failed(val message: String) : TvStatus
}

data class TvState(
    val device: DlnaDevice? = null,
    val channelId: Int? = null,
    val channelName: String = "",
    val status: TvStatus = TvStatus.Idle,
)

/**
 * Plays channels on a DLNA TV. The TV is first given the provider URL
 * itself, so the phone is free once it starts. If the TV won't play that
 * (redirects, user agent checks), the phone relays the stream instead.
 *
 * App-scoped: the TV keeps playing while the user browses, and the relay
 * keeps running with the screen off.
 */
class TvController(
    context: Context,
    http: OkHttpClient,
    private val credentials: CredentialStore,
    private val catalogue: CatalogueRepository,
) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    // Renderers answer SOAP in milliseconds; a slow one is a gone one.
    private val soapHttp = http.newBuilder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
    private val avt = AvTransport(soapHttp)
    private val relay = StreamRelay(http)
    private val noRedirects = soapHttp.newBuilder().followRedirects(false).followSslRedirects(false).build()

    private val _state = MutableStateFlow(TvState())
    val state: StateFlow<TvState> = _state

    private var playJob: Job? = null

    /** TVs that failed with the direct URL this session; they go straight to the relay. */
    private val needsRelay = mutableSetOf<String>()

    suspend fun discover(): List<DlnaDevice> {
        val wifi = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val lock = wifi.createMulticastLock("iptvlive:ssdp").apply {
            setReferenceCounted(false)
            acquire()
        }
        return try {
            val locations = Ssdp.discover()
            coroutineScope { locations.map { async { describe(it) } }.awaitAll() }
                .filterNotNull()
                .distinctBy { it.udn }
        } finally {
            lock.release()
        }
    }

    /**
     * For networks that block multicast: a description URL, or a bare address,
     * which is tried at the port and path Samsung TVs use.
     */
    suspend fun addByAddress(input: String): DlnaDevice {
        val s = input.trim()
        val candidates = when {
            s.startsWith("http") -> listOf(s)
            s.contains('/') -> listOf("http://$s")
            else -> listOf("http://$s:9197/dmr", "http://$s/description.xml")
        }
        for (url in candidates) describe(url)?.let { return it }
        throw DlnaException("No TV answered at $s.")
    }

    fun select(device: DlnaDevice) {
        if (_state.value.device?.udn == device.udn) return
        stopInternal(keepDevice = false)
        _state.value = TvState(device = device)
    }

    fun play(channelId: Int) {
        playJob?.cancel()
        playJob = scope.launch { start(channelId) }
    }

    /** Stops the TV and the relay; the TV stays selected. */
    fun stop() = stopInternal(keepDevice = true)

    /** Stops and forgets the TV, so channels play on the phone again. */
    fun disconnect() = stopInternal(keepDevice = false)

    private fun stopInternal(keepDevice: Boolean) {
        playJob?.cancel()
        val device = _state.value.device
        endRelay()
        if (device != null) scope.launch { runCatching { avt.stop(device) } }
        _state.update {
            if (keepDevice) it.copy(status = if (it.channelId != null) TvStatus.Stopped else TvStatus.Idle) else TvState()
        }
    }

    private suspend fun start(channelId: Int) {
        val device = _state.value.device ?: return
        val channel = catalogue.channel(channelId)
        val creds = credentials.credentials.first()
        if (channel == null || creds == null) {
            _state.update { it.copy(channelId = channelId, status = TvStatus.Failed("This channel is no longer available.")) }
            return
        }
        _state.update {
            it.copy(channelId = channelId, channelName = channel.name, status = TvStatus.Starting("Connecting to ${device.name}…"))
        }
        val source = XtreamUrls.liveStream(creds.streamBase, creds.username, creds.password, channel.id)

        var lastError: String? = null
        if (device.udn !in needsRelay) {
            endRelay()
            when (val r = tryStart(device, resolveRedirects(source), channel.name)) {
                null -> return playing(device, TvMode.Direct)
                else -> lastError = r
            }
            needsRelay += device.udn
        }

        _state.update { it.copy(status = TvStatus.Starting("Sending through this phone…")) }
        val relayed = try {
            // The relay follows redirects per connection, so it gets fresh edge tokens.
            withContext(Dispatchers.IO) { relay.publish(source, channel.id, device.host) }
        } catch (e: Exception) {
            return fail("Could not start the relay on this phone.")
        }
        RelayService.start(app, "${channel.name} on ${device.name}")
        when (val r = tryStart(device, relayed, channel.name)) {
            null -> playing(device, TvMode.Relay)
            else -> {
                endRelay()
                fail(r.takeIf { it != NOT_STARTED } ?: lastError?.takeIf { it != NOT_STARTED }
                    ?: "${device.name} did not start playing. It may not support this stream.")
            }
        }
    }

    /** Null on success, else why it failed. */
    private suspend fun tryStart(device: DlnaDevice, url: String, title: String): String? {
        try {
            // Many TVs refuse a new URI while something plays; stop first, ignore errors.
            runCatching { avt.stop(device) }
            avt.setUri(device, url, title)
            avt.play(device)
            // A TV that refuses a URL either goes TRANSITIONING -> STOPPED, or
            // never leaves STOPPED; give the second a few polls, in case it is slow.
            var sawTransition = false
            var stoppedPolls = 0
            repeat(START_POLLS) {
                delay(1_000)
                when (avt.transportState(device)) {
                    "PLAYING" -> return null
                    "TRANSITIONING" -> sawTransition = true
                    "STOPPED", "NO_MEDIA_PRESENT" ->
                        if (sawTransition || ++stoppedPolls >= STOPPED_POLLS) return NOT_STARTED
                }
            }
            return NOT_STARTED
        } catch (e: CancellationException) {
            throw e
        } catch (e: DlnaException) {
            return e.message
        }
    }

    private suspend fun playing(device: DlnaDevice, mode: TvMode) {
        _state.update { it.copy(status = TvStatus.Playing(mode)) }
        // Notice when the TV stops on its own: its remote, input change, stream end.
        var errors = 0
        while (true) {
            delay(5_000)
            val s = try {
                avt.transportState(device).also { errors = 0 }
            } catch (e: DlnaException) {
                if (++errors >= 3) {
                    endRelay()
                    return fail("Lost contact with ${device.name}.")
                }
                continue
            }
            if (s == "STOPPED" || s == "NO_MEDIA_PRESENT") {
                endRelay()
                _state.update { it.copy(status = TvStatus.Stopped) }
                return
            }
        }
    }

    /**
     * The portal answers a stream URL with a 302 (HTML body) to a tokenised
     * edge server. A Samsung QN700B gives up on that redirect but plays the
     * edge URL it points to, so the TV is handed the end of the chain. Falls
     * back to the original URL if the portal can't be asked.
     */
    private suspend fun resolveRedirects(url: String): String = withContext(Dispatchers.IO) {
        var current = url
        repeat(MAX_REDIRECTS) {
            val next = runCatching {
                noRedirects.newCall(Request.Builder().url(current).head().build()).execute().use { resp ->
                    resp.header("Location")?.takeIf { resp.isRedirect }?.let { resp.request.url.resolve(it)?.toString() }
                }
            }.getOrNull() ?: return@withContext current
            current = next
        }
        current
    }

    private fun fail(message: String) = _state.update { it.copy(status = TvStatus.Failed(message)) }

    private fun endRelay() {
        relay.stop()
        RelayService.stop(app)
    }

    private suspend fun describe(location: String): DlnaDevice? = withContext(Dispatchers.IO) {
        runCatching {
            soapHttp.newCall(Request.Builder().url(location).build()).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                DlnaDevice.parse(resp.body?.string().orEmpty(), location)
            }
        }.getOrNull()
    }

    private companion object {
        const val START_POLLS = 15
        const val STOPPED_POLLS = 4
        const val MAX_REDIRECTS = 5
        const val NOT_STARTED = "not started"
    }
}
