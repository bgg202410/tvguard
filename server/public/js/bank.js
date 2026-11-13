// 首页只留一行入口，题库列表 / 新增 / 导入全部收到这里，避免首页被表格撑得很长

/** 二级页共用一个切换动作：全部藏起来，再放要显示的那一个 */
function hideViews(){
  ['mainView', 'bankView', 'wrongView', 'logsView', 'apkView'].forEach(id => $(id).classList.add('hidden'));
}

function openBank(){
  hideViews();
  $('bankView').classList.remove('hidden');
  if (location.hash !== '#bank') history.replaceState(null, '', '#bank');
  window.scrollTo(0, 0);
  // 每次进题库页都退回普通浏览：批量勾选不跨次保留，免得一进来就是一片蓝底
  setBatchMode(false);
  renderQuizScope();
  loadQuestions(true);
}

function closeBank(){
  $('bankView').classList.add('hidden');
  $('mainView').classList.remove('hidden');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  window.scrollTo(0, 0);
}

$('bankBtn').onclick = openBank;
$('bankBack').onclick = closeBank;
$('bankAdd').onclick = () => {
  const d = $('dNew');
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('bankImport').onclick = () => {
  const d = $('dImp');
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

let bankTotal = 0;
let lastWrong = { total: 0, bySubject: {} };

/** 题库页按钮上的错题数（首页入口卡已移除，这里只剩错题本按钮一处） */
function renderBankEntry(){
  const n = lastWrong.total || 0;
  const stat = $('bankEntryStat');
  if (stat) stat.textContent =
    `共 ${bankTotal} 道 · ${SUBJ.length} 个学科 · ` + (n ? `错题 ${n} 道 · ` : '') + '点这里增删改';
  $('bankWrong').textContent = n ? `错题本 ${n}` : '错题本';
}

async function loadWrong(){
  try {
    const d = await api('/api/admin/wrong');
    lastWrong = { total: d.total || 0, bySubject: d.bySubject || {} };
    renderBankEntry();
    $('wrongStat').textContent = d.total
      ? `共 ${d.total} 道 · 答错次数多的排前面`
      : '还没有错题';
    $('wBody').innerHTML = d.items.length
      ? d.items.map(x => `
        <tr>
          <td>${subjectTag(x.subject)}</td>
          <td>${x.level ? `<span class="tag l${x.level}">${['', '简单', '中等', '挑战'][x.level] || ''}</span>` : ''}</td>
          <td>${esc(x.prompt)}${x.exists ? '' : ' <span class="muted">（题目已删除）</span>'}</td>
          <td>${esc(String(x.answer || ''))}</td>
          <td>${x.times} 次</td>
          <td class="muted">${x.streak} 次</td>
          <td class="muted">${ago(x.lastAt)}</td>
          <td><button class="small danger" onclick="dropWrong('${x.id}')">移出</button></td>
        </tr>`).join('')
      : `<tr><td colspan="8" class="empty">还没有错题，孩子答错的题会自动进这里</td></tr>`;
    $('wMore').textContent = d.total ? '连续答对「算学会」次数后会自动移出，也可以手动移出' : '';
  } catch (e) {
    toast(e.message, true);
  }
}

window.dropWrong = async id => {
  try {
    await api('/api/admin/wrong/' + encodeURIComponent(id), { method: 'DELETE' });
    toast('已移出错题本');
    loadWrong();
  } catch (e) { toast(e.message, true); }
};

function openWrong(){
  hideViews();
  $('wrongView').classList.remove('hidden');
  if (location.hash !== '#wrong') history.replaceState(null, '', '#wrong');
  window.scrollTo(0, 0);
  loadWrong();
}

function closeWrong(){
  $('wrongView').classList.add('hidden');
  $('bankView').classList.remove('hidden');
  if (location.hash !== '#bank') history.replaceState(null, '', '#bank');
  window.scrollTo(0, 0);
  loadQuestions(true);
}

$('bankWrong').onclick = openWrong;
$('wrongBack').onclick = closeWrong;
$('wrongRefresh').onclick = loadWrong;

$('loginBtn').onclick = async () => {
  $('loginErr').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('pwd').value }) });
    $('pwd').value = '';
    showApp();
  } catch (e) {
    $('loginErr').textContent = e.message;
  }
};
$('pwd').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

