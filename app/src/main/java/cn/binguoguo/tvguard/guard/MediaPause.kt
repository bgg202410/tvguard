package cn.binguoguo.tvguard.guard

import android.content.Context
import android.media.AudioManager

/**
 * 让电视上正在播放的节目「暂停一下」。
 *
 * 普通 App 没有权限直接控制别的播放器（发 MEDIA_PAUSE 需要系统签名），
 * 唯一通用的手段是 **抢音频焦点**：请求 AUDIOFOCUS_GAIN_TRANSIENT 之后，
 * 遵循 Android 音频焦点规范的播放器（TCL 内置播放器、腾讯/爱奇艺/芒果等主流 App
 * 都遵循）会收到 AUDIOFOCUS_LOSS_TRANSIENT 并暂停；答题页关闭时放弃焦点，
 * 它们会自己接着播。
 *
 * 局限要说清楚：不遵循音频焦点的播放器（个别直播类、魔改固件）不会暂停，
 * 这时只能保证「声音会被让出来」，画面继续走 —— 属于系统能力上限，不是 bug。
 */
object MediaPause {

    private var am: AudioManager? = null
    private var listener: AudioManager.OnAudioFocusChangeListener? = null

    private var held = false

    /** 进入答题/锁屏页时调用。重复调用无副作用。 */
    fun hold(ctx: Context) {
        if (held) return
        val a = ctx.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        val l = AudioManager.OnAudioFocusChangeListener { /* 我们不关心别人来抢 */ }
        val r = try {
            a.requestAudioFocus(l, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        } catch (t: Throwable) {
            AudioManager.AUDIOFOCUS_REQUEST_FAILED
        }
        if (r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            am = a
            listener = l
            held = true
        }
    }

    /** 离开答题/锁屏页时调用，播放器会自动恢复播放。 */
    fun release() {
        if (!held) return
        try {
            am?.abandonAudioFocus(listener)
        } catch (t: Throwable) {
        }
        am = null
        listener = null
        held = false
    }
}
