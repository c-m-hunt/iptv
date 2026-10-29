package com.cmhunt.iptvlive.data.xtream

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

/** A failure with a message fit to show the user as-is. */
class XtreamException(message: String) : Exception(message)

data class ServerInfo(
    val url: String?,
    val port: String?,
    val httpsPort: String?,
    val protocol: String?,
    val timezone: String?,
)

data class AccountInfo(
    val username: String,
    val status: String,
    val expDate: Long?,
    val maxConnections: Int?,
    val activeConnections: Int?,
    val server: ServerInfo,
)

data class LiveCategory(val id: String, val name: String)

data class LiveChannel(
    val id: Int,
    val name: String,
    val categoryId: String,
    val icon: String,
    val epgId: String,
)

/**
 * Talks to `player_api.php`. The JSON is read by hand rather than through
 * generated serializers: portals send numbers as strings, strings as numbers,
 * and nulls where you'd least expect them, and one bad field shouldn't sink an
 * 8,000-channel catalogue.
 */
class XtreamClient(private val http: OkHttpClient) {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    suspend fun authenticate(portal: String, username: String, password: String): AccountInfo {
        // The portal sits behind an HTTP cache keyed on the exact URL; without a
        // unique parameter it replays a minutes-old answer.
        val url = apiUrl(portal, username, password, null)
            .newBuilder()
            .addQueryParameter("_", System.currentTimeMillis().toString())
            .build()
        val root = getJson(url, authCall = true) as? JsonObject
            ?: throw XtreamException("The portal sent an unexpected reply.")
        val user = root["user_info"] as? JsonObject
            ?: throw XtreamException("This does not look like an Xtream Codes portal.")

        if (user.int("auth") != 1) throw XtreamException("Wrong username or password.")
        val status = user.str("status").orEmpty()
        if (status.lowercase() in setOf("expired", "banned", "disabled")) {
            throw XtreamException("The account status is \"$status\".")
        }

        val server = root["server_info"] as? JsonObject
        return AccountInfo(
            username = user.str("username").orEmpty(),
            status = status,
            expDate = user.str("exp_date")?.toLongOrNull(),
            maxConnections = user.int("max_connections"),
            activeConnections = user.int("active_cons"),
            server = ServerInfo(
                url = server?.str("url"),
                port = server?.str("port"),
                httpsPort = server?.str("https_port"),
                protocol = server?.str("server_protocol"),
                timezone = server?.str("timezone"),
            ),
        )
        // user_info.password is echoed back by the portal; it is deliberately
        // not copied into AccountInfo.
    }

    suspend fun liveCategories(portal: String, username: String, password: String): List<LiveCategory> {
        val arr = getJson(apiUrl(portal, username, password, "get_live_categories")) as? JsonArray
            ?: return emptyList()
        return withContext(Dispatchers.Default) {
            arr.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val id = o.str("category_id") ?: return@mapNotNull null
                LiveCategory(id, o.str("category_name").orEmpty().trim())
            }
        }
    }

    suspend fun liveStreams(portal: String, username: String, password: String): List<LiveChannel> {
        val arr = getJson(apiUrl(portal, username, password, "get_live_streams")) as? JsonArray
            ?: throw XtreamException("The portal sent an unexpected channel list.")
        return withContext(Dispatchers.Default) {
            arr.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val id = o.int("stream_id") ?: return@mapNotNull null
                LiveChannel(
                    id = id,
                    name = o.str("name").orEmpty().trim(),
                    categoryId = o.str("category_id").orEmpty(),
                    icon = o.str("stream_icon").orEmpty(),
                    epgId = o.str("epg_channel_id").orEmpty(),
                )
            }
        }
    }

    private fun apiUrl(portal: String, username: String, password: String, action: String?): HttpUrl {
        val base = "$portal/player_api.php".toHttpUrlOrNull()
            ?: throw XtreamException("The server URL is not valid.")
        return base.newBuilder()
            .addQueryParameter("username", username)
            .addQueryParameter("password", password)
            .apply { if (action != null) addQueryParameter("action", action) }
            .build()
    }

    // Exception messages here never include the URL: it carries the password.
    private suspend fun getJson(url: HttpUrl, authCall: Boolean = false): JsonElement =
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(url).header("Cache-Control", "no-cache").build()
            val body = try {
                http.newCall(request).execute().use { resp ->
                    if (authCall && (resp.code == 401 || resp.code == 403)) {
                        throw XtreamException("Wrong username or password.")
                    }
                    if (!resp.isSuccessful) throw XtreamException("The portal answered HTTP ${resp.code}.")
                    resp.body?.string().orEmpty()
                }
            } catch (e: XtreamException) {
                throw e
            } catch (e: IOException) {
                throw XtreamException("Cannot reach the portal (${e.javaClass.simpleName}).")
            }
            try {
                json.parseToJsonElement(body)
            } catch (e: Exception) {
                // The portal sometimes answers with plain text ("Got 503 upstream").
                val hint = body.trim().take(60).ifEmpty { "empty response" }
                throw XtreamException("The portal is unavailable: $hint")
            }
        }
}

internal fun JsonObject.str(key: String): String? {
    val p = this[key] as? JsonPrimitive ?: return null
    if (p is JsonNull) return null
    return p.content
}

internal fun JsonObject.int(key: String): Int? {
    val s = str(key) ?: return null
    return s.toIntOrNull() ?: s.toDoubleOrNull()?.toInt()
}
