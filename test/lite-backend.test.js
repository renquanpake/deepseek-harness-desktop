'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createLiteBackend } = require('../lite/backend');

function makeDirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'app');
  const pkgDir = path.join(appDir, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1', bin: { dsh: 'lib/bin.js' } }));
  fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), '// entry');
  const dshHome = path.join(root, 'home');
  fs.mkdirSync(dshHome, { recursive: true });
  return { root, appDir, dshHome };
}

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

test('starts the runtime, parses the auth url and reports the port', async (t) => {
  const { appDir, dshHome } = makeDirs(t);
  const calls = { spawn: 0, probe: 0 };
  const child = makeChild();
  const backend = createLiteBackend({
    appDir,
    dshHome,
    spawnSyncFn: () => {
      calls.probe += 1;
      return { status: 0, stdout: '--no-open\n--port <port>', stderr: '' };
    },
    spawnFn: (command, args, options) => {
      calls.spawn += 1;
      assert.ok(args.includes('web'));
      assert.ok(args.includes('--no-open'));
      assert.deepStrictEqual(args.slice(-2), ['--port', '0']);
      assert.strictEqual(options.env.DSH_HOME, dshHome);
      setImmediate(() => child.stdout.emit('data', 'dsh web: http://127.0.0.1:4321/?token=abc\n'));
      return child;
    }
  });

  const result = await backend.start();

  assert.strictEqual(result.url, 'http://127.0.0.1:4321/?token=abc');
  assert.strictEqual(result.port, 4321);
  assert.strictEqual(calls.spawn, 1);
  assert.strictEqual(calls.probe, 1);

  backend.stop();
  assert.strictEqual(child.killed, true);
});

test('reuses the capability cache instead of probing again', async (t) => {
  const { appDir, dshHome } = makeDirs(t);
  let probes = 0;
  const probe = () => {
    probes += 1;
    return { status: 0, stdout: '--no-open\n--port <port>', stderr: '' };
  };
  const makeSpawn = () => () => {
    const child = makeChild();
    setImmediate(() => child.stdout.emit('data', 'dsh web: http://127.0.0.1:4567/?token=abc\n'));
    return child;
  };

  await createLiteBackend({ appDir, dshHome, spawnSyncFn: probe, spawnFn: makeSpawn() }).start();
  const second = createLiteBackend({
    appDir,
    dshHome,
    spawnSyncFn: () => {
      throw new Error('probe must not run');
    },
    spawnFn: makeSpawn()
  });
  const result = await second.start();

  assert.strictEqual(probes, 1);
  assert.strictEqual(result.port, 4567);
});

test('rejects when the runtime is not prepared', async (t) => {
  const { root } = makeDirs(t);
  const backend = createLiteBackend({ appDir: path.join(root, 'missing'), dshHome: path.join(root, 'home') });
  await assert.rejects(() => backend.start(), /dsh-runtime/);
});

test('rejects when the runtime exits before printing the url', async (t) => {
  const { appDir, dshHome } = makeDirs(t);
  const backend = createLiteBackend({
    appDir,
    dshHome,
    spawnSyncFn: () => ({ status: 0, stdout: '--no-open', stderr: '' }),
    spawnFn: () => {
      const child = makeChild();
      setImmediate(() => {
        child.stderr.emit('data', 'boom\n');
        child.emit('exit', 1);
      });
      return child;
    }
  });

  await assert.rejects(() => backend.start(), /退出/);
});

test('times out when no url is printed', async (t) => {
  const { appDir, dshHome } = makeDirs(t);
  const backend = createLiteBackend({
    appDir,
    dshHome,
    timeoutMs: 100,
    spawnSyncFn: () => ({ status: 0, stdout: '--no-open', stderr: '' }),
    spawnFn: () => makeChild()
  });

  await assert.rejects(() => backend.start(), /没有输出认证 URL/);
});
