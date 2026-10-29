package com.cmhunt.iptvlive.ui.player

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.xtream.XtreamUrls
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

sealed interface PlayerTarget {
    data object Loading : PlayerTarget
    data class Missing(val message: String) : PlayerTarget
    data class Ready(val name: String, val url: String) : PlayerTarget
}

class PlayerViewModel(container: AppContainer, channelId: Int) : ViewModel() {

    private val _target = MutableStateFlow<PlayerTarget>(PlayerTarget.Loading)
    val target: StateFlow<PlayerTarget> = _target

    init {
        viewModelScope.launch {
            val channel = container.catalogue.channel(channelId)
            val creds = container.credentials.credentials.first()
            _target.value = when {
                channel == null -> PlayerTarget.Missing("This channel is no longer in the list.")
                creds == null -> PlayerTarget.Missing("You are logged out.")
                else -> PlayerTarget.Ready(
                    channel.name,
                    XtreamUrls.liveStream(creds.streamBase, creds.username, creds.password, channel.id),
                )
            }
        }
    }
}
