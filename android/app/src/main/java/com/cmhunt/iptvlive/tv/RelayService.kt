package com.cmhunt.iptvlive.tv

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.cmhunt.iptvlive.IptvApp
import com.cmhunt.iptvlive.MainActivity
import com.cmhunt.iptvlive.R

/**
 * Keeps the process, CPU and Wi-Fi awake while this phone relays a stream to
 * a TV. The relay itself lives in [TvController]; without this service,
 * Android would freeze it a few minutes after the screen goes off.
 */
class RelayService : Service() {

    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            (application as IptvApp).container.tv.stop()
            stopSelf()
            return START_NOT_STICKY
        }
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Sending a channel to your TV"
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, notification(text),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0,
        )
        acquireLocks()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wifiLock?.takeIf { it.isHeld }?.release()
        wakeLock?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    private fun acquireLocks() {
        if (wifiLock == null) {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wifi.createWifiLock(mode, "iptvlive:relay").apply { acquire() }
        }
        if (wakeLock == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "iptvlive:relay").apply { acquire() }
        }
    }

    private fun notification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Playing on TV", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, RelayService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_tv)
            .setContentTitle("Playing on TV through this phone")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .build()
    }

    companion object {
        private const val CHANNEL = "relay"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "stop"
        private const val EXTRA_TEXT = "text"

        fun start(context: Context, text: String) {
            ContextCompat.startForegroundService(
                context, Intent(context, RelayService::class.java).putExtra(EXTRA_TEXT, text),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RelayService::class.java))
        }
    }
}
