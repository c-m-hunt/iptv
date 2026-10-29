package com.cmhunt.iptvlive.ui.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.Credentials
import com.cmhunt.iptvlive.data.xtream.XtreamException
import com.cmhunt.iptvlive.data.xtream.XtreamUrls
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class LoginState(
    val portal: String = "",
    val username: String = "",
    val password: String = "",
    val streamOverride: String = "",
    val showAdvanced: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
)

class LoginViewModel(private val container: AppContainer) : ViewModel() {

    private val _state = MutableStateFlow(LoginState())
    val state: StateFlow<LoginState> = _state

    init {
        viewModelScope.launch {
            val h = container.credentials.hints()
            _state.update {
                it.copy(
                    portal = h.portal,
                    username = h.username,
                    streamOverride = h.streamOverride,
                    showAdvanced = h.streamOverride.isNotEmpty(),
                )
            }
        }
    }

    fun onPortal(v: String) = _state.update { it.copy(portal = v, error = null) }
    fun onUsername(v: String) = _state.update { it.copy(username = v, error = null) }
    fun onPassword(v: String) = _state.update { it.copy(password = v, error = null) }
    fun onStreamOverride(v: String) = _state.update { it.copy(streamOverride = v, error = null) }
    fun toggleAdvanced() = _state.update { it.copy(showAdvanced = !it.showAdvanced) }

    fun logIn() {
        val s = _state.value
        if (s.busy) return
        val portal = XtreamUrls.normalisePortal(s.portal)
        val user = s.username.trim()
        when {
            portal.isEmpty() -> return fail("Enter the server URL.")
            user.isEmpty() -> return fail("Enter the username.")
            s.password.isEmpty() -> return fail("Enter the password.")
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val account = container.xtream.authenticate(portal, user, s.password)
                val override = s.streamOverride.trim()
                val streamBase = XtreamUrls.resolveStreamBase(
                    portal = portal,
                    override = override,
                    serverUrl = account.server.url,
                    serverPort = account.server.port,
                    httpsPort = account.server.httpsPort,
                    protocol = account.server.protocol,
                )
                container.catalogue.clear()
                // Saving switches AppRoot to the main screens.
                container.credentials.save(Credentials(portal, user, s.password, streamBase, override))
            } catch (e: XtreamException) {
                fail(e.message ?: "Login failed.")
            }
        }
    }

    private fun fail(msg: String) = _state.update { it.copy(busy = false, error = msg) }
}