$('logoutBtn').onclick = async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
};

// 分页：页码从 1 开始，每页条数记在 localStorage，下次进来还是这个数
let qPage = 1;
let qPageSize = Number(localStorage.getItem('tg_qsize')) || 20;

/**
 * 通用分页条：首页 / 上一页 / 「第 x–y 条 · 共 n 条 · p/q 页」 / 下一页 / 末页
 * go 收到 -1 / 1 / 'first' / 'last'
 */
function renderPager(el, page, size, total, go){
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  el.innerHTML = `
    <button class="small" data-pg="first" ${page <= 1 ? 'disabled' : ''}>« 首页</button>
    <button class="small" data-pg="prev" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
    <span class="info">第 ${from}–${to} 条 · 共 ${total} 条 · 第 ${page} / ${pages} 页</span>
    <button class="small" data-pg="next" ${page >= pages ? 'disabled' : ''}>下一页 ›</button>
    <button class="small" data-pg="last" ${page >= pages ? 'disabled' : ''}>末页 »</button>`;
  el.onclick = e => {
    const b = e.target.closest('button[data-pg]');
    if (!b || b.disabled) return;
    const k = b.dataset.pg;
    go(k === 'first' || k === 'last' ? k : (k === 'prev' ? -1 : 1));
  };
}

async function loadQuestions(reset){
  if (reset) qPage = 1;
  const subject = qSubject;
  const type = $('qType').value;
  const level = $('qLevel').value;
  const grade = $('qGrade').value;
  const kw = $('qSearch').value.trim();
  // 选了具体年级时，「含通用题」勾上才把 grade=0 的题一起列出来
  const incG = grade !== 'all' && $('qIncGeneral').checked ? 1 : 0;
  const offset = (qPage - 1) * qPageSize;
  try {
    const d = await api(`/api/admin/questions?subject=${subject}&type=${type}&level=${level}&grade=${grade}&incGeneral=${incG}&q=${encodeURIComponent(kw)}&offset=${offset}&limit=${qPageSize}`);
    // 删掉某页最后一条后页码可能越界，自动退一页
    const pages = Math.max(1, Math.ceil(d.total / qPageSize));
    if (qPage > pages){ qPage = pages; return loadQuestions(false); }

    // chips 上的题量按「当前筛选」重算：选了一年级就只显示一年级的题数
    paintChipCounts({ total: d.scopeTotal, bySubject: d.bySubject });
    // 上面那行「当前筛选 + 共 N 道」跟着一起变
    renderQuizScope(d.total);

    $('qBody').innerHTML = d.items.length ? d.items.map(q => {
      const picked = qSel.has(q.id);
      const pin = Number(q.priority) > 0
        ? `<span class="tag" style="margin-left:6px;background:rgba(76,141,255,.16);color:var(--brand)" title="优先级 ${q.priority}：会排在未设置优先级的题前面">置顶 ${q.priority}</span>`
        : '';
      return `
        <tr data-id="${q.id}" class="${picked ? 'qsel' : ''}">
          <td><input type="checkbox" class="qpick" data-id="${q.id}" ${picked ? 'checked' : ''}
                title="勾选后可批量启用 / 停用 / 删除"></td>
          <td>${gradeTag(q.grade)}</td>
          <td>${subjectTag(q.subject)}</td>
          <td><span class="tag">${TYPE_NAME[q.type] || '单选'}</span></td>
          <td><span class="tag l${q.level}">${['','简单','中等','挑战'][q.level] || '?'}</span><span class="stars">${'★'.repeat(q.stars || 1)}</span></td>
          <td class="qstem" onclick="editQ('${q.id}')" title="点一下编辑这道题">
            ${esc(q.prompt)}${pin}</td>
          <td><b>${q.answer ? esc(String(q.answer).split('|').join(' + ')) : '<span class="muted">无需作答</span>'}</b></td>
          <td class="muted cellnote">
            <div class="hintline" title="${esc(q.hint || '')}">${esc(q.hint || '—')}</div>
            ${q.explanation ? `<div class="expline" title="${esc(q.explanation)}">解析：${esc(q.explanation)}</div>` : ''}
          </td>
          <td>${q.enabled ? '<span class="tag l1">启用</span>' : '<span class="tag">停用</span>'}</td>
          <td>
            <div class="qacts">
              <button class="small" onclick="editQ('${q.id}')" title="改题干 / 答案 / 选项 / 难度">编辑</button>
              <button class="small" onclick="toggleQ('${q.id}',${q.enabled ? 'false' : 'true'})">${q.enabled ? '停用' : '启用'}</button>
              <button class="small" onclick="resetQ('${q.id}')" title="清掉这道题的出题记录：立刻回到「还没出过」的优先池，不用等 30 分钟冷却">清记录</button>
              <button class="small danger" onclick="delQ('${q.id}')">删</button>
            </div>
          </td>
        </tr>`;
    }).join('')
      : `<tr><td colspan="10" class="empty">没有匹配的题目</td></tr>`;

    syncQSel();

    renderPager($('qPager'), qPage, qPageSize, d.total, g => {
      if (g === 'first') qPage = 1;
      else if (g === 'last') qPage = pages;
      else qPage = Math.min(pages, Math.max(1, qPage + g));
      loadQuestions(false);
    });
  } catch (e) { toast(e.message, true); }
}

