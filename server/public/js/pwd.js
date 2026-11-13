// 只有已登录才能调这个接口；点开才请求，不在进页面时预拉
let pwdReal = '';
let pwdMemoFile = '';
let pwdSessionHours = 12;   // 登录有效期（小时），以接口返回为准，别写死

/** 密码卡片下面那几行说明：来源 / 备忘文件（有效期改成了可编辑控件，不再写死在这里） */
function pwdMetaHtml(src, weak) {
  return `${esc(pwdSourceText(src))}`
    + `<br>备忘文件：<code>${esc(pwdMemoFile)}</code>`
    + (weak ? '<br><span style="color:#F7C97C">这是弱密码 / 默认密码，点上面「修改密码」改掉</span>' : '');
}

$('pwdBtn').onclick = async () => {
  const card = $('pwdCard');
  if (!card.classList.contains('hidden')) { card.classList.add('hidden'); return; }
  try {
    const d = await api('/api/admin/password');
    pwdReal = d.password;
    pwdMemoFile = d.memoFile || '';
    pwdSessionHours = Number(d.sessionHours) > 0 ? Number(d.sessionHours) : 12;
    $('pwdValue').textContent = pwdReal;
    $('pwdReveal').textContent = '隐藏';
    $('pwdMeta').innerHTML = pwdMetaHtml(d.source, d.weak);
    // 有效期输入框预填当前值，并清空上次的保存提示
    $('sessHours').value = pwdSessionHours;
    $('sessMsg').textContent = '';
    card.classList.remove('hidden');
  } catch (e) { toast(e.message, true); }
};

$('pwdReveal').onclick = () => {
  const el = $('pwdValue');
  if (el.classList.contains('masked')) {
    el.classList.remove('masked');
    el.textContent = pwdReal;
    $('pwdReveal').textContent = '隐藏';
  } else {
    el.classList.add('masked');
    el.textContent = '••••••';
    $('pwdReveal').textContent = '显示';
  }
};

$('pwdCopy').onclick = async () => {
  // navigator.clipboard 只在 HTTPS（安全上下文）下存在，HTTP 内网页面走 execCommand 兜底
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(pwdReal);
      toast('密码已复制');
      return;
    }
  } catch (e) { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = pwdReal;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    toast(ok ? '密码已复制' : '复制失败，请手动选中密码复制', !ok);
  } catch (e) {
    toast('复制失败：' + e.message, true);
  }
};

$('pwdClose').onclick = () => $('pwdCard').classList.add('hidden');

function pwModal(show){
  const m = $('pwModal');
  if (show){
    m.classList.remove('hidden');
    $('pwCur').value = '';
    $('pwNew').value = '';
    $('pwNew2').value = '';
    // 有效期取接口值（可能被 ADMIN_SESSION_HOURS 改过），页面上不写死
    $('pwSessHours').textContent = pwdSessionHours;
    setTimeout(() => $('pwCur').focus(), 30);
  } else {
    m.classList.add('hidden');
  }
}

/** 密码来源用一句人话说明，改过密码后这里要跟着变 */
function pwdSourceText(src){
  return {
    admin: '后台设置的密码（存在 data/config.json，优先于 .env）',
    env: '来自 .env 的 ADMIN_PASSWORD',
    remembered: '来自 data/config.json（上次生效的值，.env 没设）',
    default: '还是内置默认值，建议改掉'
  }[src] || src;
}

$('pwdEdit').onclick = () => pwModal(true);
$('pwCancel').onclick = () => pwModal(false);
$('pwModal').onclick = e => { if (e.target.id === 'pwModal') pwModal(false); };

$('pwSave').onclick = async () => {
  const cur = $('pwCur').value;
  const n1 = $('pwNew').value.trim();
  const n2 = $('pwNew2').value.trim();
  if (!cur) return toast('先输入当前密码', true);
  // 本地先按后端同一套规则拦一遍（6~64 位、不能和原密码相同），别等提交才报错
  if (n1.length < 6) return toast('新密码至少 6 位', true);
  if (n1.length > 64) return toast('新密码最多 64 位', true);
  if (n1 === cur) return toast('新密码和当前密码一样', true);
  if (n1 !== n2) return toast('两次输入的新密码不一样', true);
  const btn = $('pwSave');
  btn.disabled = true;
  try {
    const d = await api('/api/admin/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: cur, newPassword: n1 })
    });
    pwdReal = d.password;
    if (Number(d.sessionHours) > 0) pwdSessionHours = Number(d.sessionHours);
    $('pwdValue').textContent = pwdReal;
    $('pwdValue').classList.remove('masked');
    $('pwdReveal').textContent = '隐藏';
    $('pwdMeta').innerHTML = pwdMetaHtml(d.source, false);
    pwModal(false);
    toast('密码已改好，客户端家长验证也用新密码');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
};

// 改登录有效期（小时）：后台可改、持久化，改完立即生效
$('sessSave').onclick = async () => {
  const raw = Number($('sessHours').value);
  if (!Number.isFinite(raw)) return toast('请输入有效的小时数', true);
  if (raw < 0.1 || raw > 720) return toast('有效期需在 0.1 ~ 720 小时之间', true);
  const btn = $('sessSave');
  btn.disabled = true;
  $('sessMsg').style.color = '';
  $('sessMsg').textContent = '';
  try {
    const d = await api('/api/admin/session', {
      method: 'POST',
      body: JSON.stringify({ hours: raw })
    });
    pwdSessionHours = d.hours;
    $('sessHours').value = d.hours;
    $('sessMsg').textContent = `已保存 ${d.hours} 小时（当前登录已按新值续期，其它设备会重新登录）`;
    toast('登录有效期已更新');
  } catch (e) {
    $('sessMsg').style.color = '#F79C9C';
    $('sessMsg').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
};

