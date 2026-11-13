package cn.binguoguo.tvguard.guard

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import cn.binguoguo.tvguard.R
import cn.binguoguo.tvguard.data.Prefs
import cn.binguoguo.tvguard.databinding.ActivityGateBinding
import cn.binguoguo.tvguard.diag.DiagActivity
import cn.binguoguo.tvguard.launcher.HomeActivity
import cn.binguoguo.tvguard.net.Remote
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 家长验证页：按主页 / 按返回想离开守时桌面时弹出来，输对管理密码才放行。
 */
class GateActivity : AppCompatActivity() {

    private lateinit var b: ActivityGateBinding
    private var busy = false
    private var diagMode = false
    private val pw = StringBuilder()
    private var shownAt = 0L
    private val handler = Handler(Looper.getMainLooper())
    private var autoBackAt = 0L
    private var settled = false

    private val autoTicker = object : Runnable {
        override fun run() {
            val left = ((autoBackAt - System.currentTimeMillis()) / 1000L).coerceAtLeast(0L)
            b.tvAuto.text = getString(R.string.gate_auto_back, (left / 60).toInt(), (left % 60).toInt())
            if (left <= 0L) {
                deny()
                return
            }
            handler.postDelayed(this, 500L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        shownAt = SystemClock.elapsedRealtime()
        val mode = intent.getStringExtra(EXTRA_MODE)
        diagMode = mode == MODE_DIAG

        // 没地址就没有服务端可验密码，直接放行，否则永远配不上
        if (diagMode && Prefs.serverUrl.isBlank()) {
            openDiag(skippedVerify = true)
            return
        }

        b = ActivityGateBinding.inflate(layoutInflater)
        setContentView(b.root)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val home = mode != MODE_EXIT
        b.tvReason.text = getString(
            when {
                diagMode -> R.string.gate_reason_diag
                home -> R.string.gate_reason_home
                else -> R.string.gate_reason_exit
            }
        )

        buildKeyboard()
        renderPwd()
        armAutoBack()
    }

    override fun onResume() {
        super.onResume()
        // 告诉桌面拦截：验证页在前台，别来抢焦点（会把键盘打断）
        UiState.gateShowing = true
    }

    override fun onPause() {
        UiState.gateShowing = false
        super.onPause()
    }

    override fun onDestroy() {
        UiState.gateShowing = false
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun buildKeyboard() {
        b.kbRows.removeAllViews()
        listOf("1234567890", "abcdefghij", "klmnopqrst", "uvwxyz").forEach { chars ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(6) }
            }
            chars.forEach { c ->
                row.addView(makeKey(c.toString(), dp(54), 46) { onChar(c) })
            }
            b.kbRows.addView(row)
        }

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        }
        actions.addView(makeKey(getString(R.string.gate_del), dp(96), 48, primary = false) { onDelete() })
        actions.addView(makeKey(getString(R.string.gate_clear), dp(96), 48, primary = false) {
            pw.setLength(0); renderPwd(); armAutoBack()
        })
        actions.addView(makeKey(getString(R.string.gate_ok), dp(150), 48, primary = true) { submit() })
        b.kbRows.addView(actions)
    }

