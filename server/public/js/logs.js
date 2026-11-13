const EV_NAMES = {
  register: '设备注册', quiz_served: '出题', quiz_answer: '答题',
  login: '登录', login_failed: '登录失败', seed: '初始化题库',
  import: '导入题目', export: '导出题库', apps_sync: '同步应用', question_reset: '清出题记录',
  unlock_ok: '家长验证通过', unlock_failed: '家长验证失败',
  keepalive_fix: '自动保活', device_revive: '离线唤醒', device_delete: '删除设备',
  device_offline: '连接断开', device_online: '连接恢复',
  server_upgrade: '管理端升级', server_upgrade_failed: '升级失败', server_rollback: '管理端回滚', server_rollback_failed: '回滚失败',
  shot_error: '截屏', shot_toggle: '截屏开关', adb_key: '同步 adb 密钥',
  device_ip: '指定电视 IP',
  password_changed: '修改管理密码',
  notice_push: '推送留言', notice_clear: '清除留言',
  log_export: '日志归档',
  subject_add: '新增学科', subject_delete: '删除学科',
  question_edit: '编辑题目', question_delete: '删除题目'
};

function evTime(ts){ return new Date(ts).toLocaleString('zh-CN'); }

function evDevice(e){
  if (!e.deviceId) return '—';
  return `<span class="mono" style="font-size:12px">${esc(e.deviceId)}</span>`;
}

/** 一条事件的「详情」列：按类型把有意义的字段拼出来 */
function evDetail(e){
  const p = [];
  // 高频事件合并过的，先标一句「合并 N 次」，免得家长以为只上报了一次
  if (e.merged > 1) p.push(`<span class="tag" style="color:#F5CE6B">合并 ${e.merged} 次</span>`);
  if (e.model) p.push(esc(e.model));
  if (e.subject){
    const s = subjOf(e.subject);
    p.push(`<span class="tag sub" style="color:${s.color}">${esc(s.name)}</span>`);
  }
  if (e.level) p.push(`难度 ${['', '简单', '中等', '挑战'][e.level] || e.level}`);
  if (e.correct !== undefined && e.correct !== null){
    p.push(e.correct ? '<span style="color:#6FD08C">答对</span>' : '<span style="color:#F79C9C">答错</span>');
  }
  if (e.choice) p.push(`作答 ${esc(String(e.choice).slice(0, 24))}`);
  if (e.qid) p.push(`<span class="muted">题 ${esc(String(e.qid).slice(0, 10))}</span>`);
  if (e.count !== undefined) p.push(`${e.count} 个应用`);
  if (e.target) p.push(esc(e.target));
  if (e.error) p.push(`<span style="color:#F79C9C">${esc(e.error)}</span>`);
  if (e.ok !== undefined || e.failed !== undefined){
    p.push(`成功 ${e.ok || 0}${e.failed ? ` · 失败 <span style="color:#F79C9C">${e.failed}</span>` : ''}`);
  }
  if (e.ip) p.push(`<span class="muted">${esc(e.ip)}</span>`);
  return p.join(' · ') || '<span class="muted">—</span>';
}

/**
 * 一条事件表格行。
 *
 * 「答题」「出题」这两种带 qid 的行可以点开看题目原文 —— 那就加 data-ev 指到
 * 当前列表里的下标，点的时候按下标回查事件对象（比把整条 JSON 塞进 DOM 属性干净）。
 */
function evRow(e, i){
  const hit = (e.type === 'quiz_answer' || e.type === 'quiz_served') && e.qid;
  return `<tr${hit ? ` class="hit" data-ev="${i}" title="点击查看题目详情"` : ''}>
    <td class="muted" style="white-space:nowrap">${evTime(e.ts)}</td>
    <td><span class="tag"${EV_GROUP_OF[e.type] ? ' title="筛选分组：' + esc(EV_GROUP_OF[e.type]) + '"' : ''}>${esc(EV_NAMES[e.type] || e.type)}</span></td>
    <td>${evDevice(e)}</td>
    <td class="muted">${evDetail(e)}</td>
  </tr>`;
}

/**
 * 首页：只取最近 10 条，看全部去二级页。
 *
 * 连接断开 / 恢复、自动保活也要折叠（和运行日志页同一口径）——一晚上待机会翻十几次，
 * 不折叠的话首页 10 行永远只有这几类。只是不显示，记录都在 events.jsonl
 * 和每天的归档文件里，一条不少；想看去二级页点「显示连接日志」。
 */
const EV_HOME_EXCLUDE = 'device_online,device_offline,keepalive_fix';

