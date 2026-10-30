'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

function defaultRun(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
        windowsHide: true,
        shell: Boolean(options.shell),
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || '') + (error && error.message ? `\n${error.message}` : '')
        });
      }
    );
  });
}

function createShellUpdater({
  appDir,
  run = defaultRun,
  fsImpl = fs,
  platform = process.platform,
  log = console
}) {
  if (!appDir) throw new TypeError('appDir is required');

  async function git(args) {
    return run('git', args, { cwd: appDir });
  }

  function isGitCheckout() {
    try {
      return fsImpl.existsSync(path.join(appDir, '.git'));
    } catch {
      return false;
    }
  }

  async function status() {
    if (!isGitCheckout()) {
      return { supported: false, reason: 'not-a-git-checkout' };
    }
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = await git(['rev-parse', 'HEAD']);
    const dirty = await git(['status', '--porcelain']);
    if (branch.code !== 0 || head.code !== 0) {
      return { supported: false, reason: 'git-unavailable' };
    }
    return {
      supported: true,
      branch: branch.stdout.trim(),
      head: head.stdout.trim(),
      dirty: dirty.code === 0 ? dirty.stdout.trim().length > 0 : true
    };
  }

  async function installDependencies(registry) {
    return run(
      platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ci', '--no-audit', '--no-fund', `--registry=${registry}`],
      { cwd: appDir, shell: platform === 'win32' }
    );
  }

  async function update({ registry = DEFAULT_REGISTRY } = {}) {
    const state = await status();
    if (!state.supported) return { ok: false, reason: state.reason };
    if (state.dirty) return { ok: false, reason: 'worktree-dirty', branch: state.branch };

    const pull = await git(['pull', '--ff-only']);
    if (pull.code !== 0) {
      return { ok: false, reason: 'pull-failed', stderr: pull.stderr.trim().slice(-2000) };
    }

    const headAfterPull = await git(['rev-parse', 'HEAD']);
    const newHead = headAfterPull.code === 0 ? headAfterPull.stdout.trim() : state.head;
    if (newHead === state.head) {
      return { ok: true, changed: false, head: newHead, branch: state.branch };
    }

    log.log(`[shell-update] 代码已更新 ${state.head.slice(0, 8)} -> ${newHead.slice(0, 8)}，重新安装依赖`);
    const install = await installDependencies(registry);
    if (install.code === 0) {
      return { ok: true, changed: true, oldHead: state.head, newHead, branch: state.branch };
    }

    log.warn('[shell-update] 依赖安装失败，回滚代码');
    const rollback = await git(['reset', '--hard', state.head]);
    const restore = rollback.code === 0
      ? await installDependencies(registry)
      : { code: rollback.code, stdout: '', stderr: rollback.stderr };

    return {
      ok: false,
      reason: 'install-failed',
      rolledBack: rollback.code === 0,
      restored: restore.code === 0,
      stderr: install.stderr.trim().slice(-2000)
    };
  }

  return { status, update, isGitCheckout, getAppDir: () => appDir };
}

module.exports = { createShellUpdater, defaultRun, DEFAULT_REGISTRY };
