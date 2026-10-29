package com.cmhunt.iptvlive.data.dlna

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Real multicast discovery. Needs a renderer on the network, e.g.
 * `node dev/mock-dlna-renderer.mjs`, so it only runs with DLNA_LIVE_TEST=1.
 */
class SsdpLiveTest {
    @Test
    fun `finds a renderer on the network`() = runBlocking {
        assumeTrue(System.getenv("DLNA_LIVE_TEST") == "1")
        val found = Ssdp.discover()
        println("SSDP found: $found")
        assertTrue(found.any { it.endsWith("/dmr") })
    }
}
