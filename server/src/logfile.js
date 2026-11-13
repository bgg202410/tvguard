'use strict';

/**
 * 运行日志归档：把「详细日志」落成按天的文本文件。
 *
 * 为什么要有这一层：
 *   - 实时日志（data/events.jsonl）里最吵的是「连接断开 / 连接恢复」——
 *     电视一晚上待机会翻十几次，管理端的运行日志被这两类刷满，家长根本看不到
 *     真正有用的记录。所以页面默认把它们折起来（不删，只是不显示）。
 *   - 但排查问题恰恰需要这些记录（几点断的、断了多久、有没有自动拉起）。
 *     于是每天定时把**昨天一整天**的全部事件导出成 data/logs/tvguard-YYYY-MM-DD.log，
 *     导出件是给人看的明细文本，包含连接断开 / 恢复，谁想看谁下载。
 *   - 导出成功后才把「昨天」的事件从实时日志里删掉，今天的继续留在页面上实时刷。
 *     这样实时日志永远只有一天的量，不会越滚越大，也不用再靠 5MB 轮转硬切。
 *
 * 约定：
 *   - 只导出「已经过完的日期」，并且按服务端本地时间（容器 TZ=Asia/Shanghai）分天；
 *   - 导出先写 .tmp 再 rename，写完回读校验行数，校验不过不动实时日志；
 *   - 删除只删「已导出的那一天」，今天的一条都不碰。
 */

const fs = require('fs');
const path = require('path');

/** 事件类型 → 中文名。和前端 js/logs.js 的 EV_NAMES 保持一致，文件里写中文更好读 */
const EV_NAMES = {
  register: '设备注册',
  quiz_served: '出题',
  quiz_answer: '答题',
  login: '登录',
  login_failed: '登录失败',
  seed: '初始化题库',
  import: '导入题目',
  export: '导出题库',
  apps_sync: '同步应用',
  unlock_ok: '家长验证通过',
  unlock_failed: '家长验证失败',
  keepalive_fix: '自动保活',
  device_revive: '离线唤醒',
  device_delete: '删除设备',
  device_offline: '连接断开',
  device_online: '连接恢复',
  device_ip: '指定电视 IP',
  server_upgrade: '管理端升级',
  server_upgrade_failed: '升级失败',
  server_rollback: '管理端回滚',
  server_rollback_failed: '回滚失败',
  shot_error: '截屏',
  shot_toggle: '截屏开关',
  adb_key: '同步 adb 密钥',
  password_changed: '修改管理密码',
  notice_push: '推送留言',
  notice_clear: '清除留言',
  overlay_perm: '补齐悬浮窗权限',
  log_export: '日志归档',
  subject_add: '新增学科',
  subject_delete: '删除学科',
  question_edit: '编辑题目',
  question_delete: '删除题目'
};

/** 明细字段的中文标签：认识的字段写人话，不认识的保留原始键名（不丢信息） */
const FIELD_NAMES = {
  ip: 'IP', model: '型号', name: '名称', count: '数量', target: '目标',
  ok: '成功', failed: '失败', error: '错误', subject: '学科', level: '难度',
  correct: '答对', choice: '作答', qid: '题号', from: '原IP', auto: '自动',
  day: '日期', bytes: '字节', file: '文件', text: '内容', times: '次数',
  pkg: '包名', launchPkg: '启动项', version: '版本', reason: '说明',
  a11yOn: '无障碍', adminActive: '设备管理员', rate: '比例'
};

let DATA_DIR = '';
let LOG_DIR = '';
/** 写实时事件用的回调（由 app.js 注入 store.appendEvent），避免和 store 循环依赖 */
let appendEvent = () => {};

function init(dataDir, onEvent) {
  DATA_DIR = dataDir;
  LOG_DIR = path.join(dataDir, 'logs');
  if (typeof onEvent === 'function') appendEvent = onEvent;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* 目录建不出来时导出会报错，不影响主流程 */ }
}

const p2 = n => String(n).padStart(2, '0');

