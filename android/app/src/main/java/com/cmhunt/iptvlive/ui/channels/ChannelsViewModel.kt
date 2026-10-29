package com.cmhunt.iptvlive.ui.channels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.ChannelSearch
import com.cmhunt.iptvlive.data.db.ChannelEntity
import com.cmhunt.iptvlive.data.xtream.XtreamException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ChannelRow(val channel: ChannelEntity, val category: String)

data class ChannelsState(
    val rows: List<ChannelRow> = emptyList(),
    val total: Int = 0,
    val loaded: Boolean = false,
)

sealed interface RefreshState {
    data object Idle : RefreshState
    data object Running : RefreshState
    data class Failed(val message: String) : RefreshState
}

@OptIn(FlowPreview::class)
class ChannelsViewModel(private val container: AppContainer) : ViewModel() {

    val query = MutableStateFlow("")

    private val _refresh = MutableStateFlow<RefreshState>(RefreshState.Idle)
    val refresh: StateFlow<RefreshState> = _refresh

    private val index = combine(container.catalogue.channels, container.catalogue.categories) { chans, cats ->
        val names = cats.associate { it.id to it.name }
        ChannelSearch(chans.map { ChannelRow(it, names[it.categoryId].orEmpty()) }) { it.channel.name }
    }.flowOn(Dispatchers.Default)

    val state: StateFlow<ChannelsState> =
        combine(index, query.debounce(150)) { idx, q -> idx to q }
            .map { (idx, q) ->
                val total = idx.search("").size
                ChannelsState(idx.search(q), total, loaded = true)
            }
            .flowOn(Dispatchers.Default)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), ChannelsState())

    init {
        viewModelScope.launch {
            if (container.catalogue.isStale()) refresh()
        }
    }

    fun onQuery(q: String) = query.update { q }

    fun refresh() {
        if (_refresh.value == RefreshState.Running) return
        _refresh.value = RefreshState.Running
        viewModelScope.launch {
            _refresh.value = try {
                // Null only mid log-out, when there is nothing left to refresh.
                container.credentials.credentials.first()?.let { container.catalogue.refresh(it) }
                RefreshState.Idle
            } catch (e: XtreamException) {
                RefreshState.Failed(e.message ?: "Refresh failed.")
            }
        }
    }

    fun dismissError() {
        if (_refresh.value is RefreshState.Failed) _refresh.value = RefreshState.Idle
    }

    fun logOut() {
        viewModelScope.launch {
            container.catalogue.clear()
            container.credentials.logOut()
        }
    }
}
