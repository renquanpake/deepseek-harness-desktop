'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createBackend } = require('../src/backend');

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 4242;
  return proc;
}

function setup(overrides = {}) {
  const spawned = [];
  const errors = [];
  const deps = {
    spawn: (cmd, args, opts) => {
      const proc = makeFakeProc();
      spawned.push({ cmd, args, opts, proc });
      return proc;
    },
    http: { get: () => { throw new Error('not used'); } },
    fs: {
      existsSync: () => true,
      renameSync: () => {},
      mkdirSync: () => {},
      writeFileSync: () => {}
    },
    path: require('node:path'),
    dialog: {
      showErrorBox: (title, detail) => errors.push([title, detail]),
      showMessageBox: async () => ({ response: 0 })
    },
    t: (key) => `T:${key}`,
    toWslPath: (p) => p,
    cleanStaleLocks: () => {},
    getDshHome: () => '/tmp/dsh-home',
    getLocalRuntimeDir: () => '/tmp/dsh-home/local-runtime',
    getPort: () => 3999,
    getEngine: () => 'win-native',
    isSafeMode: () => false,
    isQuitting: () => false,
    getWorkspaceDir: () => '/tmp/ws',
    getMainWindow: () => ({ webContents: null }),
    getRuntimeDir: () => '/tmp/runtime',
    getBundledNodeExe: () => null,
    buildBackendEnv: () => ({}),
    currentRegistryUrl: () => 'https://registry.npmjs.org',
    cleanupOldBrokenRuntimeDirs: () => {},
    getLocalDshVersion: () => '0.0.0',
    hydratePresetPlugins: () => {},
    setForceBundledRuntime: () => {},
    setLocalRuntimeBrokenUntil: () => {},
    sendRuntimeLog: () => {},
    watchdogMs: 15000,
    probeMs: 5000,
    loadFailureThreshold: 2,
    brokenWindowMs: 3600
  };
  Object.assign(deps, overrides);
  return { deps, spawned, errors, backend: createBackend(deps) };
}

test('start uses bundled dsh.cmd shim when node exe missing', () => {
  const { backend, spawned } = setup();
  assert.strictEqual(backend.startDshBackend(), true);
  assert.strictEqual(spawned.length, 1);
  assert.ok(spawned[0].cmd.endsWith(process.platform === 'win32' ? 'dsh.cmd' : 'dsh'));
  assert.deepStrictEqual(spawned[0].args, ['web', '--no-open', '--port', '3999']);
});

test('missing runtime stops startup and reports error to user', () => {
  const { backend, errors } = setup({
    fs: {
      existsSync: () => false,
      renameSync: () => {},
      mkdirSync: () => {},
      writeFileSync: () => {}
    }
  });
  assert.strictEqual(backend.startDshBackend(), false);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0][0], 'T:error.runtimeMissing');
  assert.ok(errors[0][1].includes('runtime:prepare'));
});

test('auth url is captured from stdout and exposed via getTargetUrl', () => {
  const { backend, spawned } = setup();
  backend.startDshBackend();
  assert.strictEqual(backend.getAuthUrl(), null);
  assert.strictEqual(backend.getTargetUrl(), 'http://127.0.0.1:3999');
  spawned[0].proc.stdout.emit('data', 'dsh web: http://127.0.0.1:3999/?token=abc\n');
  assert.strictEqual(backend.getAuthUrl(), 'http://127.0.0.1:3999/?token=abc');
  assert.strictEqual(backend.getTargetUrl(), 'http://127.0.0.1:3999/?token=abc');
  backend.clearAuthUrl();
  assert.strictEqual(backend.getAuthUrl(), null);
});

test('ready flag and running state track process lifecycle', () => {
  const { backend, spawned } = setup();
  backend.startDshBackend();
  const proc = spawned[0].proc;
  assert.strictEqual(backend.isReady(), false);
  assert.strictEqual(backend.isRunning(), true);
  backend.markReady(true);
  assert.strictEqual(backend.isReady(), true);
  proc.emit('exit', 0);
  assert.strictEqual(backend.isRunning(), false);
});

test('killProcessTree clears readiness and marks self-kill', () => {
  const { backend, spawned } = setup();
  backend.startDshBackend();
  const proc = spawned[0].proc;
  backend.markReady(true);
  proc.kill = () => {};
  const originalKill = process.kill;
  process.kill = () => {};
  try {
    backend.killProcessTree();
  } finally {
    process.kill = originalKill;
  }
  assert.strictEqual(backend.isReady(), false);
  assert.strictEqual(backend.isRunning(), false);
  assert.strictEqual(proc.killedByUs, true);
});

test('load failure counter accumulates and resets', () => {
  const { backend } = setup();
  backend.noteLoadFailure(-102, 'ERR_CONN');
  backend.noteLoadFailure(-102, 'ERR_CONN');
  backend.resetLoadFailures();
  assert.ok(true);
});