/** 服务端本地日期，和 store.today() 一致（容器里设了 TZ=Asia/Shanghai） */
function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${dayOf(ts)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function todayStr() {
  return dayOf(Date.now());
}

function yesterdayStr() {
  return dayOf(Date.now() - 24 * 3600 * 1000);
}

/**
 * 明细：认识的中文、不认识的原始键，字段一个不丢。
 *
 * 值里的换行统一转义成 \n：一条事件必须一行（不然 grep / 看行数全乱），
 * 而且写文件的校验是按字节数算的 —— 真换行会让「一条 = 一行」这个前提失效。
 */
function detail(e) {
  const parts = [];
  for (const k of Object.keys(e)) {
    if (k === 'ts' || k === 'type' || k === 'deviceId') continue;
    const v = e[k];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'boolean') { parts.push(`${FIELD_NAMES[k] || k}=${v ? '是' : '否'}`); continue; }
    if (typeof v === 'object') { parts.push(`${FIELD_NAMES[k] || k}=${oneLine(JSON.stringify(v))}`); continue; }
    parts.push(`${FIELD_NAMES[k] || k}=${oneLine(v)}`);
  }
  return parts.join(' ');
}

function oneLine(v) {
  return String(v).replace(/\r\n|\r|\n/g, '\\n');
}

/** 读取实时事件（按文件顺序，旧的在前）。轮转出来的 .1 一起算，避免归档前就被切掉 */
function readEvents() {
  const out = [];
  for (const name of ['events.jsonl.1', 'events.jsonl']) {
    const full = path.join(DATA_DIR, name);
    let raw = '';
    try { raw = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && ev.ts) out.push(ev);
      } catch (e) { /* 坏行跳过，不让半行 JSON 拖垮整个归档 */ }
    }
  }
  return out;
}

/** 原子写回实时事件：先写 .tmp 再 rename；老的 .1 一并清掉（内容已合并进来） */
function writeEvents(list) {
  const full = path.join(DATA_DIR, 'events.jsonl');
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, list.map(e => JSON.stringify(e)).join('\n') + (list.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, full);
  try { fs.unlinkSync(full + '.1'); } catch (e) { /* 没有就算了 */ }
}

function indexPath() {
  return path.join(LOG_DIR, 'index.json');
}

function readIndex() {
  try {
    const d = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch (e) {
    return {};
  }
}

function writeIndex(obj) {
  const tmp = indexPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, indexPath());
}

function dayFileName(day) {
  return `tvguard-${day}.log`;
}

/**
 * 导出一整天的事件到文件，成功后再把这一天从实时日志里删掉。
 *
 * @param {string} day  YYYY-MM-DD，默认昨天
 * @param {object} opt  { keep: true 时只导不删（手工补导时用） }
 */
function exportDay(day, opt) {
  const o = opt || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
    return { ok: false, error: '日期格式要 YYYY-MM-DD' };
  }
  const today = todayStr();
  if (day > today) return { ok: false, error: '不能导出未来的日期' };
  if (!LOG_DIR) return { ok: false, error: '日志目录未初始化' };

  const all = readEvents();
  const hit = all.filter(e => dayOf(e.ts) === day).sort((a, b) => a.ts - b.ts);
  if (!hit.length) return { ok: false, error: `${day} 没有日志记录` };

  const name = dayFileName(day);
  const full = path.join(LOG_DIR, name);
  const header = [
    `# TvGuard 运行日志 · ${day}`,
    `# 导出时间：${fmtTime(Date.now())}`,
    `# 记录数：${hit.length} 条（包含连接断开 / 连接恢复等全部事件）`,
    '# 字段：时间 | 类型 | 设备 | 详情 | 原始JSON',
    ''
  ];
  const lines = hit.map(e => [
    fmtTime(e.ts),
    EV_NAMES[e.type] || e.type,
    e.deviceId || '—',
    detail(e) || '—',
    JSON.stringify(e)
  ].join(' | '));
  const text = header.concat(lines).join('\n') + `\n# 结束：共 ${hit.length} 条\n`;

  // 先写临时文件，确认字节数对得上再改名，中途出错不会留下半个日志文件。
  // 注意别用「数行数」校验：早期版本这么干，遇到值里带换行的事件（截屏报错、
  // 服务端升级日志）就会误判成写失败，那一天的事件一直留在实时日志里删不掉。
  const tmp = full + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    const want = Buffer.byteLength(text, 'utf8');
    const got = fs.statSync(tmp).size;
    if (got !== want) {
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      return { ok: false, error: `写文件后校验不通过（${got}/${want} 字节），实时日志未删除` };
    }
    fs.renameSync(tmp, full);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    return { ok: false, error: '写文件失败：' + (e && e.message ? e.message : e) };
  }

  const st = fs.statSync(full);

  // 删除已导出的事件：只删这一天，今天的一条都不动
  let removed = 0;
  if (!o.keep && day < today) {
    const rest = all.filter(e => dayOf(e.ts) !== day);
    removed = all.length - rest.length;
    try {
      writeEvents(rest);
    } catch (e) {
      return { ok: false, error: '文件已生成，但从实时日志删除失败：' + (e && e.message ? e.message : e), file: name };
    }
  }

  const idx = readIndex();
  idx[day] = { count: hit.length, bytes: st.size, at: Date.now(), file: name };
  try { writeIndex(idx); } catch (e) { /* 索引写失败只是少了条数统计 */ }

  return { ok: true, day, count: hit.length, bytes: st.size, file: name, removed };
}

