'use strict';

/**
 * TvGuard 管理服务：一台电视一个孩子的轻量后端。
 *
 * 只做三件事：
 *   1. 给电视下发策略（额度/间隔/奖励/难度）—— 家长在网页上改，电视端下次心跳就生效；
 *   2. 给电视下发题目 + 判题（题目不下发答案，提示可后台配置）；
 *   3. 收电视上报的观看时长和答题次数，做成网页上能看的统计。
 *
 * 零第三方依赖，只用 Node 标准库，镜像里没有 npm 依赖需要联网装。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const config = require('./config');
const store = require('./store');
const apkMod = require('./apk');
const quiz = require('./quiz');
const subjects = require('./subjects');
const keepalive = require('./keepalive');
const logfile = require('./logfile');
const screenshot = require('./screenshot');
const adb = require('./adb');

const PORT = config.PORT;
// 密码来源见 src/config.js：后台改过的 > 环境变量 > data 里记住的 > 默认 tvguard。
// 用函数取而不是启动时快照一个常量 —— 后台改密码后要立刻按新密码校验，不能等重启。
const ADMIN_PASSWORD = () => config.getAdminPassword();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 目标：家长在后台直接上传 zip，服务端自己解包、备份、覆盖、重启，不用去服务器上
// 一个个文件替换。零第三方依赖 —— 用 Node 内置 zlib 直接读 zip 中央目录。
//
// 安全边界（很重要）：
//   - 只接受 src/** 与 public/** 两种路径，且拒绝 .. / 绝对路径 / 盘符 / 反斜杠穿越；
//   - data/ 永远不碰（策略、题库、设备、密钥都在里面）；
//   - 根目录文件（docker-compose.yml、Dockerfile 等）忽略 —— 它们在宿主机上，
//     容器里改了也不会生效，需要动的时候仍由家长手工覆盖一次。
const zlib = require('zlib');
const APP_ROOT = path.join(__dirname, '..');
const UPGRADE_MAX = 12 * 1024 * 1024;

/** 当前构建标记：升级包里带 BUILD.json，解包后落进 data/（重启不丢） */
function readBuild() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'build.json'), 'utf8'));
  } catch (e) {
    return { build: '未标记（首次升级后显示）' };
  }
}

/**
 * 管理端版本号：优先用升级包里 BUILD.json 带的 version（跟着包走，回滚也准），
 * 老包没有这个字段就退回本机 package.json。根目录文件不参与升级覆盖，
 * 所以 package.json 只在整包部署时更新 —— 这正是要以 BUILD.json 为准的原因。
 */
function adminVersion(build) {
  const b = build || readBuild();
  if (b && b.version) return String(b.version);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch (e) { return ''; }
}

function lastUpgrade() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'last_upgrade.json'), 'utf8'));
  } catch (e) { return null; }
}

/**
 * 读 zip：找到 EOCD → 遍历中央目录 → 按本地头偏移取数据 → store 原样 / deflate 解压。
 * 支持 Windows 打包出来的反斜杠路径（统一成正斜杠），不依赖任何外部命令。
 */
function parseZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 包（找不到结束标记）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const meta = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('zip 中央目录损坏');
    }
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen).replace(/\\/g, '/');
    off += 46 + nameLen + extraLen + commentLen;
    meta.push({ name, method, csize, localOff });
  }
  const out = [];
  for (const e of meta) {
    if (e.name.endsWith('/') || /__MACOSX|\.DS_Store/.test(e.name)) continue;
    if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error('zip 数据损坏：' + e.name);
    const start = e.localOff + 30
      + buf.readUInt16LE(e.localOff + 26) + buf.readUInt16LE(e.localOff + 28);
    const raw = buf.slice(start, start + e.csize);
    let data = null;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('不支持的压缩方式（' + e.method + '）：' + e.name);
    out.push({ name: e.name, data });
  }
  return out;
}

/** 只允许写这两个目录；返回相对路径或 null（忽略） */
function upgradeRel(name) {
  const n = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!n || n.includes('..') || /^[A-Za-z]:/.test(n) || n.startsWith('/')) return null;
  if (n.startsWith('src/') || n.startsWith('public/')) return n;
  return null;
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
}

/**
 * 整份替换目录内容（不删目录本身 —— src/public 是 bind mount 挂载点，删不得）。
 * 只清空里面的文件再拷，避免升级后残留旧版本的多余文件。
 */
function replaceDir(from, to) {
  if (!fs.existsSync(from)) throw new Error('备份/暂存目录不存在：' + from);
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(to)) {
    fs.rmSync(path.join(to, name), { recursive: true, force: true });
  }
  fs.cpSync(from, to, { recursive: true, force: true });
}

function backupDirs() {
  const root = path.join(config.DATA_DIR, 'backup');
  try {
    return fs.readdirSync(root).filter(x => /^\d{4}-/.test(x)).sort().reverse();
  } catch (e) { return []; }
}

/** 备份目录总大小（给「最后一次备份」那行显示体积） */
function dirSize(root) {
  let n = 0;
  (function walk(dir) {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of list) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full);
      else { try { n += fs.statSync(full).size; } catch (e) { /* 忽略单个文件失败 */ } }
    }
  })(root);
  return n;
}

// 备份打包下载：不引第三方依赖，手写 store（不压缩）模式的 zip
// 备份只有 src/ + public/ 两份文本，几百 KB，压缩与否无所谓；能一键下载更重要。
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}
const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
const dosDate = d => ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate())) & 0xFFFF;

/** 把一个目录打成 zip Buffer（含子目录，UTF-8 文件名） */
function zipDir(root) {
  const entries = [];
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, r);
      else entries.push({ name: r, data: fs.readFileSync(full), mtime: st.mtime });
    }
  })(root, '');

  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const time = dosTime(e.mtime), date = dosDate(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flag: UTF-8 文件名
    local.writeUInt16LE(0, 8);             // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra len
    parts.push(local, nameBuf, e.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);          // local header offset
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + e.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/** 最近一次备份：名字、时间、体积（页面只显示这一份，可下载） */
function lastBackupInfo(last) {
  const dirs = backupDirs();
  if (!dirs.length) return null;
  const name = dirs[0];
  let at = 0, size = 0;
  try {
    const full = path.join(config.DATA_DIR, 'backup', name);
    at = fs.statSync(full).mtimeMs;
    size = dirSize(full);
  } catch (e) { /* 目录读不到就只显示名字 */ }
  // 目录 mtime 是「最后一次写文件」的时刻，可能和真正开始备份差几秒；
  // 有升级记录时就以当时记下的 backupAt 为准。
  if (last && last.backup === name && last.backupAt) {
    const t = Date.parse(last.backupAt);
    if (!Number.isNaN(t)) at = t;
  }
  return { name, at: Math.round(at), size };
}

/** 覆盖前先整份备份 src/ + public/，只留最近 3 份 */
function makeBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(config.DATA_DIR, 'backup', stamp);
  copyTree(path.join(APP_ROOT, 'src'), path.join(dir, 'src'));
  copyTree(path.join(APP_ROOT, 'public'), path.join(dir, 'public'));
  // 连同当前构建标记一起备份：回滚时恢复它，状态栏才不会变「未标记」、时间也不会错位
  try {
    const bj = path.join(config.DATA_DIR, 'build.json');
    if (fs.existsSync(bj)) fs.copyFileSync(bj, path.join(dir, 'build.json'));
  } catch (e) { /* 没有标记也能回滚 */ }
  const all = backupDirs();
  for (const old of all.slice(3)) {
    try { fs.rmSync(path.join(config.DATA_DIR, 'backup', old), { recursive: true, force: true }); }
    catch (e) { /* 老备份删不掉不影响升级 */ }
  }
  return stamp;
}

/**
 * 预检：解包到 data 暂存区 + 结构校验 + 全部 JS 语法校验。
 * 不碰任何正在运行的文件；失败就抛错。升级流程内部自动先跑这一步，不需要手动点。
 */
function precheckUpgrade(buf) {
  const all = parseZip(buf);
  const files = [];
  let build = null;
  for (const f of all) {
    if (f.name === 'BUILD.json') {
      try { build = JSON.parse(f.data.toString('utf8')); } catch (e) { /* 标记可有可无 */ }
      continue;
    }
    const rel = upgradeRel(f.name);
    if (rel) files.push({ rel, data: f.data });
  }
  const names = files.map(f => f.rel);
  if (!names.includes('src/app.js') || !names.includes('public/index.html')) {
    throw new Error('包里缺少 src/app.js 或 public/index.html —— 请上传完整的管理端升级包');
  }

  // ① 全部先落到 data/ 暂存区，绝不边解边覆盖正在运行的代码
  const stage = path.join(config.DATA_DIR, 'upgrade-staging');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const f of files) {
    const dest = path.join(stage, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }

  // ② 语法校验：新 app.js 有语法错会让容器崩溃循环、后台都打不开，必须挡在覆盖之前
  const { execFileSync } = require('child_process');
  for (const f of files.filter(x => x.rel.endsWith('.js'))) {
    try {
      execFileSync(process.execPath, ['--check', path.join(stage, f.rel)], { stdio: 'pipe' });
    } catch (e) {
      throw new Error('升级包语法错误（' + f.rel + '）：' + String(e.stderr || e.message).slice(0, 200));
    }
  }
  return { files, names, build, stage };
}

