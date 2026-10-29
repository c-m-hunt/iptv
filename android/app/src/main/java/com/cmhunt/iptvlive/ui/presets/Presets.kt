package com.cmhunt.iptvlive.ui.presets

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.cmhunt.iptvlive.data.PresetSlot
import com.cmhunt.iptvlive.data.db.ChannelEntity
import com.cmhunt.iptvlive.ui.channels.ChannelLogo
import com.cmhunt.iptvlive.ui.channels.shortName

/** Home's row of nine tiles: tap to play, long-press for the channel's actions. */
@Composable
fun PresetBar(
    slots: List<PresetSlot>,
    onPlay: (ChannelEntity) -> Unit,
    onLongPress: (PresetSlot) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
    ) {
        items(slots, key = { it.number }) { slot ->
            val ch = slot.channel
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = if (ch != null) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent,
                border = if (ch == null) BorderStroke(1.dp, MaterialTheme.colorScheme.surfaceVariant) else null,
                modifier = Modifier
                    .width(96.dp)
                    .height(108.dp)
                    .combinedClickable(
                        enabled = ch != null,
                        onClick = { ch?.let(onPlay) },
                        onLongClick = { onLongPress(slot) },
                    ),
            ) {
                Box(Modifier.padding(8.dp)) {
                    Text(
                        "${slot.number}",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold,
                        color = if (ch != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Column(
                        Modifier.fillMaxWidth().align(Alignment.Center).padding(top = 10.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        if (ch != null) {
                            ChannelLogo(ch.icon, ch.name, size = 40.dp)
                            Spacer(Modifier.height(6.dp))
                            Text(
                                shortName(ch.name),
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = TextAlign.Center,
                            )
                        } else {
                            Text("Empty", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

/** 3 x 3 slot picker for "Save to a preset": shows what each slot holds now. */
@Composable
fun PresetSlotGrid(
    slots: List<PresetSlot>,
    currentChannelId: Int,
    onChoose: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        slots.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { slot ->
                    val here = slot.channel?.id == currentChannelId
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = if (here) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
                        modifier = Modifier
                            .weight(1f)
                            .height(64.dp)
                            .combinedClickable(onClick = { onChoose(slot.number) }),
                    ) {
                        Column(Modifier.padding(8.dp)) {
                            Text("${slot.number}", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                            Text(
                                slot.channel?.let { shortName(it.name) } ?: "Empty",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The filled presets as small chips, for the player and the TV panel. */
@Composable
fun PresetStrip(
    slots: List<PresetSlot>,
    currentChannelId: Int?,
    onChoose: (Int) -> Unit,
    modifier: Modifier = Modifier,
    onDark: Boolean = false,
) {
    val filled = slots.filter { it.channel != null }
    if (filled.isEmpty()) return
    Row(
        modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        filled.forEach { slot ->
            val selected = slot.channel?.id == currentChannelId
            Surface(
                shape = RoundedCornerShape(16.dp),
                color = when {
                    selected -> MaterialTheme.colorScheme.primary
                    onDark -> Color.Black.copy(alpha = 0.6f)
                    else -> MaterialTheme.colorScheme.surfaceContainerHigh
                },
                contentColor = when {
                    selected -> MaterialTheme.colorScheme.onPrimary
                    onDark -> Color.White
                    else -> MaterialTheme.colorScheme.onSurface
                },
                modifier = Modifier.combinedClickable(onClick = { onChoose(slot.number) }),
            ) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${slot.number}", fontWeight = FontWeight.Bold)
                    Spacer(Modifier.size(6.dp))
                    Text(shortName(slot.channel!!.name), maxLines = 1)
                }
            }
        }
    }
}
