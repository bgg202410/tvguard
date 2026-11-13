'use strict';

/**
 * 题库：按学科生成/挑选、判题、批量导入。
 *
 * 题目存在服务端是这次改版的核心目的 —— 换题、调难度、加提示都不用重装 App。
 * 判题也在服务端做：题目下发时**不带答案**，孩子抓包也拿不到正确项。
 * （离线时电视端回退到本地 QuestionBank，逻辑保持一致。）
 *
 * 学科差异：
 *   数学  —— 用参数生成，一道代码等于无穷多道题；
 *   语文/拼音/英语 —— 答案是知识点，没法算，用 subjects.js 里的预置题库，
 *                    家长可以停用、修改，也可以整批导入自己的一套。
 */

const store = require('./store');
const {
  SUBJECTS, SUBJECT_KEYS, BANKS, FALLBACK_HINTS,
  GRADES, GRADE_NAMES,
  normalizeSubject, normalizeQuizGrade,
  subjectName, subjectColor,
  gradeSubjects, addGradeSubject
} = require('./subjects');

const LEVEL_NAMES = { 1: '简单', 2: '中等', 3: '挑战' };

/** 年级：1~6，0 = 通用（老题、跨年级题）。后期加初高中只需扩这里 */
function normalizeGrade(v) {
  const n = Number(v);
  return GRADES.includes(n) ? n : 0;
}

function gradeName(g) {
  return GRADE_NAMES[normalizeGrade(g)] || '通用';
}

/** 题型：单选 / 判断 / 多选。判断题本质是两个固定选项，客户端不用另做界面。 */
const TYPES = ['choice', 'judge', 'multi'];
const TYPE_NAMES = { choice: '单选', judge: '判断', multi: '多选' };
const JUDGE_OPTIONS = ['对', '错'];

function normalizeType(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (TYPES.includes(t)) return t;
  if (t === '单选' || t === 'single') return 'choice';
  if (t === '判断' || t === 'truefalse') return 'judge';
  if (t === '多选' || t === 'multiple') return 'multi';
  return 'choice';
}

/** 题目默认星级：难度越高越值钱 */
function starsForLevel(level) {
  return level >= 3 ? 5 : (level === 2 ? 3 : 1);
}

