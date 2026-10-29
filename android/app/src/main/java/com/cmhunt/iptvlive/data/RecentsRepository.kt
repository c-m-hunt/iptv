package com.cmhunt.iptvlive.data

import com.cmhunt.iptvlive.data.user.RecentEntity
import com.cmhunt.iptvlive.data.user.RecentsDao
import kotlinx.coroutines.flow.Flow

class RecentsRepository(private val dao: RecentsDao) {

    val recents: Flow<List<RecentEntity>> = dao.recents()

    /** Moves the channel to the top of the list, keeping the newest [KEEP]. */
    suspend fun markWatched(channelId: Int) = dao.touch(channelId, System.currentTimeMillis(), KEEP)

    suspend fun remove(channelId: Int) = dao.remove(channelId)

    suspend fun clear() = dao.clear()

    companion object {
        const val KEEP = 20

        /**
         * Channel surfing shouldn't fill the list: a channel counts once it has
         * played this long.
         */
        const val WATCHED_AFTER_MS = 10_000L
    }
}
