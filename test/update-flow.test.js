'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const updaterPath = require.resolve('../lib/updater');
const updateCheckPath = require.resolve('../lib/update-check');
const updateFlowPath = require.resolve('../src/update-flow');

function loadUpdateFlow({ updater = {}, updateCheck = {} } = {}) {
  require(updaterPath);
  require(updateCheckPath);
  const updaterExports = require.cache[updaterPath].exports;
  const updateCheckExports = require.cache[updateCheckPath].exports;

  require.cache[updaterPath].exports = { ...updaterExports, ...updater };
  require.cache[updateCheckPath].exports = { ...updateCheckExports, ...updateCheck };
  delete require.cache[updateFlowPath];
  const mod = require(updateFlowPath);

  require.cache[updaterPath].exports = updaterExports;
  require.cache[updateCheckPath].exports = updateCheckExports;
  delete require.cache[updateFlowPath];
  return mod;
}

function translate(key, vars) {
  if (!vars) return key;
  return `${key}:${JSON.stringify(vars)}`;
}

function makeHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const localRuntimeDir = path.join(root, 'local-runtime');
  const dialogs = [];
  const errors = [];
  const folders = [];
  const calls = {
    restart: 0,
    kill: 0,
    exit: 0,
    quitting: 0,
    pnpmAdds: [],
    progress: []
  };

  const dialog = {
    showMessageBox: async (window, opts) => {
      dialogs.push(opts);
      return options.messageBoxResponse || { response: 1 };
    },
    showErrorBox: (title, message) => {
      errors.push({ title, message });
    }
  };

  const app = {
    getPath: () => path.join(root, 'app', 'DeepSeek Harness.exe'),
    releaseSingleInstanceLock: () => {},
    exit: () => {
      calls.exit += 1;
    }
  };

  const preset = {
    runPnpmAdd: async (nodeExe, pnpmCjs, packages) => {
      calls.pnpmAdds.push(packages);
      return true;
    },
    readFactoryPresetPluginNames: () => [],
    mergeLocalRuntimePresetDependencies: () => [],
    isPresetPluginInstalled: () => true,
    pruneLocalRuntimeDependencies: () => {}
  };

  const hooks = {
    killProcessTree: () => {
      calls.kill += 1;
    },
    setWindowProgress: (text) => calls.progress.push(text),
    clearWindowProgress: () => {},
    setForceBundledRuntime: () => {},
    resetLocalRuntimeBrokenUntil: () => {},
    clearLocalRuntimeWatchdog: () => {},
    startDshBackend: () => {},
    restartWithCurrentConfig: async () => {
      calls.restart += 1;
      return true;
    },
    setQuitting: () => {
      calls.quitting += 1;
    }
  };

  const flow = loadUpdateFlow(options.modules).createUpdateFlow({
    app,
    dialog,
    shell: { showItemInFolder: (file) => folders.push(file), openExternal: () => {} },
    getMainWindow: () => ({}),
    t: translate,
    getCurrentDshVersion: () => options.currentCore || { version: '0.1.0', source: 'bundled' },
    getShellVersion: () => options.currentShell || '0.2.1',
    localRuntimeDir,
    portableMarkerDir: 'portable-data',
    getPortableDataRoot: () => options.portableRoot || null,
    getBundledNodeExe: () => '/usr/bin/node',
    getBundledPnpmCjs: () => '/usr/bin/pnpm.cjs',
    preset,
    hooks
  });

  return { flow, root, localRuntimeDir, dialogs, errors, folders, calls };
}

test('cleanupOldBrokenRuntimeDirs keeps the newest entries and removes the rest', (t) => {
  const { flow, localRuntimeDir } = makeHarness(t);
  const parent = path.dirname(localRuntimeDir);
  const names = [
    'local-runtime.broken.2026-01-01T00-00-00-000Z',
    'local-runtime.broken.2026-02-01T00-00-00-000Z',
    'local-runtime.broken.2026-03-01T00-00-00-000Z',
    'local-runtime.broken.2026-04-01T00-00-00-000Z'
  ];
  for (const name of names) {
    fs.mkdirSync(path.join(parent, name), { recursive: true });
  }

  flow.cleanupOldBrokenRuntimeDirs(2);

  const remaining = fs.readdirSync(parent).filter((name) => name.startsWith('local-runtime.broken.'));
  assert.deepStrictEqual(remaining.sort(), names.slice(2).sort());
});

test('isPortable detects portable data root and marker file', (t) => {
  const portable = makeHarness(t, { portableRoot: '/portable' });
  assert.strictEqual(portable.flow.isPortable(), true);

  const marked = makeHarness(t);
  fs.mkdirSync(path.join(marked.root, 'app'), { recursive: true });
  assert.strictEqual(marked.flow.isPortable(), false);
  fs.mkdirSync(path.join(marked.root, 'app', 'portable-data'), { recursive: true });
  assert.strictEqual(marked.flow.isPortable(), true);
});

test('revertToFactoryRuntime removes the hot runtime, restarts and reports success', async (t) => {
  const harness = makeHarness(t);
  fs.mkdirSync(harness.localRuntimeDir, { recursive: true });
  fs.writeFileSync(path.join(harness.localRuntimeDir, 'package.json'), '{}');

  await harness.flow.revertToFactoryRuntime();

  assert.strictEqual(fs.existsSync(harness.localRuntimeDir), false);
  assert.strictEqual(harness.calls.restart, 1);
  assert.strictEqual(harness.dialogs.length, 1);
  assert.strictEqual(harness.dialogs[0].type, 'info');
});

