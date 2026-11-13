package cn.binguoguo.tvguard.data

import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import cn.binguoguo.tvguard.BuildConfig

/**
 * 全局配置与观看状态。
 * 用 SharedPreferences 保存数据
 */
object Prefs {

    private const val NAME = "tvguard_prefs"

    private const val K_DATE = "date"
    private const val K_SERVER_DAY = "server_day"
    private const val K_ACC = "acc_ms"
    private const val K_SESSION = "session_ms"
    private const val K_BONUS = "bonus_ms"
    private const val K_QUIZ_TODAY = "quiz_today"
    private const val K_LIMIT_MIN = "limit_min"
    private const val K_INTERVAL_MIN = "interval_min"
    private const val K_BONUS_MIN = "bonus_min"
    private const val K_COOLDOWN_SEC = "cooldown_sec"
    private const val K_DIFFICULTY = "difficulty"
    private const val K_PIN = "pin_hash"
    private const val K_UNLOCK_UNTIL = "unlock_until"
    private const val K_PENDING_QUIZ = "pending_quiz"
    private const val K_SERVER = "server_url"
    private const val K_LAST_ALIVE = "last_alive_at"
    private const val K_PENDING_REPORT = "pending_report_ms"
    private const val K_RECENT = "recent_apps"
    private const val RECENT_MAX = 8
    private const val K_NOTICE_ID = "notice_id"
    private const val K_NOTICE_TEXT = "notice_text"
    private const val K_NOTICE_AT = "notice_at"
    private const val K_NOTICE_DAY = "notice_day"
    private const val K_NOTICE_SEEN = "notice_seen_id"

    @Volatile
    private var sp: SharedPreferences? = null

