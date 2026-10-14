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

module.exports = { isBackendHttp };
