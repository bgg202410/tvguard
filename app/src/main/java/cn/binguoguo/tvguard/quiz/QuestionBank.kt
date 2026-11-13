package cn.binguoguo.tvguard.quiz

import kotlin.random.Random

data class Question(
    val stem: String,
    val options: List<String>,
    val answerIndex: Int
)

/**
 * 口算题库。全部程序生成，不依赖 assets 与网络，题目无限且不会重复。
 * 三档难度对应小学低/中/高年级量级。
 */
object QuestionBank {

    fun next(difficulty: Int): Question {
        // 后台「题目难度 = 不限」是 0：离线兜底也要三档随机，别固定成最简单的
        val level = if (difficulty == 0) Random.nextInt(1, 4) else difficulty.coerceIn(1, 3)
        return when (level) {
            1 -> addSub(2, 20, 2, 99)
            2 -> if (Random.nextBoolean()) mul(11, 99, 3, 9) else addSub(2, 99, 2, 999)
            else -> when (Random.nextInt(3)) {
                0 -> mul(12, 99, 3, 12)
                1 -> addSub(3, 99, 100, 999)
                else -> bracket()
            }
        }
    }

    private fun addSub(aMin: Int, aMax: Int, bMin: Int, bMax: Int): Question {
        val a = Random.nextInt(aMin, aMax + 1)
        val b = Random.nextInt(bMin, bMax + 1)
        val useAdd = Random.nextBoolean() || a < b
        return if (useAdd) build("$a + $b = ?", a + b) else build("$a − $b = ?", a - b)
    }

    private fun mul(aMin: Int, aMax: Int, bMin: Int, bMax: Int): Question {
        val a = Random.nextInt(aMin, aMax + 1)
        val b = Random.nextInt(bMin, bMax + 1)
        return build("$a × $b = ?", a * b)
    }

    private fun bracket(): Question {
        val a = Random.nextInt(2, 20)
        val b = Random.nextInt(2, 20)
        val c = Random.nextInt(2, 9)
        return build("($a + $b) × $c = ?", (a + b) * c)
    }

    private fun build(stem: String, answer: Int): Question {
        val set = LinkedHashSet<Int>()
        set.add(answer)
        val span = maxOf(6, answer / 6 + 4)
        var guard = 0
        while (set.size < 4 && guard++ < 60) {
            val delta = Random.nextInt(-span, span + 1)
            if (delta == 0) continue
            val cand = answer + delta
            if (cand >= 0) set.add(cand)
        }
        var pad = 1
        while (set.size < 4) set.add(answer + pad++)

        val list = set.toMutableList()
        list.shuffle()
        return Question(stem, list.map { it.toString() }, list.indexOf(answer))
    }
}
