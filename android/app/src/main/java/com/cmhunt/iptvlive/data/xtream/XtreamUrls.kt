package com.cmhunt.iptvlive.data.xtream

import java.net.URLEncoder

/**
 * Pure URL handling for an Xtream Codes portal. Kept free of Android types so
 * it can be unit tested on the JVM.
 */
object XtreamUrls {

    /**
     * Turns whatever the user typed into `scheme://host[:port][/path]` with no
     * trailing slash. People paste the full `player_api.php` URL as often as the
     * bare host, so both are accepted.
     */
    fun normalisePortal(input: String): String {
        var s = input.trim()
        if (s.isEmpty()) return ""
        if (!s.contains("://")) s = "http://$s"
        s = s.substringBefore('?').trimEnd('/')
        if (s.endsWith("/player_api.php")) s = s.removeSuffix("/player_api.php")
        if (s.endsWith("/get.php")) s = s.removeSuffix("/get.php")
        return s.trimEnd('/')
    }

    /**
     * Where streams come from. The portal and the stream host are often
     * different machines, so the login response's `server_info` is preferred
     * over the portal URL, and a manual override beats both.
     */
    fun resolveStreamBase(
        portal: String,
        override: String,
        serverUrl: String?,
        serverPort: String?,
        httpsPort: String?,
        protocol: String?,
    ): String {
        if (override.isNotBlank()) return normalisePortal(override)

        val host = serverUrl?.trim().orEmpty()
        if (host.isEmpty()) return portal
        if (host.contains("://")) return normalisePortal(host)

        val scheme = if (protocol.equals("https", ignoreCase = true)) "https" else "http"
        val port = (if (scheme == "https") httpsPort else serverPort)?.trim().orEmpty()
        val defaultPort = if (scheme == "https") "443" else "80"
        return if (port.isEmpty() || port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
    }

    fun liveStream(streamBase: String, username: String, password: String, streamId: Int): String =
        "$streamBase/live/${segment(username)}/${segment(password)}/$streamId.ts"

    // URLEncoder is form encoding; a path segment wants %20 rather than '+'.
    private fun segment(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
