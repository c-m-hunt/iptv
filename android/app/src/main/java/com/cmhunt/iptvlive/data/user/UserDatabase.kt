package com.cmhunt.iptvlive.data.user

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

/**
 * What the user made: recents now, favourites and presets later. Kept apart
 * from the catalogue cache, which may be dropped and rebuilt at any time;
 * this database must be migrated instead.
 */
@Database(entities = [RecentEntity::class], version = 1, exportSchema = true)
abstract class UserDatabase : RoomDatabase() {
    abstract fun recents(): RecentsDao
}
