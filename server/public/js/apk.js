function openApk(){
  hideViews();
  $('apkView').classList.remove('hidden');
  if (location.hash !== '#apk') history.replaceState(null, '', '#apk');
  window.scrollTo(0, 0);
  loadApk();
}

function closeApk(){
  $('apkView').classList.add('hidden');
  $('mainView').classList.remove('hidden');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  window.scrollTo(0, 0);
}

function fmtSize(n){
  if (!n) return '—';
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}

async function loadApk(){
  try {
    // 「客户端版本」必须取电视心跳上报的真实版本，不能只看分发库：
    // 用 adb 手工装过的包根本不在分发库里，只盯分发库就会一直显示旧版本。
    // 这里顺手把 overview 同步过来，设备卡和版本页看到的是同一份最新状态。
    const [d, ov] = await Promise.all([
      api('/api/admin/apk'),
      api('/api/admin/overview').catch(() => null)
    ]);
    if (ov) {
      lastOverview = ov;
      if (typeof renderDevices === 'function') renderDevices(ov.devices);
    }
    renderApk(d);
  } catch (e) { toast(e.message, true); }
}

function renderApk(d){
  const items = (d && d.items) || [];
  const active = items.find(x => x.id === d.active);
  // 客户端版本 = 设备心跳里的 appVersion（电视自己报的真实版本）
  const devs = (lastOverview && lastOverview.devices) || [];
  const vers = [...new Set(devs.map(x => x.appVersion).filter(Boolean))];
  $('apkStat').textContent = vers.length
    ? `客户端版本：v${vers.join('、v')}`
    : '客户端版本：读取中…';

  $('apkBody').innerHTML = items.length ? items.map(x => {
    const isActive = x.id === d.active;
    const id = esc(x.id);
    // 比当前分发版本新的「已上传但没发布」，单独标一下，免得家长忘了点
    const pending = !isActive && (!active || x.versionCode > active.versionCode);
    const state = isActive
      ? '<span class="tag" style="color:var(--ok)">当前分发</span>'
      : pending
        ? '<span class="tag" style="color:#F7C97C">待发布</span>'
        : '<span class="tag">历史</span>';
    // 和电视上报的真实版本对上就标一下，家长一眼看出「哪一版真的装上了」
    const onTv = vers.includes(String(x.versionName));
    const tvTag = onTv ? ' <span class="tag" style="color:#4ADE80">客户端在用</span>' : '';
    return `<tr>
      <td><b>${esc(x.versionName)}</b>
        <div class="muted" style="font-size:12px">${esc(x.package || '')}</div></td>
      <td class="mono">${x.versionCode}</td>
      <td class="muted">${fmtSize(x.size)}</td>
      <td class="muted">${evTime(new Date(x.uploadedAt).getTime())}</td>
      <td>${state}${tvTag}</td>
      <td>
        <div class="rowgap">
          ${isActive ? '' : `<button class="${pending ? 'primary ' : ''}small" onclick="apkActivate('${id}')">发布</button>`}
          <a class="small" style="text-decoration:none" href="/api/admin/apk/${encodeURIComponent(x.id)}/file">下载</a>
          <button class="ghost small" onclick="apkRemove('${id}', ${isActive})">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">还没有版本，先在上面传一个 APK</td></tr>';
}

$('apkBtn').onclick = openApk;
$('apkBack').onclick = closeApk;
$('apkRefresh').onclick = loadApk;

$('apkUpload').onclick = () => {
  const f = $('apkFile').files[0];
  if (!f) return toast('先选一个 .apk 文件', true);
  if (!/\.apk$/i.test(f.name)) return toast('只能是 .apk 文件', true);

  const bar = $('apkBar');
  const fill = bar.firstElementChild;
  const btn = $('apkUpload');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/admin/apk?name=' + encodeURIComponent(f.name));

  xhr.upload.onprogress = e => {
    if (!e.lengthComputable) return;
    const pct = Math.round(e.loaded / e.total * 100);
    fill.style.width = pct + '%';
    $('apkProg').textContent = `上传中 ${pct}%（${fmtSize(e.loaded)} / ${fmtSize(e.total)}）`;
  };
  xhr.onload = () => {
    let d = {};
    try { d = JSON.parse(xhr.responseText); } catch (e) {}
    if (xhr.status === 200 && d.ok) {
      $('apkProg').textContent = '';
      $('apkFile').value = '';
      toast(`已上传 v${d.item.versionName}（${d.item.versionCode}），点列表里的「发布」才会推给客户端`);
      renderApk(d.list);
    } else if (xhr.status === 401) {
      $('apkProg').textContent = '';
      showLogin();
    } else {
      $('apkProg').textContent = '';
      toast(d.error || '上传失败', true);
    }
  };
  xhr.onerror = () => { $('apkProg').textContent = ''; toast('上传失败，检查网络后重试', true); };
  xhr.onloadend = () => {
    bar.style.display = 'none';
    btn.disabled = false;
    btn.textContent = '上传并发布';
  };

  bar.style.display = '';
  fill.style.width = '0%';
  $('apkProg').textContent = '上传中 0%';
  btn.disabled = true;
  btn.textContent = '上传中…';
  xhr.send(f);
};

window.apkActivate = async id => {
  if (!confirm('把这个版本发布给客户端？\n\n还停在旧版本的客户端会升到这一版；已经比它新的不会降级。')) return;
  try {
    const d = await api('/api/admin/apk/' + encodeURIComponent(id) + '/activate', { method: 'POST' });
    renderApk(d.list);
    toast('已发布，客户端半分钟内会提示升级');
  } catch (e) { toast(e.message, true); }
};

window.apkRemove = async (id, isActive) => {
  const msg = isActive
    ? '这是当前分发的版本，删掉之后客户端就收不到任何升级提示了（已经装着的照常用）。确定删？'
    : '删掉这个版本？APK 文件也会一起删掉。';
  if (!confirm(msg)) return;
  try {
    const d = await api('/api/admin/apk/' + encodeURIComponent(id), { method: 'DELETE' });
    renderApk(d.list);
    toast('已删除');
  } catch (e) { toast(e.message, true); }
};

