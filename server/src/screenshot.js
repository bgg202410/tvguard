'use strict';

/**
 * 电视画面自动截屏：开着的时候按后台配置的间隔（默认 10 秒）对在线的电视截一次屏。
 * 间隔（秒）/ 最大张数由后台手动配置（config.json），照片墙横向叠放浏览；
 * 保留多少张只由「最多 N 张」决定，超量从最旧的开始删，没有时间窗口。
 *
 * 实现走的是 src/adb.js 的 exec: 服务（screencap -p 输出 PNG 二进制，
 * 不能走 shell: —— 老安卓的 shell 会把 \n 改成 \r\n，PNG 直接损坏）。
 * 拉回来后用 src/img.js 压成 960 宽的 JPEG（2.2MB → 约 100KB）再落盘，
 * 落盘格式统一是「时间戳.jpg」。
 *
 * 隐私边界：这是家长控制场景，截图只落在管理端自己的 data/shots/ 里，
 * 不上传任何第三方；开关关掉后不再截新图，旧图按张数上限自然清掉。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const adb = require('./adb');
const config = require('./config');
const img = require('./img');

/** 截屏间隔由后台配置（秒，默认 10）；最大张数也由后台配置（默认 50） */
const intervalMs = () => config.getScreenshotIntervalSec() * 1000;
const maxCount = () => config.getScreenshotMaxCount();
/**
 * 判断容器是不是被 Docker bridge 隔离在电视网段之外。
 *
 * host 模式下容器看得到宿主机的局域网地址（和电视同段），但也会看到
 * docker0 的 172.x —— 所以不能用「有没有 172.x」判断，要看「有没有
 * 和电视同网段的地址」。之前这里用 ^ 锚定整个 "eth0=172.24.0.2"
 * 字符串，导致 bridge 被漏判、给出「填 IP 就行」的错误建议。
 */
function classifyNetwork(addresses, tvIp, hasNat) {
  const prefix = String(tvIp).split('.').slice(0, 3).join('.');
  const sameSubnet = addresses.some(a => a.startsWith(prefix + '.'));
  const dockerOnly = addresses.some(a => /^172\.(1[6-9]|2\d|3[01])\./.test(a));
  return { prefix, sameSubnet, bridged: !sameSubnet && (dockerOnly || !!hasNat) };
}

/** 只给在线的电视截（90 秒内有心跳的，和 app.js 的在线窗口一致） */
const ONLINE_WINDOW_MS = 90 * 1000;
/** 压缩参数：最长边 960、质量 75，后台看画面足够 */
const SHOT_MAX_SIDE = 960;
const SHOT_QUALITY = 75;

let timer = null;
let busy = false;
const failStreak = new Map();   // 连续失败次数：只在第一次失败时记事件，别把日志刷爆

function shotsDir(deviceId) {
  return path.join(config.DATA_DIR, 'shots', deviceId);
}

