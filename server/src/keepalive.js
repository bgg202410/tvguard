'use strict';

/**
 * 断线即拉起（一对多）。
 *
 * 管理端与客户端是「一对多」—— 一台管理端管多台电视，每台独立心跳、独立判定、独立拉起。
 * 某台电视超过「自己心跳间隔的 2 倍」没来心跳（连接断开），管理端立刻通过 adb
 * 把它的守护服务拉起来（不抢前台、不打断播放）；客户端被拉起后会立刻重启心跳，
 * 重新建立连接。
 *
 * 不再有「定时巡检 + 唤醒冷却 + 修复冷却」那一套：长连接断了就是断了，立即发一次
 * 拉起命令；连不上（电视关机 / 网桥不通）就等下次翻转或静默重试，不刷屏。
 *
 * 事件去重：只看「在线 → 离线」「离线 → 在线」的翻转，每种状态只记一次
 * （device_offline / device_online），避免「失败失败成功成功」刷满日志。
 *
 * 前提：电视和管理端在同一局域网、电视开着网络调试（开发时已经开过）。
 * 电视 IP 统一走 store.effectiveIp()：Docker 网桥下请求来源只是网桥网关
 * （172.x.0.1），必须用电视自报的局域网 IP 或家长在后台手动指定的地址。
 */

const adb = require('./adb');
const config = require('./config');

const PKG = config.TV_PACKAGE;
// 组件名的两段前缀已统一：namespace 与 applicationId 都是 PKG，
// 完整组件名是 <PKG>/<PKG>.<类路径>，不再是「包名 + 另一套源码类名」的两截拼接。
const A11Y_COMPONENT = PKG + '/' + PKG + '.guard.GuardAccessibilityService';
const ADMIN_COMPONENT = PKG + '/' + PKG + '.guard.GuardDeviceAdmin';
// 离线唤醒用的两个入口：
//  - 守护服务（首选）：am startservice 把进程带起来 —— Application.onCreate 重新挂
//    计时引擎、心跳恢复、右上角角标自己回来，**全程不抢前台**，孩子正在看的
//    第三方 App（酷喵等）不会被顶掉、播放不打断；
//  - 入口 Activity（兜底）：个别固件不支持 shell 拉服务时才用 am start 把守时桌面
//    顶到前台 —— 会打断当前播放，属于最后手段。
const GUARD_SERVICE = PKG + '/' + PKG + '.guard.GuardService';
const LAUNCH_ACTIVITY = PKG + '/' + PKG + '.launcher.HomeActivity';

const running = new Set();   // 正在修复的设备，防并发
const reviving = new Set();  // 正在唤醒的设备，防并发

/** 悬浮窗权限在 Android 6+ 上是 appops 项（不是运行时权限），只能靠 appops 读写 */
const OVERLAY_OP = 'SYSTEM_ALERT_WINDOW';
/** 正在补悬浮窗权限的设备，防并发（连点两次推送） */
const overlaying = new Set();

/** 内部检测周期（毫秒）：不暴露为后台配置；5 秒扫一遍足够"立即"发现断线 */
const WATCH_TICK_MS = 5000;

/**
 * 自动补无障碍的冷却时间：同一台电视 10 分钟内最多试一次。
 * adb 连不上时一条命令要等几十秒，心跳 5 秒一次，不设冷却会把 adb 打满。
 */
const AUTO_FIX_COOLDOWN_MS = 10 * 60 * 1000;
/** 正在自动补的设备，防并发（连续几次心跳） */
const autoFixing = new Set();

/** 每台设备的在线状态（'online' / 'offline'），只存内存，用于事件去重 */
const stateMap = new Map();

function commandList(needA11y, needAdmin) {
  const list = [];
  if (needA11y) {
    list.push({ why: 'a11y_service', cmd: 'settings put secure enabled_accessibility_services ' + A11Y_COMPONENT });
    list.push({ why: 'a11y_enabled', cmd: 'settings put secure accessibility_enabled 1' });
  }
  if (needAdmin) {
    list.push({ why: 'admin_active', cmd: 'dpm set-active-admin ' + ADMIN_COMPONENT });
  }
  return list;
}

