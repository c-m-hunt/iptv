package com.cmhunt.iptvlive.data

import com.cmhunt.iptvlive.data.db.ChannelEntity
import com.cmhunt.iptvlive.data.user.PresetsDao
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.mapLatest

/** Slot [number], with its channel; null when empty or gone from the catalogue. */
data class PresetSlot(val number: Int, val channel: ChannelEntity?)

@OptIn(ExperimentalCoroutinesApi::class)
class PresetsRepository(private val dao: PresetsDao, private val catalogue: CatalogueRepository) {

    /** Always [SLOTS] entries, in order, so the UI can draw empty ones too. */
    val slots: Flow<List<PresetSlot>> =
        combine(dao.presets(), catalogue.channelCount) { presets, _ -> presets }.mapLatest { presets ->
            val byId = catalogue.channels(presets.map { it.channelId }).associateBy { it.id }
            val bySlot = presets.associate { it.slot to byId[it.channelId] }
            (1..SLOTS).map { PresetSlot(it, bySlot[it]) }
        }

    suspend fun save(slot: Int, channelId: Int) {
        require(slot in 1..SLOTS)
        dao.save(slot, channelId)
    }

    suspend fun remove(slot: Int) = dao.remove(slot)

    companion object {
        const val SLOTS = 9
    }
}
