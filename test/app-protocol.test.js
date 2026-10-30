'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  APP_SCHEME,
  SCHEME_PRIVILEGES,
  mimeFor,
  buildCsp,
  buildBackendCsp,
  isAppUrl,
  resolveAppRequest,
  registerAppSchemePrivileges,
  createAppProtocolHandler
} = require('../lib/app-protocol');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-app-protocol-'));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("app");');
  fs.writeFileSync(path.join(root, 'assets', 'app.css'), 'body { color: #fff; }');
  fs.writeFileSync(path.join(root, 'assets', 'app.json'), '{"ok":true}');
  fs.writeFileSync(path.join(root, 'docs', 'index.html'), '<title>docs</title>');
  fs.writeFileSync(path.join(root, 'assets', 'logo.svg'), '<svg></svg>');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeFakeProtocol() {
  const calls = { privileges: [], handles: [] };
  return {
    calls,
    registerSchemesAsPrivileged(list) {
      calls.privileges.push(list);
    },
    handle(scheme, handler) {
      calls.handles.push({ scheme, handler });
    }
  };
}

test('resolveAppRequest: resolves a regular file under appRoot', () => {
  const appRoot = path.resolve('/tmp/dsh-app-root');
  const result = resolveAppRequest('dsh-app://app/assets/app.js', { appRoot });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.filePath, path.join(appRoot, 'assets', 'app.js'));
  assert.strictEqual(result.mime, 'text/javascript; charset=utf-8');
  assert.strictEqual(result.status, 200);
});

test('resolveAppRequest: falls back to index.html for root and directory requests', () => {
  const appRoot = path.resolve('/tmp/dsh-app-root');

  const root = resolveAppRequest('dsh-app://app/', { appRoot });
  assert.strictEqual(root.ok, true);
  assert.strictEqual(root.filePath, path.join(appRoot, 'index.html'));

  const trailing = resolveAppRequest('dsh-app://app/docs/', { appRoot });
  assert.strictEqual(trailing.ok, true);
  assert.strictEqual(trailing.filePath, path.join(appRoot, 'docs', 'index.html'));

  const extensionless = resolveAppRequest('dsh-app://app/docs', { appRoot });
  assert.strictEqual(extensionless.ok, true);
  assert.strictEqual(extensionless.filePath, path.join(appRoot, 'docs', 'index.html'));
});

test('resolveAppRequest: rejects lexical and encoded path traversal', () => {
  const appRoot = path.resolve('/tmp/dsh-app-root');
  const attacks = [
    'dsh-app://app/../secret',
    'dsh-app://app/../../etc/passwd',
    'dsh-app://app/%2e%2e/secret',
    'dsh-app://app/..%2Fsecret',
    'dsh-app://app/%2e%2e%2fsecret',
    'dsh-app://app/assets/%2e%2e/%2e%2e/secret',
    'dsh-app://app/..%5Csecret',
    'dsh-app://app/%252e%252e%252fsecret',
    'dsh-app://app/%252e%252e/secret'
  ];

  for (const url of attacks) {
    const result = resolveAppRequest(url, { appRoot });
    assert.strictEqual(result.ok, false, url);
    assert.strictEqual(result.status, 403, url);
  }
});

test('resolveAppRequest: rejects absolute paths and Windows drive paths', () => {
  const appRoot = path.resolve('/tmp/dsh-app-root');
  const attacks = [
    'dsh-app://app//etc/passwd',
    'dsh-app://app/%2Fetc%2Fpasswd',
    'dsh-app://app/C:%5CWindows%5Cwin.ini',
    'dsh-app://app/C:/Windows/win.ini'
  ];

  for (const url of attacks) {
    const result = resolveAppRequest(url, { appRoot });
    assert.strictEqual(result.ok, false, url);
    assert.strictEqual(result.status, 403, url);
  }
});

