'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runContractCheck, findFreePort } = require('../lib/upstream-contract');

const FAKE_BIN = `'use strict';
const http = require('node:http');
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 3080;
const mode = process.env.FAKE_MODE || 'good';
const token = 'tok123';
const tokenUrl = 'http://127.0.0.1:' + port + '/?token=' + token;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://dsh.invalid');
  const cookies = req.headers.cookie || '';
  if (url.searchParams.get('token')) {
    if (mode === 'no-cookie') {
      res.writeHead(303, { location: '/' });
      return res.end();
    }
    res.writeHead(303, { location: '/', 'set-cookie': 'dsh_token=1; Path=/; HttpOnly' });
    return res.end();
  }
  if (mode === 'open-index') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><div id="root"></div>');
  }
  if (cookies.includes('dsh_token=1')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><div id="root"></div>');
  }
  res.writeHead(401, { 'content-type': 'text/plain' });
  res.end('dsh web authentication required');
});

server.listen(port, '127.0.0.1', () => {
  if (mode === 'no-url') process.exit(0);
  if (mode === 'no-token-url') {
    console.log('dsh web: http://127.0.0.1:' + port + '/?nope=1');
    return;
  }
  console.log('dsh web: ' + tokenUrl);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

function makeRuntime(t, version = '0.2.1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkgDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } })
  );
  fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), FAKE_BIN);
  return root;
}

function withMode(mode, fn) {
  const previous = process.env.FAKE_MODE;
  process.env.FAKE_MODE = mode;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.FAKE_MODE;
    else process.env.FAKE_MODE = previous;
  });
}

test('a runtime that follows the contract passes every probe', async (t) => {
  const runtimeDir = makeRuntime(t);
  const result = await withMode('good', () => runContractCheck({ runtimeDir, log: null }));

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.version, '0.2.1');
  assert.deepStrictEqual(result.steps.map((step) => step.ok), [true, true, true, true]);
});

test('a runtime that never prints the url fails the launch step', async (t) => {
  const runtimeDir = makeRuntime(t);
  const result = await withMode('no-url', () => runContractCheck({ runtimeDir, timeoutMs: 1500, log: null }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.steps[0].ok, false);
  assert.match(result.steps[0].detail, /退出/);
});

test('an url without a token is rejected', async (t) => {
  const runtimeDir = makeRuntime(t);
  const result = await withMode('no-token-url', () => runContractCheck({ runtimeDir, timeoutMs: 1500, log: null }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.steps[0].ok, false);
});

test('a token url that mints no cookie fails the probe', async (t) => {
  const runtimeDir = makeRuntime(t);
  const result = await withMode('no-cookie', () => runContractCheck({ runtimeDir, log: null }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.steps[2].ok, false);
  assert.match(result.steps[2].detail, /cookies=0/);
});

test('an index reachable without auth fails the probe', async (t) => {
  const runtimeDir = makeRuntime(t);
  const result = await withMode('open-index', () => runContractCheck({ runtimeDir, log: null }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.steps[1].name, 'index without token returns 401');
  assert.strictEqual(result.steps[1].ok, false);
});

test('an unsupported core version is rejected before spawning', async (t) => {
  const runtimeDir = makeRuntime(t, '0.4.0');
  const result = await runContractCheck({ runtimeDir, log: null });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.steps[0].name, 'runtime compatibility');
  assert.match(result.steps[0].detail, /超出已验证范围/);
});

test('findFreePort returns a usable loopback port', async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port) && port > 0);
});
