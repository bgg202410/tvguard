package cn.binguoguo.tvguard.quiz

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.roundToInt
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import cn.binguoguo.tvguard.R
import cn.binguoguo.tvguard.data.Prefs
import cn.binguoguo.tvguard.databinding.ActivityQuizBinding
import cn.binguoguo.tvguard.guard.MediaPause
import cn.binguoguo.tvguard.guard.UiState
import cn.binguoguo.tvguard.guard.WatchTracker
import cn.binguoguo.tvguard.net.AnswerResult
import cn.binguoguo.tvguard.net.Quiz
import cn.binguoguo.tvguard.net.Remote
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 答题拦截页。全屏、保持常亮、屏蔽返回键。
 *
 * 题目、选项、正确答案、解析全部来自管理端 —— 这一页自己不判断对错，
 * 只负责把选择送上去、把结果念给孩子听。
 *
 * 交互规则（2026-11 产品定）：
 *   - 一题只能提交一次。提交后选项立刻锁死（不再响应点击/遥控器选中），
 *     正确项标绿 ✓、选错的标红 ✗，让人一眼知道答案，但改不了；
 *   - 结果只停留 3 秒，然后**自己走**：能放行就回电视，没放行就换下一道题。
 *     不再有「再来一题 / 继续看电视」按钮 —— 遥控器上少按一次就少一次吵架；
 *   - 答对**不加时长**：每天能看多久只看管理端的「每日额度」，答题只决定能不能接着看；
 *   - 进页面时抢音频焦点让节目暂停，离开时释放，节目自己接着播（见 MediaPause）。
 *
 * 取题或提交失败（说明管理端已经连不上）时直接关页放行：产品规则是"连不上就不管"。
 */
class QuizActivity : AppCompatActivity() {

    companion object {
        /** 打开原因：不传 = 到点弹题（答对放行）；传 reward = 时长用完了来换时长 */
        const val EXTRA_MODE = "mode"
        const val MODE_REWARD = "reward"

        /** 连续几次取不到题才算「管理端真的不可达」，之前一直重试 */
        private const val MAX_NET_FAILS = 3

        /**
         * 自动适配阈值：中文按全角、英文数字按半角折算。
         * 38sp 的居中题干在 520dp 宽里一行约 13 个汉字、两行约 32 个，
         * 超过就切「左题干 / 右选项 + 解析」，免得被 ellipsize 截断。
         */
        private const val LONG_STEM_UNITS = 64
        private const val LONG_OPTION_CHARS = 20
        private const val OPTION_BOX_SHORT_DP = 520
        /** 长题居中版式的选项宽度：比短题略宽一点，但同样居中，不再铺满整屏 */
        private const val OPTION_BOX_LONG_DP = 560
        /** 长题一行字少一档、选项矮一档，保证整组还在屏幕正中不被挤出去 */
        private const val OPTION_SHORT_DP = 60
        private const val OPTION_LONG_DP = 44
    }

    private lateinit var b: ActivityQuizBinding
    private val handler = Handler(Looper.getMainLooper())

    /** true = 从禁用页点「答题换时长」进来的，答满 N 题才发奖励，不是答对就走 */
    private var rewardMode = false

    private var current: Quiz? = null
    private var answered = false
    private var busy = false

    /**
     * 这一轮已经答完、允许关页。
     *
     * 关页只能走 [closeQuiz]；只要这个标志还是 false，被切到后台（按主页、切应用）
     * 就立刻把答题页拉回来 —— 否则孩子按一下主页就能跳过答题去看电视。
     */
    private var passed = false

    /** 连续取题失败次数：一次网络抖动不该直接放行 */
    private var netFails = 0

    /** 当前题已勾选的选项下标（单选只有一个，多选可能是多个） */
    private val picked = LinkedHashSet<Int>()