/**
 * 修复无障碍 / 设备管理员（不抛错）。返回 null 表示这次没尝试（无 IP / 已在修）。
 * 注意：本函数不记事件，事件由调用方（手动路由 / watcher）决定，避免刷屏。
 * @returns {Promise<{ok:boolean, target?:string, outputs?:Array, error?:string, skipped?:boolean}|null>}
 */
async function attemptFix(s, deviceId, opts) {
  const force = !!(opts && opts.force);
  const d = s.getDevice(deviceId);
  if (!d) return null;
  if (running.has(deviceId)) return null;
  const ip = s.effectiveIp(d);   // Docker 网桥下 lastIp 可能是网关，必须用解析后的地址
  if (!ip) {
    if (force) {
      const msg = '没有可用的电视 IP（Docker 网桥下自动识别会拿到网关，请在后台手动指定电视 IP）';
      s.recordFix(deviceId, false, msg);
      return { ok: false, error: msg };
    }
    return null;
  }

  const needA11y = d.a11yOn === false;
  // 自动补只动无障碍：设备管理员是「激活」语义，留给家长在后台手动拨开关
  const needAdmin = !(opts && opts.a11yOnly) && d.adminActive === false;
  if (!needA11y && !needAdmin) {
    // 状态都齐了：手动点了也如实告诉「不用修」
    return { ok: true, skipped: true };
  }

  running.add(deviceId);
  const target = [needA11y && '无障碍', needAdmin && '设备管理员'].filter(Boolean).join('+');
  try {
    const outputs = [];
    for (const c of commandList(needA11y, needAdmin)) {
      const out = await adb.adbShell(ip, adb.DEFAULT_PORT, c.cmd, { timeout: 40000 });
      outputs.push(c.why + '=' + String(out || '').trim().slice(0, 80));
    }
    s.recordFix(deviceId, true, '', target);
    return { ok: true, target, outputs };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 200);
    s.recordFix(deviceId, false, msg, target);
    return { ok: false, target, error: msg };
  } finally {
    running.delete(deviceId);
  }
}

/**
 * 心跳发现「无障碍没开」时自动补开（用户要求：有权限就自动开启）。
 *
 * 触发条件：电视上报 a11yOn=false 且距上次尝试超过 10 分钟。
 * 只补无障碍，不动设备管理员（那个是后台手动开关的语义）。
 * 不 await、不抛错：adb 慢就慢在后台，绝不能让心跳卡住；
 * 失败会写进设备的 fixAt/fixOk，设备卡上直接能看见上次尝试结果。
 *
 * @returns {Promise<object|null>} null = 这次没尝试（不需要 / 冷却中 / 已在跑）
 */
async function maybeAutoFix(s, deviceId){
  const d = s.getDevice(deviceId);
  if (!d || d.a11yOn !== false) return null;             // 已经开着，不用管
  if (autoFixing.has(deviceId)) return null;             // 上一轮还没跑完
  if (Date.now() - (d.fixAt || 0) < AUTO_FIX_COOLDOWN_MS) return null;  // 冷却中
  autoFixing.add(deviceId);
  try {
    const r = await attemptFix(s, deviceId, { a11yOnly: true });
    if (r) {
      s.appendEvent({
        type: 'keepalive_fix', deviceId, auto: true,
        ok: !!r.ok, target: r.target, error: r.error
      });
    }
    return r;
  } catch (e) {
    return null;   // attemptFix 内部已记 fixAt/fixError，这里不再刷事件
  } finally {
    autoFixing.delete(deviceId);
  }
}

/**
 * 拉起客户端：通过 adb `am start` 把守时桌面进程拉起来（首选拉守护服务，不抢前台）。
 * 电视端被拉起后会立刻重启心跳，重新建立连接。
 * 本函数不记事件，事件由调用方决定（手动=device_revive，自动翻转=device_offline 附带）。
 * @returns {Promise<{ok:boolean, error?:string, skipped?:boolean}|null>} null = 这次没尝试
 */