/** 归档列表（新的在前）。以磁盘为准，index.json 只补条数 */
function list() {
  const idx = readIndex();
  let names = [];
  try { names = fs.readdirSync(LOG_DIR).filter(n => /^tvguard-\d{4}-\d{2}-\d{2}\.log$/.test(n)); } catch (e) { names = []; }
  const files = names.map(n => {
    const full = path.join(LOG_DIR, n);
    let st = { size: 0, mtimeMs: 0 };
    try { st = fs.statSync(full); } catch (e) { /* ignore */ }
    const day = n.slice('tvguard-'.length, -'.log'.length);
    const meta = idx[day] || {};
    return {
      file: n,
      day,
      bytes: st.size,
      count: Number(meta.count) || 0,
      at: Number(meta.at) || st.mtimeMs || 0
    };
  }).sort((a, b) => (a.day < b.day ? 1 : -1));
  return files;
}

/** 文件名白名单校验：只允许归档目录里的 tvguard-YYYY-MM-DD.log */
function safePath(name) {
  const n = String(name || '');
  if (!/^tvguard-\d{4}-\d{2}-\d{2}\.log$/.test(n)) return '';
  return path.join(LOG_DIR, n);
}

function remove(name) {
  const full = safePath(name);
  if (!full || !fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  const day = path.basename(full).slice('tvguard-'.length, -'.log'.length);
  const idx = readIndex();
  if (idx[day]) { delete idx[day]; try { writeIndex(idx); } catch (e) { /* ignore */ } }
  return true;
}

/**
 * 补导出：把实时日志里所有「早于今天」的日期都导一遍。
 * 服务器重启 / 凌晨那会儿断过电，都能靠这一下补齐，不会漏掉某一天。
 */
function maybeArchive() {
  const today = todayStr();
  const all = readEvents();
  const days = new Set();
  for (const e of all) {
    const d = dayOf(e.ts);
    if (d < today) days.add(d);
  }
  const done = [];
  for (const d of Array.from(days).sort()) {
    const r = exportDay(d);
    if (r.ok) done.push(r);
    else if (r.error) console.log(`[tvguard] 日志归档跳过 ${d}：${r.error}`);
  }
  return done;
}

function runOnce(reason) {
  let done = [];
  try {
    done = maybeArchive();
  } catch (e) {
    console.log('[tvguard] 日志归档失败：' + (e && e.message ? e.message : e));
    return [];
  }
  for (const r of done) {
    console.log(`[tvguard] 日志已归档 ${r.day}：${r.count} 条 → ${r.file}（${r.bytes} 字节，已从实时日志删除 ${r.removed} 条）`);
    try {
      appendEvent({
        type: 'log_export',
        day: r.day,
        count: r.count,
        bytes: r.bytes,
        file: r.file,
        auto: reason !== 'manual'
      });
    } catch (e) { /* ignore */ }
  }
  return done;
}

let started = false;

/**
 * 启动定时任务：
 *   - 启动 5 秒后补一次（重启、断电后把落下的当天归档补上）；
 *   - 每天 00:05 导昨天（0 点刚过可能还有最后一秒的心跳在写，留 5 分钟缓冲）；
 *   - 每小时兜底一次，防止长时间运行后系统时间被调整错过定时。
 */
function start() {
  if (started) return;
  started = true;
  setTimeout(() => runOnce('boot'), 5000).unref?.();

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0, 0);
    const wait = Math.max(60 * 1000, next.getTime() - now.getTime());
    const t = setTimeout(() => { runOnce('daily'); scheduleNext(); }, wait);
    t.unref?.();
  };
  scheduleNext();

  const hourly = setInterval(() => runOnce('tick'), 60 * 60 * 1000);
  hourly.unref?.();
}

module.exports = {
  init,
  start,
  runOnce,
  exportDay,
  list,
  remove,
  safePath,
  maybeArchive,
  dayOf,
  todayStr,
  yesterdayStr,
  LOG_DIR: () => LOG_DIR
};