/** 多选答案规范化：去重、排序、用 | 连接，保证比对时不受顺序影响 */
function normAnswer(type, answer) {
  const raw = Array.isArray(answer) ? answer.join('|') : String(answer == null ? '' : answer);
  if (type !== 'multi') return raw.trim();
  const parts = raw.split(/[|｜,，、]/).map(s => s.trim()).filter(Boolean);
  return [...new Set(parts)].sort().join('|');
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[rand(0, arr.length - 1)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 生成一道口算题（不含 id） */
function makeQuestion(level) {
  let a, b, c, prompt, answer;

  if (level === 1) {
    // 两位数以内加减，不出现负数
    a = rand(10, 49);
    b = rand(5, 39);
    if (Math.random() < 0.5) { prompt = `${a} + ${b} = ?`; answer = a + b; }
    else {
      if (b > a) [a, b] = [b, a];
      prompt = `${a} - ${b} = ?`; answer = a - b;
    }
  } else if (level === 2) {
    // 两位数与三位数混合，加减为主
    a = rand(25, 480);
    b = rand(12, 390);
    if (Math.random() < 0.55) { prompt = `${a} + ${b} = ?`; answer = a + b; }
    else {
      if (b > a) [a, b] = [b, a];
      prompt = `${a} - ${b} = ?`; answer = a - b;
    }
  } else {
    // 挑战：表内乘除 + 混合运算
    const kind = rand(1, 3);
    if (kind === 1) {
      a = rand(12, 99); b = rand(3, 9);
      prompt = `${a} × ${b} = ?`; answer = a * b;
    } else if (kind === 2) {
      a = rand(120, 780); b = rand(4, 9);
      prompt = `${a} × ${b} = ?`; answer = a * b;
    } else {
      a = rand(12, 60); b = rand(2, 9); c = rand(10, 90);
      prompt = `${a} × ${b} + ${c} = ?`; answer = a * b + c;
    }
  }

  return {
    subject: 'math',
    type: 'choice',
    stars: starsForLevel(level),
    level,
    prompt,
    answer: String(answer),
    options: makeOptions(answer),
    hint: makeHint(level, prompt, answer),
    explanation: `${prompt.replace(/\s*=\s*\?$/, '')} = ${answer}`
  };
}

/** 三个干扰项：贴着正确答案浮动，看起来都像算错一步的结果 */
function makeOptions(answer) {
  const set = new Set([String(answer)]);
  const deltas = [-10, -9, -2, -1, 1, 2, 9, 10, -11, 11, -20, 20];
  let guard = 0;
  while (set.size < 4 && guard++ < 100) {
    const d = pick(deltas);
    const v = answer + d;
    if (v >= 0 && v !== answer) set.add(String(v));
  }
  // 兜底：极端情况下用随机数补足
  while (set.size < 4) set.add(String(rand(1, 999)));
  return shuffle([...set]);
}

function makeHint(level, prompt, answer) {
  // 提示按题型给一条思路，不是直接报答案
  if (prompt.includes('×')) {
    return '把大数拆成整十数加零头，先乘整十数，再补上剩下的';
  }
  if (prompt.includes('-')) {
    return '先看个位够不够减，不够就从十位借 1';
  }
  if (level >= 2) return '从高位往低位加，别忘了进位';
  return '可以先凑成整十数再加，会快一点';
}

/** 一条预置题库记录 → 题目对象 */
function bankToQuestion(subject, level, entry, index) {
  const [prompt, answer, distractors, hint] = entry;
  const options = shuffle([answer, ...(distractors || [])].map(x => String(x).trim()).filter(Boolean));
  return {
    subject,
    type: 'choice',
    stars: starsForLevel(level),
    level,
    prompt,
    answer: String(answer),
    options,
    hint: hint || pick(FALLBACK_HINTS[subject] || ['']),
    explanation: '',
    bankKey: `${subject}:${level}:${index}`
  };
}

let seq = 0;
function newId(prefix) {
  seq = (seq + 1) % 100000;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * 首次启动灌题，保证服务一上线每一科都能出题。
 *
 * 幂等靠两点：
 *   1) 老数据（只有数学、没有 subject 字段）在启动时补成 math；
 *   2) 某一科完全没有题时才灌该科的预置题库，家长删空了重启会重新灌回来。
 */
function ensureSeed() {
  let dirty = false;
  const touched = [];

  for (const q of store.questions) {
    if (!q.subject) { q.subject = 'math'; dirty = true; }
    if (!q.type) { q.type = 'choice'; dirty = true; }
    if (!q.stars) { q.stars = starsForLevel(q.level || 2); dirty = true; }
    // 老题没有年级：标成「通用」，任何年级筛选都能看到，也不误标教材进度
    if (q.grade === undefined) { q.grade = 0; dirty = true; }
  }

  for (const key of SUBJECT_KEYS) {
    if (store.questions.some(q => q.subject === key)) continue;
    const out = [];
    if (key === 'math') {
      for (const level of [1, 2, 3]) {
        for (let i = 0; i < 60; i++) {
          out.push(Object.assign({ id: newId('q'), enabled: true, source: 'seed', grade: 0 }, makeQuestion(level)));
        }
      }
    } else {
      const bank = BANKS[key] || {};
      for (const level of [1, 2, 3]) {
        (bank[level] || []).forEach((entry, i) => {
          out.push(Object.assign({ id: newId('q'), enabled: true, source: 'seed', grade: 0 },
            bankToQuestion(key, level, entry, i)));
        });
      }
    }
    if (!out.length) continue;
    store.questions.push(...out);
    touched.push({ subject: key, count: out.length });
    dirty = true;
  }

  if (dirty) {
    store.saveQuestions();
    for (const t of touched) store.appendEvent({ type: 'seed', subject: t.subject, count: t.count });
  }
}

/** 取一道题，避开这台设备最近出过的，避免短时间内重复 */
const recentByDevice = new Map();

/** 同一道题在多少毫秒内不再出现（题池 ≥40 道时） */
const REPEAT_WINDOW_MS = 30 * 60_000;
/** 小题池放宽到 90 分钟：池子只够一轮时窗口太长等于把池子锁死 */
const REPEAT_WINDOW_SMALL_MS = 90 * 60_000;

/** 出题难度：0 = 不限（所有难度随机），1~3 = 出这个难度**及以下** */
function normalizeLevel(v) {
  const n = Number(v);
  return [0, 1, 2, 3].includes(n) ? n : 0;
}

/**
 * 难度命中：**累积语义**，高难度包含所有低难度。
 *
 *   简单(1) → 只出简单
 *   中等(2) → 简单 + 中等
 *   挑战(3) → 简单 + 中等 + 挑战（也就是全难度）
 *   不限(0) → 全难度
 *
 * 家长选「挑战」的本意是「别只给孩子出简单题，难一点的也能出」，
 * 按 `level === scope` 精确匹配会把简单/中等题全排掉，题库一下子见底。
 */
function levelMatch(q, scopeLevel) {
  if (!scopeLevel) return true;
  const lv = Number(q.level) || 2;   // 老题没有难度字段，按「中等」算，不被简单档吃掉
  return lv <= scopeLevel;
}

/**
 * 出题范围以「后台策略」为准，电视端只需要带 deviceId。
 * 排查时可以直接用 /api/v1/quiz?grade=3&subject=chinese&level=2 覆盖。
 *
 * quizGrade = 0 / subjects = [] / difficulty = 0 时三项都没选，
 * 结果就是「全部启用题目随机抽」，只在抽样时按错题>未答>已答加权。
 */
function quizScope(deviceId, opts) {
  const pol = store.effectivePolicy(deviceId);
  const o = opts || {};
  const has = v => v !== undefined && v !== null && v !== '';

  const grade = normalizeQuizGrade(has(o.grade) ? o.grade : pol.quizGrade);
  const level = normalizeLevel(has(o.level) ? o.level : pol.difficulty);
  // 通用题开关：勾上 = 通用题与所选年级的题一起随机抽；不勾 = 指定年级时只抽该年级的题
  const includeGeneral = has(o.includeGeneral) ? !!o.includeGeneral : !!pol.quizIncludeGeneral;

  // 空数组 = 不限学科。注意不能走 normalizeSubjects()，那个函数空数组会回落成「全部学科」，
  // 会把家长「一个都不勾」的语义悄悄改掉，也漏掉后来新增的自定义学科。
  let subjects = [];
  if (has(o.subject)) {
    const k = normalizeSubject(o.subject);
    if (k) subjects = [k];
  } else if (Array.isArray(pol.subjects)) {
    subjects = pol.subjects.length ? expandSubjectKeys(pol.subjects) : [];
  }
  return { grade, level, subjects, includeGeneral };
}

/**
 * 自定义学科的 key 带年级前缀（每个年级独立一套），导入题库包后同名学科会有多个 key。
 * 策略页按名字合并成一个勾选框，勾「科学」要覆盖所有年级的「科学」，
 * 所以这里把选中的 key 按名字展开成全部等价 key。
 */
function expandSubjectKeys(keys) {
  const out = new Set(keys);
  const all = gradeSubjects(0);
  const names = new Set(keys.map(k => (all.find(s => s.key === k) || {}).name).filter(Boolean));
  for (const s of all) if (names.has(s.name)) out.add(s.key);
  return [...out];
}

/**
 * 年级命中：不限全收；指定年级只收该年级的题，通用题是否混入由 includeGeneral 决定
 * （后台的「包含通用题」勾选框）。scopeGrade=-1 是老数据「仅通用题」的兼容分支，
 * 界面上已没有这个选项。
 *
 * 通用题默认不混入 —— 「通用」是程序生成的种子题（数学口算挑战档是 120~780 × 4~9，
 * 三位数乘一位数），混进一年级就会蹦出 576 × 6 这种明显超纲的题。
 * 指定年级的池子真没题时，nextQuestion 的逐级放宽兜底会接住，不会把孩子卡住。
 */
function inGrade(q, scopeGrade, includeGeneral) {
  const g = normalizeGrade(q.grade);
  if (scopeGrade === 0) return true;
  if (scopeGrade === -1) return g === 0;
  return g === scopeGrade || (includeGeneral && g === 0);
}

/**
 * 出题权重：错题 > 未答 > 已答。
 *
 * 错题      —— 错题本里还挂着的题，权重 8~19（错得越多越高，wrongBoostRate 还能再抬一档）
 * 未答      —— 从没作答过的题（出过但没答也算），权重 3
 * 已答      —— 答过的题，权重 1/(1+答对次数)，答对越多越不容易再出现，但永远不会降到 0
 *
 * 用加权随机而不是「错题池非空就必出错题」，避免孩子卡在同一道题上出不来。
 * 只要三级基础权重严格递减，整体出现概率就恒定满足 错题 > 未答 > 已答。
 */
function questionWeight(q) {
  const w = store.wrong[q.id];
  if (w && w.n > 0) {
    const boost = Math.min(100, Math.max(0, Number(store.policy.wrongBoostRate) || 0));
    return 8 + Math.round(boost / 20) + Math.min(6, w.n * 2);
  }
  const s = store.qstatOf(q.id);
  const answered = s ? (s.right || 0) + (s.wrong || 0) : 0;
  if (!answered) return 3;
  return 1 / (1 + (s.right || 0));
}

function weightedPick(list) {
  if (!list.length) return null;
  const weights = list.map(questionWeight);
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

function nextQuestion(deviceId, options) {
  const o = options || {};
  const scope = quizScope(deviceId, o);
  // 只出文字题：旧版题库里可能还留着听力/视频题，本分支不含媒体播放能力，一律跳过。
  const all = store.questions.filter(q => q.enabled !== false && TYPES.includes(q.type || 'choice'));

  const match = (q, useGrade, useLevel, useSubject) =>
    (!useGrade || inGrade(q, scope.grade, scope.includeGeneral)) &&
    (!useLevel || levelMatch(q, scope.level)) &&
    (!useSubject || scope.subjects.length === 0 || scope.subjects.includes(q.subject));

  // 逐级放宽：全条件 → 丢难度 → 丢学科 → 全库。
  // 家长勾了范围但题库刚好没有这类题时，电视照样抽得到题，不会 503 把孩子卡住。
  // 顺序刻意是「先松难度再松学科」：题量不足时换难度比换学科更不突兀。
  let pool = all.filter(q => match(q, true, true, true));
  if (!pool.length) pool = all.filter(q => match(q, true, false, true));
  if (!pool.length) pool = all.filter(q => match(q, true, false, false));
  if (!pool.length) pool = all;
  if (!pool.length) return null;

  const exclude = new Set(o.exclude || []);
  // 最近 20 道的设备级黑名单（内存）：题目统计还没落盘时也能挡住连出两道一样的
  const recent = recentByDevice.get(deviceId) || [];
  const now = Date.now();

  /**
   * 「最近出过没」以 qstats.lastAt 为准 —— 它落盘，进程重启也不会失效。
   * 窗口按题池大小定：池子小（<40 道）时 30 分钟窗口会把整个池子锁死，
   * 反而每道题都要靠兜底分支，所以放松到 90 分钟 + 只做轮转。
   */
  const win = pool.length >= 40 ? REPEAT_WINDOW_MS : REPEAT_WINDOW_SMALL_MS;
  const lastAt = q => {
    const s = store.qstatOf(q.id);
    return (s && s.lastAt) || 0;
  };
  const usable = pool.filter(q => !exclude.has(q.id) && !recent.includes(q.id));

  /** 一组题里优先级最高的那一档（同档之间不排先后，交给 weightedPick 随机） */
  const pickTop = list => {
    let top = -Infinity;
    for (const q of list) {
      const p = Number(q.priority) || 0;
      if (p > top) top = p;
    }
    return list.filter(q => (Number(q.priority) || 0) === top);
  };

  /**
   * 优先级只在「还没出过的题」里起作用：置顶题出过一次就正常让位，
   * 不会因为 priority 高就在小池子里反复霸屏；等它滑出窗口（或隔天）会再次优先。
   * 全都是默认 0 时，pickTop 等于不筛选，行为和以前完全一致。
   */
  const fresh = usable.filter(q => now - lastAt(q) > win);
  let use;
  if (fresh.length) {
    use = pickTop(fresh);
  } else {
    // 整个池子都在窗口内：先从「最久没出过」的 1/4 档里取，档内再挑最高优先级
    const sorted = (usable.length ? usable : pool).slice().sort((a, b) => lastAt(a) - lastAt(b));
    use = pickTop(sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 4))));
  }
  const q = weightedPick(use);

  store.markServed(q.id);   // 「出过但没答」也是状态，供权重判断

  // 记住最近 20 道，够了就滚掉最老的
  const list = recent.concat(q.id);
  while (list.length > 20) list.shift();
  recentByDevice.set(deviceId, list);

  // 下发时不带 answer，也不带 explanation（解析是答完才给的东西）
  return {
    id: q.id,
    subject: q.subject,
    subjectName: subjectName(q.subject, q.grade),
    subjectColor: subjectColor(q.subject, q.grade),
    grade: normalizeGrade(q.grade),
    gradeName: gradeName(q.grade),
    type: q.type || 'choice',
    stars: q.stars || starsForLevel(q.level),
    prompt: q.prompt,
    options: q.options,
    hint: q.hint || '',
    level: q.level
  };
}

