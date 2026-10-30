'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createFixtureServer, PAGE } = require('./e2e/fixture-server');

test('fixture server serves the probe page and records requests', async (t) => {
  const server = createFixtureServer();
  const baseUrl = await server.start();
  t.after(() => server.stop());

  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const response = await fetch(baseUrl);
  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const body = await response.text();
  assert.strictEqual(body, PAGE);
  assert.match(body, /dshDesktop\.getRuntimeInfo/);

  const health = await fetch(`${baseUrl}health`);
  assert.deepStrictEqual(await health.json(), { ok: true });

  const missing = await fetch(`${baseUrl}nope`);
  assert.strictEqual(missing.status, 404);

  assert.deepStrictEqual(
    server.requests.map((entry) => entry.url),
    ['/', '/health', '/nope']
  );
});

test('fixture server binds an ephemeral loopback port and stops cleanly', async () => {
  const first = createFixtureServer();
  const second = createFixtureServer();
  const firstUrl = await first.start();
  const secondUrl = await second.start();

  assert.notStrictEqual(firstUrl, secondUrl, 'each fixture must get its own port');

  await first.stop();
  await second.stop();
  assert.strictEqual(first.getBaseUrl(), null);
  assert.strictEqual(second.getBaseUrl(), null);
});
