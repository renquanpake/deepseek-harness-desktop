'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULTS,
  normalizeAccelerator,
  normalizeBindings,
  loadKeybindings,
  saveKeybindings,
  ensureKeybindingFile
} = require('../lib/keybindings');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-keys-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('normalizeAccelerator canonicalizes modifiers and key casing', () => {
  assert.strictEqual(normalizeAccelerator('alt+space'), 'Alt+Space');
  assert.strictEqual(normalizeAccelerator('  Ctrl + alt + d '), 'Control+Alt+D');
  assert.strictEqual(normalizeAccelerator('cmdorctrl+shift+f12'), 'CommandOrControl+Shift+F12');
  assert.strictEqual(normalizeAccelerator('f12'), 'F12');
  assert.strictEqual(normalizeAccelerator('Alt+A+B'), null, 'only one non-modifier key is allowed');
  assert.strictEqual(normalizeAccelerator('Alt+Space+Shift'), 'Alt+Shift+Space');
});

test('normalizeAccelerator rejects junk and over-long values', () => {
  for (const value of [null, '', 42, 'Alt+', '+D', 'Alt+NotAKey', 'A'.repeat(80), 'Alt+D+E']) {
    assert.strictEqual(normalizeAccelerator(value), null, String(value));
  }
});

test('normalizeBindings fills defaults and reports unknown accelerator errors', () => {
  const good = normalizeBindings({ relayShortcut: 'Ctrl+Shift+Space' });
  assert.strictEqual(good.valid, true);
  assert.strictEqual(good.bindings.relayShortcut, 'Control+Shift+Space');
  assert.strictEqual(good.bindings.toggleDevTools, DEFAULTS.toggleDevTools);

  const bad = normalizeBindings({ relayShortcut: 'Nope' });
  assert.strictEqual(bad.valid, false);
  assert.strictEqual(bad.bindings.relayShortcut, DEFAULTS.relayShortcut);
  assert.strictEqual(bad.errors.length, 1);

  const conflicting = normalizeBindings({ relayShortcut: 'Alt+D', relayFallback: 'alt+d' });
  assert.strictEqual(conflicting.valid, false);
  assert.strictEqual(conflicting.bindings.relayFallback, DEFAULTS.relayFallback);
});

test('normalizeBindings rejects non-object payloads', () => {
  for (const value of [null, [], 'x', 7]) {
    const result = normalizeBindings(value);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.bindings, { ...DEFAULTS });
  }
});

test('loadKeybindings returns defaults when the file is missing', (t) => {
  const root = makeRoot(t);
  const result = loadKeybindings(path.join(root, 'keybindings.json'));
  assert.strictEqual(result.source, 'default');
  assert.deepStrictEqual(result.bindings, { ...DEFAULTS });
  assert.deepStrictEqual(result.errors, []);
});

test('loadKeybindings reads valid files and flags invalid JSON', (t) => {
  const root = makeRoot(t);
  const file = path.join(root, 'keybindings.json');
  fs.writeFileSync(file, JSON.stringify({ toggleDevTools: 'ctrl+shift+i' }));

  const valid = loadKeybindings(file);
  assert.strictEqual(valid.source, 'file');
  assert.strictEqual(valid.bindings.toggleDevTools, 'Control+Shift+I');
  assert.strictEqual(valid.bindings.relayShortcut, DEFAULTS.relayShortcut);

  fs.writeFileSync(file, '{not json');
  const invalid = loadKeybindings(file);
  assert.strictEqual(invalid.source, 'invalid');
  assert.deepStrictEqual(invalid.bindings, { ...DEFAULTS });
  assert.match(invalid.errors[0], /JSON/);
});

test('saveKeybindings writes normalized bindings atomically and replaces the temp file', (t) => {
  const root = makeRoot(t);
  const file = path.join(root, 'nested', 'keybindings.json');

  const saved = saveKeybindings(file, { relayShortcut: 'alt+shift+d' });

  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.bindings.relayShortcut, 'Alt+Shift+D');
  assert.ok(fs.existsSync(file));
  assert.strictEqual(fs.existsSync(`${file}.tmp`), false);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.relayShortcut, 'Alt+Shift+D');
  assert.strictEqual(onDisk.toggleDevTools, 'F12');
});

test('saveKeybindings reports disk errors without throwing', (t) => {
  const root = makeRoot(t);
  const result = saveKeybindings(path.join(root, 'x', 'keybindings.json'), DEFAULTS, {
    mkdirSync: () => {},
    writeFileSync: () => {
      throw new Error('EACCES');
    },
    renameSync: () => {}
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /EACCES/);
});

test('ensureKeybindingFile creates a default file exactly once', (t) => {
  const root = makeRoot(t);
  const file = path.join(root, 'keybindings.json');

  const first = ensureKeybindingFile(file);
  assert.strictEqual(first.created, true);
  assert.ok(fs.existsSync(file));

  const second = ensureKeybindingFile(file);
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.source, 'file');
});