/** 顺序：预检 → 备份现状 → 覆盖 → 任一写入失败自动回滚 */
function applyUpgrade(buf) {
  const prep = precheckUpgrade(buf);
  const { names, build, stage } = prep;
  // 只读挂载时给一句人话提示，而不是让 fs.writeFileSync 抛 EROFS
  const probe = path.join(APP_ROOT, 'src', '.upgrade_probe');
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    throw new Error('代码目录是只读挂载，无法自升级：请按 INSTALL.txt 把 docker-compose.yml 里的 :ro 改成 :rw 后重建一次容器（只需做一次）');
  }

  // 升级前的状态 = 即将被备份的那一版。
  // 页面要能分清「备份里装的是旧版本」和「这次升上去的是新版本」，
  // 所以旧版本的构建标记、安装时间都要在覆盖前抓下来。
  const prev = lastUpgrade();
  const prevBuild = readBuild();
  const backupAt = new Date().toISOString();

  // ③ 备份现状（src + public 整份），再覆盖；中途抛错立刻用这份备份还原
  const stamp = makeBackup();
  try {
    replaceDir(path.join(stage, 'src'), path.join(APP_ROOT, 'src'));
    replaceDir(path.join(stage, 'public'), path.join(APP_ROOT, 'public'));
  } catch (e) {
    replaceDir(path.join(config.DATA_DIR, 'backup', stamp, 'src'), path.join(APP_ROOT, 'src'));
    replaceDir(path.join(config.DATA_DIR, 'backup', stamp, 'public'), path.join(APP_ROOT, 'public'));
    throw new Error('写入失败，已自动回滚：' + String(e.message || e));
  }

  const info = {
    at: new Date().toISOString(),        // 新版本装完的时刻（= 页面「最近一次升级」）
    backupAt,                            // 备份旧版本的那一刻（= 页面「最后一次备份」）
    backup: stamp,
    files: names.length,
    build: (build && build.build) || '未标记',
    fromBuild: (prevBuild && prevBuild.build) || '未标记',   // 备份里的版本
    fromAt: (prev && prev.at) || null,                       // 那个版本是什么时候装上的
  };
  fs.writeFileSync(path.join(config.DATA_DIR, 'last_upgrade.json'), JSON.stringify(info, null, 2));
  if (build) fs.writeFileSync(path.join(config.DATA_DIR, 'build.json'), JSON.stringify(build, null, 2));
  store.appendEvent({ type: 'server_upgrade', files: names.length, build: info.build, backup: stamp });
  return { ...info, list: names };
}

/**
 * 回滚到「最近一次升级前的备份」（即撤销最近一次升级，可来回切换）。
 * 关键：回滚目标必须是升级时生成的备份（last_upgrade.backup），而不是 backupDirs()[0]——
 * 因为 backupDirs 降序、[0] 是最新的，而回滚前我们又会 makeBackup 生成一份「现状备份」，
 * 用 [0] 会指向刚生成的现状，等于没回滚。
 */
function rollbackUpgrade() {
  const rec = lastUpgrade();
  const target = rec && rec.backup;
  if (!target || !fs.existsSync(path.join(config.DATA_DIR, 'backup', target))) {
    throw new Error('找不到可回滚的备份（没有升级记录，或备份已被清理）');
  }
  const dir = path.join(config.DATA_DIR, 'backup', target);
  const prevBuild = readBuild();
  const backupAt = new Date().toISOString();
  const stamp = makeBackup();  // 回滚前先留一份现状，方便再切回去
  replaceDir(path.join(dir, 'src'), path.join(APP_ROOT, 'src'));
  replaceDir(path.join(dir, 'public'), path.join(APP_ROOT, 'public'));
  // 恢复被回滚到的那版的构建标记（含 version / packedAt），状态栏才不会变「未标记」，
  // 构建时间也跟着回到那个版本的真实构建时间（按浏览器本地时区显示，即北京时间）。
  try {
    const bj = path.join(dir, 'build.json');
    if (fs.existsSync(bj)) fs.copyFileSync(bj, path.join(config.DATA_DIR, 'build.json'));
  } catch (e) { /* 老备份没有 build.json，维持现状 */ }
  fs.writeFileSync(path.join(config.DATA_DIR, 'last_upgrade.json'),
    JSON.stringify({
      at: new Date().toISOString(), rollback: target,
      backupAt, backup: stamp,   // 指向回滚前生成的现状备份：下次回滚就切回它
      fromBuild: (prevBuild && prevBuild.build) || '未标记',
      fromAt: (rec && rec.at) || null,
    }, null, 2));
  store.appendEvent({ type: 'server_rollback', backup: target });
  return { backup: target };
}

/**
 * 容器内自重启：exit(0) 后靠 compose 的 restart: unless-stopped 自动拉起，新代码生效。
 * 本地测试可用 TVG_NO_RESTART=1 关掉。
 */
function scheduleRestart() {
  if (process.env.TVG_NO_RESTART === '1') return;
  setTimeout(() => process.exit(0), 1200);
}

/** 升级页内嵌在 app.js 里：引导阶段只替换这一个文件，就能拿到完整升级入口 */
const UPGRADE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理端升级 · 守时桌面</title>
<style>
:root{--bg:#14171C;--card:#232830;--ink:#F5F7FA;--ink2:#B4BECC;--ink3:#7D8794;--line:#39414D;
--brand:#4C8DFF;--ok:#4ADE80;--warn:#FBBF24;--bad:#F87171}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:28px 20px 80px}
header{display:flex;align-items:center;gap:14px;margin-bottom:24px}
.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#4C8DFF,#7C5CFF);
display:grid;place-items:center;font-size:19px;font-weight:700}
h1{font-size:20px;margin:0;font-weight:650}.sub{color:var(--ink3);font-size:13px}
a{color:#6EA8FF;text-decoration:none}.spacer{flex:1}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px}
h2{font-size:16px;margin:0 0 14px;font-weight:640}
.row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed var(--line)}
.row:last-child{border-bottom:0}.k{color:var(--ink3)}.v{text-align:right;word-break:break-all}
button{font:inherit;border:0;border-radius:9px;padding:9px 16px;cursor:pointer;color:#fff;background:var(--brand)}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--ink2)}
button.warn{background:#7A4A12;color:#FFE9BE;border:1px solid #B07830}
button:disabled{opacity:.5;cursor:not-allowed}
input[type=file]{display:block;width:100%;padding:12px;border:1px dashed var(--line);border-radius:9px;color:var(--ink2);margin-bottom:14px}
.btns{display:flex;gap:10px;flex-wrap:wrap}
#status{margin-top:14px;padding:12px 14px;border-radius:9px;background:#1B1F26;color:var(--ink2);
font-size:13px;white-space:pre-wrap;min-height:42px}
.good{color:var(--ok)}.bad{color:var(--bad)}.dim{color:var(--ink3)}
ul{padding-left:20px;color:var(--ink2);font-size:13px;margin:8px 0 0}
</style></head><body><div class="wrap">
<header><div class="logo">守</div><div><h1>管理端升级</h1></div>
<div class="spacer"></div><a href="/">← 返回管理端</a></header>

<div class="card"><h2>当前状态</h2>
<div class="row"><span class="k">管理端版本</span><span class="v" id="ver">读取中…</span></div>
<div class="row"><span class="k">构建时间</span><span class="v" id="build">读取中…</span></div>
<div class="row"><span class="k">最近一次升级</span><span class="v" id="last">—</span></div></div>

<div class="card"><h2>上传升级包（.zip）</h2>
<input type="file" id="file" accept=".zip,application/zip">
<div class="btns">
<button id="btnUpgrade">备份并升级</button></div>
<div id="status">选择一个升级包，点「备份并升级」开始；升级前会自动备份当前版本。</div>
</div>

<div class="card"><h2>备份与回滚</h2>
<div class="row"><span class="k">最后一次备份</span><span class="v" id="backup">—</span></div>
<div class="row"><span class="k">备份内容</span><span class="v dim" id="backupSrc">—</span></div>
<div class="btns" style="margin-top:14px">
<button id="btnRollback" class="warn">回滚上一版</button></div>
</div>
</div>
<script>
function q(id){return document.getElementById(id)}
function say(t,cls){var e=q('status');e.textContent=t;e.className=cls||''}
function pad(n){return (n<10?'0':'')+n}
/* 时间可能是 ISO 带时区，也可能是打包机写的「YYYY-MM-DD HH:MM:SS」；
   后者各家浏览器解析不一致，这里统一手动拆（不带时区就按本地时间）。
   注意：这段在模板字符串里，正则里的反斜杠要写两个，否则发到页面就成了 d{4}。 */
function parseAt(v){ if(v===null||v===undefined||v==='') return null;
  var d;
  if(typeof v==='number') d=new Date(v);
  else d=new Date(String(v));   // JS 原生解析：ISO（含 Z / +08:00 偏移）与本地串都按本地时区还原
  return isNaN(d.getTime())?null:d }
function fmtAt(v){ var d=parseAt(v); if(!d) return v==null?'—':String(v);
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '
    +pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds()) }
/* 构建标记可能是时间串或一句说明，含日期片段就按本地时区格式化，否则原样 */
function fmtBuild(v){ if(!v) return ''; var s=String(v);
  return /\\d{4}-\\d{2}-\\d{2}/.test(s)?fmtAt(s):s }
function fmtSize(n){ n=Number(n)||0; if(n<1024) return n+' B';
  if(n<1048576) return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(2)+' MB' }
