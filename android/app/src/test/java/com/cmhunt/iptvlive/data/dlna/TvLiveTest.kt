package com.cmhunt.iptvlive.data.dlna

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.URI

/**
 * Sends a real stream to a real TV through [StreamRelay] and [AvTransport],
 * from this machine. Puts a picture on the TV, so it only runs when asked:
 *
 *   DLNA_TV_CONTROL=http://<tv>:9197/upnp/control/AVTransport1 \
 *   IPTV_TEST_STREAM_URL=<stream url> ./gradlew testDebugUnitTest --tests '*TvLiveTest*'
 *
 * The stream URL carries credentials; nothing here prints it.
 */
class TvLiveTest {
    @Test
    fun `tv plays a stream through the relay`() = runBlocking {
        val control = System.getenv("DLNA_TV_CONTROL")
        val stream = System.getenv("IPTV_TEST_STREAM_URL")
        assumeTrue(control != null && stream != null)

        val http = OkHttpClient.Builder()
            .addInterceptor { it.proceed(it.request().newBuilder().header("User-Agent", "VLC/3.0.20 LibVLC/3.0.20").build()) }
            .build()
        val tv = DlnaDevice("uuid:test", "TV", "", "", control!!, control)
        val relay = StreamRelay(http)
        val avt = AvTransport(http)
        try {
            val url = relay.publish(stream!!, 1, URI(control).host)
            println("relay url host: ${URI(url).host}:${URI(url).port}")
            runCatching { avt.stop(tv) }
            avt.setUri(tv, url, "Relay test")
            avt.play(tv)
            var state = ""
            repeat(12) { i ->
                delay(1_000)
                state = avt.transportState(tv)
                println("+${i + 1}s state=$state clients=${relay.clients.value}")
                if (state == "PLAYING" && i >= 5) return@repeat
            }
            assertEquals("PLAYING", state)
        } finally {
            runCatching { avt.stop(tv) }
            relay.shutdown()
        }
    }
}
