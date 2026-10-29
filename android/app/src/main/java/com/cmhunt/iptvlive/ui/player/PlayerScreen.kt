package com.cmhunt.iptvlive.ui.player

import android.app.Activity
import android.content.pm.ActivityInfo
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.RecentsRepository
import com.cmhunt.iptvlive.ui.presets.PresetSlotGrid
import com.cmhunt.iptvlive.ui.presets.PresetStrip
import com.cmhunt.iptvlive.ui.tv.TvIcon
import com.cmhunt.iptvlive.ui.tv.TvPanel
import com.cmhunt.iptvlive.ui.tv.TvPickerSheet
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

private const val CONTROLS_HIDE_MS = 4_000L

/** What's open over the player; while anything is, the controls stay up. */
private enum class Modal { None, TvPicker, SavePreset }

@Composable
fun PlayerScreen(container: AppContainer, channelId: Int, context: String, onBack: () -> Unit) {
    val vm = viewModel(key = "player-$channelId-$context") { PlayerViewModel(container, channelId, context) }
    val target by vm.target.collectAsStateWithLifecycle()
    val tvState by container.tv.state.collectAsStateWithLifecycle()

    // With a TV selected the channel goes there and this screen is its remote.
    // Choosing a TV mid-playback lands here too: the local player is disposed,
    // which frees its connection before the TV asks for one.
    if (tvState.device != null) {
        val now = (target as? PlayerTarget.Ready)?.now
        LaunchedEffect(now?.id, tvState.device) {
            if (now != null && container.tv.state.value.channelId != now.id) container.tv.play(now.id)
        }
        TvPanel(container, now, onBack, onStep = vm::step, onPreset = vm::playPreset)
        return
    }

    FullScreenLandscape()

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when (val t = target) {
            PlayerTarget.Loading -> Unit
            is PlayerTarget.Missing -> Centered { Text(t.message, color = Color.White) }
            is PlayerTarget.Ready -> LivePlayer(container, t.now, vm, onBack)
        }
    }
}

@Composable
private fun LivePlayer(container: AppContainer, now: NowPlaying, vm: PlayerViewModel, onBack: () -> Unit) {
    val context = LocalContext.current
    var player by remember { mutableStateOf<StreamPlayer?>(null) }

    // Built on start and released on stop: a backgrounded app must not hold
    // one of the account's connections. Kept across channel changes, which
    // only swap the stream, so changing channel doesn't rebuild the decoder.
    LifecycleStartEffect(Unit) {
        val p = StreamPlayer(context, container.http)
        player = p
        onStopOrDispose {
            p.release()
            player = null
        }
    }
    // Effects use this snapshot, never `player` itself: a coroutine reads
    // state when it runs, so an effect keyed on a null player would already
    // see the new one, play, and then run again for the key change.
    val current = player
    LaunchedEffect(current, now.url) { current?.play(now.url) }

    val idle = remember { MutableStateFlow(PlaybackUi()) }
    val ui by (current?.ui ?: idle).collectAsState()

    // Counts time actually playing, not buffering, before it goes in Recents.
    LaunchedEffect(current, now.id) {
        val p = current ?: return@LaunchedEffect
        var playedMs = 0L
        while (playedMs < RecentsRepository.WATCHED_AFTER_MS) {
            delay(1_000)
            if (p.exo.isPlaying) playedMs += 1_000
        }
        container.recents.markWatched(now.id)
    }

    val favourites by container.favourites.ids.collectAsStateWithLifecycle(emptySet())
    val slots by container.presets.slots.collectAsStateWithLifecycle(emptyList())

    var showControls by remember { mutableStateOf(true) }
    var touches by remember { mutableIntStateOf(0) }
    var modal by remember { mutableStateOf(Modal.None) }
    fun poke() {
        showControls = true
        touches++
    }
    // A new channel shows its name for a moment.
    LaunchedEffect(now.id) { poke() }
    LaunchedEffect(showControls, touches, modal) {
        if (showControls && modal == Modal.None) {
            delay(CONTROLS_HIDE_MS)
            showControls = false
        }
    }

    // Keys, for keyboards and TV remotes: up/down and CH+/- change channel,
    // 1-9 jump to a preset, centre/enter shows the controls.
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    Box(
        Modifier
            .fillMaxSize()
            .focusRequester(focus)
            .focusable()
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                val preset = PRESET_KEYS.indexOf(e.key)
                when {
                    e.key in NEXT_KEYS -> vm.step(+1)
                    e.key in PREVIOUS_KEYS -> vm.step(-1)
                    preset >= 0 -> vm.playPreset(preset + 1)
                    e.key == Key.DirectionCenter || e.key == Key.Enter -> poke()
                    else -> return@onKeyEvent false
                }
                true
            }
            // Swipe up for the next channel, down for the previous one.
            .pointerInput(Unit) {
                val threshold = 64.dp.toPx()
                var dragged = 0f
                detectVerticalDragGestures(
                    onDragStart = { dragged = 0f },
                    onDragEnd = {
                        when {
                            dragged < -threshold -> vm.step(+1)
                            dragged > threshold -> vm.step(-1)
                        }
                    },
                ) { change, dy ->
                    change.consume()
                    dragged += dy
                }
            }
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                showControls = !showControls
                touches++
            },
    ) {
        AndroidView(
            factory = {
                PlayerView(it).apply {
                    useController = false
                    keepScreenOn = true
                    setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                }
            },
            update = { it.player = player?.exo },
            modifier = Modifier.fillMaxSize(),
        )

        when {
            ui.error != null -> ErrorCard(ui, onRetry = { player?.retry() })
            ui.buffering -> Centered { CircularProgressIndicator(color = Color.White) }
        }

        val visible = showControls || ui.error != null
        AnimatedVisibility(visible, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopStart).fillMaxWidth()) {
            TopBar(now, ui.unsupportedAudio, onBack) {
                val fav = now.id in favourites
                IconButton(onClick = { container.appScope.launch { container.favourites.toggle(now.id) }; poke() }) {
                    Icon(
                        if (fav) Icons.Filled.Star else Icons.Filled.StarBorder,
                        if (fav) "Remove from favourites" else "Add to favourites",
                        tint = if (fav) MaterialTheme.colorScheme.primary else Color.White,
                    )
                }
                IconButton(onClick = { modal = Modal.SavePreset }) {
                    Icon(Icons.Filled.Bookmark, "Save to a preset", tint = Color.White)
                }
                TvIcon(container, onClick = { modal = Modal.TvPicker }, tint = Color.White)
            }
        }
        AnimatedVisibility(visible, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.CenterEnd)) {
            Column(
                Modifier.safeDrawingPadding().padding(end = 12.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                RoundButton({ vm.step(+1); poke() }) { Icon(Icons.Filled.KeyboardArrowUp, "Next channel", tint = Color.White) }
                RoundButton({ vm.step(-1); poke() }) { Icon(Icons.Filled.KeyboardArrowDown, "Previous channel", tint = Color.White) }
            }
        }
        AnimatedVisibility(visible, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.BottomStart).fillMaxWidth()) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.7f))))
                    .safeDrawingPadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            ) {
                PresetStrip(slots, now.id, onChoose = { vm.playPreset(it); poke() }, onDark = true)
            }
        }
    }

    // Outside the overlay, which hides itself after a few seconds.
    when (modal) {
        Modal.TvPicker -> TvPickerSheet(container, onDismiss = { modal = Modal.None })
        Modal.SavePreset -> AlertDialog(
            onDismissRequest = { modal = Modal.None },
            title = { Text("Save to a preset") },
            text = {
                PresetSlotGrid(slots, currentChannelId = now.id, onChoose = { slot ->
                    container.appScope.launch { container.presets.save(slot, now.id) }
                    modal = Modal.None
                })
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { modal = Modal.None }) { Text("Cancel") } },
        )
        Modal.None -> Unit
    }
}

