'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_ARCHIVES = 3;

function createOperationLog({
  dir,
  file = 'operations.jsonl',
  maxBytes = DEFAULT_MAX_BYTES,
  maxArchives = DEFAULT_MAX_ARCHIVES,
  now = Date.now,
  fsImpl = fs,
  log = console
}) {
  if (!dir) throw new TypeError('dir is required');
  const filePath = path.join(dir, file);

  function ensureDir() {
    fsImpl.mkdirSync(dir, { recursive: true });
  }

  function rotate() {
    for (let index = maxArchives - 1; index >= 1; index -= 1) {
      const from = `${filePath}.${index}`;
      const to = `${filePath}.${index + 1}`;
      try {
        if (fsImpl.existsSync(from)) fsImpl.renameSync(from, to);
      } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
    }
    try {
      if (fsImpl.existsSync(filePath)) fsImpl.renameSync(filePath, `${filePath}.1`);
    } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
  }

  function rotateIfNeeded() {
    try {
      const stat = fsImpl.statSync(filePath);
      if (stat.size >= maxBytes) rotate();
    } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
  }

  function append(type, data = {}) {
    if (!type) throw new TypeError('type is required');
    ensureDir();
    rotateIfNeeded();
    const entry = { ts: new Date(now()).toISOString(), type, ...data };
    try {
      fsImpl.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      log.warn(`[operation-log] 写入失败: ${err.message}`);
    }
    return entry;
  }

  function read(limit = 100) {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    let raw = '';
    try {
      raw = fsImpl.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }
    const entries = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
    }
    return entries.slice(-limit);
  }

  return { append, read, rotate, getFilePath: () => filePath, getDir: () => dir };
}

module.exports = { createOperationLog };
