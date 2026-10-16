'use strict';

const fs = require('fs');
const path = require('path');

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || Number.isNaN(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      return false;
    }
    if (err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function cleanStaleLocks(dirPath, checkPidAlive = isPidAlive) {
  if (!dirPath || !fs.existsSync(dirPath)) return 0;
  let cleanedCount = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        cleanedCount += cleanStaleLocks(fullPath, checkPidAlive);
      } else if (entry.isFile() && entry.name.endsWith('.lock')) {
        let shouldUnlink = false;
        try {
          const content = fs.readFileSync(fullPath, 'utf8').trim();
          const pid = parseInt(content, 10);
          if (!pid || Number.isNaN(pid)) {
            shouldUnlink = true;
          } else if (!checkPidAlive(pid)) {
            shouldUnlink = true;
          }
        } catch {
          shouldUnlink = true;
        }
        if (shouldUnlink) {
          try {
            fs.unlinkSync(fullPath);
            cleanedCount += 1;
          } catch {}
        }
      }
    }
  } catch (err) {
    console.warn('[lock-cleaner] Skip error:', err.message);
  }
  return cleanedCount;
}

module.exports = { cleanStaleLocks, isPidAlive };