/** 某台电视最新一张截图的路径（没有就 null） */
function latestShot(deviceId) {
  try {
    const files = fs.readdirSync(shotsDir(deviceId)).filter(f => f.endsWith('.jpg')).sort();
    return files.length ? path.join(shotsDir(deviceId), files[files.length - 1]) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 照片墙：全部保留的截图，按时间倒序（最新在前），最多 maxCount 张。
 * 文件名就是时间戳（captureNow 落盘 at + '.jpg'），直接从文件名取时间，不用读 mtime。
 */
function listShots(deviceId) {
  try {
    const dir = shotsDir(deviceId);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jpg'))
      .map(f => {
        const at = parseInt(f.slice(0, -4), 10);
        let size = 0;
        try { size = fs.statSync(path.join(dir, f)).size; } catch (e) {}
        return { at, size };
      })
      .filter(x => x.at > 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, maxCount());
  } catch (e) {
    return [];
  }
}

/** 按时间戳取某一张截图的路径（不存在就 null） */
function shotByTime(deviceId, at) {
  const t = parseInt(at, 10);
  if (!t) return null;
  const fp = path.join(shotsDir(deviceId), t + '.jpg');
  try { return fs.existsSync(fp) ? fp : null; } catch (e) { return null; }
}

/** 只按「最大张数」从旧到新删，超量的清掉；没有时间窗口 */
function prune(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg') || f.endsWith('.png')).sort(); } catch (e) { return; }
  // png 是旧格式残留，一并过期删除。按文件名（=时间戳）从旧到新排，多余的删掉
  const over = files.length - maxCount();
  files.forEach((f, i) => {
    if (i >= over) return;
    try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 下轮再删 */ }
  });
}

/**
 * 对一台电视立即截一次屏并落盘（自动轮询和手动「立即截图」共用）。
 * @returns {Promise<{at:number, size:number}>}
 */
async function captureNow(store, deviceId) {
  const d = store.getDevice(deviceId);
  if (!d) throw new Error('device not found');
  const ip = store.effectiveIp(d);
  if (!ip) throw new Error('没有可用的电视 IP（Docker 网桥下自动识别会拿到网关，请在后台手动指定电视 IP）');
  const png = await adb.adbExec(ip, adb.DEFAULT_PORT, 'screencap -p', { timeout: 20000 });
  if (!png || png.length < 8 || png.slice(0, 4).toString('hex') !== '89504e47') {
    throw new Error('截屏返回的不是 PNG（' + (png ? png.length : 0) + ' 字节）');
  }
  // PNG → 缩到 960 宽 → JPEG（1080p PNG 约 2.2MB，压完约 100KB）
  const dec = img.decodePng(png);
  const small = img.fit(dec.rgba, dec.width, dec.height, SHOT_MAX_SIDE);
  const jpg = img.encodeJpeg(small.rgba, small.width, small.height, SHOT_QUALITY);
  const dir = shotsDir(deviceId);
  fs.mkdirSync(dir, { recursive: true });
  const at = Date.now();
  fs.writeFileSync(path.join(dir, at + '.jpg'), jpg);
  d.shotAt = at;                  // 只放内存，给 overview 显示「最后截屏」用
  prune(dir);
  return { at, size: jpg.length, width: small.width, height: small.height };
}

async function captureOnce(store) {
  const targets = store.devicesList().filter(d =>
    store.effectiveIp(d) && Date.now() - d.lastSeen < ONLINE_WINDOW_MS);
  for (const d of targets) {
    if (!config.getScreenshotEnabled()) break;   // 中途被关掉就停手
    try {
      await captureNow(store, d.id);
      if (failStreak.get(d.id) > 0) {
        store.appendEvent({ type: 'shot_error', deviceId: d.id, error: '已恢复' });
      }
      failStreak.set(d.id, 0);
    } catch (e) {
      const n = (failStreak.get(d.id) || 0) + 1;
      failStreak.set(d.id, n);
      if (n === 1) {
        store.appendEvent({ type: 'shot_error', deviceId: d.id, error: String(e && e.message || e).slice(0, 120) });
      }
    }
  }
}

/**
 * 截图自检：把整条链路拆成能定位的步骤，失败时后台直接说清卡在哪一步。
 * 对 TCL 等电视实测通过（42938 字节 PNG → 20KB JPEG），所以服务端侧失败
 * 多半是「密钥没被电视授权」或「网络调试口不通」，自检会把这两项单独列出来。
 */
async function diagnose(store, deviceId, overrideIp) {
  const steps = [];
  let advice = '';
  const add = (name, ok, detail) => {
    steps.push({ name, ok: !!ok, detail: String(detail == null ? '' : detail) });
    return !!ok;
  };
  const done = ok => ({ ok: !!ok, steps, advice });

  const d = store.getDevice(deviceId);
  if (!add('设备记录', !!d, d ? d.id : 'device not found')) return done(false);
  const ip = overrideIp || store.effectiveIp(d);
  const nat = d.natIp || (store.isBridgeGateway(d.lastIp) ? d.lastIp : '');
  if (!ip) {
    const why = nat
      ? `请求来源被识别为 ${nat} —— 这是 Docker 网桥网关，不是电视 IP`
      : '电视还没上报过局域网 IP';
    advice = '→ 在下面「电视 IP」填电视的真实局域网地址（例如 192.168.1.73），点「保存并自检」。' +
      '这只是播种值，电视上报真实地址后会自动接管，换 IP 不用再改。';
    add('电视 IP', false, `${why}。请在「手动指定电视 IP」里填电视的地址（例如 192.168.1.73）`);
    return done(false);
  }
  const srcName = d.ipSource === 'reported' ? '电视上报，换 IP 自动同步'
    : d.fixedIp ? '后台手动指定，电视上报后自动接管' : '请求来源';
  add('电视 IP', true, `${ip}（${srcName}）` + (nat ? ` · 已排除 Docker 网关 ${nat}` : ''));

  const ki = adb.keyInfo();
  if (!add('adb 密钥', ki.valid, ki.valid
    ? `${ki.name || '未命名'} · 指纹 ${ki.fingerprint}${ki.generated ? ' · 管理端自动生成' : ''}`
    : 'data/adb_key.json 缺失或格式不对')) return done(false);
  if (ki.generated) {
    steps.push({ name: '建议', ok: true, detail: '这把钥匙是管理端自己生成的，电视没点过「允许 USB 调试」就会一直连不上；请上传电脑上已授权的 adbkey' });
  }

  const probe = await new Promise(resolve => {
    const t = Date.now();
    const s = net.createConnection({ host: ip, port: adb.DEFAULT_PORT });
    const finish = (ok, err) => {
      try { s.destroy(); } catch (e) {}
      resolve({ ok, err: err || '', ms: Date.now() - t });
    };
    // 电视内存紧张时 adbd 响应偏慢，给足 8 秒，避免把「慢」误判成「不通」
    s.setTimeout(8000);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false, 'ETIMEDOUT'));
    s.once('error', e => finish(false, String((e && e.code) || (e && e.message) || e)));
  });
  if (!add('网络调试口 5555', probe.ok, probe.ok
    ? `TCP 可连（${probe.ms}ms）`
    : `连不上 ${ip}:5555（${probe.err}，${probe.ms}ms）—— 检查：① 电视「网络 ADB」是否开着；② 这个 IP 是不是电视本身；③ 容器能否访问局域网`)) {
    // 把容器自己的网卡列出来，判断它到底在不在宿主机局域网里。
    // 注意 host 模式下也能看到 docker0 的 172.x，所以不能用「有没有 172.x」判断，
    // 要看「有没有和电视同网段的地址」：有 = host，没有且只有 Docker 私网 = bridge。
    const nics = [];
    const addresses = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of (list || [])) {
        if (a.family === 'IPv4' && !a.internal) {
          nics.push(`${name}=${a.address}`);
          addresses.push(a.address);
        }
      }
    }
    const net = classifyNetwork(addresses, ip, !!nat);
    const prefix = net.prefix;
    const bridged = net.bridged;

    advice = bridged
      ? `→ 电视 IP ${ip} 是对的（${srcName}），再填一次也没用，问题在容器网络：\n` +
        '   ① 用仓库里的 docker-compose.yml 覆盖宿主机上的部署目录' +
        '（已是 network_mode: host、去掉了 ports）；\n' +
        '   ② 在 Docker 里停止并重建 tvguard 项目（或执行 docker compose up -d --force-recreate）。⚠️ 只点「重启」不会换网络；\n' +
        `   ③ 再点「截图自检」：下面「容器网卡」出现 ${prefix}.x（宿主机地址）而不是 172.x.x.x 就是成了。\n` +
        '   data/ 卷不动，密钥 / 题库 / 设备记录 / 管理密码都会保留。'
      : '→ 容器已在宿主机网络栈，检查：① 电视「网络 ADB / 网络调试」开关；' +
        '② 宿主机防火墙有没有拦 5555；③ 电视与宿主机是不是同一个网段。';
    add('容器网络（根因）', false,
      `容器网卡：${nics.join(', ') || '无'}` +
      (bridged
        ? `。这是 Docker 私有网段，容器和电视不在同一网络（${prefix}.x），出站到电视被挡；` +
          '截图 / 离线唤醒 / 自动保活都会超时。必须把容器改成 host 网络并「重新构建」，' +
          '光改代码或改 IP 都解决不了。'
        : `。容器和电视同网段（${prefix}.x），网络层没被隔离，继续查电视的 ADB 开关与防火墙。`));
    return done(false);
  }

  let png;
  try {
    png = await adb.adbExec(ip, adb.DEFAULT_PORT, 'screencap -p', { timeout: 20000 });
  } catch (e) {
    advice = '→ 上传电脑上已授权的 adbkey（C:\\Users\\<你>\\.android\\adbkey 整份）到下面「同步 adb 密钥」，' +
      '不要在文本编辑器里手改文件。';
    add('ADB 授权 + screencap', false, String(e && e.message || e));
    return done(false);
  }
  const isPng = png && png.length >= 8 && png.slice(0, 4).toString('hex') === '89504e47';
  if (!add('ADB 授权 + screencap', isPng, isPng
    ? `${png.length} 字节 PNG`
    : `返回的不是 PNG（${png ? png.length : 0} 字节）`)) return done(false);

  try {
    const dec = img.decodePng(png);
    const small = img.fit(dec.rgba, dec.width, dec.height, SHOT_MAX_SIDE);
    const jpg = img.encodeJpeg(small.rgba, small.width, small.height, SHOT_QUALITY);
    add('PNG 解码 / JPEG 压缩', true, `${dec.width}×${dec.height} → ${small.width}×${small.height}，${jpg.length} 字节`);
  } catch (e) {
    add('PNG 解码 / JPEG 压缩', false, String(e && e.message || e));
    return done(false);
  }
  try {
    const dir = shotsDir(deviceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    add('截图目录可写', true, dir);
  } catch (e) {
    add('截图目录可写', false, String(e && e.message || e));
    return done(false);
  }
  return done(true);
}

function start(store) {
  if (timer) return;
  // 用 1 秒 tick + 上次截屏时间实现「间隔可配」：改配置立即生效，不用重启服务
  let lastAt = 0;
  let lastPrune = 0;
  timer = setInterval(() => {
    if (!config.getScreenshotEnabled()) {
      // 关着的时候只做轻量清理（30 秒一次）：把关开关之前留下的旧图按张数上限清掉
      if (Date.now() - lastPrune > 30 * 1000) {
        lastPrune = Date.now();
        for (const d of store.devicesList()) prune(shotsDir(d.id));
      }
      return;
    }
    if (Date.now() - lastAt < intervalMs()) return;
    lastAt = Date.now();
    if (busy) return;
    busy = true;
    captureOnce(store).catch(() => {}).finally(() => { busy = false; });
  }, 1000);
  timer.unref && timer.unref();
}

module.exports = {
  start, latestShot, listShots, shotByTime, captureNow, diagnose, classifyNetwork,
  intervalMs
};
