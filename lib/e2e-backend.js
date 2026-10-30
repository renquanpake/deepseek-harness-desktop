'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isEnabled(env) {
  return /^(1|true|yes)$/i.test(String((env && env.DSH_E2E) || ''));
}

function getE2eBackendUrl(env = process.env) {
  if (!isEnabled(env)) return null;
  const raw = env && env.DSH_E2E_BACKEND_URL;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return parsed.href;
}

module.exports = { getE2eBackendUrl, LOOPBACK_HOSTS };
