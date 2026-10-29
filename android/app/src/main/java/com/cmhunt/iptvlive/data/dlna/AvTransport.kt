package com.cmhunt.iptvlive.data.dlna

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/** A failure with a message fit to show the user. */
class DlnaException(message: String) : Exception(message)

/**
 * The few AVTransport actions needed to play a live stream on a renderer.
 * Plain SOAP over HTTP; every renderer speaks this, however old.
 */
class AvTransport(private val http: OkHttpClient) {

    suspend fun setUri(device: DlnaDevice, uri: String, title: String) =
        call(
            device, "SetAVTransportURI",
            "<CurrentURI>${xmlEscape(uri)}</CurrentURI>" +
                "<CurrentURIMetaData>${xmlEscape(didl(uri, title))}</CurrentURIMetaData>",
        )

    suspend fun play(device: DlnaDevice) = call(device, "Play", "<Speed>1</Speed>")

    suspend fun stop(device: DlnaDevice) = call(device, "Stop", "")

    /** PLAYING, STOPPED, TRANSITIONING, PAUSED_PLAYBACK or NO_MEDIA_PRESENT. */
    suspend fun transportState(device: DlnaDevice): String {
        val body = call(device, "GetTransportInfo", "")
        return tagValue(body, "CurrentTransportState") ?: "UNKNOWN"
    }

    private suspend fun call(device: DlnaDevice, action: String, args: String): String =
        withContext(Dispatchers.IO) {
            val envelope = """<?xml version="1.0" encoding="utf-8"?>""" +
                """<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" """ +
                """s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>""" +
                """<u:$action xmlns:u="$SERVICE"><InstanceID>0</InstanceID>$args</u:$action>""" +
                """</s:Body></s:Envelope>"""
            val request = Request.Builder()
                .url(device.avTransportUrl)
                .header("SOAPACTION", "\"$SERVICE#$action\"")
                .post(envelope.toRequestBody("text/xml; charset=\"utf-8\"".toMediaType()))
                .build()
            try {
                http.newCall(request).execute().use { resp ->
                    val body = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) throw DlnaException(faultMessage(action, resp.code, body))
                    body
                }
            } catch (e: IOException) {
                throw DlnaException("Cannot reach ${device.name} (${e.javaClass.simpleName}).")
            }
        }

    companion object {
        private const val SERVICE = "urn:schemas-upnp-org:service:AVTransport:1"

        /**
         * DLNA flags for a live, unseekable stream: OP=00 says no byte or time
         * seeking, and FLAGS sets streaming transfer mode. Samsung TVs are known
         * to refuse items whose protocolInfo they don't like, so this is the
         * conservative form most renderers accept for MPEG-TS.
         */
        const val CONTENT_FEATURES = "DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
        // Not video/mp2t: a Samsung QN700B's GetProtocolInfo lists no such type,
        // but accepts video/mpeg with any profile, which covers MPEG-TS.
        const val MIME = "video/mpeg"

        internal fun didl(uri: String, title: String): String =
            """<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" """ +
                """xmlns:dc="http://purl.org/dc/elements/1.1/" """ +
                """xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">""" +
                """<item id="0" parentID="-1" restricted="1">""" +
                """<dc:title>${xmlEscape(title)}</dc:title>""" +
                """<upnp:class>object.item.videoItem</upnp:class>""" +
                """<res protocolInfo="http-get:*:$MIME:$CONTENT_FEATURES">${xmlEscape(uri)}</res>""" +
                """</item></DIDL-Lite>"""

        internal fun xmlEscape(s: String): String = buildString(s.length) {
            for (c in s) when (c) {
                '&' -> append("&amp;")
                '<' -> append("&lt;")
                '>' -> append("&gt;")
                '"' -> append("&quot;")
                '\'' -> append("&apos;")
                else -> append(c)
            }
        }

        internal fun tagValue(xml: String, tag: String): String? =
            Regex("<(?:\\w+:)?$tag>([^<]*)</(?:\\w+:)?$tag>").find(xml)?.groupValues?.get(1)?.trim()

        /** Renderers report errors as a SOAP fault with a UPnP error code. */
        internal fun faultMessage(action: String, httpCode: Int, body: String): String {
            val code = tagValue(body, "errorCode")
            val desc = tagValue(body, "errorDescription")
            val known = when (code) {
                "701" -> "the TV is not in a state to do that"
                "705" -> "the TV is busy with something else"
                "714", "716" -> "the TV does not accept this stream"
                "718" -> "the TV cannot find that stream"
                else -> null
            }
            val detail = known ?: desc ?: "HTTP $httpCode"
            return "$action failed: $detail${if (code != null) " (UPnP $code)" else ""}."
        }
    }
}
