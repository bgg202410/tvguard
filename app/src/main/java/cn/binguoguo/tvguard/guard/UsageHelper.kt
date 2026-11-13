package cn.binguoguo.tvguard.guard

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.Process

/**
 * 前台应用判定。需要「使用情况访问权限」，用户手动开。
 * 拿不到权限时返回 null，上层自动降级到音频信号。
 */
object UsageHelper {

    fun hasPermission(ctx: Context): Boolean {
        val ops = ctx.getSystemService(AppOpsManager::class.java) ?: return false
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ops.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName
            )
        } else {
            ops.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /** 取最近 windowMs 内最后一次进入前台的包名 */
    fun foregroundPackage(ctx: Context, windowMs: Long = 90_000L): String? {
        if (!hasPermission(ctx)) return null
        val usm = ctx.getSystemService(UsageStatsManager::class.java) ?: return null
        val end = System.currentTimeMillis()
        return try {
            val events = usm.queryEvents(end - windowMs, end) ?: return null
            val e = UsageEvents.Event()
            var fg: String? = null
            while (events.hasNextEvent()) {
                events.getNextEvent(e)
                val resumed = e.eventType == UsageEvents.Event.ACTIVITY_RESUMED
                val legacy = e.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND
                if (resumed || legacy) fg = e.packageName
            }
            fg
        } catch (t: Throwable) {
            null
        }
    }
}
