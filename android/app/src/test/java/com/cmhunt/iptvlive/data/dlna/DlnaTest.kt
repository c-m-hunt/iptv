package com.cmhunt.iptvlive.data.dlna

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DlnaTest {

    // Shaped like a Samsung description: the renderer sits in an embedded
    // device and the control URL is relative.
    private val samsungLike = """<?xml version="1.0"?>
        <root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:sec="http://www.sec.co.kr/dlna">
          <device>
            <deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
            <friendlyName>Outer</friendlyName>
            <UDN>uuid:outer</UDN>
            <deviceList>
              <device>
                <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
                <friendlyName>[TV] Samsung 7 Series (55)</friendlyName>
                <manufacturer>Samsung Electronics</manufacturer>
                <modelName>UE55RU7400</modelName>
                <UDN>uuid:tv-1</UDN>
                <serviceList>
                  <service>
                    <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
                    <controlURL>/upnp/control/RenderingControl1</controlURL>
                  </service>
                  <service>
                    <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
                    <controlURL>upnp/control/AVTransport1</controlURL>
                  </service>
                </serviceList>
              </device>
            </deviceList>
          </device>
        </root>"""

    @Test
    fun `description finds the embedded renderer and resolves its control url`() {
        val d = DlnaDevice.parse(samsungLike, "http://192.168.1.50:9197/dmr")!!
        assertEquals("uuid:tv-1", d.udn)
        assertEquals("[TV] Samsung 7 Series (55)", d.name)
        assertEquals("Samsung Electronics", d.manufacturer)
        assertEquals("http://192.168.1.50:9197/upnp/control/AVTransport1", d.avTransportUrl)
        assertEquals("192.168.1.50", d.host)
    }

    @Test
    fun `description honours URLBase`() {
        val xml = samsungLike.replace("<device>\n            <deviceType>urn:schemas-upnp-org:device:Basic:1",
            "<URLBase>http://10.0.0.9:7676/</URLBase><device>\n            <deviceType>urn:schemas-upnp-org:device:Basic:1")
        val d = DlnaDevice.parse(xml, "http://192.168.1.50:9197/dmr")!!
        assertEquals("http://10.0.0.9:7676/upnp/control/AVTransport1", d.avTransportUrl)
    }

    @Test
    fun `a device without AVTransport is not a renderer`() {
        assertNull(DlnaDevice.parse(samsungLike.replace("AVTransport", "ContentDirectory"), "http://h/d"))
    }

    @Test
    fun `ssdp reply location is read case-insensitively`() {
        val reply = "HTTP/1.1 200 OK\r\nCache-Control: max-age=1800\r\nlocation: http://192.168.1.50:9197/dmr\r\nST: x\r\n\r\n"
        assertEquals("http://192.168.1.50:9197/dmr", Ssdp.parseLocation(reply))
        assertNull(Ssdp.parseLocation("NOTIFY * HTTP/1.1\r\nLOCATION: http://x/\r\n\r\n"))
    }

    @Test
    fun `didl metadata escapes the url and title`() {
        val didl = AvTransport.didl("http://h/live/a&b/42.ts", "Tom & Jerry <HD>")
        assertTrue(didl.contains("<dc:title>Tom &amp; Jerry &lt;HD&gt;</dc:title>"))
        assertTrue(didl.contains(">http://h/live/a&amp;b/42.ts</res>"))
        assertTrue(didl.contains("protocolInfo=\"http-get:*:video/mpeg:DLNA.ORG_OP=00;"))
    }

    @Test
    fun `soap faults become readable messages`() {
        val body = "<s:Envelope><s:Body><s:Fault><detail><UPnPError>" +
            "<errorCode>716</errorCode><errorDescription>Resource not found</errorDescription>" +
            "</UPnPError></detail></s:Fault></s:Body></s:Envelope>"
        assertEquals(
            "Play failed: the TV does not accept this stream (UPnP 716).",
            AvTransport.faultMessage("Play", 500, body),
        )
        assertEquals("Stop failed: HTTP 500.", AvTransport.faultMessage("Stop", 500, ""))
    }

    @Test
    fun `transport state is read from a namespaced response`() {
        val body = "<u:GetTransportInfoResponse><CurrentTransportState>PLAYING</CurrentTransportState></u:GetTransportInfoResponse>"
        assertEquals("PLAYING", AvTransport.tagValue(body, "CurrentTransportState"))
    }
}
