'use strict';

const { app, BrowserWindow, dialog, Menu } = require('electron');
const os = require('node:os');
const path = require('node:path');

const { createLogger } = require('./log');
const { createLiteBackend } = require('./backend');

const APP_DIR = path.join(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const logger = createLogger({ dir: path.join(DSH_HOME, 'logs') });

let mainWindow = null;
let backend = null;

function isLoopback(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#090a0f',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'splash.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => ({
    action: isLoopback(url) ? 'allow' : 'deny'
  }));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isLoopback(url) || url.startsWith('file://')) return;
    event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    createWindow();

    backend = createLiteBackend({ appDir: APP_DIR, dshHome: DSH_HOME, log: logger });
    try {
      const { url } = await backend.start();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url);
    } catch (error) {
      logger.error(error.message);
      dialog.showErrorBox('DeepSeek Harness 启动失败', error.message);
      app.quit();
    }
  });
}

app.on('before-quit', () => {
  if (backend) backend.stop();
});

app.on('window-all-closed', () => {
  app.quit();
});
