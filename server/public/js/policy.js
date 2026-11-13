let SUBJ = [];            // 全年级并集，策略页用
let QSUBJ = [];           // 题库页当前年级的学科（每个年级独立一套）
let qSubject = 'all';     // 题库当前筛选的学科
const TYPE_NAME = { choice: '单选', judge: '判断', multi: '多选' };

function subjOf(k){
  return SUBJ.find(s => s.key === k) || QSUBJ.find(s => s.key === k) ||
    { key: k || 'math', name: k || '数学', short: '?', color: '#7D8794' };
}

function qSubjList(){ return QSUBJ.length ? QSUBJ : SUBJ; }

function subjectTag(k){
  const s = subjOf(k);
  return `<span class="tag sub" style="color:${s.color}">${esc(s.name)}</span>`;
}

/** 题库筛选 chips 的数据镜像：[{ key, name, color, keys: [...] }]，供 loadDevices 只刷数字不重建 DOM */
let QCHIPS = [];

/**
 * 策略卡的学科勾选框。同名学科（6 个年级各自的「科学」）合并成一个框，题量累加。
 * 选中态按**名字**记 —— 切年级后 key 会变（g1_science → g3_science），按 key 记会全部丢勾。
 */
function renderPolicyChips(onNames){
  const names = onNames instanceof Set ? onNames : new Set(onNames || []);
  const seenName = new Set();
  const merged = [];
  for (const s of SUBJ){
    if (seenName.has(s.name)) continue;
    seenName.add(s.name);
    const group = SUBJ.filter(x => x.name === s.name);
    merged.push(Object.assign({}, group[0], {
      total: group.reduce((n, x) => n + (x.total || 0), 0),
      enabled: group.reduce((n, x) => n + (x.enabled || 0), 0)
    }));
  }
  $('pSubjects').innerHTML = merged.map(s => `
    <label class="chk ${names.has(s.name) ? 'on' : ''}${s.total ? '' : ' zero'}" data-name="${esc(s.name)}">
      <input type="checkbox" value="${esc(s.key)}" ${names.has(s.name) ? 'checked' : ''}
        onchange="this.parentNode.classList.toggle('on', this.checked)">
      <span style="color:${s.color};font-weight:600">${esc(s.name)}</span>
      <span class="cnt">${s.enabled}/${s.total}</span>
    </label>`).join('');
}

/** 当前（可能还没保存）勾了哪些学科，按名字取 */
function currentPolicyCheckedNames(){
  return [...document.querySelectorAll('#pSubjects label.chk.on')]
    .map(l => l.dataset.name).filter(Boolean);
}

let scopeSeq = 0;

// 首页策略卡和题库页都要把「年级 / 通用题 / 学科 / 难度」说成人话，
// 以前各写一套，结果同一条策略一处写「挑战」一处写「挑战（全部难度）」，
// 家长看着像两个东西。统一放这里。

const GRADE_TEXT = { 0: '不限年级', 1: '一年级', 2: '二年级', 3: '三年级', 4: '四年级', 5: '五年级', 6: '六年级' };

/**
 * 难度文案。出题是**累积**语义：选「挑战」= 简单 + 中等 + 挑战全出，
 * 所以不能只写「挑战」，否则家长以为是只出难题。
 */
const LEVEL_TEXT = { 0: '不限难度', 1: '简单', 2: '中等及以上', 3: '全部难度（挑战）' };
function levelText(lv){ return LEVEL_TEXT[Number(lv) || 0] || LEVEL_TEXT[0]; }
function gradeText(g){ const n = Number(g) || 0; return GRADE_TEXT[n] || '不限年级'; }

/**
 * 出题范围 → 一句人话。
 * o = { grade, incGeneral, subjects:[学科名], level }
 */
function scopeText(o){
  const t = o || {};
  const g = Number(t.grade) || 0;
  const parts = [gradeText(g)];
  if (g > 0 && t.incGeneral) parts.push('含通用题');
  parts.push(t.subjects && t.subjects.length ? t.subjects.join('、') : '全部学科');
  parts.push(levelText(t.level));
  return parts.join(' · ');
}

/**
 * 年级 / 难度 / 通用题一变，就按新范围重算「每个学科还能抽多少题」。
 * 口径和服务端出题完全一致：年级只算该年级（含通用题另算）、难度累积。
 */
