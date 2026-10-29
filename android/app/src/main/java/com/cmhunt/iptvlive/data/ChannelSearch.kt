package com.cmhunt.iptvlive.data

/**
 * Local channel search. The portal ignores `&search=`, so the whole catalogue
 * is filtered here. A channel matches when its name contains every word typed,
 * in any order — "bbc hd" finds "UK: BBC One HD".
 */
class ChannelSearch<T>(private val items: List<T>, name: (T) -> String) {

    // Lower-cased once per catalogue rather than once per keystroke.
    private val names = items.map { name(it).lowercase() }

    fun search(query: String): List<T> {
        val tokens = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return items
        return items.filterIndexed { i, _ -> tokens.all { names[i].contains(it) } }
    }
}
