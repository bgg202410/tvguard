package cn.binguoguo.tvguard.guard

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import cn.binguoguo.tvguard.R
import cn.binguoguo.tvguard.databinding.ActivityUpdateBinding
import cn.binguoguo.tvguard.net.Remote
import cn.binguoguo.tvguard.net.UpdateInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import cn.binguoguo.tvguard.launcher.HomeActivity

/**
 * 发现新版本时升级
 */
class UpdateActivity : AppCompatActivity() {

    private lateinit var b: ActivityUpdateBinding
    private val handler = Handler(Looper.getMainLooper())
    private var info: UpdateInfo? = null
    private var busy = false

    private var installerLaunched = false

    override fun onResume() {
        super.onResume()
        if (!installerLaunched) return
        installerLaunched = false
        startActivity(
            Intent(this, HomeActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        )
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityUpdateBinding.inflate(layoutInflater)
        setContentView(b.root)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        buildButtons()
        info = Remote.pendingUpdate
        if (info != null) {
            bind(info!!)
        } else {
            // 直接从通知/别的地方进来：自己查一次
            b.tvVer.text = getString(R.string.upd_checking)
            lifecycleScope.launch {
                val got = withContext(Dispatchers.IO) { Remote.checkUpdate() }
                if (got == null) {
                    b.tvVer.text = getString(R.string.upd_none)
                    handler.postDelayed({ finish() }, 1500L)
                } else {
                    info = got
                    bind(got)
                }
            }
        }
    }

    private fun bind(u: UpdateInfo) {
        b.tvVer.text = getString(R.string.upd_version, u.versionName, fmtSize(u.size))
    }

    private fun buildButtons() {
        b.btnRow.removeAllViews()
        val later = key(getString(R.string.upd_later), dp(240), 54, primary = false) { finish() }
        val now = key(getString(R.string.upd_now), dp(240), 54, primary = true) { startDownload() }
        b.btnRow.addView(later)
        b.btnRow.addView(now)
        now.requestFocus()
    }

    private fun key(label: String, width: Int, height: Int, primary: Boolean, onClick: () -> Unit): TextView {
        val tv = TextView(this)
        tv.text = label
        tv.gravity = Gravity.CENTER
        tv.isClickable = true
        tv.isFocusable = true
        tv.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 18f)
        tv.setTextColor(Color.WHITE)
        tv.background = ContextCompat.getDrawable(this, if (primary) R.drawable.bg_primary else R.drawable.bg_option)
        tv.layoutParams = LinearLayout.LayoutParams(width, dp(height)).apply {
            marginStart = dp(6); marginEnd = dp(6)
        }
        tv.setOnClickListener { if (!busy) onClick() }
        tv.setOnFocusChangeListener { v, has ->
            (v as TextView).setTextColor(Color.WHITE)
            if (has) v.animate().scaleX(1.06f).scaleY(1.06f).setDuration(90).start()
            else v.animate().scaleX(1f).scaleY(1f).setDuration(90).start()
        }
        return tv
    }

    private fun startDownload() {
        val u = info ?: return
        val dest = File(File(cacheDir, "update"), "tvguard.apk")
        busy = true
        b.btnRow.visibility = View.GONE
        b.pb.visibility = View.VISIBLE
        b.tvProg.text = getString(R.string.upd_downloading, 0)

        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                Remote.downloadApk(dest, u.md5) { pct ->
                    handler.post { b.pb.progress = pct; b.tvProg.text = getString(R.string.upd_downloading, pct) }
                }
            }
            busy = false
            if (!ok) {
                b.pb.visibility = View.GONE
                b.tvProg.text = getString(R.string.upd_failed)
                b.btnRow.visibility = View.VISIBLE
                return@launch
            }
            b.tvProg.text = getString(R.string.upd_installing)
            install(dest)
        }
    }

    private fun install(file: File) {
        try {
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            installerLaunched = true
            startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            )
            b.tvProg.text = getString(R.string.upd_need_confirm)
        } catch (t: Throwable) {
            b.tvProg.text = getString(R.string.upd_install_failed, t.message ?: "")
            b.btnRow.visibility = View.VISIBLE
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun fmtSize(n: Long): String {
        if (n <= 0) return ""
        return if (n >= 1024 * 1024) String.format("%.1f MB", n / 1024.0 / 1024.0)
        else "${n / 1024} KB"
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
