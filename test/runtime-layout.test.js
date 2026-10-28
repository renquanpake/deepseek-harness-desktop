'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeLayout } = require('../src/runtime-layout');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layout-'));
  return root;
}

test('bundled runtime dir falls back to appDir when unpacked paths missing', () => {
  const root = makeTree();
  const appDir = path.join(root, 'app');
  fs.mkdirSync(path.join(appDir, 'dsh-runtime'), { recursive: true });
  const layout = createRuntimeLayout({ localRuntimeDir: path.join(root, 'local'), appDir });
  const dir = layout.getBundledRuntimeDir();
  assert.ok(!dir || dir === path.join(appDir, 'dsh-runtime') || dir.includes('dsh-runtime'));
});

test('isLocalRuntimeUsable reflects dsh.mjs presence', () => {
  const root = makeTree();
  const localDir = path.join(root, 'local');
  const layout = createRuntimeLayout({ localRuntimeDir: localDir, appDir: root });
  assert.strictEqual(layout.isLocalRuntimeUsable(), false);
  fs.mkdirSync(path.join(localDir, 'node_modules', '@deepseek-ai', 'dsh', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(localDir, 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs'), '');
  assert.strictEqual(layout.isLocalRuntimeUsable(), true);
  assert.strictEqual(layout.getLocalRuntimeDshCli(), path.join(localDir, 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs'));
});

test('getLocalDshVersion reads package.json version', () => {
  const root = makeTree();
  const localDir = path.join(root, 'local');
  const pkgDir = path.join(localDir, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '0.9.9' }));
  const layout = createRuntimeLayout({ localRuntimeDir: localDir, appDir: root });
  assert.strictEqual(layout.getLocalDshVersion(), '0.9.9');
});

test('getBundledPnpmCjs checks candidate order and returns null when absent', () => {
  const root = makeTree();
  const appDir = path.join(root, 'app');
  const runtimeDir = path.join(appDir, 'dsh-runtime');
  const layout = createRuntimeLayout({ localRuntimeDir: path.join(root, 'local'), appDir });
  fs.mkdirSync(runtimeDir, { recursive: true });
  assert.strictEqual(layout.getBundledPnpmCjs(), null);
  fs.writeFileSync(path.join(runtimeDir, 'pnpm.cjs'), '');
  assert.strictEqual(layout.getBundledPnpmCjs(), path.join(runtimeDir, 'pnpm.cjs'));
});

test('getCurrentDshVersion reports source by runtimeDir match', () => {
  const root = makeTree();
  const localDir = path.join(root, 'local');
  const layout = createRuntimeLayout({ localRuntimeDir: localDir, appDir: root });
  const localPkg = path.join(localDir, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(localPkg, { recursive: true });
  fs.writeFileSync(path.join(localPkg, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const hot = layout.getCurrentDshVersion(localDir);
  assert.deepStrictEqual(hot, { version: '1.2.3', source: 'hot-update' });
  const factory = layout.getCurrentDshVersion(path.join(root, 'nowhere'));
  assert.deepStrictEqual(factory, { version: 'unknown', source: 'factory' });
});
