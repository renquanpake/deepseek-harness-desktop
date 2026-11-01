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

const {
  parseWebHelp,
  probeWebCapabilities,
  portFromUrl
} = require('../lib/dsh-adapter');

test('parseWebHelp detects supported flags and rejects unrelated help', () => {
  const full = parseWebHelp('Usage: dsh --profile web [options]\n  --no-open\n  --port <port>\n  --host <host>');
  assert.deepStrictEqual(full, { supportsNoOpen: true, supportsPort: true });

  const deprecated = parseWebHelp('Serve the DeepSeek Harness UI\n  --listen <port>');
  assert.deepStrictEqual(deprecated, { supportsNoOpen: false, supportsPort: false });

  assert.strictEqual(parseWebHelp('Usage: dsh plugin [options]'), null);
  assert.strictEqual(parseWebHelp(''), null);
  assert.strictEqual(parseWebHelp(null), null);
});

test('buildLaunchArgs honours probed capabilities', () => {
  assert.deepStrictEqual(
    buildLaunchArgs({ port: 3080, capabilities: { supportsNoOpen: true, supportsPort: true } }),
    ['web', '--no-open', '--port', '3080']
  );
  assert.deepStrictEqual(
    buildLaunchArgs({ port: 3080, capabilities: { supportsNoOpen: false, supportsPort: true } }),
    ['web', '--port', '3080']
  );
  assert.deepStrictEqual(
    buildLaunchArgs({ port: 3080, capabilities: { supportsNoOpen: true, supportsPort: false } }),
    ['web', '--no-open']
  );
  assert.deepStrictEqual(
    buildLaunchArgs({ port: 3080, safeMode: true, capabilities: { supportsNoOpen: false, supportsPort: false } }),
    ['web', '--safe-mode']
  );
  assert.deepStrictEqual(
    buildLaunchArgs({ port: 0, capabilities: { supportsNoOpen: true, supportsPort: true } }),
    ['web', '--no-open', '--port', '0']
  );
});

test('probeWebCapabilities parses help output and tolerates failures', () => {
  const help = 'Usage: dsh --profile web [options]\n  --no-open\n  --port <port>';
  const probed = probeWebCapabilities({
    entry: '/app/lib/bin.js',
    spawnSyncFn: () => ({ status: 0, stdout: help, stderr: '' })
  });
  assert.deepStrictEqual(probed, { supportsNoOpen: true, supportsPort: true });

  const broken = probeWebCapabilities({
    entry: '/app/lib/bin.js',
    spawnSyncFn: () => {
      throw new Error('spawn failed');
    }
  });
  assert.strictEqual(broken, null);

  assert.strictEqual(probeWebCapabilities({ entry: null }), null);
});

test('portFromUrl extracts a valid port only', () => {
  assert.strictEqual(portFromUrl('http://127.0.0.1:43293/?token=x'), 43293);
  assert.strictEqual(portFromUrl('http://127.0.0.1/?token=x'), null);
  assert.strictEqual(portFromUrl('not-a-url'), null);
  assert.strictEqual(portFromUrl(null), null);
});

const { adoptCapturedPort } = require('../lib/dsh-adapter');

test('adoptCapturedPort only reports a changed port', () => {
  assert.strictEqual(adoptCapturedPort('http://127.0.0.1:43293/?token=x', 3080), 43293);
  assert.strictEqual(adoptCapturedPort('http://127.0.0.1:3080/?token=x', 3080), null);
  assert.strictEqual(adoptCapturedPort('nope', 3080), null);
});

const { validateProfileManifest, readProfileManifest } = require('../lib/dsh-adapter');

test('validateProfileManifest enforces the dsh.profile.bundles shape', () => {
  assert.strictEqual(validateProfileManifest({ dsh: { profile: { bundles: ['a', 'b'] } } }).ok, true);
  assert.strictEqual(validateProfileManifest({ dsh: { profile: { bundles: [] } } }).ok, true);

  const missing = validateProfileManifest({ dsh: {} });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.errors[0], /dsh\.profile/);

  const wrongType = validateProfileManifest({ dsh: { profile: { bundles: 'a' } } });
  assert.strictEqual(wrongType.ok, false);
  assert.match(wrongType.errors[0], /array/);

  const badEntry = validateProfileManifest({ dsh: { profile: { bundles: ['a', 42] } } });
  assert.strictEqual(badEntry.ok, false);
  assert.match(badEntry.errors[0], /non-empty strings/);

  assert.strictEqual(validateProfileManifest(null).ok, false);
});

test('readProfileManifest tolerates missing or broken files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(readProfileManifest(root), null);

  fs.writeFileSync(path.join(root, 'package.json'), '{bad json');
  assert.strictEqual(readProfileManifest(root), null);

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  assert.deepStrictEqual(readProfileManifest(root).dsh.profile.bundles, []);
});

const { capabilityCacheKey, readCapabilityCache, writeCapabilityCache } = require('../lib/dsh-adapter');

test('capability cache round-trips and invalidates on key change', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-caps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'bin.js');
  fs.writeFileSync(entry, '// x');
  const cachePath = path.join(root, 'cache.json');
  const key = capabilityCacheKey(entry);
  assert.ok(key);

  const caps = { supportsNoOpen: true, supportsPort: false };
  assert.strictEqual(writeCapabilityCache(cachePath, key, caps), true);
  assert.deepStrictEqual(readCapabilityCache(cachePath, key), caps);
  assert.strictEqual(readCapabilityCache(cachePath, 'other-key'), null);

  const broken = path.join(root, 'broken.json');
  fs.writeFileSync(broken, '{bad');
  assert.strictEqual(readCapabilityCache(broken, key), null);
});

test('capability cache handles missing files and unwritable paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-caps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(capabilityCacheKey(path.join(root, 'missing.js')), null);
  assert.strictEqual(readCapabilityCache(path.join(root, 'missing.json'), 'k'), null);
  assert.strictEqual(
    writeCapabilityCache(path.join(root, 'x', 'cache.json'), 'k', { supportsNoOpen: true, supportsPort: true }),
    true
  );
});
