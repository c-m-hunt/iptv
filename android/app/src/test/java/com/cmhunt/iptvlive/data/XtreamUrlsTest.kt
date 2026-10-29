package com.cmhunt.iptvlive.data

import com.cmhunt.iptvlive.data.xtream.XtreamUrls
import org.junit.Assert.assertEquals
import org.junit.Test

class XtreamUrlsTest {

    @Test
    fun `portal accepts a bare host`() =
        assertEquals("http://tv.example.com:8080", XtreamUrls.normalisePortal(" tv.example.com:8080/ "))

    @Test
    fun `portal strips a pasted player_api url`() =
        assertEquals(
            "https://tv.example.com",
            XtreamUrls.normalisePortal("https://tv.example.com/player_api.php?username=a&password=b"),
        )

    @Test
    fun `stream base prefers the override`() =
        assertEquals(
            "http://edge.example.com:25461",
            XtreamUrls.resolveStreamBase("http://p", "edge.example.com:25461", "srv", "80", "443", "http"),
        )

    @Test
    fun `stream base comes from server_info`() {
        assertEquals("http://srv.example.com:8080", XtreamUrls.resolveStreamBase("http://p", "", "srv.example.com", "8080", "", "http"))
        assertEquals("http://srv.example.com", XtreamUrls.resolveStreamBase("http://p", "", "srv.example.com", "80", "", "http"))
        assertEquals("https://srv.example.com:8443", XtreamUrls.resolveStreamBase("http://p", "", "srv.example.com", "80", "8443", "https"))
    }

    @Test
    fun `stream base falls back to the portal`() =
        assertEquals("http://p:1", XtreamUrls.resolveStreamBase("http://p:1", "", "", null, null, null))

    @Test
    fun `live url encodes credentials as path segments`() =
        assertEquals(
            "http://s/live/a%20b/p%2Fw%40d/42.ts",
            XtreamUrls.liveStream("http://s", "a b", "p/w@d", 42),
        )
}
