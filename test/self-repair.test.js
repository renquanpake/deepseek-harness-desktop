'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runSelfRepair } = require('../lib/self-repair');

test('runSelfRepair: cleans stale locks, removes broken markers, and triggers hydration', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-self-repair-'));
  const dshHome = path.join(tmpDir, 'dsh-home');
  const runtimeDir = path.join(tmpDir, 'dsh-runtime');

  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  // 1. Create a dead lock file
  const deadLock = path.join(dshHome, 'test.lock');
  fs.writeFileSync(deadLock, '9999999');

  // 2. Create a broken marker
  const marker = path.join(dshHome, '.broken-marker.json');
  fs.writeFileSync(marker, JSON.stringify({ broken: true }));

  // 3. Create preset profile
  const presetWeb = path.join(runtimeDir, 'default-profile', 'profiles', 'web');
  fs.mkdirSync(presetWeb, { recursive: true });
  fs.writeFileSync(path.join(presetWeb, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['dsh-codex-ui'] } }
  }));

  let killCalled = false;
  const killOrphanProcess = () => { killCalled = true; };

  const report = runSelfRepair({ dshHome, runtimeDir, killOrphanProcess });

  assert.strictEqual(report.repaired, true);
  assert.strictEqual(killCalled, true);
  assert.strictEqual(fs.existsSync(deadLock), false, 'Dead lock file should be unlinked');
  assert.strictEqual(fs.existsSync(marker), false, 'Broken marker should be removed');

  const userPkg = JSON.parse(fs.readFileSync(path.join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'));
  assert.deepStrictEqual(userPkg.dsh.profile.bundles, ['dsh-codex-ui']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runSelfRepair: handles clean state without crashing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-self-repair-clean-'));
  const dshHome = path.join(tmpDir, 'dsh-home');
  const runtimeDir = path.join(tmpDir, 'dsh-runtime');

  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const report = runSelfRepair({ dshHome, runtimeDir });
  assert.strictEqual(typeof report.repaired, 'boolean');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
