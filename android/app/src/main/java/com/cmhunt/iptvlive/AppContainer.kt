package com.cmhunt.iptvlive

import android.content.Context
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.room.Room
import com.cmhunt.iptvlive.data.CatalogueRepository
import com.cmhunt.iptvlive.data.CredentialStore
import com.cmhunt.iptvlive.data.RecentsRepository
import com.cmhunt.iptvlive.data.SecretBox
import com.cmhunt.iptvlive.data.db.AppDatabase
import com.cmhunt.iptvlive.data.user.UserDatabase
import com.cmhunt.iptvlive.data.xtream.XtreamClient
import com.cmhunt.iptvlive.tv.TvController
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Hand-rolled dependency wiring. The app is small enough that a DI framework
 * would cost more build time than it saves.
 */
class AppContainer(context: Context) {

    /** Shared by the API, the player and the logo loader. */
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // The live catalogue is several MB from a slow portal.
        .readTimeout(30, TimeUnit.SECONDS)
        // Some portals refuse unfamiliar clients; a player's UA gets through.
        .addInterceptor { chain ->
            chain.proceed(chain.request().newBuilder().header("User-Agent", USER_AGENT).build())
        }
        .build()

    private val prefs = PreferenceDataStoreFactory.create {
        context.preferencesDataStoreFile("settings")
    }

    // Only the re-downloadable catalogue lives here so far, so a schema change
    // can simply start over.
    private val db = Room.databaseBuilder(context, AppDatabase::class.java, "iptv.db")
        .fallbackToDestructiveMigration(dropAllTables = true)
        .build()

    private val userDb = Room.databaseBuilder(context, UserDatabase::class.java, "user.db").build()

    val xtream = XtreamClient(http)
    val credentials = CredentialStore(prefs, SecretBox())
    val catalogue = CatalogueRepository(db.catalogue(), xtream, prefs)
    val recents = RecentsRepository(userDb.recents())
    val tv = TvController(context, http, credentials, catalogue, recents)

    companion object {
        const val USER_AGENT = "VLC/3.0.20 LibVLC/3.0.20"
    }
}
