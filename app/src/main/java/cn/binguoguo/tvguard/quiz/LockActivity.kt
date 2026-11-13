package cn.binguoguo.tvguard.quiz

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import cn.binguoguo.tvguard.databinding.ActivityLockBinding
import cn.binguoguo.tvguard.guard.MediaPause
import cn.binguoguo.tvguard.guard.WatchTracker
import cn.binguoguo.tvguard.net.Remote
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import cn.binguoguo.tvguard.R

/**
 * 锁定 / 禁用页。三种情形共用一套界面：
 *
 *   1. **时段外**（管理端把时段用途设成「时段外禁用电视」）→ 显示下次可用时间；
 *   2. **今日时长用完，还能答题换时间** → 显示「答题换时长」按钮，
 *      孩子按 OK 进答题页，答对 N 题换一次（每天次数由管理端配）；
 *   3. **时长用完且今天次数也换满了** → 纯禁用，只能等明天 0 点。
 *
 * 除了那个按钮，页面上没有任何可操作的东西：返回键无效，不能跳过。
 * 每 5 秒本地判断一次能不能走；每 10 秒才问一次管理端（家长可能临时调大时长，
 * 但锁屏时不该每 5 秒发一次请求）。
 */
class LockActivity : AppCompatActivity() {

    private lateinit var b: ActivityLockBinding
    private val handler = Handler(Looper.getMainLooper())
    private var ticks = 0

    /** 已经点了「答题换时长」，避免连按 OK 叠开两个答题页 */
    private var quizOpened = false

    /** 这一页已经决定关掉（时长恢复 / 管控关闭），别在 onStop 里又拉回来 */
    private var leaving = false

