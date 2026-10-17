'use strict';

function isBackendHttp(rawUrl, port) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
  return parsed.port === '' || parsed.port === String(port);
}

function isTrustedSender(event, port, mainWindowInstance = null) {
  if (!event) return false;
  // 1. 本地原生桌面外壳主窗口实例
  if (mainWindowInstance && event.sender && event.sender === mainWindowInstance.webContents) {
    return true;
  }
  // 2. 本地原生外壳的 file:// 协议地址 (shell/index.html)
  const frameUrl = event.senderFrame ? event.senderFrame.url : (typeof event.url === 'string' ? event.url : '');
  if (typeof frameUrl === 'string' && frameUrl.startsWith('file://')) {
    const normalized = frameUrl.replace(/\\/g, '/');
    if (normalized.endsWith('/shell/index.html') || normalized.includes('/shell/index.html')) {
      return true;
    }
  }
  // 3. 受信任的本地 127.0.0.1 或 localhost 后端页面
  if (isBackendHttp(frameUrl, port)) {
    return true;
  }
  return false;
}

module.exports = { isBackendHttp, isTrustedSender };
