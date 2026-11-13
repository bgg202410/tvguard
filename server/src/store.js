'use strict';

/**
 * 极简持久化层：零依赖，全部落在 JSON 文件上。
 *
 * 为什么不用 SQLite / MariaDB：
 *   - 这套系统只管一台电视、一个孩子。数据量是「几百条题目 + 一年几千条事件」，
 *     JSON 全量读入内存毫无压力；
 *   - 零依赖意味着镜像小（约 60MB）、构建不需要外网 npm、备份就是拷文件夹；
 *   - 真要换 SQLite，只需要把本文件替换掉，上层 API 不用改。
 *
 * 写入用「临时文件 + rename」原子替换，避免断电时留下半个 JSON。
 */

const fs = require('fs');
const path = require('path');
const { normalizeSubjects, normalizeQuizGrade } = require('./subjects');
const { DEFAULT_HEARTBEAT_SEC } = require('./config');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Docker 默认用 bridge 网络 + 端口映射，外部请求进容器时源地址
// 会被 MASQUERADE 成 Docker 网桥网关（例如 172.23.0.1）。服务端如果把这个地址
// 当成电视 IP 存下来，adb 去连「网关:5555」必然失败 —— 电视的 ADB 其实开着。
// 解决：优先用电视自己上报的局域网 IP，其次才用观察到的来源 IP；网关地址只记录
// 到 natIp 供自检说明根因，绝不覆盖已有的可用 IP。家长也可以在后台手动指定。

/** 规整并校验 IPv4，非法返回空串 */
function isLanIp(v) {
  const s = String(v == null ? '' : v).replace(/^::ffff:/, '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return '';
  const p = s.split('.').map(Number);
  if (p.some(n => n > 255)) return '';
  if (s === '127.0.0.1' || s === '0.0.0.0' || (p[0] === 169 && p[1] === 254)) return '';
  return s;
}

/** 是不是 Docker / 路由器的网关地址（末位 .1 且落在常见内网段） */
function isBridgeGateway(v) {
  const s = isLanIp(v);
  if (!s) return false;
  const [a, b, , d] = s.split('.').map(Number);
  if (d !== 1) return false;
  return (a === 172 && b >= 16 && b <= 31) || a === 10 || (a === 192 && b === 168);
}

/**
 * 真正拿去 adb 连接的地址。
 * 注意优先级：lastIp（电视每 30 秒上报，会随 DHCP 变化自动更新）最权威，
 * fixedIp 只是「电视还没上报过」时的播种值，绝不长期压住上报值 —— 否则
 * 电视换了 IP 反而会一直连旧地址。网关地址一律排除。
 */
function effectiveIp(d) {
  if (!d) return '';
  const last = isLanIp(d.lastIp);
  if (last && !isBridgeGateway(last)) return last;
  const fixed = isLanIp(d.fixedIp);
  if (fixed && !isBridgeGateway(fixed)) return fixed;
  return '';
}

/** 设备管理员指令的有效期：电视当时关着就挂着，超过这段时间自动作废 */
const ADMIN_CMD_TTL = 30 * 60 * 1000;

function file(name) {
  return path.join(DATA_DIR, name);
}

function readJson(name, def) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    return def;
  }
}

function writeJson(name, obj) {
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file(name));
}

const DEFAULT_POLICY = {
  dailyLimitMin: 120,   // 每日额度
  quizIntervalMin: 10,  // 答题间隔
  passBonusMin: 10,     // ⚠️ 已废弃：答题不再发放时长，保留字段只为兼容老 policy.json
  // 出题范围：三项都「不限 / 不勾」= 全部题目随机抽（仍按错题>未答>已答加权）
  difficulty: 0,        // 0 不限 / 1 简单 / 2 中等 / 3 挑战
  quizGrade: 0,         // 0 不限 / 1~6 该年级题（通用题是否混入由 quizIncludeGeneral 决定）
  quizIncludeGeneral: false,  // true = 通用题与所选年级的题一起随机抽；false = 不抽通用题
  subjects: [],         // 空 = 不限（全库）；非空 = 只在这几科里抽
  quizMode: 'single',   // single = 答对一题即放行 / group = 整组达标才放行
  groupSize: 5,         // group 模式：一组几道
  groupPassRate: 60,    // group 模式：正确率达到多少算过
  useStarBonus: false,  // ⚠️ 已废弃（同上）
  starBonus: [1, 1, 2, 3, 5],  // ⚠️ 已废弃（同上）
  schedule: { mode: 'off', days: [] },  // 时段管控，days 为空表示全时段开放
  wrongPolicy: 'retry', // 答错怎么走：retry = 重答到对才放行 / pass = 答错也放行
  wrongBoostRate: 40,   // 出题时优先抽错题的概率（百分比），0 = 不优先
  wrongGraduate: 2,     // 错题连续答对几次就算学会、移出错题库
  // 桌面拦截：孩子一回到系统桌面就把他送回守时桌面（等价于吃掉遥控器主页键）。
  // 依赖电视的无障碍服务，没开的时候这个开关等于无效。
  desktopGuard: true,
  // 时长用完之后再答题换时间（默认关闭）。
  // 注意：这是「用完之后的续命」，不是在基础额度内随便加时间 ——
  // 所以孩子答得再多也只能多拿 rewardMin * rewardTimes 分钟，当天到此为止。
  rewardEnabled: false,   // 开关
  rewardQuizCount: 10,    // 答对几题换一次
  rewardMin: 10,          // 一次换几分钟
  rewardTimes: 2,         // 每天最多换几次（合计上限 = rewardMin * rewardTimes）
  enabled: true         // 总开关，false = 暂停管控
};

const SCHEDULE_MODES = ['off', 'block', 'quizOnly'];
const SLOTS_PER_DAY = 48;   // 48 个 30 分钟格子

/** 时段表规范化：7 天 × 48 格，'1' 可用 / '0' 不可用。缺的按"全天可用"补。 */
function normalizeSchedule(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const mode = SCHEDULE_MODES.includes(s.mode) ? s.mode : 'off';
  const days = [];
  for (let d = 0; d < 7; d++) {
    const one = Array.isArray(s.days) ? s.days[d] : null;
    if (typeof one === 'string' && /^[01]{48}$/.test(one)) {
      days.push(one);
    } else if (Array.isArray(one)) {
      days.push(Array.from({ length: SLOTS_PER_DAY }, (_, i) => (one[i] ? '1' : '0')).join(''));
    } else {
      days.push('1'.repeat(SLOTS_PER_DAY));
    }
  }
  return { mode, days };
}

