package com.cmhunt.iptvlive.data

/**
 * Where a channel was opened from, so channel up/down moves through the same
 * list. Travels in the player's route as a short string.
 */
object PlayContext {
    const val RECENTS = "recents"
    const val FAVOURITES = "fav"
    const val PRESETS = "presets"

    fun category(id: String) = "cat:$id"

    fun search(query: String) = if (query.isBlank()) "" else "search:${query.trim()}"

    fun categoryOf(ctx: String): String? = ctx.removePrefix("cat:").takeIf { ctx.startsWith("cat:") }

    fun queryOf(ctx: String): String? = ctx.removePrefix("search:").takeIf { ctx.startsWith("search:") }
}

/**
 * The channels channel up/down steps through, wrapping at both ends. Built
 * once when the player opens: lists like Recents reorder themselves as you
 * watch, and stepping through a list that moves under you is confusing.
 */
class ChannelQueue(ids: List<Int>, startId: Int) {

    /** The start channel is always in the queue, even if the list lost it. */
    val ids: List<Int> = if (startId in ids) ids else listOf(startId) + ids

    var index: Int = this.ids.indexOf(startId)
        private set

    val current: Int get() = ids[index]
    val size: Int get() = ids.size

    /** Next is +1, previous is -1. Returns the new channel. */
    fun step(delta: Int): Int {
        index = (index + delta).mod(ids.size)
        return current
    }
}
