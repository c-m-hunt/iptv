package com.cmhunt.iptvlive.data.dlna

import org.w3c.dom.Element
import java.io.ByteArrayInputStream
import java.net.URI
import javax.xml.parsers.DocumentBuilderFactory

/** A UPnP media renderer that can be told to play a URL. */
data class DlnaDevice(
    val udn: String,
    val name: String,
    val manufacturer: String,
    val model: String,
    /** The description URL; also the base for relative control URLs. */
    val location: String,
    val avTransportUrl: String,
) {
    val host: String get() = URI(location).host

    companion object {
        private const val AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:"

        /**
         * Parses a device description. Returns null for a device without an
         * AVTransport service, which can't be sent a stream. Embedded devices
         * are searched too: some TVs put the renderer one level down.
         */
        fun parse(xml: String, location: String): DlnaDevice? {
            val doc = DocumentBuilderFactory.newInstance()
                .apply { isNamespaceAware = false }
                .newDocumentBuilder()
                .parse(ByteArrayInputStream(xml.toByteArray(Charsets.UTF_8)))
            val root = doc.documentElement
            val base = root.child("URLBase")?.textContent?.trim()?.takeIf { it.isNotEmpty() } ?: location

            val services = root.getElementsByTagName("service")
            for (i in 0 until services.length) {
                val svc = services.item(i) as Element
                val type = svc.child("serviceType")?.textContent?.trim().orEmpty()
                if (!type.startsWith(AV_TRANSPORT)) continue
                val control = svc.child("controlURL")?.textContent?.trim() ?: continue
                // The device that owns this service is the <device> two levels up.
                val device = svc.parentNode?.parentNode as? Element ?: continue
                return DlnaDevice(
                    udn = device.child("UDN")?.textContent?.trim().orEmpty().ifEmpty { location },
                    name = device.child("friendlyName")?.textContent?.trim().orEmpty().ifEmpty { "TV" },
                    manufacturer = device.child("manufacturer")?.textContent?.trim().orEmpty(),
                    model = device.child("modelName")?.textContent?.trim().orEmpty(),
                    location = location,
                    avTransportUrl = URI(base).resolve(control).toString(),
                )
            }
            return null
        }

        private fun Element.child(tag: String): Element? {
            val nodes = childNodes
            for (i in 0 until nodes.length) {
                val n = nodes.item(i)
                if (n is Element && (n.tagName == tag || n.tagName.endsWith(":$tag"))) return n
            }
            return null
        }
    }
}