function loadInfo(){return fetch('/api/admin/upgrade/info',{cache:'no-store'}).then(function(r){
  if(r.status===401){location.href='/';throw new Error('未登录')}
  return r.json()}).then(function(d){
  q('ver').textContent=d.version?'v'+d.version:'未标记';
  q('build').textContent=(d.build.packedAt||d.build.build)?fmtBuild(d.build.packedAt||d.build.build):'未标记';
  var L=d.last;
  if(!L){q('last').textContent='尚无升级记录';q('last').title=''}
  else{
    /* 字面意思就是一个时间：明细（升级到哪个构建、多少文件、是否回滚）收进悬停提示 */
    q('last').textContent=fmtAt(L.at);
    q('last').title=L.rollback?('回滚到上一版本 · 回滚于 '+fmtAt(L.at))
      :(L.build?'升级到 '+fmtBuild(L.build):'')+(L.files?' · '+L.files+' 个文件':'');
  }
  var b=d.lastBackup;
  q('backup').innerHTML=b
    ? fmtAt(b.at)+' · '+fmtSize(b.size)+' <a href="/api/admin/upgrade/backup?name='
      +encodeURIComponent(b.name)+'">下载</a>'
    : '暂无（升级时自动创建）';
  q('backupSrc').textContent=!b?'—'
    :(L&&L.backup===b.name)
      ?(L.fromBuild&&!/未标记/.test(L.fromBuild)
          ?'升级前的版本 · 构建 '+fmtBuild(L.fromBuild)+(L.fromAt?' · 安装于 '+fmtAt(L.fromAt):'')
          :'升级前的版本（首装，无构建标记）')
      :'升级前的版本（无对应升级记录）';
  return d})}
function file(){var f=q('file').files[0];if(!f){alert('请先选择 .zip 升级包');return null}return f}
function post(url,body){return fetch(url,{method:'POST',body:body,
  headers:{'Content-Type':'application/octet-stream'}}).then(function(r){return r.json()})}
function busy(on){['btnUpgrade','btnRollback'].forEach(function(x){q(x).disabled=on})}
function waitRestart(oldAt){
  say('升级完成，服务正在重启…','good');busy(true);
  var n=0;var t=setInterval(function(){
    n++;
    fetch('/api/admin/upgrade/info',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
      if(d.last&&d.last.at!==oldAt){clearInterval(t);busy(false);location.reload()}
    }).catch(function(){});
    if(n>30){clearInterval(t);busy(false);say('服务还没回来，请稍后手动刷新页面。','bad')}
  },1500)}
q('btnUpgrade').onclick=function(){var f=file();if(!f)return;
  if(!confirm('将先自动备份当前版本，升级后自动重启服务。继续？'))return;
  busy(true);say('正在升级…');
  loadInfo().then(function(d){var old=d.last?d.last.at:'';
    return post('/api/admin/upgrade',f).then(function(r){
      if(!r.ok)throw new Error(r.error||'升级失败');
      waitRestart(old)})}).
    catch(function(e){busy(false);say(e.message||'升级失败','bad')})};
q('btnRollback').onclick=function(){if(!confirm('用最近一份备份覆盖回当前版本，并重启服务。继续？'))return;
  busy(true);say('正在回滚…');
  post('/api/admin/upgrade/rollback',new Uint8Array(0)).then(function(d){
    if(!d.ok)throw new Error(d.error||'回滚失败');say('已回滚，服务正在重启…','good');
    setTimeout(function(){location.reload()},6000)
  }).catch(function(e){busy(false);say(e.message||'回滚失败','bad')})};
