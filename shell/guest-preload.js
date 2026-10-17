// DeepSeek Harness - Webview Guest Preload (Core Chat & Approval Bridge)
'use strict';

const { ipcRenderer } = require('electron');

let lastNotifyTime = 0;
let observerScheduled = false;

// 1. 扫描 DSH Web 内部真实 DOM 的审批提示
function checkApprovalPrompts() {
  observerScheduled = false;
  if (!document.hidden) return; // 窗口在前台时无需打扰
  const now = Date.now();
  if (now - lastNotifyTime < 8000) return;

  const elements = document.querySelectorAll(
    'button, [role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="confirm"]'
  );
  let needsApproval = false;
  for (const el of elements) {
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
    // 通过 sendToHost 将真实审批事件上报给父级宿主外壳
    ipcRenderer.sendToHost('dsh:needs-approval', {
      title: 'DeepSeek Harness 等待指令审批',
      body: 'AI 智能体正在请求执行工具或 Shell 命令，点击立即返回窗口处理。'
    });
  }
}

const approvalObserver = new MutationObserver(() => {
  if (!observerScheduled) {
    observerScheduled = true;
    setTimeout(checkApprovalPrompts, 300);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    checkApprovalPrompts();
  }
});

window.addEventListener('DOMContentLoaded', () => {
  if (document.body) {
    approvalObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 2. 监听来自宿主外壳的剪贴板投喂消息并精准灌入真实输入框
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
