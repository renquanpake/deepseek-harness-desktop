'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { pickWorkspaceMode } = require('../lib/cli-workspace');

test('pickWorkspaceMode: returns null for empty or standard args', () => {
  assert.deepStrictEqual(pickWorkspaceMode(['node', 'main.js']), { mode: null, value: null });
  assert.deepStrictEqual(pickWorkspaceMode(['node', 'main.js', '--dev']), { mode: null, value: null });
});

test('pickWorkspaceMode: parses --open-dir', () => {
  const res = pickWorkspaceMode(['electron', '.', '--open-dir', 'D:\\projects\\repo']);
  assert.deepStrictEqual(res, { mode: 'open-dir', value: 'D:\\projects\\repo' });
});

test('pickWorkspaceMode: parses --worktree-dir and --worktree', () => {
  const res1 = pickWorkspaceMode(['electron', '.', '--worktree-dir', 'D:\\worktree\\feat-1']);
  assert.deepStrictEqual(res1, { mode: 'worktree-dir', value: 'D:\\worktree\\feat-1' });

  const res2 = pickWorkspaceMode(['electron', '.', '--worktree', 'D:\\worktree\\feat-2']);
  assert.deepStrictEqual(res2, { mode: 'worktree-dir', value: 'D:\\worktree\\feat-2' });
});

test('pickWorkspaceMode: ignores flags with missing value at tail', () => {
  assert.deepStrictEqual(pickWorkspaceMode(['electron', '.', '--open-dir']), { mode: null, value: null });
  assert.deepStrictEqual(pickWorkspaceMode(['electron', '.', '--worktree-dir']), { mode: null, value: null });
});
