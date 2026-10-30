'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildLauncherContent,
  computePathUpdate,
  removePathEntry,
  createCliInstaller,
  LAUNCHER_NAME
} = require('../lib/cli-install');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeHarness(t, options = {}) {
  const root = makeRoot(t);
  const dshEntry = path.join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs');
  fs.mkdirSync(path.dirname(dshEntry), { recursive: true });
  fs.writeFileSync(dshEntry, '#!/usr/bin/env node\n');
  const state = { path: options.userPath || 'C:\\Windows\\system32;C:\\Tools' };
  const writes = [];
  const installer = createCliInstaller({
    binDir: path.join(root, 'bin'),
    getNodeExe: () => 'C:\\Program Files\\DeepSeek Harness\\node.exe',
    getDshEntry: () => dshEntry,
    readUserPath: () => state.path,
    writeUserPath: (value) => {
      writes.push(value);
      state.path = value;
    },
    platform: 'win32',
    log: { warn: () => {} }
  });
  return { installer, root, state, writes, dshEntry };
}

test('launcher content quotes both paths and forwards all arguments', () => {
  const content = buildLauncherContent({
    nodeExe: 'C:\\Program Files\\DSH\\node.exe',
    dshEntry: 'C:\\Users\\dev\\AppData\\dsh.mjs'
  });
  assert.match(content, /^@echo off\r\n/);
  assert.match(content, /"C:\\Program Files\\DSH\\node\.exe" "C:\\Users\\dev\\AppData\\dsh\.mjs" %\*/);
});

test('computePathUpdate appends the bin dir once and is case insensitive', () => {
  const first = computePathUpdate('C:\\Windows;C:\\Tools', 'C:\\Users\\dev\\bin');
  assert.strictEqual(first.changed, true);
  assert.strictEqual(first.value, 'C:\\Windows;C:\\Tools;C:\\Users\\dev\\bin');

  const again = computePathUpdate('C:\\Windows;c:\\users\\DEV\\BIN\\', 'C:\\Users\\dev\\bin');
  assert.strictEqual(again.changed, false);
  assert.strictEqual(again.value, 'C:\\Windows;c:\\users\\DEV\\BIN\\');
});

test('computePathUpdate ignores empty entries', () => {
  const update = computePathUpdate('C:\\A;;; C:\\B ;', 'C:\\bin');
  assert.strictEqual(update.value, 'C:\\A;C:\\B;C:\\bin');
});

test('removePathEntry drops only the matching entry', () => {
  const result = removePathEntry('C:\\A;C:\\bin;C:\\B', 'c:\\BIN');
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.value, 'C:\\A;C:\\B');

  const untouched = removePathEntry('C:\\A;C:\\B', 'C:\\bin');
  assert.strictEqual(untouched.changed, false);
  assert.strictEqual(untouched.value, 'C:\\A;C:\\B');
});

test('install writes the launcher and registers the bin directory', (t) => {
  const harness = makeHarness(t);

  const result = harness.installer.install();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.pathChanged, true);
  const launcher = path.join(harness.root, 'bin', LAUNCHER_NAME);
  assert.ok(fs.existsSync(launcher));
  const content = fs.readFileSync(launcher, 'utf8');
  assert.match(content, /node\.exe/);
  assert.match(content, /dsh\.mjs/);
  assert.strictEqual(harness.writes.length, 1);
  assert.match(harness.state.path, /bin$/);

  const status = harness.installer.status();
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.inPath, true);
  assert.strictEqual(status.runtimePresent, true);
});

test('install is idempotent and does not rewrite an unchanged PATH', (t) => {
  const harness = makeHarness(t);
  harness.installer.install();
  const writesAfterFirst = harness.writes.length;

  const second = harness.installer.install();

  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.pathChanged, false);
  assert.strictEqual(harness.writes.length, writesAfterFirst);
});

test('repair rewrites a missing launcher without duplicating PATH entries', (t) => {
  const harness = makeHarness(t);
  harness.installer.install();
  fs.rmSync(path.join(harness.root, 'bin', 'dsh.cmd'));
  assert.strictEqual(harness.installer.status().installed, false);

  const repaired = harness.installer.repair();

  assert.strictEqual(repaired.ok, true);
  assert.strictEqual(repaired.pathChanged, false);
  assert.strictEqual(harness.installer.status().installed, true);
});

test('remove deletes the launcher and drops only its PATH entry', (t) => {
  const harness = makeHarness(t);
  harness.installer.install();

  const result = harness.installer.remove();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.launcherRemoved, true);
  assert.strictEqual(result.pathChanged, true);
  assert.strictEqual(fs.existsSync(path.join(harness.root, 'bin', 'dsh.cmd')), false);
  assert.doesNotMatch(harness.state.path, /\\bin$/);
  assert.match(harness.state.path, /C:\\Windows\\system32/);
});

test('missing bundled runtime is reported instead of writing a broken launcher', (t) => {
  const root = makeRoot(t);
  const installer = createCliInstaller({
    binDir: path.join(root, 'bin'),
    getNodeExe: () => null,
    getDshEntry: () => null,
    readUserPath: () => '',
    writeUserPath: () => {},
    platform: 'win32',
    log: { warn: () => {} }
  });

  const result = installer.install();
  assert.deepStrictEqual(result, { ok: false, reason: 'missing-runtime' });
});

test('non-windows platforms refuse to install', (t) => {
  const harness = makeHarness(t);
  const installer = createCliInstaller({
    binDir: path.join(harness.root, 'bin'),
    getNodeExe: () => '/usr/bin/node',
    getDshEntry: () => harness.dshEntry,
    readUserPath: () => '',
    writeUserPath: () => {},
    platform: 'linux',
    log: { warn: () => {} }
  });

  assert.deepStrictEqual(installer.install(), { ok: false, reason: 'unsupported-platform' });
  assert.deepStrictEqual(installer.remove(), { ok: false, reason: 'unsupported-platform' });
});
