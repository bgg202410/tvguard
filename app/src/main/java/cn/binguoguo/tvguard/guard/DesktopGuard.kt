package cn.binguoguo.tvguard.guard

import android.content.Context
import android.content.Intent
import android.util.Log
import cn.binguoguo.tvguard.launcher.HomeActivity
import cn.binguoguo.tvguard.net.Remote

/**
 * 桌面拦截：返回系统桌面拦截。
 */
object DesktopGuard {

    private const val TAG = "TvGuard"

    const val ALLOW_WINDOW_MS = 3 * 60_000L

    private const val KICK_GAP_MS = 1_500L

    @Volatile
    private var desktopPkgs: Set<String> = emptySet()

    /** 无障碍报上来的每一个前台包名都过这里 */
    fun onForeground(ctx: Context, pkg: String) {
        if (!isDesktop(ctx, pkg)) return
        if (!shouldBlock(ctx)) return
        kick(ctx, pkg)
    }

    fun isDesktop(ctx: Context, pkg: String): Boolean {
        if (pkg.isEmpty()) return false
        val set = desktopPkgs.ifEmpty { resolve(ctx).also { desktopPkgs = it } }
        return pkg in set
    }

    private fun resolve(ctx: Context): Set<String> {
        val out = mutableSetOf(
            "com.tcl.cyberui",
            "com.android.tvlauncher",
            "com.google.android.tvlauncher"
        )
        runCatching {
            val i = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
            ctx.packageManager.queryIntentActivities(i, 0)
                .forEach { out += it.activityInfo.packageName }
        }
        Log.d(TAG, "桌面包名：${out.joinToString()}")
        return out
    }

    private fun shouldBlock(ctx: Context): Boolean {
        val now = System.currentTimeMillis()
        if (now < UiState.allowDesktopUntil) return false
        if (UiState.gateShowing) return false
        if (WatchTracker.quizShowing || WatchTracker.lockShowing) return false
        if (!Remote.shouldManage()) return false
        if (!Remote.desktopGuardOn) return false
        return true
    }

    private fun kick(ctx: Context, pkg: String) {
        val now = System.currentTimeMillis()
        if (now - UiState.lastDesktopKickAt < KICK_GAP_MS) return
        UiState.lastDesktopKickAt = now
        WatchTracker.lastPageLaunchAt = now
        Log.d(TAG, "桌面拦截：$pkg → 拉回守时桌面")
        runCatching {
            ctx.startActivity(
                Intent(ctx, HomeActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                )
            )
        }.onFailure { Log.d(TAG, "桌面拦截失败：${it.message}") }
    }
}
