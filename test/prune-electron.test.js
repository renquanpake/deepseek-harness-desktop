'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pruneElectron, parseArgs, KEEP_LOCALES } = require('../scripts/prune-electron');

function makeDist(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-dist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'electron.exe'), 'x');
  fs.mkdirSync(path.join(root, 'locales'));
  for (const name of ['en-US.pak', 'zh-CN.pak', 'zh-TW.pak', 'de.pak', 'fr.pak', 'ja.pak']) {
    fs.writeFileSync(path.join(root, 'locales', name), 'x'.repeat(1024));
  }
  return root;
}

test('keeps the three locales and removes the rest', (t) => {
  const root = makeDist(t);
  const result = pruneElectron({ distDir: root, log: { warn: () => {} } });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.removed, 3);
  assert.strictEqual(result.freedBytes, 3 * 1024);
  const remaining = fs.readdirSync(path.join(root, 'locales')).sort();
  assert.deepStrictEqual(remaining, ['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);
});

test('dry run reports without deleting', (t) => {
  const root = makeDist(t);
  const result = pruneElectron({ distDir: root, dryRun: true, log: { warn: () => {} } });
  assert.strictEqual(result.removed, 3);
  assert.strictEqual(fs.readdirSync(path.join(root, 'locales')).length, 6);
});

test('a missing dist is reported without throwing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = pruneElectron({ distDir: root, log: { warn: () => {} } });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'electron-dist-missing');
});

test('parseArgs defaults to node_modules/electron/dist', () => {
  const defaults = parseArgs([]);
  assert.strictEqual(defaults.distDir, path.join(process.cwd(), 'node_modules', 'electron', 'dist'));
  assert.strictEqual(defaults.dryRun, false);
  const custom = parseArgs(['--dist-dir', '/tmp/e', '--dry-run']);
  assert.strictEqual(custom.distDir, path.resolve('/tmp/e'));
  assert.strictEqual(custom.dryRun, true);
  assert.ok(KEEP_LOCALES.has('zh-CN.pak'));
});
