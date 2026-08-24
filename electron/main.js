// DeepSeek Harness 桌面外壳
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeTheme, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { DshBackend, DEFAULT_HOST, DEFAULT_PORT } = require('./backend');

const isDev = process.argv.includes('--dev') || !app.isPackaged;
const APP_VERSION = app.getVersion();

let mainWindow = null;
let tray = null;
let backend = null;
let isQuitting = false;
let backendUrl = null;

// ─── 单实例锁 ──────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// ─── 后端 ──────────────────────────────────────────────────
async function startBackend() {
  backend = new DshBackend({ host: DEFAULT_HOST, port: DEFAULT_PORT });
  backend.onBackendCrashed = (code) => {
    if (isQuitting) return;
    dialog.showErrorBox('DeepSeek Harness 后端异常退出', `dsh 进程退出 (code=${code})，应用将关闭。`);
    app.quit();
  };
  backendUrl = await backend.start();
  return backendUrl;
}

async function restartBackend() {
  if (backend) await backend.stop();
  send('backend-status', 'restarting');
  try {
    await startBackend();
    send('backend-status', 'ready', backendUrl);
    showWindow();
  } catch (err) {
    dialog.showErrorBox('后端启动失败', String(err.message || err));
  }
}

// ─── 窗口 ──────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 940, minHeight: 600,
    show: false, title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1e' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin !== new URL(backendUrl).origin) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    } catch { return { action: 'deny' }; }
  });

  nativeTheme.on('updated', () => {
    if (mainWindow) {
      mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1a1a1e' : '#ffffff');
      send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
  });

  mainWindow.loadURL(backendUrl);
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ─── 托盘 ──────────────────────────────────────────────────
function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'icon.png'));
  tray.setToolTip(`DeepSeek Harness v${APP_VERSION}`);
  rebuildTrayMenu();
  tray.on('click', showWindow);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const autoLaunchEnabled = isAutoLaunchEnabled();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showWindow },
    { label: '重启服务', click: () => restartBackend() },
    { type: 'separator' },
    { label: `开机自启: ${autoLaunchEnabled ? '开 ✓' : '关'}`, click: toggleAutoLaunch },
    { type: 'separator' },
    { label: `v${APP_VERSION}`, enabled: false },
    { label: '检查 dsh 运行时更新…', click: () => checkDshUpdate() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// ─── 快捷键 & 自启动 ──────────────────────────────────────
function registerShortcuts() {
  if (!globalShortcut.register('CommandOrControl+Alt+D', showWindow))
    console.warn('[main] 快捷键注册失败');
}

function isAutoLaunchEnabled() {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
}

function toggleAutoLaunch() {
  const current = isAutoLaunchEnabled();
  app.setLoginItemSettings({ openAtLogin: !current, openAsHidden: true, path: process.execPath });
  rebuildTrayMenu();
}

function setupAutoLaunch() {
  // 首次运行时设置为开启，之后由用户通过菜单控制
  const settings = app.getLoginItemSettings();
  if (!settings.openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, path: process.execPath });
  }
}

// ─── dsh 运行时更新 ────────────────────────────────────────
let dshUpdating = false;

function getDshRuntimeDir() {
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'dsh-runtime')
    : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, '..', '..', 'dist', 'win-unpacked', 'resources', 'dsh-runtime');
  return fs.existsSync(dev) ? dev : null;
}

function getDshVersion(runtimeDir) {
  try {
    const p = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).version : null;
  } catch { return null; }
}

function fetchNpmLatest() {
  return new Promise((resolve, reject) => {
    const https = require('https');
    https.get('https://registry.npmmirror.com/@deepseek-ai/dsh/latest', { timeout: 15000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf).version); }
        catch { reject(new Error('解析版本失败')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('网络超时')); });
  });
}

