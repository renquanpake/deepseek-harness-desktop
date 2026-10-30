'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createShortcutController } = require('../src/shortcuts');

function makeHarness(options = {}) {
  const registered = [];
  const warnings = [];
  const logs = [];
  let unregistered = 0;
  let menuRebuilds = 0;
  const loads = [];
  let currentBindings = options.bindings || {
    bindings: { relayShortcut: 'Alt+Space', relayFallback: 'CommandOrControl+Alt+D', toggleDevTools: 'F12' },
    source: 'file',
    errors: []
  };

  const controller = createShortcutController({
    globalShortcut: {
      register: (accelerator) => {
        registered.push(accelerator);
        if (options.failPrimary && accelerator === currentBindings.bindings.relayShortcut) return false;
        if (options.failAll) return false;
        return true;
      },
      unregisterAll: () => {
        unregistered += 1;
      }
    },
    loadBindings: () => {
      loads.push(true);
      return currentBindings;
    },
    toggleWindow: () => {},
    rebuildMenus: () => {
      menuRebuilds += 1;
    },
    operationLog: { append: (type, data) => logs.push({ type, data }) },
    warn: (message) => warnings.push(message)
  });

  return {
    controller,
    registered,
    warnings,
    logs,
    loads,
    get unregistered() {
      return unregistered;
    },
    get menuRebuilds() {
      return menuRebuilds;
    },
    setBindings: (next) => {
      currentBindings = next;
    }
  };
}

test('register uses the configured relay shortcut', () => {
  const harness = makeHarness();
  assert.strictEqual(harness.controller.register(), 'Alt+Space');
  assert.deepStrictEqual(harness.registered, ['Alt+Space']);
});

test('register falls back when the primary accelerator is taken', () => {
  const harness = makeHarness({ failPrimary: true });
  assert.strictEqual(harness.controller.register(), 'CommandOrControl+Alt+D');
  assert.deepStrictEqual(harness.registered, ['Alt+Space', 'CommandOrControl+Alt+D']);
  assert.match(harness.warnings[0], /occupied/);
});

test('register reports null when both accelerators fail', () => {
  const harness = makeHarness({ failAll: true });
  assert.strictEqual(harness.controller.register(), null);
  assert.strictEqual(harness.warnings.length, 2);
});

test('reload re-registers, rebuilds menus and logs the outcome', () => {
  const harness = makeHarness();
  harness.controller.register();

  const result = harness.controller.reload();

  assert.strictEqual(harness.unregistered, 1);
  assert.strictEqual(harness.menuRebuilds, 1);
  assert.strictEqual(result.registered, 'Alt+Space');
  assert.strictEqual(result.source, 'file');
  assert.deepStrictEqual(harness.logs[0], {
    type: 'keybindings-reload',
    data: { source: 'file', errors: 0, registered: 'Alt+Space' }
  });
});

test('reload applies newly loaded bindings', () => {
  const harness = makeHarness();
  harness.controller.register();
  harness.setBindings({
    bindings: { relayShortcut: 'Control+Shift+Space', relayFallback: 'Alt+D', toggleDevTools: 'F12' },
    source: 'file',
    errors: []
  });

  harness.controller.reload();

  assert.strictEqual(harness.controller.getBindings().relayShortcut, 'Control+Shift+Space');
  assert.deepStrictEqual(harness.registered, ['Alt+Space', 'Control+Shift+Space']);
});

test('bindings are loaded once until reload', () => {
  const harness = makeHarness();
  harness.controller.getBindings();
  harness.controller.getBindings();
  assert.strictEqual(harness.loads.length, 1);
});
