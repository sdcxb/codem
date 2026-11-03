package com.codem.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * 让设备内 Host **常驻**（ADR-0002 §3.2「前台服务 + 唤醒锁」，关闭 UI 不停 Host）。
 *
 * 只做两件事：
 * 1. `startForeground` + 常驻通知（Android 不会因为界面退到后台就回收进程）；
 * 2. `PARTIAL_WAKE_LOCK`（只保 CPU，不保网络 —— 与设计一致）。
 *
 * Host 本身仍是 Activity 启动的子进程；前台服务只是把**承载它的进程**保下来。
 */
public class KeepAliveService extends Service {
    private static final String CHANNEL = "codem-host";
    private static final int NOTIFICATION_ID = 1;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Codem Host", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("本机 Host 运行中");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
        PendingIntent open = PendingIntent.getActivity(
                this,
                0,
                new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        Notification notification = builder
                .setContentTitle("Codem")
                .setContentText("本机 Host 运行中（关闭界面也会继续）")
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        startForeground(NOTIFICATION_ID, notification);

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "codem:host");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
