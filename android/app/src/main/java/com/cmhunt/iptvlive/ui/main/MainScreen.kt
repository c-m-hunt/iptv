package com.cmhunt.iptvlive.ui.main

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.systemBars
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.ui.categories.CategoriesScreen
import com.cmhunt.iptvlive.ui.channels.Loading
import com.cmhunt.iptvlive.ui.channels.Message
import com.cmhunt.iptvlive.ui.home.HomeScreen
import com.cmhunt.iptvlive.ui.search.SearchScreen
import com.cmhunt.iptvlive.ui.tv.TvBanner
import com.cmhunt.iptvlive.ui.tv.TvButton

enum class Tab(val label: String, val icon: ImageVector) {
    Home("Home", Icons.Filled.Home),
    Categories("Categories", Icons.AutoMirrored.Filled.List),
    Search("Search", Icons.Filled.Search),
}

/**
 * The tabs, with what they share: the top bar (TV, refresh, log out), the
 * "playing on TV" banner, and the first-run catalogue download. A bottom bar
 * on a phone, a side rail on a tablet or TV.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(container: AppContainer, onPlay: (Int, String) -> Unit, onOpenCategory: (String) -> Unit) {
    val vm = viewModel { MainViewModel(container) }
    val refresh by vm.refresh.collectAsStateWithLifecycle()
    val count by vm.channelCount.collectAsStateWithLifecycle()
    val tvState by container.tv.state.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(Tab.Home) }
    val snackbar = remember { SnackbarHostState() }
    var menuOpen by remember { mutableStateOf(false) }

    val failed = refresh as? RefreshState.Failed
    val total = count ?: 0
    // With channels on screen, a failed refresh is a footnote, not a dead end.
    LaunchedEffect(failed, total) {
        if (failed != null && total > 0) {
            snackbar.showSnackbar("${failed.message} Showing the saved list.")
            vm.dismissError()
        }
    }

    @Suppress("DEPRECATION")
    val suiteType = NavigationSuiteScaffoldDefaults.calculateFromAdaptiveInfo(currentWindowAdaptiveInfo())
    val bottomBar = suiteType == NavigationSuiteType.NavigationBar

    NavigationSuiteScaffold(
        navigationSuiteItems = {
            Tab.entries.forEach {
                item(
                    selected = tab == it,
                    onClick = { tab = it },
                    icon = { Icon(it.icon, null) },
                    label = { Text(it.label) },
                )
            }
        },
        layoutType = suiteType,
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(if (tab == Tab.Home) "IPTV Live" else tab.label) },
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
            bottomBar = {
                TvBanner(
                    tvState,
                    onOpen = { tvState.channelId?.let { onPlay(it, "") } },
                    onStop = container.tv::stop,
                    // The navigation bar below already keeps clear of the gesture bar.
                    padForSystemBar = !bottomBar,
                )
            },
            snackbarHost = { SnackbarHost(snackbar) },
            // The navigation bar handles the bottom inset when it is shown.
            contentWindowInsets = if (bottomBar) WindowInsets.statusBars
            else WindowInsets.systemBars.only(WindowInsetsSides.Top + WindowInsetsSides.Bottom + WindowInsetsSides.End),
        ) { padding ->
            PullToRefreshBox(
                isRefreshing = refresh == RefreshState.Running && total > 0,
                onRefresh = vm::refresh,
                modifier = Modifier.padding(padding).fillMaxSize(),
            ) {
                when {
                    count == null -> Box(Modifier.fillMaxSize())
                    total == 0 && failed != null -> Message(failed.message, action = "Try again", onAction = vm::refresh)
                    total == 0 && refresh == RefreshState.Running -> Loading("Downloading the channel list…")
                    total == 0 -> Message("No channels yet.", action = "Refresh", onAction = vm::refresh)
                    else -> when (tab) {
                        Tab.Home -> HomeScreen(container, onPlay)
                        Tab.Categories -> CategoriesScreen(container, onOpenCategory)
                        Tab.Search -> SearchScreen(container, onPlay)
                    }
                }
            }
        }
    }
}
