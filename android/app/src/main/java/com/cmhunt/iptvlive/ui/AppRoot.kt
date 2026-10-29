package com.cmhunt.iptvlive.ui

import android.net.Uri
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.Credentials
import com.cmhunt.iptvlive.ui.categories.CategoryChannelsScreen
import com.cmhunt.iptvlive.ui.login.LoginScreen
import com.cmhunt.iptvlive.ui.main.MainScreen
import com.cmhunt.iptvlive.ui.player.PlayerScreen
import kotlinx.coroutines.flow.map

private sealed interface Session {
    data object Loading : Session
    data object LoggedOut : Session
    data class LoggedIn(val credentials: Credentials) : Session
}

/**
 * Login sits outside the nav graph: saving credentials swaps in the main graph,
 * and logging out swaps it away, so Back can never return to either by mistake.
 */
@Composable
fun AppRoot(container: AppContainer) {
    val session by container.credentials.credentials
        .map { if (it == null) Session.LoggedOut else Session.LoggedIn(it) }
        .collectAsStateWithLifecycle(initialValue = Session.Loading)

    // Surface also sets the default content colour; without it bare Text is black.
    Surface(Modifier.fillMaxSize()) {
        when (val s = session) {
            Session.Loading -> Unit
            Session.LoggedOut -> LoginScreen(container)
            is Session.LoggedIn -> MainGraph(container)
        }
    }
}

@Composable
private fun MainGraph(container: AppContainer) {
    val nav = rememberNavController()
    val play: (Int) -> Unit = { id -> nav.navigate("player/$id") }
    NavHost(nav, startDestination = "main") {
        composable("main") {
            MainScreen(container, onPlay = play, onOpenCategory = { id -> nav.navigate("category/${Uri.encode(id)}") })
        }
        composable("category/{id}") { entry ->
            CategoryChannelsScreen(
                container = container,
                categoryId = entry.arguments?.getString("id").orEmpty(),
                onBack = { nav.popBackStack() },
                onPlay = play,
            )
        }
        composable(
            "player/{id}",
            arguments = listOf(navArgument("id") { type = NavType.IntType }),
        ) { entry ->
            PlayerScreen(
                container = container,
                channelId = entry.arguments?.getInt("id") ?: 0,
                onBack = { nav.popBackStack() },
            )
        }
    }
}