test('resolveAppRequest: ignores query and fragment when resolving the path', () => {
  const appRoot = path.resolve('/tmp/dsh-app-root');

  const withQuery = resolveAppRequest('dsh-app://app/index.html?next=../secret', { appRoot });
  assert.strictEqual(withQuery.ok, true);
  assert.strictEqual(withQuery.filePath, path.join(appRoot, 'index.html'));

  const withFragment = resolveAppRequest('dsh-app://app/index.html#/../secret', { appRoot });
  assert.strictEqual(withFragment.ok, true);
  assert.strictEqual(withFragment.filePath, path.join(appRoot, 'index.html'));
});

test('resolveAppRequest: rejects invalid scheme, host, credentials, encoding, and null bytes', () => {
  const appRoot = path.resolve('/tmp/dsh-app-root');

  assert.strictEqual(resolveAppRequest('https://app/index.html', { appRoot }).status, 400);
  assert.strictEqual(resolveAppRequest('dsh-app://evil/index.html', { appRoot }).status, 403);
  assert.strictEqual(resolveAppRequest('dsh-app://app.evil/index.html', { appRoot }).status, 403);
  assert.strictEqual(resolveAppRequest('dsh-app://user:pass@app/index.html', { appRoot }).status, 403);
  assert.strictEqual(resolveAppRequest('dsh-app://app:1234/index.html', { appRoot }).status, 403);
  assert.strictEqual(resolveAppRequest('dsh-app://app/%E0%A4%A', { appRoot }).status, 400);
  assert.strictEqual(resolveAppRequest('dsh-app://app/%00index.html', { appRoot }).status, 400);
  assert.strictEqual(resolveAppRequest('not a url', { appRoot }).status, 400);
  assert.strictEqual(resolveAppRequest('', { appRoot }).status, 400);
  assert.strictEqual(resolveAppRequest('dsh-app://app/index.html', {}).status, 400);
});

test('mimeFor: covers required static asset types', () => {
  assert.strictEqual(mimeFor('/x/index.html'), 'text/html; charset=utf-8');
  assert.strictEqual(mimeFor('/x/app.js'), 'text/javascript; charset=utf-8');
  assert.strictEqual(mimeFor('/x/app.css'), 'text/css; charset=utf-8');
  assert.strictEqual(mimeFor('/x/data.json'), 'application/json; charset=utf-8');
  assert.strictEqual(mimeFor('/x/logo.svg'), 'image/svg+xml');
  assert.strictEqual(mimeFor('/x/icon.png'), 'image/png');
  assert.strictEqual(mimeFor('/x/favicon.ico'), 'image/x-icon');
  assert.strictEqual(mimeFor('/x/font.woff2'), 'font/woff2');
  assert.strictEqual(mimeFor('/x/app.js.map'), 'application/json; charset=utf-8');
  assert.strictEqual(mimeFor('/x/FONT.WOFF2'), 'font/woff2');
  assert.strictEqual(mimeFor('/x/archive.bin'), 'application/octet-stream');
});