/** 当前时刻是否在允许时段内。off 模式永远算在时段内。 */
function slotNow(now) {
  const t = new Date(now == null ? Date.now() : now);
  return { day: (t.getDay() + 6) % 7, slot: Math.floor((t.getHours() * 60 + t.getMinutes()) / 30) };
}

function inSchedule(schedule, now) {
  const s = normalizeSchedule(schedule);
  if (s.mode === 'off') return { active: true, mode: 'off' };
  const { day, slot } = slotNow(now);
  const active = s.days[day][slot] === '1';
  return { active, mode: s.mode, day, slot };
}

/** 从当前时刻往后找最近一个可用格，给"下次可用时间"提示用 */
function nextActiveAt(schedule, now) {
  const s = normalizeSchedule(schedule);
  if (s.mode === 'off') return null;
  const base = now == null ? Date.now() : now;
  const start = new Date(base);
  const halfHour = 30 * 60 * 1000;
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate(),
    start.getHours(), start.getMinutes() < 30 ? 30 : 0, 0, 0);
  if (start.getMinutes() >= 30) cur.setHours(cur.getHours() + 1);
  for (let i = 0; i < 7 * 48; i++) {
    const { day, slot } = slotNow(cur.getTime());
    if (s.days[day][slot] === '1') return cur.getTime();
    cur.setTime(cur.getTime() + halfHour);
  }
  return null;
}

const state = {
  policy: Object.assign({}, DEFAULT_POLICY, readJson('policy.json', {})),
  devices: readJson('devices.json', {}),
  questions: readJson('questions.json', []),
  // 错题本：{ [qid]: { n: 答错次数, streak: 之后连对次数, subject, lastAt } }
  wrong: readJson('wrong.json', {}),
  // 题目维度作答统计：{ [qid]: { served, right, wrong, lastAt } }
  // 用来实现「错题 > 未答 > 已答」的出题权重；和错题本独立，删错题不影响已答记录
  qstats: readJson('qstats.json', {}),
  // 留言栏：家长在后台写一句话，推到电视桌面上显示；null = 没有留言
  notice: readJson('notice.json', null)
};

// 老数据兼容：「仅通用题」(-1) 这个选项已从界面拿掉，启动时统一回落成不限年级
if (state.policy.quizGrade === -1) state.policy.quizGrade = 0;
state.policy.quizIncludeGeneral = !!state.policy.quizIncludeGeneral;