async function loadEvents(){
  try {
    const d = await api('/api/admin/events?limit=10&exclude=' + EV_HOME_EXCLUDE);
    evCache = d.items || [];
    $('evStat').textContent = d.total
      ? `共 ${d.total} 条` + (d.hidden ? ` · 已折叠连接 ${d.hidden} 条` : '') + ` · 显示最近 ${Math.min(10, d.total)} 条`
      : '';
    $('evStat').title = '连接断开 / 恢复、自动保活太频繁，首页默认折叠；想看去运行日志页点「显示连接日志」，或下载归档日志文件';
    $('evBody').innerHTML = d.items.length
      ? d.items.map(evRow).join('')
      : '<tr><td colspan="4" class="empty">暂无事件</td></tr>';
  } catch (e) { /* 静默 */ }
}

let logPage = 1;
let logSize = Number(localStorage.getItem('tg_logsize')) || 20;
let logGroup = 'all';   // 当前选中的筛选键（用来画高亮）
let logType = 'all';    // 发给服务端的 type（分组是逗号分隔的多个类型）
let logFine = false;    // 是否展开到具体类型

/**
 * 连接断开 / 连接恢复 / 自动保活默认折叠起来。
 *
 * 电视一晚上待机会翻十几次、保活自检也会反复跑，这几类铺满一屏，家长根本看不到
 * 「谁答了题、谁改了策略」。注意：**只是不显示，不是删掉** —— 点「显示连接日志」
 * 随时能看（同类高频记录还会合并成一条带次数），每天的归档文件里也一条不少。
 */
const CONN_TYPES = 'device_online,device_offline,keepalive_fix';
let logHideConn = localStorage.getItem('tg_hideconn') !== '0';

/**
 * 筛选栏分组：明细 18 种太多，按业务收成 6 组。
 * 服务端 queryEvents 的 type 支持逗号分隔，所以分组筛选不用改后端。
 * 「细分」按钮可临时展开回原来的具体类型，能力不丢。
 */
const EV_GROUPS = [
  { key: 'quiz',   name: '答题',     types: ['quiz_served', 'quiz_answer'] },
  { key: 'auth',   name: '登录验证', types: ['login', 'login_failed', 'unlock_ok', 'unlock_failed'] },
  { key: 'bank',   name: '题库同步', types: ['seed', 'import', 'apps_sync', 'question_reset', 'question_edit', 'question_delete'] },
  { key: 'device', name: '设备', types: ['register', 'device_delete', 'device_revive', 'device_ip'] },
  { key: 'conn',   name: '连接日志', types: ['device_online', 'device_offline', 'keepalive_fix'] },
  { key: 'notice', name: '留言', types: ['notice_push', 'notice_clear'] },
  { key: 'shot',   name: '截屏',     types: ['shot_error', 'shot_toggle', 'adb_key', 'password_changed'] },
  { key: 'server', name: '管理端',   types: ['server_upgrade', 'server_upgrade_failed', 'server_rollback', 'server_rollback_failed', 'log_export'] }
];
const EV_GROUP_KEYS = new Set(EV_GROUPS.flatMap(g => g.types));
const EV_GROUP_OF = {};
EV_GROUPS.forEach(g => g.types.forEach(t => { EV_GROUP_OF[t] = g.name; }));

/** 两个列表各自的事件缓存：行上只存下标，点开时按下标取对象 */
let evCache = [];
let logCache = [];

function openLogs(){
  hideViews();
  $('logsView').classList.remove('hidden');
  if (location.hash !== '#logs') history.replaceState(null, '', '#logs');
  window.scrollTo(0, 0);
  $('logSize').value = String(logSize);
  // 设备下拉要拿首页那份数据；直接带 #logs 进来时可能还没拉到
  if (lastOverview) { fillLogDevices(); loadLogs(true); loadLogFiles(); }
  else loadOverview().then(() => { fillLogDevices(); loadLogs(true); loadLogFiles(); });
}

function closeLogs(){
  $('logsView').classList.add('hidden');
  $('mainView').classList.remove('hidden');
  if (location.hash) history.replaceState(null, '', location.pathname);
  window.scrollTo(0, 0);
  loadEvents();
}

/** 设备下拉：直接用首页那份 overview，不再多请求一次 */
function fillLogDevices(){
  const sel = $('logDevice');
  const cur = sel.value;
  const list = (lastOverview && lastOverview.devices) || [];
  sel.innerHTML = '<option value="all">全部设备</option>' + list.map(d =>
    `<option value="${esc(d.id)}">${esc(d.name || d.id)}</option>`).join('');
  sel.value = list.some(d => d.id === cur) ? cur : 'all';
}