async function refreshScopeSubjects(){
  const seq = ++scopeSeq;
  const names = currentPolicyCheckedNames();
  const g = $('pGrade').value;
  const lv = $('pDiff').value;
  const inc = $('pIncGeneral').checked ? '1' : '0';
  try {
    const d = await api(`/api/admin/subjects?grade=${encodeURIComponent(g)}&level=${encodeURIComponent(lv)}&incGeneral=${inc}`);
    if (seq !== scopeSeq) return;      // 连点几下只认最后一次
    SUBJ = d.list || [];
    renderPolicyChips(names);
  } catch (e) {
    /* 计数失败不影响保存，静默 */
  }
}

['pGrade', 'pDiff', 'pIncGeneral'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', refreshScopeSubjects);
});

function renderSubjects(policy, bank){
  // 策略卡的学科勾选框：全年级并集，同名合并（否则导入题库包后会刷出 6 个都叫「科学」的框）
  renderPolicyChips(new Set((policy.subjects || []).map(k => subjOf(k).name)));

  // 题库筛选 chips / 表单下拉：用「当前年级」的学科，跟着年级下拉联动。
  // 同名学科（如 6 个年级各自的「科学」）合并成一个 chip，题量累加；
  // 服务端按名字展开 key，点一个「科学」能筛出所有年级的科学题。
  const list = qSubjList();
  const bankObj = bank || {};
  // 服务端按学科名聚合的那份（g1_math 与通用 math 都计入「数学」）
  const bySubj = bankObj.bySubjectName || {};
  const seen = new Set();
  // 「全部」的初始数：当前年级各学科之和，兜底用全库总数。
  // 真正的精确值由 loadQuestions 拿到 scopeTotal 后回填（paintChipCounts）。
  const listTotal = list.reduce((n, x) => n + (Number(x.total) || 0), 0) || bankObj.total || 0;
  const chips = [{ key: 'all', name: '全部', n: listTotal, keys: [] }];
  for (const s of list){
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    const group = list.filter(x => x.name === s.name);
    const gradeSum = group.reduce((n, x) => n + (Number(x.total) || 0), 0);
    chips.push({
      key: (group.find(x => x.key === qSubject) || s).key,
      name: s.name,
      color: s.color,
      // 学科对象自带的是「该年级这个学科」的题量，比全库数更贴近当前视图；
      // 一个都没有时退回服务端的按名字聚合统计
      n: group.some(x => Number.isFinite(x.total)) ? gradeSum : ((bySubj[s.name] || {}).total || 0),
      keys: group.map(x => x.key)
    });
  }
  QCHIPS = chips;
  if (!chips.some(c => c.key === qSubject)) {
    // 切年级后学科 key 会变（g3_math → g1_math），按名字接住，别把选中态丢掉
    const nm = qSubject === 'all' ? '' : subjOf(qSubject).name;
    const hit = nm && chips.find(c => c.name === nm);
    qSubject = hit ? hit.key : 'all';
  }
  $('qSubjects').innerHTML = chips.map(c => `
    <span class="chip ${qSubject === c.key ? 'on' : ''}" data-key="${esc(c.key)}" onclick="setQSubject('${esc(c.key)}')">
      ${c.color ? `<span class="sdot" style="background:${c.color}"></span>` : ''}${esc(c.name)}
      <span class="n">${c.n}</span>
    </span>`).join('');

  const opts = list.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
  if ($('nSubject').innerHTML !== opts) $('nSubject').innerHTML = opts;

  // 首页题库入口卡已移除（合并进「题库管理」），bankEntryStat 元素不复存在，别再写它
  bankTotal = bankObj.total || 0;
  renderBankEntry();

  syncOptionHint();
}

/**
 * 用一次查询结果刷新 chips 数字。
 * src = { total, bySubject }，其中 bySubject 按**学科名**聚合（服务端已把
 * g1_math / math 这类不同年级的同名学科合并），结构是 { 学科名: { total, enabled } }。
 */
function paintChipCounts(src){
  const wrap = $('qSubjects');
  if (!wrap || !wrap.children.length) return;
  const bySubj = (src && src.bySubject) || {};
  const items = wrap.children;
  let sum = 0;
  const nums = QCHIPS.map(c => {
    if (c.key === 'all') return 0;
    const n = (bySubj[c.name] || {}).total || 0;
    sum += n;
    return n;
  });
  for (let i = 0; i < items.length && i < QCHIPS.length; i++){
    const num = items[i].querySelector('.n');
    if (!num) continue;
    num.textContent = QCHIPS[i].key === 'all'
      // 「全部」优先用服务端给的基集总数：有的题学科已从学科表删掉，
      // 各学科加和会偏小，直接用总数更准
      ? (src && Number.isFinite(src.total) ? src.total : sum)
      : nums[i];
  }
}

