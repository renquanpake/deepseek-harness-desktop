'use strict';

const path = require('node:path');

function createWindowFactory({
  BrowserWindow,
  shell,
  appRoot,
  preloadPath,
  appScheme,
  appHost,
  appProtocolEnabled = false,
  isBackendHttp,
  isAppUrl,
  isAllowedFileUrl = () => false,
  getPort,
  getWorkspaceDir,
  isHiddenLaunch = () => false,
  beforeLoad = () => {},
  onLoadFailure = () => {},
  onLoadReady = () => {},
  onCloseRequest = () => {},
  onRendererGone = () => {}
}) {
  function openExternal(url) {
    try {
      const result = shell.openExternal(url);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
  }

  function create() {
    const isWindows = process.platform === 'win32';
    const window = new BrowserWindow({
      show: !isHiddenLaunch(),
      width: 1440,
      height: 920,
      minWidth: 960,
      minHeight: 640,
      title: `DeepSeek Harness Studio — ${getWorkspaceDir()}`,
      autoHideMenuBar: true,
      titleBarStyle: isWindows ? 'hidden' : 'default',
      titleBarOverlay: isWindows ? {
        color: '#18181b',
        symbolColor: '#a1a1aa',
        height: 38
      } : undefined,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false
      }
    });

    beforeLoad(window);

    if (appProtocolEnabled) {
      window.loadURL(`${appScheme}://${appHost}/splash.html`);
    } else {
      window.loadFile(path.join(appRoot, 'splash.html'));
    }

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isBackendHttp(url, getPort())) {
        return { action: 'allow' };
      }
      openExternal(url);
      return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, url) => {
      if (isBackendHttp(url, getPort()) || isAppUrl(url) || isAllowedFileUrl(url)) return;
      event.preventDefault();
      openExternal(url);
    });

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
      if (validatedUrl === 'about:blank' || (validatedUrl && validatedUrl.endsWith('splash.html'))) return;
      onLoadFailure(errorCode, errorDescription);
    });

    window.webContents.on('dom-ready', () => {
      onLoadReady();
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      onRendererGone(details);
    });

    window.on('close', (event) => {
      onCloseRequest(event, window);
    });

    return window;
  }

  return create;
}

module.exports = { createWindowFactory };
