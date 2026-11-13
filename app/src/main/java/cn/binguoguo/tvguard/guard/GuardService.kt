package cn.binguoguo.tvguard.guard

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import cn.binguoguo.tvguard.R
import cn.binguoguo.tvguard.launcher.HomeActivity
import cn.binguoguo.tvguard.net.Remote

/**
 * 常驻守护服务。
 *
 * 固件不允许安装非系统签名的桌面（HOME）应用，
 * 所以拿不到「桌面身份」这条最稳的保活路径，只能当普通后台 App。
 *
 * 这里用前台服务（带一条常驻通知）把进程钉住，START_STICKY 保证被杀后自动回来；
 * 开机由 [BootReceiver] 拉起来。Android 6 上后台启动 Activity 不受限，
 * 所以弹题不需要额外权限。
 */
class GuardService : Service() {

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTI_ID, buildNotification())
        WatchTracker.attach(this)
        if (!Remote.online) Remote.checkAtBoot()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            val ch = NotificationChannel(CHANNEL, "守护运行中", NotificationManager.IMPORTANCE_LOW)
            ch.setShowBadge(false)
            ch.setSound(null, null)
            nm?.createNotificationChannel(ch)
        }

        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, HomeActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }
        return builder
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("守时桌面运行中")
            .setContentText("计时和答题提醒在后台进行")
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .build()
    }

    companion object {
        private const val CHANNEL = "tvguard_guard"
        private const val NOTI_ID = 1001

        fun start(ctx: Context) {
            val intent = Intent(ctx, GuardService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
            else ctx.startService(intent)
        }
    }
}
