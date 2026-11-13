package cn.binguoguo.tvguard.guard

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import cn.binguoguo.tvguard.data.Prefs

/**
 * Profile Owner 能力封装。
 */
object DeviceOwner {

    private val targets: List<CleanerPackages.Entry> get() = CleanerPackages.active()

    fun component(ctx: Context): ComponentName = GuardDeviceAdmin.component(ctx)

    private fun dpm(ctx: Context): DevicePolicyManager? =
        ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager

    private var lastStates: Map<String, Boolean> = emptyMap()

    /** Profile Owner 是否还在（恢复出厂/刷机会掉，掉了要重新 adb 设置） */
    fun isProfileOwner(ctx: Context): Boolean {
        val m = dpm(ctx) ?: return false
        return runCatching { m.isProfileOwnerApp(ctx.packageName) }.getOrDefault(false)
    }

    /** 探测「隐藏应用」权限是否被 ROM 放行；null = 放行，否则是失败原因 */
    fun probe(ctx: Context): String? {
        return try {
            val m = dpm(ctx) ?: return "没有设备策略服务"
            m.isApplicationHidden(component(ctx), targets.first().pkg)
            null
        } catch (t: Throwable) {
            t.message ?: t.javaClass.simpleName
        }
    }

    /**
     * 各嫌疑包的隐藏状态（true = 已屏蔽）。查询失败时返回上次缓存；
     * 缓存也没有（刚开机从未查到）返回空 map。
     */
    fun hiddenStates(ctx: Context): Map<String, Boolean> {
        return try {
            val m = dpm(ctx) ?: return lastStates
            val out = LinkedHashMap<String, Boolean>()
            for (e in targets) out[e.pkg] = m.isApplicationHidden(component(ctx), e.pkg)
            lastStates = out
            out
        } catch (t: Throwable) {
            lastStates
        }
    }

    /**
     * 隐藏 / 恢复全部嫌疑包。返回 null 表示全部成功，否则是失败原因
     * （部分包已操作成功，界面上以状态行为准）。
     */
    fun setAllHidden(ctx: Context, hidden: Boolean): String? {
        var err: String? = null
        try {
            val m = dpm(ctx) ?: return "没有设备策略服务"
            for (e in targets) {
                try {
                    m.setApplicationHidden(component(ctx), e.pkg, hidden)
                } catch (t: Throwable) {
                    err = "${e.pkg}: ${t.message ?: t.javaClass.simpleName}"
                }
            }
        } catch (t: Throwable) {
            return t.message ?: t.javaClass.simpleName
        }
        hiddenStates(ctx) // 立刻刷新缓存
        return err
    }

    fun reassertHidden(ctx: Context): Int {
        if (!Prefs.killersHidden) return 0
        if (!isProfileOwner(ctx)) return 0
        if (probe(ctx) != null) return 0
        var fixed = 0
        for ((pkg, hidden) in hiddenStates(ctx)) {
            if (hidden) continue
            try {
                val m = dpm(ctx) ?: return fixed
                m.setApplicationHidden(component(ctx), pkg, true)
                fixed += 1
            } catch (t: Throwable) {
                // 单个失败下轮再试
            }
        }
        return fixed
    }
}
