const { test } = require('node:test');
const assert = require('node:assert');
const { pickWorkspaceMode } = require('../lib/cli-workspace');

test('reads --open-dir value', () => {
  assert.deepStrictEqual(pickWorkspaceMode(['D:\\app.exe', '--open-dir', 'E:\\proj']), {
    mode: 'open-dir', value: 'E:\\proj'
  });
});

test('reads --worktree-dir value', () => {
  assert.deepStrictEqual(pickWorkspaceMode(['app.exe', '--worktree-dir', 'C:\\repo']), {
    mode: 'worktree-dir', value: 'C:\\repo'
  });
});

test('returns null when absent', () => {
  assert.deepStrictEqual(pickWorkspaceMode(['app.exe', '--dev']), { mode: null, value: null });
});

test('returns null when flag is last with no value', () => {
  assert.deepStrictEqual(pickWorkspaceMode(['app.exe', '--open-dir']), { mode: null, value: null });
});

test('first recognised flag wins', () => {
  assert.strictEqual(pickWorkspaceMode(['app.exe', '--open-dir', 'a', '--worktree-dir', 'b']).mode, 'open-dir');
});
