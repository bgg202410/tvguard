// 开关存服务端（config.json），打开后服务端每 10 秒对在线电视截一次，
// 这里只负责：拉状态 → 渲染照片墙（保留窗口内的截图叠放排列）→ 每 10 秒补新图。

let shotTimer = null;
let shotEnabled = false;
let shotCurId = '';
let lastShotStatus = { devices: [] };
let shotListCache = { id: '', shots: [] };   // 当前设备照片墙数据（新→旧）

/**
 * 自检 / 排查区默认收起，首页只留「电视画面」。
 * 只有点「截图自检」才展开；展开后可用里面的密钥上传、电视 IP 等工具。
 */
function showTools(open){
  const box = $('shotTools');
  if (box) box.style.display = open ? '' : 'none';
}
$('shotToolsClose').onclick = () => showTools(false);

function shotQuery(){
  return '?deviceId=' + encodeURIComponent(shotCurId) + '&ts=' + Date.now();
}

/** 「x 秒 / 分钟前」 */
function agoText(at){
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  return Math.floor(s / 3600) + ' 小时前';
}

/**
 * 照片墙：拉全部保留的截图列表，叠放渲染。
 * 每张下面标截图时间 + 多久之前；点击弹出全屏预览。
 * URL 里带时间戳且服务端允许缓存，重复渲染直接走浏览器缓存，不闪不重下。
 */
async function shotShow(){
  if (!shotCurId) return;
  const wall = $('shotWall');
  const empty = $('shotEmpty');
  try {
    const r = await api('/api/admin/shot/list/' + encodeURIComponent(shotCurId));
    const shots = r.shots || [];
    const changed = shotListCache.id !== shotCurId ||
      shotListCache.shots.length !== shots.length ||
      (shots[0] && shotListCache.shots[0] && shots[0].at !== shotListCache.shots[0].at);
    if (!changed) return;                       // 没新图就不重画，滚动位置不丢
    const keepScroll = wall.scrollLeft;         // 重画后恢复滚动位置
    wall.innerHTML = shots.map((s, i) => `
      <figure class="shotItem${i === 0 ? ' first' : ''}" data-at="${s.at}" data-i="${i}"
              style="z-index:${shots.length - i}"
              title="${new Date(s.at).toLocaleString('zh-CN')} · 点击预览">
        <img loading="lazy" src="/api/admin/shot/${encodeURIComponent(shotCurId)}/${s.at}" alt="截图 ${new Date(s.at).toLocaleTimeString('zh-CN')}">
        <figcaption>${new Date(s.at).toLocaleTimeString('zh-CN')} · ${agoText(s.at)}</figcaption>
      </figure>`).join('');
    wall.scrollLeft = keepScroll;
    shotListCache = { id: shotCurId, shots };
    // 点击 → 全屏预览（← → 切换，Esc / 点空白关闭）
    wall.querySelectorAll('.shotItem').forEach(el => {
      el.onclick = () => shotView(Number(el.dataset.i));
    });
    empty.style.display = 'none';
    $('shotWrap').style.display = '';
    const meta = (lastShotStatus.devices || []).find(x => x.id === shotCurId);
    const interval = lastShotStatus.intervalSec || 10;
    const maxCount = lastShotStatus.maxCount || 50;
    $('shotMeta').textContent = `共 ${shots.length} 张（上限 ${maxCount}）· 来自 ${meta ? (meta.ip || meta.lastIp || '?') : '?'} · 每 ${interval} 秒一张，超出上限自动删最旧`;
  } catch (e) {
    // 404 = 该设备还没有任何截图
    wall.innerHTML = '';
    $('shotWrap').style.display = 'none';
    empty.style.display = '';
    empty.textContent = '还没有截图。打开「自动截屏」后，电视在线时按设定的间隔新增一张。';  }
}

let shotViewIndex = -1;

/** 打开第 i 张（相对照片墙顺序，0 = 最新）：← → 切换，Esc / 点空白关闭 */
function shotView(i){
  const shots = shotListCache.shots || [];
  if (!shots[i]) return;
  shotViewIndex = i;
  $('shotViewerImg').src = '/api/admin/shot/' + encodeURIComponent(shotCurId) + '/' + shots[i].at;
  $('shotViewerCap').textContent =
    `${new Date(shots[i].at).toLocaleString('zh-CN')} · ${agoText(shots[i].at)} · 第 ${i + 1}/${shots.length} 张`;
  $('shotViewer').classList.add('on');
  $('shotPrev').disabled = i <= 0;
  $('shotNext').disabled = i >= shots.length - 1;
}

function shotViewClose(){
  shotViewIndex = -1;
  $('shotViewer').classList.remove('on');
  $('shotViewerImg').removeAttribute('src');
}

function shotViewStep(d){
  const n = (shotListCache.shots || []).length;
  const i = shotViewIndex + d;
  if (i >= 0 && i < n) shotView(i);
}

