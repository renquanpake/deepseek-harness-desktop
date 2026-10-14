const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktopShell', {
  getRuntimeInfo: () => ipcRenderer.invoke('dsh:get-runtime-info'),
  switchEngine: (mode) => ipcRenderer.invoke('dsh:switch-engine', mode),
  restartSafeMode: () => ipcRenderer.invoke('dsh:restart-safe-mode'),
  registerContextMenu: () => ipcRenderer.invoke('dsh:register-context-menu'),
  unregisterContextMenu: () => ipcRenderer.invoke('dsh:unregister-context-menu')
});

window.addEventListener('DOMContentLoaded', () => {
  const originalRAF = window.requestAnimationFrame.bind(window);
  let isWindowBlurred = false;
  window.addEventListener('blur', () => { isWindowBlurred = true; });
  window.addEventListener('focus', () => { isWindowBlurred = false; });

  window.requestAnimationFrame = function (callback) {
    if (document.hidden || isWindowBlurred) {
      return window.setTimeout(() => callback(performance.now()), 250);
    }
    return originalRAF(callback);
  };

  let lastNotifyTime = 0;
  const observer = new MutationObserver(() => {
    if (!document.hidden && !isWindowBlurred) return;
    const now = Date.now();
    if (now - lastNotifyTime < 8000) return;
    const bodyText = document.body ? document.body.innerText : '';
    const needsApproval =
      bodyText.includes('Approve') ||
      bodyText.includes('Allow execution') ||
      bodyText.includes('等待审批') ||
      bodyText.includes('允许执行');
    if (needsApproval) {
      lastNotifyTime = now;
      ipcRenderer.send('dsh:native-notify', {
        title: 'DeepSeek Harness 等待指令审批',
        body: '后台 Agent 正在请求执行工具或 Shell 命令，点击立即返回窗口处理。'
      });
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  ipcRenderer.on('dsh:inject-clipboard-text', (_event, text) => {
    if (!text) return;
    const textarea = document.querySelector('textarea');
    if (textarea) {
      textarea.focus();
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set;
      const nextVal = textarea.value ? `${textarea.value}\n\n${text}` : text;
      nativeInputValueSetter.call(textarea, nextVal);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
});
