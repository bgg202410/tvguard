package cn.binguoguo.tvguard.launcher

import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.LinearLayout
import androidx.recyclerview.widget.RecyclerView
import cn.binguoguo.tvguard.R
import cn.binguoguo.tvguard.data.AppEntry
import cn.binguoguo.tvguard.databinding.ItemAllHeaderBinding
import cn.binguoguo.tvguard.databinding.ItemAppBinding
import cn.binguoguo.tvguard.databinding.ItemRecentBinding
import cn.binguoguo.tvguard.databinding.ItemRecentHeaderBinding

/**
 * 桌面列表：两行表头（最近使用 / 全部应用）
 */
class AppAdapter(private val onOpen: (AppEntry) -> Unit) :
    RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private val apps = ArrayList<AppEntry>()
    private var recent: List<AppEntry> = emptyList()

    fun submit(list: List<AppEntry>, recentApps: List<AppEntry>) {
        apps.clear()
        apps.addAll(list)
        recent = recentApps
        notifyDataSetChanged()
    }

    fun isHeader(position: Int): Boolean = position < headerCount

    private val headerCount: Int get() = if (recent.isEmpty()) 1 else 2

    override fun getItemCount(): Int = headerCount + apps.size

    override fun getItemViewType(position: Int): Int = when {
        recent.isNotEmpty() && position == 0 -> TYPE_RECENT
        position == headerCount - 1 -> TYPE_ALL
        else -> TYPE_APP
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            TYPE_RECENT -> RecentHeaderVH(ItemRecentHeaderBinding.inflate(inflater, parent, false))
            TYPE_ALL -> AllHeaderVH(ItemAllHeaderBinding.inflate(inflater, parent, false))
            else -> AppVH(ItemAppBinding.inflate(inflater, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (holder) {
            is RecentHeaderVH -> holder.bind(recent)
            is AllHeaderVH -> Unit
            is AppVH -> holder.bind(apps[position - headerCount])
        }
    }

    private inner class RecentHeaderVH(private val b: ItemRecentHeaderBinding) :
        RecyclerView.ViewHolder(b.root) {

        fun bind(list: List<AppEntry>) {
            b.llRecent.removeAllViews()
            val inflater = LayoutInflater.from(b.root.context)
            val gap = (5 * b.root.resources.displayMetrics.density).toInt()
            list.forEach { entry ->
                val item = ItemRecentBinding.inflate(inflater, b.llRecent, false)
                item.tvName.text = entry.label
                if (entry.isSettings) item.ivIcon.setImageResource(R.drawable.ic_launcher)
                else item.ivIcon.setImageDrawable(entry.icon)
                item.root.setOnClickListener { onOpen(entry) }
                item.root.layoutParams = LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
                ).apply {
                    marginStart = gap
                    marginEnd = gap
                }
                b.llRecent.addView(item.root)
            }
        }
    }

    private class AllHeaderVH(b: ItemAllHeaderBinding) : RecyclerView.ViewHolder(b.root)

    inner class AppVH(private val b: ItemAppBinding) : RecyclerView.ViewHolder(b.root) {

        fun bind(entry: AppEntry) {
            b.tvName.text = entry.label
            if (entry.isSettings) {
                b.ivIcon.setImageResource(R.drawable.ic_launcher)
            } else {
                b.ivIcon.setImageDrawable(entry.icon)
            }
            b.root.setOnClickListener { onOpen(entry) }
        }
    }

    private companion object {
        const val TYPE_RECENT = 0
        const val TYPE_ALL = 1
        const val TYPE_APP = 2
    }
}