$('shotPrev').onclick = e => { e.stopPropagation(); shotViewStep(-1); };
$('shotNext').onclick = e => { e.stopPropagation(); shotViewStep(1); };
$('shotViewerImg').onclick = e => e.stopPropagation();   // 点图本身不关闭
$('shotViewer').onclick = () => shotViewClose();          // 点空白关闭
document.addEventListener('keydown', e => {
  if (!$('shotViewer').classList.contains('on')) return;
  if (e.key === 'Escape') shotViewClose();
  else if (e.key === 'ArrowLeft') shotViewStep(-1);
  else if (e.key === 'ArrowRight') shotViewStep(1);
});

function shotTick(){
  if (document.hidden || !$('mainView') || $('mainView').classList.contains('hidden')) return;
  shotShow();
}

async function loadShotStatus(){
  try {
    lastShotStatus = await api('/api/admin/shot/status');
    shotEnabled = !!lastShotStatus.enabled;
    $('shotOn').checked = shotEnabled;
    // 截图间隔 / 最大张数：回显后台配置（焦点在里面时跳过，别冲掉正在输入的值）
    const si = $('shotInterval'), mc = $('shotMaxCount');
    if (si && document.activeElement !== si) si.value = lastShotStatus.intervalSec || 10;
    if (mc && document.activeElement !== mc) mc.value = lastShotStatus.maxCount || 50;
    // 密钥信息：一眼看出服务端现在用的是不是「电视授权过的那把钥匙」
    const k = lastShotStatus.key || {};
    const keyEl = $('shotKeyInfo');
    if (keyEl) {
      keyEl.innerHTML = k.valid
        ? `当前 adb 密钥：<b>${esc(k.name || '未命名')}</b> · 指纹 <code>${esc(k.fingerprint)}</code>` +
          (k.generated
            ? '<br><span style="color:#F7C97C">这是管理端自己生成的钥匙，电视多半没授权过 —— 这就是截图失败最常见的原因，请在下面上传电脑上已授权的 adbkey。</span>'
            : '<br>看起来是电脑同步过来的钥匙；若仍失败，请点「截图自检」看卡在哪一步。')
        : '<span style="color:#F7C97C">adb 密钥文件缺失或格式不对，请在下面上传已授权的 adbkey。</span>';
    }
    // 设备下拉框：跟设备列表对齐，记住上次选的
    const sel = $('shotDev');
    const list = lastShotStatus.devices || [];
    // 电视 IP 状态：Docker 网桥下自动识别会拿到 172.x.0.1，这里直接说清楚
    const ipEl = $('shotIpInfo');
    if (ipEl) {
      const cur = list.find(x => x.id === shotCurId) || list[0];
      if (!cur) {
        ipEl.textContent = '还没有电视连接';
      } else {
        const src = cur.ipSource === 'reported' ? '电视上报 · 换 IP 自动同步'
          : cur.fixedIp ? '手动指定 · 电视上报后自动接管'
            : '请求来源';
        ipEl.textContent = cur.ip
          ? `${cur.ip}（${src}）`
          : `未识别${cur.natIp ? '（只看到 Docker 网关 ' + cur.natIp + '，不是电视）' : ''}`;
        const inp = $('shotIpInput');
        if (inp && document.activeElement !== inp) inp.value = cur.fixedIp || '';
      }
    }
    if (!list.length) {
      sel.innerHTML = '<option value="">还没有电视连接</option>';
      shotCurId = '';
      return;
    }
    sel.innerHTML = list.map(d =>
      `<option value="${esc(d.id)}"${d.id === shotCurId ? ' selected' : ''}>${esc(d.name)}${d.online ? '' : '（离线）'}</option>`
    ).join('');
    if (!list.some(d => d.id === shotCurId)) shotCurId = list[0].id;
    sel.value = shotCurId;
    shotShow();
    // 自动补新图：只在开关打开时轮询，照片墙每轮拉一次列表，有新图才重画
    clearInterval(shotTimer);
    if (shotEnabled) shotTimer = setInterval(shotTick, (lastShotStatus.intervalMs || 10000));
  } catch (e) { /* 静默 */ }
}

$('shotDev').onchange = () => {
  shotCurId = $('shotDev').value;
  shotListCache = { id: '', shots: [] };   // 换设备：强制重画照片墙
  if (typeof shotViewClose === 'function') shotViewClose();
  shotShow();
};
$('shotRefresh').onclick = () => { loadShotStatus(); shotShow(); };

/** 把自检结果按步骤列出来，失败那一步用「✗」标红一眼可见 */
function renderDiag(d){
  const out = $('shotDiagOut');
  if (!out) return;
  const lines = (d.steps || []).map(s =>
    `${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? '：' + s.detail : ''}`);
  lines.unshift(d.ok ? '自检通过：这条链路是通的，可以点「立即截图」再试一次。'
                     : '自检发现问题，看第一个 ✗ 那一项：');
  // 建议由服务端根据实际诊断结果给（IP 缺失 / 容器 bridge / ADB 未授权各不相同），
  // 不能再一律提示「填 IP 就行」—— IP 本来就对时会把用户带错方向。
  if (!d.ok && d.advice) lines.push('', d.advice);
  out.textContent = lines.join('\n');
  out.style.display = '';
  showTools(true);
}