const store = {
  DATA_DIR,

  get policy() {
    return state.policy;
  },

  /** 当前留言（给后台回显）。null = 没有留言 */
  get notice() {
    return state.notice;
  },

  /**
   * 给电视下发的留言（心跳里用）。
   * 家长可以提前写好、定时到以后某天：没到那天的留言不下发，
   * 但后台照样能回显、能改、能清空。到那天之后一直有效，直到清空或换内容。
   */
  get activeNotice() {
    const n = state.notice;
    if (!n || (n.day && n.day > today())) return null;
    return n;
  },

  /** 服务端本地日期，给后台判断「这条留言是待生效还是已在显示」 */
  get serverToday() { return today(); },

  /**
   * 设置留言。空字符串 = 清除。
   *
   * 每次推送都换一个新 id：电视端按 id 记住「这条我看过、点掉了」，
   * 没有新 id 的话家长改完内容、孩子那条仍然关着，会觉得推送没生效。
   *
   * @param {string} day 显示日期 YYYY-MM-DD（只到天），默认服务端今天
   */
  setNotice(text, day) {
    const t = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim().slice(0, 200);
    if (!t) {
      state.notice = null;
      writeJson('notice.json', null);
      return null;
    }
    const raw = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : today();
    // 后台只允许选今天及以后；接口被绕过传了过去的日期也一律回落到今天
    const d = raw < today() ? today() : raw;
    const n = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: t,
      at: Date.now(),
      day: d
    };
    state.notice = n;
    writeJson('notice.json', n);
    return n;
  },

  savePolicy(patch) {
    Object.assign(state.policy, patch);
    // 范围兜底，防前端或接口传进离谱的值
    state.policy.dailyLimitMin = clamp(state.policy.dailyLimitMin, 10, 720);
    state.policy.quizIntervalMin = clamp(state.policy.quizIntervalMin, 1, 120);
    state.policy.passBonusMin = clamp(state.policy.passBonusMin, 1, 120);
    state.policy.difficulty = clamp(state.policy.difficulty, 0, 3);
    state.policy.quizGrade = normalizeQuizGrade(state.policy.quizGrade);
    // 老数据里 quizGrade=-1 表示「仅通用题」，该选项已从界面上拿掉，统一回落成不限年级
    if (state.policy.quizGrade === -1) state.policy.quizGrade = 0;
    state.policy.quizIncludeGeneral = !!state.policy.quizIncludeGeneral;
    // 学科「一个都不勾」是有意义的：表示不限学科、全库随机。
    // 只有非空数组才做合法 key 校验，别让 normalizeSubjects 的空数组回落把语义吃掉。
    state.policy.subjects = Array.isArray(state.policy.subjects) && state.policy.subjects.length === 0
      ? []
      : normalizeSubjects(state.policy.subjects);
    state.policy.quizMode = state.policy.quizMode === 'group' ? 'group' : 'single';
    state.policy.groupSize = clamp(state.policy.groupSize, 1, 20);
    state.policy.groupPassRate = clamp(state.policy.groupPassRate, 1, 100);
    state.policy.useStarBonus = !!state.policy.useStarBonus;
    state.policy.starBonus = normalizeStarBonus(state.policy.starBonus);
    state.policy.schedule = normalizeSchedule(state.policy.schedule);
    state.policy.wrongPolicy = state.policy.wrongPolicy === 'pass' ? 'pass' : 'retry';
    state.policy.wrongBoostRate = clamp(state.policy.wrongBoostRate, 0, 100);
    state.policy.wrongGraduate = clamp(state.policy.wrongGraduate, 1, 10);
    state.policy.desktopGuard = !!state.policy.desktopGuard;
    state.policy.rewardEnabled = !!state.policy.rewardEnabled;
    state.policy.rewardQuizCount = clamp(state.policy.rewardQuizCount, 1, 100);
    state.policy.rewardMin = clamp(state.policy.rewardMin, 1, 120);
    state.policy.rewardTimes = clamp(state.policy.rewardTimes, 1, 10);
    state.policy.enabled = !!state.policy.enabled;
    writeJson('policy.json', state.policy);
    return state.policy;
  },

  // ------------------------------------------------------------ 题目作答统计

  get qstats() {
    return state.qstats;
  },

  qstatOf(qid) {
    return state.qstats[qid] || null;
  },

  /** 题目被出过一次（还没作答也算） */
  markServed(qid) {
    if (!qid) return;
    const s = state.qstats[qid] || { served: 0, right: 0, wrong: 0, lastAt: 0 };
    s.served = (s.served || 0) + 1;
    s.lastAt = Date.now();
    state.qstats[qid] = s;
    writeJson('qstats.json', state.qstats);
  },

  /** 作答结果：答对次数越多，这道题以后越不容易再出现 */
  markAnswered(qid, correct) {
    if (!qid) return;
    const s = state.qstats[qid] || { served: 0, right: 0, wrong: 0, lastAt: 0 };
    if (correct) s.right = (s.right || 0) + 1;
    else s.wrong = (s.wrong || 0) + 1;
    s.lastAt = Date.now();
    state.qstats[qid] = s;
    writeJson('qstats.json', state.qstats);
  },

  /** 删题时顺手清掉统计，避免 qstats.json 无限膨胀 */
  dropQstat(qid) {
    if (!state.qstats[qid]) return;
    delete state.qstats[qid];
    writeJson('qstats.json', state.qstats);
  },

  /**
   * 手动清掉某道题的出题记录（题本身留着）。
   * 效果 = 当作从没出过：lastAt 归零后立刻重新进入「没出过」的优先池，
   * 答对次数也一起清掉，权重回到未答档。
   */
  resetQstat(qid) {
    if (!qid || !state.qstats[qid]) return false;
    delete state.qstats[qid];
    writeJson('qstats.json', state.qstats);
    return true;
  },

  // ------------------------------------------------------------ 错题本

  get wrong() {
    return state.wrong;
  },

  /** 答错：记一次，连对计数清零 */
  markWrong(qid, subject) {
    if (!qid) return;
    const w = state.wrong[qid] || { n: 0, streak: 0, subject: subject || 'math' };
    w.n += 1;
    w.streak = 0;
    w.subject = subject || w.subject || 'math';
    w.lastAt = Date.now();
    state.wrong[qid] = w;
    writeJson('wrong.json', state.wrong);
  },

  /**
   * 答对：连对达到 wrongGraduate 次就移出错题库。
   * 不在错题本里的题答对了不写入 —— 只关心错过的题什么时候学会。
   */
  markRight(qid) {
    const w = state.wrong[qid];
    if (!w) return;
    w.streak = (w.streak || 0) + 1;
    w.lastAt = Date.now();
    if (w.streak >= clamp(this.effectivePolicy(null).wrongGraduate, 1, 10)) delete state.wrong[qid];
    writeJson('wrong.json', state.wrong);
  },

  dropWrong(qid) {
    if (!state.wrong[qid]) return false;
    delete state.wrong[qid];
    writeJson('wrong.json', state.wrong);
    return true;
  },

  /** 错题本条目，按错次数、最近出错排序 */
  wrongList() {
    return Object.keys(state.wrong)
      .map(qid => {
        const w = state.wrong[qid];
        const q = state.questions.find(x => x.id === qid);
        return {
          id: qid,
          subject: w.subject,
          times: w.n,
          streak: w.streak || 0,
          lastAt: w.lastAt || 0,
          prompt: q ? q.prompt : '（题目已删除）',
          answer: q ? q.answer : '',
          level: q ? q.level : 0,
          exists: !!q
        };
      })
      .sort((a, b) => b.times - a.times || b.lastAt - a.lastAt);
  },

  /** 每科有多少道错题，给后台卡片和出题用 */
  wrongCountBySubject() {
    const out = {};
    for (const qid of Object.keys(state.wrong)) {
      const s = state.wrong[qid].subject || 'math';
      out[s] = (out[s] || 0) + 1;
    }
    return out;
  },

  /**
   * 当前是否在允许时段内（按该设备的最终策略算）。
   *
   * **必须把整张时段表（days）一起下发**：电视端要靠它自己判断「现在能不能弹题」，
   * 不然只能永远认为"在时段内"。2026-11 那版漏了 days，直接表现为
   * 「没设中午时段，中午照样弹题」—— 电视端拿不到表就按"全天可用"处理了。
   */
  scheduleState(deviceId, now) {
    const pol = this.effectivePolicy(deviceId);
    const sched = normalizeSchedule(pol.schedule);
    const st = inSchedule(sched, now);
    return Object.assign(st, {
      days: sched.days,
      nextAt: st.active ? null : nextActiveAt(sched, now)
    });
  },

  /** group 模式下的本组进度。放服务端，电视端无状态，断电换机都不丢。 */
  groupState(deviceId) {
    const d = state.devices[deviceId];
    if (!d) return { asked: 0, correct: 0, stars: 0 };
    const size = this.effectivePolicy(deviceId).groupSize;
    if (!d.group || d.group.size !== size) {
      d.group = { size, asked: 0, correct: 0, stars: 0, startedAt: Date.now() };
    }
    return d.group;
  },

  /** 记一道题的作答结果，返回是否刚好完成一组、以及本组正确率与累计星级 */
  advanceGroup(deviceId, correct, stars) {
    const d = state.devices[deviceId];
    if (!d) return { finished: false };
    const g = this.groupState(deviceId);
    g.asked += 1;
    if (correct) {
      g.correct += 1;
      g.stars += Number(stars) || 0;
    }
    const finished = g.asked >= g.size;
    const rate = g.asked ? Math.round(g.correct / g.asked * 100) : 0;
    const answered = g.asked;
    const sumStars = g.stars;
    if (finished) d.group = { size: g.size, asked: 0, correct: 0, stars: 0, startedAt: Date.now() };
    writeJson('devices.json', state.devices);
    return { finished, rate, size: g.size, asked: answered, correct: g.correct, sumStars };
  },

  get questions() {
    return state.questions;
  },

  /** 设备表。外部只读，写入走 touchDevice / updateDevice */
  get devices() {
    return state.devices;
  },

  getDevice(deviceId) {
    return state.devices[deviceId] || null;
  },

  saveQuestions() {
    writeJson('questions.json', state.questions);
  },

  /** 设备维度的最终策略：全局策略 + 该设备的覆盖项 */
  effectivePolicy(deviceId) {
    const d = state.devices[deviceId];
    const override = (d && d.override) || {};
    return Object.assign({}, state.policy, override);
  },

  /** 注册/更新设备心跳。首次见到自动建档，name 默认用型号。 */
  touchDevice(deviceId, info) {
    const now = Date.now();
    let d = state.devices[deviceId];
    if (!d) {
      d = state.devices[deviceId] = {
        id: deviceId,
        name: (info && info.model) || '未命名电视',
        model: (info && info.model) || '',
        appVersion: (info && info.appVersion) || '',
        firstSeen: now,
        lastSeen: now,
        override: {},
        stats: newStats(),
        apps: [],        // 电视上报的已装应用
        appsAt: 0,       // 上次上报时间
        launchPkg: '',   // 启动后直接进入哪个应用；空 = 显示守时桌面
        // 设备管理员（保活用）：状态只能由电视上报，指令只能由后台下发
        adminActive: false,
        adminAt: 0,
        adminCmd: '',    // 'on' / 'off'，电视执行完自动清空
        adminCmdAt: 0,
        // 电视上报的失败原因：no_ui = 系统里没有设备管理员界面（拉不起确认框）
        adminError: '',
        // 无障碍服务：桌面拦截完全靠它，电视上报真实状态，后台据此提示要不要开
        a11yOn: false,
        a11yAt: 0,
        // 保活自动修复：电视的 IP + 最近一次 adb 修复的结果
        // fixedIp = 家长手动指定；natIp = Docker 网桥网关（只用于诊断，不拿来连）
        lastIp: '',
        fixedIp: '',
        natIp: '',
        ipSource: '',
        fixAt: 0,
        fixOk: false,
        fixError: '',
        fixTarget: '',
        // 离线自动唤醒：App 被杀后 adb am start 拉回前台的结果
        reviveAt: 0,
        reviveOk: false,
        reviveError: '',
        // 心跳间隔（秒）：客户端请求管理端的连接间隔，每设备独立配置（一对多）
        heartbeatSec: DEFAULT_HEARTBEAT_SEC,
        // 在线状态机：watcher 据此在「连接断开 / 恢复」翻转时各记一次事件，避免刷屏
        onlineState: 'online'
      };
    } else {
      d.lastSeen = now;
      if (info && info.model) d.model = info.model;
      if (info && info.appVersion) d.appVersion = info.appVersion;
      if (!d.stats || d.stats.date !== today()) {
        d.stats = newStats();
        // 刚跨天：接下来几分钟不采信电视报上来的「今日累计绝对值」。
        // 老版本 App 不带 day 字段，它手里那份是昨天的数，一采信就把统计顶回去了
        d.stats.rolledAt = now;
      }
      ensureStats(d);
      // 老数据没有这三个字段，补上，避免前端 undefined
      if (!Array.isArray(d.apps)) d.apps = [];
      if (typeof d.appsAt !== 'number') d.appsAt = 0;
      if (typeof d.launchPkg !== 'string') d.launchPkg = '';
      if (typeof d.adminActive !== 'boolean') d.adminActive = false;
      if (typeof d.adminAt !== 'number') d.adminAt = 0;
      if (typeof d.adminCmd !== 'string') d.adminCmd = '';
      if (typeof d.adminCmdAt !== 'number') d.adminCmdAt = 0;
      if (typeof d.adminError !== 'string') d.adminError = '';
      if (typeof d.a11yOn !== 'boolean') d.a11yOn = false;
      if (typeof d.a11yAt !== 'number') d.a11yAt = 0;
      if (typeof d.lastIp !== 'string') d.lastIp = '';
      if (typeof d.fixedIp !== 'string') d.fixedIp = '';
      if (typeof d.natIp !== 'string') d.natIp = '';
      if (typeof d.ipSource !== 'string') d.ipSource = '';
      if (typeof d.fixAt !== 'number') d.fixAt = 0;
      if (typeof d.fixOk !== 'boolean') d.fixOk = false;
      if (typeof d.fixError !== 'string') d.fixError = '';
      if (typeof d.fixTarget !== 'string') d.fixTarget = '';
      if (typeof d.reviveAt !== 'number') d.reviveAt = 0;
      if (typeof d.reviveOk !== 'boolean') d.reviveOk = false;
      if (typeof d.reviveError !== 'string') d.reviveError = '';
      if (typeof d.heartbeatSec !== 'number') d.heartbeatSec = DEFAULT_HEARTBEAT_SEC;
      if (d.onlineState !== 'online' && d.onlineState !== 'offline') d.onlineState = 'online';
    }
    writeJson('devices.json', state.devices);
    return d;
  },

  /** 电视上报已装应用清单（每次 App 启动时发一次，家长装了新软件后能同步过来） */
  setApps(deviceId, list) {
    const d = state.devices[deviceId];
    if (!d) return null;
    const seen = new Set();
    d.apps = (Array.isArray(list) ? list : [])
      .map(a => ({
        pkg: String((a && a.pkg) || '').slice(0, 120),
        label: String((a && a.label) || '').slice(0, 60),
        act: String((a && a.act) || '').slice(0, 200)
      }))
      .filter(a => a.pkg && a.label && !seen.has(a.pkg) && seen.add(a.pkg))
      .sort((x, y) => x.label.localeCompare(y.label, 'zh-CN'));
    d.appsAt = Date.now();
    // 配了启动项但应用被卸载了：自动清空，否则电视会卡在"启动项打不开"
    if (d.launchPkg && !d.apps.some(a => a.pkg === d.launchPkg)) d.launchPkg = '';
    writeJson('devices.json', state.devices);
    return d;
  },

  updateDevice(deviceId, patch) {
    const d = state.devices[deviceId];
    if (!d) return null;
    if (typeof patch.name === 'string') d.name = patch.name.slice(0, 40);
    if (patch.override && typeof patch.override === 'object') {
      d.override = normalizeOverride(patch.override);
    }
    // 启动项：只接受上报清单里存在的包名，空串表示"显示守时桌面"
    if (typeof patch.launchPkg === 'string') {
      const pkg = patch.launchPkg.trim();
      if (!pkg) d.launchPkg = '';
      else if ((d.apps || []).some(a => a.pkg === pkg)) d.launchPkg = pkg;
    }
    // 心跳间隔（秒）：每设备独立配置，夹到 1..120 防止填错把系统搞挂
    if (typeof patch.heartbeatSec === 'number') {
      d.heartbeatSec = Math.min(120, Math.max(1, Math.round(patch.heartbeatSec)));
    }
    writeJson('devices.json', state.devices);
    return d;
  },

  devicesList() {
    return Object.values(state.devices).sort((a, b) => b.lastSeen - a.lastSeen);
  },

  // ------------------------------------------------------------ 设备管理员（保活用）

  /**
   * 设备管理员现在的样子，给 session / 后台用。
   *
   * `cmd` 是有有效期的：家长点了「激活」但电视当时关着，指令挂 30 分钟；
   * 过了就作废，免得第二天开机突然弹一个没人记得的确认框。
   */
  adminState(deviceId) {
    const d = state.devices[deviceId];
    if (!d) return { active: false, cmd: '', at: 0, pending: false, error: '' };
    const fresh = d.adminCmd && Date.now() - (d.adminCmdAt || 0) < ADMIN_CMD_TTL;
    const cmd = fresh ? d.adminCmd : '';
    return {
      active: !!d.adminActive,
      cmd,
      at: d.adminCmdAt || 0,
      pending: !!cmd && ((cmd === 'on') !== !!d.adminActive),
      error: d.adminError || ''
    };
  },

  /**
   * 后台下发指令。已经是目标状态就直接返回，不下发 ——
   * 否则电视会白弹一次系统确认框。
   */
  setAdminCmd(deviceId, action) {
    const d = state.devices[deviceId];
    if (!d) return null;
    if (action === 'cancel') {
      d.adminCmd = '';
      d.adminCmdAt = 0;
      writeJson('devices.json', state.devices);
      return this.adminState(deviceId);
    }
    const cmd = action === 'on' ? 'on' : action === 'off' ? 'off' : '';
    if (!cmd) return this.adminState(deviceId);
    // 已经是这个状态：不用下发了，顺手把残留指令清掉
    if ((cmd === 'on') === !!d.adminActive) {
      d.adminCmd = '';
      d.adminCmdAt = 0;
      writeJson('devices.json', state.devices);
      return this.adminState(deviceId);
    }
    d.adminCmd = cmd;
    d.adminCmdAt = Date.now();
    writeJson('devices.json', state.devices);
    return this.adminState(deviceId);
  },

  /**
   * 电视上报「无障碍服务开没开」。
   *
   * 桌面拦截没有它就是个空开关，所以后台必须能看见真实状态 ——
   * 家长在电视上找不到入口（这台 TCL 把设置页裁了），只能照后台给的命令用电脑开。
   */
  setA11y(deviceId, on) {
    const d = state.devices[deviceId];
    if (!d) return null;
    d.a11yOn = !!on;
    d.a11yAt = Date.now();
    writeJson('devices.json', state.devices);
    return { on: d.a11yOn, at: d.a11yAt };
  },

  /**
   * 记下电视的 IP。observedIp 是请求来源（Docker 下往往是网关），
   * reportedIp 是电视自己读到的局域网 IP（可信，优先用）。
   */
  setDeviceIp(deviceId, observedIp, reportedIp) {
    const d = state.devices[deviceId];
    if (!d) return;
    const obs = isLanIp(observedIp);
    const rep = isLanIp(reportedIp);
    const reported = rep && !isBridgeGateway(rep) ? rep : '';
    const good = reported || (obs && !isBridgeGateway(obs) ? obs : '');
    const oldIp = d.lastIp;
    let changed = false;
    if (good) {
      if (d.lastIp !== good) { d.lastIp = good; changed = true; }
      const src = reported ? 'reported' : 'observed';
      if (d.ipSource !== src) { d.ipSource = src; changed = true; }
      if (d.natIp) { d.natIp = ''; changed = true; }
      // 电视能自己报 IP 了：手动播种值退休，之后 DHCP 换 IP 会自动跟随，
      // 不会卡在家长当初填的那个地址上。
      if (reported && d.fixedIp) { d.fixedIp = ''; changed = true; }
    } else if (obs && isBridgeGateway(obs) && d.natIp !== obs) {
      // 只留证据给自检，绝不覆盖之前已经拿到的可用 IP
      d.natIp = obs;
      changed = true;
    }
    if (changed) {
      writeJson('devices.json', state.devices);
      // IP 变了记一条，后台「最近事件」能看出电视换过网段
      if (good && oldIp && oldIp !== good) {
        store.appendEvent({ type: 'device_ip', deviceId, ip: good, from: oldIp, auto: true });
      }
    }
  },

  /** 家长在后台手动指定电视 IP；传空串恢复自动识别 */
  setFixedIp(deviceId, ip) {
    const d = state.devices[deviceId];
    if (!d) return null;
    const v = String(ip == null ? '' : ip).trim();
    if (!v) {
      d.fixedIp = '';
      // 手动播种时 lastIp 也被写成了手动值，不清掉的话「恢复自动识别」形同没点
      if (d.ipSource === 'manual') {
        d.lastIp = '';
        d.ipSource = '';
      }
    } else {
      const clean = isLanIp(v);
      if (!clean) throw new Error('IP 格式不对，填类似 192.168.1.73 的局域网地址');
      if (isBridgeGateway(clean)) throw new Error('这是 Docker 网桥/路由器网关地址，不是电视 IP');
      d.fixedIp = clean;
      d.lastIp = clean;          // 立刻生效，不用等下一次心跳
      d.natIp = '';
      d.ipSource = 'manual';
    }
    writeJson('devices.json', state.devices);
    return effectiveIp(d);
  },

  /** 记录一次保活自动修复的结果，设备卡上要展示 */
  recordFix(deviceId, ok, error, target) {
    const d = state.devices[deviceId];
    if (!d) return null;
    d.fixAt = Date.now();
    d.fixOk = !!ok;
    d.fixError = ok ? '' : String(error || '').slice(0, 200);
    if (target) d.fixTarget = String(target).slice(0, 40);
    writeJson('devices.json', state.devices);
    return d;
  },

  /** 记录一次离线自动唤醒（adb am start 拉回前台）的结果 */
  recordRevive(deviceId, ok, error) {
    const d = state.devices[deviceId];
    if (!d) return null;
    d.reviveAt = Date.now();
    d.reviveOk = !!ok;
    d.reviveError = ok ? '' : String(error || '').slice(0, 200);
    writeJson('devices.json', state.devices);
    return d;
  },

  /**
   * 离线判定窗口（毫秒）：超过「最后一次心跳 + 这个窗口」没消息，视为连接断开。
   *
   * = 心跳间隔的 2 倍（无障碍 / 设备管理员修复也用同一档时间），最小 8 秒，
   * 避免单次网络抖动误判。每台电视按自己的 heartbeatSec 算，互不干扰（一对多）。
   * overview 的「在线」徽标和 watcher 的拉起判定共用它，保证前后端一致。
   */
  offlineWindowMs(d) {
    const sec = (d && d.heartbeatSec) || DEFAULT_HEARTBEAT_SEC;
    return Math.max(8000, sec * 2 * 1000);
  },

  /**
   * 电视上报「本机设备管理员是否激活」。
   *
   * 只有这条路能改状态：服务端没有任何办法知道电视上那个开关到底开没开，
   * 也没办法远程替它打开（系统安全限制）。指令和实际上报对上了就清掉指令。
   *
   * @param ackedAt 电视处理过哪条指令的时间戳（回执）。家长点了「取消」没激活时，
   *                状态没变，但指令已经问过了 —— 靠这个回执清掉，不然会反复弹窗。
   * @param error   执行失败原因，目前只有 no_ui（这台电视的系统设置里没有设备管理员界面）
   */
  setAdminState(deviceId, active, ackedAt, error) {
    const d = state.devices[deviceId];
    if (!d) return null;
    d.adminActive = !!active;
    d.adminAt = Date.now();
    if (typeof error === 'string') d.adminError = error.slice(0, 40);
    // 已经激活了，之前那条「开不了」的提示就该消失
    if (d.adminActive) d.adminError = '';
    const acked = Number(ackedAt) || 0;
    const matched = (d.adminCmd === 'on' && d.adminActive) || (d.adminCmd === 'off' && !d.adminActive);
    const asked = acked > 0 && acked >= (d.adminCmdAt || 0);
    if (d.adminCmd && (matched || asked)) {
      d.adminCmd = '';
      d.adminCmdAt = 0;
    }
    writeJson('devices.json', state.devices);
    return this.adminState(deviceId);
  },

  /** 电视端上报：把「本轮新看的毫秒数」累加进当天统计 */
  report(deviceId, payload) {
    const d = this.touchDevice(deviceId, payload);
    const addMs = clamp(Number(payload.watchedMsDelta) || 0, 0, 12 * 3600 * 1000);
    d.stats.watchedMs += addMs;

    /**
     * 绝对值校准（自愈）：客户端把「今天一共看了多少」一起报上来。
     *
     * 为什么要这一步：增量上报靠心跳送，TCL 这类 ROM 20~30 秒杀一次进程，
     * 被杀前没送出去的增量以前直接丢了（实测本地 102 分钟、管理端 68 分钟）。
     * 现在增量已落盘重发，这里再加一道保险 —— 服务端只认「比自己的大」的值，
     * 一次心跳就把差额补回来，永远不会重复累加。
     *
     * 家长点「重置今日」后的 5 分钟内不采信绝对值：那会儿电视端的累计还没
     * 跟着回落到 0（要等下一次会话刷新），采信了等于把重置撤销掉。
     */
    const total = Number(payload.watchedMsTotal);
    // 「家长点重置」和「刚跨天」两种情况下都不采信电视报上来的绝对值
    const resetAt = Math.max(Number(d.stats.resetAt) || 0, Number(d.stats.rolledAt) || 0);
    /**
     * 电视端自己的日期。**必须对上服务端的今天才认绝对值**。
     *
     * 之前只比大小，结果「电视端没跨天、服务端已经跨天」时，电视把昨天的 90 分钟
     * 当成今天的一路顶回去，第二天早上打开电视显示的还是昨天的用量。
     * 老版本 App 不带 day 字段（空串），仍然按老逻辑放行，兼容它。
     */
    const clientDay = String(payload.day || '').trim();
    const dayOk = !clientDay || clientDay === d.stats.date;
    if (dayOk && Number.isFinite(total) && total > 0 && Date.now() - resetAt > 5 * 60_000) {
      const capped = clamp(total, 0, 12 * 3600 * 1000);
      if (capped > d.stats.watchedMs) d.stats.watchedMs = capped;
    }

    d.stats.quizCount = Number(payload.quizCount) || d.stats.quizCount;
    d.stats.passCount = Number(payload.passCount) || d.stats.passCount;
    writeJson('devices.json', state.devices);
    return d;
  },

  /**
   * 把某台电视的「今天」重新开始。
   *
   * 家长偶尔需要：白天测得多了、或者想让孩子下午重新计时。
   * 只清今天的统计，不动策略和题库。电视端下次拉 session 时
   * 会发现自己记的比服务端多，自动跟服务端对齐（见 Remote.syncLocalUsage）。
   */
  resetToday(deviceId) {
    const d = state.devices[deviceId];
    if (!d) return null;
    d.stats = newStats();
    // 记下重置时间：接下来 5 分钟内不采信电视报上来的「今日累计绝对值」，
    // 否则电视端还没回落到 0 的那次上报会把重置撤销掉
    d.stats.resetAt = Date.now();
    writeJson('devices.json', state.devices);
    return d.stats;
  },

  /** 删除设备（测试条目 / 已弃用的电视）。它的截图目录由接口层顺带清理。 */
  removeDevice(deviceId) {
    if (!state.devices[deviceId]) return false;
    delete state.devices[deviceId];
    writeJson('devices.json', state.devices);
    return true;
  },

  // ------------------------------------------------------------ 时长奖励

  /**
   * 奖励进度快照（不改状态），给 session / 后台用。
   *
   * stage 四种：
   *   off       —— 开关没打开
   *   normal    —— 打开了但还没到"用完"这一步（这时不提奖励的事）
   *   open      —— 用完了，答对 N 题还能再换 M 分钟，还剩 timesLeft 次
   *   exhausted —— 今天的奖励次数用光了，禁用到底，等明天 0 点
   */
  rewardState(deviceId) {
    const pol = this.effectivePolicy(deviceId);
    const d = state.devices[deviceId];
    const st = (d && d.stats) || newStats();
    const limitMs = pol.dailyLimitMin * 60000;
    const bonusMs = st.bonusMs || 0;
    const usedMs = st.watchedMs || 0;
    const times = st.bonusTimes || 0;
    const timesLeft = Math.max(0, pol.rewardTimes - times);
    // 「用完」的判定要算上已经换来的时间：基础 2 小时 + 换来的 20 分钟都看完了才算真用完
    const drained = usedMs >= limitMs + bonusMs;
    const enabled = !!pol.rewardEnabled;
    let stage = 'normal';
    if (!enabled) stage = 'off';
    else if (drained) stage = timesLeft > 0 ? 'open' : 'exhausted';
    return {
      enabled,
      stage,
      need: pol.rewardQuizCount,
      rewardMin: pol.rewardMin,
      maxTimes: pol.rewardTimes,
      times,
      timesLeft,
      correct: st.rewardCorrect || 0,
      bonusMs,
      limitMs,
      usedMs
    };
  },

  /**
   * 答完一题结算奖励。
   *
   * 只有「基础额度 + 已换来的时间」都耗尽、且今天还有次数时才计数；
   * 答满 need 题就发一次（bonusMs 累加、次数 +1），进度归零重新数。
   * 答错既不计数也不清零 —— 允许慢慢攒，别把孩子卡死在差一题上。
   */
  settleReward(deviceId, correct) {
    const before = this.rewardState(deviceId);
    const d = state.devices[deviceId];
    let grantedMin = 0;
    if (before.enabled && before.stage === 'open' && correct && d && d.stats) {
      d.stats.rewardCorrect = (d.stats.rewardCorrect || 0) + 1;
      if (d.stats.rewardCorrect >= before.need) {
        d.stats.rewardCorrect = 0;
        d.stats.bonusMs = (d.stats.bonusMs || 0) + before.rewardMin * 60000;
        d.stats.bonusTimes = (d.stats.bonusTimes || 0) + 1;
        grantedMin = before.rewardMin;
      }
    }
    // 无论有没有发奖都落一次盘：调用方（判题接口）在同一段里改过 quizCount，
    // 借这次写入一起持久化，省得再开一次写。
    writeJson('devices.json', state.devices);
    return Object.assign({ grantedMin }, this.rewardState(deviceId));
  },

  appendEvent(ev) {
    const line = JSON.stringify(Object.assign({ ts: Date.now() }, ev)) + '\n';
    try {
      fs.appendFileSync(file('events.jsonl'), line, 'utf8');
      const st = fs.statSync(file('events.jsonl'));
      if (st.size > 5 * 1024 * 1024) rotate(file('events.jsonl'));
    } catch (e) {
      /* 日志写失败不影响主流程 */
    }
  },

  /**
   * 读事件日志（新的在前），支持按类型 / 设备 / 关键词过滤 + 分页。
   *
   * 日志是 jsonl 追加写的，量级不大（>5MB 就轮转），每次请求整文件读一遍最简单，
   * 也避免再维护一份索引。byType 顺手统计一遍，前端直接拿去做筛选标签。
   */
  queryEvents(opts) {
    const o = opts || {};
    const type = String(o.type || '').trim();
    const deviceId = String(o.deviceId || '').trim();
    const kw = String(o.q || '').trim().toLowerCase();
    // 排除某些类型：管理端的「连接断开 / 恢复」太吵，默认不显示，
    // 但它们照常写进 events.jsonl，也照常被归档到详细日志文件里，一条都不丢
    const exclude = String(o.exclude || '').trim();
    const exSet = new Set(exclude.split(',').map(s => s.trim()).filter(Boolean));
    const limit = clamp(Number(o.limit) || 50, 1, 500);
    const offset = Math.max(0, Number(o.offset) || 0);

    let raw = [];
    try {
      const text = fs.readFileSync(file('events.jsonl'), 'utf8');
      raw = text.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) {
      raw = [];
    }
    raw.reverse();   // 文件是旧的在前，反过来让新的排第一
    const scanned = raw.length;   // 原始条数（合并前），页面上显示「日志文件共 N 条」
    // 高频事件按「同类型 + 同设备 + 30 分钟内」合并成一条，带 merged 次数；
    // 只是展示口径，events.jsonl 与归档文件里一条不少
    raw = mergeBursts(raw);

    // 被藏起来的条数：前端要显示「已隐藏 N 条」，家长才知道确实有记录、只是折叠了
    const hidden = exSet.size ? raw.filter(e => exSet.has(e.type)).length : 0;
    const all = exSet.size ? raw.filter(e => !exSet.has(e.type)) : raw;

    const byType = {};
    all.forEach(e => { byType[e.type] = (byType[e.type] || 0) + 1; });

    let list = all;
    if (type && type !== 'all') {
      const types = type.split(',').map(s => s.trim()).filter(Boolean);
      list = list.filter(e => types.includes(e.type));
    }
    if (deviceId && deviceId !== 'all') {
      list = list.filter(e => e.deviceId === deviceId);
    }
    if (kw) {
      list = list.filter(e => JSON.stringify(e).toLowerCase().includes(kw));
    }

    return {
      items: list.slice(offset, offset + limit),
      total: list.length,
      offset,
      limit,
      byType,           // 全量口径，不受当前筛选影响，用来画标签
      hidden,           // 因 exclude 被折叠掉的条数（连接断开 / 恢复这类高频事件）
      scanned: scanned  // 合并前的原始条数
    };
  },

  /**
   * 首页「最近事件」：默认折叠连接断开 / 恢复。
   *
   * 首页只有 10 行，一晚待机会翻十几次，不折起来的话首页永远只看到这两类，
   * 「谁答了题、谁改了策略」全被挤走。要看连接记录的走运行日志的「显示连接日志」，
   * 或者下载归档文件（那里一条都不少）。
   */
  recentEvents(limit) {
    return this.queryEvents({
      limit: limit || 10,
      exclude: 'device_online,device_offline,keepalive_fix'
    }).items;
  }
};