window.toggleQ = async (id, enabled) => {
  try {
    await api('/api/admin/questions/' + id, { method: 'PUT', body: JSON.stringify({ enabled }) });
    loadQuestions(true);
  } catch (e) { toast(e.message, true); }
};

window.delQ = async id => {
  if (!confirm('删除这道题？')) return;
  try {
    await api('/api/admin/questions/' + id, { method: 'DELETE' });
    toast('已删除');
    loadQuestions(true);
  } catch (e) { toast(e.message, true); }
};

window.resetQ = async id => {
  if (!confirm('清掉这道题的出题记录？\n\n清掉后它立刻回到「还没出过」的优先池（置顶的题会马上优先出），\n这道题的答对次数也会一起归零。题目本身不会被删。')) return;
  try {
    const r = await api('/api/admin/questions/' + encodeURIComponent(id) + '/reset-stats', { method: 'POST' });
    toast(r.cleared ? '出题记录已清掉' : '这道题本来就没有出题记录');
    loadQuestions(true);
  } catch (e) { toast(e.message, true); }
};

/** 多选集合：跨页保留，批量操作完或换筛选条件时清空 */
let qSel = new Set();

/**
 * 批量模式：默认关。关着的时候勾选列整列不显示、工具栏也不占地方，
 * 想批量改就点「批量操作」把它打开，退出时顺手清空已选。
 */
let qBatchMode = false;

function setBatchMode(on){
  qBatchMode = !!on;
  const bar = $('qBatchBar'), btn = $('qBatchToggle'), table = $('qTable');
  if (table) table.classList.toggle('nopick', !qBatchMode);
  if (bar) bar.classList.toggle('hidden', !qBatchMode);
  if (btn) {
    btn.textContent = qBatchMode ? '退出批量' : '批量操作';
    btn.classList.toggle('primary', qBatchMode);
    btn.title = qBatchMode
      ? '退出批量操作，勾选会一起清掉'
      : '打开后每行前面会出现勾选框，可一次改一批';
  }
  if (!qBatchMode) clearQSel();
  else syncQSel();
}
if ($('qBatchToggle')) $('qBatchToggle').onclick = () => setBatchMode(!qBatchMode);

