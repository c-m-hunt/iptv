package com.cmhunt.iptvlive.ui.search

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.ChannelSearch
import com.cmhunt.iptvlive.data.PlayContext
import com.cmhunt.iptvlive.ui.channels.ChannelActions
import com.cmhunt.iptvlive.ui.channels.ChannelActionsSheet
import com.cmhunt.iptvlive.ui.channels.ChannelItem
import com.cmhunt.iptvlive.ui.channels.ChannelRow
import com.cmhunt.iptvlive.ui.channels.Message
import com.cmhunt.iptvlive.ui.channels.SearchField
import com.cmhunt.iptvlive.ui.channels.countLabel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn

data class SearchState(val rows: List<ChannelRow> = emptyList(), val total: Int = 0)

@OptIn(FlowPreview::class)
class SearchViewModel(container: AppContainer) : ViewModel() {
    val query = MutableStateFlow("")

    private val index = combine(
        container.catalogue.channels,
        container.catalogue.categories,
        container.favourites.ids,
    ) { chans, cats, favs ->
        val names = cats.associate { it.id to it.name }
        ChannelSearch(chans.map { ChannelRow(it, names[it.categoryId].orEmpty(), it.id in favs) }) { it.channel.name }
    }.flowOn(Dispatchers.Default)

    val state: StateFlow<SearchState> =
        combine(index, query.debounce(150)) { idx, q -> SearchState(idx.search(q), idx.search("").size) }
            .flowOn(Dispatchers.Default)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), SearchState())
}

/** Every channel, filtered by all the words typed: the portal's own search doesn't work. */
@Composable
fun SearchScreen(container: AppContainer, onPlay: (Int, String) -> Unit) {
    val vm = viewModel { SearchViewModel(container) }
    val state by vm.state.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val focus = remember { FocusRequester() }
    var actions by remember { mutableStateOf<ChannelActions?>(null) }

    // Opening the Search tab means typing; returning to a search means reading it.
    LaunchedEffect(Unit) { if (vm.query.value.isEmpty()) focus.requestFocus() }

    Column(Modifier.fillMaxSize()) {
        SearchField(
            query,
            { vm.query.value = it },
            "Search ${countLabel(state.total, "channel", "channels")}",
            Modifier.focusRequester(focus),
        )
        if (state.rows.isEmpty() && query.isNotBlank()) {
            Message("No channels match \"$query\".")
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(state.rows, key = { it.channel.id }) { row ->
                    ChannelItem(
                        row,
                        // Up/down then steps through these results.
                        onClick = { onPlay(row.channel.id, PlayContext.search(query)) },
                        onLongClick = { actions = ChannelActions(row.channel) },
                    )
                }
            }
        }
    }

    actions?.let { ChannelActionsSheet(container, it, onDismiss = { actions = null }) }
}
