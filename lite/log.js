'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createLogger({ dir, file = 'lite.log', maxBytes = 512 * 1024, fsImpl = fs, now = Date.now } = {}) {
  const filePath = dir ? path.join(dir, file) : null;

  function write(level, message) {
    const line = `${new Date(now()).toISOString()} [${level}] ${message}`;
    if (level === 'error') console.error(line);
    else console.log(line);
    if (!filePath) return;
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      try {
        if (fsImpl.statSync(filePath).size >= maxBytes) fsImpl.writeFileSync(filePath, '');
      } catch {
        /* 文件尚不存在 */
      }
      fsImpl.appendFileSync(filePath, `${line}\n`);
    } catch (err) {
      console.error(`[lite] 写入日志失败: ${err.message}`);
    }
  }

  return {
    info: (message) => write('info', message),
    error: (message) => write('error', message),
    getFilePath: () => filePath
  };
}

module.exports = { createLogger };
