// DeepSeek Harness 桌面外壳 - 主进程
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeTheme, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { DshBackend, DEFAULT_HOST, DEFAULT_PORT } = require('./backend');

const isDev = process.argv.includes('--dev') || !app.isPackaged;
let mainWindow = null;
let tray = null;
let backend = null;
let isQuitting = false;
let backendUrl = null;

// ---------- 单实例锁 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

// ---------- 后端管理 ----------
async function startBackend() {
  backend = new DshBackend({ host: DEFAULT_HOST, port: DEFAULT_PORT });
  backend.onBackendCrashed = (code) => {
    if (isQuitting) return;
    dialog.showErrorBox('DeepSeek Harness 后端异常退出', `dsh 进程意外退出 (code=${code})。应用将退出，请重启。`);
    app.quit();
  };
  backendUrl = await backend.start();
  return backendUrl;
}

async function restartBackend() {
  if (backend) await backend.stop();
  mainWindow && mainWindow.webContents.send('backend-status', 'restarting');
  try {
    await startBackend();
    mainWindow && mainWindow.webContents.send('backend-status', 'ready', backendUrl);
    showWindow();
  } catch (err) {
    dialog.showErrorBox('后端启动失败', String(err.message || err));
  }
}

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1e' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('close', (e) => {
    // 点 X 关窗 → 最小化到托盘，不退出（托盘退出才是真退出）
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 外链用系统浏览器打开；同源才允许内嵌
    try {
      if (new URL(url).origin !== new URL(backendUrl).origin) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    } catch {
      return { action: 'deny' };
    }
  });

  // 深色模式跟随系统
  nativeTheme.on('updated', () => {
    if (mainWindow) {
      mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1a1a1e' : '#ffffff');
      mainWindow.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
  });

  // 加载后端页面
  mainWindow.loadURL(backendUrl);
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------- 托盘 ----------
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  tray = new Tray(iconPath);
  tray.setToolTip('DeepSeek Harness');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: showWindow },
    { label: '重启服务', click: () => restartBackend() },
    { type: 'separator' },
    { label: '检查更新', click: () => checkForUpdates() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow); // 单击托盘显示
}

// ---------- 全局快捷键 ----------
function registerShortcuts() {
  const ok = globalShortcut.register('CommandOrControl+Alt+D', showWindow);
  if (!ok) console.warn('[main] 全局快捷键注册失败 (可能被占用)');
}

// ---------- 开机自启动 ----------
function setupAutoLaunch() {
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
    path: process.execPath,
  });
}

// ---------- 自动更新 ----------
let autoUpdater = null;

function initUpdater() {
  let updater;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (err) {
    console.warn('[updater] 模块加载失败:', err.message);
    return;
  }
  updater.on('update-available', (info) => console.log(`[updater] 发现新版本 ${info.version}，自动下载中…`));
  updater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['立即重启安装', '稍后'],
      title: '更新已就绪',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '重启应用后自动安装更新。',
    });
    if (response === 0) {
      isQuitting = true;
      if (backend) await backend.stop();
      updater.quitAndInstall();
    }
  });
  updater.on('error', (err) => console.warn('[updater]', err.message));
  autoUpdater = updater;
}

async function checkForUpdates() {
  if (!autoUpdater) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn('[updater] 检查更新失败:', err.message);
  }
}

// ---------- IPC ----------
ipcMain.handle('backend:status', () => ({ running: !!backend && !!backend.child, url: backendUrl }));
ipcMain.handle('backend:restart', () => restartBackend());
ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (err) {
    dialog.showErrorBox('启动失败', `无法启动 dsh 后端:\n${err.message}`);
    app.quit();
    return;
  }

  createWindow();
  createTray();
  registerShortcuts();
  if (!isDev) {
    setupAutoLaunch();
    initUpdater();
    setTimeout(checkForUpdates, 8000);
  }
});

app.on('before-quit', () => { isQuitting = true; });

app.on('will-quit', async (e) => {
  // 更新安装路径 backend 已手动停止；有活进程才拦
  if (backend && backend.child) {
    e.preventDefault();
    await backend.stop();
    app.exit(0);
  }
});

app.on('activate', () => showWindow());
