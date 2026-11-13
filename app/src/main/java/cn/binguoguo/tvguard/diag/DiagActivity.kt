package cn.binguoguo.tvguard.diag

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import cn.binguoguo.tvguard.R
import cn.binguoguo.tvguard.data.AppRepository
import cn.binguoguo.tvguard.data.Prefs
import cn.binguoguo.tvguard.databinding.ActivityDiagBinding
import cn.binguoguo.tvguard.guard.UsageHelper
import cn.binguoguo.tvguard.guard.WatchTracker
import cn.binguoguo.tvguard.net.Remote
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 设备诊断 + 管理端连接设置，从桌面底部「连接设置」进入。 */
class DiagActivity : AppCompatActivity() {

    private lateinit var b: ActivityDiagBinding
    private val handler = Handler(Looper.getMainLooper())
    private val values = LinkedHashMap<String, TextView>()
    private var appCount = 0

    private var currentCard: LinearLayout? = null
    private var keysBuilt = false

    private var upperCase = false
    private val letterKeys = mutableListOf<TextView>()
    private var shiftKey: TextView? = null

    private val ticker = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, 1_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityDiagBinding.inflate(layoutInflater)
        setContentView(b.root)
        // 家长入口已从应用列表里移除，这里不用再减 1
        appCount = AppRepository(this).load().size
        setupServerCard()
        buildRows()
        if (intent.getBooleanExtra(EXTRA_VERIFY_SKIPPED, false)) {
            b.tvSkipHint.visibility = View.VISIBLE
        }
        // 焦点落在按钮而不是 EditText：一进页就弹软键盘会把半屏内容顶掉
        b.btnTest.post { b.btnTest.requestFocus() }
    }

    override fun onResume() {
        super.onResume()
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    override fun onPause() {
        handler.removeCallbacks(ticker)
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun setupServerCard() {
        b.etServerUrl.setText(Prefs.serverUrl.ifBlank { "http://" })
        b.etServerUrl.setSelection(b.etServerUrl.text.length)
        refreshServerInfo()

        b.btnEdit.setOnClickListener { toggleKeyboard() }
        b.btnTest.setOnClickListener { testConnection() }
        b.btnSave.setOnClickListener { saveServerUrl() }
        b.btnReset.setOnClickListener { resetServerUrl() }
    }

    private fun refreshServerInfo() {
        val url = Prefs.serverUrl
        b.tvServerUrl.text = url.ifBlank { "（未配置）· 在下面填好地址后点「保存并重连」" }
        b.tvServerUrl.setTextColor(getColor(if (url.isBlank()) R.color.warn else R.color.ink))
        b.tvServerSource.text = if (Prefs.isServerUrlCustom) "本机已修改" else "出厂值"
        refreshBadge()
    }

    private fun refreshBadge() {
        val (label, colorRes) = when {
            Prefs.serverUrl.isBlank() -> "未配置" to R.color.warn
            Remote.online -> "已连接" to R.color.ok
            else -> "连不上" to R.color.bad
        }
        b.tvBadge.text = label
        val c = getColor(colorRes)
        b.tvBadge.setTextColor(c)
        b.tvBadge.background = GradientDrawable().apply {
            cornerRadius = dp(18).toFloat()
            setColor(Color.argb(38, Color.red(c), Color.green(c), Color.blue(c)))
            setStroke(dp(1), c)
        }
    }

    private fun setResult(text: String, colorRes: Int) {
        b.tvResult.text = text
        b.tvResult.setTextColor(getColor(colorRes))
    }

    private fun toggleKeyboard() {
        val show = b.llKeyPanel.visibility != View.VISIBLE
        if (show && !keysBuilt) {
            buildCharKeys()
            keysBuilt = true
        }
        b.llKeyPanel.visibility = if (show) View.VISIBLE else View.GONE
        b.btnEdit.text = if (show) "收起键盘" else "⌨ 输入"
        if (show) {
            b.llKeyPanel.post { firstFocusable(b.llKeyPanel)?.requestFocus() }
        } else {
            hideSoftInput()
        }
    }

    /** 电视输入法常叫不出来，只能自绘；path/query 大小写敏感，所以留了大写切换。 */
    private fun buildCharKeys() {
        val rows = listOf(
            listOf("http://", "https://", "://", ".", ":", "/", "-", "_", "?", "="),
            listOf("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "@"),
            "abcdefghijklm".map { it.toString() },
            "nopqrstuvwxyz".map { it.toString() },
            listOf("ABC 大写", "⌫", "←", "→", "清空", "完成")
        )
        rows.forEach { chars ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(5) }
            }
            chars.forEach { c ->
                val isShift = c == "ABC 大写"
                val key = makeKey(c, if (c.length > 2) dp(84) else dp(46), isShift) { onKey(c) }
                if (c.length == 1 && c[0].isLetter()) letterKeys.add(key)
                if (isShift) shiftKey = key
                row.addView(key)
            }
            b.llKeys.addView(row)
        }
    }

    /** 只改键面文字，不重建键盘，遥控器焦点才不会丢 */
    private fun toggleCase() {
        upperCase = !upperCase
        letterKeys.forEach { k ->
            val s = k.text.toString()
            k.text = if (upperCase) s.uppercase() else s.lowercase()
        }
        shiftKey?.let { k ->
            k.text = if (upperCase) "abc 小写" else "ABC 大写"
            k.setTextColor(shiftKeyColor(k.hasFocus()))
        }
    }

    private fun shiftKeyColor(hasFocus: Boolean): Int =
        getColor(
            when {
                hasFocus -> android.R.color.white
                upperCase -> R.color.brand
                else -> R.color.ink
            }
        )

    private fun makeKey(
        label: String,
        width: Int,
        isShift: Boolean = false,
        onClick: () -> Unit
    ): TextView =
        TextView(this).apply {
            text = label
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = true
            textSize = if (label.length > 2) 14f else 17f
            setTextColor(getColor(R.color.ink))
            background = ContextCompat.getDrawable(this@DiagActivity, R.drawable.bg_key)
            layoutParams = LinearLayout.LayoutParams(width, dp(44)).apply {
                marginStart = dp(3)
                marginEnd = dp(3)
            }
            setOnClickListener { onClick() }
            setOnFocusChangeListener { v, has ->
                (v as TextView).setTextColor(
                    if (isShift) shiftKeyColor(has)
                    else getColor(if (has) android.R.color.white else R.color.ink)
                )
                if (has) v.animate().scaleX(1.08f).scaleY(1.08f).setDuration(90).start()
                else v.animate().scaleX(1f).scaleY(1f).setDuration(90).start()
            }
        }

    private fun onKey(k: String) {
        val e = b.etServerUrl
        when (k) {
            "完成" -> { toggleKeyboard(); return }
            // 闭包捕获的是建键时的标签，两个都认
            "ABC 大写", "abc 小写" -> { toggleCase(); return }
            "清空" -> { e.setText(""); return }
            "⌫" -> {
                val a = e.selectionStart.coerceAtLeast(0)
                val z = e.selectionEnd.coerceAtLeast(0)
                if (a != z) e.text.delete(minOf(a, z), maxOf(a, z))
                else if (a > 0) e.text.delete(a - 1, a)
                return
            }
            "←" -> { e.setSelection((e.selectionStart - 1).coerceAtLeast(0)); return }
            "→" -> { e.setSelection((e.selectionStart + 1).coerceAtMost(e.text.length)); return }
            else -> {
                val a = minOf(e.selectionStart, e.selectionEnd).coerceAtLeast(0)
                val z = maxOf(e.selectionStart, e.selectionEnd).coerceAtLeast(0)
                val insert = if (upperCase && k.length == 1 && k[0].isLetter())
                    k.uppercase() else k
                e.text.replace(a, z, insert)
            }
        }
    }

    private fun hideSoftInput() {
        runCatching {
            getSystemService(InputMethodManager::class.java)
                ?.hideSoftInputFromWindow(b.etServerUrl.windowToken, 0)
        }
    }

    private fun testConnection() {
        val url = b.etServerUrl.text.toString().trim()
        setResult("正在测试…", R.color.ink3)
        b.btnTest.isEnabled = false
        lifecycleScope.launch {
            val (ok, msg) = withContext(Dispatchers.IO) { Remote.testServer(url) }
            b.btnTest.isEnabled = true
            setResult("测试：$msg", if (ok) R.color.ok else R.color.bad)
        }
    }

    private fun saveServerUrl() {
        val url = b.etServerUrl.text.toString().trim().trimEnd('/')
        if (url.isBlank()) {
            setResult("地址不能为空", R.color.bad)
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            setResult("地址要以 http:// 开头，例如 http://192.168.1.10:8088", R.color.bad)
            return
        }
        b.btnSave.isEnabled = false
        setResult("已保存，正在重连…", R.color.ink3)
        // refresh() 开头会把 Prefs.serverUrl 同步回内部 base，所以这里只需落盘
        Prefs.serverUrl = url
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { Remote.refresh() }
            b.btnSave.isEnabled = true
            refreshServerInfo()
            setResult(
                if (ok) "已保存并连接成功"
                else "已保存，但仍连不上 · 检查 IP、端口、是否同一局域网",
                if (ok) R.color.ok else R.color.warn
            )
            b.etServerUrl.setText(Prefs.serverUrl.ifBlank { "http://" })
            b.etServerUrl.setSelection(b.etServerUrl.text.length)
        }
    }

    private fun resetServerUrl() {
        Prefs.clearServerUrl()
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { Remote.refresh() }
            refreshServerInfo()
            b.etServerUrl.setText(Prefs.serverUrl.ifBlank { "http://" })
            b.etServerUrl.setSelection(b.etServerUrl.text.length)
            setResult(
                if (ok) "已恢复出厂地址并连接成功"
                else "已恢复出厂地址 · ${Prefs.serverUrl.ifBlank { "当前未预置地址，请在上面填写" }}",
                if (ok) R.color.ok else R.color.ink3
            )
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun buildRows() {
        b.llDiag.removeAllViews()
        values.clear()
        currentCard = null

        section("屏幕")
        row("分辨率", "px")
        row("逻辑尺寸", "dp")
        row("密度", "dpi")

        section("桌面身份")
        row("当前默认桌面", "")
        row("是我自己吗", "")
        row("候选桌面数", "")
        row("候选桌面", "")

        section("权限")
        row("悬浮窗权限", "")
        row("使用情况权限", "")
        row("管控强度", "")

        section("实时信号")
        row("连接状态", "")
        row("屏幕状态", "")
        row("音频是否在播", "")
        row("媒体音量", "")
        row("前台应用", "")
        row("是否在计时", "")
        row("计时豁免", "")

        section("数据")
        row("识别到的应用", "")
        row("今日已看", "")
        row("剩余额度", "")
        row("系统", "")

        section("快捷设置")
        action("打开悬浮窗权限设置") {
            runCatching {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName")
                    )
                )
            }
        }
        action("打开使用情况权限设置") {
            runCatching { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) }
        }
        action("打开主屏幕（默认桌面）设置") { openHomeSettings() }
        action("打开本应用系统设置页") {
            runCatching {
                startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:$packageName")
                    )
                )
            }
        }
    }

    /** 参数叫 title 而非 text，避免被 apply 里的同名属性遮蔽 */
    private fun section(title: String) {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = ContextCompat.getDrawable(this@DiagActivity, R.drawable.bg_card)
            setPadding(dp(18), dp(14), dp(18), dp(14))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(12) }
        }
        card.addView(TextView(this).apply {
            this.text = title
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            setTextColor(getColor(R.color.brand))
            setPadding(0, 0, 0, dp(6))
        })
        b.llDiag.addView(card)
        currentCard = card
    }

    private fun row(label: String, initial: String): TextView {
        val line = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(5), 0, dp(5))
        }
        line.addView(TextView(this).apply {
            text = label
            textSize = 15f
            setTextColor(getColor(R.color.ink2))
            layoutParams = LinearLayout.LayoutParams(dp(200), ViewGroup.LayoutParams.WRAP_CONTENT)
        })
        val value = TextView(this).apply {
            text = initial
            textSize = 15f
            setTextColor(getColor(R.color.ink))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        line.addView(value)
        (currentCard ?: b.llDiag).addView(line)
        values[label] = value
        return value
    }

    private fun action(label: String, onClick: () -> Unit) {
        val tv = TextView(this).apply {
            text = label
            textSize = 16f
            gravity = Gravity.CENTER
            isFocusable = true
            isClickable = true
            background = ContextCompat.getDrawable(this@DiagActivity, R.drawable.bg_option)
            setTextColor(getColor(R.color.brand))
            setPadding(dp(20), dp(12), dp(20), dp(12))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
            setOnClickListener { onClick() }
        }
        (currentCard ?: b.llDiag).addView(tv)
    }

    /** 部分厂商把「主屏幕」藏在不同位置，逐个试 */
    private fun openHomeSettings() {
        val candidates = listOf(
            Settings.ACTION_HOME_SETTINGS,
            "android.settings.MANAGE_DEFAULT_APPS_SETTINGS",
            Settings.ACTION_SETTINGS
        )
        for (action in candidates) {
            if (runCatching { startActivity(Intent(action)) }.isSuccess) return
        }
    }

    private fun refresh() {
        val dm = resources.displayMetrics

        values["分辨率"]?.text = "${dm.widthPixels} × ${dm.heightPixels}"
        values["逻辑尺寸"]?.text =
            "${(dm.widthPixels / dm.density).toInt()} × ${(dm.heightPixels / dm.density).toInt()}"
        values["密度"]?.text = "${dm.densityDpi}"

        val homePkg = currentHomePackage()
        values["当前默认桌面"]?.text = homePkg ?: "读不到"
        val isSelf = homePkg == packageName
        values["是我自己吗"]?.text = if (isSelf) "是，桌面身份已生效" else "否，现在跑的是 ${homePkg ?: "?"}"
        values["是我自己吗"]?.setTextColor(getColor(if (isSelf) R.color.ok else R.color.bad))

        val homes = homeCandidates()
        values["候选桌面数"]?.text = "${homes.size}"
        values["候选桌面"]?.text = homes.joinToString("  |  ").ifEmpty { "无" }

        val overlay = Settings.canDrawOverlays(this)
        val usage = UsageHelper.hasPermission(this)
        values["悬浮窗权限"]?.text = if (overlay) "已开启" else "未开启"
        values["悬浮窗权限"]?.setTextColor(getColor(if (overlay) R.color.ok else R.color.bad))
        values["使用情况权限"]?.text = if (usage) "已开启（仅诊断用）" else "未开启（不影响计时）"
        values["使用情况权限"]?.setTextColor(getColor(if (usage) R.color.ok else R.color.warn))
        values["管控强度"]?.text = if (overlay) "强：可盖顶弹题" else "弱：只能回桌面时拦"
        values["管控强度"]?.setTextColor(getColor(if (overlay) R.color.ok else R.color.bad))

        val pm = getSystemService(PowerManager::class.java)
        val am = getSystemService(AudioManager::class.java)
        values["连接状态"]?.text = Remote.statusText
        values["连接状态"]?.setTextColor(getColor(if (Remote.online) R.color.ok else R.color.warn))
        values["屏幕状态"]?.text = if (pm?.isInteractive == true) "亮" else "灭"
        values["音频是否在播"]?.text = if (am?.isMusicActive == true) "是" else "否"
        values["媒体音量"]?.text = "${am?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: -1}"
        values["前台应用"]?.text = UsageHelper.foregroundPackage(this) ?: "读不到（未授权）"

        // 唯一的豁免来源是「连不上管理端 / 管控关闭 / 自由时段」，电视端没有设置页
        values["计时豁免"]?.text = when {
            !Remote.online -> "离线（${Remote.statusText}）· 完全不限制"
            !Remote.shouldManage() -> "管控关闭或自由时段"
            Remote.isBlocked() -> "时段外禁用"
            else -> "无"
        }
        val tracking = Remote.shouldManage() && WatchTracker.isWatching(this)
        values["是否在计时"]?.text = if (tracking) "正在计时" else "未计时"
        values["是否在计时"]?.setTextColor(getColor(if (tracking) R.color.ok else R.color.ink3))

        values["识别到的应用"]?.text = "$appCount 个"
        values["今日已看"]?.text = "${WatchTracker.liveAccumulatedMs / 60_000L} 分钟"
        values["剩余额度"]?.text = "${WatchTracker.liveRemainingMs / 60_000L} 分钟"
        values["系统"]?.text =
            "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}(API ${Build.VERSION.SDK_INT})"

        refreshBadge()
    }

    private fun currentHomePackage(): String? {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val res = packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)
        return res?.activityInfo?.packageName
    }

    private fun homeCandidates(): List<String> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        return runCatching {
            packageManager.queryIntentActivities(intent, 0)
                .map { it.activityInfo.packageName }
                .distinct()
        }.getOrDefault(emptyList())
    }

    private fun firstFocusable(root: ViewGroup): View? {
        for (i in 0 until root.childCount) {
            val child = root.getChildAt(i)
            if (child is ViewGroup) firstFocusable(child)?.let { return it }
            if (child.isFocusable && child.visibility == View.VISIBLE) return child
        }
        return null
    }

    companion object {
        const val EXTRA_VERIFY_SKIPPED = "verify_skipped"
    }
}
