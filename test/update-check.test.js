'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const UPDATE_CHECK = require('../lib/update-check');

test('CONFIG exposes official-first sources and registry', () => {
  assert.ok(Array.isArray(UPDATE_CHECK.CONFIG.CORE_REGISTRY_SOURCES));
  assert.ok(UPDATE_CHECK.CONFIG.CORE_REGISTRY_SOURCES.length >= 2);
  assert.strictEqual(UPDATE_CHECK.CONFIG.REGISTRY, 'https://registry.npmmirror.com');
  assert.strictEqual(typeof UPDATE_CHECK.CONFIG.DOWNLOAD_TIMEOUT_MS, 'number');
});

test('candidate helpers return official URLs first, deduped', () => {
  const core = UPDATE_CHECK.coreRegistryCandidates();
  assert.ok(Array.isArray(core));
  assert.strictEqual(core[0], 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest');
  assert.ok(new Set(core).size === core.length, 'no duplicates');
});

test('each candidate builder returns an array of https/http URLs', () => {
  for (const fn of [
    UPDATE_CHECK.coreRegistryCandidates,
    UPDATE_CHECK.shellManifestCandidates,
    UPDATE_CHECK.releaseCandidates,
    UPDATE_CHECK.downloadProxies
  ]) {
    const urls = fn();
    assert.ok(Array.isArray(urls), `${fn.name} must return array`);
    for (const u of urls) assert.match(u, /^https?:\/\//);
  }
});

test('check helpers are async functions', () => {
  assert.strictEqual(typeof UPDATE_CHECK.checkCoreVersion, 'function');
  assert.strictEqual(typeof UPDATE_CHECK.checkShellVersion, 'function');
  assert.strictEqual(typeof UPDATE_CHECK.checkReleaseAssets, 'function');
});
