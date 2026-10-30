'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProtocolSetup } = require('../src/protocol-setup');

const BACKEND = 'http://127.0.0.1:3080';

function makeSession() {
  const calls = [];
  return {
    calls,
    defaultSession: {
      webRequest: {
        onHeadersReceived: (handler) => calls.push(handler)
      }
    }
  };
}

function makeProtocol() {
  const handlers = new Map();
  return {
    handlers,
    handle: (scheme, handler) => handlers.set(scheme, handler)
  };
}

function runHeaderHandler(handler, details) {
  let result = null;
  handler(details, (value) => {
    result = value;
  });
  return result;
}

test('backend CSP is installed once and only on the backend main frame', () => {
  const session = makeSession();
  const setup = createProtocolSetup({
    session,
    protocol: makeProtocol(),
    net: { fetch: async () => new Response('') },
    appRoot: process.cwd(),
    isBackendDocument: (url) => url.startsWith(BACKEND),
    getBackendOrigin: () => BACKEND
  });

  assert.strictEqual(setup.installBackendCsp(), true);
  assert.strictEqual(setup.installBackendCsp(), false);
  assert.strictEqual(session.calls.length, 1);

  const handler = session.calls[0];
  const backendDoc = runHeaderHandler(handler, {
    resourceType: 'mainFrame',
    url: `${BACKEND}/workspace`,
    responseHeaders: { 'X-Test': ['1'] }
  });
  assert.match(backendDoc.responseHeaders['Content-Security-Policy'][0], /object-src 'none'/);
  assert.deepStrictEqual(backendDoc.responseHeaders['X-Test'], ['1']);

  const other = runHeaderHandler(handler, {
    resourceType: 'mainFrame',
    url: 'https://evil.example/',
    responseHeaders: {}
  });
  assert.strictEqual(other.responseHeaders['Content-Security-Policy'], undefined);

  const subresource = runHeaderHandler(handler, {
    resourceType: 'script',
    url: `${BACKEND}/app.js`,
    responseHeaders: {}
  });
  assert.strictEqual(subresource.responseHeaders['Content-Security-Policy'], undefined);
});

test('backend CSP keeps a policy already sent by the backend', () => {
  const session = makeSession();
  const setup = createProtocolSetup({
    session,
    protocol: makeProtocol(),
    net: { fetch: async () => new Response('') },
    appRoot: process.cwd(),
    isBackendDocument: () => true,
    getBackendOrigin: () => BACKEND
  });
  setup.installBackendCsp();

  const result = runHeaderHandler(session.calls[0], {
    resourceType: 'mainFrame',
    url: `${BACKEND}/`,
    responseHeaders: { 'content-security-policy': ["default-src 'self'"] }
  });
  const csp = result.responseHeaders['Content-Security-Policy'][0];
  assert.match(csp, /default-src 'self'/);
  assert.strictEqual((csp.match(/object-src/g) || []).length, 1);
});

test('report mode adds a report-only strict policy without tightening enforcement', () => {
  const session = makeSession();
  const setup = createProtocolSetup({
    session,
    protocol: makeProtocol(),
    net: { fetch: async () => new Response('') },
    appRoot: process.cwd(),
    isBackendDocument: () => true,
    getBackendOrigin: () => BACKEND,
    backendCspMode: 'report'
  });
  setup.installBackendCsp();

  const result = runHeaderHandler(session.calls[0], {
    resourceType: 'mainFrame',
    url: `${BACKEND}/`,
    responseHeaders: {}
  });
  const enforced = result.responseHeaders['Content-Security-Policy'][0];
  const reportOnly = result.responseHeaders['Content-Security-Policy-Report-Only'][0];

  assert.match(enforced, /object-src 'none'/);
  assert.doesNotMatch(enforced, /script-src/);
  assert.match(reportOnly, /script-src 'self'/);
  assert.match(reportOnly, new RegExp(`connect-src[^;]*${BACKEND.replace(/[.:]/g, '\\$&')}`));
  assert.match(reportOnly, /ws:/);
});

test('enforce mode sends the strict policy as an additional enforced policy', () => {
  const session = makeSession();
  const setup = createProtocolSetup({
    session,
    protocol: makeProtocol(),
    net: { fetch: async () => new Response('') },
    appRoot: process.cwd(),
    isBackendDocument: () => true,
    getBackendOrigin: () => BACKEND,
    backendCspMode: 'enforce'
  });
  setup.installBackendCsp();

  const result = runHeaderHandler(session.calls[0], {
    resourceType: 'mainFrame',
    url: `${BACKEND}/`,
    responseHeaders: {}
  });
  const policies = result.responseHeaders['Content-Security-Policy'];
  assert.strictEqual(policies.length, 2);
  assert.match(policies[0], /object-src 'none'/);
  assert.match(policies[1], /script-src 'self'/);
  assert.strictEqual(result.responseHeaders['Content-Security-Policy-Report-Only'], undefined);
});

test('off mode keeps only the hardening subset', () => {
  const session = makeSession();
  const setup = createProtocolSetup({
    session,
    protocol: makeProtocol(),
    net: { fetch: async () => new Response('') },
    appRoot: process.cwd(),
    isBackendDocument: () => true,
    getBackendOrigin: () => BACKEND,
    backendCspMode: 'off'
  });
  setup.installBackendCsp();

  const result = runHeaderHandler(session.calls[0], {
    resourceType: 'mainFrame',
    url: `${BACKEND}/`,
    responseHeaders: {}
  });
  assert.strictEqual(result.responseHeaders['Content-Security-Policy-Report-Only'], undefined);
  assert.strictEqual(result.responseHeaders['Content-Security-Policy'].length, 1);
});

test('app protocol is skipped unless explicitly enabled', () => {
  const protocol = makeProtocol();
  const setup = createProtocolSetup({
    session: makeSession(),
    protocol,
    net: { fetch: async () => new Response('') },
    appRoot: process.cwd(),
    appProtocolEnabled: false,
    isBackendDocument: () => false,
    getBackendOrigin: () => BACKEND
  });

  assert.strictEqual(setup.installAppProtocol(), false);
  assert.strictEqual(protocol.handlers.size, 0);
});

test('app protocol serves local splash with a locked CSP', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-protocol-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'splash.html'), '<!doctype html><title>splash</title>');

  const protocol = makeProtocol();
  const setup = createProtocolSetup({
    session: makeSession(),
    protocol,
    net: { fetch: async () => new Response('') },
    appRoot: root,
    appProtocolEnabled: true,
    isBackendDocument: () => false,
    getBackendOrigin: () => BACKEND
  });

  assert.strictEqual(setup.installAppProtocol(), true);
  const handler = protocol.handlers.get('dsh-app');
  assert.strictEqual(typeof handler, 'function');

  const response = await handler({ method: 'GET', url: 'dsh-app://app/splash.html' });
  assert.strictEqual(response.status, 200);
  assert.match(await response.text(), /splash/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
});
