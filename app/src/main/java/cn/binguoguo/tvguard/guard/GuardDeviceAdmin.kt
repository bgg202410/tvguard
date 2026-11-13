package cn.binguoguo.tvguard.guard

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.util.Log

/**
 * 设备管理员 —— 保活的主要手段。
 *
 * 清理工具会把后台应用 force-stop（`stopped=true`），
 * 被强停之后闹钟、广播、START_STICKY 全失效，应用彻底躺平、只能等人手动打开。
 * 而**设备管理员是系统里「强制停止」按钮会被禁用的那类应用**：国产 ROM 的清理
 * 基本都会绕开它，否则管理功能就废了。
 *
 * 代价很小：只声明「锁屏」一项策略（[force-lock]），平时不用；
 * 需要时还能顺手做「到点直接锁屏」。
 *
 * 电视上没有无障碍入口，这条路比无障碍好走 —— 激活入口在
 * 设置 → 安全 → 设备管理员，而且我们能用 ACTION_ADD_DEVICE_ADMIN 直接拉起确认框。
 */
class GuardDeviceAdmin : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        Log.d(TAG, "设备管理员已激活，后台清理会绕开本应用")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        Log.d(TAG, "设备管理员已取消")
    }

    companion object {
        private const val TAG = "TvGuard"

        fun component(ctx: Context): ComponentName =
            ComponentName(ctx.applicationContext, GuardDeviceAdmin::class.java)

        fun isActive(ctx: Context): Boolean {
            val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
                ?: return false
            return runCatching { dpm.isAdminActive(component(ctx)) }.getOrDefault(false)
        }

        /** 拉起系统确认框（遥控器点一下「激活」即可） */
        fun requestActivate(ctx: Context): Boolean = runCatching {
            ctx.startActivity(
                Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                    .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, component(ctx))
                    .putExtra(
                        DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                        "防止守时桌面被电视清理，保证计时和答题提醒不中断。本应用只使用「锁屏」这一项权限。"
                    )
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            true
        }.getOrDefault(false)

        /**
         * 取消激活。
         *
         */
        fun deactivate(ctx: Context): Boolean {
            val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
            val done = if (dpm == null) false else runCatching {
                dpm.removeActiveAdmin(component(ctx))
                !isActive(ctx)
            }.getOrDefault(false)
            if (done) return true
            runCatching {
                ctx.startActivity(
                    Intent(Settings.ACTION_SECURITY_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
            return false
        }
    }
}
