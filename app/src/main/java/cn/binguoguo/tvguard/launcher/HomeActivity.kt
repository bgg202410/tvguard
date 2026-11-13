package cn.binguoguo.tvguard.launcher

import android.content.Intent
import android.content.res.ColorStateList
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import cn.binguoguo.tvguard.R
import cn.binguoguo.tvguard.data.AppEntry
import cn.binguoguo.tvguard.data.AppRepository
import cn.binguoguo.tvguard.data.Prefs
import cn.binguoguo.tvguard.databinding.ActivityHomeBinding
import cn.binguoguo.tvguard.guard.GateActivity
import cn.binguoguo.tvguard.guard.GuardDeviceAdmin
import cn.binguoguo.tvguard.guard.KeepAliveActivity
import cn.binguoguo.tvguard.guard.UiState
import cn.binguoguo.tvguard.guard.UpdateActivity
import cn.binguoguo.tvguard.guard.WatchTracker
import cn.binguoguo.tvguard.net.Remote
import cn.binguoguo.tvguard.quiz.LockActivity
import cn.binguoguo.tvguard.quiz.QuizActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 桌面本体。
 */
class HomeActivity : AppCompatActivity() {

    private lateinit var b: ActivityHomeBinding
    private lateinit var adapter: AppAdapter
    private val handler = Handler(Looper.getMainLooper())

    // 系统安装应用
    private var apps: List<AppEntry> = emptyList()
    private var autoLaunched = false
    private var launchTries = 0
    private var selfNavigating = false
    private var gateShowing = false
    private var lastUpdateCheck = 0L
    private var lastSelfLaunchAt = 0L

