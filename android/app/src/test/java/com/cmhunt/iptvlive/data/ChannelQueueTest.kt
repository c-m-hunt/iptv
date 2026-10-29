package com.cmhunt.iptvlive.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChannelQueueTest {

    @Test
    fun `steps wrap at both ends`() {
        val q = ChannelQueue(listOf(1, 2, 3), startId = 3)
        assertEquals(1, q.step(+1))
        assertEquals(3, q.step(-1))
        assertEquals(2, q.step(-1))
    }

    @Test
    fun `a start channel missing from the list is put first`() {
        val q = ChannelQueue(listOf(5, 6), startId = 9)
        assertEquals(listOf(9, 5, 6), q.ids)
        assertEquals(9, q.current)
        assertEquals(5, q.step(+1))
    }

    @Test
    fun `a one-channel queue stays put`() {
        val q = ChannelQueue(emptyList(), startId = 4)
        assertEquals(4, q.step(+1))
        assertEquals(4, q.step(-1))
    }

    @Test
    fun `contexts round-trip`() {
        assertEquals("12", PlayContext.categoryOf(PlayContext.category("12")))
        assertEquals("bbc one", PlayContext.queryOf(PlayContext.search(" bbc one ")))
        assertEquals("", PlayContext.search("  "))
        assertNull(PlayContext.categoryOf(PlayContext.RECENTS))
    }
}
