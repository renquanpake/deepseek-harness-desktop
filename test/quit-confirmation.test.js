'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createQuitConfirmation } = require('../src/quit-confirmation');

function translate(key, vars) {
  if (!vars) return key;
  return `${key}:${JSON.stringify(vars)}`;
}

function makeHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dialogs = [];
  const dialog = {
    showMessageBox: async (window, opts) => {
      dialogs.push(opts);
      if (typeof options.respond === 'function') return options.respond(opts);
      return options.response || { response: 1 };
    }
  };

  const confirmation = createQuitConfirmation({
    dialog,
    t: translate,
    getMainWindow: () => (options.noWindow ? null : {}),
    getBackendStatus: options.status === undefined
      ? () => ({ ready: true, engine: 'win-native', port: 3080 })
      : () => options.status,
    markerPath: options.markerPath === undefined ? path.join(root, 'background-close-confirmed') : options.markerPath,
    log: { warn: () => {} }
  });

  return { confirmation, dialogs, root };
}

test('first window close asks before hiding to tray and remembers the answer', (t) => {
  const { confirmation, dialogs, root } = makeHarness(t, { response: { response: 1 } });
  const marker = path.join(root, 'background-close-confirmed');

  return confirmation.confirmBackgroundHide().then((allowed) => {
    assert.strictEqual(allowed, true);
    assert.strictEqual(dialogs.length, 1);
    assert.strictEqual(dialogs[0].type, 'info');
    assert.ok(fs.existsSync(marker));
    return confirmation.confirmBackgroundHide();
  }).then((allowedAgain) => {
    assert.strictEqual(allowedAgain, true);
    assert.strictEqual(dialogs.length, 1, 'second hide must not ask again');
  });
});

test('cancelling the first hide keeps the window visible and writes no marker', async (t) => {
  const { confirmation, root } = makeHarness(t, { response: { response: 0 } });
  const allowed = await confirmation.confirmBackgroundHide();
  assert.strictEqual(allowed, false);
  assert.strictEqual(fs.existsSync(path.join(root, 'background-close-confirmed')), false);
});

test('an existing marker skips the hide dialog', async (t) => {
  const { confirmation, dialogs, root } = makeHarness(t);
  fs.writeFileSync(path.join(root, 'background-close-confirmed'), 'yes\n');

  const scoped = createQuitConfirmation({
    dialog: { showMessageBox: async () => { dialogs.push('called'); } },
    t: translate,
    getMainWindow: () => ({}),
    getBackendStatus: () => ({ ready: false }),
    markerPath: path.join(root, 'background-close-confirmed')
  });

  assert.strictEqual(await scoped.confirmBackgroundHide(), true);
  assert.deepStrictEqual(dialogs, []);
  assert.strictEqual(confirmation.isBackgroundHideConfirmed(), false);
});

test('quit is allowed without a dialog when the backend is not running', async (t) => {
  const { confirmation, dialogs } = makeHarness(t, { status: { ready: false } });
  assert.strictEqual(await confirmation.confirmQuit(), true);
  assert.deepStrictEqual(dialogs, []);
});

test('quit asks for confirmation while the backend is running', async (t) => {
  const { confirmation, dialogs } = makeHarness(t, { response: { response: 0 } });
  const allowed = await confirmation.confirmQuit();

  assert.strictEqual(allowed, true);
  assert.strictEqual(dialogs.length, 1);
  assert.strictEqual(dialogs[0].type, 'question');
  assert.strictEqual(dialogs[0].defaultId, 1, 'cancel must be the default');
  assert.strictEqual(dialogs[0].cancelId, 1);
  assert.match(dialogs[0].detail, /win-native/);
  assert.match(dialogs[0].detail, /127\.0\.0\.1:3080/);
});

test('cancelling the quit dialog keeps the app running', async (t) => {
  const { confirmation } = makeHarness(t, { response: { response: 1 } });
  assert.strictEqual(await confirmation.confirmQuit(), false);
});

test('a failing dialog fails closed for quit and hide', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const confirmation = createQuitConfirmation({
    dialog: {
      showMessageBox: async () => {
        throw new Error('no display');
      }
    },
    t: translate,
    getMainWindow: () => ({}),
    getBackendStatus: () => ({ ready: true }),
    markerPath: path.join(root, 'marker'),
    log: { warn: () => {} }
  });

  assert.strictEqual(await confirmation.confirmQuit(), false);
  assert.strictEqual(await confirmation.confirmBackgroundHide(), false);
});

test('a missing window never blocks quitting or hiding', async (t) => {
  const { confirmation } = makeHarness(t, { noWindow: true });
  assert.strictEqual(await confirmation.confirmQuit(), true);
  assert.strictEqual(await confirmation.confirmBackgroundHide(), true);
});
