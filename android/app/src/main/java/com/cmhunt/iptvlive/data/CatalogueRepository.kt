package com.cmhunt.iptvlive.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import com.cmhunt.iptvlive.data.db.CatalogueDao
import com.cmhunt.iptvlive.data.db.CategoryEntity
import com.cmhunt.iptvlive.data.db.CategoryWithCount
import com.cmhunt.iptvlive.data.db.ChannelEntity
import com.cmhunt.iptvlive.data.xtream.XtreamClient
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first

/**
 * The live catalogue, kept in Room so the app opens instantly and still works
 * when the portal is having a bad day. Refreshed when older than [MAX_AGE_MS].
 */
class CatalogueRepository(
    private val dao: CatalogueDao,
    private val client: XtreamClient,
    private val prefs: DataStore<Preferences>,
) {
    val channels: Flow<List<ChannelEntity>> = dao.channels()
    val categories: Flow<List<CategoryEntity>> = dao.categories()
    val categoriesWithCounts: Flow<List<CategoryWithCount>> = dao.categoriesWithCounts()
    val channelCount: Flow<Int> = dao.channelCountFlow()

    fun channelsIn(categoryId: String): Flow<List<ChannelEntity>> = dao.channelsIn(categoryId)

    suspend fun category(id: String): CategoryEntity? = dao.category(id)

    suspend fun channel(id: Int): ChannelEntity? = dao.channel(id)

    suspend fun isEmpty(): Boolean = dao.channelCount() == 0

    suspend fun isStale(): Boolean {
        val at = prefs.data.first()[REFRESHED_AT] ?: 0L
        return isEmpty() || System.currentTimeMillis() - at > MAX_AGE_MS
    }

    /** Throws [com.cmhunt.iptvlive.data.xtream.XtreamException] on failure; the old data stays. */
    suspend fun refresh(c: Credentials) = coroutineScope {
        val cats = async { client.liveCategories(c.portal, c.username, c.password) }
        val chans = async { client.liveStreams(c.portal, c.username, c.password) }
        val categories = cats.await().mapIndexed { i, x -> CategoryEntity(x.id, x.name, i) }
        val channels = chans.await().mapIndexed { i, x ->
            ChannelEntity(x.id, x.name, x.categoryId, x.icon, x.epgId, i)
        }
        dao.replaceAll(categories, channels)
        prefs.edit { it[REFRESHED_AT] = System.currentTimeMillis() }
    }

    /** A different account may see a different catalogue, so drop it on log out. */
    suspend fun clear() {
        dao.replaceAll(emptyList(), emptyList())
        prefs.edit { it.remove(REFRESHED_AT) }
    }

    private companion object {
        const val MAX_AGE_MS = 6 * 60 * 60 * 1000L
        val REFRESHED_AT = longPreferencesKey("catalogue_refreshed_at")
    }
}
