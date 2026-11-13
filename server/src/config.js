'use strict';

/**
 * 配置解析：所有可变项集中在这里，不再散落在各文件里读 process.env。
 *
 * 为什么要单独一层：
 *   - 管理员密码原来只有「环境变量 / 默认 tvguard」两种来源，
 *     容器重建时 .env 没挂上就会悄悄退回默认值，家长以为密码还是自己设的那个，登录不上。
 *   - 现在密码解析成三层，并且**每次启动都把当前生效的密码留一份到 data 目录**，
 *     data 是 volume 挂载的，容器重建、迁移服务器都不会丢，忘了随时能查回来。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');       // 生效中的配置快照（含密码）
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt'); // 人肉可读的密码备忘
const DEFAULT_PASSWORD = 'tvguard';

const PORT = Number(process.env.PORT) || 8088;

/**
 * 电视端包名（applicationId）：与 app 的 gradle.properties「tvguard.appId」保持一致。
 * 组件名、pidof 全部由它派生，不在业务代码里写死；容器里可用环境变量 TV_PACKAGE 覆盖。
 */
const TV_PACKAGE = process.env.TV_PACKAGE || 'cn.binguoguo.tvguard';

function readJson(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || def;
  } catch (e) {
    return def;
  }
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 密码来源优先级：
 *   1. 后台「管理密码」页改过的（data/config.json 里 setByAdmin=true）—— 改一次就永久生效；
 *   2. 环境变量 ADMIN_PASSWORD；
 *   3. data/config.json 里记住的上次值；
 *   4. 内置默认值。
 *
 * 为什么后台改的排最前：这个文件在容器里改不了 .env（那只在宿主机上，容器里不一定挂着），
 * 所以后台改密码只能落到 data 卷。要是不优先，容器一重启 .env 里的旧密码又盖回来，
 * 家长会以为「改了没用」。
 */
let password = '';
let source = '';

function loadAdminPassword() {
  const fromEnv = String(process.env.ADMIN_PASSWORD || '').trim();
  const saved = readJson(CONFIG_FILE, {});
  const remembered = String(saved.adminPassword || '').trim();
  const managed = saved.setByAdmin === true && remembered.length >= 6;

  if (managed) {
    password = remembered;
    source = 'admin';
  } else if (fromEnv) {
    password = fromEnv;
    source = 'env';
  } else if (remembered) {
    password = remembered;
    source = 'remembered';
  } else {
    password = DEFAULT_PASSWORD;
    source = 'default';
  }
  return { password, source };
}

/** 只有不是后台设置的那份，才在启动时把当前生效值盖进 config.json（当快照用） */
function snapshotPassword() {
  const saved = readJson(CONFIG_FILE, {});
  if (saved.setByAdmin === true) return;      // 后台设置过的别覆盖
  if (saved.adminPassword === password) return;
  writeConfig({ adminPassword: password, note: '这是服务当前生效的管理密码。可直接在后台「管理密码」里修改，无需改 .env。' });
}

/** 读整份 config.json；写的时候按键合并，别把别的配置项冲掉 */
function readConfig() {
  return readJson(CONFIG_FILE, {});
}

