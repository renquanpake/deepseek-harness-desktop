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

  let isAutoStart = false;
  let autoStartBtn = null;

  const updateStyle = (active) => {
    isAutoStart = Boolean(active);
    if (!autoStartBtn) return;
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

    if (isAutoStart) {
      autoStartBtn.style.cssText = `${baseStyle}; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4);`;
      autoStartBtn.innerHTML = '<span style="font-size:12px">⚡</span><span>自启动: 开</span>';
    } else {
      autoStartBtn.style.cssText = `${baseStyle}; background: rgba(148, 163, 184, 0.12); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.25);`;
      autoStartBtn.innerHTML = '<span style="font-size:12px">⚡</span><span>自启动: 关</span>';
    }
  };

  // Register listener ONCE globally to prevent EventEmitter leaks
  ipcRenderer.on('dsh:auto-start-changed', (_event, enabled) => {
    updateStyle(enabled);
  });

  function mountSidebarAutoStartButton() {
    if (!autoStartBtn) {
      autoStartBtn = document.createElement('div');
      autoStartBtn.id = 'dsh-autostart-toggle';
      autoStartBtn.setAttribute('role', 'button');
      autoStartBtn.setAttribute('tabindex', '0');
      autoStartBtn.title = '点击切换 Windows 开机自动启动';

      autoStartBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const nextState = !isAutoStart;
        const res = await ipcRenderer.invoke('dsh:set-auto-start', nextState);
        updateStyle(res);
      });

      autoStartBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          autoStartBtn.click();
        }
      });

      ipcRenderer.invoke('dsh:get-auto-start').then(updateStyle).catch(() => updateStyle(false));
    }

    const sidebarContainer = document.querySelector(
      'aside, [data-sidebar], .dsh-sidebar, nav, [class*="sidebar"], [class*="Sidebar"]'
    );

    if (sidebarContainer) {
      if (autoStartBtn.parentElement !== sidebarContainer) {
        autoStartBtn.style.position = '';
        autoStartBtn.style.bottom = '';
        autoStartBtn.style.left = '';
        autoStartBtn.style.boxShadow = '';
        autoStartBtn.style.margin = '8px 12px';
        sidebarContainer.appendChild(autoStartBtn);
      }
    } else if (!autoStartBtn.parentElement && document.body) {
      autoStartBtn.style.position = 'fixed';
      autoStartBtn.style.bottom = '16px';
      autoStartBtn.style.left = '16px';
      autoStartBtn.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
      document.body.appendChild(autoStartBtn);
    }
  }

  mountSidebarAutoStartButton();

  let lastNotifyTime = 0;
  let observerScheduled = false;

  const checkApprovalPrompts = () => {
    observerScheduled = false;
    mountSidebarAutoStartButton();

    if (!document.hidden && !isWindowBlurred) return;
    const now = Date.now();
    if (now - lastNotifyTime < 8000) return;

    // Targeted query instead of costly document.body.innerText reflow
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
      setTimeout(checkApprovalPrompts, 300); // 300ms throttle
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
