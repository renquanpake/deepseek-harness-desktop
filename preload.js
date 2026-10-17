const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktopShell', {
  getRuntimeInfo: () => ipcRenderer.invoke('dsh:get-runtime-info'),
  getBackendStatus: () => ipcRenderer.invoke('dsh:get-backend-status'),
  switchEngine: (mode) => ipcRenderer.invoke('dsh:switch-engine', mode),
  restartSafeMode: () => ipcRenderer.invoke('dsh:restart-safe-mode'),
  registerContextMenu: () => ipcRenderer.invoke('dsh:register-context-menu'),
  unregisterContextMenu: () => ipcRenderer.invoke('dsh:unregister-context-menu'),
  getWorkspaceStatus: () => ipcRenderer.invoke('dsh:get-workspace-status'),
  requestClipboardPaste: () => ipcRenderer.send('dsh:request-clipboard-paste'),
  convertToWslPath: (windowsPath) => ipcRenderer.invoke('dsh:convert-to-wsl-path', windowsPath),
  getAutoStart: () => ipcRenderer.invoke('dsh:get-auto-start'),
  setAutoStart: (enable) => ipcRenderer.invoke('dsh:set-auto-start', enable),
  setAlwaysOnTop: (enable) => ipcRenderer.invoke('dsh:set-always-on-top', enable),
  getPluginInventory: () => ipcRenderer.invoke('dsh:get-plugin-inventory'),
  rehydratePlugins: () => ipcRenderer.invoke('dsh:rehydrate-plugins'),
  createWorktreeDialog: () => ipcRenderer.invoke('dsh:create-worktree-dialog'),
  checkUpdate: () => ipcRenderer.invoke('dsh:check-update'),
  runSelfRepair: () => ipcRenderer.invoke('dsh:run-self-repair'),
  nativeNotify: (payload) => ipcRenderer.send('dsh:native-notify', payload),

  onAutoStartChanged: (callback) => {
    if (typeof callback === 'function') {
      ipcRenderer.on('dsh:auto-start-changed', (_event, enabled) => callback(enabled));
    }
  },
  onBackendReady: (callback) => {
    if (typeof callback === 'function') {
      ipcRenderer.on('dsh:backend-ready', (_event, url, port) => callback(url, port));
    }
  },
  onRuntimeLog: (callback) => {
    if (typeof callback === 'function') {
      ipcRenderer.on('dsh:runtime-log', (_event, logLine) => callback(logLine));
    }
  },
  onInjectClipboard: (callback) => {
    if (typeof callback === 'function') {
      ipcRenderer.on('dsh:inject-clipboard-text', (_event, text) => callback(text));
    }
  }
});
