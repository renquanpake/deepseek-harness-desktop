'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkRuntime, parseArgs } = require('../scripts/check-runtime-compat');

function makeRuntime(t, { version = '0.2.1', entry = 'bin/dsh.mjs', pnpm = true, preset = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkgDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(pkgDir, { recursive: true });
  if (version !== null) {
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  }
  if (entry) {
    fs.mkdirSync(path.dirname(path.join(pkgDir, entry)), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, entry), '');
  }
  if (pnpm) {
    fs.mkdirSync(path.join(root, 'node_modules', 'pnpm', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '');
  }
  if (preset) {
    fs.mkdirSync(path.join(root, 'default-profile', 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'default-profile', 'profiles', 'web', 'package.json'), '{}');
  }
  return root;
}

test('a healthy runtime passes every check', (t) => {
  const runtimeDir = makeRuntime(t);
  const result = checkRuntime({ runtimeDir });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.version, '0.2.1');
  assert.ok(result.entry);
  assert.deepStrictEqual(result.warnings, []);
});

test('versions outside the verified range are rejected', (t) => {
  const runtimeDir = makeRuntime(t, { version: '0.3.0' });
  const result = checkRuntime({ runtimeDir });
  assert.strictEqual(result.ok, false);
  assert.match(result.problems.join('\n'), /超出已验证范围/);
});

test('a missing package manifest is rejected', (t) => {
  const runtimeDir = makeRuntime(t, { version: null });
  const result = checkRuntime({ runtimeDir });
  assert.strictEqual(result.ok, false);
  assert.match(result.problems.join('\n'), /package\.json/);
});

test('a runtime without any launchable entry is rejected', (t) => {
  const runtimeDir = makeRuntime(t, { entry: null });
  const result = checkRuntime({ runtimeDir });
  assert.strictEqual(result.ok, false);
  assert.match(result.problems.join('\n'), /dsh 入口/);
});

test('missing pnpm or preset profile only warns', (t) => {
  const runtimeDir = makeRuntime(t, { pnpm: false, preset: false });
  const result = checkRuntime({ runtimeDir });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.warnings.length, 2);
});

test('parseArgs defaults to the local dsh-runtime directory', () => {
  const defaults = parseArgs([]);
  assert.strictEqual(defaults.runtimeDir, path.join(process.cwd(), 'dsh-runtime'));
  assert.strictEqual(defaults.quiet, false);

  const custom = parseArgs(['--runtime-dir', '/tmp/rt', '--quiet']);
  assert.strictEqual(custom.runtimeDir, path.resolve('/tmp/rt'));
  assert.strictEqual(custom.quiet, true);
});
