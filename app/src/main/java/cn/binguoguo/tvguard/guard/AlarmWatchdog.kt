package cn.binguoguo.tvguard.guard

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/**
 * 看门狗：定期把自己叫醒。
 */
object AlarmWatchdog {

    /** action 前缀跟 applicationId 走，不写死包名；显式 Intent 已限定本接收器。 */
    fun tickAction(ctx: Context): String = ctx.packageName + ".action.WATCHDOG"

    private const val REQ_CODE = 2001
    private const val INTERVAL_MS = 60_000L

    fun schedule(ctx: Context, delayMs: Long = INTERVAL_MS) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val at = System.currentTimeMillis() + delayMs
        val pi = pending(ctx)
        try {
            am.setExact(AlarmManager.RTC_WAKEUP, at, pi)
        } catch (t: Throwable) {
            runCatching { am.set(AlarmManager.RTC_WAKEUP, at, pi) }
        }
    }

    fun cancel(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        runCatching { am.cancel(pending(ctx)) }
    }

    private fun pending(ctx: Context): PendingIntent {
        val i = Intent(ctx, BootReceiver::class.java).setAction(tickAction(ctx))
        return PendingIntent.getBroadcast(
            ctx, REQ_CODE, i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