/** 勾选态 → 行底色、全选框、批量工具栏三处一起同步 */
function syncQSel(){
  const boxes = [...document.querySelectorAll('#qBody .qpick')];
  boxes.forEach(b => {
    const tr = b.closest('tr');
    if (tr) tr.classList.toggle('qsel', b.checked);
  });
  // 集合以复选框为准（翻页后旧页的 id 不在 DOM 里，但仍在集合里，所以两边要合并着数）
  const all = $('qAll');
  if (all) {
    const picked = boxes.filter(b => b.checked).length;
    all.checked = boxes.length > 0 && picked === boxes.length;
    all.indeterminate = picked > 0 && picked < boxes.length;
  }
  const bar = $('qBatchBar');
  if (!bar) return;
  // 工具栏只跟「批量模式」走：开着就一直显示，没勾题时按钮置灰
  bar.classList.toggle('hidden', !qBatchMode);
  $('qBatchCount').textContent = `已选 ${qSel.size} 道` +
    (qSel.size > boxes.filter(b => b.checked).length ? '（含其它页）' : '');
  ['qbEnable', 'qbDisable', 'qbReset', 'qbDelete', 'qbExport'].forEach(id => {
    const b = $(id);
    if (b) b.disabled = qSel.size === 0;
  });
}

$('qBody').addEventListener('change', e => {
  const b = e.target.closest('.qpick');
  if (!b) return;
  const id = b.dataset.id;
  b.checked ? qSel.add(id) : qSel.delete(id);
  syncQSel();
});

$('qAll').addEventListener('change', e => {
  const boxes = [...document.querySelectorAll('#qBody .qpick')];
  boxes.forEach(b => {
    b.checked = e.target.checked;
    e.target.checked ? qSel.add(b.dataset.id) : qSel.delete(b.dataset.id);
  });
  syncQSel();
});

function clearQSel(){
  qSel.clear();
  document.querySelectorAll('#qBody .qpick').forEach(b => { b.checked = false; });
  syncQSel();
}
$('qbClear').onclick = clearQSel;

/** 批量动作统一走这里：一次请求，服务端逐条执行后回报成功 / 不存在的数量 */
async function batchQ(action, verb, confirmText){
  if (!qSel.size) return;
  if (confirmText && !confirm(confirmText.replace('{n}', qSel.size))) return;
  const ids = [...qSel];
  try {
    const r = await api('/api/admin/questions/batch', {
      method: 'POST',
      body: JSON.stringify({ action, ids })
    });
    const extra = r.missing ? `，${r.missing} 道已不存在` : '';
    toast(action === 'reset' && r.ok && !r.cleared
      ? '这些题本来就没有出题记录，已重置'
      : `${verb} ${r.ok} 道${extra}`);
    clearQSel();
    loadQuestions(false);
    if (typeof loadDevices === 'function') loadDevices();
  } catch (e) { toast(e.message, true); }
}

$('qbEnable').onclick = () => batchQ('enable', '已启用');
$('qbDisable').onclick = () => batchQ('disable', '已停用');
$('qbReset').onclick = () => batchQ('reset', '已清出题记录',
  '清掉选中的 {n} 道题的出题记录？\n\n它们会立刻回到「还没出过」的优先池，答对次数一起归零，\n题目本身不会被删。');
$('qbDelete').onclick = () => batchQ('delete', '已删除',
  '删除选中的 {n} 道题？\n\n删除后不能恢复，孩子在用的题库会立刻少掉这些题。');

/**
 * 导出勾中的题：服务端按题库包格式吐 JSON，这里直接存成文件。
 * 导出的是「题目本身」，不含出题记录和答对次数；文件名带时间，连着导几次也不会互相覆盖。
 * 勾选不清空 —— 常见用法是「先导出备份，再批量删掉」。
 */
$('qbExport').onclick = async () => {
  if (!qSel.size) return;
  const btn = $('qbExport');
  btn.disabled = true;
  try {
    const d = await api('/api/admin/questions/export?ids=' +
      encodeURIComponent([...qSel].join(',')));
    if (!d.count) { toast('这些题已经不在了，没什么可导出', true); return; }
    const t = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `tvguard-题库-${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}`
      + `-${p2(t.getHours())}${p2(t.getMinutes())}.json`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(d.items, null, 2)],
      { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`已导出 ${d.count} 道题`);
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = qSel.size === 0; }
};