async function checkDshUpdate() {
  if (dshUpdating) return;
  const runtimeDir = getDshRuntimeDir();
  if (!runtimeDir) { dialog.showErrorBox('错误', '找不到 dsh-runtime 目录'); return; }

  const current = getDshVersion(runtimeDir);
  send('dsh-update:status', { phase: 'checking', currentVersion: current });

  let latest;
  try { latest = await fetchNpmLatest(); }
  catch (err) { send('dsh-update:status', { phase: 'error', message: err.message }); return; }

  if (current && latest === current) {
    send('dsh-update:status', { phase: 'up-to-date', version: current });
    dialog.showMessageBox({ type: 'info', buttons: ['好的'], title: 'dsh 运行时', message: `已是最新 (${current})` });
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['更新', '取消'], title: 'dsh 运行时更新',
    message: `发现新版本: ${current || '?'} → ${latest}`,
    detail: '更新后需重启应用。',
  });
  if (response !== 0) return;

  dshUpdating = true;
  send('dsh-update:status', { phase: 'updating', targetVersion: latest });

  try {
    await doDshUpdate(runtimeDir, latest);
    updateRuntimeJson(runtimeDir, latest);
    send('dsh-update:status', { phase: 'done', version: latest });
    const { response: r } = await dialog.showMessageBox({
      type: 'info', buttons: ['立即重启', '稍后'], title: '更新完成',
      message: `已更新到 v${latest}`, detail: '建议重启以使用新版本。',
    });
    if (r === 0) { isQuitting = true; if (backend) await backend.stop(); app.relaunch(); app.exit(0); }
  } catch (err) {
    send('dsh-update:status', { phase: 'error', message: err.message });
    dialog.showErrorBox('更新失败', String(err.message || err));
  } finally {
    dshUpdating = false;
  }
}

function doDshUpdate(runtimeDir, targetVersion) {
  const { execFile } = require('child_process');
  const dsDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai');
  const backupDir = path.join(runtimeDir, '_bak_ds');
  const tmpDir = path.join(runtimeDir, '_tmp_update');

  // 清理残留
  for (const d of [backupDir, tmpDir]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });

  // 备份
  if (fs.existsSync(dsDir)) fs.renameSync(dsDir, backupDir);

  try {
    // 写临时 package.json + npm install
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: '_tmp', private: true,
      dependencies: { '@deepseek-ai/dsh': targetVersion },
    }));

    return new Promise((resolve, reject) => {
      execFile('npm', ['install', '--registry', 'https://registry.npmmirror.com'], {
        cwd: tmpDir, timeout: 300000, windowsHide: true,
      }, (err) => {
        if (err) return reject(err);
        const newDs = path.join(tmpDir, 'node_modules', '@deepseek-ai');
        if (!fs.existsSync(newDs)) return reject(new Error('npm install 后找不到包'));
        fs.cpSync(newDs, dsDir, { recursive: true });
        resolve();
      });
    });
  } finally {
    for (const d of [tmpDir, backupDir]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

function updateRuntimeJson(runtimeDir, version) {
  try {
    fs.writeFileSync(path.join(runtimeDir, 'RUNTIME.json'), JSON.stringify({
      version, preparedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

// ─── IPC ───────────────────────────────────────────────────
function send(ch, ...args) { mainWindow?.webContents?.send(ch, ...args); }

ipcMain.handle('backend:status', () => ({ running: !!backend?.child, url: backendUrl }));
ipcMain.handle('backend:restart', () => restartBackend());
ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });
ipcMain.handle('app:version', () => APP_VERSION);
ipcMain.handle('dsh-update:check', () => checkDshUpdate());
ipcMain.handle('dsh-update:current-version', () => {
  const dir = getDshRuntimeDir();
  return dir ? getDshVersion(dir) : null;
});

// ─── 启动 ──────────────────────────────────────────────────
app.whenReady().then(async () => {
  try { await startBackend(); }
  catch (err) { dialog.showErrorBox('启动失败', `无法启动 dsh 后端:\n${err.message}`); app.quit(); return; }

  createWindow();
  createTray();
  registerShortcuts();
  if (!isDev) setupAutoLaunch();
});

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', async (e) => {
  if (backend?.child) { e.preventDefault(); await backend.stop(); app.exit(0); }
});
app.on('activate', () => showWindow());
