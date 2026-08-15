// preload: 暴露安全的 IPC 桥给页面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  getBackendStatus: () => ipcRenderer.invoke('backend:status'),
  restartBackend: () => ipcRenderer.invoke('backend:restart'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  onBackendStatus: (cb) => {
    const h = (_e, status, url) => cb(status, url);
    ipcRenderer.on('backend-status', h);
    return () => ipcRenderer.removeListener('backend-status', h);
  },
  onThemeChanged: (cb) => {
    const h = (_e, mode) => cb(mode);
    ipcRenderer.on('theme-changed', h);
    return () => ipcRenderer.removeListener('theme-changed', h);
  },
});