let qEditCur = null;

/** 编辑弹窗里的学科下拉：跟着年级走（各年级学科 key 不同） */
async function fillQeSubjects(grade, keepKey){
  try {
    const d = await api('/api/admin/subjects?grade=' + encodeURIComponent(grade));
    const list = d.list || [];
    $('qeSubject').innerHTML = list.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
    $('qeSubject').value = list.some(s => s.key === keepKey) ? keepKey : (list[0] ? list[0].key : '');
  } catch (e) { toast(e.message, true); }
}

/** 题型变了：判断题没有选项 */
function syncQeUI(){
  const t = $('qeType').value;
  $('qeOptionsBox').style.display = t === 'judge' ? 'none' : '';
  $('qeAnswer').placeholder = t === 'judge' ? '对 / 错'
    : t === 'multi' ? '多个正确选项用 | 分隔，如 red|blue'
    : '填正确答案，要和某个选项一致';
}
$('qeType').onchange = syncQeUI;
$('qeGrade').onchange = () => fillQeSubjects($('qeGrade').value, $('qeSubject').value);

function closeQEdit(){ $('qEditModal').classList.add('hidden'); qEditCur = null; }
$('qeCancel').onclick = closeQEdit;
$('qeCancel2').onclick = closeQEdit;
$('qEditModal').addEventListener('click', e => { if (e.target.id === 'qEditModal') closeQEdit(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && qEditCur) closeQEdit(); });

/** 点题干或「编辑」都走这里：先取单题详情，再回填弹窗 */
window.editQ = async id => {
  try {
    const q = await api('/api/admin/questions/' + encodeURIComponent(id));
    qEditCur = q;
    $('qeId').textContent = '#' + String(q.id).slice(-8);
    $('qeGrade').value = String(q.grade || 0);
    await fillQeSubjects(q.grade || 0, q.subject);
    $('qeType').value = q.type || 'choice';
    $('qeLevel').value = String(q.level || 1);
    $('qeStars').value = String(q.stars || 1);
    $('qePriority').value = String(q.priority || 0);
    $('qePrompt').value = q.prompt || '';
    $('qeAnswer').value = q.answer === undefined || q.answer === null ? '' : String(q.answer);
    $('qeOptions').value = (q.options || []).join(', ');
    $('qeHint').value = q.hint || '';
    $('qeExplanation').value = q.explanation || '';
    $('qeEnabled').checked = q.enabled !== false;
    syncQeUI();
    $('qEditModal').classList.remove('hidden');
    $('qePrompt').focus();
  } catch (e) { toast(e.message, true); }
};

