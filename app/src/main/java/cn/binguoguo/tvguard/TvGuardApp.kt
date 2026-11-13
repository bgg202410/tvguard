package cn.binguoguo.tvguard

import android.app.Application
import cn.binguoguo.tvguard.data.Prefs
import cn.binguoguo.tvguard.guard.AlarmWatchdog
import cn.binguoguo.tvguard.guard.GuardService
import cn.binguoguo.tvguard.guard.WatchTracker
import cn.binguoguo.tvguard.net.Remote

class TvGuardApp : Application() {

    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        Remote.start(this)
        WatchTracker.attach(this)
        GuardService.start(this)
        AlarmWatchdog.schedule(this)
        Remote.checkAtBoot()
    }
}
