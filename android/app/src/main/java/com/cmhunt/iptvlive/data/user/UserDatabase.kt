package com.cmhunt.iptvlive.data.user

import androidx.room.AutoMigration
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

/** A channel watched for long enough to count. One row per channel. */
@Entity(tableName = "recents")
data class RecentEntity(
    @PrimaryKey val channelId: Int,
    val watchedAt: Long,
)

@Dao
interface RecentsDao {
    @Query("SELECT * FROM recents ORDER BY watchedAt DESC")
    fun recents(): Flow<List<RecentEntity>>

    @Query("INSERT OR REPLACE INTO recents (channelId, watchedAt) VALUES (:channelId, :at)")
    suspend fun upsert(channelId: Int, at: Long)

    @Query("DELETE FROM recents WHERE channelId NOT IN (SELECT channelId FROM recents ORDER BY watchedAt DESC LIMIT :keep)")
    suspend fun trim(keep: Int)

    @Transaction
    suspend fun touch(channelId: Int, at: Long, keep: Int) {
        upsert(channelId, at)
        trim(keep)
    }

    @Query("DELETE FROM recents WHERE channelId = :channelId")
    suspend fun remove(channelId: Int)

    @Query("DELETE FROM recents")
    suspend fun clear()
}

@Entity(tableName = "favourites")
data class FavouriteEntity(
    @PrimaryKey val channelId: Int,
    val addedAt: Long,
)

@Dao
interface FavouritesDao {
    @Query("SELECT * FROM favourites ORDER BY addedAt")
    fun favourites(): Flow<List<FavouriteEntity>>

    @Query("SELECT COUNT(*) FROM favourites WHERE channelId = :channelId")
    suspend fun count(channelId: Int): Int

    @Query("INSERT OR REPLACE INTO favourites (channelId, addedAt) VALUES (:channelId, :at)")
    suspend fun add(channelId: Int, at: Long)

    @Query("DELETE FROM favourites WHERE channelId = :channelId")
    suspend fun remove(channelId: Int)
}

/** One channel in a numbered slot, 1-9. A channel may sit in several. */
@Entity(tableName = "presets")
data class PresetEntity(
    @PrimaryKey val slot: Int,
    val channelId: Int,
)

@Dao
interface PresetsDao {
    @Query("SELECT * FROM presets ORDER BY slot")
    fun presets(): Flow<List<PresetEntity>>

    @Query("INSERT OR REPLACE INTO presets (slot, channelId) VALUES (:slot, :channelId)")
    suspend fun save(slot: Int, channelId: Int)

    @Query("DELETE FROM presets WHERE slot = :slot")
    suspend fun remove(slot: Int)
}

/**
 * What the user made: recents, favourites and presets. Kept apart
 * from the catalogue cache, which may be dropped and rebuilt at any time;
 * this database must be migrated instead.
 */
@Database(
    entities = [RecentEntity::class, FavouriteEntity::class, PresetEntity::class],
    version = 2,
    exportSchema = true,
    // 2 only adds tables, which Room can derive from the exported schemas.
    autoMigrations = [AutoMigration(from = 1, to = 2)],
)
abstract class UserDatabase : RoomDatabase() {
    abstract fun recents(): RecentsDao
    abstract fun favourites(): FavouritesDao
    abstract fun presets(): PresetsDao
}