$('qeSave').onclick = async () => {
  if (!qEditCur) return;
  const type = $('qeType').value;
  const prompt = $('qePrompt').value.trim();
  if (!prompt) { toast('题干不能为空', true); return; }
  const patch = {
    grade: Number($('qeGrade').value) || 0,
    subject: $('qeSubject').value,
    type,
    level: Number($('qeLevel').value),
    stars: Number($('qeStars').value),
    priority: Number($('qePriority').value) || 0,
    prompt,
    answer: $('qeAnswer').value,
    hint: $('qeHint').value,
    explanation: $('qeExplanation').value,
    enabled: $('qeEnabled').checked
  };
  // 判断题的选项由服务端固定成「对 / 错」，不要覆盖
  if (type !== 'judge') patch.options = $('qeOptions').value;
  const btn = $('qeSave');
  btn.disabled = true;
  try {
    await api('/api/admin/questions/' + encodeURIComponent(qEditCur.id), {
      method: 'PUT', body: JSON.stringify(patch)
    });
    toast('已保存');
    closeQEdit();
    loadQuestions(false);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
};

$('qRefresh').onclick = () => loadQuestions(true);
$('qLevel').onchange = () => loadQuestions(true);
$('qType').onchange = () => loadQuestions(true);
$('qIncGeneral').onchange = () => loadQuestions(true);
$('qSearch').addEventListener('keydown', e => { if (e.key === 'Enter') loadQuestions(true); });

// 每页条数：记住上次的选择，下次进题库还是这个数
$('qSize').value = String(qPageSize);
$('qSize').onchange = () => {
  qPageSize = Number($('qSize').value) || 20;
  try { localStorage.setItem('tg_qsize', String(qPageSize)); } catch (e) {}
  loadQuestions(true);
};

$('nAdd').onclick = async () => {
  try {
    await api('/api/admin/questions', {
      method: 'POST',
      body: JSON.stringify({
        grade: Number($('nGrade').value),
        subject: $('nSubject').value,
        type: $('nType').value,
        stars: Number($('nStars').value),
        priority: Number($('nPriority').value) || 0,
        prompt: $('nPrompt').value,
        answer: $('nAnswer').value,
        options: $('nOptions').value,
        hint: $('nHint').value,
        explanation: $('nExplanation').value,
        level: Number($('nLevel').value)
      })
    });
    $('nPrompt').value = $('nAnswer').value = $('nOptions').value = '';
    $('nHint').value = $('nExplanation').value = '';
    if ($('nPriority')) $('nPriority').value = '0';
    toast('已添加');
    loadQuestions(true);
    loadDevices();
  } catch (e) { toast(e.message, true); }
};

/** 文本导入：整批按「通用 / 中等 / 数学 / 单选」为默认值，行首 [年级/学科/难度] 可逐行覆盖 */
$('impBtn').onclick = async () => {
  const text = $('impText').value.trim();
  if (!text) { toast('先把题目粘贴进来', true); return; }
  await importTextBatch(text);
};

async function importTextBatch(text){
  try {
    const r = await api('/api/admin/questions/import', {
      method: 'POST',
      body: JSON.stringify({ text, grade: 0, level: 2, subject: 'math', type: 'choice' })
    });
    $('impMsg').textContent = `导入完成：新增 ${r.ok} 道` +
      (r.skipped ? `，跳过重复 ${r.skipped} 道` : '') +
      (r.failed ? `，失败 ${r.failed} 道（第一行：${r.errors[0] || ''}）` : '');
    toast(`导入成功 ${r.ok} 道${r.skipped ? `，跳过重复 ${r.skipped} 道` : ''}${r.failed ? `，失败 ${r.failed} 道` : ''}`, r.failed > 0);
    if (r.ok) $('impText').value = '';
    loadQuestions(true);
    loadDevices();
  } catch (e) { $('impMsg').textContent = '导入失败：' + e.message; toast(e.message, true); }
}

/** 文件导入：.json 走题库包（bulk 接口，按年级/学科/题干去重），其它按纯文本逐行解析 */
// 按钮在 <summary> 里：不拦的话点它会顺手把折叠块收起来
$('impFileBtn').onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  $('impFile').click();
};
$('impFile').onchange = async () => {
  const f = $('impFile').files && $('impFile').files[0];
  if (!f) return;
  $('impMsg').textContent = `正在读取 ${f.name}…`;
  try {
    const raw = await f.text();
    if (/\.json$/i.test(f.name)) {
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : (data.items || []);
      if (!items.length) throw new Error('文件里没有题目');
      const r = await api('/api/admin/questions/bulk', { method: 'POST', body: JSON.stringify(items) });
      $('impMsg').textContent = `题库包导入完成：新增 ${r.ok} 道，跳过重复 ${r.skipped} 道` +
        (r.failed ? `，失败 ${r.failed} 道（${r.errors[0] || ''}）` : '');
      toast(`题库包导入完成：新增 ${r.ok} 道`);
      gradeInitFor = null;
      if (typeof loadOverview === 'function') loadOverview();
      loadQuestions(true);
    } else {
      await importTextBatch(raw);
    }
  } catch (e) {
    $('impMsg').textContent = '导入失败：' + e.message;
    toast(e.message, true);
  } finally {
    $('impFile').value = '';
  }
};