/**
 * 类型筛选标签：默认按业务分组，数量取服务端全量统计（不受当前筛选影响）。
 * 未归进分组的新类型不会丢，统一收到「其他」里。
 */
function renderLogTypes(byType, hidden){
  const stat = byType || {};
  const total = Object.values(stat).reduce((a, b) => a + b, 0);
  const mk = (key, name, n, type, title) =>
    `<button class="small ${logGroup === key ? 'primary' : ''}" data-group="${esc(key)}" data-type="${esc(type)}"${title ? ` title="${esc(title)}"` : ''}>${esc(name)} ${n}</button>`;
  const detailOf = keys => keys.filter(k => stat[k])
    .map(k => `${EV_NAMES[k] || k} ${stat[k]}`).join(' · ');

  let html = mk('all', '全部', total, 'all');
  if (logFine){
    // 细分视图：按具体类型展开，只列出现过的
    const keys = Object.keys(stat);
    html += keys.map(k => mk(k, EV_NAMES[k] || k, stat[k], k)).join('');
  } else {
    for (const g of EV_GROUPS){
      const n = g.types.reduce((s, t) => s + (stat[t] || 0), 0);
      if (!n) continue;   // 没有记录的分组不占位
      html += mk(g.key, g.name, n, g.types.join(','), '包含：' + detailOf(g.types));
    }
    const others = Object.keys(stat).filter(k => !EV_GROUP_KEYS.has(k));
    const otherN = others.reduce((s, k) => s + stat[k], 0);
    if (otherN) html += mk('other', '其他', otherN, others.join(','), '包含：' + detailOf(others));
  }
  html += `<button class="small ghost" data-fine="1" title="按具体事件类型筛选">${logFine ? '收起细分' : '细分 ▾'}</button>`;
  // 连接断开 / 恢复：默认折叠，按钮上直接写清楚藏了多少条
  html += `<button class="small ghost" data-conn="1" title="连接日志（连接断开 / 恢复、自动保活）太频繁，默认折叠；每天的归档日志文件里一条不少">${
    logHideConn ? `显示连接日志${hidden ? ` ${hidden}` : ''}` : '隐藏连接日志'}</button>`;
  $('logTypes').innerHTML = html;
}

async function loadLogs(reset){
  if (reset) logPage = 1;
  const offset = (logPage - 1) * logSize;
  const params = new URLSearchParams({
    type: logType,
    deviceId: $('logDevice').value || 'all',
    q: $('logSearch').value.trim(),
    exclude: logHideConn ? CONN_TYPES : '',
    offset: String(offset),
    limit: String(logSize)
  });
  try {
    const d = await api('/api/admin/events?' + params.toString());
    const pages = Math.max(1, Math.ceil(d.total / logSize));
    if (logPage > pages){ logPage = pages; return loadLogs(false); }

    renderLogTypes(d.byType, d.hidden);
    logCache = d.items || [];
    $('logBody').innerHTML = d.items.length
      ? d.items.map(evRow).join('')
      : '<tr><td colspan="4" class="empty">这个筛选条件下没有日志</td></tr>';
    $('logsStat').textContent = `共 ${d.total} 条 · 日志文件共 ${d.scanned} 条` +
      (logHideConn && d.hidden ? ` · 已折叠连接记录 ${d.hidden} 条` : '') +
      ' · 每天 00:05 自动导出昨天明细';
    renderPager($('logPager'), logPage, logSize, d.total, g => {
      if (g === 'first') logPage = 1;
      else if (g === 'last') logPage = pages;
      else logPage = Math.min(pages, Math.max(1, logPage + g));
      loadLogs(false);
    });
  } catch (e) { toast(e.message, true); }
}

$('evMore').onclick = openLogs;
$('logsBack').onclick = closeLogs;
$('logsRefresh').onclick = () => { fillLogDevices(); loadLogs(false); };
$('logSize').onchange = () => {
  logSize = Number($('logSize').value) || 20;
  try { localStorage.setItem('tg_logsize', String(logSize)); } catch (e) {}
  loadLogs(true);
};
$('logDevice').onchange = () => loadLogs(true);
$('logQuery').onclick = () => loadLogs(true);
$('logSearch').addEventListener('keydown', e => { if (e.key === 'Enter') loadLogs(true); });
$('logTypes').onclick = e => {
  const fine = e.target.closest('button[data-fine]');
  if (fine){
    logFine = !logFine;
    logGroup = 'all'; logType = 'all';   // 视图切换后回到全部，避免高亮对不上
    loadLogs(true);
    return;
  }
  const conn = e.target.closest('button[data-conn]');
  if (conn){
    logHideConn = !logHideConn;
    try { localStorage.setItem('tg_hideconn', logHideConn ? '1' : '0'); } catch (e) {}
    // 折叠时「连接记录」这个分组会从标签里消失，当前又正好筛着它 → 回到全部
    if (logHideConn && logGroup === 'conn'){ logGroup = 'all'; logType = 'all'; }
    loadLogs(true);
    return;
  }
  const b = e.target.closest('button[data-type]');
  if (!b) return;
  logGroup = b.dataset.group || b.dataset.type;
  logType = b.dataset.type;
  loadLogs(true);
};

