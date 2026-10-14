const { test } = require('node:test');
const assert = require('node:assert');
const { isBackendHttp } = require('../lib/trusted-url');

test('accepts http backend on exact port', () => {
  assert.strictEqual(isBackendHttp('http://127.0.0.1:3080/workspace', 3080), true);
  assert.strictEqual(isBackendHttp('http://localhost:3080', 3080), true);
});

test('rejects lookalike domains that start with the backend host', () => {
  assert.strictEqual(isBackendHttp('http://127.0.0.1.evil.com', 3080), false);
  assert.strictEqual(isBackendHttp('http://localhostevil.com', 3080), false);
});

test('rejects port mismatch and non-http protocols', () => {
  assert.strictEqual(isBackendHttp('http://127.0.0.1:9999/x', 3080), false);
  assert.strictEqual(isBackendHttp('https://127.0.0.1:3080', 3080), false);
});

test('rejects malformed urls', () => {
  assert.strictEqual(isBackendHttp('not a url', 3080), false);
});