const GRADE_LABEL = { 0: '通用', 1: '一年级', 2: '二年级', 3: '三年级', 4: '四年级', 5: '五年级', 6: '六年级' };
function gradeTag(g){
  const n = Number(g) || 0;
  return `<span class="tag" title="年级：${GRADE_LABEL[n] || '通用'}">${GRADE_LABEL[n] || '通用'}</span>`;
}

/** 上一次查询命中的题数，renderQuizScope 无参调用时复用，免得「共 N 道」闪没 */
let lastQTotal = null;

/** 题库筛选的难度词表：这里筛的是「精确那一档」，和出题范围的累积语义不是一回事 */
const QLEVEL_TEXT = { all: '全部难度', 1: '简单', 2: '中等', 3: '挑战' };

/** 题库页当前筛选说成人话（年级 / 通用题 / 学科 / 难度 / 题型），用词与上面那排下拉完全一致 */
function currentFilterText(){
  const gv = $('qGrade').value;
  const t = $('qType').value;
  const lv = $('qLevel').value;
  const parts = [gradeText(gv === 'all' ? 0 : gv)];
  if (gv !== 'all' && $('qIncGeneral').checked) parts.push('含通用题');
  parts.push(qSubject === 'all' ? '全部学科' : subjOf(qSubject).name);
  parts.push(QLEVEL_TEXT[lv] || '全部难度');
  parts.push(t === 'all' ? '全部题型' : (TYPE_NAME[t] || ''));
  return parts.filter(Boolean).join(' · ');
}

/**
 * 两行提示，各说各的事：
 *   ① 当前筛选 —— 就是上面那排控件拼出来的，随点随变；
 *   ② 电视当前出题 —— 服务端已保存、电视真正在用的范围，只有点按钮才会跟①一致。
 * 以前只显示②，家长看着自己选的一年级 + 语文 + 全部难度，提示却写「全部学科 · 挑战」，
 * 以为筛选坏了。分开写就不会再混。
 */
function renderQuizScope(total){
  if (total !== undefined) lastQTotal = total;
  const el = $('qScopeStat');
  if (el){
    el.textContent = '当前筛选：' + currentFilterText() +
      (Number.isFinite(lastQTotal) ? ` · 共 ${lastQTotal} 道` : '');
  }
  const live = $('qScopeLive');
  if (!live) return;
  const p = lastOverview && lastOverview.policy;
  if (!p) { live.textContent = '客户端当前出题：读取中…'; return; }
  const g = Number(p.quizGrade) || 0;
  const txt = scopeText({
    grade: g <= 0 ? 0 : g,
    incGeneral: !!p.quizIncludeGeneral,
    subjects: (p.subjects || []).map(k => subjOf(k).name),
    level: p.difficulty
  });
  live.textContent = `客户端当前出题：${txt}`;
}

/** 把题库页当下选的年级 / 学科 / 难度一键保存成电视的出题范围 */
$('qUseScope').onclick = async () => {
  const gv = $('qGrade').value;
  const quizGrade = gv === 'all' ? 0 : Number(gv);
  const lv = $('qLevel').value;
  const difficulty = lv === 'all' ? 0 : Number(lv);
  const subjects = qSubject === 'all' ? [] : [qSubject];
  // 指定年级时，通用题是否跟着抽由「含通用题」勾选决定
  const quizIncludeGeneral = gv !== 'all' && $('qIncGeneral').checked;
  try {
    await api('/api/admin/policy', {
      method: 'PUT',
      body: JSON.stringify({ quizGrade, quizIncludeGeneral, difficulty, subjects })
    });
    await loadOverview();
    renderQuizScope();
    toast('出题范围已按当前筛选保存，客户端半分钟内生效');
  } catch (e) { toast(e.message, true); }
};

/** 让「新增 / 导入」表单的学科下拉只列这个年级的学科 */
async function applyFormSubjects(grade, selId){
  try {
    const d = await api('/api/admin/subjects?grade=' + encodeURIComponent(grade));
    const sel = $(selId);
    const cur = sel.value;
    sel.innerHTML = (d.list || []).map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
    sel.value = (d.list || []).some(s => s.key === cur) ? cur : 'math';
    syncOptionHint();
  } catch (e) { toast(e.message, true); }
}