    private val ticker = object : Runnable {
        override fun run() {
            refreshStatus()
            handler.postDelayed(this, 1_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityHomeBinding.inflate(layoutInflater)
        setContentView(b.root)

        adapter = AppAdapter { entry -> openApp(entry) }
        val lm = GridLayoutManager(this, 4)
        lm.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
            override fun getSpanSize(position: Int): Int =
                if (adapter.isHeader(position)) 4 else 1
        }
        b.rvApps.layoutManager = lm
        b.rvApps.adapter = adapter
        b.rvApps.itemAnimator = null

        loadApps()
        setupSettingsEntry()
        refreshStatus()
        reportAppsOnce()
    }

    override fun onResume() {
        super.onResume()
        selfNavigating = false
        gateShowing = false
        // 首页自己就显示「下次提问还有 x:xx」，后台角标这时没必要挂
        UiState.homeVisible = true
        if (!Remote.online) Remote.checkAtBoot()
        syncAfterLeave()
        loadApps()
        refreshStatus()
        handler.removeCallbacks(ticker)
        handler.post(ticker)
        handlePendingQuiz()
        // 管理端新 APK
        checkUpdateQuietly()
        handler.postDelayed({ maybeLaunchConfigured() }, 400L)
        b.rvApps.post { b.rvApps.getChildAt(0)?.requestFocus() }
    }

    /**
     * 管理端的新apk检查
     */
    private fun checkUpdateQuietly() {
        val now = System.currentTimeMillis()
        if (now - lastUpdateCheck < UPDATE_CHECK_MS) return
        lastUpdateCheck = now
        lifecycleScope.launch {
            val info = withContext(Dispatchers.IO) { Remote.checkUpdate() }
            if (info != null && !isFinishing && !isDestroyed) {
                lastSelfLaunchAt = System.currentTimeMillis()
                startActivity(Intent(this@HomeActivity, UpdateActivity::class.java))
            }
        }
    }

    /**
     * 从别的应用 / 系统主页回到守时桌面时，把这段时间对齐一次。
     */
    private fun syncAfterLeave() {
        WatchTracker.flush()
        WatchTracker.reportPending()
        Remote.refreshIfStale(30_000L)
    }

    @Deprecated("返回键改为家长验证")
    override fun onBackPressed() {
        if (!Remote.shouldManage()) {
            finish()
            return
        }
        openGate(GateActivity.MODE_EXIT)
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (selfNavigating) { selfNavigating = false; return }
        if (gateShowing || isFinishing) return

        val now = System.currentTimeMillis()
        if (now - lastSelfLaunchAt < SELF_LAUNCH_GUARD_MS) return
        if (now - WatchTracker.lastPageLaunchAt < SELF_LAUNCH_GUARD_MS) return
        if (WatchTracker.quizShowing || WatchTracker.lockShowing) return

        if (!Remote.shouldManage()) return
        openGate(GateActivity.MODE_HOME)
    }

    private fun openGate(mode: String) {
        if (gateShowing) return
        gateShowing = true
        val i = Intent(this, GateActivity::class.java).putExtra(GateActivity.EXTRA_MODE, mode)
        runCatching { startActivity(i) }.onFailure { gateShowing = false }
    }

    /**
     * 上报已装应用清单
     */
    private fun reportAppsOnce() {
        if (appsReported || apps.isEmpty()) return
        appsReported = true
        val list = apps
        lifecycleScope.launch(Dispatchers.IO) { Remote.reportApps(list) }
    }

    private fun maybeLaunchConfigured() {
        if (autoLaunched || isFinishing) return
        val s = Remote.session
        if (s == null) {
            // session 还没到（开机时网卡可能刚起来），等几轮再看
            if (Remote.online.not() && launchTries++ < 8) {
                handler.postDelayed({ maybeLaunchConfigured() }, 600L)
            }
            return
        }
        val pkg = s.launchPkg
        if (pkg.isBlank()) return
        val entry = apps.firstOrNull { it.packageName == pkg }
        if (entry == null) {
            return
        }
        autoLaunched = true
        openApp(entry)
    }

    override fun onPause() {
        handler.removeCallbacks(ticker)
        UiState.homeVisible = false
        WatchTracker.flush()
        WatchTracker.reportPending()
        super.onPause()
    }

    override fun onDestroy() {
        UiState.homeVisible = false
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun handlePendingQuiz() {
        val intervalMs = (Remote.session?.quizIntervalMin ?: Prefs.quizIntervalMin) * 60_000L
        val overdue = WatchTracker.liveSessionMs >= intervalMs
        if (!Prefs.pendingQuiz && !overdue) return
        Prefs.pendingQuiz = false
        if (!Remote.shouldManage()) return
        // 交给 LockActivity
        lastSelfLaunchAt = System.currentTimeMillis()
        if (WatchTracker.liveRemainingMs <= 0L || Remote.isBlocked()) {
            startActivity(Intent(this, LockActivity::class.java))
            return
        }
        WatchTracker.quizShowing = true
        startActivity(Intent(this, QuizActivity::class.java))
    }

    private fun loadApps() {
        apps = AppRepository(this).load()
        submitWithRecent()
    }


    private fun submitWithRecent() {
        val byPkg = apps.associateBy { it.packageName }
        val recent = Prefs.recentPackages(5).mapNotNull { byPkg[it] }
        adapter.submit(apps, recent)
    }


    private fun renderKeepAliveEntry() {
        val on = GuardDeviceAdmin.isActive(this)
        b.tvKeepAlive.visibility = if (on) View.GONE else View.VISIBLE
        b.tvKeepAlive.setOnClickListener {
            startActivity(Intent(this, KeepAliveActivity::class.java))
        }
    }

    private fun setupSettingsEntry() {
        b.tvSettings.setOnClickListener {
            // 本页自己启动的页面，别让 onUserLeaveHint 又弹一层家长验证
            lastSelfLaunchAt = System.currentTimeMillis()
            openGate(GateActivity.MODE_DIAG)
        }
    }

    private fun refreshSettingsHint() {
        val need = Prefs.serverUrl.isBlank() || !Remote.online
        b.tvSettings.text = getString(
            if (need) R.string.home_settings_need else R.string.home_settings
        )
        b.tvSettings.setTextColor(
            ContextCompat.getColor(this, if (need) R.color.warn else R.color.ink2)
        )
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun openApp(entry: AppEntry) {
        selfNavigating = true
        lastSelfLaunchAt = System.currentTimeMillis()
        Prefs.touchRecent(entry.packageName)
        val component = entry.component
        if (component != null) {
            val intent = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
                this.component = component
                addFlags(Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            }
            if (runCatching { startActivity(intent) }.isSuccess) {
                submitWithRecent()
                return
            }
        }
        val ok = packageManager.getLaunchIntentForPackage(entry.packageName)?.let {
            runCatching { startActivity(it) }.isSuccess
        } ?: false
        if (!ok) {
            selfNavigating = false
            Prefs.removeRecent(entry.packageName)
        }
        submitWithRecent()
    }

    private fun refreshStatus() {
        Prefs.checkRollover()
        renderKeepAliveEntry()
        refreshSettingsHint()
        val now = Date()
        b.tvClock.text = SimpleDateFormat("HH:mm", Locale.getDefault()).format(now)
        b.tvDate.text = SimpleDateFormat("M月d日 EEEE", Locale.CHINA).format(now)
        b.tvLink.text = Remote.statusText

        // ① 连不上管理端 / 管控关闭 / 自由时段：不做任何限制，也不显示额度
        if (!Remote.shouldManage()) {
            val free = Remote.online && Remote.session?.enabled == false
            b.tvRemainLabel.text = if (free) "管控已关闭" else if (!Remote.online) "未连接管理端" else "自由使用"
            b.tvRemain.text = "--"
            b.tvRemainUnit.text = ""
            val dim = ContextCompat.getColor(this, R.color.ink3)
            b.tvRemain.setTextColor(dim)
            b.tvRemainUnit.setTextColor(dim)
            // 连不上 / 还没拿到 session 时别把进度条清零：先用本地落盘的进度顶着。
            val localTotal = (Prefs.dailyLimitMin.toLong() * 60_000L).coerceAtLeast(1L)
            b.pbQuota.progress =
                ((Prefs.accumulatedMs * 1000) / localTotal).toInt().coerceIn(0, 1000)
            b.pbQuota.progressTintList = ColorStateList.valueOf(dim)
            b.tvStatus.text = if (Remote.online) {
                "当前不做限制"
            } else {
                "连不上管理端，不做限制 · 请检查电视和管理端是否在同一个网络"
            }
            return
        }

        val remainMs = WatchTracker.liveRemainingMs
        val remainMin = ((remainMs + 59_999L) / 60_000L).toInt()
        val accent = accentFor(remainMin)

        if (remainMin >= 60) {
            b.tvRemainLabel.text = "今天还能看"
            b.tvRemain.text = "%d:%02d".format(remainMin / 60, remainMin % 60)
            b.tvRemainUnit.text = "小时"
        } else {
            b.tvRemainLabel.text = "今天还能看"
            // 调大字号以补偿去掉的"小时"单位，视觉重量不变
            b.tvRemain.text = remainMin.toString()
            b.tvRemainUnit.text = "分钟"
        }
        b.tvRemain.setTextColor(accent)
        b.tvRemainUnit.setTextColor(accent)

        val total = WatchTracker.totalMs.coerceAtLeast(1L)
        b.pbQuota.progress = ((WatchTracker.liveAccumulatedMs * 1000) / total).toInt().coerceIn(0, 1000)
        b.pbQuota.progressTintList = ColorStateList.valueOf(accent)

        val usedMin = WatchTracker.liveAccumulatedMs / 60_000L
        val toNext = WatchTracker.msToNextQuiz
        b.tvStatus.text = if (remainMs <= 0L) {
            when (Remote.session?.rewardStage) {
                "open" -> "时长用完了 · 打开锁定页可以答题换时长"
                "exhausted" -> "今天看完了 · 明天 0 点恢复"
                else -> "今天的额度用完了 · 明天 0 点自动恢复"
            }
        } else {
            "已看 $usedMin 分钟 · 下次提问还有 %d:%02d".format(toNext / 60_000L, (toNext % 60_000L) / 1000L)
        }
    }

    private fun accentFor(remainMin: Int): Int {
        val totalMin = (WatchTracker.totalMs / 60_000L).toFloat().coerceAtLeast(1f)
        val ratio = remainMin / totalMin
        val res = when {
            ratio <= 0.05f -> R.color.bad
            ratio <= 0.20f -> R.color.warn
            else -> R.color.ok
        }
        return ContextCompat.getColor(this, res)
    }

    companion object {
        @Volatile
        private var appsReported = false
        private const val UPDATE_CHECK_MS = 3 * 60_000L
        private const val SELF_LAUNCH_GUARD_MS = 4_000L
    }
}
