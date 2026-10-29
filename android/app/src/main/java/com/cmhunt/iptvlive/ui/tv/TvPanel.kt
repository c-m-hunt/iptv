package com.cmhunt.iptvlive.ui.tv

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ConnectedTv
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.tv.TvMode
import com.cmhunt.iptvlive.tv.TvState
import com.cmhunt.iptvlive.tv.TvStatus

fun TvStatus.label(): String = when (this) {
    TvStatus.Idle -> "Ready"
    is TvStatus.Starting -> step
    is TvStatus.Playing -> if (mode == TvMode.Relay) "Playing through this phone" else "Playing"
    TvStatus.Stopped -> "Stopped"
    is TvStatus.Failed -> message
}

/** The player screen while a TV is selected: remote-control style, no video. */
@Composable
fun TvPanel(container: AppContainer, channelId: Int, onBack: () -> Unit) {
    val tv = container.tv
    val state by tv.state.collectAsStateWithLifecycle()
    val device = state.device ?: return

    Box(Modifier.fillMaxSize().safeDrawingPadding()) {
        IconButton(onClick = onBack, modifier = Modifier.padding(8.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
        }
        Column(
            Modifier.fillMaxSize().padding(32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(Icons.Filled.ConnectedTv, null, Modifier.size(72.dp), tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(16.dp))
            Text("Playing on ${device.name}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            Text(
                state.channelName.ifEmpty { "…" },
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(16.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (state.status is TvStatus.Starting) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    state.status.label(),
                    color = if (state.status is TvStatus.Failed) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurface,
                    textAlign = TextAlign.Center,
                )
            }
            Spacer(Modifier.height(24.dp))
            when (state.status) {
                is TvStatus.Playing, is TvStatus.Starting -> OutlinedButton(onClick = tv::stop) {
                    Icon(Icons.Filled.Stop, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Stop")
                }
                else -> Button(onClick = { tv.play(channelId) }) { Text("Play on TV") }
            }
            TextButton(onClick = tv::disconnect) { Text("Watch on this phone instead") }
        }
    }
}

/** A strip for the channel list: what the TV is playing, with a stop button. */
@Composable
fun TvBanner(state: TvState, onOpen: () -> Unit, onStop: () -> Unit) {
    val device = state.device ?: return
    if (state.channelId == null) return
    Surface(color = MaterialTheme.colorScheme.primaryContainer) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onOpen)
                .background(MaterialTheme.colorScheme.primaryContainer)
                // The colour runs under the gesture bar; the text stays above it.
                .navigationBarsPadding()
                .padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.ConnectedTv, null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    state.channelName,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${device.name} · ${state.status.label()}",
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (state.status is TvStatus.Playing || state.status is TvStatus.Starting) {
                IconButton(onClick = onStop) {
                    Icon(Icons.Filled.Stop, "Stop on TV", tint = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
        }
    }
}
