'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pruneRuntime, parseArgs, shouldRemoveFile, shouldKeepFile } = require('../scripts/prune-runtime');

function makeRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, content = 'x') => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('node_modules/@deepseek-ai/dsh/package.json', '{"name":"@deepseek-ai/dsh","version":"0.2.1"}');
  write('node_modules/@deepseek-ai/dsh/lib/bin.js', '#' .repeat(10));
  write('node_modules/@deepseek-ai/dsh/lib/bin.js.map', 'x'.repeat(100));
  write('node_modules/@deepseek-ai/dsh/README.md', 'x'.repeat(100));
  write('node_modules/@deepseek-ai/dsh/LICENSE', 'MIT');
  write('node_modules/some-pkg/index.js', 'console.log(1)');
  write('node_modules/some-pkg/index.d.ts', 'x'.repeat(50));
  write('node_modules/some-pkg/src/main.ts', 'x'.repeat(50));
  write('node_modules/some-pkg/tests/a.test.js', 'x');
  write('node_modules/some-pkg/native.node', 'x');
  return root;
}

test('prunes non-runtime files and keeps runtime files and licenses', (t) => {
  const root = makeRuntime(t);
  const result = pruneRuntime({ runtimeDir: root, log: { warn: () => {} } });

  assert.strictEqual(result.ok, true);
  assert.ok(result.freedBytes > 0);
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  assert.strictEqual(exists('node_modules/@deepseek-ai/dsh/lib/bin.js'), true);
  assert.strictEqual(exists('node_modules/@deepseek-ai/dsh/lib/bin.js.map'), false);
  assert.strictEqual(exists('node_modules/@deepseek-ai/dsh/README.md'), false);
  assert.strictEqual(exists('node_modules/@deepseek-ai/dsh/LICENSE'), true);
  assert.strictEqual(exists('node_modules/some-pkg/index.js'), true);
  assert.strictEqual(exists('node_modules/some-pkg/index.d.ts'), false);
  assert.strictEqual(exists('node_modules/some-pkg/src/main.ts'), false);
  assert.strictEqual(exists('node_modules/some-pkg/tests'), false);
  assert.strictEqual(exists('node_modules/some-pkg/native.node'), true);
});

test('dry run reports without deleting', (t) => {
  const root = makeRuntime(t);
  const result = pruneRuntime({ runtimeDir: root, dryRun: true, log: { warn: () => {} } });
  assert.strictEqual(result.dryRun, true);
  assert.ok(result.freedBytes > 0);
  assert.strictEqual(fs.existsSync(path.join(root, 'node_modules/some-pkg/index.d.ts')), true);
});

test('refuses a directory without a prepared runtime', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prune-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = pruneRuntime({ runtimeDir: root, log: { warn: () => {} } });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'runtime-not-prepared');
});

test('file classification keeps licenses and drops docs and types', () => {
  assert.strictEqual(shouldRemoveFile('a.js.map'), true);
  assert.strictEqual(shouldRemoveFile('readme.md'), true);
  assert.strictEqual(shouldRemoveFile('types.d.ts'), true);
  assert.strictEqual(shouldRemoveFile('source.ts'), true);
  assert.strictEqual(shouldRemoveFile('index.js'), false);
  assert.strictEqual(shouldRemoveFile('native.node'), false);
  assert.strictEqual(shouldKeepFile('LICENSE'), true);
  assert.strictEqual(shouldKeepFile('LICENSE.md'), true);
  assert.strictEqual(shouldKeepFile('NOTICE'), true);
});

test('parseArgs defaults to dsh-runtime', () => {
  const defaults = parseArgs([]);
  assert.strictEqual(defaults.runtimeDir, path.join(process.cwd(), 'dsh-runtime'));
  assert.strictEqual(defaults.dryRun, false);
  const custom = parseArgs(['--runtime-dir', '/tmp/rt', '--dry-run']);
  assert.strictEqual(custom.runtimeDir, path.resolve('/tmp/rt'));
  assert.strictEqual(custom.dryRun, true);
});