/** 题库页现在是否处于「全量」筛选（概览定时刷新只在全量时才能覆盖数字） */
function bankScopeIsDefault(){
  const g = $('qGrade'), l = $('qLevel'), t = $('qType'), s = $('qSearch');
  return (!g || g.value === 'all') && (!l || l.value === 'all') &&
    (!t || t.value === 'all') && (!s || !s.value.trim());
}

/** 概览定时刷新时只更新 chip 上的题量数字，不重建 DOM，避免打断当前筛选状态 */
function updateChipCounts(bank){
  // 正在按年级 / 难度 / 题型 / 关键词筛的时候不能拿全库数顶回去，
  // 否则每 10 秒数字自己跳回 2564，家长看到的就是「筛选没生效」。
  if (!bankScopeIsDefault()) return;
  paintChipCounts({ total: (bank || {}).total, bySubject: (bank || {}).bySubjectName });
}

window.setQSubject = k => {
  qSubject = k;
  const chips = $('qSubjects').children;
  for (let i = 0; i < chips.length; i++) chips[i].classList.toggle('on', chips[i].dataset.key === k);
  loadQuestions(true);
};

/** 题库页切换年级后，用该年级的学科列表重绘 chips 与录入下拉 */
window.setGradeSubjects = function(list){
  QSUBJ = list || [];
  // 同名就算还在：chips 按名字合并，切年级后选中态跟名字走
  const names = new Set(QSUBJ.map(s => s.name));
  const cur = subjOf(qSubject).name;
  if (qSubject !== 'all' && !names.has(cur)) qSubject = 'all';
  // 直接带 #bank 进来时 overview 可能还没回来：这里也要能画 chips，
  // 否则学科列表更新了、chips 还是空的，看着像筛选没生效
  const ov = lastOverview || { policy: { subjects: [] }, bank: {} };
  renderSubjects(ov.policy || { subjects: [] }, ov.bank || {});
};

window.syncOptionHint = function(){
  const k = $('nSubject').value || 'math';
  const t = $('nType').value;
  const ph = {
    prompt: '365 + 128 = ?',
    hint: '先算 365+100，再加 28',
    expl: '365 + 128 = 493'
  };
  $('nPrompt').placeholder = ph.prompt;
  $('nHint').placeholder = ph.hint;
  $('nExplanation').placeholder = ph.expl;

  if (t === 'judge') {
    $('fNOptions').style.display = 'none';
    $('nAnswerLabel').textContent = '答案（对 / 错，√ × 也认）';
    $('nAnswer').placeholder = '对';
    return;
  }
  $('fNOptions').style.display = '';
  $('nAnswerLabel').textContent = t === 'multi' ? '答案（多个正确项用 | 分隔）' : '答案';
  $('nAnswer').placeholder = t === 'multi' ? 'red|blue' : '493';

  if (t === 'multi') {
    $('nOptionsLabel').textContent = '选项（必填，逗号分隔）';
    $('nOptions').placeholder = 'red,blue,apple,book';
    return;
  }
  const isMath = k === 'math';
  $('nOptionsLabel').textContent = isMath
    ? '选项（可选，逗号分隔；留空自动生成干扰项）'
    : '选项（必填，逗号分隔，至少 2 个）';
  $('nOptions').placeholder = isMath ? '493,483,503,383'
    : (k === 'english' ? 'apple,banana,orange' : '谦虚,自豪,高兴');
};

// 单选题 / 多选题切换后，答案与选项的文案要跟着变

let lastOverview = null;

