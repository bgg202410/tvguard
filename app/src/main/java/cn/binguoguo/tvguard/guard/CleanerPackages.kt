package cn.binguoguo.tvguard.guard

object CleanerPackages {

    data class Entry(val pkg: String, val label: String)

    val DEFAULT: List<Entry> = listOf(
        Entry("com.tcl.tvhealthcheck", "TCL 健康检查"),
        Entry("com.tcl.tvweishi", "TCL 电视卫士"),
    )

    fun active(): List<Entry> = DEFAULT
}
