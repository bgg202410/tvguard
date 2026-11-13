package cn.binguoguo.tvguard.data

import android.content.ComponentName
import android.graphics.drawable.Drawable

data class AppEntry(
    val label: String,
    val packageName: String,
    val component: ComponentName?,
    val icon: Drawable?,
    val isSettings: Boolean = false
)