loadInfo().catch(function(e){say('状态读取失败：'+e.message,'bad')});
</script></body></html>`;


// 电视端按各自心跳间隔（默认 5 秒）上报心跳；在线口径由 store.offlineWindowMs 按设备心跳判定，不再用全局常量

// session 密钥由密码派生：改密码会让旧 cookie 全部失效，重启不影响登录态
let SECRET = deriveSecret();
function deriveSecret() {
  return crypto.createHash('sha256').update('tvguard.admin.' + ADMIN_PASSWORD()).digest('hex');
}

quiz.ensureSeed();

// 电视端 APK 的收发包（data/apk/，最新 + 3 个历史版本）
const apkStore = apkMod.init(config.DATA_DIR);

// 电视画面自动截屏（后台可开关，默认关；只给在线的电视截，保留张数由后台配置）
screenshot.start(store);
// 离线自动唤醒：电视端 App 被杀导致心跳断时，adb am start 拉回前台
keepalive.startWatcher(store);
// 运行日志按天归档：每天 00:05 把昨天的详细日志写成文件，写完从实时日志删掉
logfile.init(config.DATA_DIR, ev => store.appendEvent(ev));
logfile.start();

/** 请求来源的 IPv4（电视上报的来源就是电视自己的 IP，自动修复靠它 adb 过去） */
function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end(buf);
}

function readBody(req, limit) {
  limit = limit || 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function readBinary(req, limit) {
  limit = limit || 120 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('文件太大了（上限 ' + Math.round(limit / 1024 / 1024) + 'MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) {  // 防目录穿越
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      // 内网管理端，文件才几十 KB：一律不缓存。
      // 否则「服务端升级」换了 js，浏览器还在用旧脚本，改完看着像没生效。
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

function hmac(s) {
  return crypto.createHmac('sha256', SECRET).update(s).digest('hex').slice(0, 32);
}

function issueToken() {
  // 有效期走 config.getSessionHours()（默认 12 小时，后台可改）：当天有效，第二天要重新登录。
  // token 组成：v2.<过期时间戳>.<签名>，签名里带上 sessionEpoch ——
  // 改有效期时 epoch +1，旧 token 的签名对不上 → 一次性作废，其它设备的登录态被强制刷新。
  const exp = Date.now() + config.getSessionHours() * 3600 * 1000;
  return 'v2.' + exp + '.' + hmac('v2.' + exp + '.' + config.getSessionEpoch());
}

function validToken(token) {
  if (!token) return false;
  const m = /^v2\.(\d+)\.([0-9a-f]+)$/.exec(String(token));
  if (!m) return false;   // 老格式（30 天）：直接判无效
  if (Number(m[1]) < Date.now()) return false;
  const expect = hmac('v2.' + m[1] + '.' + config.getSessionEpoch());
  return expect.length === m[2].length &&
    crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(m[2]));
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAdmin(req) {
  return validToken(parseCookies(req)['tg_session']);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method;

  if (method === 'OPTIONS') { json(res, 204, {}); return; }

  try {
    // ---------- 电视端 ----------
    if (p === '/api/v1/ping') {
      return json(res, 200, { ok: true, ts: Date.now(), version: '1.0.0' });
    }

    if (p === '/api/v1/device/register' && method === 'POST') {
      const body = await readBody(req);
      const id = body.deviceId || body.device_id;
      if (!id) return json(res, 400, { error: 'deviceId required' });
      const d = store.touchDevice(id, body);
      store.setDeviceIp(id, clientIp(req), body.localIp);
      store.appendEvent({ type: 'register', deviceId: id, model: body.model });
      return json(res, 200, {
        ok: true,
        name: d.name,
        policy: store.effectivePolicy(id),
        questions: quiz.stats()
      });
    }

    if (p === '/api/v1/device/policy' && method === 'GET') {
      const id = q.get('deviceId');
      if (!id) return json(res, 400, { error: 'deviceId required' });
      // 走 touchDevice 而不是直接读：跨天后统计要先滚到「今天」，否则这里会把昨天的用量当今天返回
      const d = store.touchDevice(id, {});
      return json(res, 200, {
        policy: store.effectivePolicy(id),
        usedTodayMs: d ? d.stats.watchedMs : 0,
        day: store.today(),
        serverTime: Date.now()
      });
    }

    // 一次拿全：策略 + 时段状态 + 今日用量 + 组进度。电视端 30 秒轮询这一个接口就够了。
    if (p === '/api/v1/device/session' && method === 'GET') {
      const id = q.get('deviceId');
      if (!id) return json(res, 400, { error: 'deviceId required' });
      const prevVersion = (store.getDevice(id) || {}).appVersion || '';
      const d = store.touchDevice(id, { model: q.get('model'), appVersion: q.get('v') });
      // 电视自己读到的局域网 IP 最可信：Docker bridge 下 clientIp(req) 只是网桥网关
      store.setDeviceIp(id, clientIp(req), q.get('localIp'));
      const pol = store.effectivePolicy(id);
      // 升级检测：上报的版本号和上次不一样 = 刚装完新包。升级后无障碍/管理员最容易掉，
      // 立刻触发一次保活修复（绕过冷却），电视端下一轮上报就会把真实状态带回来。
      const used = d.stats ? d.stats.watchedMs : 0;
      const limitMs = pol.dailyLimitMin * 60000;
      const bonusMs = (d.stats && d.stats.bonusMs) || 0;
      return json(res, 200, {
        ok: true,
        serverTime: Date.now(),
        // 服务端认定的「今天」：电视端拿它做跨天重置的最终依据（电视时钟不准也不会算错账）
        day: store.today(),
        device: { id: d.id, name: d.name },
        policy: pol,
        schedule: store.scheduleState(id),
        usage: {
          watchedMs: used,
          limitMs,
          // 答题换来的时长也算进今日可用总量里，电视端只认 remainingMs
          bonusMs,
          totalMs: limitMs + bonusMs,
          remainingMs: Math.max(0, limitMs + bonusMs - used),
          quizCount: d.stats.quizCount,
          passCount: d.stats.passCount
        },
        // 时长用完后的答题奖励：stage = off / open / exhausted
        reward: store.rewardState(id),
        group: pol.quizMode === 'group' ? store.groupState(id) : null,
        // 启动项：电视开机/打开 App 后直奔这个应用；null = 显示守时桌面
        launch: d.launchPkg
          ? { pkg: d.launchPkg, label: ((d.apps || []).find(a => a.pkg === d.launchPkg) || {}).label || '' }
          : null,
        // 设备管理员：active = 电视上报的真实状态；cmd = 后台刚下发、还没执行的动作
        admin: store.adminState(id),
        // 留言栏：家长在后台写的一句话，电视在看节目时用悬浮弹框盖出来（按 id 记已读）
        // 定时到天的留言还没到期就不下发，后台仍能看到、能改
        notice: store.activeNotice,
        // 心跳间隔（秒）：读这台设备自己配的，没配过用全局默认（5 秒）；一台管理端管多台电视，每台独立
        heartbeatSec: (d.heartbeatSec || config.DEFAULT_HEARTBEAT_SEC)
      });
    }

    // 电视上报已装应用清单：家长装了新软件，后台点一下「同步」就能看到并设为启动项
    if (p === '/api/v1/device/apps' && method === 'POST') {
      const body = await readBody(req);
      const id = body.deviceId;
      if (!id) return json(res, 400, { error: 'deviceId required' });
      store.touchDevice(id, {});
      store.setDeviceIp(id, clientIp(req), body.localIp);
      const d = store.setApps(id, body.apps);
      store.appendEvent({ type: 'apps_sync', deviceId: id, count: d ? d.apps.length : 0 });
      return json(res, 200, { ok: true, count: d ? d.apps.length : 0, launchPkg: d ? d.launchPkg : '' });
    }

    if (p === '/api/v1/quiz' && method === 'GET') {
      const deviceId = q.get('deviceId') || 'unknown';
      // 出题范围（年级/学科/难度）以后台策略为准；这三个 query 只用于排查时临时覆盖
      const question = quiz.nextQuestion(deviceId, {
        level: q.get('level'),
        grade: q.get('grade'),
        subject: q.get('subject'),
        exclude: (q.get('exclude') || '').split(',').filter(Boolean)
      });
      if (!question) return json(res, 503, { error: 'no question available' });
      store.appendEvent({
        type: 'quiz_served', deviceId, qid: question.id,
        subject: question.subject, grade: question.grade, level: question.level
      });
      return json(res, 200, question);
    }

    if (p === '/api/v1/quiz/answer' && method === 'POST') {
      const body = await readBody(req);
      const deviceId = body.deviceId || 'unknown';
      // 没走过 session 的设备（比如刚换机、清过数据）也要能判题和记统计
      store.touchDevice(deviceId, {});
      const r = quiz.checkAnswer(body.qid, body.choice);

      store.appendEvent({
        type: 'quiz_answer',
        deviceId,
        qid: body.qid,
        subject: r.subject,
        choice: Array.isArray(body.choice) ? body.choice.join('|') : body.choice,
        correct: r.correct
      });
      if (r.missing) return json(res, 404, { error: 'question not found' });

      const pol = store.effectivePolicy(deviceId);

      // 错题本 + 题目维度统计：答错记一次，答对累计连对；
      // qstats 另记答对次数，出题时用来把「答对过的题」的出现概率压下去
      if (r.correct) store.markRight(body.qid);
      else store.markWrong(body.qid, r.subject);
      store.markAnswered(body.qid, r.correct);

      let group = null;
      // 答题只做「把关」，不再发放观看时长 —— 每天能看多久只由 dailyLimitMin 决定。
      // pass 告诉电视端这一轮能不能放行：
      //   单题模式 = 答对即放行；
      //   整组模式 = 答满一组且正确率达标才放行（否则接着答下一组）。
      let pass = !!r.correct;

      if (pol.quizMode === 'group') {
        const g = store.advanceGroup(deviceId, r.correct, r.stars);
        group = { asked: g.asked, size: g.size, correct: g.correct, finished: g.finished, rate: g.rate };
        pass = g.finished && g.rate >= pol.groupPassRate;
      }

      // 电视端把"上次上报之后又看了多久"随判题一起带上来，省掉一次独立上报请求。
      // 必须放在奖励结算之前 —— 否则刚看完的那段时间还没算进今日用量，
      // 「额度用完」的判定会晚一步，奖励就会被提前发放。
      const delta = Number(body.watchedMsDelta) || 0;
      /**
       * 顺便把「今日累计绝对值」也入账。
       *
       * 增量是心跳送的，而心跳比孩子点答题慢半拍 —— 电视本地刚用完额度那一秒，
       * 服务端账上还差最后几秒，`rewardState` 就会判成 `normal`，
       * 于是「答对第一题算不算进度」被判成不算，孩子白答一题。
       * 带上绝对值让服务端当场校准（只认更大的值，不会重复累加）。
       */
      const total = Number(body.watchedMsTotal) || 0;
      if (delta > 0 || total > 0) {
        store.report(deviceId, { watchedMsDelta: delta, watchedMsTotal: total, day: body.day });
      }

      const dev = store.getDevice(deviceId);
      if (dev && dev.stats) {
        dev.stats.quizCount = (dev.stats.quizCount || 0) + 1;
        if (r.correct) dev.stats.passCount = (dev.stats.passCount || 0) + 1;
      }

      // 时长用完之后的答题换时间（policy.rewardEnabled 打开才生效）。
      // grantedMin > 0 表示这一题正好凑满 N 题、刚发放了一次奖励。
      const reward = store.settleReward(deviceId, r.correct);
      const rewardMinutes = reward.grantedMin || 0;

      return json(res, 200, {
        correct: r.correct,
        pass,
        answer: r.answer,
        explanation: r.explanation,
        subject: r.subject,
        type: r.type,
        stars: r.stars,
        rewardMinutes,
        reward,
        group,
        policy: pol
      });
    }

    if (p === '/api/v1/report' && method === 'POST') {
      const body = await readBody(req);
      const id = body.deviceId;
      if (!id) return json(res, 400, { error: 'deviceId required' });
      const d = store.report(id, body);
      store.setDeviceIp(id, clientIp(req), body.localIp);
      // 心跳顺带捎上「设备管理员开没开」：这是状态唯一的来源，
      // 后台那两个按钮点下去之后，就等这个值回来才算真的生效
      const admin = typeof body.adminActive === 'boolean'
        ? store.setAdminState(id, body.adminActive, body.adminAckAt, body.adminError)
        : store.adminState(id);
      // 无障碍状态：桌面拦截靠它，后台要能看见
      if (typeof body.a11yOn === 'boolean') store.setA11y(id, body.a11yOn);
      // 无障碍没开就顺手补：网络调试开着、和管理端同一局域网时直接 adb 开启，
      // 失败冷 10 分钟再试。不 await —— adb 回包可能几十秒，绝不能拖慢心跳。
      if (body.a11yOn === false) keepalive.maybeAutoFix(store, id).catch(() => {});
      // 新架构：不再在 /report 里自动触发「保活修复」。长连接断了由 watcher 立即拉起客户端，
      // 拉起成功后会顺手把无障碍/设备管理员补回来（见 keepalive.attemptRevive），无需这里再触发。
      return json(res, 200, {
        ok: true,
        policy: store.effectivePolicy(id),
        usedTodayMs: d.stats.watchedMs,
        admin,
        serverTime: Date.now()
      });
    }

    /**
     * 电视端「家长验证」：按主页/返回想离开守时桌面时，要输一次管理密码。
     *
     * 永远返回 200，用 body.ok 表示对错 —— 电视端的 HTTP 客户端把非 2xx 一律当网络失败，
     * 那样「密码错」会被误判成「连不上管理端」，按离线放行规则就直接放人了。
     */
    if (p === '/api/v1/device/unlock' && method === 'POST') {
      const body = await readBody(req);
      const id = body.deviceId || 'unknown';
      store.touchDevice(id, {});
      const ok = String(body.password || '').trim() === ADMIN_PASSWORD();
      store.appendEvent({ type: ok ? 'unlock_ok' : 'unlock_failed', deviceId: id });
      return json(res, 200, { ok });
    }

    // ---------- 管理端 ----------
    if (p === '/api/admin/login' && method === 'POST') {
      const body = await readBody(req);
      if (String(body.password || '') !== ADMIN_PASSWORD()) {
        store.appendEvent({ type: 'login_failed', ip: req.socket.remoteAddress });
        return json(res, 401, { error: '密码不对' });
      }
      const token = issueToken();
      res.setHeader('Set-Cookie',
        `tg_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(config.getSessionHours() * 3600)}`);
      store.appendEvent({ type: 'login', ip: req.socket.remoteAddress });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/logout' && method === 'POST') {
      res.setHeader('Set-Cookie', 'tg_session=; Path=/; HttpOnly; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/me') {
      // sessionHours 给登录页显示「登录后多久免密」，不是敏感信息
      return json(res, 200, { loggedIn: isAdmin(req), sessionHours: config.getSessionHours() });
    }

    // 以下全部需要登录
    if (p.startsWith('/api/admin/') && !isAdmin(req)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    // 已登录才能查当前密码：家长忘了密码但浏览器还留着登录态时，能自己找回来
    if (p === '/api/admin/password' && method === 'GET') {
      return json(res, 200, {
        password: ADMIN_PASSWORD(),
        source: config.getPasswordSource(),
        weak: config.isWeakPassword(),
        configFile: config.CONFIG_FILE,
        memoFile: config.PASSWORD_FILE,
        // 登录有效期（小时）：前端文案直接用它，别在页面上写死 12
        sessionHours: config.getSessionHours()
      });
    }

    /**
     * 改管理密码。
     *
     * 必须带当前密码：浏览器可能开着没锁屏，孩子随手点进来改掉密码就麻烦了。
     * 改完立刻换一份 session 密钥（派生自密码），本机重新签发 cookie 保持登录，
     * 其它设备上的登录态自动失效 —— 密码换了，别人不该还挂着。
     */
    if (p === '/api/admin/password' && method === 'POST') {
      const body = await readBody(req);
      const cur = String(body.currentPassword || '');
      const next = String(body.newPassword || '').trim();
      if (cur !== ADMIN_PASSWORD()) {
        store.appendEvent({ type: 'password_change_failed', ip: req.socket.remoteAddress });
        return json(res, 400, { error: '当前密码不对' });
      }
      if (next.length < 6) return json(res, 400, { error: '新密码至少 6 位' });
      if (next.length > 64) return json(res, 400, { error: '新密码最多 64 位' });
      if (next === cur) return json(res, 400, { error: '新密码和当前密码一样' });
      try {
        config.setAdminPassword(next);
      } catch (e) {
        return json(res, 500, { error: '保存失败：' + (e && e.message || e) });
      }
      SECRET = deriveSecret();
      const token = issueToken();
      res.setHeader('Set-Cookie',
        `tg_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(config.getSessionHours() * 3600)}`);
      store.appendEvent({ type: 'password_changed', ip: req.socket.remoteAddress });
      return json(res, 200, {
        ok: true, password: ADMIN_PASSWORD(), source: config.getPasswordSource(),
        sessionHours: config.getSessionHours()
      });
    }

    /**
     * 登录有效期（小时）：后台可改，改完写进 data 卷持久化、重启不丢。
     * 改的时候 epoch 会 +1，旧 token 全部失效 → 本人这里顺手重新签发保持登录，
     * 其它设备上还挂着的管理端会被强制重新登录，改动立刻全网生效。
     */
    if (p === '/api/admin/session' && method === 'GET') {
      return json(res, 200, {
        hours: config.getSessionHours(),
        epoch: config.getSessionEpoch(),
        min: 0.1, max: 720
      });
    }
    if (p === '/api/admin/session' && method === 'POST') {
      const body = await readBody(req);
      const raw = Number(body.hours);
      if (!Number.isFinite(raw)) return json(res, 400, { error: '请输入有效的小时数' });
      if (raw < 0.1 || raw > 720) return json(res, 400, { error: '有效期需在 0.1 ~ 720 小时之间' });
      const r = config.setSessionHours(raw);
      const token = issueToken();
      res.setHeader('Set-Cookie',
        `tg_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(config.getSessionHours() * 3600)}`);
      store.appendEvent({ type: 'session_hours_changed', hours: raw });
      return json(res, 200, { ok: true, hours: r.hours });
    }

    // 保活 / 唤醒 / 心跳参数：后台可配，保存即时生效（无需重启）
    if (p === '/api/admin/overview' && method === 'GET') {
      const now = Date.now();
      const devices = store.devicesList().map(d => {
        const pol = store.effectivePolicy(d.id);
        return {
          id: d.id,
          name: d.name,
          model: d.model,
          appVersion: d.appVersion,
          firstSeen: d.firstSeen,
          lastSeen: d.lastSeen,
          // 在线口径：超过「自己心跳间隔的 2 倍」没心跳才按离线算（每台独立，一对多）
          online: now - d.lastSeen < store.offlineWindowMs(d),
          onlineWindowMs: store.offlineWindowMs(d),
          override: d.override || {},
          policy: pol,
          stats: d.stats,
          // 启动项：家长在设备卡里挑一个应用，电视每次打开就直奔它
          launchPkg: d.launchPkg || '',
          apps: d.apps || [],
          appsAt: d.appsAt || 0,
          grantMs: ((d.stats && d.stats.bonusMs) || 0),
          remainingMs: Math.max(
            0,
            pol.dailyLimitMin * 60000 + ((d.stats && d.stats.bonusMs) || 0) - (d.stats ? d.stats.watchedMs : 0)
          ),
          // 答题换时长的进度：用了几次 / 还能用几次 / 这一轮攒了几题
          reward: store.rewardState(d.id),
          // 设备管理员：保活的关键，设备卡上要能看到到底开没开
          admin: store.adminState(d.id),
          // 无障碍：桌面拦截完全依赖它，没开的时候后台要明确提示
          a11y: { on: !!d.a11yOn, at: d.a11yAt || 0 },
          // 保活自动修复：实际用于 adb 的 IP + 最近一次自动修复的结果
          ip: store.effectiveIp(d),
          lastIp: d.lastIp || '',
          fixedIp: d.fixedIp || '',
          natIp: d.natIp || '',
          ipSource: d.ipSource || '',
          // 心跳间隔（秒）：设备卡输入框要回显当前值，漏了这个字段的话
          // 每次重渲染都会显示兜底 5，家长会以为 30 没存上
          heartbeatSec: d.heartbeatSec || 5,
          fix: { at: d.fixAt || 0, ok: !!d.fixOk, error: d.fixError || '', target: d.fixTarget || '' },
          revive: { at: d.reviveAt || 0, ok: !!d.reviveOk, error: d.reviveError || '' }
        };
      });
      return json(res, 200, {
        serverTime: now,
        policy: store.policy,
        // 留言栏当前内容：后台卡片要回显「电视上正在显示什么」
        notice: store.notice,
        devices,
        // 题量按「当前生效的出题范围」统计，和电视端实际能抽到的池子一致
        subjects: quiz.subjectMeta(store.policy.quizGrade, store.policy.difficulty, store.policy.quizIncludeGeneral),
        types: quiz.TYPES.map(t => ({ key: t, name: quiz.TYPE_NAMES[t] })),
        bank: quiz.stats(),
        wrong: { total: store.wrongList().length, bySubject: store.wrongCountBySubject() }
      });
    }

    // 错题本：列表 / 移出
    if (p === '/api/admin/wrong' && method === 'GET') {
      const subject = q.get('subject');
      let list = store.wrongList();
      if (subject && subject !== 'all') list = list.filter(x => x.subject === subject);
      return json(res, 200, { total: list.length, items: list, bySubject: store.wrongCountBySubject() });
    }

    if (p.startsWith('/api/admin/wrong/') && method === 'DELETE') {
      const qid = decodeURIComponent(p.slice('/api/admin/wrong/'.length));
      if (!store.dropWrong(qid)) return json(res, 404, { error: 'not in wrong book' });
      return json(res, 200, { ok: true, total: store.wrongList().length });
    }

    if (p === '/api/admin/policy' && method === 'PUT') {
      const body = await readBody(req);
      return json(res, 200, { policy: store.savePolicy(body) });
    }

    if (p.startsWith('/api/admin/device/') && method === 'PUT') {
      const id = decodeURIComponent(p.slice('/api/admin/device/'.length));
      const body = await readBody(req);
      const d = store.updateDevice(id, body);
      if (!d) return json(res, 404, { error: 'device not found' });
      return json(res, 200, {
        device: { id: d.id, name: d.name, override: d.override, launchPkg: d.launchPkg || '', apps: d.apps || [] }
      });
    }

    // 删除设备：测试条目 / 换掉的电视，列表里不再出现的都清掉
    if (p.startsWith('/api/admin/device/') && method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/admin/device/'.length));
      if (!store.getDevice(id)) return json(res, 404, { error: 'device not found' });
      store.removeDevice(id);
      // 顺带把它的截图目录清了（没截过图就没有这个目录，force 跳过）
      try { fs.rmSync(path.join(config.DATA_DIR, 'shots', id), { recursive: true, force: true }); } catch (e) { /* 无所谓 */ }
      store.appendEvent({ type: 'device_delete', deviceId: id });
      return json(res, 200, { ok: true });
    }

    /**
     * 手动指定电视 IP。Docker bridge 部署下服务端只能看到网桥网关（172.x.0.1），
     * 自动识别就会失效；这里让家长在后台填一次真实局域网 IP，截图和离线唤醒立刻恢复。
     * 传空字符串 = 清除手动指定，回到自动识别。
     */
    if (p.startsWith('/api/admin/device/') && p.endsWith('/ip') && method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/admin/device/'.length, -'/ip'.length));
      if (!store.getDevice(id)) return json(res, 404, { error: 'device not found' });
      const body = await readBody(req);
      try {
        const ip = store.setFixedIp(id, body.ip);
        store.appendEvent({ type: 'device_ip', deviceId: id, ip: ip || 'auto' });
        return json(res, 200, { ok: true, ip, source: ip ? 'manual' : 'auto' });
      } catch (e) {
        return json(res, 400, { error: String(e && e.message || e) });
      }
    }

    /**
     * 后台开关「设备管理员」（保活用）。
     *
     * 为什么只能这样：Android 不允许远程激活设备管理员（这是系统的安全底线），
     * 服务端能做的只是下发一个意愿，等电视端拉 session 时自己弹出系统确认框，
     * 家长按一下遥控器的「激活」。所以这里返回的是「已下发」，不是「已激活」。
     */
    if (p.startsWith('/api/admin/device/') && p.endsWith('/admin') && method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/admin/device/'.length, -'/admin'.length));
      const body = await readBody(req);
      const action = String(body.action || '').trim();
      if (!['on', 'off', 'cancel'].includes(action)) {
        return json(res, 400, { error: 'action 只能是 on / off / cancel' });
      }
      const st = store.setAdminCmd(id, action);
      if (!st) return json(res, 404, { error: 'device not found' });
      store.appendEvent({
        type: 'admin_cmd', deviceId: id, action,
        // 已经是对的状态时不会真的下发，记一下便于事后对账
        queued: !!st.cmd
      });
      return json(res, 200, { ok: true, admin: st });
    }

    // 重置今日统计：家长偶尔需要「今天重新开始」
    if (p.startsWith('/api/admin/device/') && p.endsWith('/reset') && method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/admin/device/'.length, -'/reset'.length));
      const st = store.resetToday(id);
      if (!st) return json(res, 404, { error: 'device not found' });
      store.appendEvent({ type: 'reset_today', deviceId: id });
      return json(res, 200, { ok: true, stats: st });
    }

    /**
     * 手动触发一次保活修复（不走冷却）。电视上报发现没开时后台也会自动跑同一套，
     * 这个按钮给「等不及冷却 / 想马上确认能不能修」的场景。
     */
    if (p.startsWith('/api/admin/device/') && p.endsWith('/fix') && method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/admin/device/'.length, -'/fix'.length));
      if (!store.getDevice(id)) return json(res, 404, { error: 'device not found' });
      const r = await keepalive.attemptFix(store, id, { force: true });
      if (r) store.appendEvent({ type: 'keepalive_fix', deviceId: id, ok: r.ok, target: r.target, error: r.error });
      return json(res, 200, r || { ok: false, error: '正在修复中，稍后再试' });
    }

    // 手动唤醒一台离线的电视：adb am start 把守时桌面拉回前台（巡检也会自动跑）
    if (p.startsWith('/api/admin/device/') && p.endsWith('/revive') && method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/admin/device/'.length, -'/revive'.length));
      if (!store.getDevice(id)) return json(res, 404, { error: 'device not found' });
      const r = await keepalive.attemptRevive(store, id, { force: true });
      if (r) store.appendEvent({ type: 'device_revive', deviceId: id, ok: r.ok, error: r.error });
      return json(res, 200, r || { ok: false, error: '正在唤醒中，稍后再试' });
    }

    // ---------- 电视画面截屏 ----------

    // 开关状态 + 各设备的最后截屏时间
    if (p === '/api/admin/shot/status' && method === 'GET') {
      return json(res, 200, {
        enabled: config.getScreenshotEnabled(),
        intervalSec: config.getScreenshotIntervalSec(),
        intervalMs: screenshot.intervalMs(),
        maxCount: config.getScreenshotMaxCount(),
        key: adb.keyInfo(),
        devices: store.devicesList().map(d => ({
          id: d.id, name: d.name,
          ip: store.effectiveIp(d), lastIp: d.lastIp || '',
          fixedIp: d.fixedIp || '', natIp: d.natIp || '', ipSource: d.ipSource || '',
          online: Date.now() - d.lastSeen < store.offlineWindowMs(d),
          shotAt: d.shotAt || 0
        }))
      });
    }

    if (p === '/api/admin/shot/status' && method === 'POST') {
      const body = await readBody(req);
      const enabled = config.setScreenshotEnabled(!!body.enabled);
      // 截图间隔 / 最大张数也可以顺手一起改（两个输入框共用一个「保存」按钮）
      const intervalSec = body.intervalSec === undefined ? undefined : config.setScreenshotIntervalSec(body.intervalSec);
      const maxCount = body.maxCount === undefined ? undefined : config.setScreenshotMaxCount(body.maxCount);
      store.appendEvent({ type: 'shot_toggle', on: enabled, intervalSec, maxCount });
      return json(res, 200, { ok: true, enabled, intervalSec, maxCount });
    }

    // 截图自检：把密钥 / 网络 / 授权 / 截屏 / 压缩 / 写盘逐项跑一遍，失败直接定位
    if (p === '/api/admin/shot/diagnose' && method === 'POST') {
      const body = await readBody(req);
      const id = body.deviceId || (store.devicesList()[0] || {}).id;
      if (!id || !store.getDevice(id)) return json(res, 404, { error: 'device not found' });
      // body.ip 只用于临时试某个地址，不写进设备记录
      return json(res, 200, await screenshot.diagnose(store, id, body.ip));
    }

    // 同步 adb 密钥：把电脑上「电视已授权过」的 adbkey 整份传上来，不用在文本编辑器里手改文件
    if (p === '/api/admin/adb-key' && method === 'POST') {
      const body = await readBody(req);
      try {
        const key = adb.setKey(body.pem || body.text || body.key);
        store.appendEvent({ type: 'adb_key', name: key.name, fingerprint: key.fingerprint });
        return json(res, 200, { ok: true, key });
      } catch (e) {
        return json(res, 400, { error: String(e && e.message || e) });
      }
    }

    // 手动截一张：不用开自动截屏的开关，随时点随时截
    if (p === '/api/admin/shot/capture' && method === 'POST') {
      const body = await readBody(req);
      const id = body.deviceId;
      if (!id || !store.getDevice(id)) return json(res, 404, { error: 'device not found' });
      try {
        const r = await screenshot.captureNow(store, id);
        return json(res, 200, { ok: true, at: r.at, size: r.size });
      } catch (e) {
        return json(res, 500, { error: String(e && e.message || e) });
      }
    }

    // 照片墙：保留窗口内的所有截图（按时间倒序，前端叠放展示）
    if (p.startsWith('/api/admin/shot/list/') && method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/admin/shot/list/'.length));
      if (!store.getDevice(id)) return json(res, 404, { error: 'device not found' });
      return json(res, 200, { ok: true, shots: screenshot.listShots(id) });
    }

    // 截图二进制（JPEG，960 宽压缩版）：/shot/:id = 最新一张，/shot/:id/:ts = 指定那张。
    // 前端用时间戳参数防缓存；指定某张时带 Cache-Control 让照片墙滑起来不重复下载。
    if (p.startsWith('/api/admin/shot/') && method === 'GET') {
      const rest = p.slice('/api/admin/shot/'.length).split('/').map(decodeURIComponent);
      const id = rest[0];
      const fp = rest[1]
        ? screenshot.shotByTime(id, rest[1])
        : screenshot.latestShot(id);
      if (!fp) return json(res, 404, { error: '还没有截图' });
      let stat;
      try { stat = fs.statSync(fp); } catch (e) { return json(res, 404, { error: '还没有截图' }); }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': stat.size,
        // 指定时间戳的图内容不变，可以缓存；最新一张永远 no-store
        'Cache-Control': rest[1] ? 'private, max-age=600' : 'no-store'
      });
      fs.createReadStream(fp).pipe(res);
      return;
    }

    if (p === '/api/admin/questions' && method === 'GET') {
      const subject = q.get('subject');
      const type = q.get('type');
      const level = q.get('level');
      const grade = q.get('grade');
      const kw = (q.get('q') || '').trim();
      // 先按「题型 / 难度 / 年级 / 通用题」过滤出基集。
      // 顶部 chips 上每个学科的题量就按这份基集算，和下面的列表同一口径 ——
      // 之前 chips 用的是 overview 里的全库统计，选了一年级数字还是 2564，看着像筛选没生效。
      let base = store.questions;
      if (type && type !== 'all') base = base.filter(x => (x.type || 'choice') === type);
      if (level && level !== 'all') base = base.filter(x => String(x.level) === level);
      // 选具体年级时只看该年级的题；「包含通用题」勾上才把 grade=0 的题一起列出来。
      // 「全部年级」是管理视图，永远全库可见。
      if (grade && grade !== 'all' && grade !== '0') {
        const g = quiz.normalizeGrade(grade);
        const inc = q.get('incGeneral') === '1';
        base = base.filter(x => {
          const qg = quiz.normalizeGrade(x.grade);
          return qg === g || (inc && qg === 0);
        });
      }
      // 按「学科名」聚合：一年级是 g1_math、通用题是 math，勾了「含通用题」后
      // 两者都叫「数学」，必须加在同一个 chip 上，所以这里不按 key 分桶。
      // 年级学科的 key 要带上年级才解析得出名字，否则 g1_math 会原样返回。
      const bySubject = {};
      for (const x of base) {
        const n = subjects.subjectName(x.subject || 'math', quiz.normalizeGrade(x.grade));
        const c = bySubject[n] || (bySubject[n] = { total: 0, enabled: 0 });
        c.total++;
        if (x.enabled !== false) c.enabled++;
      }

      let list = base;
      // 学科筛选按「名字」展开：每个年级的「科学」是独立 key，前端 chips 已按名字合并，
      // 点一个「科学」要覆盖所有年级的 g1_science / g2_science / …
      if (subject && subject !== 'all') {
        const keys = new Set(quiz.expandSubjectKeys([subject]));
        keys.add(subject);
        list = list.filter(x => keys.has(x.subject || 'math'));
      }
      if (kw) list = list.filter(x => x.prompt.includes(kw) || String(x.answer).includes(kw));
      const total = list.length;
      const offset = Math.max(0, Number(q.get('offset')) || 0);
      const limit = Math.min(200, Number(q.get('limit')) || 50);
      return json(res, 200, {
        total,
        // 「全部」chip 用这个数：不含学科 / 关键词过滤，但已经带上年级 / 难度 / 题型
        scopeTotal: base.length,
        bySubject,
        byGrade: quiz.stats().byGrade,
        items: list.slice(offset, offset + limit).map(x => ({
          id: x.id, grade: quiz.normalizeGrade(x.grade),
          subject: x.subject || 'math', type: x.type || 'choice',
          stars: x.stars || 1, level: x.level, prompt: x.prompt,
          priority: Number(x.priority) || 0,
          answer: x.answer, options: x.options, hint: x.hint || '',
          explanation: x.explanation || '',
          enabled: x.enabled !== false, source: x.source || ''
        }))
      });
    }

    if (p === '/api/admin/questions' && method === 'POST') {
      const body = await readBody(req);
      const r = quiz.addQuestion(body);
      if (r.error) return json(res, 400, r);
      return json(res, 200, r);
    }

    if (p === '/api/admin/questions/import' && method === 'POST') {
      const body = await readBody(req);
      const r = quiz.importText(body.text, body.level, body.subject, body.type, body.grade);
      store.appendEvent({ type: 'import', ok: r.ok, failed: r.failed, subject: body.subject || '' });
      return json(res, 200, r);
    }

    /** 题库包：一次上传一整套按年级归档的题目（JSON 数组，去重、只写一次盘） */
    /**
     * 批量操作：题库页多选后一次性启用 / 停用 / 清出题记录 / 删除。
     * 放在单题路由前面 —— '/api/admin/questions/batch' 也会被下面的 startsWith 命中，
     * 这里先拦下来，避免被当成 id 为 "batch" 的题目。
     * 一次最多 500 条（前端一页最多 100，留出「跨页累积」的余量）。
     */
    if (p === '/api/admin/questions/batch' && method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || '');
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean).slice(0, 500) : [];
      if (!ids.length) return json(res, 400, { error: '没有选中题目' });
      if (!['enable', 'disable', 'reset', 'delete'].includes(action)) {
        return json(res, 400, { error: '不支持的批量操作：' + action });
      }
      let ok = 0, missing = 0, cleared = 0;
      for (const id of ids) {
        if (action === 'delete') {
          quiz.deleteQuestion(id) ? ok++ : missing++;
        } else if (action === 'reset') {
          const r = quiz.resetQuestionStats(id);
          if (r.error) missing++; else { ok++; if (r.cleared) cleared++; }
        } else {
          quiz.updateQuestion(id, { enabled: action === 'enable' }) ? ok++ : missing++;
        }
      }
      store.appendEvent({
        type: action === 'delete' ? 'question_delete'
          : action === 'reset' ? 'question_reset' : 'question_edit',
        count: ok, batch: 1,
        reason: action === 'enable' ? '批量启用' : action === 'disable' ? '批量停用'
          : action === 'reset' ? '批量清出题记录' : '批量删除'
      });
      return json(res, 200, { ok, missing, cleared, action });
    }

    if (p === '/api/admin/questions/bulk' && method === 'POST') {
      const body = await readBody(req, 32 * 1024 * 1024);
      const items = Array.isArray(body) ? body : (body.items || []);
      const r = quiz.bulkImport(items);
      if (r.error) return json(res, 400, r);
      store.appendEvent({ type: 'import', ok: r.ok, skipped: r.skipped, failed: r.failed, subject: '题库包' });
      return json(res, 200, r);
    }

    /**
     * 题库导出：把勾中的题按题库包格式吐出来（完全不带 ids 参数才是整库）。
     * 带 ids 但解析不出任何 id 时返回空列表 —— 免得勾选丢了却把整库导出去。
     * 导出文件可以直接喂回「选择文件导入」，用来备份 / 换机器 / 批量改完再导回来。
     */
    if (p === '/api/admin/questions/export' && method === 'GET') {
      const hasIds = q.has('ids');
      const ids = String(q.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (hasIds && !ids.length) return json(res, 200, { count: 0, items: [] });
      const items = quiz.exportQuestions(ids);
      store.appendEvent({ type: 'export', count: items.length });
      return json(res, 200, { count: items.length, items });
    }

    // ---------- 学科（每个年级独立一套，可自定义） ----------
    // level / incGeneral 用来算「按当前出题范围筛选后每个学科还剩多少题」：
    // 不传就是全难度、不含通用题，和电视端出题口径保持一致
    if (p === '/api/admin/subjects' && method === 'GET') {
      const g = q.get('grade');
      return json(res, 200, {
        grades: quiz.GRADES,
        gradeNames: quiz.GRADE_NAMES,
        all: subjects.allGradeSubjects(),
        list: quiz.subjectMeta(g || 0, q.get('level'), q.get('incGeneral') === '1')
      });
    }
    if (p === '/api/admin/subjects' && method === 'POST') {
      const body = await readBody(req);
      const r = subjects.addGradeSubject(body.grade, body);
      if (r.error) return json(res, 400, r);
      store.appendEvent({ type: 'subject_add', grade: body.grade, subject: r.subject.name });
      return json(res, 200, r);
    }
    if (p.startsWith('/api/admin/subjects/') && method === 'PUT') {
      const body = await readBody(req);
      const r = subjects.updateGradeSubject(body.grade, decodeURIComponent(p.slice('/api/admin/subjects/'.length)), body);
      if (r.error) return json(res, 400, r);
      return json(res, 200, r);
    }
    if (p.startsWith('/api/admin/subjects/') && method === 'DELETE') {
      const key = decodeURIComponent(p.slice('/api/admin/subjects/'.length));
      const r = subjects.removeGradeSubject(q.get('grade'), key);
      if (r.error) return json(res, 400, r);
      store.appendEvent({ type: 'subject_delete', grade: q.get('grade'), subject: key });
      return json(res, 200, r);
    }

    /**
     * 清掉某道题的出题记录（题留着）。
     * 用于「刚加/刚改的题想马上出现」：出题即写 lastAt，冷却 30 分钟，
     * 但题目本身没法改这个时间，只能从题库页手动清一下。
     */
    if (p.startsWith('/api/admin/questions/') && p.endsWith('/reset-stats') && method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/admin/questions/'.length, -'/reset-stats'.length));
      const r = quiz.resetQuestionStats(id);
      if (r.error) return json(res, 404, r);
      store.appendEvent({ type: 'question_reset', qid: id });
      return json(res, 200, r);
    }

    if (p.startsWith('/api/admin/questions/')) {
      const id = decodeURIComponent(p.slice('/api/admin/questions/'.length));
      // 单题详情：日志里点「答题」要看清这道题的题干、选项和正确答案；
      // 题库页的「编辑」也复用这个接口，所以编辑弹窗要用的字段（媒体 / 优先级 / 启用状态）一样得给全。
      if (method === 'GET') {
        const q0 = store.questions.find(x => x.id === id);
        if (!q0) return json(res, 404, { error: '题目已不在题库里' });
        return json(res, 200, {
          id: q0.id, grade: quiz.normalizeGrade(q0.grade),
          subject: q0.subject || 'math', type: q0.type || 'choice',
          stars: q0.stars || 1, level: q0.level, prompt: q0.prompt,
          priority: Number(q0.priority) || 0,
          enabled: q0.enabled !== false,
          answer: q0.answer, options: q0.options || [], hint: q0.hint || '',
          explanation: q0.explanation || '', source: q0.source || ''
        });
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const q2 = quiz.updateQuestion(id, body);
        if (!q2) return json(res, 404, { error: 'not found' });
        // 只改启用状态是高频动作（列表里点一下就发），不写事件刷屏；真编辑内容才记一笔
        if (Object.keys(body || {}).some(k => k !== 'enabled')) {
          store.appendEvent({ type: 'question_edit', qid: id, subject: q2.subject, level: q2.level });
        }
        return json(res, 200, { question: q2 });
      }
      if (method === 'DELETE') {
        const okDel = quiz.deleteQuestion(id);
        if (okDel) store.appendEvent({ type: 'question_delete', qid: id });
        return json(res, okDel ? 200 : 404, { ok: okDel });
      }
    }

    if (p === '/api/admin/events' && method === 'GET') {
      const r = store.queryEvents({
        type: q.get('type') || '',
        deviceId: q.get('deviceId') || '',
        q: q.get('q') || '',
        // 前端默认传 exclude=device_online,device_offline：这两类太频繁，页面先折起来
        exclude: q.get('exclude') || '',
        offset: Number(q.get('offset')) || 0,
        limit: Number(q.get('limit')) || 50
      });
      return json(res, 200, r);
    }

    // ---------- 运行日志归档（详细日志文件） ----------

    /** 列表：磁盘上的 tvguard-YYYY-MM-DD.log + 今天实时还剩多少条 */
    if (p === '/api/admin/eventlogs' && method === 'GET') {
      const today = store.today();
      const live = store.queryEvents({ limit: 1 });
      return json(res, 200, {
        files: logfile.list(),
        today: { day: today, count: live.scanned + live.hidden },
        dir: 'data/logs'
      });
    }

    /** 下载：?name=tvguard-2026-11-15.log（文件名白名单校验，防目录穿越） */
    if (p === '/api/admin/eventlogs/file' && method === 'GET') {
      const full = logfile.safePath(q.get('name'));
      if (!full || !fs.existsSync(full)) return json(res, 404, { error: '文件不存在' });
      const st = fs.statSync(full);
      const name = path.basename(full);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(full).pipe(res);
      return;
    }

    /** 删除归档文件 */
    if (p === '/api/admin/eventlogs/file' && method === 'DELETE') {
      const name = q.get('name');
      if (!logfile.remove(name)) return json(res, 404, { error: '文件不存在' });
      store.appendEvent({ type: 'log_export', day: String(name || '').replace(/\D/g, ''), file: name, reason: '删除归档文件' });
      return json(res, 200, { ok: true, files: logfile.list() });
    }

    /** 手动导出：默认昨天；指定 day 可补导某一天（只导不删） */
    if (p === '/api/admin/eventlogs/export' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const day = String((body && body.day) || '').trim() || logfile.yesterdayStr();
      const r = logfile.exportDay(day, { keep: true });
      if (!r.ok) return json(res, 400, { error: r.error });
      store.appendEvent({ type: 'log_export', day: r.day, count: r.count, bytes: r.bytes, file: r.file, auto: false });
      return json(res, 200, Object.assign({ files: logfile.list() }, r));
    }

    // ---------- 留言栏 ----------

    if (p === '/api/admin/notice' && method === 'GET') {
      return json(res, 200, { notice: store.notice, today: store.serverToday });
    }

    /** 推送 / 清空留言：text 为空 = 清除。day 是显示日期（YYYY-MM-DD），没传就当天生效 */
    if (p === '/api/admin/notice' && (method === 'PUT' || method === 'POST')) {
      const body = await readBody(req);
      const n = store.setNotice(body.text, body.day);
      store.appendEvent(n
        ? { type: 'notice_push', text: n.text, day: n.day }
        : { type: 'notice_clear' });

      // 推送的同时把电视的悬浮窗权限补齐。
      // TCL 的清理工具会把这条 appops 从 allow 改回去，改回去之后留言弹框和右上角角标
      // 都是**静默失效**（客户端 logd 也被禁，连异常都看不到），家长只会觉得「推了没反应」。
      // 已经 allow 的设备只读一次就返回，不做任何变更；连不上的如实报错交给前端提示。
      const overlay = [];
      if (n) {
        for (const d of store.devicesList()) {
          const r = await keepalive.ensureOverlay(store, d.id);
          // 补不上，多半是电视进程被 TCL 清理工具干掉了（连 adb 也不应）。顺手异步拉一次，
          // 不阻塞这次推送：拉起来之后它第一件事就是 checkAtBoot，正好把这条留言取走。
          if (!r.ok) {
            keepalive.attemptRevive(store, d.id, { force: false }).catch(() => { /* 失败有记录 */ });
            r.reviving = true;
          }
          overlay.push(Object.assign({ id: d.id, name: d.name }, r));
          // 只在真动了手（补开成功 / 补开失败）时记事件，本来就是 allow 的不刷日志
          if (!r.already) {
            store.appendEvent({
              type: 'overlay_perm', deviceId: d.id, ok: !!r.ok,
              fixed: !!r.fixed, error: r.error || ''
            });
          }
        }
      }
      return json(res, 200, { ok: true, notice: n, today: store.serverToday, overlay });
    }

    // ---------- APK 版本管理（管理端） ----------

    // 列表：最新 + 历史（默认 4 个 = 当前 + 3 个可回退的）
    if (p === '/api/admin/apk' && method === 'GET') {
      return json(res, 200, apkMod.list(apkStore));
    }

    /**
     * 上传 APK。
     *
     * 用「原始二进制 + ?name=文件名」而不是 multipart：零依赖解析 multipart 太容易踩坑，
     * 前端 fetch(url, { body: file }) 直接传就完了。
     */
    if (p === '/api/admin/apk' && method === 'POST') {
      let buf;
      try {
        buf = await readBinary(req);
      } catch (e) {
        return json(res, 413, { error: e.message });
      }
      if (!buf || buf.length < 1024) return json(res, 400, { error: '没收到文件内容' });

      const tmp = path.join(os.tmpdir(), `tvg-apk-${Date.now()}.apk`);
      try {
        fs.writeFileSync(tmp, buf);
        const item = apkMod.addVersion(apkStore, tmp, q.get('name') || '');
        store.appendEvent({ type: 'apk_uploaded', versionName: item.versionName, versionCode: item.versionCode });
        return json(res, 200, { ok: true, item, list: apkMod.list(apkStore) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* 已删 */ }
      }
    }

    // 历史版本也能下载（备份 / U 盘手动降级用）
    if (p.startsWith('/api/admin/apk/') && p.endsWith('/file') && method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/admin/apk/'.length, -'/file'.length));
      const it = apkMod.list(apkStore).items.find(x => x.id === id);
      if (!it) return json(res, 404, { error: '版本不在了' });
      const fp = path.join(apkStore.dir, it.file);
      let stat;
      try { stat = fs.statSync(fp); } catch (e) { return json(res, 410, { error: '文件不在了' }); }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="tvguard-${it.versionCode}.apk"`,
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(fp).pipe(res);
      return;
    }

    if (p.startsWith('/api/admin/apk/') && method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/admin/apk/'.length).replace(/\/activate$/, ''));
      try {
        const item = apkMod.activate(apkStore, id);
        store.appendEvent({ type: 'apk_activated', versionName: item.versionName, versionCode: item.versionCode });
        return json(res, 200, { ok: true, list: apkMod.list(apkStore) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (p.startsWith('/api/admin/apk/') && method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/admin/apk/'.length));
      try {
        apkMod.remove(apkStore, id);
        return json(res, 200, { ok: true, list: apkMod.list(apkStore) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // ---------- APK 下发（电视端） ----------

    /**
     * 电视端问「有没有比我新的版本」。
     *
     * 只认 versionCode 更大 —— 后台把分发指针切回旧版本时不会让已经升上去的电视降级
     * （Android 装不上低版本，硬装得先卸载，那是应急操作，不能让电视自己干）。
     */
    if (p === '/api/v1/device/apk' && method === 'GET') {
      const vc = Number(q.get('vc')) || 0;
      const pkg = q.get('pkg') || '';
      const a = apkMod.active(apkStore);
      if (!a) return json(res, 200, { update: false });
      const samePkg = !pkg || a.package === pkg;
      return json(res, 200, {
        update: samePkg && a.versionCode > vc,
        versionCode: a.versionCode,
        versionName: a.versionName,
        size: a.size,
        md5: a.md5,
        url: '/apk/latest.apk'
      });
    }

    // 下载当前分发版本
    if (p === '/apk/latest.apk' && method === 'GET') {
      const a = apkMod.active(apkStore);
      if (!a) return json(res, 404, { error: '还没上传过 APK' });
      let stat;
      try { stat = fs.statSync(a.filePath); } catch (e) {
        return json(res, 410, { error: '文件不在了，重新上传一次' });
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="tvguard-${a.versionCode}.apk"`,
        'X-Apk-Md5': a.md5,
        'X-Apk-Version': `${a.versionName} (${a.versionCode})`,
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(a.filePath).pipe(res);
      return;
    }

    // ---------- 服务端自升级 ----------
    // 页面：必须登录；没登录回首页输密码。接口走上面统一的 /api/admin/ 鉴权。
    if (p === '/admin/upgrade' && method === 'GET') {
      if (!isAdmin(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(UPGRADE_HTML);
    }

    if (p === '/api/admin/upgrade/info' && method === 'GET') {
      const last = lastUpgrade();
      const build = readBuild();
      return json(res, 200, {
        version: adminVersion(build), build, last, lastBackup: lastBackupInfo(last)
      });
    }

    /** 下载最近一次备份：现场把 data/backup/<stamp>/ 打成一个 zip 流给浏览器 */
    if (p === '/api/admin/upgrade/backup' && method === 'GET') {
      const name = String(q.get('name') || '').trim();
      if (!name || !backupDirs().includes(name)) return json(res, 404, { error: '备份不存在' });
      try {
        const buf = zipDir(path.join(config.DATA_DIR, 'backup', name));
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': buf.length,
          'Content-Disposition': `attachment; filename="tvguard-backup-${name}.zip"`,
          'Cache-Control': 'no-store'
        });
        return res.end(buf);
      } catch (e) {
        return json(res, 500, { error: String(e && e.message || e) });
      }
    }

    if (p === '/api/admin/upgrade' && method === 'POST') {
      let buf;
      try { buf = await readBinary(req, UPGRADE_MAX); }
      catch (e) { return json(res, 413, { error: e.message }); }
      if (!buf || buf.length < 1024) return json(res, 400, { error: '没收到升级包' });
      try {
        const r = applyUpgrade(buf);
        json(res, 200, { ok: true, ...r });
        scheduleRestart();
        return;
      } catch (e) {
        // 页面只报成败，不带 src/public 这类实现细节；详细原因进运行日志
        const detail = String(e && e.message || e).slice(0, 300);
        store.appendEvent({ type: 'server_upgrade_failed', error: detail });
        const readOnly = detail.startsWith('代码目录是只读');
        return json(res, 400, { error: readOnly ? detail : '升级失败，详细原因已写入运行日志' });
      }
    }

    if (p === '/api/admin/upgrade/rollback' && method === 'POST') {
      try {
        const r = rollbackUpgrade();
        json(res, 200, { ok: true, ...r });
        scheduleRestart();
        return;
      } catch (e) {
        store.appendEvent({ type: 'server_rollback_failed', error: String(e && e.message || e).slice(0, 300) });
        return json(res, 400, { error: '回滚失败，详细原因已写入运行日志' });
      }
    }

    // ---------- 静态页面 ----------
    if (!p.startsWith('/api/')) {
      return serveStatic(res, p);
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  const srcName = {
    admin: '后台「管理密码」里设置的（data/config.json，优先于 .env）',
    env: '环境变量 ADMIN_PASSWORD',
    remembered: 'data/config.json 里记住的值（上次生效的密码）',
    default: '内置默认值'
  }[config.getPasswordSource()] || config.getPasswordSource();
  console.log(`[tvguard] listening on :${PORT}  data=${store.DATA_DIR}`);
  console.log(`[tvguard] 密码来源：${srcName}`);
  if (config.isWeakPassword()) {
    console.log('[tvguard] ⚠ 密码是默认值或过短，登录后台点「管理密码」→「修改密码」改掉');
  }
  console.log(`[tvguard] 密码备忘文件：${config.PASSWORD_FILE}`);
  console.log(`[tvguard] 题库 ${quiz.stats().total} 道`);
});
