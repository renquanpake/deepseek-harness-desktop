'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createIpcActions } = require('../src/ipc-actions');

function makeHarness(overrides = {}) {
  const calls = {
    restarts: 0,
    switched: [],
    menus: 0,
    engine: 'win-native',
    safeMode: false,
    autoStart: false,
    sent: [],
    shown: [],
    focus: 0,
    flash: [],
    notifications: []
  };

  class FakeNotification {
    static isSupported() {
      return overrides.notificationSupported !== false;
    }

    constructor(options) {
      this.options = options;
      this.handlers = {};
      calls.notifications.push(this);
    }

    on(event, handler) {
      this.handlers[event] = handler;
    }

    show() {
      this.shown = true;
    }
  }

  const window = {
    isFocused: () => overrides.windowFocused === true,
    flashFrame: (value) => calls.flash.push(value),
    show: () => calls.shown.push('window'),
    focus: () => {
      calls.focus += 1;
    },
    webContents: { send: (channel, payload) => calls.sent.push({ channel, payload }) },
    setAlwaysOnTop: (value) => calls.sent.push({ channel: 'always-on-top', payload: value })
  };

  const actions = createIpcActions({
    Notification: FakeNotification,
    dialog: {
      showOpenDialog: async () =>
        overrides.openDialog || { canceled: true, filePaths: [] }
    },
    t: (key) => key,
    app: { id: 'app' },
    backend: {
      isReady: () => true,
      isRunning: () => true,
      getTargetUrl: () => 'http://127.0.0.1:3080/'
    },
    clipboardBridge: {
      feedClipboardIntoEditor: () => {},
      convertToWslMountPath: (value) => `wsl:${value}`
    },
    worktreeManager: {
      createIsolatedGitWorktree: (dir) => ({
        created: true,
        worktreePath: `${dir}/.worktree`,
        repoPath: dir,
        branchName: 'dsh/task-1'
      })
    },
    getMainWindow: () => (overrides.noWindow ? null : window),
    getPort: () => 3080,
    getEngine: () => calls.engine,
    setEngine: (value) => {
      calls.engine = value;
    },
    isSafeMode: () => calls.safeMode,
    setSafeMode: (value) => {
      calls.safeMode = value;
    },
    getShellVersion: () => '0.2.1',
    getCurrentDshVersion: () => ({ version: '0.1.0', source: 'bundled' }),
    getDshHome: () => '/home/dsh',
    getWorkspaceDir: () => '/workspace/demo',
    getWorktreeStatus: () => ({
      isWorktree: true,
      worktreePath: '/workspace/demo/.worktree',
      worktreeBranch: 'dsh/task-1'
    }),
    readFactoryPresetPluginNames: () => ['a', 'b'],
    hydratePresetPlugins: () => {},
    switchWorkspace: (dir, session) => calls.switched.push({ dir, session }),
    restartWithCurrentConfig: async () => {
      calls.restarts += 1;
      return true;
    },
    registerWindowsContextMenu: () => ({ total: 3, failed: 0 }),
    unregisterWindowsContextMenu: () => ({ total: 3, failed: 1 }),
    getAutoStart: () => calls.autoStart,
    setAutoStart: (_app, value) => {
      calls.autoStart = value;
      return { enabled: value };
    },
    rebuildMenus: () => {
      calls.menus += 1;
    },
    runSelfRepair: () => ({ actions: ['cleaned-locks'] }),
    getRuntimeDir: () => '/runtime',
    killProcessTree: () => {},
    runUpdateCheck: () => {},
    log: { log: () => {} },
    ...overrides.actions
  });

  return { actions, calls, window };
}

test('runtime info reflects the current shell state', () => {
  const { actions } = makeHarness();
  assert.deepStrictEqual(actions['dsh:get-runtime-info'](), {
    version: '0.2.1',
    coreVersion: '0.1.0',
    port: 3080,
    engine: 'win-native',
    safeMode: false,
    home: '/home/dsh',
    workspaceDir: '/workspace/demo'
  });
});

