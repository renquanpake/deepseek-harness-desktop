'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

function isBackendHttp(rawUrl, port) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
  // HTTP default port is 80. Only match if effective port matches expected port.
  const effectivePort = parsed.port || '80';
  return effectivePort === String(port);
}

function isTrustedSender(event, port, mainWindowInstance = null) {
  if (!event) return false;
  // 1. 本地原生桌面外壳主窗口实例
  if (mainWindowInstance && event.sender && event.sender === mainWindowInstance.webContents) {
    return true;
  }
  // 2. 本地原生外壳的 file:// 协议地址 (严格全等路径校验，杜绝子串混淆)
  const frameUrl = event.senderFrame ? event.senderFrame.url : (typeof event.url === 'string' ? event.url : '');
  if (typeof frameUrl === 'string' && frameUrl.startsWith('file://')) {
    try {
      const filePath = fileURLToPath(frameUrl);
      const expectedShellPath = path.resolve(__dirname, '..', 'shell', 'index.html');
      if (path.resolve(filePath) === expectedShellPath) {
        return true;
      }
    } catch {}
  }
  // 3. 受信任的本地 127.0.0.1 或 localhost 后端页面
  if (isBackendHttp(frameUrl, port)) {
    return true;
  }
  return false;
}

module.exports = { isBackendHttp, isTrustedSender };