/**
 * 归档卡片：每天 00:05 服务端把「昨天」的全部事件导出成 tvguard-YYYY-MM-DD.log，
 * 连接断开 / 恢复也都在里面；导出成功后这些事件从实时日志里删掉。
 * 这里只负责列出来 + 下载 / 删除 / 手动补导。
 */
const fmtBytes = n => {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
};

/** 服务端的「今天」（YYYY-MM-DD，时区以服务端为准），loadLogFiles 时刷新 */
let logToday = '';

/** 浏览器本地兜底：服务端的 today 没拿到时用（国内部署两边的日期一致） */
function localToday(){
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** YYYY-MM-DD 加减天数。用 T00:00:00 构造本地时间，不经过 UTC，避免跨时区差一天 */
function shiftDay(dayStr, delta){
  const d = new Date(dayStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + delta);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 手动导出公共流程：「导出今天」「导出该日」共用同一个接口，只是 day 不同。
 * 都是 keep=true —— 只落文件，不动实时日志（自动归档才删）。
 * 重复导出同一天会覆盖旧文件，想拿最新的再点一次就行。
 * 服务端 exportDay 会拒绝未来日期和没有记录的日期，错误直接 toast 出来。
 */
async function exportDayManual(btn, day){
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '导出中…';
  try {
    const d = await api('/api/admin/eventlogs/export', {
      method: 'POST',
      body: JSON.stringify({ day: day || localToday() })
    });
    toast(`已导出 ${d.day}：${d.count} 条 → ${d.file}，在下方列表里下载`);
    await loadLogFiles();
    loadLogs(true);           // 导昨天会把昨天的实时记录删掉，列表要跟着减小
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

$('logExportTodayBtn').onclick = function(){ exportDayManual(this, logToday); };
$('logExportDayBtn').onclick = function(){
  const day = ($('logExportDay').value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { toast('先选一个日期', true); return; }
  exportDayManual(this, day);
};
$('logFilesRefresh').onclick = loadLogFiles;

async function loadLogFiles(){
  const body = $('logFilesBody');
  if (!body) return;
  try {
    const d = await api('/api/admin/eventlogs');
    const files = d.files || [];
    logToday = (d.today && d.today.day) || logToday;
    // 日期选择器：默认昨天（最常导的那天），最大只能选到今天
    const dayInput = $('logExportDay');
    if (dayInput && logToday){
      dayInput.max = logToday;
      if (!dayInput.value) dayInput.value = shiftDay(logToday, -1) || logToday;
    }
    const today = (d.today && d.today.count) || 0;
    $('logFilesStat').textContent = files.length
      ? `${files.length} 个归档文件 · 今天实时 ${today} 条`
      : `还没有归档文件 · 今天实时 ${today} 条`;
    body.innerHTML = files.length ? files.map(f => `
      <tr data-file="${esc(f.file)}">
        <td class="mono" style="font-size:12.5px">${esc(f.day)}</td>
        <td>${f.count ? f.count + ' 条' : '<span class="muted">—</span>'}</td>
        <td class="muted">${fmtBytes(f.bytes)}</td>
        <td class="muted">${f.at ? new Date(f.at).toLocaleString('zh-CN') : '—'}</td>
        <td style="text-align:right">
          <a class="small btnlike" href="/api/admin/eventlogs/file?name=${encodeURIComponent(f.file)}"
             download="${esc(f.file)}" title="下载完整明细（含连接断开 / 恢复）">下载</a>
          <button class="small ghost" data-del="${esc(f.file)}" title="删除这个归档文件">删除</button>
        </td>
      </tr>`).join('')
      : '<tr><td colspan="5" class="empty">还没有归档文件。点右上角「导出今天 / 导出昨天」立刻生成一个，明天 00:05 也会自动导出昨天的。</td></tr>';
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" class="empty">读取失败：${esc(e.message)}</td></tr>`;
  }
}


$('logFilesBody').onclick = async e => {
  const del = e.target.closest('button[data-del]');
  if (!del) return;
  const name = del.dataset.del;
  if (!confirm(`删除归档文件 ${name}？删除后这段日志就彻底没了（不能恢复）。`)) return;
  try {
    await api('/api/admin/eventlogs/file?name=' + encodeURIComponent(name), { method: 'DELETE' });
    await loadLogFiles();
  } catch (err) { toast(err.message, true); }
};

/** 点「答题 / 出题」那行 → 弹出这道题。两个列表共用一套弹层。 */
function bindEventClicks(tbody, getList){
  tbody.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-ev]');
    if (!tr) return;
    const item = getList()[Number(tr.dataset.ev)];
    if (item) showEventDetail(item);
  });
}
bindEventClicks($('evBody'), () => evCache);
bindEventClicks($('logBody'), () => logCache);

function closeEventDetail(){ $('evModal').classList.add('hidden'); }
$('evmClose').onclick = closeEventDetail;
$('evModal').onclick = e => { if (e.target === $('evModal')) closeEventDetail(); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('evModal').classList.contains('hidden')) closeEventDetail();
});