    fun init(ctx: Context) {
        sp = ctx.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)
        rolloverIfNeeded()
    }

    private fun p(): SharedPreferences =
        sp ?: throw IllegalStateException("Prefs 未初始化")

    private fun todayKey(): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())

    fun localDayKey(): String = if (sp == null) "" else todayKey()

    fun checkRollover() = rolloverIfNeeded()

    /**
     * 强制按「服务端认定的今天」清零。
     */
    fun forceRollover(day: String) {
        p().edit()
            .putString(K_DATE, day)
            .putLong(K_ACC, 0L)
            .putLong(K_SESSION, 0L)
            .putLong(K_BONUS, 0L)
            .putInt(K_QUIZ_TODAY, 0)
            .putLong(K_PENDING_REPORT, 0L)
            .apply()
    }

    private fun rolloverIfNeeded() {
        val today = todayKey()
        if (p().getString(K_DATE, "") != today) forceRollover(today)
    }

    /** 服务端认定的「今天」，跨天对齐用；空串 = 还没和服务端同步过 */
    var serverDay: String
        get() = p().getString(K_SERVER_DAY, "") ?: ""
        set(v) = p().edit().putString(K_SERVER_DAY, v).apply()

    //今日累计时长
    var accumulatedMs: Long
        get() {
            rolloverIfNeeded()
            return p().getLong(K_ACC, 0L)
        }
        set(v) = p().edit().putLong(K_ACC, v).apply()

    var serverUrl: String
        get() = p().getString(K_SERVER, BuildConfig.SERVER_URL) ?: ""
        set(v) = p().edit().putString(K_SERVER, v.trim()).apply()

    val isServerUrlCustom: Boolean get() = p().contains(K_SERVER)

    fun clearServerUrl() {
        p().edit().remove(K_SERVER).apply()
    }

    var sessionMs: Long
        get() = p().getLong(K_SESSION, 0L)
        set(v) = p().edit().putLong(K_SESSION, v).apply()


    // 数据保存
    fun saveProgress(accMs: Long, sessionMs: Long, aliveAt: Long, pendingReportMs: Long = 0L) {
        p().edit()
            .putLong(K_ACC, accMs)
            .putLong(K_SESSION, sessionMs)
            .putLong(K_LAST_ALIVE, aliveAt)
            .putLong(K_PENDING_REPORT, pendingReportMs)
            .apply()
    }

    /** 已累计但还没上报的观看时长（毫秒）：进程重启后接着上报，不丢账 */
    var pendingReportMs: Long
        get() = p().getLong(K_PENDING_REPORT, 0L)
        set(v) = p().edit().putLong(K_PENDING_REPORT, v).apply()

    /**
     * 答题奖励的额外时长。
     */
    var bonusMs: Long
        get() = p().getLong(K_BONUS, 0L)
        set(v) = p().edit().putLong(K_BONUS, v).apply()

    var quizCountToday: Int
        get() = p().getInt(K_QUIZ_TODAY, 0)
        set(v) = p().edit().putInt(K_QUIZ_TODAY, v).apply()

    var dailyLimitMin: Int
        get() = p().getInt(K_LIMIT_MIN, 120)
        set(v) = p().edit().putInt(K_LIMIT_MIN, v).apply()

    var quizIntervalMin: Int
        get() = p().getInt(K_INTERVAL_MIN, 10)
        set(v) = p().edit().putInt(K_INTERVAL_MIN, v).apply()

    var passBonusMin: Int
        get() = p().getInt(K_BONUS_MIN, 10)
        set(v) = p().edit().putInt(K_BONUS_MIN, v).apply()

    var cooldownSec: Int
        get() = p().getInt(K_COOLDOWN_SEC, 60)
        set(v) = p().edit().putInt(K_COOLDOWN_SEC, v).apply()

    /** 1 简单 / 2 中等 / 3 挑战 */
    var difficulty: Int
        get() = p().getInt(K_DIFFICULTY, 2)
        set(v) = p().edit().putInt(K_DIFFICULTY, v.coerceIn(1, 3)).apply()

    /** 今日总时长：只有每日额度，不含任何答题加成 */
    val limitTotalMs: Long
        get() = dailyLimitMin * 60_000L

    val remainingMs: Long
        get() = (limitTotalMs - accumulatedMs).coerceAtLeast(0L)

    fun hasPin(): Boolean = p().contains(K_PIN)

    fun setPin(pin: String) {
        p().edit().putString(K_PIN, sha256("tvguard.v1|$pin")).apply()
    }

    fun verifyPin(pin: String): Boolean {
        val stored = p().getString(K_PIN, null) ?: return false
        return stored == sha256("tvguard.v1|$pin")
    }

    var pendingQuiz: Boolean
        get() = p().getBoolean(K_PENDING_QUIZ, false)
        set(v) = p().edit().putBoolean(K_PENDING_QUIZ, v).apply()

    /**
     * 计时最后还活着的时间戳。
     */
    var lastAliveAt: Long
        get() = p().getLong(K_LAST_ALIVE, 0L)
        set(v) = p().edit().putLong(K_LAST_ALIVE, v).apply()

    private const val K_KILLERS_HIDDEN = "killers_hidden"

    var killersHidden: Boolean
        get() = p().getBoolean(K_KILLERS_HIDDEN, false)
        set(v) = p().edit().putBoolean(K_KILLERS_HIDDEN, v).apply()

    /**
     * 记一次应用使用，最新的排最前。
     */
    fun touchRecent(pkg: String) {
        if (pkg.isBlank()) return
        val now = System.currentTimeMillis()
        val keep = parseRecent().filter { it.first != pkg }
        val merged = (listOf(pkg to now) + keep).take(RECENT_MAX)
        recentRaw = merged.joinToString(";") { "${it.first}|${it.second}" }
    }

    /** 从「最近使用」里剔掉某个应用：跳转失败时用，避免孩子反复点到打不开的项 */
    fun removeRecent(pkg: String) {
        if (pkg.isBlank()) return
        val keep = parseRecent().filter { it.first != pkg }
        recentRaw = keep.joinToString(";") { "${it.first}|${it.second}" }
    }


    fun recentPackages(limit: Int = 5): List<String> =
        parseRecent().map { it.first }.take(limit)

    private var recentRaw: String
        get() = p().getString(K_RECENT, "") ?: ""
        set(v) = p().edit().putString(K_RECENT, v).apply()

    private fun parseRecent(): List<Pair<String, Long>> =
        recentRaw.split(';').mapNotNull { part ->
            val i = part.lastIndexOf('|')
            if (i <= 0) return@mapNotNull null
            val pkg = part.substring(0, i)
            if (pkg.isBlank()) null else pkg to (part.substring(i + 1).toLongOrNull() ?: 0L)
        }

    val noticeId: String
        get() = p().getString(K_NOTICE_ID, "") ?: ""

    val noticeText: String
        get() = p().getString(K_NOTICE_TEXT, "") ?: ""

    val noticeAt: Long
        get() = p().getLong(K_NOTICE_AT, 0L)

    val noticeDay: String
        get() = p().getString(K_NOTICE_DAY, "") ?: ""

    fun cacheNotice(id: String, text: String, at: Long, day: String = "") {
        p().edit()
            .putString(K_NOTICE_ID, id)
            .putString(K_NOTICE_TEXT, text)
            .putLong(K_NOTICE_AT, at)
            .putString(K_NOTICE_DAY, day)
            .apply()
    }

    /** 管理端清空了留言：连内容一起清掉，桌面那张卡随即消失 */
    fun clearNotice() {
        p().edit()
            .putString(K_NOTICE_ID, "")
            .putString(K_NOTICE_TEXT, "")
            .putLong(K_NOTICE_AT, 0L)
            .putString(K_NOTICE_DAY, "")
            .apply()
    }

    var noticeSeenId: String
        get() = p().getString(K_NOTICE_SEEN, "") ?: ""
        set(v) = p().edit().putString(K_NOTICE_SEEN, v).apply()

    fun unlockFor(minutes: Int) {
        p().edit()
            .putLong(K_UNLOCK_UNTIL, System.currentTimeMillis() + minutes * 60_000L)
            .apply()
    }

    fun lockNow() {
        p().edit().putLong(K_UNLOCK_UNTIL, 0L).apply()
    }

    fun isUnlocked(): Boolean = p().getLong(K_UNLOCK_UNTIL, 0L) > System.currentTimeMillis()

    fun resetToday() {
        p().edit()
            .putLong(K_ACC, 0L)
            .putLong(K_SESSION, 0L)
            .putLong(K_BONUS, 0L)
            .putInt(K_QUIZ_TODAY, 0)
            .putLong(K_PENDING_REPORT, 0L)
            .apply()
    }

    private fun sha256(s: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        return md.digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
