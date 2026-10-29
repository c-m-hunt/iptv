package com.cmhunt.iptvlive.data.dlna

import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import kotlin.concurrent.thread

class StreamRelayTest {

    private val payload = ByteArray(300_000) { (it % 251).toByte() }
    private lateinit var upstream: ServerSocket
    private val http = OkHttpClient()
    private val relay = StreamRelay(http)

    @Before
    fun startUpstream() {
        // A one-request-at-a-time origin that serves a fixed "stream" and closes.
        upstream = ServerSocket(0)
        thread(isDaemon = true) {
            while (!upstream.isClosed) {
                val s = runCatching { upstream.accept() }.getOrNull() ?: break
                s.use {
                    val r = it.getInputStream().bufferedReader()
                    while (r.readLine()?.isNotEmpty() == true) Unit
                    it.getOutputStream().apply {
                        write("HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nConnection: close\r\n\r\n".toByteArray())
                        write(payload)
                        flush()
                    }
                }
            }
        }
    }

    @After
    fun tearDown() {
        relay.shutdown()
        upstream.close()
    }

    @Test
    fun `relay passes the stream through with DLNA headers`() {
        val url = relay.publish("http://127.0.0.1:${upstream.localPort}/live/u/p/7.ts", 7, "127.0.0.1")
        http.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            assertEquals(200, resp.code)
            assertEquals(AvTransport.MIME, resp.header("Content-Type"))
            assertEquals("Streaming", resp.header("transferMode.dlna.org"))
            assertEquals(AvTransport.CONTENT_FEATURES, resp.header("contentFeatures.dlna.org"))
            assertArrayEquals(payload, resp.body!!.bytes())
        }
    }

    @Test
    fun `head answers without touching the upstream`() {
        val url = relay.publish("http://127.0.0.1:1/never", 7, "127.0.0.1")
        http.newCall(Request.Builder().url(url).head().build()).execute().use { resp ->
            assertEquals(200, resp.code)
            assertEquals(AvTransport.MIME, resp.header("Content-Type"))
            // "Content-Length: 0" made a Samsung think the stream was empty.
            assertEquals(null, resp.header("Content-Length"))
        }
    }

    @Test
    fun `unknown paths are refused`() {
        val url = relay.publish("http://127.0.0.1:${upstream.localPort}/x", 7, "127.0.0.1")
        val wrong = url.replaceAfterLast('/', "8.ts").replace(Regex("/[0-9a-f]{24}/"), "/guess/")
        http.newCall(Request.Builder().url(wrong).build()).execute().use { resp ->
            assertEquals(404, resp.code)
        }
    }

    @Test
    fun `an upstream failure becomes a 502`() {
        val dead = ServerSocket(0).also { it.close() }.localPort
        val url = relay.publish("http://127.0.0.1:$dead/live.ts", 9, "127.0.0.1")
        http.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            assertEquals(502, resp.code)
        }
    }
}
