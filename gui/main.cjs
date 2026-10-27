/**
 * Electron 主进程：开窗口、管配置、跑同步任务。
 * 渲染进程通过 preload 暴露的 API 调用，所有文件操作都在这里做。
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');

// 核心库是 ESM，用动态 import 加载
let core = null;
async function getCore() {
  if (!core) core = await import('./core.mjs');
  return core;
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return null; }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'DSH 会话同步',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ───────────────────────────── IPC ─────────────────────────────

const send = (evt) => {
  if (win && !win.isDestroyed()) win.webContents.send('sync:event', evt);
};

ipcMain.handle('config:get', async () => {
  const c = loadConfig();
  const c2 = await getCore();
  return { config: c, defaultDshHome: c2.defaultDshHome(), userData: app.getPath('userData') };
});

ipcMain.handle('config:save', async (_e, cfg) => {
  saveConfig(cfg);
  return { ok: true };
});

ipcMain.handle('dialog:pickFolder', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title || '选择文件夹',
    defaultPath: opts.defaultPath || os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:openPath', async (_e, p) => {
  if (!p) return;
  await shell.openPath(p);
});

ipcMain.handle('local:list', async (_e, dshHome) => {
  const c = await getCore();
  return c.listLocalSessions(dshHome);
});

ipcMain.handle('remote:list', async (_e, cfg) => {
  const c = await getCore();
  return c.doList(cfg);
});

ipcMain.handle('doctor', async (_e, cfg) => {
  const c = await getCore();
  return c.doDoctor(cfg);
});

ipcMain.handle('backup', async (_e, cfg) => {
  const c = await getCore();
  try {
    const r = await c.doBackup(cfg, send);
    return { ok: true, result: r };
  } catch (e) {
    send({ type: 'error', text: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('restore', async (_e, cfg, targetCwd) => {
  const c = await getCore();
  try {
    const r = await c.doRestore(cfg, targetCwd, send);
    return { ok: true, result: r };
  } catch (e) {
    send({ type: 'error', text: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('app:info', async () => {
  const c = await getCore();
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    configPath: CONFIG_PATH,
    defaultDshHome: c.defaultDshHome(),
  };
});

ipcMain.handle('trash:list', async (_e, dshHome) => {
  try {
    const entries = await fsp.readdir(dshHome, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith('.dsh-sync-trash-'))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch { return []; }
});
