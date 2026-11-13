package cn.binguoguo.tvguard.data

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo

/**
 * 读取已安装的应用。
 */
class AppRepository(private val ctx: Context) {

    fun load(): List<AppEntry> {
        val pm = ctx.packageManager
        val raw = query(pm, CATEGORY_LEANBACK) + query(pm, CATEGORY_PLAIN)

        val seen = HashSet<String>()
        val out = ArrayList<AppEntry>(raw.size)
        for (ri in raw) {
            val ai = ri.activityInfo ?: continue
            val pkg = ai.packageName
            if (pkg == ctx.packageName) continue
            if (!seen.add(pkg)) continue
            val label = runCatching { ri.loadLabel(pm).toString() }.getOrDefault(pkg)
            if (label.isBlank()) continue
            val icon = runCatching { ri.loadIcon(pm) }.getOrNull()
            out.add(AppEntry(label, pkg, ComponentName(ai.packageName, ai.name), icon))
        }
        return out.distinctBy { it.packageName }
    }

    private fun query(pm: PackageManager, category: String): List<ResolveInfo> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(category)
        return runCatching { pm.queryIntentActivities(intent, 0) }.getOrDefault(emptyList())
    }

    companion object {
        private const val CATEGORY_LEANBACK = "android.intent.category.LEANBACK_LAUNCHER"
        private const val CATEGORY_PLAIN = "android.intent.category.LAUNCHER"
    }
}
