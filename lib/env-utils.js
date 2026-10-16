'use strict';

const net = require('net');

function findAvailablePort(startPort = 3080, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, host, () => {
      server.once('close', () => resolve(startPort));
      server.close();
    });
    server.on('error', () => {
      resolve(findAvailablePort(startPort + 1, host));
    });
  });
}

function prependPathDirs(existingPath, extraDirs, platform = process.platform) {
  const separator = platform === 'win32' ? ';' : ':';
  const parts = String(existingPath || '').split(separator).filter(Boolean);
  const seen = parts.map((item) => (platform === 'win32' ? item.toLowerCase() : item));
  const dirs = Array.isArray(extraDirs) ? extraDirs : [extraDirs].filter(Boolean);

  for (let index = dirs.length - 1; index >= 0; index -= 1) {
    const dir = dirs[index];
    const key = platform === 'win32' ? dir.toLowerCase() : dir;
    if (!seen.includes(key)) {
      parts.unshift(dir);
      seen.unshift(key);
    }
  }
  return parts.join(separator);
}

module.exports = { findAvailablePort, prependPathDirs };