test('buildCsp: locks scripts and frames, and limits connect-src to self plus backend', () => {
  const csp = buildCsp({ backendOrigin: 'http://127.0.0.1:3080/' });

  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:3080/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test('buildCsp: omits backend origin when unset and relaxes eval only in dev', () => {
  const plain = buildCsp();
  assert.match(plain, /connect-src 'self'(;|$)/);
  assert.doesNotMatch(plain, /unsafe-eval/);

  const dev = buildCsp({ backendOrigin: 'http://127.0.0.1:3080', dev: true });
  assert.match(dev, /script-src 'self' 'unsafe-eval'/);
  assert.match(dev, /connect-src 'self' http:\/\/127\.0\.0\.1:3080 ws:\/\/127\.0\.0\.1:3080/);

  assert.throws(() => buildCsp({ backendOrigin: 'file:///etc/passwd' }), TypeError);
  assert.throws(() => buildCsp({ backendOrigin: 'not-a-url' }), TypeError);
});

test('buildBackendCsp: hardens object, base and framing without touching script or style sources', () => {
  const csp = buildBackendCsp();
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.doesNotMatch(csp, /style-src/);
  assert.doesNotMatch(csp, /connect-src/);
});

test('buildBackendCsp: preserves backend-sent directives without duplicating them', () => {
  const csp = buildBackendCsp("default-src 'self'; object-src 'none'");
  assert.match(csp, /default-src 'self'/);
  assert.strictEqual((csp.match(/object-src/g) || []).length, 1);
});

test('isAppUrl: accepts only dsh-app://app origins', () => {
  assert.strictEqual(isAppUrl('dsh-app://app'), true);
  assert.strictEqual(isAppUrl('dsh-app://app/'), true);
  assert.strictEqual(isAppUrl('dsh-app://app/index.html?x=1#y'), true);
  assert.strictEqual(isAppUrl('DSH-APP://APP/index.html'), true);

  assert.strictEqual(isAppUrl('dsh-app://evil/index.html'), false);
  assert.strictEqual(isAppUrl('dsh-app://app.evil/index.html'), false);
  assert.strictEqual(isAppUrl('dsh-app://app:1234/index.html'), false);
  assert.strictEqual(isAppUrl('dsh-app://user:pass@app/index.html'), false);
  assert.strictEqual(isAppUrl('http://127.0.0.1:3080/'), false);
  assert.strictEqual(isAppUrl('file:///index.html'), false);
  assert.strictEqual(isAppUrl(''), false);
  assert.strictEqual(isAppUrl(null), false);
});

test('registerAppSchemePrivileges: registers standard secure fetch-enabled scheme', () => {
  const protocol = makeFakeProtocol();
  registerAppSchemePrivileges(protocol);

  assert.strictEqual(protocol.calls.privileges.length, 1);
  assert.deepStrictEqual(protocol.calls.privileges[0], [
    { scheme: APP_SCHEME, privileges: { ...SCHEME_PRIVILEGES } }
  ]);
  assert.strictEqual(SCHEME_PRIVILEGES.standard, true);
  assert.strictEqual(SCHEME_PRIVILEGES.secure, true);
  assert.strictEqual(SCHEME_PRIVILEGES.supportFetchAPI, true);
  assert.strictEqual(SCHEME_PRIVILEGES.corsEnabled, true);
});

test('createAppProtocolHandler: registers handler and serves a static file', async (t) => {
  const appRoot = makeFixture(t);
  const protocol = makeFakeProtocol();
  const net = { fetch: async () => { throw new Error('net.fetch must not be used for static assets'); } };

  const handler = createAppProtocolHandler({
    protocol,
    net,
    appRoot,
    backendOrigin: 'http://127.0.0.1:3080'
  });

  assert.strictEqual(protocol.calls.privileges.length, 1);
  assert.strictEqual(protocol.calls.handles.length, 1);
  assert.strictEqual(protocol.calls.handles[0].scheme, APP_SCHEME);
  assert.strictEqual(protocol.calls.handles[0].handler, handler);

  const response = await handler({ url: 'dsh-app://app/assets/app.js', method: 'GET' });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(await response.text(), 'console.log("app");');
});

test('createAppProtocolHandler: can skip privilege registration for Electron lifecycle split', () => {
  const protocol = makeFakeProtocol();
  createAppProtocolHandler({
    protocol,
    net: { fetch: async () => new Response('') },
    appRoot: path.resolve('/tmp/dsh-app-root'),
    registerPrivileges: false
  });

  assert.strictEqual(protocol.calls.privileges.length, 0);
  assert.strictEqual(protocol.calls.handles.length, 1);
});

test('createAppProtocolHandler: serves directory index and rejects missing files and methods', async (t) => {
  const appRoot = makeFixture(t);
  const protocol = makeFakeProtocol();
  const handler = createAppProtocolHandler({
    protocol,
    net: { fetch: async () => new Response('') },
    appRoot
  });

  const index = await handler({ url: 'dsh-app://app/', method: 'GET' });
  assert.strictEqual(index.status, 200);
  assert.strictEqual(await index.text(), '<!doctype html><title>app</title>');

  const docs = await handler({ url: 'dsh-app://app/docs/', method: 'GET' });
  assert.strictEqual(docs.status, 200);
  assert.strictEqual(await docs.text(), '<title>docs</title>');

  const missing = await handler({ url: 'dsh-app://app/missing.js', method: 'GET' });
  assert.strictEqual(missing.status, 404);

  const badMethod = await handler({ url: 'dsh-app://app/index.html', method: 'POST' });
  assert.strictEqual(badMethod.status, 405);

  const badHost = await handler({ url: 'http://127.0.0.1:3080/index.html', method: 'GET' });
  assert.strictEqual(badHost.status, 403);
});

test('createAppProtocolHandler: serves static content from an injected fs without realpath', async () => {
  const handler = createAppProtocolHandler({
    protocol: makeFakeProtocol(),
    net: { fetch: async () => new Response('') },
    appRoot: path.resolve('/fake/app-root'),
    fsImpl: {
      promises: {
        readFile: async (target) => Buffer.from(`served:${path.basename(target)}`)
      }
    }
  });

  const response = await handler({ url: 'dsh-app://app/assets/app.js', method: 'GET' });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(await response.text(), 'served:app.js');
});

test('createAppProtocolHandler: blocks symlink escape outside appRoot', async (t) => {
  const appRoot = makeFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-app-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(appRoot, 'leak.txt'), 'file');
  } catch {
    return;
  }

  const handler = createAppProtocolHandler({
    protocol: makeFakeProtocol(),
    net: { fetch: async () => new Response('') },
    appRoot
  });

  const response = await handler({ url: 'dsh-app://app/leak.txt', method: 'GET' });
  assert.strictEqual(response.status, 403);
});

