package io.codem.codem_mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 本机 Host 的保活服务（前台服务 + CPU 唤醒锁）。
 *
 * 与 [CodemForegroundService] 分开：那个服务表示「正在连电脑」，这个表示
 * 「手机上的本机 Host 在跑」。两者可同时存在，通知文案与入口都不同，
 * Dart 侧不需要知道本服务的存在（`codem/local_host` 的 start/stop 会自己拉起/停掉它）。
 *
 * 只做两件事：
 * 1. `startForeground` + 常驻通知：界面退到后台后系统不会立刻回收进程；
 * 2. `PARTIAL_WAKE_LOCK`：只保 CPU（不保网络），Node Host 在锁屏后仍能应答请求。
 *
 * Host 本身是应用进程的子进程（PRoot → Node），前台服务只是把**承载它的进程**保住。
 */
class LocalHostKeepAliveService : Service() {
    companion object {
        const val CHANNEL_ID = "codem.localhost"
        const val NOTIFICATION_ID = 4103
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        val pm = getSystemService(PowerManager::class.java)
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "codem:localhost").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "本机 Host", NotificationManager.IMPORTANCE_LOW).apply {
                description = "手机上的 Codem 本机 Host 运行时保持"
                setShowBadge(false)
            }
        )
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            3,
            Intent(this, MainActivity::class.java),
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
            .setContentText("本机 Host 运行中（关闭界面也会继续）")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }
}
