package com.cmhunt.iptvlive.data.dlna

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.SocketTimeoutException

/**
 * SSDP discovery of UPnP media renderers (TVs, speakers, Kodi). Sends an
 * M-SEARCH to the multicast group and collects the description URLs that
 * answer. Replies come back unicast to our socket.
 *
 * On Android the caller must hold a Wi-Fi MulticastLock, or many devices
 * filter the traffic out.
 */
object Ssdp {
    private const val GROUP = "239.255.255.250"
    private const val PORT = 1900

    // Some TVs answer only for the device type, others only for the service.
    private val SEARCH_TARGETS = listOf(
        "urn:schemas-upnp-org:device:MediaRenderer:1",
        "urn:schemas-upnp-org:service:AVTransport:1",
    )

    suspend fun discover(timeoutMs: Int = 3_000): Set<String> = withContext(Dispatchers.IO) {
        val found = linkedSetOf<String>()
        MulticastSocket(null as InetSocketAddress?).use { socket ->
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(0))
            socket.timeToLive = 4
            socket.soTimeout = 250
            val group = InetAddress.getByName(GROUP)

            // UDP is lossy, so each search goes out twice.
            repeat(2) {
                for (st in SEARCH_TARGETS) {
                    val msg = mSearch(st).toByteArray(Charsets.US_ASCII)
                    socket.send(DatagramPacket(msg, msg.size, group, PORT))
                }
            }

            val buf = ByteArray(2048)
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                val packet = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(packet)
                } catch (e: SocketTimeoutException) {
                    continue
                }
                parseLocation(String(packet.data, 0, packet.length, Charsets.UTF_8))?.let { found += it }
            }
        }
        found
    }

    internal fun mSearch(st: String) =
        "M-SEARCH * HTTP/1.1\r\n" +
            "HOST: $GROUP:$PORT\r\n" +
            "MAN: \"ssdp:discover\"\r\n" +
            "MX: 2\r\n" +
            "ST: $st\r\n" +
            "USER-AGENT: Android/1 UPnP/1.1 IPTVLive/1\r\n\r\n"

    /** The LOCATION header of an M-SEARCH reply, or null. Header names are case-insensitive. */
    internal fun parseLocation(reply: String): String? {
        if (!reply.startsWith("HTTP/1.1 200", ignoreCase = true)) return null
        return reply.lineSequence()
            .map { it.trim() }
            .firstOrNull { it.startsWith("location:", ignoreCase = true) }
            ?.substringAfter(':')
            ?.trim()
            ?.takeIf { it.startsWith("http") }
    }
}