async function loadOverview(){
  try {
    const d = await api('/api/admin/overview');
    lastOverview = d;
    SUBJ = d.subjects || [];

    $('pDaily').value = d.policy.dailyLimitMin;
    $('pInterval').value = d.policy.quizIntervalMin;
    $('pDiff').value = String(d.policy.difficulty === undefined ? 0 : d.policy.difficulty);
    // 老数据 quizGrade=-1（仅通用题）界面已没有这个选项，回落成不限年级
    const pg = Number(d.policy.quizGrade);
    $('pGrade').value = String(pg === -1 || !pg ? 0 : pg);
    $('pIncGeneral').checked = !!d.policy.quizIncludeGeneral;
    $('pEnabled').checked = !!d.policy.enabled;
    $('pQuizMode').value = d.policy.quizMode || 'single';
    $('pGroupSize').value = d.policy.groupSize || 5;
    $('pPassRate').value = d.policy.groupPassRate || 60;
    $('pWrongPolicy').value = d.policy.wrongPolicy === 'pass' ? 'pass' : 'retry';
    $('pWrongBoost').value = d.policy.wrongBoostRate === undefined ? 40 : d.policy.wrongBoostRate;
    $('pWrongGrad').value = d.policy.wrongGraduate || 2;
    $('pRewardOn').checked = !!d.policy.rewardEnabled;
    $('pRewardCount').value = d.policy.rewardQuizCount || 10;
    $('pRewardMin').value = d.policy.rewardMin || 10;
    $('pRewardTimes').value = d.policy.rewardTimes || 2;
    $('pDeskGuard').checked = d.policy.desktopGuard !== false;
    lastWrong = d.wrong || { total: 0, bySubject: {} };
    bankTotal = (d.bank && d.bank.total) || 0;
    renderBankEntry();

    renderSubjects(d.policy, d.bank);
    renderSched(d.policy);
    renderDevices(d.devices);
    // 留言栏卡片跟着概览一起刷新（推送后不用手动刷新页面）
    if (typeof renderNoticeCard === 'function') renderNoticeCard(d.notice);
    // 题库页那行「当前出题范围」跟着概览一起刷新
    if (typeof renderQuizScope === 'function') renderQuizScope();
  } catch (e) {
    // 别把真实原因吞掉：控制台留全量错误，状态点上带简短原因（如「未登录」「HTTP 500」）
    console.error('loadOverview 失败:', e);
    $('srvDot').className = 'dot off';
    $('srvText').textContent = '连接失败: ' + (e && e.message ? e.message : '未知');
  }
}

/** 放行方式 / 时段 两个下拉联动的显示与提示 */
window.syncMode = function(){
  const group = $('pQuizMode').value === 'group';
  $('fGroupSize').style.display = group ? '' : 'none';
  $('fPassRate').style.display = group ? '' : 'none';

  const mode = $('pSchedMode').value;
  const tips = {
    off: '不按时段管控，全天只看「每日上网总时长」和「答题间隔」。',
    quizOnly: '蓝色格子内：正常计时 + 到点弹题。格子外：随便看，不扣时长也不弹题 —— 适合白天老人看电视、晚上再管孩子。注意这时段管的是「要不要答题」，不限制能不能开机。',
    block: '蓝色格子外：电视直接锁定（提示下次可用时间），等于限定「什么时候能上网」。格子内仍要答题解锁，并遵守每日上网总时长。'
  };
  // 三种模式的差别收进「时段用途」旁边的 ⓘ，页面上不再占一大段
  setHiconTip($('schedTipIcon'), tips[mode] || '');
  syncReward();
};

/**
 * 答题换时长：开关打开时才展开设置区。
 */
window.syncReward = function(){
  if (!$('pRewardOn')) return;
  $('fReward').style.display = $('pRewardOn').checked ? '' : 'none';
};

let SCHED = { mode: 'off', days: [] };

function ensureSchedDays(){
  const d = Array.isArray(SCHED.days) ? SCHED.days.slice(0, 7) : [];
  while (d.length < 7) d.push('1'.repeat(48));
  SCHED.days = d.map(x => (typeof x === 'string' && /^[01]{48}$/.test(x)) ? x : '1'.repeat(48));
}

function renderSched(policy){
  const s = policy.schedule || {};
  SCHED = { mode: s.mode || 'off', days: (s.days || []).slice() };
  ensureSchedDays();
  $('pSchedMode').value = SCHED.mode;
  buildSchedGrid();
  updateSchedStat();
  syncMode();
}

function buildSchedGrid(){
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  let html = '<div class="sched-inner"><div class="sched-hours"><span></span>';
  for (let s = 0; s < 48; s += 6) {
    html += `<span class="sched-hour" style="grid-column:span 6">${String(s / 2).padStart(2, '0')}:00</span>`;
  }
  html += '</div>';
  for (let d = 0; d < 7; d++){
    html += `<div class="sched-row"><span class="sched-day">周${names[d]}</span>`;
    for (let s = 0; s < 48; s++){
      const on = SCHED.days[d][s] === '1';
      html += `<i class="sched-cell${on ? ' on' : ''}" data-d="${d}" data-s="${s}"></i>`;
    }
    html += '</div>';
  }
  html += '</div>';
  $('schedGrid').innerHTML = html;
}