function findById(id) {
  return store.questions.find(q => q.id === id) || null;
}

/**
 * 判题。正确答案在服务端比对，客户端拿不到。
 * 多选按集合比对，顺序无关；判断题就是两个固定选项的单选。
 */
function checkAnswer(id, choice) {
  const q = findById(id);
  if (!q) return { correct: false, answer: '', missing: true };
  const type = q.type || 'choice';
  const base = {
    answer: q.answer || '',
    explanation: q.explanation || q.hint || '',
    subject: q.subject || 'math',
    type,
    stars: q.stars || starsForLevel(q.level)
  };
  const ok = normAnswer(type, choice) === normAnswer(type, q.answer);
  return Object.assign(base, { correct: ok });
}

/** 选项解析：数组或「逗号/顿号/分号/换行」分隔的字符串 */
function parseOptions(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : String(raw == null ? '' : raw).split(/[,，、;；\n]+/);
  return arr.map(s => String(s).trim()).filter(Boolean);
}

/** 判断题答案的常见写法都认：对/√/true/是 → 对，错/×/false/否 → 错 */
function normalizeJudge(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['对', '√', '正确', 'true', 'yes', '是', 't', '1'].includes(s)) return '对';
  if (['错', '×', 'x', '错误', 'false', 'no', '否', 'f', '0'].includes(s)) return '错';
  return '';
}