async function attemptRevive(s, deviceId, opts) {
  const force = !!(opts && opts.force);
  const d = s.getDevice(deviceId);
  if (!d) return null;
  if (reviving.has(deviceId)) return null;
  const ip = s.effectiveIp(d);
  if (!ip) {
    if (force) {
      const msg = '没有可用的电视 IP（Docker 网桥下自动识别会拿到网关，请在后台手动指定电视 IP）';
      s.recordRevive(deviceId, false, msg);
      return { ok: false, error: msg };
    }
    return null;
  }
  // 内存紧张（MemFree 常年 30MB 级）时 adbd 响应极慢：实测命令其实执行成功了，
  // 只是回包超过 15 秒 —— 先查进程，活着就不必走 am start（那会抢前台）。
  const SHELL_TIMEOUT = 40000;
  reviving.add(deviceId);
  try {
    let out = '';
    let ok = true;
    try {
      out = String(await adb.adbShell(ip, adb.DEFAULT_PORT, 'am startservice -n ' + GUARD_SERVICE, { timeout: SHELL_TIMEOUT }) || '');
      if (/error|exception|failure|not found/i.test(out)) ok = false;
    } catch (e) {
      ok = false;
      out = String(e && e.message || e);
    }
    if (!ok) {
      // 关键甄别：命令可能已经生效只是回包慢。先查进程，活着就不必走 am start（那会抢前台）。
      let pid = '';
      try {
        pid = String(await adb.adbShell(ip, adb.DEFAULT_PORT, 'pidof ' + PKG, { timeout: SHELL_TIMEOUT }) || '').trim();
      } catch (e) { /* 连不上就按原失败走 */ }
      if (/^\d+/m.test(pid)) {
        ok = true;
        out = '服务已在运行（首次命令回包超时，pidof=' + pid.split(/\s/)[0] + '）';
      } else {
        try {
          const o2 = String(await adb.adbShell(ip, adb.DEFAULT_PORT, 'am start -n ' + LAUNCH_ACTIVITY, { timeout: SHELL_TIMEOUT }) || '').trim();
          out = '服务拉起失败，兜底 am start: ' + o2.slice(0, 120);
          ok = !/error|exception|failure/i.test(o2);
        } catch (e2) {
          ok = false;
          out = String(e2 && e2.message || e2).slice(0, 200);
        }
      }
    }
    // 拉活成功后顺手把无障碍/设备管理员补回来：电视上的清理工具会周期性把
    // 这两项清掉（进程被 force-stop 时系统还会顺手关掉无障碍开关）。
    if (ok) {
      let patched = [];
      for (const c of commandList(true, true)) {
        try {
          await adb.adbShell(ip, adb.DEFAULT_PORT, c.cmd, { timeout: 25000 });
          patched.push(c.why);
        } catch (e) { /* 单项失败继续补下一项 */ }
      }
      if (patched.length) out += ' | 已恢复:' + patched.join('+');
    }
    s.recordRevive(deviceId, ok, ok ? '' : out.slice(0, 200));
    return ok ? { ok: true, out } : { ok: false, error: out.slice(0, 200) };
  } finally {
    reviving.delete(deviceId);
  }
}

/**
 * 确保电视已开启「显示在其他应用上层」（悬浮窗权限）。
 *
 * 为什么要在这里兜：这条权限在 Android 6 上是 appops 项，TCL 的清理工具会把它从
 * allow 改回去；一旦被关掉，客户端会出现两种**完全静默**的失效 ——
 *   1. 右上角「下次答题」角标不显示（OverlayHint.attach 直接 return）；
 *   2. 家长留言弹不出来（NoticeOverlay.show 第一句就是 canDrawOverlays 判断）。
 * 加上这台电视的 logd 被禁，家长只会觉得「后台推了但电视没反应」。
 *
 * 推送留言时顺手调用：先读，已经是 allow 就原样返回（不做任何变更）；
 * 否则 set allow 再回读确认。读不到（关机 / 没开网络调试）就如实报错，
 * 由后端提示家长 —— 不盲目 set，避免把「连不上」误当成「已修好」。
 *
 * @returns {Promise<{ok:boolean, already?:boolean, fixed?:boolean, ip?:string, error?:string}>}
 */