function writeConfig(patch) {
  const merged = Object.assign({}, readConfig(), patch, { updatedAt: new Date().toISOString() });
  writeAtomic(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

/** 人肉可读的备忘，用 Notepad / 文本编辑器直接打开就能看 */
function writeMemo() {
  const srcText = {
    admin: '后台「管理密码」里设置的（data/config.json）',
    env: '环境变量 ADMIN_PASSWORD',
    remembered: 'data/config.json（上次生效的值）',
    default: '内置默认值'
  }[source] || source;

  const memo = [
    'TvGuard 管理端 —— 当前生效的管理员密码',
    '',
    `密码：${password}`,
    `来源：${srcText}`,
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '改密码：登录后台后点右上角「管理密码」→「修改密码」。',
    '改完立即生效，容器重启也不会变回去；此时 .env 里的 ADMIN_PASSWORD 不再使用。',
    '改了密码后，其它设备上的登录态会失效，用新密码重新登录即可。',
    ''
  ].join('\n');
  try {
    writeAtomic(PASSWORD_FILE, memo);
    fs.chmodSync(PASSWORD_FILE, 0o600);
  } catch (e) {
    // 某些挂载盘不支持 chmod，忽略即可，不影响启动
  }
}

loadAdminPassword();
snapshotPassword();
writeMemo();

const weak = () => password === DEFAULT_PASSWORD || password.length < 6;

// 整数夹取：后台填错（负数/超大/非数字）时回落到默认，别让错误值把系统搞挂
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// 小数夹取：同上，但允许 0.5 这种小数（登录有效期按小时算，可能不足 1 小时）
function clampNum(v, min, max, def) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// 心跳间隔（秒）：客户端请求管理端的连接间隔，默认 5 秒。
// 这是每设备配置（在后台设备卡里改），不是全局后台可配项 —— 一台管理端可能管多台电视，
// 每台独立设自己的心跳，互不影响。全局只留这个默认值，设备没单独设过就用它。
const DEFAULT_HEARTBEAT_SEC = 5;

// 管理端登录态有效期（小时）。以前是 30 天免登录，家长要求别缓存那么久 → 默认 12 小时
// （当天有效，第二天要重新输密码）。这个值现在**后台可直接改**：
//   - 优先用 data/config.json 里管理员设置过的 sessionHours（改一次就持久、重启不丢）；
//   - 没改过才读环境变量 ADMIN_SESSION_HOURS（部署级覆盖，给不想进后台的人用）；
//   - 都没设就用默认 12。
// 不做滑动续期：天天用就永远不过期，和 30 天没区别。
//
// sessionEpoch：每次改有效期就 +1，并一起参与 token 签名 —— 这样旧登录态一次性作废，
// 其它设备上还挂着的管理端会被强制重新登录，改动立刻全网生效（和改密码一个套路）。
let sessionHours = (() => {
  const saved = readConfig();
  if (typeof saved.sessionHours === 'number' && Number.isFinite(saved.sessionHours)) {
    return clampNum(saved.sessionHours, 0.1, 720, 12);
  }
  return clampNum(process.env.ADMIN_SESSION_HOURS, 0.1, 720, 12);
})();
let sessionEpoch = (() => {
  const saved = readConfig();
  return Number.isFinite(saved.sessionEpoch) ? saved.sessionEpoch : 1;
})();

function getSessionHours() { return sessionHours; }
function getSessionEpoch() { return sessionEpoch; }

/**
 * 后台改登录有效期：写进 data 卷 → 立刻生效 → 重启不丢。
 * 同时把 sessionEpoch +1，让所有旧 token 失效，其它设备被迫重新登录。
 * 调用方（接口）会顺手给当前请求者重新签发一个带新有效期的 token，保证本人不被踢出。
 */
function setSessionHours(h) {
  const n = clampNum(h, 0.1, 720, 12);
  sessionEpoch = (Number.isFinite(sessionEpoch) ? sessionEpoch : 1) + 1;
  sessionHours = n;
  writeConfig({ sessionHours: n, sessionEpoch });
  return { hours: n, epoch: sessionEpoch };
}

// 截屏开关：跟着 config.json 走，后台改完即时生效
let shotEnabled = readConfig().screenshotOn === true;

// 截图间隔（秒）与最大张数：后台手动输入，默认 10 秒 / 50 张；保留多少图只由张数决定
const shotCfg = readConfig();
let shotIntervalSec = Number(shotCfg.shotIntervalSec) >= 5 ? Math.round(Number(shotCfg.shotIntervalSec)) : 10;
let shotMaxCount = Number(shotCfg.shotMaxCount) >= 5 ? Math.round(Number(shotCfg.shotMaxCount)) : 50;

module.exports = {
  PORT,
  DATA_DIR,
  TV_PACKAGE,
  CONFIG_FILE,
  PASSWORD_FILE,
  DEFAULT_PASSWORD,
  /** 管理端登录态有效期（小时），默认 12，后台可改、持久化 */
  getSessionHours,
  getSessionEpoch,
  setSessionHours,
  /** 当前生效的密码（后台改过就是新密码，别再读 process.env） */
  getAdminPassword: () => password,
  getPasswordSource: () => source,
  isWeakPassword: weak,
  /** 弱密码判断在启动日志里用一次，保留旧字段名兼容 */
  get WEAK_PASSWORD() { return weak(); },
  get ADMIN_PASSWORD() { return password; },
  get PASSWORD_SOURCE() { return source; },

  /**
   * 后台改密码：写进 data 卷 → 立即生效 → 重启不丢。
   *
   * 写盘失败（比如 data 目录只读）直接抛错，让接口把失败原因返回给页面，
   * 不能出现「页面说改好了，重启又变回去」这种坑。
   */
  setAdminPassword(next) {
    const pwd = String(next || '').trim();
    if (pwd.length < 6) throw new Error('密码至少 6 位');
    if (pwd.length > 64) throw new Error('密码最多 64 位');
    writeConfig({
      adminPassword: pwd,
      setByAdmin: true,
      note: '管理员在后台改过密码，此值优先于 .env 的 ADMIN_PASSWORD。'
    });
    password = pwd;
    source = 'admin';
    writeMemo();
    return { password, source };
  },

  /** 电视画面自动截屏（每 10 秒一张，只留最近 5 分钟），默认关 */
  getScreenshotEnabled: () => shotEnabled === true,

  setScreenshotEnabled(on) {
    shotEnabled = !!on;
    writeConfig({ screenshotOn: shotEnabled });
    return shotEnabled;
  },

  /** 截图间隔（秒）：最小 5，家长在后台手动输入 */
  getScreenshotIntervalSec: () => shotIntervalSec,

  setScreenshotIntervalSec(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return shotIntervalSec;
    shotIntervalSec = Math.min(600, Math.max(5, n));
    writeConfig({ shotIntervalSec });
    return shotIntervalSec;
  },

  /** 最多保存几张截图：默认 50，超出从最旧的开始删 */
  getScreenshotMaxCount: () => shotMaxCount,

  setScreenshotMaxCount(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return shotMaxCount;
    shotMaxCount = Math.min(500, Math.max(5, n));
    writeConfig({ shotMaxCount });
    return shotMaxCount;
  },

  /** 心跳默认值（秒）：客户端连管理端的间隔，每设备可覆盖 */
  DEFAULT_HEARTBEAT_SEC
};
