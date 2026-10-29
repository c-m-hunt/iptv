package com.cmhunt.iptvlive.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

data class Credentials(
    /** Normalised portal, e.g. `http://portal.example.com:8080`. */
    val portal: String,
    val username: String,
    val password: String,
    /** Resolved at login: the override if one was set, else `server_info`. */
    val streamBase: String,
    /** What the user typed under Advanced; empty when unused. */
    val streamOverride: String,
)

/** The fields the login form can pre-fill after a log out. */
data class LoginHints(val portal: String, val username: String, val streamOverride: String)

class CredentialStore(
    private val prefs: DataStore<Preferences>,
    private val box: SecretBox,
) {
    val credentials: Flow<Credentials?> = prefs.data
        .map { p ->
            val portal = p[PORTAL] ?: return@map null
            val user = p[USERNAME] ?: return@map null
            val secret = p[PASSWORD] ?: return@map null
            // A password we can no longer decrypt means logging in again.
            val password = box.decrypt(secret) ?: return@map null
            Credentials(portal, user, password, p[STREAM_BASE] ?: portal, p[STREAM_OVERRIDE].orEmpty())
        }
        .distinctUntilChanged()

    suspend fun hints(): LoginHints {
        val p = prefs.data.first()
        return LoginHints(p[PORTAL].orEmpty(), p[USERNAME].orEmpty(), p[STREAM_OVERRIDE].orEmpty())
    }

    suspend fun save(c: Credentials) {
        val secret = box.encrypt(c.password)
        prefs.edit {
            it[PORTAL] = c.portal
            it[USERNAME] = c.username
            it[PASSWORD] = secret
            it[STREAM_BASE] = c.streamBase
            it[STREAM_OVERRIDE] = c.streamOverride
        }
    }

    /** Forgets the password only; the portal and username pre-fill the form. */
    suspend fun logOut() {
        prefs.edit { it.remove(PASSWORD) }
    }

    private companion object {
        val PORTAL = stringPreferencesKey("portal")
        val USERNAME = stringPreferencesKey("username")
        val PASSWORD = stringPreferencesKey("password_enc")
        val STREAM_BASE = stringPreferencesKey("stream_base")
        val STREAM_OVERRIDE = stringPreferencesKey("stream_override")
    }
}
