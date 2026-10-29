package com.cmhunt.iptvlive.data

import com.cmhunt.iptvlive.data.db.ChannelEntity
import com.cmhunt.iptvlive.data.user.FavouritesDao
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapLatest

@OptIn(ExperimentalCoroutinesApi::class)
class FavouritesRepository(private val dao: FavouritesDao, private val catalogue: CatalogueRepository) {

    val ids: Flow<Set<Int>> = dao.favourites().map { list -> list.mapTo(HashSet()) { it.channelId } }

    /**
     * Favourite channels in the provider's order, which keeps related channels
     * together (BBC One, BBC Two…). Re-read after a catalogue refresh.
     */
    val channels: Flow<List<ChannelEntity>> =
        combine(ids, catalogue.channelCount) { favs, _ -> favs }.mapLatest { catalogue.channels(it) }

    suspend fun toggle(channelId: Int) {
        if (dao.count(channelId) > 0) dao.remove(channelId) else dao.add(channelId, System.currentTimeMillis())
    }
}
