'use strict';

const {
  APP_SCHEME,
  APP_HOST,
  buildCsp,
  buildBackendCsp,
  buildBackendStrictCsp,
  normalizeCspMode,
  createAppProtocolHandler
} = require('../lib/app-protocol');

function createProtocolSetup({
  session,
  protocol,
  net,
  appRoot,
  appProtocolEnabled = false,
  dev = false,
  isBackendDocument,
  getBackendOrigin,
  backendCspMode = 'off',
  log = console
}) {
  const cspMode = normalizeCspMode(backendCspMode);
  let backendCspInstalled = false;

  function installBackendCsp() {
    if (backendCspInstalled) return false;
    backendCspInstalled = true;
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const isWithinBackend = details.resourceType === 'mainFrame'
        && typeof isBackendDocument === 'function'
        && isBackendDocument(details.url);
      if (!isWithinBackend) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      const headers = { ...(details.responseHeaders || {}) };
      const findKey = (name) => Object.keys(headers).find((key) => key.toLowerCase() === name);
      const enforcedKey = findKey('content-security-policy');
      const existingEnforced = enforcedKey ? [].concat(headers[enforcedKey]).join(', ') : '';
      if (enforcedKey) delete headers[enforcedKey];
      headers['Content-Security-Policy'] = [buildBackendCsp(existingEnforced)];

      if (cspMode !== 'off') {
        const origin = typeof getBackendOrigin === 'function' ? getBackendOrigin() : null;
        let strict;
        try {
          strict = buildBackendStrictCsp({ backendOrigin: origin });
        } catch (err) {
          log.warn(`[csp] 构建严格策略失败: ${err.message}`);
          strict = null;
        }
        if (strict) {
          if (cspMode === 'enforce') {
            headers['Content-Security-Policy'] = [buildBackendCsp(existingEnforced), strict];
          } else {
            headers['Content-Security-Policy-Report-Only'] = [strict];
          }
        }
      }
      callback({ responseHeaders: headers });
    });
    return true;
  }

  function installAppProtocol() {
    if (!appProtocolEnabled) return false;
    const origin = typeof getBackendOrigin === 'function' ? getBackendOrigin() : null;
    const csp = buildCsp({ backendOrigin: origin, dev });
    const handler = createAppProtocolHandler({
      protocol,
      net,
      appRoot,
      backendOrigin: origin,
      registerPrivileges: false
    });
    protocol.handle(APP_SCHEME, async (request) => {
      const response = await handler(request);
      const headers = new Headers(response.headers);
      headers.set('content-security-policy', csp);
      const hasBody = request.method !== 'HEAD' && response.body !== null;
      return new Response(hasBody ? response.body : null, {
        status: response.status,
        statusText: response.statusText || '',
        headers
      });
    });
    if (log && typeof log.info === 'function') {
      log.info(`[protocol] registered ${APP_SCHEME}://${APP_HOST}`);
    }
    return true;
  }

  return { installBackendCsp, installAppProtocol, cspMode };
}

module.exports = { createProtocolSetup };