    private fun makeKey(label: String, width: Int, height: Int, primary: Boolean = false, onClick: () -> Unit): TextView {
        val tv = TextView(this)
        tv.text = label
        tv.gravity = Gravity.CENTER
        tv.isClickable = true
        tv.isFocusable = true
        tv.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, if (label.length > 1) 17f else 19f)
        tv.setTextColor(Color.WHITE)
        tv.background = ContextCompat.getDrawable(this, if (primary) R.drawable.bg_primary else R.drawable.bg_option)
        tv.layoutParams = LinearLayout.LayoutParams(width, dp(height)).apply { marginStart = dp(4); marginEnd = dp(4) }
        tv.setOnClickListener { if (!busy) onClick() }
        // 焦点状态文字保持白字，蓝底上才看得清（bg_option 聚焦时是蓝色）
        tv.setOnFocusChangeListener { v, has ->
            (v as TextView).setTextColor(Color.WHITE)
            if (has) v.animate().scaleX(1.06f).scaleY(1.06f).setDuration(90).start()
            else v.animate().scaleX(1f).scaleY(1f).setDuration(90).start()
        }
        return tv
    }

    private fun onChar(c: Char) {
        if (pw.length >= 24) return
        pw.append(c)
        renderPwd()
        armAutoBack()
        if (b.tvMsg.text.isNotEmpty()) b.tvMsg.text = ""
    }

    private fun onDelete() {
        if (pw.isNotEmpty()) pw.setLength(pw.length - 1)
        renderPwd()
        armAutoBack()
    }

    private fun renderPwd() {
        if (pw.isEmpty()) {
            b.tvPwd.text = getString(R.string.gate_pwd_empty)
            b.tvPwd.setTextColor(ContextCompat.getColor(this, R.color.ink3))
        } else {
            // 只给圆点 + 位数，别把密码明文摆在电视上
            b.tvPwd.text = "●".repeat(pw.length) + "  (${pw.length})"
            b.tvPwd.setTextColor(ContextCompat.getColor(this, R.color.ink))
        }
    }

    private fun armAutoBack(ms: Long = AUTO_BACK_MS) {
        if (busy) return
        autoBackAt = System.currentTimeMillis() + ms
        handler.removeCallbacks(autoTicker)
        handler.post(autoTicker)
    }

    private fun submit() {
        if (busy) return
        val pwd = pw.toString()
        if (pwd.isEmpty()) {
            b.tvMsg.text = getString(R.string.gate_empty)
            return
        }
        busy = true
        handler.removeCallbacks(autoTicker)   // 验证中不要再被自动返回打断
        b.tvMsg.text = getString(R.string.gate_checking)

        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { Remote.verifyAdmin(pwd) }
            busy = false
            when (ok) {
                true -> if (diagMode) openDiag() else allow()
                false -> {
                    b.tvMsg.text = getString(R.string.gate_wrong)
                    pw.setLength(0)
                    renderPwd()
                    // 家长主动进设置，输错留在本页重试
                    if (diagMode) armAutoBack() else handler.postDelayed({ deny() }, 1200L)
                }
                // 连不上管理端：按「连不上就放行」的总规则处理
                null -> if (diagMode) openDiag(skippedVerify = true) else allow()
            }
        }
    }

    private fun allow() {
        handler.removeCallbacksAndMessages(null)
        WatchTracker.flush()
        WatchTracker.reportPending()
        Remote.refreshIfStale(0L)
        showChoices()
    }

    private fun openDiag(skippedVerify: Boolean = false) {
        settled = true
        handler.removeCallbacksAndMessages(null)
        runCatching {
            startActivity(
                Intent(this, DiagActivity::class.java)
                    .putExtra(DiagActivity.EXTRA_VERIFY_SKIPPED, skippedVerify)
            )
        }
        finish()
    }

    private fun showChoices() {
        busy = false
        b.tvTitle.text = getString(R.string.gate_passed)
        b.tvReason.text = getString(R.string.gate_where)
        b.tvPwd.visibility = android.view.View.GONE
        b.tvMsg.visibility = android.view.View.GONE
        b.kbRows.removeAllViews()

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        }
        // 默认焦点落在「回守时桌面」：家长犹豫时不会因为按一下 OK 就掉到系统桌面出不来
        val stay = makeKey(getString(R.string.gate_stay), dp(300), 56, primary = true) { deny() }
        val sys = makeKey(getString(R.string.gate_sys), dp(300), 56) { goSystemHome() }
        row.addView(stay)
        row.addView(sys)
        b.kbRows.addView(row)
        stay.requestFocus()
        armAutoBack(CHOICE_BACK_MS)
    }

    private fun goSystemHome() {
        settled = true
        // 给一段放行窗口：否则桌面拦截会在几秒内把家长又弹回守时桌面，
        // 什么都干不了（装应用、改设置都在系统桌面上）。
        UiState.allowDesktopUntil = System.currentTimeMillis() + DesktopGuard.ALLOW_WINDOW_MS
        handler.removeCallbacksAndMessages(null)
        runCatching {
            startActivity(
                Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
        finish()
    }

    private fun deny() {
        settled = true
        handler.removeCallbacksAndMessages(null)
        runCatching {
            startActivity(
                Intent(this, HomeActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            )
        }
        finish()
    }

    override fun onStop() {
        super.onStop()
        if (settled || isChangingConfigurations) return
        deny()
    }

    @Deprecated("返回键等同「不放行」")
    override fun onBackPressed() {
        // 刚弹出来的 600ms 内不认返回：上一下「返回」的抬起事件会落到这一页，
        // 不挡的话就是「按返回 → 弹验证页 → 立刻自己关掉」，看着像没反应
        if (SystemClock.elapsedRealtime() - shownAt < 600L) return
        deny()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_MODE = "mode"
        const val MODE_HOME = "home"
        const val MODE_EXIT = "exit"
        const val MODE_DIAG = "diag"

        private const val AUTO_BACK_MS = 3 * 60_000L
        private const val CHOICE_BACK_MS = 15_000L
    }
}