function updateSchedStat(){
  let slots = 0;
  for (let d = 0; d < 7; d++) for (let s = 0; s < 48; s++) if (SCHED.days[d][s] === '1') slots++;
  $('schedStat').textContent = SCHED.mode === 'off'
    ? '未启用'
    : `本周共 ${(slots / 2).toFixed(1)} 小时`;
}

function setCell(el){
  const d = Number(el.dataset.d);
  const s = Number(el.dataset.s);
  const arr = SCHED.days[d].split('');
  arr[s] = paintVal;
  SCHED.days[d] = arr.join('');
  el.classList.toggle('on', paintVal === '1');
}

/* 说明文案按输入方式换：手机上没有鼠标，得告诉家长「按住 0.3 秒」才进拖动模式 */
if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
  const h = $('schedPaintHint');
  if (h) h.textContent = '左右滑动看后面的时间；按住 0.3 秒后可连续涂';
}

/* 拖动涂格子。
   三个坑：
   ① 触屏上「拖」和「滑」是同一个手势 —— 以前为了能拖涂把 touch-action 写死 none，
      结果手机上横向滑不动，48 格只看得见前 9 小时，后面的时间等于设不了。
      现在默认 touch-action:pan-x（能滑），真正开始涂时才由 .painting 临时冻结滚动；
   ② 触屏要区分「短按 = 单格开关」和「长按 = 连续涂」：按住 320ms 才进入拖动模式，
      中途手指移动超过 8px 就判定为滑动、放弃涂格；
   ③ 鼠标拖出格子后事件目标会变，靠 setPointerCapture 把后续事件锁在网格上。*/
let painting = false;
let paintVal = '1';
let pendingCell = null;   // 触屏按下后待判定的格子：短按涂它，长按转拖动
let pressTimer = null;
let downX = 0, downY = 0, downId = null;
const LONG_PRESS_MS = 320;
const MOVE_SLOP = 8;      // 手指移动超过这个距离就当滑动，不涂

function cellAt(x, y){
  const el = document.elementFromPoint(x, y);
  return el && el.closest ? el.closest('.sched-cell') : null;
}

function toggleCell(el){
  const prev = paintVal;
  paintVal = el.classList.contains('on') ? '0' : '1';
  setCell(el);
  paintVal = prev;
}

function beginPaint(c, pointerId){
  painting = true;
  paintVal = c.classList.contains('on') ? '0' : '1';
  setCell(c);
  c.classList.add('hit');
  // 涂的这一刻才冻结滚动，否则手指一按就滑不动了
  $('schedGrid').classList.add('painting');
  try { $('schedGrid').setPointerCapture(pointerId); } catch (_) {}
}

function cancelPress(){
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  pendingCell = null;
  downId = null;
}

$('schedGrid').addEventListener('pointerdown', e => {
  const c = e.target.closest('.sched-cell');
  if (!c) return;
  // 鼠标 / 手写笔：立刻进入拖涂（和以前一致）
  if (e.pointerType !== 'touch') {
    e.preventDefault();
    beginPaint(c, e.pointerId);
    return;
  }
  // 触屏：先不抢手势，抬手时再按短按/长按区分
  cancelPress();
  pendingCell = c;
  downX = e.clientX; downY = e.clientY; downId = e.pointerId;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    const cell = pendingCell;
    const id = downId;
    pendingCell = null;
    if (!cell || id === null) return;
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) {} }
    beginPaint(cell, id);
  }, LONG_PRESS_MS);
});

$('schedGrid').addEventListener('pointermove', e => {
  // 还没进入拖动模式时，手指一旦明显移动就认定是滑动，取消涂格等待
  if (pendingCell && (Math.abs(e.clientX - downX) > MOVE_SLOP || Math.abs(e.clientY - downY) > MOVE_SLOP)) {
    cancelPress();
  }
  if (!painting) return;
  e.preventDefault();
  const c = cellAt(e.clientX, e.clientY);
  if (c) setCell(c);
});

/* 鼠标的兜底：老浏览器/没吃到 capture 时，进入格子就涂，不依赖 move 的坐标换算 */
$('schedGrid').addEventListener('pointerover', e => {
  if (!painting) return;
  const c = e.target.closest('.sched-cell');
  if (c) setCell(c);
});