test('createAppProtocolHandler: proxies /api to backend and passes status and content-type through', async (t) => {
  const appRoot = makeFixture(t);
  const captured = [];
  const net = {
    fetch: async (url, init) => {
      captured.push({ url, init });
      return new Response('{"ok":true}', {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'a=b' }
      });
    }
  };

  const handler = createAppProtocolHandler({
    protocol: makeFakeProtocol(),
    net,
    appRoot,
    backendOrigin: 'http://127.0.0.1:4567'
  });

  const headers = new Headers({ accept: 'application/json' });
  const response = await handler({
    url: 'dsh-app://app/api/items?limit=2',
    method: 'GET',
    headers
  });

  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].url, 'http://127.0.0.1:4567/api/items?limit=2');
  assert.strictEqual(captured[0].init.method, 'GET');
  assert.strictEqual(captured[0].init.headers, headers);
  assert.strictEqual(response.status, 201);
  assert.strictEqual(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.strictEqual(response.headers.get('set-cookie'), null);
  assert.strictEqual(await response.text(), '{"ok":true}');
});

test('createAppProtocolHandler: proxies exact /api path and returns 502 on backend failure', async (t) => {
  const appRoot = makeFixture(t);
  const seen = [];
  const net = {
    fetch: async (url) => {
      seen.push(url);
      if (url.endsWith('/api')) return new Response('root-api', { status: 200 });
      throw new Error('offline');
    }
  };

  const handler = createAppProtocolHandler({
    protocol: makeFakeProtocol(),
    net,
    appRoot,
    backendOrigin: 'http://127.0.0.1:4567'
  });

  const exact = await handler({ url: 'dsh-app://app/api', method: 'GET' });
  assert.strictEqual(exact.status, 200);
  assert.strictEqual(await exact.text(), 'root-api');
  assert.strictEqual(seen[0], 'http://127.0.0.1:4567/api');

  const failed = await handler({ url: 'dsh-app://app/api/health', method: 'GET' });
  assert.strictEqual(failed.status, 502);
});

test('createAppProtocolHandler: rejects invalid wiring early', () => {
  assert.throws(() => createAppProtocolHandler({ protocol: {}, net: {}, appRoot: '/x' }), TypeError);
  assert.throws(() => createAppProtocolHandler({ protocol: makeFakeProtocol(), net: {}, appRoot: '/x' }), TypeError);
  assert.throws(() => createAppProtocolHandler({ protocol: makeFakeProtocol(), net: { fetch() {} } }), TypeError);
  assert.throws(
    () => createAppProtocolHandler({
      protocol: makeFakeProtocol(),
      net: { fetch() {} },
      appRoot: '/x',
      backendOrigin: 'ftp://127.0.0.1'
    }),
    TypeError
  );
});
