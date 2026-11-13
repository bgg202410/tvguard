package cn.binguoguo.tvguard.guard

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import cn.binguoguo.tvguard.data.Prefs
import cn.binguoguo.tvguard.net.Remote
import cn.binguoguo.tvguard.quiz.LockActivity
import cn.binguoguo.tvguard.quiz.QuizActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * 观看计时引擎。
 */
object WatchTracker {

    private const val TAG = "TvGuard"
    private const val TICK_MS = 1_000L
    private const val FLUSH_EVERY_MS = 1_000L
    private const val CATCH_UP_MIN_MS = 5_000L
    private const val FALLBACK_BEAT_MS = 5_000L
    private const val QUIZ_STUCK_MS = 10 * 60_000L
    private const val CATCH_UP_MAX_MS = 10 * 60_000L

    @Volatile
    private var catchUpDone = false

    @Volatile
    var quizLeftAt: Long = 0L

    @Volatile
    var lockLeftAt: Long = 0L

    @Volatile
    private var lastRebringAt: Long = 0L

    @Volatile
    var lastPageLaunchAt: Long = 0L

    /**
     * 已经问过家长的那条管理员指令的时间戳。
     */
    @Volatile
    private var adminAckAt: Long = 0L

    @Volatile
    private var adminError: String = ""

    private const val REBRING_DELAY_MS = 1_500L

    /** 两次兜底之间的最小间隔 */
    private const val REBRING_GAP_MS = 3_000L