test('runUpdateCheck stays silent when nothing is newer and silent flag is set', async (t) => {
  const harness = makeHarness(t, {
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.1.0',
        checkShellVersion: async () => '0.2.1'
      }
    }
  });

  await harness.flow.runUpdateCheck(true);

  assert.strictEqual(harness.dialogs.length, 0);
  assert.strictEqual(harness.calls.restart, 0);
  assert.strictEqual(harness.calls.pnpmAdds.length, 0);
});

test('runUpdateCheck reports up-to-date state when not silent', async (t) => {
  const harness = makeHarness(t, {
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.1.0',
        checkShellVersion: async () => '0.2.1'
      }
    }
  });

  await harness.flow.runUpdateCheck(false);

  assert.strictEqual(harness.dialogs.length, 1);
  assert.strictEqual(harness.dialogs[0].message, 'dialog.updateCheck.upToDate');
});

test('core-only update installs the hot runtime and restarts the backend', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.2.0',
        checkShellVersion: async () => '0.2.1',
        checkReleaseAssets: async () => null
      }
    }
  });

  await harness.flow.runUpdateCheck(false);

  assert.deepStrictEqual(harness.calls.pnpmAdds, [['@deepseek-ai/dsh@0.2.0']]);
  assert.ok(fs.existsSync(path.join(harness.localRuntimeDir, 'package.json')));
  assert.strictEqual(harness.calls.restart, 1);
  const lastDialog = harness.dialogs[harness.dialogs.length - 1];
  assert.match(lastDialog.message, /^dialog\.hotUpdate\.successMessage/);
});

test('cancelling the update dialog performs no mutation', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 2 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.9.0',
        checkShellVersion: async () => '0.9.0',
        checkReleaseAssets: async () => null
      }
    }
  });

  await harness.flow.runUpdateCheck(false);

  assert.strictEqual(harness.calls.pnpmAdds.length, 0);
  assert.strictEqual(harness.calls.restart, 0);
  assert.strictEqual(harness.calls.exit, 0);
});

test('shell update stops before install when the hash does not match', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.1.0',
        checkShellVersion: async () => '0.3.0',
        checkReleaseAssets: async () => ({
          installerUrl: 'https://example.com/DeepSeek-Harness-Setup.exe',
          sha256: 'deadbeef'
        })
      },
      updater: {
        downloadWithProxies: async () => {},
        verifyInstallerIntegrity: () => ({ ok: false, reason: 'hash-mismatch' })
      }
    }
  });

  await harness.flow.runUpdateCheck(false);

  assert.strictEqual(harness.errors.length, 1);
  assert.strictEqual(harness.errors[0].title, 'error.integrityCheckFailed');
  assert.strictEqual(harness.calls.exit, 0);
  assert.strictEqual(harness.calls.restart, 0);
});

test('shell update refuses installer urls without an exe name', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.1.0',
        checkShellVersion: async () => '0.3.0',
        checkReleaseAssets: async () => ({
          installerUrl: 'https://example.com/payload.bat',
          sha256: 'deadbeef'
        })
      },
      updater: {
        downloadWithProxies: async () => {
          throw new Error('must not download');
        },
        verifyInstallerIntegrity: () => ({ ok: true, verified: true, actual: 'a'.repeat(64) })
      }
    }
  });

  await harness.flow.runUpdateCheck(false);

  assert.strictEqual(harness.errors.length, 1);
  assert.strictEqual(harness.errors[0].title, 'error.integrityCheckFailed');
  assert.strictEqual(harness.calls.exit, 0);
});

test('portable shell update reveals the installer instead of running it', async (t) => {
  const harness = makeHarness(t, {
    portableRoot: '/portable',
    messageBoxResponse: { response: 0 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.1.0',
        checkShellVersion: async () => '0.3.0',
        checkReleaseAssets: async () => ({
          installerUrl: 'https://example.com/DeepSeek-Harness-Setup.exe',
          sha256: 'deadbeef'
        })
      },
      updater: {
        downloadWithProxies: async () => {},
        verifyInstallerIntegrity: () => ({ ok: true, verified: true, actual: 'a'.repeat(64) })
      }
    }
  });

  await harness.flow.runUpdateCheck(false);

  assert.strictEqual(harness.folders.length, 1);
  assert.ok(harness.folders[0].endsWith('DeepSeek-Harness-Setup.exe'));
  assert.strictEqual(harness.calls.exit, 0);
  assert.strictEqual(harness.calls.restart, 0);
  const portableDialog = harness.dialogs[harness.dialogs.length - 1];
  assert.strictEqual(portableDialog.message, 'dialog.shellUpdate.portableMessage');
});

test('concurrent update checks collapse into a single run', async (t) => {
  let coreChecks = 0;
  const harness = makeHarness(t, {
    modules: {
      updateCheck: {
        checkCoreVersion: async () => {
          coreChecks += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return '0.1.0';
        },
        checkShellVersion: async () => '0.2.1'
      }
    }
  });

  await Promise.all([harness.flow.runUpdateCheck(true), harness.flow.runUpdateCheck(true)]);

  assert.strictEqual(coreChecks, 1);
});