function addQuestion(input, deferSave) {
  const grade = normalizeGrade(input.grade);
  const subject = normalizeSubject(input.subject, grade) || 'math';
  const type = normalizeType(input.type);
  const level = [1, 2, 3].includes(Number(input.level)) ? Number(input.level) : 2;
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return { error: '题干不能为空' };

  let answer = String(input.answer == null ? '' : input.answer).trim();
  if (type === 'judge') {
    answer = normalizeJudge(answer);
    if (!answer) return { error: '判断题答案只能是「对」或「错」' };
  } else {
    answer = normAnswer(type, answer);
    if (!answer) return { error: '答案不能为空' };
  }

  let options;
  if (type === 'judge') {
    options = JUDGE_OPTIONS.slice();  // 判断题选项固定，不用家长填
  } else {
    options = parseOptions(input.options);
  }

  if (type !== 'judge' && options.length < 2) {
    if (subject === 'math' && type === 'choice' && /^-?\d+$/.test(answer)) {
      options = makeOptions(Number(answer));
    } else {
      return { error: `${subjectName(subject)}题需要至少 2 个选项（用逗号分隔）` };
    }
  }
  // 多选的每个正确项都必须在选项里（无答案题 answer 为空，整段跳过）
  if (answer) {
    for (const part of answer.split('|').filter(Boolean)) {
      if (!options.includes(part)) options.push(part);
    }
    if (type !== 'multi' && !options.includes(answer)) options.push(answer);
  }
  if (options.length > 6) options = options.slice(0, 6);

  const stars = clampStars(input.stars, level);
  const q = {
    id: newId('q'),
    grade,
    subject,
    type,
    stars,
    priority: clampPriority(input.priority),
    level,
    prompt,
    answer,
    options: type === 'judge' ? options : shuffle([...new Set(options)]),
    hint: String(input.hint || '').trim() || pick(FALLBACK_HINTS[subject] || FALLBACK_HINTS.math || ['']),
    explanation: String(input.explanation || '').trim(),
    enabled: input.enabled === undefined ? true : !!input.enabled,
    source: String(input.source || 'admin').slice(0, 40)
  };
  store.questions.push(q);
  if (!deferSave) store.saveQuestions();
  return { question: q };
}

