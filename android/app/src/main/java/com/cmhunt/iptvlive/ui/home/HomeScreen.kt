package com.cmhunt.iptvlive.ui.home

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.PlayContext
import com.cmhunt.iptvlive.data.PresetSlot
import com.cmhunt.iptvlive.ui.channels.ChannelActions
import com.cmhunt.iptvlive.ui.channels.ChannelActionsSheet
import com.cmhunt.iptvlive.ui.channels.ChannelItem
import com.cmhunt.iptvlive.ui.channels.ChannelRow
import com.cmhunt.iptvlive.ui.presets.PresetBar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class HomeViewModel(private val container: AppContainer) : ViewModel() {

    val presets: StateFlow<List<PresetSlot>> = container.presets.slots
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val favourites: StateFlow<List<ChannelRow>> =
        combine(container.favourites.channels, container.catalogue.categories) { chans, cats ->
            val catNames = cats.associate { it.id to it.name }
            chans.map { ChannelRow(it, catNames[it.categoryId].orEmpty(), favourite = true) }
        }
            .flowOn(Dispatchers.Default)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /** Recent channels, newest first. Channels gone from the catalogue are skipped. */
    val recents: StateFlow<List<ChannelRow>?> =
        combine(
            container.recents.recents,
            container.catalogue.channels,
            container.catalogue.categories,
            container.favourites.ids,
        ) { recent, chans, cats, favs ->
            val byId = chans.associateBy { it.id }
            val catNames = cats.associate { it.id to it.name }
            val now = System.currentTimeMillis()
            recent.mapNotNull { r ->
                val ch = byId[r.channelId] ?: return@mapNotNull null
                val ago = if (now - r.watchedAt < DateUtils.MINUTE_IN_MILLIS) "Just now"
                else DateUtils.getRelativeTimeSpanString(r.watchedAt, now, DateUtils.MINUTE_IN_MILLIS)
                val detail = listOf(catNames[ch.categoryId].orEmpty(), ago.toString()).filter { it.isNotEmpty() }
                ChannelRow(ch, detail.joinToString(" · "), favourite = ch.id in favs)
            }
        }
            .flowOn(Dispatchers.Default)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    fun clearRecents() {
        viewModelScope.launch { container.recents.clear() }
    }
}

@Composable
fun HomeScreen(container: AppContainer, onPlay: (Int, String) -> Unit) {
    val vm = viewModel { HomeViewModel(container) }
    val presets by vm.presets.collectAsStateWithLifecycle()
    val favourites by vm.favourites.collectAsStateWithLifecycle()
    val recents by vm.recents.collectAsStateWithLifecycle()
    var actions by remember { mutableStateOf<ChannelActions?>(null) }
    val recentRows = recents ?: return

    LazyColumn(Modifier.fillMaxSize()) {
        item { Header("Presets") }
        item {
            PresetBar(
                presets,
                onPlay = { onPlay(it.id, PlayContext.PRESETS) },
                onLongPress = { slot ->
                    slot.channel?.let { ch ->
                        actions = ChannelActions(ch, listOf("Remove from preset ${slot.number}" to { container.presets.remove(slot.number) }))
                    }
                },
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
        if (presets.none { it.channel != null }) {
            item { Hint("Long-press any channel and choose \"Save to a preset\", or use the bookmark in the player.") }
        }

        item { Header("Favourites") }
        if (favourites.isEmpty()) {
            item { Hint("Long-press a channel, or tap the star in the player, to add a favourite.") }
        }
        items(favourites, key = { "fav-${it.channel.id}" }) { row ->
            ChannelItem(
                row,
                onClick = { onPlay(row.channel.id, PlayContext.FAVOURITES) },
                onLongClick = { actions = ChannelActions(row.channel) },
            )
        }

        item {
            Header("Recent channels") {
                if (recentRows.isNotEmpty()) TextButton(onClick = vm::clearRecents) { Text("Clear") }
            }
        }
        if (recentRows.isEmpty()) {
            item { Hint("Channels you watch show here. Find one in Categories or Search.") }
        }
        items(recentRows, key = { "recent-${it.channel.id}" }) { row ->
            ChannelItem(
                row,
                onClick = { onPlay(row.channel.id, PlayContext.RECENTS) },
                onLongClick = {
                    actions = ChannelActions(row.channel, listOf("Remove from recent" to { container.recents.remove(row.channel.id) }))
                },
            )
        }
    }

    actions?.let { ChannelActionsSheet(container, it, onDismiss = { actions = null }) }
}

@Composable
private fun Header(text: String, action: @Composable () -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 16.dp, end = 4.dp, top = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(text, style = MaterialTheme.typography.titleMedium)
        action()
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
    )
}
