package cn.binguoguo.tvguard.guard

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 *  无障碍保活，电视无入口，只能使用命令：
 *   adb shell settings put secure enabled_accessibility_services \
 *     <applicationId>/<applicationId>.guard.GuardAccessibilityService
 *   adb shell settings put secure accessibility_enabled 1
 */
class GuardAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        UiState.a11yOn = true
        Log.d(TAG, "无障碍服务已连接（保活生效）")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString().orEmpty()
        if (pkg.isEmpty()) return
        UiState.foregroundPkg = pkg
        UiState.foregroundAt = System.currentTimeMillis()
        try {
            DesktopGuard.onForeground(this, pkg)
        } catch (t: Throwable) {
            Log.d(TAG, "桌面拦截出错：${t.message}")
        }
    }

    override fun onInterrupt() {
    }

    override fun onDestroy() {
        UiState.a11yOn = false
        super.onDestroy()
    }

    private companion object {
        const val TAG = "TvGuard"
    }
}
