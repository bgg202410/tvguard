package cn.binguoguo.tvguard.guard

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View

/**
 * 圆形倒计时环
 */
class RingCountdownView(ctx: Context) : View(ctx) {

    private val density = resources.displayMetrics.density

    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.argb(105, 0, 0, 0)
    }

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 6 * density
        color = Color.argb(52, 255, 255, 255)
    }

    private val barPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 6 * density
        strokeCap = Paint.Cap.ROUND
        color = Color.rgb(74, 222, 128)
    }

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textSize = 17 * resources.displayMetrics.scaledDensity
    }

    /** 剩余比例 0..1 */
    private var fraction = 1f
    private var label = ""

    private val arcRect = RectF()

    fun set(label: String, fraction: Float) {
        val f = if (fraction.isNaN()) 1f else fraction.coerceIn(0f, 1f)
        // 每秒都会调一次，值没变就别重绘
        if (label == this.label && kotlin.math.abs(f - this.fraction) < 0.0005f) return
        this.label = label
        this.fraction = f
        barPaint.color = colorFor(f)
        invalidate()
    }

    private fun colorFor(f: Float): Int = when {
        f <= 0.06f -> 0xFFFF6B6B.toInt()   // 最后一分钟内
        f <= 0.2f -> 0xFFFFB454.toInt()
        else -> 0xFF4ADE80.toInt()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val size = (SIZE_DP * density).toInt()
        setMeasuredDimension(size, size)
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val outer = kotlin.math.min(width, height) / 2f
        val ringR = outer - barPaint.strokeWidth / 2f - 1f

        // 半透明圆底：让白字在任何画面上都读得出来
        canvas.drawCircle(cx, cy, outer, bgPaint)
        canvas.drawCircle(cx, cy, ringR, trackPaint)

        arcRect.set(cx - ringR, cy - ringR, cx + ringR, cy + ringR)
        // 从 12 点方向顺时针
        canvas.drawArc(arcRect, -90f, 360f * fraction, false, barPaint)

        // 文字垂直居中：按 fontMetrics 算基线，比 drawText(y=cy) 正
        val fm = textPaint.fontMetrics
        val baseline = cy - (fm.ascent + fm.descent) / 2f
        canvas.drawText(label, cx, baseline, textPaint)
    }

    private companion object {
        const val SIZE_DP = 90f
    }
}
