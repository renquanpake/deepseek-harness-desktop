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
  }
});

// Inner DSH clipboard and approval events
window.addEventListener('DOMContentLoaded', () => {
  let lastNotifyTime = 0;
  let observerScheduled = false;

  const checkApprovalPrompts = () => {
    observerScheduled = false;
    if (!document.hidden) return;
    const now = Date.now();
    if (now - lastNotifyTime < 8000) return;

    const modalOrButtons = document.querySelectorAll(
      'button, [role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="confirm"]'
    );
    let needsApproval = false;
    for (const el of modalOrButtons) {
      const text = el.textContent || '';
      if (
        text.includes('Approve') ||
        text.includes('Allow execution') ||
        text.includes('等待审批') ||
        text.includes('允许执行')
      ) {
        needsApproval = true;
        break;
      }
    }

    if (needsApproval) {
      lastNotifyTime = now;
      ipcRenderer.send('dsh:native-notify', {
        title: 'DeepSeek Harness 等待指令审批',
        body: '后台 Agent 正在请求执行工具或 Shell 命令，点击立即返回窗口处理。'
      });
    }
  };

  const observer = new MutationObserver(() => {
    if (!observerScheduled) {
      observerScheduled = true;
      setTimeout(checkApprovalPrompts, 300);
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener('paste', (event) => {
    const target = event.target;
    const isEditable = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
    if (!isEditable) return;
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    if (!text || !text.trim()) {
      ipcRenderer.send('dsh:request-clipboard-paste');
    }
  });

  ipcRenderer.on('dsh:inject-clipboard-text', (_event, text) => {
    if (!text) return;
    const textarea = document.querySelector('textarea');
    if (textarea) {
      textarea.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      const nextVal = textarea.value ? `${textarea.value}\n\n${text}` : text;
      nativeSetter.call(textarea, nextVal);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
});
