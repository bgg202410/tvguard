const $ = id => document.getElementById(id);
let toastTimer = null;

function toast(msg, isErr){
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast on' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

/** 数字输入框的显示名，用于提示「答题间隔（分钟）只能是 1~120」 */
function fieldLabel(el){
  const box = el.closest('.field');
  const lab = box && box.querySelector('label.f');
  return lab ? lab.textContent.trim() : '这个数值';
}

/**
 * 把越界的数字就地夹回 min/max。
 *
 * 浏览器不管 type=number 的 min/max，用户能敲出「答题间隔 900000」这种值，
 * 提交后服务端虽然会 clamp，但输入框里留着 900000 很容易让人以为真生效了，
 * 所以在输入框失焦和保存前都夹一次，并明确提示改成了多少。
 */
function clampInput(el, notify){
  if (el.type !== 'number') return false;
  const min = el.min === '' ? NaN : Number(el.min);
  const max = el.max === '' ? NaN : Number(el.max);
  const raw = String(el.value).trim();
  if (raw === '') return false;
  let v = Number(raw);
  if (!Number.isFinite(v)) { el.value = ''; return true; }
  v = Math.round(v);
  const lo = Number.isFinite(min) ? min : v;
  const hi = Number.isFinite(max) ? max : v;
  const fix = Math.min(hi, Math.max(lo, v));
  if (fix === Number(raw)) return false;
  el.value = fix;
  if (notify) toast(`${fieldLabel(el)}只能是 ${lo}~${hi}，已改为 ${fix}`, true);
  return true;
}

/** 保存前把整页数字都过一遍，别让越界值悄悄提交上去 */
function clampAllNumbers(){
  let fixed = 0;
  document.querySelectorAll('input[type=number]').forEach(el => {
    if (clampInput(el, true)) fixed++;
  });
  return fixed;
}

async function api(path, opts){
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  if (res.status === 401){ showLogin(); throw new Error('未登录'); }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch(e){ data = {}; }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function fmtMin(ms){ return Math.round((ms || 0) / 60000); }

function ago(ts){
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

function showLogin(){
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
  setTimeout(() => $('pwd').focus(), 60);
}

function showApp(){
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('hostLine').textContent = location.host;
  $('srvDot').className = 'dot';
  $('srvText').textContent = '已连接';
  loadOverview();
  loadQuestions(true);
  loadEvents();
  loadShotStatus();   // 电视画面区：填充设备下拉框 + 开关状态（之前只在点「刷新」时才加载，首次进来是空的）
  // 刷新页面时停在原来那一页：带 #bank / #wrong / #logs 进来就直接落到对应二级页
  if (location.hash === '#bank') openBank();
  else if (location.hash === '#wrong') { openBank(); openWrong(); }
  else if (location.hash === '#logs') openLogs();
  else if (location.hash === '#apk') openApk();
}

// 页面里写 <i class="hicon" tabindex="0" data-tip="说明（可含 HTML）">i</i>，
// 警告型加 .warn、图标内容写 ! 。
// 交互：点击弹出并固定（再点一次 / 点别处 / Esc 收起）；悬停 350ms 也可预览，移开即收；
// 键盘 Tab 聚焦后回车 / 空格同样弹出。滚动、缩放窗口时提示框跟着图标走。
// data-tip 的内容全部是本仓库开发者手写的静态文案，所以 innerHTML 不做转义；
// 永远不要把接口返回或用户输入拼进 data-tip。
(function(){
  let box = null, cur = null, pinned = false, hoverTimer = null;

  function ensure(){
    if (box) return box;
    box = document.createElement('div');
    box.id = 'tipbox';
    box.className = 'tipbox';
    document.body.appendChild(box);
    return box;
  }

  function place(icon){
    const b = ensure();
    const bw = Math.min(340, innerWidth - 16);
    b.style.maxWidth = bw + 'px';
    b.style.visibility = 'hidden';
    b.classList.add('on');
    const th = b.offsetHeight, r = icon.getBoundingClientRect();
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, innerWidth - bw - 8));
    let top = r.bottom + 9;
    // 下方放不下且上方放得下就翻到上面
    if (top + th > innerHeight - 8 && r.top - th - 9 > 8) top = r.top - th - 9;
    b.style.left = left + 'px';
    b.style.top = top + 'px';
    b.style.visibility = '';
  }

  function open(icon, pin){
    if (cur && cur !== icon) close();
    cur = icon;
    pinned = !!pin;
    icon.classList.add('on');
    box = ensure();
    box.innerHTML = icon.dataset.tip || '';
    place(icon);
  }

  function close(){
    if (!cur) return;
    cur.classList.remove('on');
    cur = null;
    pinned = false;
    if (box) box.classList.remove('on');
  }

  function toggle(icon){
    if (cur === icon && pinned) { close(); return; }
    open(icon, true);
  }

  document.addEventListener('click', e => {
    if (e.target.closest('#tipbox')) return;   // 在提示里选文字、复制路径，别关
    const icon = e.target.closest('.hicon');
    if (icon) { e.preventDefault(); e.stopPropagation(); toggle(icon); return; }
    close();
  }, true);

  // 悬停 350ms 预览（不固定），移开即收；图标内部子节点间移动不算离开
  document.addEventListener('mouseover', e => {
    const icon = e.target.closest('.hicon');
    if (!icon || cur === icon) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => open(icon, false), 350);
  });
  document.addEventListener('mouseout', e => {
    const icon = e.target.closest('.hicon');
    if (!icon) return;
    clearTimeout(hoverTimer);
    if (icon.contains(e.relatedTarget)) return;
    if (cur === icon && !pinned) close();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); return; }
    const a = document.activeElement;
    if ((e.key === 'Enter' || e.key === ' ') && a && a.classList && a.classList.contains('hicon')) {
      e.preventDefault();
      toggle(a);
    }
  });

  document.addEventListener('scroll', () => { if (cur) place(cur); }, true);
  window.addEventListener('resize', () => { if (cur) place(cur); });

  /**
   * 供业务代码随时换提示内容（例如「时段用途」随下拉变的那段说明）：
   * 只改 data-tip，正展开着就立刻按新内容重画，避免看到上一项的旧说明。
   */
  window.setHiconTip = function(icon, text){
    if (!icon) return;
    icon.dataset.tip = text || '';
    if (cur === icon) open(icon, pinned);
  };
})();