    private fun beatEveryMs(): Long {
        val sec = Remote.session?.heartbeatSec ?: 5
        return sec.coerceIn(5, 120) * 1000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val main = Handler(Looper.getMainLooper())

    private var appContext: Context? = null
    private var job: Job? = null

    @Volatile
    var quizShowing: Boolean = false
        set(value) {
            field = value
            quizShownAt = if (value) System.currentTimeMillis() else 0L
            if (!value) quizLeftAt = 0L
        }

    @Volatile
    var lockShowing: Boolean = false

    @Volatile
    private var quizShownAt: Long = 0L

    @Volatile
    private var quizRetryNotAfter: Long = 0L

    @Volatile
    private var lastBeatAt: Long = 0L

    @Volatile
    private var pendingMs: Long = 0L

    @Volatile
    private var pendingReportMs: Long = 0L

    @Volatile
    private var reportRestored = false
    val liveSessionMs: Long get() = Prefs.sessionMs + pendingMs

    val liveAccumulatedMs: Long get() = Prefs.accumulatedMs + pendingMs
    val totalMs: Long
        get() {
            val s = Remote.session ?: return 120L * 60_000L
            return (s.dailyLimitMin * 60_000L + s.bonusMs).coerceAtLeast(60_000L)
        }

    val liveRemainingMs: Long get() = (totalMs - liveAccumulatedMs).coerceAtLeast(0L)

    fun attach(ctx: Context) {
        appContext = ctx.applicationContext
        if (!reportRestored) {
            reportRestored = true
            pendingReportMs = Prefs.pendingReportMs
            if (pendingReportMs > 0L) Log.d(TAG, "恢复待上报时长 ${pendingReportMs / 1000}s")
        }
        Remote.onDayReset = {
            pendingMs = 0L
            pendingReportMs = 0L
            Prefs.pendingReportMs = 0L
            Log.d(TAG, "服务端已跨天，本地累计与待上报零头清零")
        }
        if (job != null) return
        job = scope.launch {
            while (isActive) {
                delay(TICK_MS)
                tick()
            }
        }
    }

    private fun tick() {
        val ctx = appContext ?: return
        Prefs.checkRollover()
        beat()
        diag()
        refreshNoticeOverlay(ctx)   // 先判留言，角标据此让位
        refreshOverlay(ctx)
        handleAdminCmd(ctx)
        if (quizShowing && quizShownAt > 0 && System.currentTimeMillis() - quizShownAt > QUIZ_STUCK_MS) {
            quizShowing = false
        }

        rebringIfLeaked(ctx)

        if (lockShowing) {
            flush()
            return
        }

        if (!Remote.online) {
            flush()
            return
        }
        if (Remote.isBlocked()) {
            flush()
            requestLock(ctx)
            return
        }
        if (!Remote.shouldManage()) {
            flush()
            return
        }

        if (!isWatching(ctx)) return
        catchUpOnce()
        if (liveRemainingMs <= 0L) {
            flush()
            if (!quizShowing) requestLock(ctx)
            return
        }

        pendingMs += TICK_MS
        pendingReportMs += TICK_MS
        if (pendingMs >= FLUSH_EVERY_MS) flush()

        val intervalMs = (Remote.session?.quizIntervalMin ?: Prefs.quizIntervalMin) * 60_000L
        if (!quizShowing && liveSessionMs >= intervalMs && System.currentTimeMillis() >= quizRetryNotAfter) {
            flush()
            requestQuiz(ctx)
        }
    }

    /**
     * 兜底：答题页 / 锁定页被按到后台就拉回前台。
     */
    private fun rebringIfLeaked(ctx: Context) {
        val now = System.currentTimeMillis()
        if (now - lastRebringAt < REBRING_GAP_MS) return

        val target = when {
            quizShowing && quizLeftAt > 0 && now - quizLeftAt > REBRING_DELAY_MS -> QuizActivity::class.java
            lockShowing && lockLeftAt > 0 && now - lockLeftAt > REBRING_DELAY_MS -> LockActivity::class.java
            else -> null
        } ?: return

        lastRebringAt = now
        lastPageLaunchAt = now
        main.post { startActivity(ctx, target) { } }
    }

    private var diagN = 0
    private fun diag() {
        diagN += 1
        if (diagN % 10 != 0) return
        Log.d(
            TAG,
            "tick online=${Remote.online} manage=${Remote.shouldManage()} " +
                    "session=${liveSessionMs / 1000}s acc=${liveAccumulatedMs / 1000}s " +
                    "remain=${liveRemainingMs / 1000}s quiz=$quizShowing lock=$lockShowing " +
                    "interval=${Remote.session?.quizIntervalMin}"
        )
    }

    private fun refreshOverlay(ctx: Context) {
        // 验证页 / 答题页 / 锁定页都是全屏拦截，那里不该再挂角标。
        val show = Remote.shouldManage() && !quizShowing && !lockShowing &&
                !UiState.gateShowing && !UiState.quizPageShowing &&
                !UiState.homeVisible && liveRemainingMs > 0L && !NoticeOverlay.isShowing
        if (!show) {
            main.post { OverlayHint.update(ctx, "", 1f, false) }
            return
        }
        val intervalMs = (Remote.session?.quizIntervalMin ?: Prefs.quizIntervalMin) * 60_000L
        val left = msToNextQuiz
        val label = "%d:%02d".format(left / 60_000L, (left % 60_000L) / 1000L)
        val fraction = if (intervalMs > 0L) left.toFloat() / intervalMs.toFloat() else 1f
        main.post { OverlayHint.update(ctx, label, fraction, true) }
    }

    /**
     * 家长留言：除了答题页，任何页面都弹。
     */
    private fun refreshNoticeOverlay(ctx: Context) {
        val id = Prefs.noticeId
        val text = Prefs.noticeText
        val inQuiz = quizShowing || UiState.quizPageShowing
        if (id.isBlank() || text.isBlank() || id == Prefs.noticeSeenId || inQuiz) {
            main.post { NoticeOverlay.hide() }
            return
        }
        if (NoticeOverlay.isShowing) return   // 已经弹着，别重复 addView
        main.post { NoticeOverlay.show(ctx, id, text, Prefs.noticeAt, Prefs.noticeDay) }
    }

    fun takePendingReportMs(): Long {
        val v = pendingReportMs
        if (v <= 0L) return 0L
        pendingReportMs = 0L
        Prefs.pendingReportMs = 0L     // 磁盘同步清零，别让下次进程重启又报一遍
        return v
    }

    private fun beat() {
        val now = System.currentTimeMillis()
        if (now - lastBeatAt < beatEveryMs()) return
        lastBeatAt = now
        appContext?.let { ctx -> scope.launch { DeviceOwner.reassertHidden(ctx) } }

        if (!Remote.online) {
            scope.launch { Remote.refresh() }
            return
        }
        // 孩子在看别的应用时首页不在前台（HomeActivity 的 ticker 已停），没人刷 session。
        // 这里每分钟兜一次：后台改策略、下发「激活设备管理员」才能及时到达，
        // 不用等回到守时桌面。
        Remote.refreshIfStale(beatEveryMs())
        // 顺手把攒着的观看时长报上去（0 也发，纯当心跳）。
        // 捎带「设备管理员开没开」：这是后台那个开关唯一的状态来源。
        val delta = takePendingReportMs()
        val ctx = appContext
        val active = ctx?.let { GuardDeviceAdmin.isActive(it) }
        val ack = adminAckAt
        val err = adminError
        adminError = ""
        val a11y = UiState.a11yOn
        scope.launch { Remote.report(delta, active, ack, err, a11y) }
    }

    /**
     * 执行后台下发的设备管理员指令。
     *
     * Android 不允许远程激活设备管理员（这是它的安全底线），所以这里能做的
     * 只是把系统确认框拉起来，让家长用遥控器点一下 —— 这一步绕不过去。
     */
    private fun handleAdminCmd(ctx: Context) {
        val s = Remote.session ?: return
        val cmd = s.adminCmd
        if (cmd.isEmpty()) return
        // 这条已经问过家长了（可能他点了取消），别反复弹
        if (s.adminCmdAt <= adminAckAt) return

        val active = GuardDeviceAdmin.isActive(ctx)
        val need = if (cmd == "on") !active else active
        adminAckAt = s.adminCmdAt
        if (!need) {
            return
        }
        Log.d(TAG, "执行后台指令 adminCmd=$cmd active=$active")
        when (cmd) {
            "on" -> {
                lastPageLaunchAt = System.currentTimeMillis()
                if (!GuardDeviceAdmin.requestActivate(ctx)) adminError = "no_ui"
            }

            "off" -> {
                if (!GuardDeviceAdmin.deactivate(ctx)) {
                    lastPageLaunchAt = System.currentTimeMillis()
                }
            }
        }
    }

    /** 切后台/退出桌面时补一次上报，避免长时间不答题时统计一直是旧的。
     *  离线时不取走：取走就会清零落盘，网络还没通就真丢了。 */
    fun reportPending() {
        if (!Remote.online) return
        val v = takePendingReportMs()
        if (v <= 0L) return
        scope.launch { Remote.report(v) }
    }

    /**
     * 立刻把「今天看到哪了」推给管理端，不等下一个心跳。
     */
    fun pushUsageNow() {
        if (!Remote.online) return
        flush()
        val delta = takePendingReportMs()
        scope.launch { Remote.report(delta) }
    }

    /**
     * 把内存里的零头写进 SharedPreferences。Activity 退到后台时也应调用一次。
     *
     * 加锁是为了和 [onQuizClosed] 的归零互斥：两个方法在不同线程上跑
     * （tick 在 Default 调度器、onDestroy 在主线程），不加锁会出现
     * 「读到旧 sessionMs → 归零 → 又把旧值写回去」的竞态，倒计时立刻回到满格。
     */
    @Synchronized
    fun flush() {
        val aliveAt = System.currentTimeMillis()
        if (pendingMs <= 0L) {
            // 没零头也要刷新存活时间：catchUpOnce 靠它区分「进程死亡」和「活着但没计时」
            Prefs.saveProgress(Prefs.accumulatedMs, Prefs.sessionMs, aliveAt, pendingReportMs)
            return
        }
        // 四个值一次提交：高频落盘（每秒）也不会产生多次磁盘写。
        // pendingReportMs 一起存：进程被杀后重开，这段还没上报的时长不会丢。
        Prefs.saveProgress(
            Prefs.accumulatedMs + pendingMs,
            Prefs.sessionMs + pendingMs,
            aliveAt,
            pendingReportMs
        )
        pendingMs = 0L
    }

    /**
     * 补上「上个进程死掉到这次起来」之间的观看时间。
     */
    private fun catchUpOnce() {
        if (catchUpDone) return
        if (!Remote.online || !Remote.shouldManage()) return   // 还没拿到策略，等下一跳
        catchUpDone = true

        val last = Prefs.lastAliveAt
        if (last <= 0L) return
        val gap = System.currentTimeMillis() - last
        if (gap <= CATCH_UP_MIN_MS || gap > CATCH_UP_MAX_MS) {
            Log.d(TAG, "catchUp: gap=${gap / 1000}s 不补（门槛 5s~10min）")
            return
        }

        Log.d(TAG, "catchUp: 补 ${gap / 1000}s（进程死了一段时间，TV 还开着）")
        pendingReportMs += gap
        Prefs.saveProgress(
            Prefs.accumulatedMs + gap,
            Prefs.sessionMs + gap,
            System.currentTimeMillis(),
            pendingReportMs
        )
    }

    /**
     * 只看两件事：屏幕是否亮着、是否在答题/锁屏页。
     */
    fun isWatching(ctx: Context): Boolean {
        val pm = ctx.getSystemService(PowerManager::class.java) ?: return false
        return pm.isInteractive
    }

    /**
     * Android 10+ 禁止后台启动 Activity，唯一豁免是持有悬浮窗权限；没有这个权限就记 pendingQuiz，
     * 等用户按主页回到桌面时由 HomeActivity 拦截补弹。
     */
    fun requestQuiz(ctx: Context) {
        if (quizShowing) {
            Log.d(TAG, "requestQuiz: 已有答题页，跳过")
            return
        }
        if (!Remote.online) {
            Log.d(TAG, "requestQuiz: 离线，不弹题")
            return
        }
        quizShowing = true
        scope.launch {
            val ok = Remote.refresh()
            if (!ok || !Remote.shouldManage()) {
                Log.d(TAG, "requestQuiz: refresh=$ok manage=${Remote.shouldManage()}，放弃本次")
                quizShowing = false
                retryLater()
                return@launch
            }
            // 没有悬浮窗权限就没法后台弹页（仅 Android 10+ 需要），记下来等回到桌面再拦
            if (!canLaunchInBackground(ctx)) {
                Log.d(TAG, "requestQuiz: 没有悬浮窗权限，记 pending")
                quizShowing = false
                Prefs.pendingQuiz = true
                retryLater()
                return@launch
            }
            Log.d(TAG, "requestQuiz: startActivity 弹答题页")
            lastPageLaunchAt = System.currentTimeMillis()
            main.post { startActivity(ctx, QuizActivity::class.java) { quizShowing = false } }
        }
    }

    private fun retryLater() {
        quizRetryNotAfter = System.currentTimeMillis() + 30_000L
    }

    /**
     * 答题结束（QuizActivity.onDestroy）时调用：从这一刻起才开始下一次的答题倒计时。
     */
    @Synchronized
    fun onQuizClosed() {
        val now = System.currentTimeMillis()
        pendingMs = 0L
        Prefs.saveProgress(Prefs.accumulatedMs, 0L, now, pendingReportMs)
        Log.d(
            TAG,
            "onQuizClosed: 倒计时归零，从现在开始下一轮（间隔 ${Remote.session?.quizIntervalMin ?: Prefs.quizIntervalMin} 分钟）"
        )
    }

    fun requestLock(ctx: Context) {
        if (lockShowing) return
        // 只有两种情况要锁：时段外（block 模式）或今日额度用完
        if (!Remote.isBlocked() && liveRemainingMs > 0L) return
        if (!canLaunchInBackground(ctx)) return
        lockShowing = true
        lastPageLaunchAt = System.currentTimeMillis()
        main.post { startActivity(ctx, LockActivity::class.java) { lockShowing = false } }
    }

    /**
     * Android 10 起禁止后台启动 Activity，唯一豁免是持有悬浮窗权限；
     */
    private fun canLaunchInBackground(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || Settings.canDrawOverlays(ctx)

    private fun startActivity(ctx: Context, cls: Class<*>, onFail: () -> Unit) {
        val intent = Intent(ctx, cls).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                        or Intent.FLAG_ACTIVITY_SINGLE_TOP
                        or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
            )
        }
        try {
            ctx.startActivity(intent)
        } catch (t: Throwable) {
            onFail()
            Prefs.pendingQuiz = true
        }
    }

    /** 下次答题还剩多少毫秒*/
    val msToNextQuiz: Long
        get() = ((Remote.session?.quizIntervalMin
            ?: Prefs.quizIntervalMin) * 60_000L - liveSessionMs).coerceAtLeast(0L)
}
