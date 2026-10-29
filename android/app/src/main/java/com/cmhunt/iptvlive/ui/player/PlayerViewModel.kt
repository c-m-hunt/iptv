package com.cmhunt.iptvlive.ui.player

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.ChannelQueue
import com.cmhunt.iptvlive.data.ChannelSearch
import com.cmhunt.iptvlive.data.PlayContext
import com.cmhunt.iptvlive.data.db.ChannelEntity
import com.cmhunt.iptvlive.data.xtream.XtreamUrls
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** The channel on screen, and where it sits in the list up/down moves through. */
data class NowPlaying(
    val id: Int,
    val name: String,
    val url: String,
    val listLabel: String,
    val position: Int,
    val size: Int,
)

sealed interface PlayerTarget {
    data object Loading : PlayerTarget
    data class Missing(val message: String) : PlayerTarget
    data class Ready(val now: NowPlaying) : PlayerTarget
}

class PlayerViewModel(private val container: AppContainer, startId: Int, context: String) : ViewModel() {

    private val _target = MutableStateFlow<PlayerTarget>(PlayerTarget.Loading)
    val target: StateFlow<PlayerTarget> = _target

    private var byId: Map<Int, ChannelEntity> = emptyMap()
    private var queue: ChannelQueue? = null
    private var label = ""

    init {
        viewModelScope.launch {
            val all = container.catalogue.channels.first()
            byId = all.associateBy { it.id }
            val start = byId[startId]
            if (start == null) {
                _target.value = PlayerTarget.Missing("This channel is no longer in the list.")
                return@launch
            }
            val (ids, name) = resolve(context, start, all)
            queue = ChannelQueue(ids.filter { it in byId }, startId)
            label = name
            emit()
        }
    }

    /** Channel up is +1, down is -1. */
    fun step(delta: Int) {
        val q = queue ?: return
        q.step(delta)
        viewModelScope.launch { emit() }
    }

    /** Jumps to a preset, and up/down then moves through the presets. */
    fun playPreset(slot: Int) {
        viewModelScope.launch {
            val slots = container.presets.slots.first()
            val ch = slots.getOrNull(slot - 1)?.channel ?: return@launch
            queue = ChannelQueue(slots.mapNotNull { it.channel?.id }, ch.id)
            label = "Presets"
            emit()
        }
    }

    private suspend fun resolve(ctx: String, start: ChannelEntity, all: List<ChannelEntity>): Pair<List<Int>, String> {
        PlayContext.categoryOf(ctx)?.let { cat -> return inCategory(cat, all) }
        PlayContext.queryOf(ctx)?.let { q ->
            return ChannelSearch(all) { it.name }.search(q).map { it.id } to "Search \"$q\""
        }
        return when (ctx) {
            PlayContext.RECENTS -> container.recents.recents.first().map { it.channelId } to "Recent"
            PlayContext.FAVOURITES -> {
                val favs = container.favourites.ids.first()
                all.filter { it.id in favs }.map { it.id } to "Favourites"
            }
            PlayContext.PRESETS -> container.presets.slots.first().mapNotNull { it.channel?.id } to "Presets"
            // Opened without a list (the TV banner): its own category.
            else -> inCategory(start.categoryId, all)
        }
    }

    private suspend fun inCategory(categoryId: String, all: List<ChannelEntity>): Pair<List<Int>, String> =
        all.filter { it.categoryId == categoryId }.map { it.id } to
            container.catalogue.category(categoryId)?.name.orEmpty()

    private suspend fun emit() {
        val q = queue ?: return
        val ch = byId[q.current] ?: return
        val creds = container.credentials.credentials.first()
        if (creds == null) {
            _target.value = PlayerTarget.Missing("You are logged out.")
            return
        }
        _target.value = PlayerTarget.Ready(
            NowPlaying(
                id = ch.id,
                name = ch.name,
                url = XtreamUrls.liveStream(creds.streamBase, creds.username, creds.password, ch.id),
                listLabel = label,
                position = q.index + 1,
                size = q.size,
            ),
        )
    }
}
