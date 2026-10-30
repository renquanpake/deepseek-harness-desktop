'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveDshEntry,
  resolveDshCommand,
  readDshVersion,
  buildLaunchArgs,
  parseAuthenticatedUrl,
  isVersionSupported,
  describeSupportRange
} = require('../lib/dsh-adapter');

function makeRuntime(t, manifest, files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkgDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(pkgDir, { recursive: true });
  if (manifest) {
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest));
  }
  for (const file of files) {
    const full = path.join(pkgDir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  return root;
}

test('resolveDshEntry follows the package bin map', (t) => {
  const root = makeRuntime(t, { name: '@deepseek-ai/dsh', version: '0.2.1', bin: { dsh: 'lib/cli.js' } }, ['lib/cli.js']);
  assert.strictEqual(resolveDshEntry(root), path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'cli.js'));
});

test('resolveDshEntry accepts a string bin and falls back to known layouts', (t) => {
  const stringBin = makeRuntime(t, { version: '0.2.1', bin: 'bin/dsh.js' }, ['bin/dsh.js']);
  assert.ok(resolveDshEntry(stringBin).endsWith(path.join('bin', 'dsh.js')));

  const fallback = makeRuntime(t, { version: '0.2.1' }, ['bin/dsh.mjs']);
  assert.ok(resolveDshEntry(fallback).endsWith(path.join('bin', 'dsh.mjs')));

  const legacy = makeRuntime(t, { version: '0.2.1' }, ['lib/bin.js']);
  assert.ok(resolveDshEntry(legacy).endsWith(path.join('lib', 'bin.js')));
});

test('resolveDshEntry returns null when no entry exists', (t) => {
  const root = makeRuntime(t, { version: '0.2.1' }, []);
  assert.strictEqual(resolveDshEntry(root), null);
  assert.strictEqual(resolveDshCommand(root, 'linux'), null);
});

test('resolveDshCommand finds the pnpm bin shim', (t) => {
  const root = makeRuntime(t, { version: '0.2.1' }, []);
  const binDir = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '');
  assert.ok(resolveDshCommand(root, 'win32').endsWith('dsh.cmd'));
  assert.strictEqual(resolveDshCommand(root, 'linux'), null);
});

test('readDshVersion tolerates missing manifests and bad json', (t) => {
  const good = makeRuntime(t, { version: '0.2.0' });
  assert.strictEqual(readDshVersion(good), '0.2.0');

  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adapter-empty-'));
  t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
  assert.strictEqual(readDshVersion(missing), null);

  const broken = makeRuntime(t, null, []);
  fs.writeFileSync(path.join(broken, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{not json');
  assert.strictEqual(readDshVersion(broken), null);
});

test('buildLaunchArgs keeps the flags the shell depends on', () => {
  assert.deepStrictEqual(buildLaunchArgs({ port: 3080 }), ['web', '--no-open', '--port', '3080']);
  assert.deepStrictEqual(buildLaunchArgs({ port: 3080, safeMode: true }), ['web', '--no-open', '--port', '3080', '--safe-mode']);
  assert.deepStrictEqual(buildLaunchArgs({}), ['web', '--no-open']);
});

test('parseAuthenticatedUrl accepts common upstream output shapes', () => {
  const expected = 'http://127.0.0.1:3080/?token=abc123';
  const samples = [
    `dsh web: ${expected}`,
    `[dsh] dsh web: ${expected} (press Ctrl+C to stop)`,
    `\u001b[32mdsh web: ${expected}\u001b[0m`,
    `Listening on ${expected}`,
    `"${expected}"`,
    `see (${expected}).`
  ];
  for (const sample of samples) {
    assert.strictEqual(parseAuthenticatedUrl(sample, { port: 3080 }), expected, sample);
  }
});

test('parseAuthenticatedUrl rejects urls without a token or wrong port', () => {
  assert.strictEqual(parseAuthenticatedUrl('dsh web: http://127.0.0.1:3080/', { port: 3080 }), null);
  assert.strictEqual(parseAuthenticatedUrl('dsh web: http://127.0.0.1:4000/?token=x', { port: 3080 }), null);
  assert.strictEqual(parseAuthenticatedUrl('dsh web: http://example.com:3080/?token=x', { port: 3080 }), null);
  assert.strictEqual(parseAuthenticatedUrl('', { port: 3080 }), null);
  assert.strictEqual(parseAuthenticatedUrl(null), null);
  assert.strictEqual(parseAuthenticatedUrl('http://localhost:3080/?token=y', { port: 3080 }), 'http://localhost:3080/?token=y');
});

test('isVersionSupported guards the tested range', () => {
  assert.strictEqual(isVersionSupported('0.1.0-rc.6'), true);
  assert.strictEqual(isVersionSupported('0.2.1-rc.2'), true);
  assert.strictEqual(isVersionSupported('0.2.9'), true);
  assert.strictEqual(isVersionSupported('0.3.0'), false);
  assert.strictEqual(isVersionSupported('0.0.9'), false);
  assert.strictEqual(isVersionSupported('garbage'), false);
  assert.strictEqual(isVersionSupported(null), false);
  assert.strictEqual(describeSupportRange(), '>=0.1.0-0 <0.3.0');
});
