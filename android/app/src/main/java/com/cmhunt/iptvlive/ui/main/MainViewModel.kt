package com.cmhunt.iptvlive.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.xtream.XtreamException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

sealed interface RefreshState {
    data object Idle : RefreshState
    data object Running : RefreshState
    data class Failed(val message: String) : RefreshState
}

/** What every tab shares: the catalogue's freshness, and logging out. */
class MainViewModel(private val container: AppContainer) : ViewModel() {

    private val _refresh = MutableStateFlow<RefreshState>(RefreshState.Idle)
    val refresh: StateFlow<RefreshState> = _refresh

    /** Null until the first count arrives, so "loading" and "empty" differ. */
    val channelCount: StateFlow<Int?> = container.catalogue.channelCount
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    init {
        viewModelScope.launch {
            if (container.catalogue.isStale()) refresh()
        }
    }

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
            container.tv.disconnect()
            container.catalogue.clear()
            container.credentials.logOut()
        }
    }
}
