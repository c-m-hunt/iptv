package com.cmhunt.iptvlive.ui.channels

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.db.ChannelEntity
import com.cmhunt.iptvlive.ui.presets.PresetSlotGrid
import kotlinx.coroutines.launch

/** A channel and anything extra its list can do with it ("Remove from Recent"). */
data class ChannelActions(val channel: ChannelEntity, val extra: List<Pair<String, suspend () -> Unit>> = emptyList())

/** Long-press menu for a channel, wherever it is listed. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelActionsSheet(container: AppContainer, actions: ChannelActions, onDismiss: () -> Unit) {
    val channel = actions.channel
    val favourites by container.favourites.ids.collectAsStateWithLifecycle(emptySet())
    val slots by container.presets.slots.collectAsStateWithLifecycle(emptyList())
    var choosingSlot by remember { mutableStateOf(false) }
    val isFavourite = channel.id in favourites

    // App scope: the sheet leaves the screen as soon as an action is chosen.
    fun run(action: suspend () -> Unit) {
        container.appScope.launch { action() }
        onDismiss()
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(bottom = 16.dp),
        ) {
            Row(Modifier.padding(horizontal = 24.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                ChannelLogo(channel.icon, channel.name)
                Spacer(Modifier.width(14.dp))
                Text(channel.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Item(
                if (isFavourite) "Remove from favourites" else "Add to favourites",
                { Icon(if (isFavourite) Icons.Filled.Star else Icons.Filled.StarBorder, null) },
            ) { run { container.favourites.toggle(channel.id) } }
            Item("Save to a preset", { Icon(Icons.Filled.Bookmark, null) }) { choosingSlot = !choosingSlot }
            if (choosingSlot) {
                PresetSlotGrid(
                    slots,
                    currentChannelId = channel.id,
                    onChoose = { slot -> run { container.presets.save(slot, channel.id) } },
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                )
            }
            for ((label, action) in actions.extra) {
                Item(label, { Icon(Icons.Filled.Delete, null) }) { run(action) }
            }
        }
    }
}

@Composable
private fun Item(text: String, icon: @Composable () -> Unit, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(text) },
        leadingContent = icon,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable(onClick = onClick),
    )
}
