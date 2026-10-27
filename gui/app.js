/* DSH 会话同步 —— 渲染进程 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let CFG = null;          // 当前配置
let DEFAULT_HOME = '';   // 默认 DSH 目录
let BUSY = false;
let LOCAL = [];          // 本机会话
let REMOTE = null;       // 远端清单

// ───────────────────────── 小工具 ─────────────────────────

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 2600);
}

function humanSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function shortId(id) {
  if (!id) return '';
  return id.length > 24 ? `${id.slice(0, 11)}…${id.slice(-8)}` : id;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function backendLabel(cfg) {
  if (!cfg || !cfg.backend) return '未设置';
  if (cfg.backend === 'local') return `本地文件夹 ${cfg.path || ''}`;
  if (cfg.backend === 'webdav') return `WebDAV ${cfg.url || ''}`;
  if (cfg.backend === 's3') return `S3 ${cfg.bucket || ''}`;
  return cfg.backend;
}

function logLine(container, level, text) {
  const el = document.createElement('div');
  el.className = `l-${level || 'dim'}`;
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  // 防止无限增长
  while (container.childElementCount > 800) container.removeChild(container.firstChild);
}

// ───────────────────────── 导航 ─────────────────────────

function go(page) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'browse') refreshRemote();
  if (page === 'settings') renderSettings();
  if (page === 'home') refreshLocal();
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

// ───────────────────────── 侧栏状态 ─────────────────────────

function renderSideStatus() {
  const dot = $('#side-status');
  const txt = $('#side-status-text');
  if (!CFG || !CFG.backend) {
    dot.className = 'status-dot';
    txt.textContent = '未设置';
    return;
  }
  dot.className = 'status-dot ok';
  txt.textContent = backendLabel(CFG);
  txt.title = backendLabel(CFG);
}

// ───────────────────────── 首页 ─────────────────────────

async function refreshLocal() {
  const home = (CFG && CFG.dshHome) || DEFAULT_HOME;
  try {
    LOCAL = await window.api.listLocal(home);
  } catch (e) {
    LOCAL = [];
  }
  const tbody = $('#home-table tbody');
  tbody.innerHTML = '';

  const totalEvents = LOCAL.reduce((a, s) => a + s.events, 0);
  const totalSize = LOCAL.reduce((a, s) => a + s.size, 0);
  const children = LOCAL.filter((s) => s.isChild).length;
  const broken = LOCAL.filter((s) => s.broken).length;

  $('#home-stats').innerHTML = `
    <div class="stat"><b>${LOCAL.length}</b><span>会话</span></div>
    <div class="stat"><b>${totalEvents.toLocaleString()}</b><span>事件</span></div>
    <div class="stat"><b>${humanSize(totalSize)}</b><span>占用</span></div>
    <div class="stat"><b>${children}</b><span>子会话</span></div>
    ${broken ? `<div class="stat"><b style="color:var(--bad)">${broken}</b><span>损坏</span></div>` : ''}
  `;

  for (const s of LOCAL.slice(0, 200)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="id">${esc(shortId(s.id))}</td>
      <td class="num">${s.events.toLocaleString()}</td>
      <td class="num">${humanSize(s.size)}</td>
      <td>${s.preset ? `<span class="pill">${esc(s.preset)}</span>` : '—'}</td>
      <td>${s.broken ? '<span class="pill bad">读不出</span>' : s.isChild ? '<span class="pill child">子会话</span>' : ''}</td>
    `;
    tbody.appendChild(tr);
  }

  if (LOCAL.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty">这个 DSH 目录下还没有会话。<br>检查一下「设置」里的 DSH 数据目录对不对。</div></td></tr>`;
  }

  $('#home-backup-sub').textContent = CFG && CFG.backend
    ? `共 ${LOCAL.length} 个会话待同步`
    : '先设置同步位置';
  $('#home-restore-sub').textContent = CFG && CFG.backend
    ? backendLabel(CFG)
    : '先设置同步位置';
}

$('#home-refresh').addEventListener('click', refreshLocal);
$('#home-backup').addEventListener('click', () => go('backup'));
$('#home-restore').addEventListener('click', () => go('restore'));

// ───────────────────────── 备份 ─────────────────────────

function renderBackupHeader() {
  $('#backup-target').textContent = backendLabel(CFG);
  $('#backup-home').textContent = (CFG && CFG.dshHome) || DEFAULT_HOME;
}

$('#backup-start').addEventListener('click', async () => {
  if (BUSY) return;
  if (!CFG || !CFG.backend) { toast('先去「设置」选同步位置', 'bad'); go('settings'); return; }

  BUSY = true;
  const btn = $('#backup-start');
  btn.disabled = true;
  btn.textContent = '备份中…';
  $('#backup-log').innerHTML = '';
  $('#backup-bar').style.width = '0%';

  const res = await window.api.backup(CFG);

  btn.disabled = false;
  btn.textContent = '开始备份';
  BUSY = false;

  if (!res.ok) {
    logLine($('#backup-log'), 'bad', `失败：${res.error}`);
    toast('备份失败', 'bad');
    return;
  }
  const r = res.result;
  const log = $('#backup-log');
  logLine(log, 'head', '备份完成');
  logLine(log, 'ok', `会话 ${r.total} 个：新上传 ${r.uploaded}，跳过 ${r.skipped}`);
  logLine(log, 'ok', `本次传输 ${humanSize(r.bytes)}`);
  if (r.attachments) logLine(log, 'ok', `新增附件 ${r.attachments} 个`);
  if (r.presets && r.presets.length) {
    logLine(log, 'warn', `用到预设：${r.presets.join(', ')}（另一台机器上要装同名预设）`);
  }
  toast(`备份完成，上传 ${r.uploaded} 个`, 'ok');
  refreshLocal();
});

// ───────────────────────── 还原 ─────────────────────────

function renderRestoreHeader() {
  $('#restore-target').textContent = backendLabel(CFG);
  if (!$('#restore-cwd').value) {
    $('#restore-cwd').value = (CFG && CFG.dshHome ? '' : '');
  }
}

$('#restore-pick').addEventListener('click', async () => {
  const p = await window.api.pickFolder({ title: '选择还原到的工作目录' });
  if (p) $('#restore-cwd').value = p;
});

$('#restore-start').addEventListener('click', async () => {
  if (BUSY) return;
  if (!CFG || !CFG.backend) { toast('先去「设置」选同步位置', 'bad'); go('settings'); return; }

  const cwd = $('#restore-cwd').value.trim();
  if (!cwd) { toast('先填一下还原到哪个工作目录', 'bad'); return; }

  BUSY = true;
  const btn = $('#restore-start');
  btn.disabled = true;
  btn.textContent = '还原中…';
  $('#restore-log').innerHTML = '';
  $('#restore-bar').style.width = '0%';

  const res = await window.api.restore(CFG, cwd);

  btn.disabled = false;
  btn.textContent = '开始还原';
  BUSY = false;

  if (!res.ok) {
    logLine($('#restore-log'), 'bad', `失败：${res.error}`);
    toast('还原失败', 'bad');
    return;
  }
  const r = res.result;
  const log = $('#restore-log');
  logLine(log, 'head', '还原完成');
  logLine(log, 'ok', `会话 ${r.restored} 个（其中 ${r.rewritten} 个改了工作目录路径）`);
  if (r.attachments) logLine(log, 'ok', `附件还原 ${r.attachments} 个`);
  if (r.trash) logLine(log, 'warn', `原有会话已挪到：${r.trash}`);
  if (r.presets && r.presets.length) {
    logLine(log, 'warn', `用到预设：${r.presets.join(', ')}`);
    logLine(log, 'dim', '如果这台机器没装对应预设，打开会话会报 agent-preset/not-found，装上就好。');
  }
  logLine(log, 'head', '现在重启 DSH，会话列表里就能看到了。');
  toast(`还原完成，${r.restored} 个会话`, 'ok');
  refreshLocal();
});

// ───────────────────────── 查看备份 ─────────────────────────

async function refreshRemote() {
  const tbody = $('#browse-table tbody');
  const empty = $('#browse-empty');

  if (!CFG || !CFG.backend) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = '还没设置同步位置。先去「设置」。';
    $('#browse-sub').textContent = '同步位置里的会话清单';
    return;
  }

  tbody.innerHTML = `<tr><td colspan="5"><div class="empty">读取中…</div></td></tr>`;
  empty.hidden = true;

  try {
    REMOTE = await window.api.listRemote(CFG);
  } catch (e) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = `连不上同步位置：${e.message || e}`;
    return;
  }

  tbody.innerHTML = '';
  $('#browse-sub').textContent = `${REMOTE.label}　·　${REMOTE.rows.length} 个会话`;

  if (REMOTE.rows.length === 0) {
    empty.hidden = false;
    empty.textContent = '同步位置里还没有备份。先选「备份」。';
    return;
  }

  for (const r of REMOTE.rows) {
    const tr = document.createElement('tr');
    const dir = (r.cwd || '').split(/[\\/]/).filter(Boolean).slice(-1)[0] || '—';
    tr.innerHTML = `
      <td class="id">${esc(r.short)}</td>
      <td class="num">${(r.events || 0).toLocaleString()}</td>
      <td class="num">${humanSize(r.size)}</td>
      <td>${r.preset && r.preset !== '-' ? `<span class="pill">${esc(r.preset)}</span>` : '—'}</td>
      <td style="color:var(--text-faint)">${esc(dir)}${r.isChild ? ' <span class="pill child">子</span>' : ''}</td>
    `;
    tbody.appendChild(tr);
  }
}

$('#browse-refresh').addEventListener('click', refreshRemote);

// ───────────────────────── 体检 ─────────────────────────

$('#doctor-run').addEventListener('click', async () => {
  const list = $('#doctor-list');
  list.innerHTML = '<div class="check info"><div class="ic">…</div><div class="tx">检查中</div></div>';

  const res = await window.api.doctor(CFG);
  list.innerHTML = '';

  const icon = { ok: '✓', warn: '!', bad: '✗', info: '·' };
  for (const c of res.checks) {
    const el = document.createElement('div');
    el.className = `check ${c.level}`;
    el.innerHTML = `<div class="ic">${icon[c.level] || '·'}</div><div class="tx">${esc(c.text)}</div>`;
    list.appendChild(el);
  }
  const bads = res.checks.filter((c) => c.level === 'bad').length;
  toast(bads ? `发现 ${bads} 个问题` : '一切正常', bads ? 'bad' : 'ok');
});

// ───────────────────────── 设置 ─────────────────────────

let SETTINGS_BACKEND = 'local';

function renderSettings() {
  const cfg = CFG || {};
  SETTINGS_BACKEND = cfg.backend || 'local';

  $$('#backend-seg button').forEach((b) => b.classList.toggle('active', b.dataset.backend === SETTINGS_BACKEND));
  $$('[data-backend-panel]').forEach((p) => { p.hidden = p.dataset.backendPanel !== SETTINGS_BACKEND; });

  $('#local-path').value = cfg.path || '';
  $('#dav-url').value = cfg.url || '';
  $('#dav-user').value = cfg.username || '';
  $('#dav-pass').value = cfg.password || '';
  $('#s3-endpoint').value = cfg.endpoint || '';
  $('#s3-bucket').value = cfg.bucket || '';
  $('#s3-region').value = cfg.region || 'us-east-1';
  $('#s3-key').value = cfg.accessKeyId || '';
  $('#s3-secret').value = cfg.secretAccessKey || '';
  $('#s3-prefix').value = cfg.prefix || 'dsh-sync';
  $('#dsh-home').value = cfg.dshHome || DEFAULT_HOME;

  renderTrash();
}

$$('#backend-seg button').forEach((b) => {
  b.addEventListener('click', () => {
    SETTINGS_BACKEND = b.dataset.backend;
    $$('#backend-seg button').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-backend-panel]').forEach((p) => { p.hidden = p.dataset.backendPanel !== SETTINGS_BACKEND; });
  });
});

$('#local-pick').addEventListener('click', async () => {
  const p = await window.api.pickFolder({ title: '选择备份存放的文件夹' });
  if (p) $('#local-path').value = p;
});

$('#dsh-pick').addEventListener('click', async () => {
  const p = await window.api.pickFolder({ title: '选择 DSH 数据目录', defaultPath: DEFAULT_HOME });
  if (p) $('#dsh-home').value = p;
});

function collectConfig() {
  const cfg = { backend: SETTINGS_BACKEND, dshHome: $('#dsh-home').value.trim() || DEFAULT_HOME };
  if (SETTINGS_BACKEND === 'local') {
    cfg.path = $('#local-path').value.trim();
  } else if (SETTINGS_BACKEND === 'webdav') {
    cfg.url = $('#dav-url').value.trim();
    cfg.username = $('#dav-user').value.trim();
    cfg.password = $('#dav-pass').value;
  } else {
    cfg.endpoint = $('#s3-endpoint').value.trim();
    cfg.bucket = $('#s3-bucket').value.trim();
    cfg.region = $('#s3-region').value.trim() || 'us-east-1';
    cfg.accessKeyId = $('#s3-key').value.trim();
    cfg.secretAccessKey = $('#s3-secret').value;
    cfg.prefix = $('#s3-prefix').value.trim() || 'dsh-sync';
  }
  return cfg;
}

function validateConfig(cfg) {
  if (cfg.backend === 'local' && !cfg.path) return '请选择备份文件夹';
  if (cfg.backend === 'webdav' && !cfg.url) return '请填 WebDAV 地址';
  if (cfg.backend === 's3') {
    if (!cfg.endpoint) return '请填 Endpoint';
    if (!cfg.bucket) return '请填 Bucket';
    if (!cfg.accessKeyId) return '请填 AccessKeyId';
    if (!cfg.secretAccessKey) return '请填 AccessKeySecret';
  }
  return null;
}

$('#settings-save').addEventListener('click', async () => {
  const cfg = collectConfig();
  const err = validateConfig(cfg);
  if (err) { toast(err, 'bad'); return; }

  await window.api.saveConfig(cfg);
  CFG = cfg;
  renderSideStatus();
  renderBackupHeader();
  renderRestoreHeader();
  await refreshLocal();
  toast('设置已保存', 'ok');
});

$('#settings-test').addEventListener('click', async () => {
  const cfg = collectConfig();
  const err = validateConfig(cfg);
  if (err) { toast(err, 'bad'); return; }

  toast('正在测试…');
  try {
    const r = await window.api.listRemote(cfg);
    toast(`连上了，里面有 ${r.rows.length} 个会话`, 'ok');
  } catch (e) {
    toast(`连不上：${e.message || e}`, 'bad');
  }
});

async function renderTrash() {
  const home = (CFG && CFG.dshHome) || DEFAULT_HOME;
  const box = $('#trash-list');
  const items = await window.api.listTrash(home);
  if (items.length === 0) {
    box.innerHTML = '<div class="hint" style="color:var(--text-faint);font-size:12px">没有回收目录。</div>';
    return;
  }
  box.innerHTML = '';
  for (const name of items) {
    const el = document.createElement('div');
    el.className = 'trash-item';
    el.innerHTML = `<span>${esc(name)}</span><button class="btn ghost sm">打开位置</button>`;
    el.querySelector('button').addEventListener('click', () => window.api.openPath(home));
    box.appendChild(el);
  }
}

// ───────────────────────── 进度事件 ─────────────────────────

window.api.onEvent((evt) => {
  if (evt.type === 'progress') {
    const pct = evt.total ? Math.round((evt.done / evt.total) * 100) : 0;
    const bar = evt.phase === 'sessions'
      ? (BUSY && $('#page-backup').classList.contains('active') ? $('#backup-bar') : $('#restore-bar'))
      : (BUSY && $('#page-backup').classList.contains('active') ? $('#backup-bar') : $('#restore-bar'));
    if (bar) bar.style.width = `${pct}%`;

    const phaseEl = $('#page-backup').classList.contains('active') ? $('#backup-phase') : $('#restore-phase');
    if (phaseEl) {
      const name = evt.phase === 'sessions' ? '会话' : '附件';
      phaseEl.textContent = `${name} ${evt.done}/${evt.total}`;
    }
    return;
  }

  const log = $('#page-backup').classList.contains('active') ? $('#backup-log') : $('#restore-log');
  if (evt.type === 'log' && log) logLine(log, evt.level, evt.text);
  if (evt.type === 'error' && log) logLine(log, 'bad', evt.text);
});

// ───────────────────────── 启动 ─────────────────────────

async function boot() {
  const info = await window.api.appInfo();
  DEFAULT_HOME = info.defaultDshHome;

  $('#app-version').textContent = `v${info.version}`;
  $('#about-version').textContent = `v${info.version}`;
  $('#about-config').textContent = info.configPath;
  $('#about-electron').textContent = `Electron ${info.electron} / Node ${info.node}`;

  const got = await window.api.getConfig();
  CFG = got.config;

  if (!CFG) {
    CFG = { backend: 'local', dshHome: DEFAULT_HOME, path: '' };
  }
  if (!CFG.dshHome) CFG.dshHome = DEFAULT_HOME;

  renderSideStatus();
  renderBackupHeader();
  renderRestoreHeader();
  renderSettings();
  await refreshLocal();

  // 默认还原目录：优先用本机默认工作目录
  if (!$('#restore-cwd').value) {
    $('#restore-cwd').value = `${DEFAULT_HOME.replace(/[\\/]\.dsh$/, '')}\\Documents\\deepseek-harness\\default-workspace`;
  }

  if (!got.config || !got.config.backend || (got.config.backend === 'local' && !got.config.path)) {
    go('settings');
    toast('先设置一下同步位置');
  }
}

boot();
