'use strict';

const CSP_PATTERN = /content security policy|\bcsp\b/i;
const MAX_MESSAGE_LENGTH = 500;

function isCspViolationMessage(message) {
  return typeof message === 'string' && CSP_PATTERN.test(message);
}

function createCspViolationSink({
  append,
  throttleMs = 10_000,
  now = Date.now,
  log = console
} = {}) {
  const lastSeen = new Map();

  function report(message) {
    if (!isCspViolationMessage(message)) return false;
    const trimmed = message.slice(0, MAX_MESSAGE_LENGTH);
    const timestamp = now();
    const previous = lastSeen.get(trimmed);
    if (previous !== undefined && timestamp - previous < throttleMs) return false;
    lastSeen.set(trimmed, timestamp);

    if (lastSeen.size > 200) {
      for (const [key, seenAt] of lastSeen) {
        if (timestamp - seenAt >= throttleMs) lastSeen.delete(key);
      }
    }

    try {
      if (typeof append === 'function') {
        append(trimmed);
      } else {
        log.warn(`[csp] ${trimmed}`);
      }
    } catch (err) {
      log.warn(`[csp] 记录 CSP 违规失败: ${err.message}`);
    }
    return true;
  }

  return { report };
}

module.exports = { isCspViolationMessage, createCspViolationSink, MAX_MESSAGE_LENGTH };
