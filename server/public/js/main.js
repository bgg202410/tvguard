// 数字输入框失焦/回车后立刻夹回合法范围（change 事件），别让 900000 这种值留在框里
document.addEventListener('change', e => {
  const t = e.target;
  if (t && t.tagName === 'INPUT' && t.type === 'number') clampInput(t, true);
}, true);

(async () => {
  try {
    const d = await api('/api/admin/me');
    // 登录页写明有效期：具体小时数以服务端为准（可被 ADMIN_SESSION_HOURS 覆盖）
    if ($('loginHint')) {
      const h = Number(d.sessionHours) > 0 ? Number(d.sessionHours) : 12;
      $('loginHint').textContent = `登录后 ${h} 小时内免密，过期需重新输入`;
    }
    if (d.loggedIn) showApp(); else showLogin();
  } catch (e) { showLogin(); }
})();
