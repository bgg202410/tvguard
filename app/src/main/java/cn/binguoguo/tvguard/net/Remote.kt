package cn.binguoguo.tvguard.net

import android.content.Context
import android.os.Build
import android.provider.Settings
import cn.binguoguo.tvguard.BuildConfig
import cn.binguoguo.tvguard.data.AppEntry
import cn.binguoguo.tvguard.data.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Calendar

data class Notice(
    val id: String,
    val text: String,
    val at: Long,
    val day: String = ""
)

/** 一次会话快照：策略 + 时段表 + 今日用量 + 组进度，全部由管理端决定 */
data class Session(
    val enabled: Boolean,
    val dailyLimitMin: Int,
    val quizIntervalMin: Int,
    val passBonusMin: Double,
    val difficulty: Int,
    val quizMode: String,
    val groupSize: Int,
    val groupPassRate: Int,
    val scheduleMode: String,
    val scheduleDays: List<String>,
    /** 答错怎么走：retry = 重答到对才放行（默认）/ pass = 答错也放行 */
    val wrongPolicy: String,
    /**
     * 桌面拦截开关。
     */
    val desktopGuardOn: Boolean,
    /** 启动项：打开守时桌面后直奔这个包；空 = 显示应用列表 */
    val launchPkg: String,
    val remainingMs: Long,
    val usedMs: Long,
    val groupAsked: Int,
    val groupCorrect: Int,
    /** 今日答题换来的时长（毫秒），已包含在下面的 totalMs 里 */
    val bonusMs: Long,
    /**
     * 有没有开「用完时间后答题换时长」。
     */
    val rewardEnabled: Boolean,
    /**
     * 时长奖励阶段：
     *   off       开关没开
     *   normal    开了但还没到"用完"（不提奖励）
     *   open      用完了，还能答题换时长
     *   exhausted 今天的奖励次数用光，禁用到明天
     */
    val rewardStage: String,
    val rewardNeed: Int,
    val rewardMin: Int,
    /** 今日已换次数 / 每天上限 / 还剩几次 */
    val rewardTimes: Int,
    val rewardMaxTimes: Int,
    val rewardTimesLeft: Int,
    /** 这一轮已经答对几题（满 need 换一次） */
    val rewardCorrect: Int,
    /**
     * 后台下发的设备管理员指令：
     *   on   —— 请打开设备管理员（保活用）
     *   off  —— 请关闭
     */
    val adminCmd: String = "",
    /** 指令下发时间 */
    val adminCmdAt: Long = 0L,
    /** 心跳间隔（秒）：服务端下发，电视端不另设配置，两端一套；默认 5 秒 */
    val heartbeatSec: Int = 5,
    /** 服务端认定的「今天」（yyyy-MM-dd） */
    val day: String = "",
    val notice: Notice? = null
)

/** 判题接口回来的奖励结算结果 */
data class RewardInfo(
    val stage: String,
    val need: Int,
    val rewardMin: Int,
    val times: Int,
    val maxTimes: Int,
    val timesLeft: Int,
    val correct: Int,
    val bonusMs: Long,
    val grantedMin: Int
)

/** 管理端下发的题目。type: choice 单选 / judge 判断 / multi 多选 */
data class Quiz(
    val id: String,
    val subject: String,
    val subjectName: String,
    val subjectColor: String,
    val grade: Int,
    val gradeName: String,
    val type: String,
    val stars: Int,
    val prompt: String,
    val options: List<String>,
    val hint: String
)

data class AnswerResult(
    val correct: Boolean,
    /** 这一轮能不能放行：单题模式=答对；整组模式=整组达标 */
    val pass: Boolean,
    val answer: String,
    val explanation: String,
    val rewardMinutes: Double,
    val groupAsked: Int,
    val groupSize: Int,
    val groupFinished: Boolean,
    val groupRate: Int,
    val reward: RewardInfo? = null
)

/**
 * 和管理端的唯一联系。
 */
object Remote {

    private const val SLOTS_PER_DAY = 48

    @Volatile
    var online: Boolean = false
        private set

    @Volatile
    var session: Session? = null
        private set

    /** 给首页/诊断页看的一句话状态 */
    @Volatile
    var statusText: String = "未连接"
        private set

    @Volatile
    var deviceId: String = ""

