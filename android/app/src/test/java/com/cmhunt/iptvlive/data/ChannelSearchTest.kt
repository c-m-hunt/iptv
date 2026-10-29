package com.cmhunt.iptvlive.data

import org.junit.Assert.assertEquals
import org.junit.Test

class ChannelSearchTest {
    private val search = ChannelSearch(listOf("UK: BBC One HD", "UK: BBC Two", "US: HBO HD", "UK: ITV1 HD")) { it }

    @Test
    fun `empty query returns everything`() = assertEquals(4, search.search("  ").size)

    @Test
    fun `every word must match, in any order`() =
        assertEquals(listOf("UK: BBC One HD"), search.search("hd bbc"))

    @Test
    fun `match is case insensitive`() = assertEquals(listOf("UK: ITV1 HD"), search.search("itv"))
}