function rotate(activeFile) {
  const bak = activeFile + '.1';
  try {
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
    fs.renameSync(activeFile, bak);
  } catch (e) { /* ignore */ }
}

/** 1~5 星每题奖励分钟，允许小数，最多 120 分钟 */
function normalizeStarBonus(raw) {
  const def = [1, 1, 2, 3, 5];
  const arr = Array.isArray(raw) ? raw : [];
  return Array.from({ length: 5 }, (_, i) => {
    const v = Number(arr[i]);
    if (!Number.isFinite(v)) return def[i];
    return Math.min(120, Math.max(0, Math.round(v * 10) / 10));
  });
}

function normalizeOverride(o) {
  const out = {};
  const map = {
    dailyLimitMin: [10, 720],
    quizIntervalMin: [1, 120],
    passBonusMin: [1, 120],
    difficulty: [0, 3]
  };
  for (const k of Object.keys(map)) {
    if (o[k] === undefined || o[k] === null || o[k] === '') continue;
    const v = Number(o[k]);
    if (!Number.isFinite(v)) continue;
    out[k] = clamp(Math.round(v), map[k][0], map[k][1]);
  }
  if (o.enabled !== undefined) out.enabled = !!o.enabled;
  if (o.wrongPolicy !== undefined) out.wrongPolicy = o.wrongPolicy === 'pass' ? 'pass' : 'retry';
  if (o.wrongBoostRate !== undefined && o.wrongBoostRate !== null && o.wrongBoostRate !== '') {
    const v = Number(o.wrongBoostRate);
    if (Number.isFinite(v)) out.wrongBoostRate = clamp(Math.round(v), 0, 100);
  }
  // 出题年级：0 不限 / 1~6 指定年级（通用题是否混入看 quizIncludeGeneral）
  if (o.quizGrade !== undefined && o.quizGrade !== null && o.quizGrade !== '') {
    out.quizGrade = normalizeQuizGrade(o.quizGrade);
    if (out.quizGrade === -1) out.quizGrade = 0;
  }
  // 通用题开关：勾上 = 通用题与所选年级题一起随机抽
  if (o.quizIncludeGeneral !== undefined) out.quizIncludeGeneral = !!o.quizIncludeGeneral;
  // 学科：用统一校验（内置 + 各年级自定义学科都认）；显式空数组 = 这台电视不限学科
  if (Array.isArray(o.subjects)) {
    out.subjects = o.subjects.length ? normalizeSubjects(o.subjects) : [];
  }
  return out;
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function today() {
  // 用本地日期（容器里设了 TZ），跨天在凌晨 0 点切
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 一台电视的"今日"统计。跨天时整块重置 —— 包括答题换来的时长，
 * 所以第一天换来的 20 分钟不会留到第二天。
 */
function newStats() {
  return {
    date: today(),
    watchedMs: 0,
    quizCount: 0,
    passCount: 0,
    bonusMs: 0,        // 今日已发放的奖励时长
    bonusTimes: 0,     // 今日已触发奖励的次数
    rewardCorrect: 0   // 当前这一轮已答对的题数（满 N 题发一次奖后归零）
  };
}

/** 老数据升级：补齐后加的字段，避免前端算出 NaN */
function ensureStats(d) {
  if (!d.stats || d.stats.date !== today()) {
    d.stats = newStats();
    d.stats.rolledAt = Date.now();
    return d.stats;
  }
  const s = d.stats;
  if (typeof s.bonusMs !== 'number') s.bonusMs = 0;
  if (typeof s.bonusTimes !== 'number') s.bonusTimes = 0;
  if (typeof s.rewardCorrect !== 'number') s.rewardCorrect = 0;
  return s;
}

/**
 * 高频事件合并：同类型 + 同设备 + 时间差在窗口内的相邻记录合成一条。
 *
 * 「自动保活」「连接断开 / 恢复」这类事件一晚上待机能刷几十条，把真正有意义的事件
 * （谁答了题、谁改了策略）全挤走。合并只发生在展示层：一条记录带 merged 次数和
 * 最早发生时间 firstTs；events.jsonl 与每天归档的日志文件里一条不少。
 */
const MERGE_TYPES = new Set(['keepalive_fix', 'device_online', 'device_offline']);
const MERGE_GAP_MS = 30 * 60 * 1000;

function mergeBursts(list) {
  const out = [];
  for (const e of list) {                      // list 已按时间倒序（新的在前）
    const prev = out[out.length - 1];
    if (prev && MERGE_TYPES.has(e.type) && prev.type === e.type &&
        (prev.deviceId || '') === (e.deviceId || '') &&
        (prev.ts - e.ts) <= MERGE_GAP_MS) {
      prev.merged = (prev.merged || 1) + 1;
      prev.firstTs = e.ts;
      // prev 是最新那条，优先保留它的结果；只有它没带信息时才回填更早的
      if (prev.error === undefined && e.error) prev.error = e.error;
      if (prev.ok === undefined && e.ok !== undefined) prev.ok = e.ok;
      continue;
    }
    out.push(Object.assign({}, e));
  }
  return out;
}

module.exports = store;
module.exports.DEFAULT_POLICY = DEFAULT_POLICY;
// IP 工具给 screenshot.js / keepalive.js / app.js 共用，避免各处重复判断网关
module.exports.effectiveIp = effectiveIp;
module.exports.isBridgeGateway = isBridgeGateway;
module.exports.isLanIp = isLanIp;
module.exports.today = today;
module.exports.normalizeSchedule = normalizeSchedule;
module.exports.inSchedule = inSchedule;
module.exports.nextActiveAt = nextActiveAt;
module.exports.SLOTS_PER_DAY = SLOTS_PER_DAY;
