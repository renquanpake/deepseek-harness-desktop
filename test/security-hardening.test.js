'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const {
  runGit,
  runReg,
  runTaskkill,
  runTasklist,
  readWindowsProcessCommandLine
} = require('../lib/secure-exec');
const { isBackendReadyStatus } = require('../lib/readiness');
const { createSingleFlight } = require('../lib/restart-guard');

test('secure-exec rejects invalid PIDs before executing anything', (t) => {
  let called = 0;
  t.mock.method(childProcess, 'execFileSync', () => {
    called += 1;
    return '';
  });
  for (const pid of ['123', 1.5, 0, -1, NaN, null, undefined]) {
    assert.throws(() => runTaskkill(pid), TypeError);
    assert.throws(() => readWindowsProcessCommandLine(pid), TypeError);
  }
  assert.strictEqual(called, 0);
});

test('secure-exec builds argument arrays and preserves execution options', (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (command, args, opts) => {
    calls.push({ command, args, opts });
    return '';
  });

  runGit(['worktree', 'add', 'C:\\repo-wt', '-b', 'dsh/task-x'], {
    cwd: 'C:\\repo',
    stdio: 'ignore',
    timeout: 180000,
    maxBuffer: 1024 * 1024
  });
  runReg(['add', 'HKCU\\Software\\Test', '/ve', '/d', 'value', '/f']);
  runTasklist(['/V', '/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 4000,
    maxBuffer: 16 * 1024 * 1024
  });
  runTaskkill(4321);

  assert.strictEqual(calls[0].command, 'git');
  assert.deepStrictEqual(calls[0].args, ['worktree', 'add', 'C:\\repo-wt', '-b', 'dsh/task-x']);
  assert.strictEqual(calls[0].opts.cwd, 'C:\\repo');
  assert.strictEqual(calls[0].opts.windowsHide, true);
  assert.strictEqual(calls[0].opts.timeout, 180000);
  assert.strictEqual(calls[0].opts.maxBuffer, 1024 * 1024);

  assert.strictEqual(calls[1].command, 'reg');
  assert.deepStrictEqual(calls[1].args, ['add', 'HKCU\\Software\\Test', '/ve', '/d', 'value', '/f']);
  assert.strictEqual(calls[1].opts.windowsHide, true);

  assert.strictEqual(calls[2].command, 'tasklist');
  assert.deepStrictEqual(calls[2].args, ['/V', '/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH']);
  assert.strictEqual(calls[2].opts.encoding, 'utf8');
  assert.strictEqual(calls[2].opts.timeout, 4000);

  assert.strictEqual(calls[3].command, 'taskkill');
  assert.deepStrictEqual(calls[3].args, ['/PID', '4321', '/T', '/F']);
  assert.strictEqual(calls[3].opts.stdio, 'ignore');
  assert.strictEqual(calls[3].opts.windowsHide, true);
  for (const call of calls) {
    assert.strictEqual(call.opts.shell, undefined);
  }
});

test('secure-exec keeps shell metacharacters inside a single argument', (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (command, args, opts) => {
    calls.push({ command, args, opts });
    return '';
  });

  const branchName = 'feature; touch /tmp/dsh-pwned && echo unsafe';
  runGit(['branch', '-D', branchName], { stdio: 'ignore' });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].command, 'git');
  assert.deepStrictEqual(calls[0].args, ['branch', '-D', branchName]);
  assert.strictEqual(calls[0].args[2], branchName);
  assert.strictEqual(calls[0].opts.shell, undefined);
});

test('readWindowsProcessCommandLine falls back from wmic to powershell', (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (command, args, opts) => {
    calls.push({ command, args, opts });
    if (command === 'wmic') throw new Error('wmic not found');
    return 'node.exe main.js\n';
  });

  const output = readWindowsProcessCommandLine(9876);
  assert.strictEqual(output, 'node.exe main.js\n');
  assert.deepStrictEqual(calls.map((call) => call.command), ['wmic', 'powershell.exe']);
  assert.deepStrictEqual(calls[0].args, ['process', 'where', 'ProcessId=9876', 'get', 'CommandLine', '/FORMAT:LIST']);
  assert.match(calls[1].args[3], /ProcessId=9876/);
  assert.strictEqual(calls[0].opts.encoding, 'utf8');
  assert.strictEqual(calls[0].opts.maxBuffer, 2 * 1024 * 1024);
  assert.strictEqual(calls[0].opts.shell, undefined);
  assert.strictEqual(calls[1].opts.shell, undefined);
});

test('readiness accepts only status codes below 500', () => {
  for (const status of [100, 200, 204, 302, 404, 499]) {
    assert.strictEqual(isBackendReadyStatus(status), true, `status ${status}`);
  }
  for (const status of [500, 502, 503, 599, undefined, null, NaN, '200']) {
    assert.strictEqual(isBackendReadyStatus(status), false, `status ${status}`);
  }
});

test('createSingleFlight shares concurrent calls and resets after settle', async () => {
  let calls = 0;
  const resolvers = [];
  const singleFlight = createSingleFlight(() => {
    calls += 1;
    return new Promise((resolve) => resolvers.push(resolve));
  });

  const first = singleFlight();
  const second = singleFlight();
  assert.strictEqual(first, second);
  assert.strictEqual(calls, 1);

  resolvers[0]('done');
  assert.strictEqual(await first, 'done');
  assert.strictEqual(await second, 'done');

  const third = singleFlight();
  assert.notStrictEqual(third, first);
  assert.strictEqual(calls, 2);
  resolvers[1]('again');
  assert.strictEqual(await third, 'again');
});

test('createSingleFlight clears state after rejection', async () => {
  let calls = 0;
  const singleFlight = createSingleFlight(async () => {
    calls += 1;
    throw new Error('restart failed');
  });

  await assert.rejects(singleFlight(), /restart failed/);
  await assert.rejects(singleFlight(), /restart failed/);
  assert.strictEqual(calls, 2);
});
