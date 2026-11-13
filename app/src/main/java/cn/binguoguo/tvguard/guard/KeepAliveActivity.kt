package cn.binguoguo.tvguard.guard

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import cn.binguoguo.tvguard.R
import cn.binguoguo.tvguard.data.Prefs
import cn.binguoguo.tvguard.databinding.ActivityKeepaliveBinding

class KeepAliveActivity : AppCompatActivity() {

    private lateinit var b: ActivityKeepaliveBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityKeepaliveBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.btnA11y.text = getString(R.string.keep_open_admin)
        b.btnA11y.setOnClickListener { openAdmin() }
        b.btnGuard.setOnClickListener { openTclGuard() }
        b.btnBattery.setOnClickListener { openBattery() }
        b.btnHealth.setOnClickListener { toggleHealthCheck() }
        (b.root.findViewById<TextView>(R.id.keepBackBtn)).setOnClickListener { finish() }
        b.btnHealth.requestFocus()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        val admin = GuardDeviceAdmin.isActive(this)
        b.tvA11y.text = if (admin) getString(R.string.keep_admin_on)
        else getString(R.string.keep_admin_off)
        b.tvA11y.setTextColor(getColorCompat(if (admin) R.color.ok else R.color.warn))

        val battery = isIgnoringBattery()
        b.tvBattery.text = getString(if (battery) R.string.keep_battery_on else R.string.keep_battery_off)
        b.tvBattery.setTextColor(getColorCompat(if (battery) R.color.ok else R.color.warn))

        b.tvKilled.text = getString(R.string.keep_watch_dog)
        b.tvMsg.text = if (admin && battery) getString(R.string.keep_all_done) else ""

        // Profile Owner 状态 + 权限探测（这台 TCL 上 DO 设不上，PO 是手动 adb 设置的）
        val po = DeviceOwner.isProfileOwner(this)
        val probe = if (po) DeviceOwner.probe(this) else null
        when {
            !po -> {
                b.tvOwner.text = getString(R.string.keep_owner_off)
                b.tvOwner.setTextColor(getColorCompat(R.color.warn))
                b.tvHealth.text = getString(R.string.keep_killers_none)
                b.tvHealth.setTextColor(getColorCompat(R.color.ink3))
                b.btnHealth.text = getString(R.string.keep_btn_health_hide)
                b.btnHealth.isEnabled = false
                b.btnHealth.isFocusable = false
            }
            probe != null -> {
                b.tvOwner.text = getString(R.string.keep_owner_no_perm, probe)
                b.tvOwner.setTextColor(getColorCompat(R.color.warn))
                b.tvHealth.text = getString(R.string.keep_killers_none)
                b.tvHealth.setTextColor(getColorCompat(R.color.ink3))
                b.btnHealth.text = getString(R.string.keep_btn_health_hide)
                b.btnHealth.isEnabled = false
                b.btnHealth.isFocusable = false
            }
            else -> {
                b.tvOwner.text = getString(R.string.keep_owner_on)
                b.tvOwner.setTextColor(getColorCompat(R.color.ok))
                renderKillers()
            }
        }
        b.btnA11y.text = getString(if (admin) R.string.keep_admin_done else R.string.keep_open_admin)
    }

    private fun renderKillers() {
        val states = DeviceOwner.hiddenStates(this)
        if (states.isEmpty()) {
            b.tvHealth.text = getString(R.string.keep_killers_none)
            b.tvHealth.setTextColor(getColorCompat(R.color.warn))
            b.btnHealth.text = getString(R.string.keep_btn_health_hide)
            b.btnHealth.isEnabled = true
            b.btnHealth.isFocusable = true
            return
        }
        val hiddenNames = StringBuilder()
        val visibleNames = StringBuilder()
        CleanerPackages.active().forEach { entry ->
            val pkg = entry.pkg
            val name = entry.label
            if (states[pkg] == true) hiddenNames.append(name).append(" ")
            else visibleNames.append(name).append(" ")
        }
        when {
            visibleNames.isEmpty() -> {
                b.tvHealth.text = getString(R.string.keep_killers_all)
                b.tvHealth.setTextColor(getColorCompat(R.color.ok))
                b.btnHealth.text = getString(R.string.keep_btn_health_show)
            }
            hiddenNames.isEmpty() -> {
                b.tvHealth.text = getString(R.string.keep_killers_none)
                b.tvHealth.setTextColor(getColorCompat(R.color.warn))
                b.btnHealth.text = getString(R.string.keep_btn_health_hide)
            }
            else -> {
                b.tvHealth.text = getString(
                    R.string.keep_killers_part,
                    hiddenNames.toString().trim(),
                    visibleNames.toString().trim()
                )
                b.tvHealth.setTextColor(getColorCompat(R.color.warn))
                b.btnHealth.text = getString(R.string.keep_btn_health_hide)
            }
        }
        b.btnHealth.isEnabled = true
        b.btnHealth.isFocusable = true
    }

    /** 屏蔽 / 恢复全部清理工具 */
    private fun toggleHealthCheck() {
        if (!DeviceOwner.isProfileOwner(this) || DeviceOwner.probe(this) != null) {
            b.tvMsg.text = getString(R.string.keep_owner_off)
            return
        }
        val anyVisible = DeviceOwner.hiddenStates(this).any { it.value != true }
        val err = DeviceOwner.setAllHidden(this, anyVisible)
        if (err == null) {
            Prefs.killersHidden = anyVisible // 屏蔽成功才记账，自动兜底从此生效
            b.tvMsg.text = getString(if (anyVisible) R.string.keep_health_done else R.string.keep_health_show_done)
        } else {
            b.tvMsg.text = getString(R.string.keep_health_fail, err)
        }
        render()
    }

    private fun openAdmin() {
        if (GuardDeviceAdmin.isActive(this)) {
            b.tvMsg.text = getString(R.string.keep_admin_done)
            return
        }
        if (!GuardDeviceAdmin.requestActivate(this)) {
            b.tvMsg.text = getString(R.string.keep_no_page)
        }
    }

    private fun openTclGuard() {
        val ok = runCatching {
            startActivity(
                Intent().setClassName(
                    "com.tcl.tvhealthcheck",
                    "com.tcl.tvhealthcheck.MainActivity"
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            true
        }.getOrDefault(false)
        if (!ok) {
            runCatching { startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            b.tvMsg.text = getString(R.string.keep_guard_missing)
        } else {
            b.tvMsg.text = getString(R.string.keep_guard_tip)
        }
    }

    private fun openBattery() {
        if (isIgnoringBattery()) {
            b.tvMsg.text = getString(R.string.keep_battery_on)
            return
        }
        val direct = runCatching {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName")
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            true
        }.getOrDefault(false)
        if (direct) return
        runCatching {
            startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }.onFailure { b.tvMsg.text = getString(R.string.keep_no_page) }
    }

    private fun isIgnoringBattery(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = getSystemService(PowerManager::class.java) ?: return false
        return runCatching { pm.isIgnoringBatteryOptimizations(packageName) }.getOrDefault(false)
    }

    private fun getColorCompat(id: Int): Int = androidx.core.content.ContextCompat.getColor(this, id)
}