/**
 * 优先级：0~999 的整数，默认 0。数值越大越先出；
 * 同一优先级之间不排先后，仍按原来的窗口 + 加权随机走。
 */
function clampPriority(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(999, Math.max(0, Math.round(n)));
}

function clampStars(v, level) {
  const n = Number(v);
  if (!Number.isFinite(n)) return starsForLevel(level);
  return Math.min(5, Math.max(1, Math.round(n)));
}

function updateQuestion(id, patch) {
  const q = findById(id);
  if (!q) return null;
  if (patch.grade !== undefined) q.grade = normalizeGrade(patch.grade);
  if (patch.subject !== undefined) {
    const s = normalizeSubject(patch.subject, q.grade);
    if (s) q.subject = s;
  }
  if (patch.type !== undefined) q.type = normalizeType(patch.type);
  if (patch.prompt !== undefined) q.prompt = String(patch.prompt).trim();
  if (patch.answer !== undefined) {
    q.answer = q.type === 'judge'
      ? (normalizeJudge(patch.answer) || q.answer)
      : normAnswer(q.type, patch.answer);
    if (q.type === 'judge') q.options = JUDGE_OPTIONS.slice();
  }
  if (patch.hint !== undefined) q.hint = String(patch.hint).trim();
  if (patch.explanation !== undefined) q.explanation = String(patch.explanation).trim();
  if (patch.stars !== undefined) q.stars = clampStars(patch.stars, q.level);
  if (patch.priority !== undefined) q.priority = clampPriority(patch.priority);
  if (patch.level !== undefined) q.level = [1, 2, 3].includes(Number(patch.level)) ? Number(patch.level) : q.level;
  if (patch.enabled !== undefined) q.enabled = !!patch.enabled;
  if (patch.options !== undefined && q.type !== 'judge') {
    const opts = parseOptions(patch.options);
    if (opts.length >= 2) {
      for (const part of String(q.answer).split('|')) if (part && !opts.includes(part)) opts.push(part);
      q.options = shuffle([...new Set(opts)]);
    }
  }
  store.saveQuestions();
  return q;
}

