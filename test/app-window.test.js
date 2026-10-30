'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createWindowFactory } = require('../src/app-window');
const { isFileInsideRoot } = require('../lib/trusted-url');

const BACKEND = 'http://127.0.0.1:3080';
const APP_URL = 'dsh-app://app/index.html';

class FakeWebContents {
  constructor() {
    this.handlers = {};
    this.openHandler = null;
  }

  setWindowOpenHandler(fn) {
    this.openHandler = fn;
  }

  on(event, fn) {
    this.handlers[event] = fn;
  }
}

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.handlers = {};
    this.loaded = null;
  }

  loadURL(url) {
    this.loaded = { type: 'url', value: url };
  }

  loadFile(filePath) {
    this.loaded = { type: 'file', value: filePath };
  }

  on(event, fn) {
    this.handlers[event] = fn;
  }
}

function makeFactory(overrides = {}) {
  const events = { external: [], failures: [], ready: 0, close: [], beforeLoad: 0 };
  const factory = createWindowFactory({
    BrowserWindow: FakeBrowserWindow,
    shell: { openExternal: (url) => events.external.push(url) },
    appRoot: '/app',
    preloadPath: '/app/preload.js',
    appScheme: 'dsh-app',
    appHost: 'app',
    appProtocolEnabled: false,
    isBackendHttp: (url, port) => typeof url === 'string' && url.startsWith(`http://127.0.0.1:${port}`),
    isAppUrl: (url) => url.startsWith('dsh-app://app'),
    isAllowedFileUrl: (url) => isFileInsideRoot(url, '/app'),
    getPort: () => 3080,
    getWorkspaceDir: () => '/workspace/demo',
    beforeLoad: () => {
      events.beforeLoad += 1;
    },
    onLoadFailure: (code, description) => events.failures.push({ code, description }),
    onLoadReady: () => {
      events.ready += 1;
    },
    onCloseRequest: (event, win) => events.close.push({ event, win }),
    ...overrides
  });
  return { factory, events };
}

test('window uses a locked sandboxed preload and the workspace title', () => {
  const { factory } = makeFactory();
  const win = factory();

  assert.strictEqual(win.options.title, 'DeepSeek Harness Studio — /workspace/demo');
  assert.deepStrictEqual(win.options.webPreferences, {
    preload: '/app/preload.js',
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false
  });
});

test('loads the local splash file unless the app protocol is enabled', () => {
  const fileFactory = makeFactory().factory;
  assert.deepStrictEqual(fileFactory().loaded, { type: 'file', value: '/app/splash.html' });

  const { factory } = makeFactory({ appProtocolEnabled: true });
  assert.deepStrictEqual(factory().loaded, {
    type: 'url',
    value: 'dsh-app://app/splash.html'
  });
});

test('runs beforeLoad before navigating', () => {
  const order = [];
  const { factory } = makeFactory({
    appProtocolEnabled: true,
    beforeLoad: () => order.push('beforeLoad')
  });
  const win = factory();
  order.push('loaded');
  assert.deepStrictEqual(order, ['beforeLoad', 'loaded']);
  assert.strictEqual(win.loaded.type, 'url');
});

test('hidden launch keeps the window hidden', () => {
  const { factory } = makeFactory({ isHiddenLaunch: () => true });
  assert.strictEqual(factory().options.show, false);
});

test('window open handler allows the backend and externalizes everything else', () => {
  const { factory, events } = makeFactory();
  const win = factory();
  const handler = win.webContents.openHandler;

  assert.deepStrictEqual(handler({ url: `${BACKEND}/chat` }), { action: 'allow' });

  const external = handler({ url: 'https://example.com/doc' });
  assert.deepStrictEqual(external, { action: 'deny' });
  assert.deepStrictEqual(events.external, ['https://example.com/doc']);
});

test('navigation guard keeps backend, app protocol and file urls in place', () => {
  const { factory, events } = makeFactory();
  const win = factory();
  const handler = win.webContents.handlers['will-navigate'];

  for (const url of [`${BACKEND}/`, APP_URL, 'file:///app/splash.html']) {
    let prevented = false;
    handler({ preventDefault: () => { prevented = true; } }, url);
    assert.strictEqual(prevented, false, `${url} must stay inside the shell`);
  }

  for (const url of ['file:///etc/passwd', 'file:///app/../secret.txt', 'https://evil.example/']) {
    let prevented = false;
    handler({ preventDefault: () => { prevented = true; } }, url);
    assert.strictEqual(prevented, true, `${url} must be blocked`);
  }
  assert.deepStrictEqual(events.external, ['file:///etc/passwd', 'file:///app/../secret.txt', 'https://evil.example/']);
});

test('load failures ignore splash and about:blank but reach the backend watchdog', () => {
  const { factory, events } = makeFactory();
  const win = factory();
  const handler = win.webContents.handlers['did-fail-load'];

  handler({}, -105, 'NAME_NOT_RESOLVED', 'about:blank');
  handler({}, -105, 'NAME_NOT_RESOLVED', `${BACKEND}/splash.html`);
  assert.deepStrictEqual(events.failures, []);

  handler({}, -105, 'NAME_NOT_RESOLVED', `${BACKEND}/`);
  assert.deepStrictEqual(events.failures, [{ code: -105, description: 'NAME_NOT_RESOLVED' }]);
});

test('renderer crashes are forwarded with the gone details', () => {
  const seen = [];
  const { factory } = makeFactory({ onRendererGone: (details) => seen.push(details) });
  const win = factory();

  win.webContents.handlers['render-process-gone']({}, { reason: 'crashed', exitCode: 1 });

  assert.deepStrictEqual(seen, [{ reason: 'crashed', exitCode: 1 }]);
});

test('dom-ready and close are forwarded to the caller', () => {
  const { factory, events } = makeFactory();
  const win = factory();

  win.webContents.handlers['dom-ready']();
  assert.strictEqual(events.ready, 1);

  const event = {};
  win.handlers.close(event);
  assert.strictEqual(events.close.length, 1);
  assert.strictEqual(events.close[0].event, event);
  assert.strictEqual(events.close[0].win, win);
});
