'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { mergeProfilePackage, hydratePresetPlugins } = require('../lib/preset-hydrator');

test('mergeProfilePackage: combines bundles and dependencies without duplication', () => {
  const userPkg = {
    name: 'user-profile',
    dependencies: { 'my-custom-plugin': '^1.0.0' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'my-custom-plugin']
      }
    }
  };

  const presetPkg = {
    name: 'preset-profile',
    dependencies: { 'dsh-codex-ui': '^1.0.0', 'dshmarket': '^1.0.0' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'dsh-codex-ui', 'dshmarket']
      }
    }
  };

  const merged = mergeProfilePackage(userPkg, presetPkg);

  assert.deepStrictEqual(merged.dependencies, {
    'dsh-codex-ui': '^1.0.0',
    'dshmarket': '^1.0.0',
    'my-custom-plugin': '^1.0.0'
  });

  assert.deepStrictEqual(merged.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    'dsh-codex-ui',
    'dshmarket',
    'my-custom-plugin'
  ]);
});

test('hydratePresetPlugins: handles full copy when user web profile does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-hydrate-'));
  const presetDir = path.join(tmpDir, 'preset');
  const dshHome = path.join(tmpDir, 'user-dsh');

  const presetWeb = path.join(presetDir, 'profiles', 'web');
  fs.mkdirSync(presetWeb, { recursive: true });
  fs.writeFileSync(path.join(presetWeb, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['dsh-codex-ui'] } }
  }));

  const res = hydratePresetPlugins(presetDir, dshHome);
  assert.strictEqual(res.hydrated, true);
  assert.strictEqual(res.mode, 'full-copy');

  const copiedPkg = JSON.parse(fs.readFileSync(path.join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'));
  assert.deepStrictEqual(copiedPkg.dsh.profile.bundles, ['dsh-codex-ui']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('hydratePresetPlugins: deeply merges when user web profile already exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-hydrate-merge-'));
  const presetDir = path.join(tmpDir, 'preset');
  const dshHome = path.join(tmpDir, 'user-dsh');

  const presetWeb = path.join(presetDir, 'profiles', 'web');
  const userWeb = path.join(dshHome, 'profiles', 'web');
  fs.mkdirSync(presetWeb, { recursive: true });
  fs.mkdirSync(userWeb, { recursive: true });

  fs.writeFileSync(path.join(presetWeb, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-codex-ui'] } }
  }));
  fs.writeFileSync(path.join(userWeb, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'user-existing-bundle'] } }
  }));

  const res = hydratePresetPlugins(presetDir, dshHome);
  assert.strictEqual(res.hydrated, true);
  assert.strictEqual(res.mode, 'merged');

  const finalPkg = JSON.parse(fs.readFileSync(path.join(userWeb, 'package.json'), 'utf8'));
  assert.deepStrictEqual(finalPkg.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    'dsh-codex-ui',
    'user-existing-bundle'
  ]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
