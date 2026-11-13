package cn.binguoguo.tvguard.guard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 系统广播入口：开机自启 + 看门狗唤醒。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON" -> {
                GuardService.start(context)
                AlarmWatchdog.schedule(context)
            }
            // 看门狗：先排下一次，再确保服务在跑（进程可能刚被这一发广播带起来）
            AlarmWatchdog.tickAction(context) -> {
                AlarmWatchdog.schedule(context)
                GuardService.start(context)
            }
        }
    }
}