$('shotDiag').onclick = async () => {
  if (!shotCurId) { toast('还没有电视连接', true); return; }
  const btn = $('shotDiag');
  btn.disabled = true;
  const out = $('shotDiagOut');
  if (out) { out.style.display = ''; out.textContent = '正在自检…（连接电视最多 20 秒）'; }
  showTools(true);
  try {
    renderDiag(await api('/api/admin/shot/diagnose', {
      method: 'POST', body: JSON.stringify({ deviceId: shotCurId })
    }));
  } catch (e) {
    if (out) out.textContent = '自检请求失败：' + e.message;
    toast(e.message, true);
  } finally { btn.disabled = false; }
};

/** 手动指定电视 IP：Docker bridge 下服务端只能看到网桥网关，填一次就通 */
async function saveShotIp(ip){
  if (!shotCurId) { toast('还没有电视连接', true); return; }
  try {
    const r = await api('/api/admin/device/' + encodeURIComponent(shotCurId) + '/ip', {
      method: 'POST', body: JSON.stringify({ ip })
    });
    toast(ip ? `已指定 ${r.ip} 作为初始 IP；电视上报真实地址后会自动接管，换 IP 不用再改` : '已恢复自动识别');
    await loadShotStatus();
    $('shotDiag').click();          // 保存完立刻自检，直接告诉用户修好没有
  } catch (e) { toast('保存失败：' + e.message, true); }
}
$('shotIpBtn').onclick = () => saveShotIp($('shotIpInput').value.trim());
$('shotIpAuto').onclick = () => { $('shotIpInput').value = ''; saveShotIp(''); };

/** 上传电脑上已授权的 adb 私钥（C:\Users\<你>\.android\adbkey 整份） */
$('shotKeyBtn').onclick = async () => {
  const f = $('shotKeyFile').files && $('shotKeyFile').files[0];
  if (!f) { toast('先选一个 adbkey 文件', true); return; }
  const btn = $('shotKeyBtn');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/adb-key', {
      method: 'POST', body: JSON.stringify({ pem: await f.text() })
    });
    toast(`已同步 adb 密钥（指纹 ${r.key.fingerprint}），下一次连接立即生效`);
    await loadShotStatus();
    $('shotDiag').click();          // 顺手再自检一遍，直接告诉用户修好没有
  } catch (e) { toast('密钥上传失败：' + e.message, true); }
  finally { btn.disabled = false; }
};

// 手动截一张：不开自动截屏也能用；截完立刻把新图刷出来
$('shotNow').onclick = async () => {
  if (!shotCurId) { toast('还没有电视连接', true); return; }
  const btn = $('shotNow');
  btn.disabled = true;
  toast('正在截取电视画面…');
  try {
    await api('/api/admin/shot/capture', {
      method: 'POST',
      body: JSON.stringify({ deviceId: shotCurId })
    });
    await loadShotStatus();
    shotShow();
    toast('已截图');
  } catch (e) {
    toast('截图失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
};

$('shotOn').onchange = async () => {
  try {
    const r = await api('/api/admin/shot/status', {
      method: 'POST',
      body: JSON.stringify({ enabled: $('shotOn').checked })
    });
    shotEnabled = r.enabled;
    toast(shotEnabled ? '自动截屏已开启，电视在线时按设定的间隔截图' : '自动截屏已关闭，旧图按张数上限自动清掉');
    loadShotStatus();
  } catch (e) {
    toast(e.message, true);
    $('shotOn').checked = shotEnabled;
  }
};

/** 保存截图间隔 / 最大张数：最小 5 秒、5 张，服务端夹好后回显 */
$('shotCfgSave').onclick = async () => {
  const intervalSec = parseInt($('shotInterval').value, 10) || 10;
  const maxCount = parseInt($('shotMaxCount').value, 10) || 50;
  try {
    const r = await api('/api/admin/shot/status', {
      method: 'POST',
      body: JSON.stringify({ enabled: shotEnabled, intervalSec, maxCount })
    });
    shotEnabled = !!r.enabled;
    if (r.intervalSec) $('shotInterval').value = r.intervalSec;
    if (r.maxCount) $('shotMaxCount').value = r.maxCount;
    toast(`已保存：每 ${r.intervalSec} 秒截一张、最多 ${r.maxCount} 张，超出的立即删最旧`);
    shotListCache = { id: '', shots: [] };   // 上限变了，强制重画照片墙
    loadShotStatus();
  } catch (e) { toast('保存失败：' + e.message, true); }
};
