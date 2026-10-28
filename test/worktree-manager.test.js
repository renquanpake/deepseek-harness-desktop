'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  createWorktreeManager,
  GIT_WORKTREE_ADD_TIMEOUT_MS,
  GIT_WORKTREE_COMMAND_TIMEOUT_MS,
  WORKTREE_PROCESS_SCAN_TIMEOUT_MS
} = require('../src/worktree');

function makeManager(session = { worktreePath: null, repoPath: null, branchName: null }) {
  let workspaceFlagCleared = 0;
  const manager = createWorktreeManager({
    session,
    isWindowsPlatform: () => false,
    clearWorkspaceFlag: () => {
      workspaceFlagCleared += 1;
    }
  });
  return { manager, session, cleared: () => workspaceFlagCleared };
}

test('worktree manager exposes expected API and timeout constants', () => {
  const { manager } = makeManager();
  for (const fn of ['isProcessAlive', 'createIsolatedGitWorktree', 'findWindowsProcessesWithWorkingDir', 'removeActiveWorktree']) {
    assert.strictEqual(typeof manager[fn], 'function', `${fn} missing`);
  }
  assert.strictEqual(GIT_WORKTREE_ADD_TIMEOUT_MS, 180000);
  assert.strictEqual(GIT_WORKTREE_COMMAND_TIMEOUT_MS, 30000);
  assert.strictEqual(WORKTREE_PROCESS_SCAN_TIMEOUT_MS, 4000);
});

test('createIsolatedGitWorktree returns a failed session shape when git is unavailable', () => {
  const { manager } = makeManager();
  const session = manager.createIsolatedGitWorktree('/nonexistent-repo-dir-xyz');
  assert.strictEqual(session.created, false);
  assert.strictEqual(session.worktreePath, '/nonexistent-repo-dir-xyz');
  assert.strictEqual(session.repoPath, null);
  assert.strictEqual(session.branchName, null);
});

test('findWindowsProcessesWithWorkingDir no-ops off windows and for empty path', () => {
  const { manager } = makeManager();
  assert.deepStrictEqual(manager.findWindowsProcessesWithWorkingDir('/some/path'), []);
  assert.deepStrictEqual(manager.findWindowsProcessesWithWorkingDir(''), []);
});

test('removeActiveWorktree returns false with empty session and does not clear flag', () => {
  const { manager, cleared } = makeManager();
  assert.strictEqual(manager.removeActiveWorktree(), false);
  assert.strictEqual(cleared(), 0);
});

test('removeActiveWorktree clears session fields after forced dir removal', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wt-test-'));
  const worktreePath = path.join(tmpRoot, 'repo-wt-abc');
  fs.mkdirSync(path.join(worktreePath, '.git'), { recursive: true });
  const session = { worktreePath, repoPath: null, branchName: null };
  const { manager, cleared } = makeManager(session);
  const removed = manager.removeActiveWorktree();
  assert.strictEqual(removed, true);
  assert.strictEqual(session.worktreePath, null);
  assert.strictEqual(session.repoPath, null);
  assert.strictEqual(session.branchName, null);
  assert.strictEqual(cleared(), 1);
  assert.strictEqual(fs.existsSync(worktreePath), false);
});

test('isProcessAlive rejects invalid pids and accepts current process', () => {
  const { manager } = makeManager();
  assert.strictEqual(manager.isProcessAlive(0), false);
  assert.strictEqual(manager.isProcessAlive(-1), false);
  assert.strictEqual(manager.isProcessAlive('nope'), false);
  assert.strictEqual(manager.isProcessAlive(process.pid), true);
});
