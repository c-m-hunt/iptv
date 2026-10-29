package com.cmhunt.iptvlive.ui.channels

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.ui.tv.TvBanner
import com.cmhunt.iptvlive.ui.tv.TvButton

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelsScreen(container: AppContainer, onPlay: (Int) -> Unit) {
    val vm = viewModel { ChannelsViewModel(container) }
    val state by vm.state.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val refresh by vm.refresh.collectAsStateWithLifecycle()
    val tvState by container.tv.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var menuOpen by remember { mutableStateOf(false) }

    val failed = refresh as? RefreshState.Failed
    // With channels on screen, a failed refresh is a footnote, not a dead end.
    LaunchedEffect(failed, state.total) {
        if (failed != null && state.total > 0) {
            snackbar.showSnackbar("${failed.message} Showing the saved list.")
            vm.dismissError()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Channels") },
                actions = {
                    TvButton(container)
                    IconButton(onClick = vm::refresh) { Icon(Icons.Filled.Refresh, "Refresh channel list") }
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Filled.MoreVert, "More") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Log out") },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, null) },
                            onClick = { menuOpen = false; vm.logOut() },
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            TvBanner(
                tvState,
                onOpen = { tvState.channelId?.let(onPlay) },
                onStop = container.tv::stop,
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = query,
                onValueChange = vm::onQuery,
                placeholder = { Text("Search ${if (state.total > 0) "%,d ".format(state.total) else ""}channels") },
                leadingIcon = { Icon(Icons.Filled.Search, null) },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { vm.onQuery("") }) { Icon(Icons.Filled.Close, "Clear search") }
                    }
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Search),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )

            PullToRefreshBox(
                isRefreshing = refresh == RefreshState.Running && state.total > 0,
                onRefresh = vm::refresh,
                modifier = Modifier.fillMaxSize(),
            ) {
                when {
                    state.total == 0 && failed != null -> Message(failed.message, action = "Try again", onAction = vm::refresh)
                    state.total == 0 && (refresh == RefreshState.Running || !state.loaded) ->
                        Loading("Downloading the channel list…")
                    state.total == 0 -> Message("No channels yet.", action = "Refresh", onAction = vm::refresh)
                    state.rows.isEmpty() -> Message("No channels match \"$query\".")
                    else -> LazyColumn(Modifier.fillMaxSize()) {
                        items(state.rows, key = { it.channel.id }) { row ->
                            ChannelItem(row, onClick = { onPlay(row.channel.id) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChannelItem(row: ChannelRow, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ChannelLogo(row.channel.icon, row.channel.name)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(row.channel.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (row.category.isNotEmpty()) {
                Text(
                    row.category,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun Loading(text: String) {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(16.dp))
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Message(text: String, action: String? = null, onAction: () -> Unit = {}) {
    // A scrollable parent keeps pull-to-refresh working on an empty screen.
    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
        item {
            Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (action != null) TextButton(onClick = onAction) { Text(action) }
                }
            }
        }
    }
}