function deleteQuestion(id) {
  const i = store.questions.findIndex(q => q.id === id);
  if (i < 0) return false;
  store.questions.splice(i, 1);
  store.saveQuestions();
  store.dropQstat(id);
  return true;
}

/**
 * 清掉某道题的出题记录（题不动）。
 * 除了落盘的 qstats（lastAt 冷却 + 答对次数压低权重），还要顺手从内存里的
 * 设备级「最近 20 道」黑名单里剔掉 —— 否则刚清零也会被黑名单挡住，
 * 得等这台设备再出满 20 道题才轮得到它。
 */
function resetQuestionStats(id) {
  if (!store.questions.find(q => q.id === id)) return { error: '题目不在题库里' };
  const cleared = store.resetQstat(id);
  let unblocked = 0;
  for (const [dev, list] of recentByDevice) {
    if (!list.includes(id)) continue;
    recentByDevice.set(dev, list.filter(x => x !== id));
    unblocked++;
  }
  return { ok: true, cleared, unblocked };
}

/**
 * 题库包批量导入（管理端上传 JSON 数组）。
 * 按「年级 + 学科 + 题干」去重，重复导入不会刷出一堆同题；只写一次盘。
 */
function bulkImport(items) {
  if (!Array.isArray(items)) return { error: '题库包格式不对：需要题目数组' };
  const seen = new Set(store.questions.map(q =>
    `${normalizeGrade(q.grade)}|${q.subject}|${String(q.prompt).trim()}`));
  let ok = 0, skipped = 0;
  const errors = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') { skipped++; continue; }
    const grade = normalizeGrade(raw.grade);
    // 题库包里可以直接写中文学科名（如「科学」）：这个年级没建过就自动建一个，
    // 免得家长先去学科管理里手工逐个年级点一遍
    let subject = normalizeSubject(raw.subject, grade);
    if (!subject) {
      const name = String(raw.subject || '').trim();
      if (name) {
        const hit = gradeSubjects(grade).find(s => s.name === name);
        if (hit) subject = hit.key;
        else {
          const made = addGradeSubject(grade, {
            name, short: String(raw.subjectShort || name.slice(0, 1)),
            color: String(raw.subjectColor || ''), desc: ''
          });
          if (made.subject) subject = made.subject.key;
        }
      }
    }
    subject = subject || 'math';
    const key = `${grade}|${subject}|${String(raw.prompt || '').trim()}`;
    if (seen.has(key)) { skipped++; continue; }
    const payload = Object.assign({}, raw, { grade, subject });
    const r = addQuestion(payload, true);
    if (r.error) { errors.push(`${key}：${r.error}`); continue; }
    seen.add(key);
    ok++;
  }
  if (ok) store.saveQuestions();
  return { ok, skipped, failed: errors.length, errors: errors.slice(0, 10) };
}

