// DeepSeek Harness Desktop - Preload Bridge & Native Integrations
const { contextBridge, ipcRenderer } = require('electron');

const desktopBridge = {
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
};

contextBridge.exposeInMainWorld('dshDesktop', desktopBridge);
contextBridge.exposeInMainWorld('dshDesktopShell', desktopBridge);

// 监听并在后台提示等待审批通知
let lastNotifyTime = 0;
let observerScheduled = false;

function checkApprovalPrompts() {
  observerScheduled = false;
  if (typeof document.hasFocus === 'function' && document.hasFocus() && !document.hidden) {
    return;
  }
  const now = Date.now();
  if (now - lastNotifyTime < 8000) return;

  const elements = document.querySelectorAll(
    'button, [role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="confirm"]'
  );
  let needsApproval = false;
  for (const el of elements) {
    if (!el || el.offsetParent === null) continue;
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
      body: 'AI 智能体正在请求执行工具或 Shell 命令，点击返回处理。'
    });
  }
}

const approvalObserver = new MutationObserver(() => {
  if (!observerScheduled) {
    observerScheduled = true;
    setTimeout(checkApprovalPrompts, 400);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) checkApprovalPrompts();
});

window.addEventListener('blur', () => {
  setTimeout(checkApprovalPrompts, 300);
});

window.addEventListener('DOMContentLoaded', () => {
  if (document.body) {
    approvalObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 截图粘贴转发
  window.addEventListener('paste', (event) => {
    const target = event.target;
    const isEditable = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
    if (!isEditable) return;
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    const hasItems = event.clipboardData && event.clipboardData.items && event.clipboardData.items.length > 0;
    if ((!text || !text.trim()) && hasItems) {
      ipcRenderer.send('dsh:request-clipboard-paste');
    }
  });

  // 接收剪贴板灌入
  ipcRenderer.on('dsh:inject-clipboard-text', (_event, text) => {
    if (!text) return;
    const activeEl = document.activeElement;
    const targetInput =
      activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT' || activeEl.isContentEditable)
        ? activeEl
        : document.querySelector('textarea, [contenteditable="true"], input[type="text"]');

    if (!targetInput) return;

    if (targetInput.isContentEditable) {
      targetInput.focus();
      document.execCommand('insertText', false, text);
    } else {
      targetInput.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      const cur = targetInput.value || '';
      const nextVal = cur ? `${cur}\n\n${text}` : text;
      if (nativeSetter) {
        nativeSetter.call(targetInput, nextVal);
      } else {
        targetInput.value = nextVal;
      }
      targetInput.dispatchEvent(new Event('input', { bubbles: true }));
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
});