function endPaint(){
  if (!painting) return;
  painting = false;
  $('schedGrid').classList.remove('painting');
  document.querySelectorAll('.sched-cell.hit').forEach(el => el.classList.remove('hit'));
  updateSchedStat();
}
window.addEventListener('pointerup', () => {
  // 触屏短按（还没进入拖动模式就抬手）= 只开关这一格
  if (pressTimer && pendingCell) {
    const c = pendingCell;
    cancelPress();
    toggleCell(c);
  }
  endPaint();
});
window.addEventListener('pointercancel', () => { cancelPress(); endPaint(); });

window.applySchedTemplate = kind => {
  const full = '1'.repeat(48);
  const zero = '0'.repeat(48);
  if (kind === 'all') SCHED.days = Array(7).fill(full);
  else if (kind === 'clear') SCHED.days = Array(7).fill(zero);
  else if (kind === 'weekend') SCHED.days = [zero, zero, zero, zero, zero, full, full];
  else if (kind === 'evening') {
    // 周一到周五 17:00–21:00（第 34–41 格），周末全天
    const evening = zero.slice(0, 34) + '1'.repeat(8) + zero.slice(42);
    SCHED.days = [evening, evening, evening, evening, evening, full, full];
  }
  if (kind !== 'all' && SCHED.mode === 'off') $('pSchedMode').value = 'quizOnly';
  if ($('pSchedMode').value !== SCHED.mode) {}
  SCHED.mode = $('pSchedMode').value;
  buildSchedGrid();
  updateSchedStat();
  syncMode();
};

$('pSchedMode').addEventListener('change', () => {
  SCHED.mode = $('pSchedMode').value;
  updateSchedStat();
});

$('saveSched').onclick = async () => {
  try {
    await api('/api/admin/policy', {
      method: 'PUT',
      body: JSON.stringify({ schedule: { mode: $('pSchedMode').value, days: SCHED.days } })
    });
    toast('时段已保存，客户端半分钟内生效');
    loadDevices();
  } catch (e) { toast(e.message, true); }
};

/** 保存后只刷设备卡和统计，不回填表单 —— 否则会把另一块还没保存的编辑冲掉 */
async function savePolicy(){
  // 越界值先夹回范围再提交，服务端那边也会 clamp，但这里得让家长当场看到
  clampAllNumbers();
  // 一个学科都不勾是合法的：表示「不限学科，全部题目随机抽」
  const subjects = [...document.querySelectorAll('#pSubjects input[type=checkbox]')]
    .filter(el => el.checked).map(el => el.value);
  try {
    await api('/api/admin/policy', {
      method: 'PUT',
      body: JSON.stringify({
        dailyLimitMin: Number($('pDaily').value),
        quizIntervalMin: Number($('pInterval').value),
        difficulty: Number($('pDiff').value),
        quizGrade: Number($('pGrade').value),
        quizIncludeGeneral: $('pIncGeneral').checked,
        subjects,
        quizMode: $('pQuizMode').value,
        groupSize: Number($('pGroupSize').value),
        groupPassRate: Number($('pPassRate').value),
        wrongPolicy: $('pWrongPolicy').value,
        wrongBoostRate: Number($('pWrongBoost').value) || 0,
        wrongGraduate: Number($('pWrongGrad').value) || 2,
        rewardEnabled: $('pRewardOn').checked,
        rewardQuizCount: Number($('pRewardCount').value) || 10,
        rewardMin: Number($('pRewardMin').value) || 10,
        rewardTimes: Number($('pRewardTimes').value) || 2,
        desktopGuard: $('pDeskGuard').checked,
        enabled: $('pEnabled').checked
      })
    });
    markPolicyDirty(false);
    toast('策略已保存，客户端半分钟内生效');
    loadDevices();
  } catch (e) { toast(e.message, true); }
}

$('savePolicy').onclick = savePolicy;

/**
 * 策略卡是「填完点保存」而不是自动保存，但卡片很长、按钮在底部，
 * 很容易改完上面几项以为已经生效 —— 所以改任何一项就亮一个「有未保存的改动」。
 */
function markPolicyDirty(dirty){
  const el = $('polDirty');
  if (!el) return;
  el.style.display = dirty ? '' : 'none';
}

['input', 'change'].forEach(evt => {
  $('policyCard').addEventListener(evt, e => {
    if (e.target && e.target.id !== 'savePolicy') markPolicyDirty(true);
  });
});

// 有没保存的改动时关页面/刷新，让浏览器问一句，别白改
window.addEventListener('beforeunload', e => {
  const el = $('polDirty');
  if (el && el.style.display !== 'none') {
    e.preventDefault();
    e.returnValue = '';
  }
});


