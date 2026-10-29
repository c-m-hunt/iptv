package com.cmhunt.iptvlive.ui.categories

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
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
import com.cmhunt.iptvlive.ui.tv.TvBanner
import com.cmhunt.iptvlive.ui.tv.TvButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn

data class CategoryState(val name: String = "", val rows: List<ChannelRow> = emptyList(), val total: Int = 0)

@OptIn(FlowPreview::class)
class CategoryChannelsViewModel(container: AppContainer, categoryId: String) : ViewModel() {
    val query = MutableStateFlow("")

    private val name = flow { emit(container.catalogue.category(categoryId)?.name.orEmpty()) }

    // Every row is in the same category, so the second line stays empty.
    private val index = combine(container.catalogue.channelsIn(categoryId), container.favourites.ids) { list, favs ->
        ChannelSearch(list.map { ChannelRow(it, "", it.id in favs) }) { it.channel.name }
    }

    val state: StateFlow<CategoryState> =
        combine(name, index, query.debounce(100)) { n, idx, q -> CategoryState(n, idx.search(q), idx.search("").size) }
            .flowOn(Dispatchers.Default)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), CategoryState())
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CategoryChannelsScreen(container: AppContainer, categoryId: String, onBack: () -> Unit, onPlay: (Int, String) -> Unit) {
    val vm = viewModel(key = "category-$categoryId") { CategoryChannelsViewModel(container, categoryId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val tvState by container.tv.state.collectAsStateWithLifecycle()
    var actions by remember { mutableStateOf<ChannelActions?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
                actions = { TvButton(container) },
            )
        },
        bottomBar = {
            TvBanner(tvState, onOpen = { tvState.channelId?.let { onPlay(it, "") } }, onStop = container.tv::stop)
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SearchField(query, { vm.query.value = it }, "Search ${countLabel(state.total, "channel", "channels")}")
            if (state.rows.isEmpty() && query.isNotBlank()) {
                Message("No channels match \"$query\".")
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(state.rows, key = { it.channel.id }) { row ->
                        ChannelItem(
                            row,
                            onClick = { onPlay(row.channel.id, PlayContext.category(categoryId)) },
                            onLongClick = { actions = ChannelActions(row.channel) },
                        )
                    }
                }
            }
        }
    }

    actions?.let { ChannelActionsSheet(container, it, onDismiss = { actions = null }) }
}
