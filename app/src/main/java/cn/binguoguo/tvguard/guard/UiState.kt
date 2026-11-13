package cn.binguoguo.tvguard.guard

object UiState {

    /** 守时桌面是否在前台：在桌面上就不用挂角标（首页自己显示倒计时） */
    @Volatile
    var homeVisible: Boolean = false

    /** 无障碍服务是否已连接（连上说明保活生效，后台不容易被清） */
    @Volatile
    var a11yOn: Boolean = false

    /** 无障碍服务报上来的当前前台包名与时间，用来判断「是不是跑出守时桌面了」 */
    @Volatile
    var foregroundPkg: String = ""
    @Volatile
    var foregroundAt: Long = 0L

    /**
     * 家长验证通过、明确选了「进入系统桌面」之后的放行截止时间。
     */
    @Volatile
    var allowDesktopUntil: Long = 0L

    /** 上一次把系统桌面顶回去的时间，防止连续事件把首页反复拉起 */
    @Volatile
    var lastDesktopKickAt: Long = 0L

    /** 家长验证页是否正在前台：它在的时候不要去抢焦点 */
    @Volatile
    var gateShowing: Boolean = false

    /**
     * 答题页是否真实在前台（QuizActivity.onResume/onDestroy 维护）。
     */
    @Volatile
    var quizPageShowing: Boolean = false
}
