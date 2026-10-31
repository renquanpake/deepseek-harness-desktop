'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const updaterPath = require.resolve('../lib/updater');
const updateCheckPath = require.resolve('../lib/update-check');
const updateFlowPath = require.resolve('../src/update-flow');
const { createUpdateJournal } = require('../lib/update-journal');

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
  const opened = [];
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
    shell: {
      showItemInFolder: (file) => folders.push(file),
      openExternal: (url) => opened.push(url)
    },
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
    hooks,
    journal: options.journal || createUpdateJournal({ dir: path.join(root, 'update-journal'), log: { warn: () => {} } }),
    verifyRuntime: options.verifyRuntime || (async () => ({ ok: true, steps: [] }))
  });

  return { flow, root, localRuntimeDir, dialogs, errors, folders, opened, calls };
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

test('shell update points users at the repository instead of running an installer', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.1.0',
        checkShellVersion: async () => '0.3.0',
        checkReleaseAssets: async () => {
          throw new Error('installer assets must not be fetched');
        }
      }
    }
  });

  await harness.flow.runUpdateCheck(false);

  assert.strictEqual(harness.errors.length, 0);
  assert.strictEqual(harness.calls.exit, 0);
  assert.strictEqual(harness.calls.restart, 0);
  assert.strictEqual(harness.opened.length, 1);
  assert.match(harness.opened[0], /github\.com\/renquanpake\/deepseek-harness-desktop/);
  const dialog = harness.dialogs[harness.dialogs.length - 1];
  assert.strictEqual(dialog.message, 'dialog.shellUpdate.manualMessage:{"version":"0.3.0"}');
});

test('closing the shell update notice opens nothing', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 1 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.1.0',
        checkShellVersion: async () => '0.3.0',
        checkReleaseAssets: async () => null
      }
    }
  });

  await harness.flow.runUpdateCheck(false);

  assert.strictEqual(harness.opened.length, 0);
  assert.strictEqual(harness.calls.exit, 0);
});

test('core versions outside the verified range are not offered', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.9.0',
        checkShellVersion: async () => '0.2.1',
        checkReleaseAssets: async () => null
      }
    }
  });

  await harness.flow.runUpdateCheck(true);

  assert.strictEqual(harness.calls.pnpmAdds.length, 0);
  assert.strictEqual(harness.calls.restart, 0);
  assert.strictEqual(harness.dialogs.length, 0);
});

test('core versions inside the verified range are still offered', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.2.1',
        checkShellVersion: async () => '0.2.1',
        checkReleaseAssets: async () => null
      }
    }
  });

  await harness.flow.runUpdateCheck(true);

  assert.deepStrictEqual(harness.calls.pnpmAdds, [['@deepseek-ai/dsh@0.2.1']]);
});

test('a core that fails the contract check is quarantined and rolled back', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    verifyRuntime: async () => ({
      ok: false,
      steps: [{ name: 'authenticated index serves the web shell', ok: false, detail: '401' }]
    }),
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.2.1',
        checkShellVersion: async () => '0.2.1',
        checkReleaseAssets: async () => null
      }
    }
  });

  await harness.flow.runUpdateCheck(true);

  assert.strictEqual(harness.calls.pnpmAdds.length, 1);
  assert.strictEqual(fs.existsSync(harness.localRuntimeDir), false, 'unverified core must be quarantined');
  const broken = fs.readdirSync(path.dirname(harness.localRuntimeDir))
    .filter((name) => name.startsWith('local-runtime.broken.'));
  assert.strictEqual(broken.length, 1);
  assert.strictEqual(harness.calls.restart, 1, 'rolls back to the factory runtime');
  assert.strictEqual(harness.errors.length, 1);
  assert.strictEqual(harness.errors[0].title, 'error.autoUpdateFailed');
  assert.match(harness.errors[0].message, /hotUpdateIncompatible/);
});

test('a verified core is recorded as the last good version', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.2.1',
        checkShellVersion: async () => '0.2.1',
        checkReleaseAssets: async () => null
      }
    }
  });

  await harness.flow.runUpdateCheck(true);

  const marker = path.join(path.dirname(harness.localRuntimeDir), 'last-good-core.json');
  assert.strictEqual(fs.existsSync(marker), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).version, '0.2.1');
});

test('a failed verification restores the last good core instead of the factory one', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    verifyRuntime: async () => ({
      ok: false,
      steps: [{ name: 'authenticated index serves the web shell', ok: false, detail: '401' }]
    }),
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.2.1',
        checkShellVersion: async () => '0.2.1',
        checkReleaseAssets: async () => null
      }
    }
  });
  const marker = path.join(path.dirname(harness.localRuntimeDir), 'last-good-core.json');
  fs.writeFileSync(marker, JSON.stringify({ version: '0.2.0', verifiedAt: '2026-10-01T00:00:00.000Z' }));

  await harness.flow.runUpdateCheck(true);

  assert.deepStrictEqual(harness.calls.pnpmAdds, [
    ['@deepseek-ai/dsh@0.2.1'],
    ['@deepseek-ai/dsh@0.2.0']
  ]);
  assert.strictEqual(harness.calls.restart, 1);
  const broken = fs.readdirSync(path.dirname(harness.localRuntimeDir))
    .filter((name) => name.startsWith('local-runtime.broken.'));
  assert.strictEqual(broken.length, 1);
  assert.strictEqual(fs.existsSync(harness.localRuntimeDir), true, 'restored runtime stays in place');
  assert.strictEqual(harness.errors.length, 1);
  assert.match(harness.errors[0].message, /hotUpdateRolledBackToLastGood/);
});

test('a successful core update records its phases in the journal', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.2.1',
        checkShellVersion: async () => '0.2.1',
        checkReleaseAssets: async () => null
      }
    }
  });

  await harness.flow.runUpdateCheck(true);

  const journalFile = path.join(harness.root, 'update-journal', 'update-journal.jsonl');
  const events = fs.readFileSync(journalFile, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line).event);
  assert.deepStrictEqual(events, [
    'check-start',
    'install-start',
    'verify-ok',
    'promote',
    'check-done'
  ]);
});

test('a rejected core records verification and fallback phases', async (t) => {
  const harness = makeHarness(t, {
    messageBoxResponse: { response: 0 },
    verifyRuntime: async () => ({
      ok: false,
      steps: [{ name: 'authenticated index serves the web shell', ok: false, detail: '401' }]
    }),
    modules: {
      updateCheck: {
        checkCoreVersion: async () => '0.2.1',
        checkShellVersion: async () => '0.2.1',
        checkReleaseAssets: async () => null
      }
    }
  });

  await harness.flow.runUpdateCheck(true);

  const journalFile = path.join(harness.root, 'update-journal', 'update-journal.jsonl');
  const events = fs.readFileSync(journalFile, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line).event);
  assert.deepStrictEqual(events, [
    'check-start',
    'install-start',
    'verify-failed',
    'factory-fallback',
    'check-done'
  ]);
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
