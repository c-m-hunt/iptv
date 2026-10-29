package com.cmhunt.iptvlive.ui.home

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.ui.channels.ChannelItem
import com.cmhunt.iptvlive.ui.channels.ChannelRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class HomeViewModel(private val container: AppContainer) : ViewModel() {

    /** Recent channels, newest first. Channels gone from the catalogue are skipped. */
    val recents: StateFlow<List<ChannelRow>?> =
        combine(container.recents.recents, container.catalogue.channels, container.catalogue.categories) { recent, chans, cats ->
            val byId = chans.associateBy { it.id }
            val catNames = cats.associate { it.id to it.name }
            val now = System.currentTimeMillis()
            recent.mapNotNull { r ->
                val ch = byId[r.channelId] ?: return@mapNotNull null
                val ago = if (now - r.watchedAt < DateUtils.MINUTE_IN_MILLIS) "Just now"
                else DateUtils.getRelativeTimeSpanString(r.watchedAt, now, DateUtils.MINUTE_IN_MILLIS)
                ChannelRow(ch, listOf(catNames[ch.categoryId].orEmpty(), ago.toString()).filter { it.isNotEmpty() }.joinToString(" · "))
            }
        }
            .flowOn(Dispatchers.Default)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    fun clear() {
        viewModelScope.launch { container.recents.clear() }
    }
}

@Composable
fun HomeScreen(container: AppContainer, onPlay: (Int) -> Unit) {
    val vm = viewModel { HomeViewModel(container) }
    val recents by vm.recents.collectAsStateWithLifecycle()
    val rows = recents ?: return

    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Recent channels", style = MaterialTheme.typography.titleMedium)
                if (rows.isNotEmpty()) TextButton(onClick = vm::clear) { Text("Clear") }
            }
        }
        if (rows.isEmpty()) {
            item {
                Text(
                    "Channels you watch show here. Find one in Categories or Search.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
        items(rows, key = { it.channel.id }) { row ->
            ChannelItem(row, onClick = { onPlay(row.channel.id) })
        }
    }
}
