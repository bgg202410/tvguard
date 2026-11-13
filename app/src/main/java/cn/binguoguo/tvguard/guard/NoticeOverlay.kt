package cn.binguoguo.tvguard.guard

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import cn.binguoguo.tvguard.R
import cn.binguoguo.tvguard.data.Prefs
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 家长留言弹框：盖在正在播放的节目之上，守时桌面在后台时也看得见。
 */
object NoticeOverlay {

    private var wm: WindowManager? = null
    private var view: View? = null

    val isShowing: Boolean get() = view?.parent != null

    fun show(ctx: Context, id: String, text: String, at: Long, day: String) {
        if (!Settings.canDrawOverlays(ctx)) return
        if (isShowing) return

        val manager = ctx.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return
        val v = LayoutInflater.from(ctx).inflate(R.layout.notice_overlay, null)
        val dm = ctx.resources.displayMetrics

        v.findViewById<TextView>(R.id.tvNoticeOverlayText).text = text
        v.findViewById<TextView>(R.id.tvNoticeOverlayDay).text = dayLabel(day, at)

        val btn = v.findViewById<TextView>(R.id.btnNoticeOverlayClose)
        btn.setOnClickListener {
            Prefs.noticeSeenId = id
            hide()
        }

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_SYSTEM_ALERT
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            0,          // 不设 FLAG_NOT_FOCUSABLE：弹框要能接遥控器 OK 键
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.CENTER
            width = minOf((560 * dm.density).toInt(), dm.widthPixels - (80 * dm.density).toInt())
        }

        runCatching {
            manager.addView(v, lp)
            wm = manager
            view = v
            btn.requestFocus()
        }.onFailure {
            view = null
            wm = null
        }
    }

    fun hide() {
        val v = view ?: return
        val manager = wm
        if (v.parent != null && manager != null) {
            runCatching { manager.removeViewImmediate(v) }
        }
        view = null
        wm = null
    }

    private fun dayLabel(day: String, at: Long): String {
        val m = Regex("^\\d{4}-(\\d{2})-(\\d{2})$").find(day)
        if (m != null) return "${m.groupValues[1].toInt()} 月 ${m.groupValues[2].toInt()} 日"
        if (at > 0L) return SimpleDateFormat("M 月 d 日", Locale.CHINA).format(Date(at))
        return ""
    }
}
