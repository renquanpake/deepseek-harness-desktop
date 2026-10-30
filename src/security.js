'use strict';

const AUDIO_PERMISSION = 'media';

function isAudioOnlyRequest(details) {
  const types = details && details.mediaTypes;
  if (!Array.isArray(types) || types.length === 0) return false;
  return types.every((type) => String(type).toLowerCase() === 'audio');
}

function createSessionSecurity({ getAllowedOrigin, log = console }) {
  function allowedOrigin() {
    const raw = typeof getAllowedOrigin === 'function' ? getAllowedOrigin() : getAllowedOrigin;
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }

  function isAllowedUrl(rawUrl) {
    const origin = allowedOrigin();
    if (!origin || !rawUrl) return false;
    try {
      return new URL(rawUrl).origin === origin;
    } catch {
      return false;
    }
  }

  function isPrimaryDocument(contents) {
    if (!contents || typeof contents.getType !== 'function') return false;
    if (contents.getType() !== 'window') return false;
    const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
    return isAllowedUrl(url);
  }

  function install(targetSession) {
    if (!targetSession) throw new TypeError('session is required');

    targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const granted = permission === AUDIO_PERMISSION
        && isPrimaryDocument(contents)
        && isAudioOnlyRequest(details);
      if (!granted) {
        log.warn(`[security] denied permission request: ${permission}`);
      }
      callback(Boolean(granted));
    });

    targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
      if (permission !== AUDIO_PERMISSION) return false;
      if (requestingOrigin && !isAllowedUrl(requestingOrigin)) return false;
      return isPrimaryDocument(contents);
    });
  }

  return { install, isPrimaryDocument, isAllowedUrl, allowedOrigin };
}

function hardenWebContents(contents, { log = console } = {}) {
  if (!contents || typeof contents.on !== 'function') return;
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log.warn('[security] blocked webview attach');
  });
}

module.exports = { createSessionSecurity, hardenWebContents, isAudioOnlyRequest };
