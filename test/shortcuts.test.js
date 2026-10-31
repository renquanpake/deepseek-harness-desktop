'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createShortcutController, RELAY_SHORTCUT, RELAY_FALLBACK } = require('../src/shortcuts');

function makeHarness(options = {}) {
  const registered = [];
  const warnings = [];
  const controller = createShortcutController({
    globalShortcut: {
      register: (accelerator) => {
        registered.push(accelerator);
        if (options.failAll) return false;
        if (options.failPrimary && accelerator === RELAY_SHORTCUT) return false;
        return true;
      }
    },
    toggleWindow: () => {},
    warn: (message) => warnings.push(message)
  });
  return { controller, registered, warnings };
}

test('register uses the fixed relay shortcut', () => {
  const harness = makeHarness();
  assert.strictEqual(harness.controller.register(), RELAY_SHORTCUT);
  assert.deepStrictEqual(harness.registered, [RELAY_SHORTCUT]);
});

test('register falls back when the primary accelerator is taken', () => {
  const harness = makeHarness({ failPrimary: true });
  assert.strictEqual(harness.controller.register(), RELAY_FALLBACK);
  assert.deepStrictEqual(harness.registered, [RELAY_SHORTCUT, RELAY_FALLBACK]);
  assert.match(harness.warnings[0], /occupied/);
});

test('register reports null when both accelerators fail', () => {
  const harness = makeHarness({ failAll: true });
  assert.strictEqual(harness.controller.register(), null);
  assert.strictEqual(harness.warnings.length, 2);
});
