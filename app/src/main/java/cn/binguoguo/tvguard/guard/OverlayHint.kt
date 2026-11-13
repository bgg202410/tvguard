package cn.binguoguo.tvguard.guard

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager

/**
 * 未保活而生的答题倒计时进度条
 */
object OverlayHint {

    private const val TAG = "TvGuard"

    private var wm: WindowManager? = null
    private var view: RingCountdownView? = null
    private var attached = false

    private var density = 1f

    fun attach(ctx: Context) {
        if (attached) return
        if (!Settings.canDrawOverlays(ctx)) return
        val manager = ctx.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return
        density = ctx.resources.displayMetrics.density
        wm = manager
        view = RingCountdownView(ctx)
        attached = true
    }

    /**
     * 刷新内容与显隐。
     */
    fun update(ctx: Context, label: String, fraction: Float, show: Boolean) {
        if (!attached) attach(ctx)
        val manager = wm ?: return
        val v = view ?: return

        if (!show) {
            hide()
            return
        }
        v.set(label, fraction)
        if (v.parent != null) return

        runCatching { manager.addView(v, params()) }
            .onFailure {
                attached = false
                wm = null
                view = null
            }
    }

    fun hide() {
        val manager = wm ?: return
        val v = view ?: return
        if (v.parent == null) return
        runCatching { manager.removeViewImmediate(v) }
    }

    fun release() {
        hide()
        wm = null
        view = null
        attached = false
    }

    private fun params(): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_SYSTEM_ALERT
        }
        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.END or Gravity.TOP
            x = (14 * density).toInt()
            y = (52 * density).toInt()
        }
    }
}
