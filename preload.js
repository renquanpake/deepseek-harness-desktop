const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktopShell', {
  getRuntimeInfo: () => ipcRenderer.invoke('dsh:get-runtime-info'),
  switchEngine: (mode) => ipcRenderer.invoke('dsh:switch-engine', mode),
  restartSafeMode: () => ipcRenderer.invoke('dsh:restart-safe-mode'),
  registerContextMenu: () => ipcRenderer.invoke('dsh:register-context-menu'),
  unregisterContextMenu: () => ipcRenderer.invoke('dsh:unregister-context-menu'),
  getWorkspaceStatus: () => ipcRenderer.invoke('dsh:get-workspace-status'),
  requestClipboardPaste: () => ipcRenderer.send('dsh:request-clipboard-paste'),
  convertToWslPath: (windowsPath) => ipcRenderer.invoke('dsh:convert-to-wsl-path', windowsPath),
  getAutoStart: () => ipcRenderer.invoke('dsh:get-auto-start'),
  setAutoStart: (enable) => ipcRenderer.invoke('dsh:set-auto-start', enable),
  onAutoStartChanged: (callback) => {
    if (typeof callback === 'function') {
      ipcRenderer.on('dsh:auto-start-changed', (_event, enabled) => callback(enabled));
    }
  }
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

  function mountSidebarAutoStartButton() {
    if (document.getElementById('dsh-autostart-toggle')) return;

    const btn = document.createElement('div');
    btn.id = 'dsh-autostart-toggle';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.title = '点击切换 Windows 开机自动启动';

    const baseStyle = [
      'display: inline-flex',
      'align-items: center',
      'gap: 6px',
      'padding: 5px 10px',
      'border-radius: 14px',
      'font-size: 11px',
      'font-weight: 500',
      'cursor: pointer',
      'user-select: none',
      'transition: all 0.2s ease',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'z-index: 9999'
    ].join(';');

    let isAutoStart = false;

    const updateStyle = (active) => {
      isAutoStart = Boolean(active);
      if (isAutoStart) {
        btn.style.cssText = `${baseStyle}; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4);`;
        btn.innerHTML = '<span style="font-size:12px">⚡</span><span>自启动: 开</span>';
      } else {
        btn.style.cssText = `${baseStyle}; background: rgba(148, 163, 184, 0.12); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.25);`;
        btn.innerHTML = '<span style="font-size:12px">⚡</span><span>自启动: 关</span>';
      }
    };

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const nextState = !isAutoStart;
      const res = await ipcRenderer.invoke('dsh:set-auto-start', nextState);
      updateStyle(res);
    });

    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        btn.click();
      }
    });

    ipcRenderer.invoke('dsh:get-auto-start').then(updateStyle).catch(() => updateStyle(false));

    ipcRenderer.on('dsh:auto-start-changed', (_event, enabled) => {
      updateStyle(enabled);
    });

    const sidebarContainer = document.querySelector('aside, [data-sidebar], .dsh-sidebar, nav, [class*="sidebar"], [class*="Sidebar"]');
    if (sidebarContainer) {
      btn.style.margin = '8px 12px';
      sidebarContainer.appendChild(btn);
    } else if (document.body) {
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.left = '16px';
      btn.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
      document.body.appendChild(btn);
    }
  }

  mountSidebarAutoStartButton();

  let lastNotifyTime = 0;
  const observer = new MutationObserver(() => {
    if (!document.getElementById('dsh-autostart-toggle')) {
      mountSidebarAutoStartButton();
    }

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

  let lastClipboardPasteRequest = 0;
  window.addEventListener('paste', (event) => {
    const now = Date.now();
    if (now - lastClipboardPasteRequest < 800) return;
    const target = event.target;
    const isEditableTarget =
      target &&
      (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
    if (!isEditableTarget) return;
    const pastedText = event.clipboardData ? event.clipboardData.getData('text') : '';
    if (pastedText && pastedText.trim()) return;
    lastClipboardPasteRequest = now;
    ipcRenderer.send('dsh:request-clipboard-paste');
  });

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