    private val options: List<TextView>
        get() = listOf(b.opt0, b.opt1, b.opt2, b.opt3)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityQuizBinding.inflate(layoutInflater)
        setContentView(b.root)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }

        // 让电视上正在放的节目先暂停 —— 答题这几分钟不该继续消耗"注意力"
        MediaPause.hold(this)

        rewardMode = intent.getStringExtra(EXTRA_MODE) == MODE_REWARD
        // 换时长这条路上没有经过 WatchTracker.requestQuiz，答题间隔要自己归零，
        // 否则换到 10 分钟后一开播就立刻又被弹一次题
        if (rewardMode) Prefs.sessionMs = 0L
        Prefs.pendingQuiz = false
        options.forEachIndexed { i, v -> v.setOnClickListener { onOption(i) } }
        b.btnConfirm.setOnClickListener { submitSelected() }

        loadQuestion()
    }

    override fun onResume() {
        super.onResume()
        WatchTracker.quizShowing = true
        // 页面本体的真实状态：右上角保活角标靠它隐藏（服务态 quizShowing
        // 可能被卡死自愈提前置回 false，不能只信它）
        UiState.quizPageShowing = true
        // 回到前台就清掉「离开」标记，兜底逻辑才不会再拉一次
        WatchTracker.quizLeftAt = 0L
        android.util.Log.d("TvGuard", "QuizActivity onResume")
    }

    /**
     * 记下「被切走了」的时刻。
     *
     * 页面自己拉回自己在这台 TCL 上不生效（stopped 的 Activity 再 start 自己会被系统忽略），
     * 所以真正动手的是 [WatchTracker] 的兜底，这里只负责报时间。
     */
    override fun onPause() {
        super.onPause()
        if (!passed && !isFinishing) WatchTracker.quizLeftAt = System.currentTimeMillis()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        WatchTracker.quizShowing = false
        UiState.quizPageShowing = false
        // 答题结束才开始下一次答题倒计时（弹题时不清零，见 WatchTracker.tick ⑤）
        WatchTracker.onQuizClosed()
        MediaPause.release()
        super.onDestroy()
    }

    @Deprecated("答题未完成不允许退出")
    override fun onBackPressed() {
        // 故意不处理
    }

    /**
     * 遥控器主页键：普通应用拦不住 HOME，但系统会先回调这里。
     * 这时立刻把自己重新拉回前台，效果就是「按主页没反应」。
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        bringBack()
    }

    /** 被切到后台（按主页、切到别的应用）且还没答完 → 拉回答题页 */
    override fun onStop() {
        super.onStop()
        if (!passed && !isFinishing) bringBack()
    }

    /**
     * 把答题页拉回最前。
     *
     * 连不上管理端时不做这件事：按产品规则「连不上就不管」，
     * 网络断了还把孩子锁在答题页，比放行更糟。
     */
    private fun bringBack() {
        if (passed || isFinishing) return
        if (!Remote.online) return
        runCatching {
            startActivity(
                Intent(this, QuizActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                )
            )
        }
    }

    /** 唯一允许关页的出口：先把 passed 置上，onStop 才不会又把页面拉回来 */
    private fun closeQuiz() {
        passed = true
        finish()
    }

    private fun loadQuestion() {
        handler.removeCallbacksAndMessages(null)
        resetUi()
        busy = true
        b.tvStem.text = "…"
        b.tvStemLong.text = "…"
        lifecycleScope.launch {
            val q = withContext(Dispatchers.IO) { Remote.fetchQuiz() }
            busy = false
            if (q == null) {
                onFetchFailed()
                return@launch
            }
            netFails = 0
            current = q
            render(q)
        }
    }

    /**
     * 取题失败：先重试，别一次网络抖动就把孩子放走。
     *
     * 连续 3 次（约 10 秒）都拿不到题，才认定管理端真的不可达，按「连不上就不管」放行。
     * 这一步很关键：以前一次失败就关页，家长看到的就是「明明该答题，界面却没了」。
     */
    private fun onFetchFailed() {
        b.tvFeedback.visibility = View.VISIBLE
        netFails += 1
        if (netFails >= MAX_NET_FAILS) {
            b.tvFeedback.text = getString(R.string.quiz_offline)
            handler.postDelayed({ closeQuiz() }, 1_200L)
            return
        }
        b.tvFeedback.setTextColor(ContextCompat.getColor(this, R.color.ink2))
        b.tvFeedback.text = getString(R.string.quiz_retry, netFails)
        b.tvStem.text = "…"
        b.tvStemLong.text = "…"
        handler.postDelayed({ loadQuestion() }, 3_000L)
    }

    private fun render(q: Quiz) {
        val typeName = when (q.type) {
            "judge" -> "判断"
            "multi" -> "多选（可以选多个）"
            else -> "单选"
        }
        val stars = "★".repeat(q.stars.coerceIn(1, 5))
        val sess = Remote.session
        val extra = when {
            // 换时长模式：进度是"累计答对几题"，不是"本组第几题"
            rewardMode -> {
                val c = sess?.rewardCorrect ?: 0
                val n = sess?.rewardNeed ?: 10
                " · 换时长 已答对 $c/$n"
            }
            sess?.quizMode == "group" -> " · 本组 ${sess.groupAsked + 1}/${sess.groupSize}"
            else -> ""
        }
        val gradePrefix = if (q.grade in 1..6 && q.gradeName.isNotBlank()) "${q.gradeName} · " else ""
        b.tvMeta.text = "$gradePrefix${q.subjectName} · $typeName · $stars$extra"

        b.tvHint.text = q.hint
        b.tvHint.visibility = if (q.hint.isBlank()) View.GONE else View.VISIBLE
        applyStemLayout(q)

        b.btnConfirm.visibility = if (q.type == "multi") View.VISIBLE else View.GONE

        options.forEachIndexed { i, v ->
            val text = q.options.getOrNull(i)
            if (text == null) {
                v.visibility = View.GONE
            } else {
                v.visibility = View.VISIBLE
                v.text = text
                v.isEnabled = true
                v.isClickable = true
                v.isFocusable = true
                v.setTextColor(ContextCompat.getColorStateList(this, R.color.option_text))
                v.background = ContextCompat.getDrawable(this, R.drawable.bg_option)
            }
        }
        options.firstOrNull { it.visibility == View.VISIBLE }?.requestFocus()
    }

    /**
     * 按内容多少选版式（两套都是居中一列，只差字号/宽度）：
     *   · 短题 —— 题干 38sp 大字 + 60dp 大选项，整组在屏幕正中；
     *   · 长题 —— 题干 28sp（最多 3 行）+ 44dp 选项，同样整组居中，
     *            只是收一档，保证内容多时也不会被挤出屏幕中央。
     * optionsBox 与 resultBox 一起「搬家」，所有控件 ID 不变，
     * 点击、焦点、结果标记逻辑不受影响。
     *
     * 这里刻意做成**完全幂等**：每次换题都重设可见性、搬家、重设尺寸，不再用
     * 「版式和上次一样就 return」省这一步。early return 容易跳过可见性修正，
     * 导致两套版式同时可见、题干叠在一起。一次 requestLayout 的代价可以忽略。
     */
    private fun applyStemLayout(q: Quiz) {
        b.tvStem.text = q.prompt
        b.tvStemLong.text = q.prompt
        val long = needsSplit(q)

        b.shortRoot.visibility = if (long) View.GONE else View.VISIBLE
        b.longRoot.visibility = if (long) View.VISIBLE else View.GONE

        moveTo(b.optionsBox, if (long) b.longSlot else b.shortSlot)
        moveTo(b.resultBox, if (long) b.longResultSlot else b.shortResultSlot)

        // 两套版式都是居中一列，只有宽度/高度收一档（长题不再左右分栏）
        val lp = b.optionsBox.layoutParams as FrameLayout.LayoutParams
        lp.width = dp(if (long) OPTION_BOX_LONG_DP else OPTION_BOX_SHORT_DP)
        lp.gravity = Gravity.CENTER_HORIZONTAL
        b.optionsBox.layoutParams = lp

        // 长题内容多，选项矮一档，整组才放得进屏幕中央
        val h = dp(if (long) OPTION_LONG_DP else OPTION_SHORT_DP)
        options.forEach { v ->
            val p = v.layoutParams as LinearLayout.LayoutParams
            p.height = h
            v.layoutParams = p
        }

        // 结果区：两套版式都居中（原来长题是贴右栏左边缘，看着偏）
        val g = Gravity.CENTER
        b.tvFeedback.gravity = g
        b.tvExplanation.gravity = g
        b.tvFeedback.maxLines = if (long) 2 else 1
        b.tvExplanation.maxLines = if (long) 3 else 3
    }

    /** 中文按全角（2）、英文数字按半角（1）折算，比纯字数更贴近实际占宽 */
    private fun needsSplit(q: Quiz): Boolean {
        var units = 0
        for (ch in q.prompt) units += if (ch.code >= 0x2E80) 2 else 1
        return units > LONG_STEM_UNITS || q.options.any { it.length > LONG_OPTION_CHARS }
    }

    private fun moveTo(view: View, target: FrameLayout) {
        if (view.parent === target) return
        (view.parent as? ViewGroup)?.removeView(view)
        target.addView(view)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).roundToInt()

    private fun resetUi() {
        answered = false
        picked.clear()
        // 上一题可能是长题版式，这里一并收回去：取题是异步的，两个 root 同时可见
        // 会在这段时间里叠出两份题干
        b.longRoot.visibility = View.GONE
        b.shortRoot.visibility = View.VISIBLE
        b.tvFeedback.text = ""
        // 空的反馈行也占高度，隐藏掉短题内容组才能真正落在屏幕正中
        b.tvFeedback.visibility = View.GONE
        b.tvFeedback.setTextColor(ContextCompat.getColor(this, R.color.ink2))
        b.tvExplanation.visibility = View.GONE
        b.tvCountdown.visibility = View.GONE
        b.btnConfirm.visibility = View.GONE
        b.btnConfirm.isEnabled = true
    }

    private fun onOption(index: Int) {
        // 提交过就彻底锁死：这一句就是"点正确答案没反应"的正面表达
        if (answered || busy) return
        val q = current ?: return
        val choice = q.options.getOrNull(index) ?: return

        if (q.type == "multi") {
            if (!picked.remove(index)) picked.add(index)
            options.forEachIndexed { i, v ->
                val text = q.options.getOrNull(i) ?: return@forEachIndexed
                v.text = if (picked.contains(i)) "✓ $text" else text
            }
            b.btnConfirm.isEnabled = picked.isNotEmpty()
            return
        }
        picked.clear()
        picked.add(index)
        submit(choice)
    }

    private fun submitSelected() {
        if (answered || busy || picked.isEmpty()) return
        val q = current ?: return
        val choices = picked.sorted().mapNotNull { q.options.getOrNull(it) }
        if (choices.isEmpty()) return
        submit(choices.joinToString("|"))
    }

    private fun submit(choice: String) {
        val q = current ?: return
        answered = true
        busy = true
        // ① 立刻锁死所有选项：不可点、不可聚焦、聚焦高亮也去掉
        options.forEach { v ->
            v.isEnabled = false
            v.isClickable = false
            v.isFocusable = false
            v.background = ContextCompat.getDrawable(this, R.drawable.bg_option)
        }
        b.btnConfirm.isEnabled = false
        // 多选题的「确认」按钮答题后就没用了，收掉给反馈/解析腾位置
        b.btnConfirm.visibility = View.GONE

        lifecycleScope.launch {
            val delta = WatchTracker.takePendingReportMs()
            val r = withContext(Dispatchers.IO) { Remote.submit(q.id, choice, delta) }
            busy = false
            if (r == null) {
                // 答了但没传上去：不解锁、不放行，提示后换一道题继续
                b.tvFeedback.visibility = View.VISIBLE
                b.tvFeedback.setTextColor(ContextCompat.getColor(this@QuizActivity, R.color.warn))
                b.tvFeedback.text = getString(R.string.quiz_submit_fail)
                handler.postDelayed({ loadQuestion() }, 2_000L)
                return@launch
            }
            showResult(r)
        }
    }

    private fun showResult(r: AnswerResult) {
        b.tvFeedback.visibility = View.VISIBLE
        // ① 把对错标在选项上：正确项绿✓，自己选错的那个红✗，其余压暗
        markOptions(r)

        // 换时长模式走另一套逻辑：答对只是攒进度，攒满才发奖
        if (rewardMode) {
            showRewardResult(r)
            return
        }

        val session = Remote.session
        val isGroup = session?.quizMode == "group"

        b.tvFeedback.setTextColor(
            ContextCompat.getColor(this, if (r.correct) R.color.ok else R.color.bad)
        )
        b.tvFeedback.text = buildString {
            append(if (r.correct) "答对了" else "答错了，正确答案是「${r.answer}」")
            if (isGroup && r.groupSize > 0) {
                append(" · 本组 ${r.groupAsked}/${r.groupSize}（对 ${r.groupRate}%）")
            }
        }

        // ② 解析：和提示重复就不重复念
        val exp = r.explanation.trim()
        if (exp.isNotEmpty() && exp != b.tvHint.text) {
            b.tvExplanation.text = exp
            b.tvExplanation.visibility = View.VISIBLE
        } else if (isGroup && r.groupFinished && !r.pass) {
            b.tvExplanation.text = "这一组正确率 ${r.groupRate}%，没到 ${session?.groupPassRate ?: 60}%，再来一组"
            b.tvExplanation.visibility = View.VISIBLE
        }

        // ③ 3 秒后自己走
        val hint = when {
            r.pass -> "回到电视"
            isGroup && r.groupFinished -> "开始新一组"
            else -> "换下一题"
        }
        scheduleNext(3, r.pass, hint)
    }

    /**
     * 换时长模式的结果页。
     *
     * 与普通答题的区别：答对一题不再直接放行，而是攒进度；
     * 攒满 N 题由管理端发奖励（grantedMin > 0），这时才关页回电视。
     * 答错不计数也不清零 —— 慢慢攒，别把孩子卡在差一题上。
     */
    private fun showRewardResult(r: AnswerResult) {
        b.tvFeedback.visibility = View.VISIBLE
        val rw = r.reward
        val granted = rw?.grantedMin ?: 0
        b.tvFeedback.setTextColor(
            ContextCompat.getColor(this, if (r.correct) R.color.ok else R.color.bad)
        )

        when {
            granted > 0 -> {
                // 发奖成功：立刻写回本地会话，锁定页一恢复就会自己关掉
                rw?.let { Remote.applyReward(it) }
                b.tvFeedback.text = "答对了！奖励 $granted 分钟"
                b.tvExplanation.text = "已经加进今天的时长里，接着看电视吧"
                b.tvExplanation.visibility = View.VISIBLE
                scheduleNext(3, true, "回到电视")
            }
            rw?.stage == "exhausted" -> {
                b.tvFeedback.text = if (r.correct) "答对了" else "答错了，正确答案是「${r.answer}」"
                b.tvExplanation.text = "今天的换时长次数已经用完了"
                b.tvExplanation.visibility = View.VISIBLE
                scheduleNext(3, true, "关闭")
            }
            // 中途家长关了开关、调大了总时长，或者管理端是老版本没有 reward 字段：
            // 这一轮已经没有"换时长"这回事了，别再让孩子傻答下去
            rw == null || rw.stage != "open" -> {
                b.tvFeedback.text = if (r.correct) "答对了" else "答错了，正确答案是「${r.answer}」"
                b.tvExplanation.text = "换时长已经结束，回去看电视吧"
                b.tvExplanation.visibility = View.VISIBLE
                scheduleNext(3, true, "返回")
            }
            else -> {
                val c = rw?.correct ?: 0
                val n = rw?.need ?: 10
                b.tvFeedback.text = if (r.correct) {
                    "答对了 · 已完成 $c/$n"
                } else {
                    "答错了，正确答案是「${r.answer}」"
                }
                b.tvExplanation.text = if (r.correct) {
                    "再答对 ${(n - c).coerceAtLeast(1)} 题就能换时长"
                } else {
                    "答错不计数，换一题继续"
                }
                b.tvExplanation.visibility = View.VISIBLE
                scheduleNext(3, false, "换下一题")
            }
        }
    }

    /** 把对错标到选项上：正确项绿✓，自己选错的标红✗，其余压暗 */
    private fun markOptions(r: AnswerResult) {
        val right = splitAnswer(r.answer)
        options.forEachIndexed { i, v ->
            val text = current?.options?.getOrNull(i) ?: return@forEachIndexed
            when {
                right.contains(text) -> {
                    v.text = "✓ $text"
                    v.setTextColor(ContextCompat.getColor(this, R.color.ok))
                }
                picked.contains(i) -> {
                    v.text = "✗ $text"
                    v.setTextColor(ContextCompat.getColor(this, R.color.bad))
                }
                else -> v.setTextColor(ContextCompat.getColor(this, R.color.ink3))
            }
        }
    }

    /**
     * 结果页只停留 [seconds] 秒，然后自动走：
     * [finishAfter] = true 就关页回去（放行 / 奖励到账），否则换下一道题。
     * 全自动，不需要按遥控器。
     */
    private fun scheduleNext(seconds: Int, finishAfter: Boolean, hint: String) {
        var left = seconds
        b.tvCountdown.visibility = View.VISIBLE
        b.tvCountdown.text = "$left 秒后$hint"
        val step = object : Runnable {
            override fun run() {
                left -= 1
                if (left <= 0) {
                    b.tvCountdown.visibility = View.GONE
                    if (finishAfter) closeQuiz() else loadQuestion()
                    return
                }
                b.tvCountdown.text = "$left 秒后$hint"
                handler.postDelayed(this, 1_000L)
            }
        }
        handler.postDelayed(step, 1_000L)
    }

    /** 正确答案拆成集合：多选是「A|B」，单选就是整串 */
    private fun splitAnswer(answer: String): Set<String> =
        answer.split('|', '｜', ',', '，', '、')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .toSet()
}