    private var base: String = ""
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 配错地址不会报错，只会静默放行 */
    fun start(ctx: Context) {
        Prefs.init(ctx)
        base = Prefs.serverUrl
        deviceId = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)
            ?: "unknown"
    }

    /**
     * 电视自己的局域网 IP
     */
    private fun localIp(): String {
        try {
            val nis = java.net.NetworkInterface.getNetworkInterfaces() ?: return ""
            var fallback = ""
            while (nis.hasMoreElements()) {
                val ni = nis.nextElement()
                if (!ni.isUp || ni.isLoopback) continue
                val addrs = ni.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr.isLoopbackAddress || addr !is java.net.Inet4Address) continue
                    val ip = addr.hostAddress ?: continue
                    val lan = ip.startsWith("192.168.") || ip.startsWith("10.") ||
                        (ip.startsWith("172.") && ip.split(".").getOrNull(1)?.toIntOrNull()
                            ?.let { it in 16..31 } == true)
                    if (!lan) continue
                    if (ni.name.startsWith("wlan") || ni.name.startsWith("eth")) return ip
                    if (fallback.isEmpty()) fallback = ip
                }
            }
            return fallback
        } catch (_: Exception) {
            return ""
        }
    }

    /** 开机时检查一次。之后只有弹题那一刻再检查，不做轮询。 */
    fun checkAtBoot() {
        scope.launch { refresh() }
    }

    /** 阻塞调用，必须在后台线程执行 */
    fun testServer(url: String): Pair<Boolean, String> {
        val u = url.trim().trimEnd('/')
        if (u.isBlank()) return false to "地址不能为空"
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            return false to "地址要以 http:// 开头"
        }
        val t0 = System.currentTimeMillis()
        val ok = Api.get(u, "/api/v1/ping") != null
        val ms = System.currentTimeMillis() - t0
        return ok to if (ok) "连通 · ${ms}ms" else "连不上 · 检查 IP、端口、是否同一局域网"
    }


    @Volatile
    private var lastSyncAt: Long = 0L

    fun refreshIfStale(minGapMs: Long) {
        val now = System.currentTimeMillis()
        if (session != null && now - lastSyncAt < minGapMs) return
        scope.launch { refresh() }
    }

    /**
     * 检查一次管理端
     */
    fun refresh(): Boolean {
        val cfg = Prefs.serverUrl
        if (cfg != base) base = cfg
        lastSyncAt = System.currentTimeMillis()

        if (base.isBlank()) {
            markOffline("未配置管理端地址")
            return false
        }

        val json = Api.get(
            base, "/api/v1/device/session",
            mapOf(
                "deviceId" to deviceId,
                "model" to Build.MODEL,
                "v" to APP_VERSION,
                // Docker 网桥下服务端看不到电视真实 IP，主动上报一次
                "localIp" to localIp()
            )
        )
        if (json == null) {
            markOffline("连不上管理端")
            return false
        }
        val s = parseSession(json)
        if (s == null) {
            markOffline("管理端返回格式不对")
            return false
        }
        session = s
        Prefs.dailyLimitMin = s.dailyLimitMin
        Prefs.quizIntervalMin = s.quizIntervalMin
        if (s.notice != null) Prefs.cacheNotice(s.notice.id, s.notice.text, s.notice.at, s.notice.day)
        else Prefs.clearNotice()
        applyServerDay(s)
        syncLocalUsage(s)
        online = true
        statusText = when {
            !s.enabled -> "已连接 · 管控已关闭"
            s.scheduleMode == "block" && !activeNow(s) -> "已连接 · 当前不在可用时段"
            s.scheduleMode == "quizOnly" && !activeNow(s) -> "已连接 · 自由时段"
            else -> "已连接"
        }
        if (s.scheduleMode != "off" && s.scheduleDays.size < 7) {
            statusText = "已连接 · 时段表未取到（暂按全天处理）"
        }
        return true
    }

    private fun markOffline(reason: String) {
        online = false
        session = null
        statusText = "未连接 · $reason"
    }

    /**
     * 跨天对齐：服务端换了日期 → 本地这份累计作废，今天从 0 开始。
     */
    private fun applyServerDay(s: Session) {
        val day = s.day.trim()
        if (day.isEmpty()) return
        val known = Prefs.serverDay
        if (known == day) return
        if (known.isNotEmpty()) {
            Prefs.forceRollover(day)
            onDayReset?.invoke()
        }
        Prefs.serverDay = day
    }

    @Volatile
    var onDayReset: (() -> Unit)? = null

    /**
     * 本地今日累计向服务端对齐。
     */
    private fun syncLocalUsage(s: Session) {
        val serverMs = s.usedMs
        if (serverMs < 0) return
        val local = Prefs.accumulatedMs

        if (local < serverMs - 5 * 60_000L) {
            Prefs.accumulatedMs = serverMs
            return
        }
        if (local > serverMs + 60_000L && serverMs < 60_000L && local > 2 * 60_000L) {
            Prefs.accumulatedMs = serverMs
        }
    }

    /** 只有在线、开关打开、且处在管控时段内，才计时和弹题 */
    fun shouldManage(): Boolean {
        if (!online) return false
        val s = session ?: return false
        if (!s.enabled) return false
        return activeNow(s)
    }

    val desktopGuardOn: Boolean
        get() = session?.desktopGuardOn == true

    fun isBlocked(): Boolean {
        if (!online) return false
        val s = session ?: return false
        return s.enabled && s.scheduleMode == "block" && !activeNow(s)
    }

    fun nextActiveAt(): Long {
        val s = session ?: return 0L
        if (s.scheduleMode == "off" || s.scheduleDays.size < 7) return 0L
        val cal = Calendar.getInstance()
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        if (cal.get(Calendar.MINUTE) >= 30) {
            cal.set(Calendar.MINUTE, 0)
            cal.add(Calendar.HOUR_OF_DAY, 1)
        } else {
            cal.set(Calendar.MINUTE, 30)
        }
        repeat(7 * SLOTS_PER_DAY) {
            if (activeNow(s, cal.timeInMillis)) return cal.timeInMillis
            cal.add(Calendar.MINUTE, 30)
        }
        return 0L
    }

    fun fetchQuiz(): Quiz? {
        if (!online) return null
        val params = buildMap {
            put("deviceId", deviceId)
            put("level", (session?.difficulty ?: 2).toString())
        }
        val json = Api.get(base, "/api/v1/quiz", params) ?: return failAndNull()
        return parseQuiz(json) ?: failAndNull()
    }

    fun submit(qid: String, choice: String, watchedDeltaMs: Long = 0L): AnswerResult? {
        if (!online) return null
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("qid", qid)
            .put("choice", choice)
            .put("watchedMsDelta", watchedDeltaMs.coerceAtLeast(0L))
            .put("watchedMsTotal", Prefs.accumulatedMs.coerceAtLeast(0L))
            .put("day", Prefs.serverDay.ifBlank { Prefs.localDayKey() })
        val json = Api.post(base, "/api/v1/quiz/answer", body) ?: return failAndNull()
        val g = json.optJSONObject("group")
        val correct = json.optBoolean("correct", false)
        return AnswerResult(
            correct = correct,
            pass = json.optBoolean("pass", correct),
            answer = answerOf(json.opt("answer")),
            explanation = json.optString("explanation", ""),
            rewardMinutes = json.optDouble("rewardMinutes", 0.0),
            groupAsked = g?.optInt("asked", 0) ?: 0,
            groupSize = g?.optInt("size", 0) ?: 0,
            groupFinished = g?.optBoolean("finished", false) ?: false,
            groupRate = g?.optInt("rate", 0) ?: 0,
            reward = parseReward(json.optJSONObject("reward"))
        )
    }

    private fun parseReward(o: JSONObject?): RewardInfo? {
        if (o == null) return null
        return RewardInfo(
            stage = o.optString("stage", "off"),
            need = o.optInt("need", 10),
            rewardMin = o.optInt("rewardMin", 10),
            times = o.optInt("times", 0),
            maxTimes = o.optInt("maxTimes", 0),
            timesLeft = o.optInt("timesLeft", 0),
            correct = o.optInt("correct", 0),
            bonusMs = o.optLong("bonusMs", 0L),
            grantedMin = o.optInt("grantedMin", 0)
        )
    }

    /**
     * 判题回来后把奖励进度写回本地会话。
     */
    fun applyReward(info: RewardInfo) {
        val s = session ?: return
        session = s.copy(
            bonusMs = info.bonusMs,
            rewardStage = info.stage,
            rewardTimes = info.times,
            rewardTimesLeft = info.timesLeft,
            rewardCorrect = info.correct
        )
    }

    /** 正确答案可能是字符串，也可能是数组（多选），统一成「A|B」 */
    private fun answerOf(v: Any?): String = when (v) {
        null -> ""
        is org.json.JSONArray -> (0 until v.length()).joinToString("|") { v.optString(it) }
        else -> v.toString()
    }

    /** 弹题中管理端掉了：立刻判定离线，这一轮直接放行 */
    private fun <T> failAndNull(): T? {
        markOffline("答题时连不上管理端")
        return null
    }

    /**
     * 家长验证：把输入的密码交给管理端核对。
     */
    fun verifyAdmin(password: String): Boolean? {
        if (base.isBlank()) return null
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("password", password)
        val json = Api.post(base, "/api/v1/device/unlock", body)
        if (json != null) return json.optBoolean("ok", false)
        return if (Api.get(base, "/api/v1/ping") != null) false else null
    }

    /**
     * 上报本轮新增观看时长
     */
    fun report(
        deltaMs: Long,
        adminActive: Boolean? = null,
        adminAckAt: Long = 0L,
        adminError: String = "",
        a11yOn: Boolean? = null
    ) {
        if (!online || base.isBlank()) return
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("watchedMsDelta", deltaMs.coerceAtLeast(0L))
            // 服务端校准用的「今日累计绝对值」：增量万一在路上丢了（进程被杀 / 请求没发完），
            // 管理端拿这个值取较大者补回来。刚点过「重置今日」时服务端会忽略它。
            .put("watchedMsTotal", Prefs.accumulatedMs.coerceAtLeast(0L))
            .put("day", Prefs.serverDay.ifBlank { Prefs.localDayKey() })
            .put("localIp", localIp())
        if (adminActive != null) body.put("adminActive", adminActive)
        if (adminAckAt > 0L) body.put("adminAckAt", adminAckAt)
        if (adminError.isNotEmpty()) body.put("adminError", adminError)
        if (a11yOn != null) body.put("a11yOn", a11yOn)
        Api.post(base, "/api/v1/report", body)
    }

    /**
     * 上报已装应用清单。
     */
    fun reportApps(apps: List<AppEntry>) {
        if (base.isBlank() || apps.isEmpty()) return
        val arr = JSONArray()
        apps.forEach { a ->
            arr.put(
                JSONObject()
                    .put("pkg", a.packageName)
                    .put("label", a.label)
                    .put("act", a.component?.className ?: "")
            )
        }
        Api.post(
            base, "/api/v1/device/apps",
            JSONObject().put("deviceId", deviceId).put("localIp", localIp()).put("apps", arr)
        )
    }

    private fun dayAndSlot(at: Long): Pair<Int, Int> {
        val cal = Calendar.getInstance().apply { timeInMillis = at }
        val day = (cal.get(Calendar.DAY_OF_WEEK) + 5) % 7   // 周一 = 0
        val slot = (cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)) / 30
        return day to slot
    }

    /**
     * 此刻是否在允许时段内。
     */
    private fun activeNow(s: Session, at: Long = System.currentTimeMillis()): Boolean {
        if (s.scheduleMode == "off") return true
        if (s.scheduleDays.size < 7) return true
        val (day, slot) = dayAndSlot(at)
        return s.scheduleDays[day].getOrNull(slot) == '1'
    }

    private fun parseSession(j: JSONObject): Session? {
        val p = j.optJSONObject("policy") ?: return null
        val sch = j.optJSONObject("schedule")
        val usage = j.optJSONObject("usage")
        val g = j.optJSONObject("group")
        val rw = j.optJSONObject("reward")
        val days = mutableListOf<String>()
        fun collectDays(arr: JSONArray?) {
            if (arr == null) return
            for (i in 0 until arr.length()) days.add(arr.optString(i))
        }
        collectDays(sch?.optJSONArray("days"))
        if (days.isEmpty()) collectDays(p.optJSONObject("schedule")?.optJSONArray("days"))
        return Session(
            enabled = p.optBoolean("enabled", true),
            dailyLimitMin = p.optInt("dailyLimitMin", 120),
            quizIntervalMin = p.optInt("quizIntervalMin", 10),
            passBonusMin = p.optDouble("passBonusMin", 10.0),
            difficulty = p.optInt("difficulty", 2),
            quizMode = p.optString("quizMode", "single"),
            groupSize = p.optInt("groupSize", 5),
            groupPassRate = p.optInt("groupPassRate", 60),
            scheduleMode = sch?.optString("mode", "off") ?: "off",
            scheduleDays = days,
            wrongPolicy = p.optString("wrongPolicy", "retry"),
            desktopGuardOn = p.optBoolean("desktopGuard", true),
            launchPkg = j.optJSONObject("launch")?.optString("pkg", "") ?: "",
            remainingMs = usage?.optLong("remainingMs", 0L) ?: 0L,
            usedMs = (usage?.optLong("watchedMs", 0L)) ?: 0L,
            groupAsked = g?.optInt("asked", 0) ?: 0,
            groupCorrect = g?.optInt("correct", 0) ?: 0,
            bonusMs = rw?.optLong("bonusMs", 0L) ?: 0L,
            rewardEnabled = rw?.optBoolean("enabled", false) ?: false,
            rewardStage = rw?.optString("stage", "off") ?: "off",
            rewardNeed = rw?.optInt("need", 10) ?: 10,
            rewardMin = rw?.optInt("rewardMin", 10) ?: 10,
            rewardTimes = rw?.optInt("times", 0) ?: 0,
            rewardMaxTimes = rw?.optInt("maxTimes", 0) ?: 0,
            rewardTimesLeft = rw?.optInt("timesLeft", 0) ?: 0,
            rewardCorrect = rw?.optInt("correct", 0) ?: 0,
            adminCmd = j.optJSONObject("admin")?.optString("cmd", "") ?: "",
            adminCmdAt = j.optJSONObject("admin")?.optLong("at", 0L) ?: 0L,
            heartbeatSec = j.optInt("heartbeatSec", 5),
            day = j.optString("day", ""),
            notice = j.optJSONObject("notice")?.let { n ->
                val id = n.optString("id", "")
                val text = n.optString("text", "")
                // 没 id 或没正文就当没有：空卡片比不显示更让人困惑
                if (id.isBlank() || text.isBlank()) null
                else Notice(
                    id = id,
                    text = text,
                    at = n.optLong("at", 0L),
                    day = n.optString("day", "")
                )
            }
        )
    }

    private fun parseQuiz(j: JSONObject): Quiz? {
        val id = j.optString("id", "")
        if (id.isBlank()) return null
        val options = mutableListOf<String>()
        j.optJSONArray("options")?.let { arr ->
            for (i in 0 until arr.length()) options.add(arr.optString(i))
        }
        return Quiz(
            id = id,
            subject = j.optString("subject", "math"),
            subjectName = j.optString("subjectName", "数学"),
            subjectColor = j.optString("subjectColor", ""),
            grade = j.optInt("grade", 0),
            gradeName = j.optString("gradeName", ""),
            type = j.optString("type", "choice"),
            stars = j.optInt("stars", 1),
            prompt = j.optString("prompt", ""),
            options = options,
            hint = j.optString("hint", "")
        )
    }

    /**
     * 问管理端有没有新版本。
     */
    fun checkUpdate(): UpdateInfo? {
        val cfg = Prefs.serverUrl
        if (cfg.isBlank()) return null
        val j = Api.get(
            cfg, "/api/v1/device/apk",
            mapOf(
                "vc" to VERSION_CODE.toString(),
                "pkg" to BuildConfig.APPLICATION_ID
            )
        ) ?: return null
        if (!j.optBoolean("update", false)) return null
        val info = UpdateInfo(
            versionCode = j.optInt("versionCode", 0),
            versionName = j.optString("versionName", ""),
            size = j.optLong("size", 0L),
            md5 = j.optString("md5", ""),
            url = j.optString("url", "/apk/latest.apk")
        )
        pendingUpdate = info
        return info
    }

    @Volatile
    var pendingUpdate: UpdateInfo? = null

    fun downloadApk(dest: File, expectMd5: String, onProgress: (Int) -> Unit): Boolean {
        val cfg = Prefs.serverUrl
        if (cfg.isBlank()) return false
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(cfg.trimEnd('/') + "/apk/latest.apk").openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 20000
                useCaches = false
            }
            if (conn.responseCode !in 200..299) return false
            val total = conn.contentLengthLong
            val md5 = MessageDigest.getInstance("MD5")
            dest.parentFile?.mkdirs()
            var read = 0L
            conn.inputStream.use { input ->
                dest.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        md5.update(buf, 0, n)
                        read += n
                        if (total > 0) onProgress(((read * 100) / total).toInt().coerceIn(0, 100))
                    }
                }
            }
            onProgress(100)
            val got = md5.digest().joinToString("") { "%02x".format(it) }
            expectMd5.isBlank() || got.equals(expectMd5, ignoreCase = true)
        } catch (t: Throwable) {
            false
        } finally {
            try { conn?.disconnect() } catch (t: Throwable) { /* ignore */ }
        }
    }

    val APP_VERSION: String = BuildConfig.VERSION_NAME
    val VERSION_CODE: Int = BuildConfig.VERSION_CODE
}

data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val size: Long,
    val md5: String,
    val url: String
)