private val NEXT_KEYS = setOf(Key.DirectionUp, Key.ChannelUp, Key.PageUp)
private val PREVIOUS_KEYS = setOf(Key.DirectionDown, Key.ChannelDown, Key.PageDown)
private val PRESET_KEYS = listOf(Key.One, Key.Two, Key.Three, Key.Four, Key.Five, Key.Six, Key.Seven, Key.Eight, Key.Nine)

@Composable
private fun RoundButton(onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier.background(Color.Black.copy(alpha = 0.5f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        IconButton(onClick = onClick) { content() }
    }
}

@Composable
private fun TopBar(now: NowPlaying, unsupportedAudio: String?, onBack: () -> Unit, actions: @Composable () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent)))
            .safeDrawingPadding()
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
            }
            Column(Modifier.weight(1f)) {
                Text(
                    now.name,
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    listOf(now.listLabel, "${now.position} / ${now.size}").filter { it.isNotBlank() }.joinToString(" · "),
                    color = Color.White.copy(alpha = 0.7f),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (unsupportedAudio != null) {
                    Text(
                        "No sound: this device cannot decode $unsupportedAudio audio.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            actions()
        }
    }
}

@Composable
private fun ErrorCard(ui: PlaybackUi, onRetry: () -> Unit) {
    Centered {
        Column(
            Modifier
                .widthIn(max = 420.dp)
                .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(12.dp))
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(ui.error.orEmpty(), color = Color.White, textAlign = TextAlign.Center)
            if (ui.retrying) {
                Text("Retrying…", color = Color.White.copy(alpha = 0.7f))
            } else {
                Button(onClick = onRetry) { Text("Try again") }
            }
        }
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}

/** Landscape with the system bars hidden while the player is on screen. */
@Composable
private fun FullScreenLandscape() {
    val view = LocalView.current
    DisposableEffect(Unit) {
        val activity = view.context as? Activity ?: return@DisposableEffect onDispose {}
        val bars = WindowCompat.getInsetsController(activity.window, view)
        val previous = activity.requestedOrientation
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        bars.hide(WindowInsetsCompat.Type.systemBars())
        onDispose {
            activity.requestedOrientation = previous
            bars.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
