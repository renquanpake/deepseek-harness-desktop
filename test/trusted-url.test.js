'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isBackendHttp, isTrustedSender } = require('../lib/trusted-url');

test('isBackendHttp: validates legitimate 127.0.0.1 and localhost URLs with exact port', () => {
  assert.strictEqual(isBackendHttp('http://127.0.0.1:3080', 3080), true);
  assert.strictEqual(isBackendHttp('http://127.0.0.1:3080/chat', 3080), true);
  assert.strictEqual(isBackendHttp('http://localhost:3080', 3080), true);
  assert.strictEqual(isBackendHttp('http://localhost:3080/settings?tab=model', 3080), true);

  // Default port 80 only matches port 80, never 3080
  assert.strictEqual(isBackendHttp('http://127.0.0.1', 80), true);
  assert.strictEqual(isBackendHttp('http://127.0.0.1/', 3080), false);
  assert.strictEqual(isBackendHttp('http://localhost/', 3080), false);
});

test('isBackendHttp: rejects non-http protocols, remote domains, and port mismatches', () => {
  // Protocol rejection
  assert.strictEqual(isBackendHttp('https://127.0.0.1:3080', 3080), false);
  assert.strictEqual(isBackendHttp('file:///C:/evil.html', 3080), false);
  assert.strictEqual(isBackendHttp('javascript:alert(1)', 3080), false);

  // Host rejection
  assert.strictEqual(isBackendHttp('http://google.com:3080', 3080), false);
  assert.strictEqual(isBackendHttp('http://attacker.com', 3080), false);
  assert.strictEqual(isBackendHttp('http://192.168.1.100:3080', 3080), false);

  // Port mismatch rejection
  assert.strictEqual(isBackendHttp('http://127.0.0.1:8080', 3080), false);
  assert.strictEqual(isBackendHttp('http://127.0.0.1:3081', 3080), false);

  // Malformed input rejection
  assert.strictEqual(isBackendHttp(null, 3080), false);
  assert.strictEqual(isBackendHttp('', 3080), false);
  assert.strictEqual(isBackendHttp('not-a-url', 3080), false);
});

test('isTrustedSender: allows desktop shell file:// and mainWindow sender, plus backend http', () => {
  const fakeWebContents = {};
  const fakeMainWindow = { webContents: fakeWebContents };
  const legitimateSplashUrl = pathToFileURL(path.resolve(__dirname, '..', 'splash.html')).href;

  // Shell sender matching mainWindow
  assert.strictEqual(
    isTrustedSender({ sender: fakeWebContents, senderFrame: { url: legitimateSplashUrl } }, 3080, fakeMainWindow),
    true
  );

  // Shell sender matching exact file:// splash path
  assert.strictEqual(
    isTrustedSender({ sender: {}, senderFrame: { url: legitimateSplashUrl } }, 3080),
    true
  );

  // Backend sender matching 127.0.0.1:<port>
  assert.strictEqual(
    isTrustedSender({ sender: {}, senderFrame: { url: 'http://127.0.0.1:3080/workspace' } }, 3080),
    true
  );

  // Rejects fake subpath trying to spoof splash.html
  assert.strictEqual(
    isTrustedSender({ sender: {}, senderFrame: { url: 'file:///C:/malicious/fake/splash.html' } }, 3080),
    false
  );

  // Rejects remote attacker
  assert.strictEqual(
    isTrustedSender({ sender: {}, senderFrame: { url: 'http://attacker.com:3080' } }, 3080),
    false
  );
});

test('isTrustedSender: allows dsh-app://app origin and rejects spoofed variants', () => {
  assert.strictEqual(
    isTrustedSender({ sender: {}, senderFrame: { url: 'dsh-app://app/splash.html' } }, 3080),
    true
  );
  assert.strictEqual(
    isTrustedSender({ sender: {}, senderFrame: { url: 'dsh-app://app/api/status' } }, 3080),
    true
  );
  // 错误 host / 带端口 / 错误 scheme 均不可信
  assert.strictEqual(
    isTrustedSender({ sender: {}, senderFrame: { url: 'dsh-app://evil/splash.html' } }, 3080),
    false
  );
  assert.strictEqual(
    isTrustedSender({ sender: {}, senderFrame: { url: 'dsh-app://app:3080/splash.html' } }, 3080),
    false
  );
  assert.strictEqual(
    isTrustedSender({ sender: {}, senderFrame: { url: 'http://app/splash.html' } }, 3080),
    false
  );
});

const { isFileInsideRoot } = require('../lib/trusted-url');

test('isFileInsideRoot only accepts files below the app root', () => {
  const root = path.resolve('/app');
  assert.strictEqual(isFileInsideRoot('file:///app/splash.html', root), true);
  assert.strictEqual(isFileInsideRoot('file:///app/nested/page.html', root), true);
  assert.strictEqual(isFileInsideRoot('file:///etc/passwd', root), false);
  assert.strictEqual(isFileInsideRoot('file:///app/../secret.txt', root), false);
  assert.strictEqual(isFileInsideRoot('file://app/splash.html', root), false);
  assert.strictEqual(isFileInsideRoot('https://example.com/x', root), false);
  assert.strictEqual(isFileInsideRoot('file:///app/splash.html', ''), false);
});
