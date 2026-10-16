'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isBackendHttp } = require('../lib/trusted-url');

test('isBackendHttp: validates legitimate 127.0.0.1 and localhost URLs', () => {
  assert.strictEqual(isBackendHttp('http://127.0.0.1:3080', 3080), true);
  assert.strictEqual(isBackendHttp('http://127.0.0.1:3080/chat', 3080), true);
  assert.strictEqual(isBackendHttp('http://localhost:3080', 3080), true);
  assert.strictEqual(isBackendHttp('http://localhost:3080/settings?tab=model', 3080), true);
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
