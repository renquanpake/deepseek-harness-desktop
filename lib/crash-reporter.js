'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_REPORTS = 20;

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || ''
    };
  }
  if (typeof error === 'string') {
    return { name: 'Error', message: error, stack: '' };
  }
  try {
    return { name: 'NonError', message: JSON.stringify(error), stack: '' };
  } catch {
    return { name: 'NonError', message: String(error), stack: '' };
  }
}

function createCrashReporter({
  dir,
  appVersion = 'unknown',
  maxReports = DEFAULT_MAX_REPORTS,
  now = Date.now,
  fsImpl = fs,
  log = console
}) {
  if (!dir) throw new TypeError('dir is required');

  function listReports() {
    try {
      return fsImpl
        .readdirSync(dir)
        .filter((name) => name.startsWith('crash-') && name.endsWith('.json'))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  function prune() {
    for (const name of listReports().slice(maxReports)) {
      try {
        fsImpl.unlinkSync(path.join(dir, name));
      } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
    }
  }

  function capture(kind, error, extra = {}) {
    if (!kind) throw new TypeError('kind is required');
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      const iso = new Date(now()).toISOString();
      const stamp = iso.replace(/[:.]/g, '-');
      const filePath = path.join(dir, `crash-${stamp}-${kind}.json`);
      const payload = {
        kind,
        timestamp: iso,
        appVersion,
        platform: process.platform,
        arch: process.arch,
        error: serializeError(error),
        ...extra
      };
      fsImpl.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
      prune();
      return filePath;
    } catch (err) {
      log.warn(`[crash] 写入崩溃报告失败: ${err.message}`);
      return null;
    }
  }

  function installProcessHooks(target = process, { rethrow } = {}) {
    if (!target || typeof target.once !== 'function') return;

    const fail = typeof rethrow === 'function'
      ? rethrow
      : (error) => {
        if (target === process) process.exitCode = 1;
        setImmediate(() => {
          throw error instanceof Error ? error : new Error(String(error));
        });
      };

    function captureAndCrash(kind, error, emitter, event) {
      const file = capture(kind, error);
      try {
        emitter.removeAllListeners(event);
      } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
      if (file) log.error(`[crash] ${kind} 已记录到 ${file}`);
      fail(error);
    }

    target.once('uncaughtException', (error) => {
      captureAndCrash('uncaught-exception', error, target, 'uncaughtException');
    });

    target.once('unhandledRejection', (reason) => {
      captureAndCrash('unhandled-rejection', reason, target, 'unhandledRejection');
    });
  }

  return { capture, installProcessHooks, listReports, getDir: () => dir };
}

module.exports = { createCrashReporter, serializeError };