async function showEventDetail(ev){
  const s = subjOf(ev.subject);
  $('evModal').classList.remove('hidden');
  $('evmTitle').textContent = ev.type === 'quiz_served' ? '这道题出给了电视'
    : '答题详情';
  $('evmMeta').innerHTML = [
    ev.subject ? `<span class="tag sub" style="color:${s.color}">${esc(s.name)}</span>` : '',
    ev.level ? `难度 ${['', '简单', '中等', '挑战'][ev.level] || ev.level}` : '',
    evTime(ev.ts),
    ev.deviceId ? `<span class="mono" style="font-size:12px">${esc(ev.deviceId)}</span>` : ''
  ].filter(Boolean).join(' · ');

  if (!ev.qid){
    $('evmBody').innerHTML = '<div class="empty">这条记录没有题目编号</div>';
    return;
  }
  $('evmBody').innerHTML = '<div class="muted" style="padding:20px 0">正在读取题目…</div>';
  try {
    const q = await api('/api/admin/questions/' + encodeURIComponent(ev.qid));
    $('evmBody').innerHTML = renderQuestionDetail(q, ev);
  } catch (e) {
    $('evmBody').innerHTML = `<div class="empty">题目已经不在题库里了<br>
      <span class="muted">编号 ${esc(ev.qid)}（${esc(e.message)}）</span></div>`;
  }
}

/** 答题 / 出题里保存的答案字段可能是「A|B」这种多选串，统一拆开比 */
function splitAns(v){
  return String(v == null ? '' : v).split(/[|｜,，、]/).map(x => x.trim()).filter(Boolean);
}

function renderQuestionDetail(q, ev){
  const right = new Set(splitAns(q.answer));
  const picked = new Set(splitAns(ev.choice));
  const opts = (q.options || []).map((o, i) => {
    const isRight = right.has(o);
    const isPicked = picked.has(o);
    let cls = '';
    let mk = String.fromCharCode(65 + i);
    if (isRight) { cls = ' ok'; mk = '✓'; }
    else if (isPicked) { cls = ' bad'; mk = '✗'; }
    const who = isPicked
      ? `<span class="who">${isRight ? '孩子选对了' : '孩子选的'}</span>`
      : '';
    return `<div class="q-opt${cls}"><span class="mk">${mk}</span><span>${esc(o)}</span>${who}</div>`;
  }).join('');

  const typeName = { judge: '判断题', multi: '多选题（可多选）', choice: '单选题' }[q.type] || '单选题';
  const verdict = (ev.correct === undefined || ev.correct === null)
    ? '<span class="muted">只出了题，还没作答</span>'
    : (ev.correct ? '<span style="color:var(--ok);font-weight:600">答对了</span>'
      : '<span style="color:var(--bad);font-weight:600">答错了</span>');
  const ansText = Array.isArray(q.answer) ? q.answer.join(' | ') : q.answer;

  return `
    <div class="muted" style="margin-top:8px">${typeName} · 编号 ${esc(q.id)}${q.source ? ' · ' + esc(q.source) : ''}</div>
    <div class="q-prompt">${esc(q.prompt)}</div>
    ${opts || '<div class="muted">这道题没有选项</div>'}
    <div class="q-note">
      <div>作答：${ev.choice ? esc(String(ev.choice)) : '—'} · ${verdict}</div>
      <div>正确答案：<b style="color:var(--ok)">${esc(ansText)}</b></div>
      ${q.explanation ? `<div>解析：${esc(q.explanation)}</div>` : ''}
      ${q.hint ? `<div class="muted">提示：${esc(q.hint)}</div>` : ''}
    </div>`;
}

