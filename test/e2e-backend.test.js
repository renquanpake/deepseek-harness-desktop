'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { getE2eBackendUrl } = require('../lib/e2e-backend');

test('e2e backend url requires the DSH_E2E flag', () => {
  assert.strictEqual(
    getE2eBackendUrl({ DSH_E2E_BACKEND_URL: 'http://127.0.0.1:4000/' }),
    null
  );
  assert.strictEqual(
    getE2eBackendUrl({ DSH_E2E: '0', DSH_E2E_BACKEND_URL: 'http://127.0.0.1:4000/' }),
    null
  );
  assert.strictEqual(
    getE2eBackendUrl({ DSH_E2E: 'true', DSH_E2E_BACKEND_URL: 'http://127.0.0.1:4000/' }),
    'http://127.0.0.1:4000/'
  );
});

test('e2e backend url only accepts loopback http fixtures', () => {
  const base = { DSH_E2E: '1' };
  for (const url of [
    'https://127.0.0.1:4000/',
    'http://evil.example:4000/',
    'file:///tmp/index.html',
    'http://10.0.0.5:4000/',
    'not-a-url'
  ]) {
    assert.strictEqual(getE2eBackendUrl({ ...base, DSH_E2E_BACKEND_URL: url }), null, url);
  }
  assert.strictEqual(
    getE2eBackendUrl({ ...base, DSH_E2E_BACKEND_URL: 'http://localhost:8123/index.html' }),
    'http://localhost:8123/index.html'
  );
  assert.strictEqual(getE2eBackendUrl({ ...base }), null);
  assert.strictEqual(getE2eBackendUrl({ ...base, DSH_E2E_BACKEND_URL: '   ' }), null);
});