/**
 * 批量导入。一行一道题，可以整批混学科。
 *
 * 行首可加 [年级/学科/难度]，也兼容老的 [学科] 或 [学科/难度]：
 *   [3年级/语文/2] 「骄傲」的反义词是？|谦虚|自豪,高兴,勇敢|骄傲自满对谦虚
 *   [一年级/拼音/1] 「妈」的拼音是？|mā|má,mǎ,mà
 *   [语文] 老格式照旧，年级取页面上选的默认值
 *
 * 字段数决定含义（数学与非数学的第 3 段不同，因为数学的选项可以自动生成）：
 *   2 段  题干|答案         数学也支持 12+34=46 这种等号写法
 *   数学  3 段  题干|答案|提示        4 段  题干|答案|选项|提示
 *   其它  3 段  题干|答案|选项        4 段  题干|答案|选项|提示
 */
function importText(text, defaultLevel, defaultSubject, defaultType, defaultGrade) {
  const defLevel = [1, 2, 3].includes(Number(defaultLevel)) ? Number(defaultLevel) : 2;
  const defGrade = normalizeGrade(defaultGrade);
  const defSubject = normalizeSubject(defaultSubject, defGrade) || 'math';
  const defType = normalizeType(defaultType);
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const seen = new Set(store.questions.map(q =>
    `${normalizeGrade(q.grade)}|${q.subject}|${String(q.prompt).trim()}`));
  let ok = 0, skipped = 0;
  const errors = [];

  for (const line of lines) {
    let body = line;
    let subject = defSubject;
    let level = defLevel;
    let grade = defGrade;

    // 行首标记：[年级/学科/难度]（新）或 [学科] / [学科/难度]（老）
    const head = body.match(/^[\[【]([^\]】]+)[\]】]\s*/);
    if (head) {
      const bits = head[1].split(/[\/／]/).map(s => s.trim()).filter(Boolean);
      const gm = String(bits[0] || '').match(/^([1-6一二三四五六])年级?$/);
      if (gm) {
        const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[gm[1]];
        grade = normalizeGrade(cn || gm[1]);
        bits.shift();
      }
      const s = normalizeSubject(bits[0], grade);
      if (!s) { errors.push(line); continue; }
      subject = s;
      if (bits[1] && [1, 2, 3].includes(Number(bits[1]))) level = Number(bits[1]);
      body = body.slice(head[0].length).trim();
    }

    let prompt, answer, hint = '', options = null;

    if (body.includes('|') || body.includes('｜')) {
      const parts = body.split(/[|｜]/).map(s => s.trim());
      prompt = parts[0];
      answer = parts[1];
      if (parts.length === 2) {
        // 题干|答案 —— 数学题自动造干扰项；非数学会在 addQuestion 里报缺选项
      } else if (parts.length === 3) {
        // 数学题不需要选项、判断题选项固定，这两种第三段都是提示
        if (subject === 'math' || defType === 'judge') hint = parts[2];
        else options = parts[2];
      } else {
        options = parts[2];
        hint = parts[3] || '';
      }
    } else {
      // 12+34=46 这种等号写法，只适合数学
      const m = body.match(/^(.+?)\s*=\s*(-?\d+)$/);
      if (!m || subject !== 'math') { errors.push(line); continue; }
      prompt = m[1].trim() + ' = ?';
      answer = m[2];
    }

    if (!prompt || answer === undefined || answer === '') { errors.push(line); continue; }
    /**
     * 多选题的写法：答案里用顿号并列多个正确项，如「苹果、香蕉」。
     * 批量导入没有题型下拉了（界面上只留单选 / 多选两种写法），所以这里自动识别：
     * 出现顿号就按多选入库，并把顿号统一成存储用的 | —— normAnswer 认 | 分隔。
     * 选项本身是用英文逗号分隔的，不会和顿号混淆。
     */
    let type = defType;
    if (type === 'choice' && /、/.test(answer)) {
      type = 'multi';
      answer = answer.replace(/、+/g, '|');
    }
    const key = `${grade}|${subject}|${prompt}`;
    if (seen.has(key)) { skipped++; continue; }
    const r = addQuestion({ grade, subject, type, prompt, answer, hint, options, level }, true);
    if (r.error) errors.push(line);
    else { seen.add(key); ok++; }
  }
  if (ok) store.saveQuestions();
  return { ok, skipped, failed: errors.length, errors: errors.slice(0, 10) };
}

