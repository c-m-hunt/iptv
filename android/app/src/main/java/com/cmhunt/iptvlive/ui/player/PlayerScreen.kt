package com.cmhunt.iptvlive.ui.player

import android.app.Activity
import android.content.pm.ActivityInfo
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
import com.cmhunt.iptvlive.ui.tv.TvButton
import com.cmhunt.iptvlive.ui.tv.TvPanel
import kotlinx.coroutines.delay

private const val CONTROLS_HIDE_MS = 4_000L

@Composable
fun PlayerScreen(container: AppContainer, channelId: Int, onBack: () -> Unit) {
    val vm = viewModel(key = "player-$channelId") { PlayerViewModel(container, channelId) }
    val target by vm.target.collectAsStateWithLifecycle()
    val tvState by container.tv.state.collectAsStateWithLifecycle()

    // With a TV selected the channel goes there and this screen is its remote.
    // Choosing a TV mid-playback lands here too: the local player is disposed,
    // which frees its connection before the TV asks for one.
    if (tvState.device != null) {
        LaunchedEffect(channelId, tvState.device) {
            if (container.tv.state.value.channelId != channelId) container.tv.play(channelId)
        }
        TvPanel(container, channelId, onBack)
        return
    }

    FullScreenLandscape()

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when (val t = target) {
            PlayerTarget.Loading -> Unit
            is PlayerTarget.Missing -> Centered { Text(t.message, color = Color.White) }
            is PlayerTarget.Ready -> LivePlayer(container, t, onBack)
        }
    }
}

@Composable
private fun LivePlayer(container: AppContainer, target: PlayerTarget.Ready, onBack: () -> Unit) {
    val context = LocalContext.current
    var player by remember { mutableStateOf<StreamPlayer?>(null) }

    // Built on start and released on stop: a backgrounded app must not hold
    // one of the account's connections.
    LifecycleStartEffect(target.url) {
        val p = StreamPlayer(context, container.http).also { it.play(target.url) }
        player = p
        onStopOrDispose {
            p.release()
            player = null
        }
    }

    val ui = player?.ui?.collectAsState()?.value ?: PlaybackUi()
    var showControls by remember { mutableStateOf(true) }
    var touches by remember { mutableIntStateOf(0) }
    LaunchedEffect(showControls, touches) {
        if (showControls) {
            delay(CONTROLS_HIDE_MS)
            showControls = false
        }
    }

    Box(
        Modifier
            .fillMaxSize()
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

        AnimatedVisibility(
            visible = showControls || ui.error != null,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.TopStart).fillMaxWidth(),
        ) {
            TopBar(target.name, ui.unsupportedAudio, onBack) { TvButton(container, tint = Color.White) }
        }
    }
}

@Composable
private fun TopBar(name: String, unsupportedAudio: String?, onBack: () -> Unit, actions: @Composable () -> Unit) {
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
                    name,
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium,
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
