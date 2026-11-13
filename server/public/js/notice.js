/**
 * 家长在后台写一句话 → /api/admin/notice → 电视下一次心跳（默认 5 秒）拿到。
 *
 * 客户端按留言的 id 记「这条已经点掉」：
 * 家长改完内容重新推送会换新 id，所以关掉的留言改过之后还会再出现，
 * 不用让家长手动去电视上「重置」。
 *
 * day 是显示日期（只到天，YYYY-MM-DD）：没到那天的留言服务端不下发给电视，
 * 后台照样能回显、能改。到那天之后一直有效，电视每次开机弹一次。
 */

/** 浏览器本地日期，兜底用（服务端已按 Asia/Shanghai 算好时优先用服务端的） */
function ntToday(){
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ntDayText(day){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  return m ? `${Number(m[2])} 月 ${Number(m[3])} 日` : (day || '今天');
}

function renderNoticeCard(n, today){
  const stat = $('ntStat');
  if (!stat) return;
  const ta = $('ntText');
  const dayInput = $('ntDay');
  const cur = today || ntToday();
  if (dayInput) {
    // 只能选今天及以后：过去的日期在留下来就是「设了也永远不显示」
    dayInput.min = cur;
    if (!dayInput.value) dayInput.value = (n && n.day) || cur;
    if (dayInput.value < cur) dayInput.value = cur;
  }
  // 不覆盖正在编辑的内容：只有输入框是空的才把当前留言填回去
  if (n && ta && !ta.value.trim()) {
    ta.value = n.text || '';
    syncNoticeCount();
  }
  if (!n){
    stat.textContent = '';
    return;
  }
  const at = new Date(Number(n.at) || 0);
  const pending = n.day && n.day > cur;
  const head = pending
    ? `已定时到 <b style="color:#F7C97C">${esc(ntDayText(n.day))}</b>，到那天才开始在电视上显示`
    : '电视上正在显示';
  stat.innerHTML = `${head}：<b style="color:var(--ink)">${esc(n.text || '')}</b>` +
    ` · ${esc(at.toLocaleString('zh-CN'))}`;
}

function syncNoticeCount(){
  const ta = $('ntText'), c = $('ntCount');
  if (ta && c) c.textContent = String((ta.value || '').length);
}

$('ntText').addEventListener('input', syncNoticeCount);

async function pushNotice(text, day){
  // 空内容走「清空」，避免家长以为点了推送但什么都没发生
  const d = await api('/api/admin/notice', {
    method: 'PUT',
    body: JSON.stringify({ text: text || '', day: day || ntToday() })
  });
  renderNoticeCard(d.notice, d.today);
  return d;
}

/**
 * 把服务端「补悬浮窗权限」的结果翻成一句人话。
 *
 * 服务端在推送时会对每台电视 appops 查一次：已经是 allow 的什么都不做，
 * 被 TCL 清理工具关掉的会顺手补回来（没补上就把原因带过来）。
 * 空串 = 没有设备 / 本来就都有权限，toast 保持原样。
 */
function ntOverlayHint(list){
  if (!Array.isArray(list) || !list.length) return '';
  const who = arr => arr.map(x => x.name || x.id).join('、');
  const bad = list.filter(x => !x.ok);
  const fixed = list.filter(x => x.fixed);
  if (bad.length) {
    const reviving = bad.filter(x => x.reviving);
    // 一台都没连上：多半是电视进程被 TCL 清理工具干掉了，服务端已在后台拉起
    if (reviving.length === bad.length) {
      return `；「${who(bad)}」当前没连上（可能被系统清掉了），已在后台尝试拉起，连上后就会弹出`;
    }
    return `；但「${who(bad)}」的悬浮窗权限没补上：${bad[0].error || '未知原因'}`;
  }
  if (fixed.length) {
    return `；已自动为「${who(fixed)}」开启悬浮窗权限，下次心跳后就能弹出`;
  }
  return '';
}

$('ntPush').onclick = async () => {
  const text = $('ntText').value.trim();
  if (!text) return toast('先写一句话再推送', true);
  const day = $('ntDay').value || ntToday();
  if (day < ntToday()) return toast('显示日期不能早于今天', true);
  const btn = $('ntPush');
  const label = btn.textContent;
  btn.disabled = true;
  // 推送时服务端会先 adb 查一次电视的悬浮窗权限（可能要 1~2 秒），按钮上给个反馈
  btn.textContent = '推送中…';
  try {
    const d = await pushNotice(text, day);
    const n = d.notice;
    const hint = ntOverlayHint(d.overlay);
    const base = n && n.day && n.day > (ntToday())
      ? `已定时到 ${ntDayText(n.day)}，到那天开始显示`
      : '已推送，孩子看电视时会弹出留言';
    toast(base + hint);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

$('ntClear').onclick = async () => {
  if (!confirm('清空留言？电视上那条留言会消失。')) return;
  try {
    await pushNotice('');
    $('ntText').value = '';
    syncNoticeCount();
    toast('已清空留言');
  } catch (e) {
    toast(e.message, true);
  }
};