function stats() {
  const byLevel = { 1: 0, 2: 0, 3: 0 };
  const bySubject = {};
  // 按「学科名」聚合的一份：g1_math / math 都叫「数学」，前端 chips 按名字合并计数
  const bySubjectName = {};
  const byGrade = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const k of SUBJECT_KEYS) bySubject[k] = { total: 0, enabled: 0 };
  let enabled = 0;

  for (const q of store.questions) {
    byLevel[q.level] = (byLevel[q.level] || 0) + 1;
    const g = normalizeGrade(q.grade);
    byGrade[g] = (byGrade[g] || 0) + 1;
    const s = q.subject || 'math';
    if (!bySubject[s]) bySubject[s] = { total: 0, enabled: 0 };
    bySubject[s].total++;
    if (q.enabled) { enabled++; bySubject[s].enabled++; }
    // 年级学科的 key 要带上年级才解析得出中文名，否则 g1_math 会原样当成名字
    const n = subjectName(s, g);
    if (!bySubjectName[n]) bySubjectName[n] = { total: 0, enabled: 0 };
    bySubjectName[n].total++;
    if (q.enabled) bySubjectName[n].enabled++;
  }
  return { total: store.questions.length, enabled, byLevel, bySubject, bySubjectName, byGrade };
}

/**
 * 学科元信息 + 题量。
 *
 * grade / level / includeGeneral 和出题时的口径**完全一致**，家长在后台就能看到
 * 「选了一年级 + 简单之后，这科还剩多少道题」，不用猜。
 * （老签名 subjectMeta(grade) 仍然可用，后两个参数缺省等于「不限难度 / 不含通用题」。）
 */
function subjectMeta(grade, level, includeGeneral) {
  const g = Number(grade);
  const hasGrade = GRADES.includes(g);
  const lv = normalizeLevel(level);
  const inc = !!includeGeneral;
  const counts = {};
  for (const q of store.questions) {
    if (hasGrade && !inGrade(q, g, inc)) continue;
    if (!levelMatch(q, lv)) continue;
    const c = counts[q.subject] || { total: 0, enabled: 0 };
    c.total++;
    if (q.enabled !== false) c.enabled++;
    counts[q.subject] = c;
  }
  const out = gradeSubjects(hasGrade ? g : 0).map(s => Object.assign({}, s, {
    total: (counts[s.key] || {}).total || 0,
    enabled: (counts[s.key] || {}).enabled || 0
  }));
  // 题库里存在但学科表里查不到的 key（删过自定义学科、老数据）也要露出来，不然题量对不上
  const known = new Set(out.map(s => s.key));
  for (const key of Object.keys(counts)) {
    if (known.has(key)) continue;
    out.push(Object.assign({
      key, name: subjectName(key), short: subjectName(key).slice(0, 1),
      color: subjectColor(key), desc: ''
    }, { total: counts[key].total, enabled: counts[key].enabled }));
  }
  return out;
}

/**
 * 导出成题库包：字段和「选择文件导入」认的 JSON 一一对应，导出的文件可以原样再导入。
 * 不带 id / 答对次数（换台机器导入时 id 本来就会重新生成，统计也不跟过来）。
 * subject 写中文学科名而不是内部 key：自家建的自定义学科在别的机器上还不存在，
 * 写名字导过去会被自动建成同名学科，写 key 只会得到一串 g3_lxxx。
 * 不传 ids 就是整库导出。
 */
function exportQuestions(ids) {
  const set = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  return store.questions
    .filter(q => !set || set.has(String(q.id)))
    .map(q => {
      const out = {
        grade: normalizeGrade(q.grade),
        subject: subjectName(q.subject, q.grade),
        type: q.type || 'choice',
        level: [1, 2, 3].includes(Number(q.level)) ? Number(q.level) : 2,
        stars: q.stars || 1,
        priority: Number(q.priority) || 0,
        prompt: q.prompt,
        answer: q.answer || '',
        options: (q.options || []).slice(),
        hint: q.hint || '',
        explanation: q.explanation || '',
        enabled: q.enabled !== false
      };
      return out;
    });
}

module.exports = {
  LEVEL_NAMES,
  TYPES,
  TYPE_NAMES,
  GRADES,
  GRADE_NAMES,
  SUBJECTS,
  subjectMeta,
  normalizeGrade,
  gradeName,
  normalizeLevel,
  quizScope,
  inGrade,
  expandSubjectKeys,
  questionWeight,
  ensureSeed,
  nextQuestion,
  findById,
  checkAnswer,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  resetQuestionStats,
  importText,
  bulkImport,
  exportQuestions,
  stats,
  makeQuestion
};
