package io.codem.codem_mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder

/**
 * 轻量前台服务：只在手机与 PC 保持连接时运行，让系统知道“Codem 正在工作”。
 *
 * 不做长连接本身（SSE 在 Dart 侧）；这个服务只负责前台通知与进程优先级，
 * 避免用户切到后台后连接被系统快速回收。
 */
class CodemForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "codem.connection"
        const val NOTIFICATION_ID = 4101
        const val EXTRA_LABEL = "label"
        const val ACTION_STOP = "io.codem.codem_mobile.STOP_FOREGROUND"
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val label = intent?.getStringExtra(EXTRA_LABEL)?.take(80) ?: "已连接的 PC"
        startForeground(NOTIFICATION_ID, buildNotification(label))
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Codem 连接",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "保持与电脑的连接"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(label: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, CodemForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Codem")
            .setContentText("正在连接 $label")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, android.R.drawable.stat_notify_sync),
                    "断开",
                    stop
                ).build()
            )
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