async function ensureOverlay(s, deviceId) {
  const d = s.getDevice(deviceId);
  if (!d) return { ok: false, error: '设备不存在' };
  if (overlaying.has(deviceId)) return { ok: false, error: '上一次还在处理中' };
  const ip = s.effectiveIp(d);
  if (!ip) return { ok: false, error: '没有可用的电视 IP（请在后台手动指定电视 IP）' };

  const GET = 'appops get ' + PKG + ' ' + OVERLAY_OP;
  const SET = 'appops set ' + PKG + ' ' + OVERLAY_OP + ' allow';
  // 这条命令在电视上很快，但 adbd 在内存吃紧时会拖：给 12 秒，别让推送接口挂住
  const T = 12000;

  overlaying.add(deviceId);
  try {
    const before = String(await adb.adbShell(ip, adb.DEFAULT_PORT, GET, { timeout: T }) || '').trim();
    if (/\ballow\b/i.test(before)) return { ok: true, already: true, ip };
    // 没拿到可识别的回读（命令失败 / 电视离线）就不要瞎写：如实报错
    if (!/SYSTEM_ALERT_WINDOW|No operations/i.test(before)) {
      return { ok: false, ip, error: '读不到权限状态：' + (before || '无回包').slice(0, 100) };
    }

    await adb.adbShell(ip, adb.DEFAULT_PORT, SET, { timeout: T });
    const after = String(await adb.adbShell(ip, adb.DEFAULT_PORT, GET, { timeout: T }) || '').trim();
    if (/\ballow\b/i.test(after)) return { ok: true, fixed: true, ip };
    return { ok: false, ip, error: '已执行授权但回读仍是：' + (after || '无回包').slice(0, 100) };
  } catch (e) {
    return { ok: false, ip, error: String(e && e.message || e).slice(0, 160) };
  } finally {
    overlaying.delete(deviceId);
  }
}

/**
 * 断线即拉起 + 事件去重。
 *
 * 每 5 秒扫一遍所有设备（一对多，每台独立判定）。某台超过「自己心跳间隔 2 倍」
 * 没心跳 = 连接断开：翻转时记一次 device_offline 并立即拉起 + 补无障碍/管理员；
 * 恢复时记一次 device_online。仍离线时按「心跳 2 倍」静默重试（不记事件），避免刷屏。
 *
 * 进程重启后首轮只初始化状态、不记事件，防止"第一眼看到离线"刷一条。
 */
function startWatcher(s) {
  if (stateMap.size === 0) {
    for (const d of s.devicesList()) {
      const offline = Date.now() - (d.lastSeen || 0) > s.offlineWindowMs(d);
      stateMap.set(d.id, offline ? 'offline' : 'online');
    }
  }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const d of s.devicesList()) {
      const offline = now - (d.lastSeen || 0) > s.offlineWindowMs(d);
      const prev = stateMap.get(d.id) || 'online';
      if (offline && prev !== 'offline') {
        stateMap.set(d.id, 'offline');
        s.appendEvent({ type: 'device_offline', deviceId: d.id });
        // 连接断了：立即把客户端拉起来，它会被拉起后立刻重启心跳
        attemptRevive(s, d.id, { force: true }).catch(() => { /* 记录已落库 */ });
      } else if (!offline && prev !== 'online') {
        stateMap.set(d.id, 'online');
        s.appendEvent({ type: 'device_online', deviceId: d.id });
      } else if (offline && prev === 'offline') {
        // 仍离线：距上次尝试超过一个离线窗口才静默重试（不记事件），不刷屏
        if (now - (d.reviveAt || 0) > s.offlineWindowMs(d)) {
          attemptRevive(s, d.id, { force: true }).catch(() => { /* 记录已落库 */ });
        }
      }
    }
  }, WATCH_TICK_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  attemptFix, attemptRevive, ensureOverlay, maybeAutoFix, startWatcher,
  A11Y_COMPONENT, ADMIN_COMPONENT, GUARD_SERVICE, LAUNCH_ACTIVITY
};
