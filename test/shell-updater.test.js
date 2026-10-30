'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createShellUpdater } = require('../lib/shell-updater');

function makeRepo(t, { gitDir = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (gitDir) fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

function makeRunner(script) {
  const calls = [];
  async function run(command, args) {
    calls.push([command, ...args].join(' '));
    const key = `${command} ${args[0]}`;
    const handler = script[key] || script[`${command} ${args.join(' ')}`] || script.default;
    if (typeof handler === 'function') return handler(command, args, calls);
    if (handler) return handler;
    return { code: 0, stdout: '', stderr: '' };
  }
  return { run, calls };
}

test('a non-git directory is reported as unsupported', async (t) => {
  const appDir = makeRepo(t, { gitDir: false });
  const updater = createShellUpdater({ appDir, run: makeRunner({}).run });
  assert.deepStrictEqual(await updater.status(), { supported: false, reason: 'not-a-git-checkout' });
  assert.deepStrictEqual(await updater.update(), { ok: false, reason: 'not-a-git-checkout' });
});

test('a dirty worktree blocks updates', async (t) => {
  const appDir = makeRepo(t);
  const runner = makeRunner({
    'git rev-parse': (command, args) => ({
      code: 0,
      stdout: args.includes('--abbrev-ref') ? 'main\n' : 'abc123\n',
      stderr: ''
    }),
    'git status': { code: 0, stdout: ' M main.js\n', stderr: '' }
  });
  const updater = createShellUpdater({ appDir, run: runner.run });

  const result = await updater.update();
  assert.deepStrictEqual(result, { ok: false, reason: 'worktree-dirty', branch: 'main' });
  assert.strictEqual(runner.calls.some((call) => call.startsWith('git pull')), false);
});

test('an already up-to-date checkout reports no change', async (t) => {
  const appDir = makeRepo(t);
  const runner = makeRunner({
    'git rev-parse': (command, args) => ({
      code: 0,
      stdout: args.includes('--abbrev-ref') ? 'main\n' : 'abc123\n',
      stderr: ''
    }),
    'git status': { code: 0, stdout: '', stderr: '' },
    'git pull': { code: 0, stdout: 'Already up to date.\n', stderr: '' }
  });
  const updater = createShellUpdater({ appDir, run: runner.run });

  assert.deepStrictEqual(await updater.update(), {
    ok: true,
    changed: false,
    head: 'abc123',
    branch: 'main'
  });
  assert.strictEqual(runner.calls.some((call) => call.startsWith('npm')), false);
});

test('a fast-forward update reinstalls dependencies', async (t) => {
  const appDir = makeRepo(t);
  let headCalls = 0;
  const runner = makeRunner({
    'git rev-parse': (command, args) => {
      if (args.includes('--abbrev-ref')) return { code: 0, stdout: 'main\n', stderr: '' };
      headCalls += 1;
      return { code: 0, stdout: headCalls === 1 ? 'old111\n' : 'new222\n', stderr: '' };
    },
    'git status': { code: 0, stdout: '', stderr: '' },
    'git pull': { code: 0, stdout: 'Fast-forward\n', stderr: '' },
    'npm.cmd ci': { code: 0, stdout: '', stderr: '' },
    'npm ci': { code: 0, stdout: '', stderr: '' }
  });
  const updater = createShellUpdater({ appDir, run: runner.run, platform: 'win32' });

  assert.deepStrictEqual(await updater.update(), {
    ok: true,
    changed: true,
    oldHead: 'old111',
    newHead: 'new222',
    branch: 'main'
  });
  assert.ok(runner.calls.some((call) => call.startsWith('npm.cmd ci')));
});

test('a failed dependency install rolls the checkout back', async (t) => {
  const appDir = makeRepo(t);
  let headCalls = 0;
  const runner = makeRunner({
    'git rev-parse': (command, args) => {
      if (args.includes('--abbrev-ref')) return { code: 0, stdout: 'main\n', stderr: '' };
      headCalls += 1;
      return { code: 0, stdout: headCalls === 1 ? 'old111\n' : 'new222\n', stderr: '' };
    },
    'git status': { code: 0, stdout: '', stderr: '' },
    'git pull': { code: 0, stdout: 'Fast-forward\n', stderr: '' },
    'git reset': { code: 0, stdout: '', stderr: '' },
    'npm ci': (command, args, calls) => (
      calls.filter((call) => call.startsWith('npm')).length === 1
        ? { code: 1, stdout: '', stderr: 'ELIFECYCLE install failed' }
        : { code: 0, stdout: '', stderr: '' }
    )
  });
  const updater = createShellUpdater({ appDir, run: runner.run, platform: 'linux' });

  const result = await updater.update();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'install-failed');
  assert.strictEqual(result.rolledBack, true);
  assert.strictEqual(result.restored, true);
  assert.match(result.stderr, /install failed/);
  assert.ok(runner.calls.some((call) => call.startsWith('git reset --hard old111')));
});

test('a failed pull is reported without touching dependencies', async (t) => {
  const appDir = makeRepo(t);
  const runner = makeRunner({
    'git rev-parse': (command, args) => ({
      code: 0,
      stdout: args.includes('--abbrev-ref') ? 'main\n' : 'abc123\n',
      stderr: ''
    }),
    'git status': { code: 0, stdout: '', stderr: '' },
    'git pull': { code: 1, stdout: '', stderr: 'fatal: not possible to fast-forward' }
  });
  const updater = createShellUpdater({ appDir, run: runner.run });

  const result = await updater.update();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'pull-failed');
  assert.match(result.stderr, /fast-forward/);
  assert.strictEqual(runner.calls.some((call) => call.startsWith('npm')), false);
});