test('backend status reports readiness and url', () => {
  const { actions } = makeHarness();
  const status = actions['dsh:get-backend-status']();
  assert.strictEqual(status.ready, true);
  assert.strictEqual(status.url, 'http://127.0.0.1:3080/');
});

test('switch engine applies the mode and restarts, wsl2 only on windows', async () => {
  const { actions, calls } = makeHarness();
  const result = await actions['dsh:switch-engine']('win-native');
  assert.strictEqual(result.engine, 'win-native');
  assert.strictEqual(calls.restarts, 1);

  if (process.platform !== 'win32') {
    await assert.rejects(() => actions['dsh:switch-engine']('wsl2'), /only available on Windows/);
  }
});

test('safe mode toggles and restarts', async () => {
  const { actions, calls } = makeHarness();
  assert.deepStrictEqual(await actions['dsh:restart-safe-mode'](), { safeMode: true });
  assert.strictEqual(calls.safeMode, true);
  assert.strictEqual(calls.restarts, 1);
});

test('auto start broadcasts the new value and rebuilds menus', () => {
  const { actions, calls } = makeHarness();
  const result = actions['dsh:set-auto-start'](true);

  assert.deepStrictEqual(result, { enabled: true });
  assert.strictEqual(calls.autoStart, true);
  assert.deepStrictEqual(calls.sent, [{ channel: 'dsh:auto-start-changed', payload: { enabled: true } }]);
  assert.strictEqual(calls.menus, 1);
});

test('worktree dialog switches workspace only after a selection', async () => {
  const cancelled = makeHarness();
  assert.deepStrictEqual(await cancelled.actions['dsh:create-worktree-dialog'](), { ok: true });
  assert.strictEqual(cancelled.calls.switched.length, 0);
  assert.strictEqual(cancelled.calls.restarts, 0);

  const selected = makeHarness({ openDialog: { canceled: false, filePaths: ['/repo'] } });
  assert.deepStrictEqual(await selected.actions['dsh:create-worktree-dialog'](), { ok: true });
  assert.strictEqual(selected.calls.switched[0].dir, '/repo/.worktree');
  assert.strictEqual(selected.calls.restarts, 1);
});

test('self repair augments the report with readiness and url', async () => {
  const { actions } = makeHarness();
  const report = await actions['dsh:run-self-repair']();
  assert.deepStrictEqual(report.actions, ['cleaned-locks']);
  assert.strictEqual(report.ready, true);
  assert.strictEqual(report.port, 3080);
  assert.strictEqual(report.url, 'http://127.0.0.1:3080');
});

test('workspace status exposes the worktree session', () => {
  const { actions } = makeHarness();
  assert.deepStrictEqual(actions['dsh:get-workspace-status'](), {
    isWorktree: true,
    worktreePath: '/workspace/demo/.worktree',
    worktreeBranch: 'dsh/task-1',
    engine: 'win-native'
  });
});

test('context menu actions report success only when every entry registers', () => {
  const { actions } = makeHarness();
  assert.strictEqual(actions['dsh:register-context-menu'](), true);
  assert.strictEqual(actions['dsh:unregister-context-menu'](), false);
});

test('notifications flash the window and focus it on click', () => {
  const { actions, calls, window } = makeHarness({ notificationSupported: false });
  actions.nativeNotify({ title: 't', body: 'b' });
  assert.deepStrictEqual(calls.flash, [true]);
  assert.strictEqual(calls.notifications.length, 0);

  const supported = makeHarness();
  supported.actions.nativeNotify({ title: 't', body: 'b' });
  const notice = supported.calls.notifications[0];
  assert.strictEqual(notice.options.title, 't');
  notice.handlers.click();
  assert.strictEqual(supported.calls.focus, 1);
  assert.deepStrictEqual(supported.calls.flash, [true, false]);
  assert.strictEqual(window.isFocused(), false);
});

test('missing main window does not break window-scoped actions', () => {
  const { actions } = makeHarness({ noWindow: true });
  assert.strictEqual(actions['dsh:set-always-on-top'](true), true);
  actions.nativeNotify({ title: 't', body: 'b' });
  actions['dsh:set-auto-start'](false);
});
