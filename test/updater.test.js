const { test } = require('node:test');
const assert = require('node:assert');
const {
  semverCompare,
  isNewer,
  decideUpdatePlan,
  pickFirstAvailable
} = require('../lib/updater');

test('semverCompare: strict ordering', () => {
  assert.strictEqual(semverCompare('1.0.0', '1.0.0'), 0);
  assert.strictEqual(semverCompare('1.0.1', '1.0.0'), 1);
  assert.strictEqual(semverCompare('1.2.0', '1.10.0'), -1);
});

test('isNewer: ignores prerelease suffixes on equal base', () => {
  assert.strictEqual(isNewer('0.2.5', '0.2.4'), true);
  assert.strictEqual(isNewer('0.2.4', '0.2.4'), false);
  assert.strictEqual(isNewer('0.2.4-rc.1', '0.2.4'), false);
});

test('decideUpdatePlan: only when remote is newer', () => {
  const base = {
    core: { currentVersion: '0.1.0-rc.6', remoteVersion: '0.2.0' },
    shell: { currentVersion: '0.1.0', remoteVersion: '0.1.0' }
  };
  assert.deepStrictEqual(decideUpdatePlan(base), {
    coreNeedsUpdate: true,
    shellNeedsUpdate: false,
    hasUpdate: true
  });
});

test('decideUpdatePlan: null remote treated as no update', () => {
  const base = {
    core: { currentVersion: '1.0.0', remoteVersion: null },
    shell: { currentVersion: '1.0.0', remoteVersion: null }
  };
  assert.deepStrictEqual(decideUpdatePlan(base), {
    coreNeedsUpdate: false,
    shellNeedsUpdate: false,
    hasUpdate: false
  });
});

test('pickFirstAvailable: returns first non-null candidate', () => {
  assert.strictEqual(pickFirstAvailable([null, 'a', 'b']), 'a');
  assert.strictEqual(pickFirstAvailable([null, undefined, null]), null);
});