let gradeInitFor = null;
async function ensureGradeSubjects(){
  const g = $('qGrade').value;
  if (gradeInitFor === g) return;
  gradeInitFor = g;
  try {
    const d = await api('/api/admin/subjects?grade=' + encodeURIComponent(g));
    setGradeSubjects(d.list || []);
    await applyFormSubjects($('nGrade').value, 'nSubject');
  } catch (e) { gradeInitFor = null; }
}

$('qGrade').onchange = () => { gradeInitFor = null; loadQuestions(true); };
// 批量导入没有学科下拉了（行首 [年级/学科/难度] 逐行指定），这里只剩「新增题目」一处
window.onFormGradeChange = () => applyFormSubjects($('nGrade').value, 'nSubject');

// 让题库页第一次加载时也把年级学科拉回来（直接带 #bank 进来的路径同样生效）
const _loadQuestionsRaw = loadQuestions;
loadQuestions = async function(reset){
  await ensureGradeSubjects();
  return _loadQuestionsRaw(reset);
};

async function renderSubjectManager(){
  try {
    const g = $('smGrade').value;
    const d = await api('/api/admin/subjects?grade=' + encodeURIComponent(g));
    $('smList').innerHTML = (d.list || []).map(s => `
      <div class="card" style="min-width:250px;padding:12px;margin:0">
        <div class="rowgap" style="margin-bottom:8px">
          <input type="color" id="smc_${esc(s.key)}" value="${esc(s.color || '#7D8794')}" style="width:44px;height:34px;padding:2px">
          <input id="smn_${esc(s.key)}" value="${esc(s.name)}" style="width:130px">
          <input id="sms_${esc(s.key)}" value="${esc(s.short || '')}" style="width:56px" title="简称">
        </div>
        <div class="rowgap">
          <button class="small" onclick="saveSubject('${esc(s.key)}')">保存</button>
          ${s.builtin ? '<span class="muted" style="font-size:12px">内置学科</span>'
            : `<button class="small danger" onclick="delSubject('${esc(s.key)}')">删除</button>`}
        </div>
      </div>`).join('');
    $('smMsg').textContent = `${GRADE_LABEL[g] || ''}共 ${(d.list || []).length} 个学科`;
  } catch (e) { $('smMsg').textContent = e.message; }
}

window.saveSubject = async key => {
  try {
    await api('/api/admin/subjects/' + encodeURIComponent(key), {
      method: 'PUT',
      body: JSON.stringify({
        grade: $('smGrade').value,
        name: $('smn_' + key).value,
        short: $('sms_' + key).value,
        color: $('smc_' + key).value
      })
    });
    toast('已保存');
    gradeInitFor = null;
    await renderSubjectManager();
    await loadQuestions(false);
  } catch (e) { toast(e.message, true); }
};

window.delSubject = async key => {
  if (!confirm('删除这个自定义学科？已经录入到这个学科下的题目不会被删，但会显示为原 key。')) return;
  try {
    await api('/api/admin/subjects/' + encodeURIComponent(key) + '?grade=' + $('smGrade').value, { method: 'DELETE' });
    toast('已删除');
    gradeInitFor = null;
    await renderSubjectManager();
    await loadQuestions(false);
  } catch (e) { toast(e.message, true); }
};

$('smGrade').onchange = renderSubjectManager;
$('smRefresh').onclick = renderSubjectManager;
$('smAdd').onclick = async () => {
  try {
    await api('/api/admin/subjects', {
      method: 'POST',
      body: JSON.stringify({
        grade: $('smGrade').value,
        name: $('smName').value,
        short: $('smShort').value,
        color: $('smColor').value
      })
    });
    $('smName').value = $('smShort').value = '';
    toast('学科已添加');
    gradeInitFor = null;
    await renderSubjectManager();
    await loadQuestions(false);
  } catch (e) { toast(e.message, true); }
};
$('bankSubjects').onclick = () => {
  const d = $('dSubjects'); d.open = true;
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  renderSubjectManager();
};

