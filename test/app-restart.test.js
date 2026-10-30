'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createRestartController } = require('../src/app-restart');

function makeHarness(options = {}) {
  const calls = [];
  const state = {
    port: 3080,
    authUrl: options.authUrl === undefined ? 'http://127.0.0.1:3090/?token=x' : options.authUrl,
    ready: options.ready !== false
  };
  const window = options.noWindow ? null : { isDestroyed: () => false };

  const controller = createRestartController({
    backend: {
      markReady: (value) => calls.push(['markReady', value]),
      clearAuthUrl: () => calls.push(['clearAuthUrl']),
      getAuthUrl: () => {
        if (options.authProbe) return options.authProbe(state);
        return state.authUrl;
      },
      getTargetUrl: () => `http://127.0.0.1:${state.port}/`
    },
    startDshBackend: () => {
      calls.push(['start']);
      return options.spawnOk !== false;
    },
    waitForBackendReady: async () => {
      calls.push(['wait']);
      return state.ready;
    },
    findAvailablePort: async (port) => {
      calls.push(['findPort', port]);
      return options.nextPort || 3090;
    },
    installAppProtocol: () => calls.push(['installProtocol']),
    getMainWindow: () => window,
    getPort: () => state.port,
    setPort: (port) => {
      state.port = port;
      calls.push(['setPort', port]);
    },
    sleep: async (ms) => {
      calls.push(['sleep', ms]);
      if (options.sleep) await options.sleep(ms);
    },
    now: options.now || Date.now,
    authWaitMs: options.authWaitMs === undefined ? 1500 : options.authWaitMs,
    onReady: (url, port) => calls.push(['onReady', url, port]),
    rebuildMenus: () => calls.push(['rebuildMenus']),
    operationLog: { append: (type, data) => calls.push(['log', type, data]) },
    logContext: () => ({ engine: 'win-native' })
  });

  return { controller, calls, state };
}

test('restart picks a port, boots the backend and reports readiness', async () => {
  const { controller, calls, state } = makeHarness();

  const ready = await controller.performRestart();

  assert.strictEqual(ready, true);
  assert.strictEqual(state.port, 3090);
  const order = calls.map((entry) => entry[0]);
  assert.deepStrictEqual(order, [
    'markReady',
    'clearAuthUrl',
    'findPort',
    'setPort',
    'log',
    'start',
    'wait',
    'markReady',
    'log',
    'installProtocol',
    'onReady',
    'rebuildMenus'
  ]);
  assert.deepStrictEqual(calls.find((entry) => entry[0] === 'onReady').slice(1), ['http://127.0.0.1:3090/', 3090]);
  assert.deepStrictEqual(calls.find((entry) => entry[0] === 'log')[2], { port: 3090, engine: 'win-native' });
});

test('a failed spawn stops before waiting and logs the failure', async () => {
  const { controller, calls } = makeHarness({ spawnOk: false });

  const ready = await controller.performRestart();

  assert.strictEqual(ready, false);
  const types = calls.filter((entry) => entry[0] === 'log').map((entry) => entry[1]);
  assert.deepStrictEqual(types, ['restart', 'restart-failed']);
  assert.strictEqual(calls.some((entry) => entry[0] === 'wait'), false);
});

test('a backend that never becomes ready skips protocol install and ready window', async () => {
  const { controller, calls } = makeHarness({ ready: false });

  const ready = await controller.performRestart();

  assert.strictEqual(ready, false);
  assert.strictEqual(calls.some((entry) => entry[0] === 'installProtocol'), false);
  assert.strictEqual(calls.some((entry) => entry[0] === 'onReady'), false);
  assert.strictEqual(calls.some((entry) => entry[0] === 'rebuildMenus'), true);
});

test('waits for the auth url until the deadline', async () => {
  let clock = 0;
  let probes = 0;
  const { controller } = makeHarness({
    authUrl: null,
    authWaitMs: 500,
    now: () => clock,
    authProbe: () => {
      probes += 1;
      return probes >= 3 ? 'http://127.0.0.1:3090/?token=x' : null;
    },
    sleep: async () => {
      clock += 100;
    }
  });

  await controller.performRestart();
  assert.strictEqual(probes, 3);
});

test('stops waiting for the auth url at the deadline', async () => {
  let clock = 0;
  let probes = 0;
  const { controller } = makeHarness({
    authUrl: null,
    authWaitMs: 300,
    now: () => clock,
    authProbe: () => {
      probes += 1;
      return null;
    },
    sleep: async () => {
      clock += 100;
    }
  });

  const ready = await controller.performRestart();
  assert.strictEqual(ready, true);
  assert.ok(probes >= 4, `expected several probes, got ${probes}`);
  assert.ok(probes <= 6, `deadline must bound probes, got ${probes}`);
});
