'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { findAvailablePort, prependPathDirs } = require('../lib/env-utils');

test('findAvailablePort: finds an available port', async () => {
  const port = await findAvailablePort(3090);
  assert.ok(typeof port === 'number');
  assert.ok(port >= 3090);
});

test('findAvailablePort: automatically skips occupied ports and picks next available', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(3100, '127.0.0.1', resolve));

  try {
    const port = await findAvailablePort(3100);
    assert.strictEqual(port, 3101);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('prependPathDirs: prepends new dirs and avoids duplicates on Windows', () => {
  const original = 'C:\\Windows\\system32;C:\\Program Files\\nodejs';
  const extra = ['C:\\my-app\\runtime', 'C:\\WINDOWS\\system32']; // second is duplicate case-insensitively

  const result = prependPathDirs(original, extra, 'win32');
  assert.strictEqual(result, 'C:\\my-app\\runtime;C:\\Windows\\system32;C:\\Program Files\\nodejs');
});

test('prependPathDirs: handles empty initial PATH', () => {
  const result = prependPathDirs('', ['/usr/local/bin', '/bin'], 'linux');
  assert.strictEqual(result, '/usr/local/bin:/bin');
});
