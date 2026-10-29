package com.cmhunt.iptvlive.data.db

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "channels", indices = [Index("categoryId")])
data class ChannelEntity(
    @PrimaryKey val id: Int,
    val name: String,
    val categoryId: String,
    val icon: String,
    val epgId: String,
    /** Order in the provider's list, which is the order people expect. */
    val position: Int,
)

@Entity(tableName = "categories")
data class CategoryEntity(
    @PrimaryKey val id: String,
    val name: String,
    val position: Int,
)

@Dao
interface CatalogueDao {
    @Query("SELECT * FROM channels ORDER BY position")
    fun channels(): Flow<List<ChannelEntity>>

    @Query("SELECT * FROM channels WHERE id = :id")
    suspend fun channel(id: Int): ChannelEntity?

    @Query("SELECT * FROM categories ORDER BY position")
    fun categories(): Flow<List<CategoryEntity>>

    @Query("SELECT COUNT(*) FROM channels")
    suspend fun channelCount(): Int

    // REPLACE because some portals list the same stream_id twice.
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertChannels(channels: List<ChannelEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertCategories(categories: List<CategoryEntity>)

    @Query("DELETE FROM channels")
    suspend fun deleteChannels()

    @Query("DELETE FROM categories")
    suspend fun deleteCategories()

    @Transaction
    suspend fun replaceAll(categories: List<CategoryEntity>, channels: List<ChannelEntity>) {
        deleteCategories()
        deleteChannels()
        insertCategories(categories)
        insertChannels(channels)
    }
}

@Database(entities = [ChannelEntity::class, CategoryEntity::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun catalogue(): CatalogueDao
}