    private val ticker = object : Runnable {
        override fun run() {
            if (canLeave()) {
                closeLock()
                return
            }
            // 每 2 跳（10 秒）刷一次策略，其余时间纯本地判断
            ticks += 1
            if (ticks % 2 == 0) Remote.checkAtBoot()
            render()
            handler.postDelayed(this, 5_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityLockBinding.inflate(layoutInflater)
        setContentView(b.root)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        MediaPause.hold(this)

        b.btnQuiz.setOnClickListener { openRewardQuiz() }

        render()
        handler.postDelayed(ticker, 5_000L)
    }

    override fun onResume() {
        super.onResume()
        WatchTracker.lockShowing = true
        WatchTracker.lockLeftAt = 0L
        quizOpened = false
        if (canLeave()) {
            closeLock()
            return
        }
        // 从答题页回来：进度可能变了，立刻重画一次，不等下一个 5 秒
        render()
    }

    /**
     * 被切走时记时间，由 WatchTracker 的兜底拉回来。
     * 去答题页（quizOpened）属于正常离开，不能记 —— 否则锁屏页会把答题页盖掉。
     */
    override fun onPause() {
        super.onPause()
        if (leaving || isFinishing || quizOpened) return
        WatchTracker.lockLeftAt = System.currentTimeMillis()
    }

    override fun onDestroy() {
        handler.removeCallbacks(ticker)
        WatchTracker.lockShowing = false
        MediaPause.release()
        super.onDestroy()
    }

    @Deprecated("锁定页不允许返回")
    override fun onBackPressed() {
        // 故意不处理
    }

    /** 按主页也走不掉：系统先回调这里，立刻把锁定页拉回最前 */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        bringBack()
    }

    /** 被切到后台（按主页、切应用）且还能锁着 → 拉回来 */
    override fun onStop() {
        super.onStop()
        if (leaving || isFinishing || quizOpened) return
        bringBack()
    }

    private fun bringBack() {
        if (leaving || isFinishing) return
        if (!Remote.online) return          // 连不上管理端按规则放行，别把孩子锁死
        if (canLeave()) return
        runCatching {
            startActivity(
                Intent(this, LockActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                )
            )
        }
    }

    /** 统一出口：置上 leaving 再关，onStop 就不会把自己拉回来 */
    private fun closeLock() {
        leaving = true
        finish()
    }

    /** 什么时候可以解除锁定 */
    private fun canLeave(): Boolean {
        if (!Remote.online) return true           // 连不上管理端 = 不管
        if (Remote.isBlocked()) return false      // 时段外：锁着
        if (!Remote.shouldManage()) return true   // 管控关闭 / 自由时段：放行
        return WatchTracker.liveRemainingMs > 0L  // 时段内：时长还有（含换来的）就放行
    }

    /** 进答题页换时长。答完由 QuizActivity 自己关闭，回到这里再判断能不能走。 */
    private fun openRewardQuiz() {
        if (quizOpened) return
        // 服务端说 open 或者本地条件已齐（服务端账目可能还差几秒没入账）
        if (Remote.session?.rewardStage != "open" && !rewardOpenNow()) return
        quizOpened = true
        b.btnQuiz.visibility = View.GONE
        // 进答题页之前把今天的账推过去。服务端是拿自己账上的时长判 open 的，
        // 不先对齐的话，孩子答对的第一题会被判成「还没到点」，不计数。
        WatchTracker.pushUsageNow()
        startActivity(
            Intent(this, QuizActivity::class.java)
                .putExtra(QuizActivity.EXTRA_MODE, QuizActivity.MODE_REWARD)
        )
    }

    /**
     * 本地也能判断「现在就该给答题换时长的按钮」。
     *
     * 只看服务端的 `stage` 会慢一拍：它要等自己账上的今日时长到线才肯变 open，
     * 而电视本地是秒级到线的。刚锁屏那十几秒里服务端还是 `normal`，
     * 按钮就不出现，孩子看到的是「今天已看 X 分钟，明天 0 点自动重置」——
     * 实际上明明还能答题换时间。
     *
     * 三个条件都在本地就有：开关开着、今天还有次数、本地额度已经耗尽。
     * 只排除服务端明确说「次数用光」（exhausted）的情况。
     */
    private fun rewardOpenNow(): Boolean {
        val s = Remote.session ?: return false
        if (!s.rewardEnabled) return false
        if (s.rewardStage == "exhausted") return false
        if (s.rewardTimesLeft <= 0) return false
        return WatchTracker.liveRemainingMs <= 0L
    }

    private fun render() {
        val s = Remote.session

        // ① 时段外：不看时长，只看时段
        if (Remote.isBlocked()) {
            b.tvTitle.text = getString(R.string.lock_title)
            val at = Remote.nextActiveAt()
            b.tvNext.text = if (at <= 0L) {
                "稍后会自动恢复"
            } else {
                val f = SimpleDateFormat("M月d日 HH:mm", Locale.getDefault())
                "下次可用：${f.format(Date(at))}"
            }
            b.btnQuiz.visibility = View.GONE
            b.tvFoot.text = ""
            return
        }

        val baseMin = s?.dailyLimitMin ?: 120
        val bonusMin = ((s?.bonusMs ?: 0L) / 60_000L).toInt()
        val totalMin = baseMin + bonusMin
        val usedMin = WatchTracker.liveAccumulatedMs / 60_000L
        val stage = s?.rewardStage ?: "off"
        val timesLeft = s?.rewardTimesLeft ?: 0
        val need = s?.rewardNeed ?: 10
        val perMin = s?.rewardMin ?: 10
        val correct = s?.rewardCorrect ?: 0
        val times = s?.rewardTimes ?: 0

        when {
            // ② 时长和次数都耗尽了 → 禁用页。
            //    放在 open 前面：服务端明确说了次数用光时，别再拿本地推算把按钮放出来
            stage == "exhausted" -> {
                b.tvTitle.text = "今天看不了啦"
                b.tvNext.text = "今天的 ${totalMin} 分钟已经看完了\n" +
                    "答题换时长的 $times 次机会也用完了"
                b.btnQuiz.visibility = View.GONE
                b.tvFoot.text = "明天 0 点自动恢复"
            }
            // ③ 用完了，但今天还有换时长的次数 → 给按钮。
            //    不能只认服务端的 stage：它要等自己账上的时长到线才肯变 open，
            //    而电视本地是秒级到线的，只认它就会「刚锁屏时不给孩子按钮」。
            stage == "open" || rewardOpenNow() -> {
                b.tvTitle.text = "今天的 ${baseMin} 分钟用完了"
                b.tvNext.text = if (bonusMin > 0) {
                    "已经换过 $times 次（+$bonusMin 分钟）也看完了\n" +
                        "再答对 $need 题，可以换 $perMin 分钟"
                } else {
                    "答对 $need 题，可以再换 $perMin 分钟"
                }
                b.btnQuiz.visibility = View.VISIBLE
                b.btnQuiz.text = if (correct > 0) "继续答题（$correct/$need）" else "答题换时长"
                b.btnQuiz.requestFocus()
                b.tvFoot.text = "今天还能换 $timesLeft 次"
            }
            // ④ 没开奖励、或者刚好卡在边界 → 普通额度用完
            else -> {
                b.tvTitle.text = "今天的 $totalMin 分钟用完了"
                b.tvNext.text = "今天已看 $usedMin 分钟\n明天 0 点自动重置"
                b.btnQuiz.visibility = View.GONE
                b.tvFoot.text = ""
            }
        }
    }
}
