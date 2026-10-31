'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EVENTS = new Set([
  'check-start',
  'check-done',
  'install-start',
  'verify-ok',
  'verify-failed',
  'promote',
  'restore',
  'factory-fallback'
]);

const ALLOWED_FIELDS = new Set(['version', 'reason']);
const MAX_REASON_LENGTH = 160;
const DEFAULT_FILE = 'update-journal.jsonl';

function createUpdateJournal({
  dir,
  file = DEFAULT_FILE,
  now = Date.now,
  fsImpl = fs,
  log = console
}) {
  if (!dir) throw new TypeError('dir is required');
  const filePath = path.join(dir, file);
  let sequence = 0;

  function record(event, fields = {}) {
    if (!EVENTS.has(event)) throw new TypeError(`unknown update event: ${event}`);
    const entry = {
      seq: sequence++,
      at: new Date(now()).toISOString(),
      event
    };
    for (const [key, value] of Object.entries(fields || {})) {
      if (!ALLOWED_FIELDS.has(key) || value === undefined || value === null) continue;
      entry[key] = key === 'reason' ? String(value).slice(0, MAX_REASON_LENGTH) : String(value);
    }
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      fsImpl.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { flush: true });
    } catch (err) {
      log.warn(`[update-journal] 写入失败: ${err.message}`);
    }
    return entry;
  }

  function read(limit = 200) {
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
        /* 跳过损坏行 */
      }
    }
    return entries.slice(-limit);
  }

  function last() {
    const entries = read(1);
    return entries.length ? entries[0] : null;
  }

  function isInterrupted() {
    const entry = last();
    if (!entry) return false;
    return entry.event === 'install-start' || entry.event === 'verify-ok';
  }

  return { record, read, last, isInterrupted, getFilePath: () => filePath, getDir: () => dir };
}

function markInterruptedRuntime({ runtimeDir, fsImpl = fs, log = console }) {
  if (!runtimeDir) throw new TypeError('runtimeDir is required');
  const markerPath = path.join(runtimeDir, '.broken-marker.json');
  try {
    if (!fsImpl.existsSync(runtimeDir)) return false;
    fsImpl.writeFileSync(
      markerPath,
      `${JSON.stringify({
        brokenVersion: null,
        reason: 'interrupted-update',
        at: new Date().toISOString()
      }, null, 2)}\n`
    );
    log.warn('[update-journal] 检测到未完成的更新，已标记本机内核为不可用');
    return true;
  } catch (err) {
    log.warn(`[update-journal] 标记中断内核失败: ${err.message}`);
    return false;
  }
}

module.exports = { EVENTS, MAX_REASON_LENGTH, createUpdateJournal, markInterruptedRuntime };
