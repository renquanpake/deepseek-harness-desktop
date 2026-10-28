'use strict';

const fs = require('fs');
const path = require('path');
const {
  runGit,
  runTaskkill,
  runTasklist,
  readWindowsProcessCommandLine
} = require('../lib/secure-exec');

const GIT_WORKTREE_COMMAND_TIMEOUT_MS = 30000;
const GIT_WORKTREE_ADD_TIMEOUT_MS = 180000;
const WORKTREE_PROCESS_SCAN_TIMEOUT_MS = 4000;

function createWorktreeManager({
  session,
  isWindowsPlatform,
  clearWorkspaceFlag
}) {
  function isProcessAlive(pid) {
    const numericPid = Number(pid);
    if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
    try {
      process.kill(numericPid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  function createIsolatedGitWorktree(repoDir) {
    try {
      const stamp = Math.random().toString(36).substring(2, 7);
      const baseName = path.basename(repoDir);
      const parentDir = path.dirname(repoDir);
      const worktreePath = path.join(parentDir, `${baseName}-wt-${stamp}`);
      const branchName = `dsh/task-${stamp}`;
      runGit(['worktree', 'add', worktreePath, '-b', branchName], {
        cwd: repoDir,
        stdio: 'ignore',
        windowsHide: true,
        timeout: GIT_WORKTREE_ADD_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
      });
      return { created: true, worktreePath, repoPath: repoDir, branchName };
    } catch (err) {
      console.warn('[git-worktree] Fallback to original dir:', err.message);
      return { created: false, worktreePath: repoDir, repoPath: null, branchName: null };
    }
  }

  function findWindowsProcessesWithWorkingDir(worktreePath) {
    const pids = new Set();
    if (!isWindowsPlatform() || !worktreePath) return [];
    try {
      const output = runTasklist(
        ['/V', '/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true, timeout: WORKTREE_PROCESS_SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
      );
      const normalizedPath = worktreePath.toLowerCase().replace(/\s/g, '');
      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('"node.exe"')) continue;
        const pidMatch = trimmed.match(/,\s*"(\d+)",/);
        if (pidMatch && isProcessAlive(Number(pidMatch[1]))) {
          pids.add(pidMatch[1]);
        }
      }
      for (const pid of [...pids]) {
        const commandLine = readWindowsProcessCommandLine(Number(pid));
        if (!commandLine) continue;
        if (commandLine.replace(/\s/g, '').toLowerCase().includes(normalizedPath)) {
          try {
            runTaskkill(Number(pid));
            console.warn(`[git-worktree] 已结束工作区残留进程 PID ${pid}`);
          } catch (killErr) {
            console.warn(`[git-worktree] 结束残留进程失败 PID ${pid}: ${killErr.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[git-worktree] 残留进程扫描失败（继续回收）: ${err.message}`);
    }
  }

  function removeActiveWorktree() {
    const { worktreePath, repoPath, branchName } = session;
    if (!worktreePath) return false;
    findWindowsProcessesWithWorkingDir(worktreePath);
    try {
      runGit(['worktree', 'remove', worktreePath, '--force'], {
        cwd: repoPath || worktreePath,
        stdio: 'ignore',
        windowsHide: true,
        timeout: GIT_WORKTREE_COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
      });
    } catch (err) {
      console.warn(`[git-worktree] git worktree remove 失败，改为直接移除目录: ${err.message}`);
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.warn(`[git-worktree] 目录移除失败: ${cleanupErr.message}`);
        return false;
      }
    }
    if (repoPath && branchName) {
      try {
        runGit(['branch', '-D', branchName], {
          cwd: repoPath,
          stdio: 'ignore',
          windowsHide: true,
          timeout: GIT_WORKTREE_COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024
        });
        console.warn(`[git-worktree] 已删除临时分支 ${branchName}`);
      } catch (branchErr) {
        console.warn(`[git-worktree] 临时分支删除失败（可能未提交或已被占用）: ${branchErr.message}`);
      }
    }
    session.worktreePath = null;
    session.repoPath = null;
    session.branchName = null;
    clearWorkspaceFlag();
    return true;
  }

  return {
    isProcessAlive,
    createIsolatedGitWorktree,
    findWindowsProcessesWithWorkingDir,
    removeActiveWorktree
  };
}

module.exports = {
  createWorktreeManager,
  GIT_WORKTREE_COMMAND_TIMEOUT_MS,
  GIT_WORKTREE_ADD_TIMEOUT_MS,
  WORKTREE_PROCESS_SCAN_TIMEOUT_MS
};
