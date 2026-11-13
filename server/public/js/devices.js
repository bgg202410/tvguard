async function loadDevices(){
  try {
    const d = await api('/api/admin/overview');
    lastOverview = d;
    renderDevices(d.devices);
    bankTotal = d.bank.total;
    renderBankEntry();
    // 只更新 chips 上的题量数字，不重建 DOM，避免打断当前筛选状态
    updateChipCounts(d.bank);
  } catch (e) { /* 静默 */ }
}

function renderDevices(list){
  const box = $('devices');
  if (!list.length){
    box.innerHTML = `<div class="card"><div class="empty">还没有电视连接过。<br>
      在电视上打开「守时桌面」，它会自动注册到这台服务器。</div></div>`;
    return;
  }
  const n = list.length;
  // 版式跟着台数走：1 台铺满整行，2 台左右各半，3 台以上才走网格
  box.className = 'grid' + (n === 1 ? ' one' : n === 2 ? ' two' : '');
  box.innerHTML = list.map((d, i) => {
    const limit = d.policy.dailyLimitMin * 60000;
    const used = d.stats ? d.stats.watchedMs : 0;
    // 兜底：used/limit 任一不是有效数字时别让 width 变成 NaN%（浏览器会退回 100%，看着像看满了）
    const pct = Number.isFinite(used) && Number.isFinite(limit) && limit > 0
      ? Math.min(100, Math.max(0, Math.round(used / limit * 100)))
      : 0;
    const cls = pct > 90 ? 'bad' : (pct > 70 ? 'warn' : '');
    const ov = Object.keys(d.override || {}).length
      ? `<span class="tag">独立策略</span>` : '';
    // adb 实际使用的 IP：Docker 网桥下 lastIp 会是 172.x.0.1，服务端已给出解析后的 ip
    const devIp = d.ip || d.lastIp || '';
    const apps = d.apps || [];
    // 答题换时长：只在开关打开时显示，否则这行对家长没有意义
    const rw = d.reward || {};
    // 1~2 台时卡片宽、统计是仪表盘格，长句给两格宽并压短文案，免得折行留空洞
    const wideCard = n <= 2;
    const rwRows = rw.enabled ? `
      <div class="kv${wideCard ? ' span2' : ''}"><span>答题换时长</span><b>今日 +${Math.round((rw.bonusMs || 0) / 60000)} 分钟
        ${wideCard
          ? `· 还可换 ${rw.timesLeft || 0} 次`
          : `（${rw.times || 0}/${rw.maxTimes || 0} 次，还可换 ${rw.timesLeft || 0} 次）`}</b></div>
      <div class="kv"><span>本轮进度</span><b>已答对 ${rw.correct || 0}/${rw.need || 0} 题</b></div>` : '';
    const launchOpts = [`<option value="">显示守时桌面（推荐）</option>`]
      .concat(apps.map(a => {
        const sel = a.pkg === d.launchPkg ? ' selected' : '';
        const off = a.pkg === d.launchPkg ? '' : '';
        return `<option value="${esc(a.pkg)}"${sel}>${esc(a.label)}${off}</option>`;
      })).join('');
    // 设备管理员：保活的关键手段。状态只能由电视上报，所以多一个「等待执行」的中间态
    const ad = d.admin || {};
    const waiting = !!ad.pending;
    // no_ui：电视的系统设置被精简掉了「设备管理员」界面，机内怎么点都开不了，
    // 只能从电脑上用 adb 激活。这个要说清楚，否则家长会一直拨开关。
    const noUi = !ad.active && ad.error === 'no_ui';
    const adState = waiting ? '等待执行' : ad.active ? '已激活' : noUi ? '需电脑激活' : '未激活';
    const adTone = waiting ? 'warn' : ad.active ? 'ok' : 'bad';
    // 开关外观：已激活=绿、等待执行=黄、其余=灰
    const swCls = ad.active ? 'on' : waiting ? 'pending' : '';
    // 点一下切状态；指令还没执行时点一下是「撤销」
    const swAction = waiting ? 'cancel' : ad.active ? 'off' : 'on';
    // 所有长说明都收进悬浮提示，右侧面板只留操作
    const adTitle = [
      ad.active
        ? '设备管理员已激活：电视的「强制停止」被禁用，清理工具一般会绕开。点开关可以取消。'
        : '',
      waiting
        ? '指令已下发，等电视执行（在线时半分钟内生效）。点一下可以撤销。'
        : '',
      (!ad.active && !waiting)
        ? '打开后电视上会弹系统确认框，遥控器点一下「激活」才生效 —— Android 不允许远程打开，只有电视在线时才能收到。'
        : '',
      noUi
        ? '这台电视的系统设置里没有「设备管理员」界面，机内点不开。管理端检测到没激活时会自动通过 adb 远程激活（要求电视开着网络调试、和管理端在同一局域网）。'
        : ''
    ].filter(Boolean).join(' ');
    // 无障碍：桌面拦截的必要条件，电视报上来的真实状态。
    // 没开时管理端会自动通过 adb 补开（要求电视开着网络调试、和管理端同一局域网），
    // 全程自动、不需要家长操作，所以卡片上不再展示状态行。
    return `
    <div class="card ${d.online ? 'hot' : ''}">
      <div class="row between">
        <div>
          <div class="devname">${esc(d.name)} ${ov}</div>
          <div class="muted">${esc(d.model || '型号未知')} · ${d.appVersion ? '实装 v' + esc(d.appVersion) : '版本未上报'}</div>
        </div>
          <span class="pill" style="padding:4px 10px"
              title="电视按各自心跳间隔上报；超过间隔 2 倍没消息才算离线">
          <span class="dot ${d.online ? '' : 'off'}"></span>${d.online ? '在线' : '离线'}
        </span>
      </div>
      <div class="bar"><i class="${cls}" style="width:${pct}%"></i></div>
      <div class="devwrap">
        <div class="devstats">
          <div class="kv"><span>上网总时长（每天）</span><b>${d.policy.dailyLimitMin} 分钟</b></div>
          <div class="kv"><span>今日已看</span><b>${fmtMin(used)} 分钟</b></div>
          <div class="kv"><span>今日剩余</span><b>${fmtMin(d.remainingMs)} 分钟</b></div>
          <div class="kv"><span>答题 / 答对</span><b>${(d.stats && d.stats.quizCount) || 0} / ${(d.stats && d.stats.passCount) || 0}</b></div>
          <div class="kv"><span>最后心跳</span><b>${ago(d.lastSeen)}${d.online ? '' : '（已断开）'}</b></div>
          <div class="kv"><span>心跳间隔（秒）</span>
            <div class="switchrow" title="客户端每 N 秒请求一次管理端（连接心跳），每台电视独立；断开后管理端立即拉起客户端。默认 5 秒。">
              <input id="hb_${i}" data-dev="${esc(d.id)}" type="number" min="1" max="120" value="${d.heartbeatSec || 5}" style="width:70px" />
              <button class="small" onclick="saveHeartbeat(${i})">保存</button>
            </div>
          </div>
          <div class="kv"><span>电视 IP（截图 / 唤醒）</span>
            <!-- 直接就地改：以前只显示一个「自动同步」标签 + 「改」按钮，标签没用、
                 改还要弹窗。现在输入框就是当前实际用的 IP，改完点保存即可；
                 清空保存 = 恢复自动识别（电视上报的地址会自动接管）。 -->
            <div class="switchrow" title="${d.natIp ? esc('Docker 网桥网关 ' + d.natIp + ' 已自动排除；这里填电视的真实局域网地址') : '电视每次心跳都会上报真实 IP，上报后自动接管；这里只是播种值，填一次就够'}">
              <input id="ip_${i}" data-dev="${esc(d.id)}" type="text" inputmode="decimal"
                     maxlength="15" placeholder="192.168.1.x" value="${esc(devIp)}" style="width:120px" />
              <button class="small" onclick="saveDevIp(${i})">保存</button>
            </div>
          </div>
          <!-- 保活：设备管理员需遥控器确认；无障碍有 adb 权限就自动补开，不占卡片 -->
          <div class="kv span2"><span>后台保活</span>
            <div class="keep">
              <div class="switchrow" title="${esc(adTitle)}">
                <button class="switch ${swCls}" aria-label="设备管理员"
                        onclick="adminCmd('${esc(d.id)}','${swAction}')"></button>
                <em class="${adTone}">设备管理员 · ${adState}</em>
              </div>
            </div>
          </div>
          ${rwRows}
        </div>

        <div class="devside">
          <div class="field">
            <label class="f">打开「守时桌面」后直接进入</label>
            <div class="rowgap">
              <select id="launch_${i}" data-dev="${esc(d.id)}" style="flex:1;min-width:0">${launchOpts}</select>
              <button class="small" onclick="saveLaunch(${i})">保存</button>
            </div>
            <div class="muted" style="margin-top:6px">
              已同步 ${apps.length} 个应用${d.appsAt ? ' · ' + ago(d.appsAt) : ' · 还没同步'}
              ${apps.length ? '' : '<br>在电视上打开一次「守时桌面」，应用清单会自动传过来'}
            </div>
          </div>

          <div class="rowgap" style="margin-top:14px">
            <button class="small" onclick="editDevice('${esc(d.id)}')">改名 / 独立策略</button>
            <button class="ghost small" onclick="resetToday('${esc(d.id)}')">重置今日</button>
            <button class="ghost small" style="color:#F79C9C" onclick="delDevice('${esc(d.id)}')">删除</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

window.editDevice = async id => {
  const d = (lastOverview.devices || []).find(x => x.id === id);
  if (!d) return;
  const name = prompt('电视名称', d.name);
  if (name === null) return;
  const lim = prompt('该电视每日上网总时长（分钟，留空=跟随全局）', d.override.dailyLimitMin || '');
  if (lim === null) return;
  const override = Object.assign({}, d.override);
  if (String(lim).trim() === '') delete override.dailyLimitMin;
  else override.dailyLimitMin = Number(lim);
  try {
    await api('/api/admin/device/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify({ name: name || d.name, override })
    });
    toast('已保存');
    loadDevices();
  } catch (e) { toast(e.message, true); }
};

/** 重置今日：把「今日已看 / 答题次数 / 已换时长」清零，客户端 30 秒内跟着对齐 */
window.resetToday = async id => {
  const d = (lastOverview.devices || []).find(x => x.id === id);
  const used = d ? Math.round(((d.stats && d.stats.watchedMs) || 0) / 60000) : 0;
  if (!confirm(`把「${d ? d.name : id}」今天的统计清零？\n\n当前今天已看 ${used} 分钟，清零后可以从头开始算。\n只影响今天，策略和题库不动。`)) return;
  try {
    await api('/api/admin/device/' + encodeURIComponent(id) + '/reset', { method: 'POST' });
    toast('今日统计已清零，客户端半分钟内跟上');
    loadDevices();
    loadEvents();
  } catch (e) { toast(e.message, true); }
};

/** 删除设备：测试条目 / 已弃用的电视，从列表里彻底移除（连同它的截图） */
window.delDevice = async id => {
  const d = (lastOverview.devices || []).find(x => x.id === id);
  if (!confirm(`把「${d ? d.name : id}」从管理端删掉？\n\n删除后它的统计、保活记录、截图全部清除。\n如果客户端还在用，下次心跳会重新注册进来（等于一次重置）。`)) return;
  try {
    await api('/api/admin/device/' + encodeURIComponent(id), { method: 'DELETE' });
    toast('已删除');
    loadOverview();
    loadEvents();
  } catch (e) { toast(e.message, true); }
};

/**
 * 设备管理员（保活）开关。
 *
 * 注意这里是「下发」不是「执行」：Android 不允许远程激活，客户端拉到指令后
 * 自己弹系统确认框，家长用遥控器点一下才真生效。所以点完只看「已下发」。
 */
window.adminCmd = async (id, action) => {
  const d = (lastOverview.devices || []).find(x => x.id === id);
  const name = d ? d.name : id;
  if (!d || !d.online) {
    if (!confirm(`「${name}」现在离线（超过各自心跳间隔 2 倍没上报）。\n\n指令会先存着，等电视下次上线后 30 分钟内执行；过时就作废。继续？`)) return;
  }
  const msg = action === 'on'
    ? `给「${name}」下发「激活设备管理员」？\n\n电视上会弹出系统确认框，需要用遥控器点一下「激活」才算完成。`
    : action === 'off'
      ? `给「${name}」下发「取消设备管理员」？\n\n取消后这台电视又能被清理工具强停了，计时和答题可能会中断。`
      : '撤销还没执行的那条指令？';
  if (!confirm(msg)) return;
  try {
    const r = await api('/api/admin/device/' + encodeURIComponent(id) + '/admin', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    const a = r.admin || {};
    if (action === 'cancel') toast('已撤销');
    else if (a.pending) toast('已下发，客户端 30 秒内会弹确认框');
    else if (action === 'on' && a.active) toast('这台电视本来就已激活');
    else if (action === 'off' && !a.active) toast('这台电视本来就没激活');
    else toast('已处理');
    loadDevices();
    loadEvents();
  } catch (e) { toast(e.message, true); }
};

/** 启动项：电视下次打开「守时桌面」时直接进入选中的应用 */
window.saveLaunch = async i => {
  const sel = $('launch_' + i);
  if (!sel) return;
  const id = sel.dataset.dev;
  try {
    await api('/api/admin/device/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify({ launchPkg: sel.value })
    });
    toast(sel.value ? '已保存，下次打开守时桌面直接进入该应用' : '已保存，下次打开显示应用列表');
    loadDevices();
  } catch (e) { toast(e.message, true); }
};

/** 心跳间隔（秒）：客户端连管理端的连接间隔，每设备独立，一对多 */
window.saveHeartbeat = async i => {
  const inp = $('hb_' + i);
  if (!inp) return;
  const id = inp.dataset.dev;
  const v = Math.max(1, Math.min(120, parseInt(inp.value, 10) || 5));
  try {
    await api('/api/admin/device/' + encodeURIComponent(id), {
      method: 'PUT', body: JSON.stringify({ heartbeatSec: v })
    });
    toast('已保存心跳间隔 ' + v + ' 秒，客户端下次会话即生效');
    loadDevices();
  } catch (e) { toast(e.message, true); }
};

/** 设备卡上直接改电视 IP；清空保存 = 恢复自动识别（Docker 网桥场景必填） */
window.saveDevIp = async i => {
  const inp = $('ip_' + i);
  if (!inp) return;
  const id = inp.dataset.dev;
  const v = inp.value.trim();
  if (v && !/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) { toast('IP 格式不对，例如 192.168.1.73', true); return; }
  try {
    const r = await api('/api/admin/device/' + encodeURIComponent(id) + '/ip', {
      method: 'POST', body: JSON.stringify({ ip: v })
    });
    toast(v ? `已保存电视 IP：${r.ip || v}（电视上报真实地址后会自动接管）` : '已清空，恢复自动识别');
    loadDevices();
  } catch (e) { toast('保存失败：' + e.message, true); }
};

// 设备卡上的在线/心跳都是「页面加载那一刻」的快照，
// 不刷新的话看到的可能是几分钟前的旧状态。这里每 20 秒拉一次 overview，
// 只重画设备区和题量 chips；正在改输入框时跳过这一轮，不冲掉没保存的修改。
// 在线/离线状态每 20 秒刷新一次，掉线/恢复不用等下一分钟才看到。
setInterval(() => {
  if (document.hidden) return;
  const app = $('appView');
  if (!app || app.classList.contains('hidden')) return;
  // 正在设备卡里改东西（IP / 心跳 / 策略）就先不重画：
  // 重画是整块 innerHTML 替换，会把还没保存的输入冲掉。
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && ae.closest && ae.closest('#devices')) return;
  loadDevices();
}, 20000);
