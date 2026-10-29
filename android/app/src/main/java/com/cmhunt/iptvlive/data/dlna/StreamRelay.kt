package com.cmhunt.iptvlive.data.dlna

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.io.OutputStream
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * A tiny HTTP server that passes a live stream from the provider to a TV on
 * the LAN, for renderers that can't fetch the provider URL themselves (they
 * choke on its redirects, or the provider refuses their user agent).
 *
 * Bytes are copied as they arrive, with the DLNA headers Samsung and friends
 * look for. Paths carry a random token so nothing else on the network can
 * use the relay to reach the subscription.
 */
class StreamRelay(private val http: OkHttpClient) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var server: ServerSocket? = null
    private val token = randomToken()

    /** path -> upstream URL */
    private val routes = ConcurrentHashMap<String, String>()

    /** path -> the connection currently serving it */
    private val serving = ConcurrentHashMap<String, Socket>()

    private val _clients = MutableStateFlow(0)
    /** TV connections currently being fed. */
    val clients: StateFlow<Int> = _clients

    val isRunning: Boolean get() = server?.isClosed == false

    @Synchronized
    fun start(preferredPort: Int = DEFAULT_PORT): Int {
        server?.takeIf { !it.isClosed }?.let { return it.localPort }
        val socket = ServerSocket().apply { reuseAddress = true }
        try {
            socket.bind(InetSocketAddress(preferredPort))
        } catch (e: IOException) {
            socket.bind(InetSocketAddress(0)) // taken: any free port will do
        }
        server = socket
        scope.launch { acceptLoop(socket) }
        return socket.localPort
    }

    /**
     * Makes [upstream] available to the device at [deviceHost] and returns the
     * URL to give it. The address is the one this phone uses to reach the TV,
     * which is the right one even with mobile data or a VPN up.
     */
    fun publish(upstream: String, streamId: Int, deviceHost: String): String {
        val port = start()
        val path = "/$token/$streamId.ts"
        routes[path] = upstream
        val ip = localAddressToward(deviceHost).hostAddress
        return "http://$ip:$port$path"
    }

    @Synchronized
    fun stop() {
        routes.clear()
        serving.values.forEach { runCatching { it.close() } }
        serving.clear()
        runCatching { server?.close() }
        server = null
    }

    fun shutdown() {
        stop()
        scope.cancel()
    }

    private suspend fun acceptLoop(socket: ServerSocket) {
        while (scope.isActive && !socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (e: IOException) {
                break // closed by stop()
            }
            scope.launch { handle(client) }
        }
    }

    private fun handle(client: Socket) {
        client.use { sock ->
            sock.soTimeout = 15_000
            val head = readHead(sock) ?: return
            val (method, path) = head
            val out = sock.getOutputStream()
            val upstreamUrl = routes[path]
            when {
                upstreamUrl == null -> respond(out, "404 Not Found")
                method == "HEAD" -> respond(out, "200 OK", streamHeaders())
                method == "GET" -> serve(sock, out, path, upstreamUrl)
                else -> respond(out, "405 Method Not Allowed")
            }
        }
    }

    private fun serve(sock: Socket, out: OutputStream, path: String, upstreamUrl: String) {
        // Newest request wins: TVs often probe with one GET and then open
        // another, and each one held open costs an account connection.
        serving.put(path, sock)?.let { old -> runCatching { old.close() } }

        val request = Request.Builder().url(upstreamUrl).build()
        val call = http.newCall(request)
        var started = false
        try {
            call.execute().use { resp ->
                if (!resp.isSuccessful) {
                    respond(out, "502 Bad Gateway")
                    return
                }
                val body = resp.body ?: return respond(out, "502 Bad Gateway")
                out.write(statusLine("200 OK", streamHeaders()))
                out.flush()
                started = true
                _clients.update { it + 1 }
                try {
                    sock.soTimeout = 0
                    val input = body.byteStream()
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                    }
                } finally {
                    _clients.update { it - 1 }
                }
            }
        } catch (e: IOException) {
            // Before the headers went out the provider is at fault: say so.
            // After, the TV hung up or the provider dropped us; either way, done.
            if (!started) respond(out, "502 Bad Gateway")
        } finally {
            call.cancel()
            serving.remove(path, sock)
        }
    }

    private fun readHead(sock: Socket): Pair<String, String>? {
        val input = sock.getInputStream()
        val sb = StringBuilder()
        while (sb.length < 8192) {
            val c = input.read()
            if (c < 0) return null
            sb.append(c.toChar())
            if (sb.endsWith("\r\n\r\n") || sb.endsWith("\n\n")) break
        }
        val parts = sb.lineSequence().firstOrNull()?.split(' ') ?: return null
        if (parts.size < 2) return null
        return parts[0].uppercase() to parts[1].substringBefore('?')
    }

    private fun respond(out: OutputStream, status: String, headers: List<Pair<String, String>> = emptyList()) {
        runCatching {
            out.write(statusLine(status, headers + ("Content-Length" to "0")))
            out.flush()
        }
    }

    private fun statusLine(status: String, headers: List<Pair<String, String>>): ByteArray =
        buildString {
            append("HTTP/1.1 ").append(status).append("\r\n")
            for ((k, v) in headers) append(k).append(": ").append(v).append("\r\n")
            append("Connection: close\r\n\r\n")
        }.toByteArray(Charsets.US_ASCII)

    private fun streamHeaders() = listOf(
        "Content-Type" to AvTransport.MIME,
        "Cache-Control" to "no-cache",
        "transferMode.dlna.org" to "Streaming",
        "contentFeatures.dlna.org" to AvTransport.CONTENT_FEATURES,
    )

    companion object {
        const val DEFAULT_PORT = 8765

        /** The local address the OS would use to reach [host]. No packet is sent. */
        fun localAddressToward(host: String): InetAddress =
            DatagramSocket().use {
                it.connect(InetAddress.getByName(host), 9)
                it.localAddress
            }

        private fun randomToken(): String {
            val bytes = ByteArray(12).also { SecureRandom().nextBytes(it) }
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
