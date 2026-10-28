'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  probePython,
  ensurePythonRuntime,
  normalizePackages,
  STAMP_FILENAME
} = require('../lib/python-runtime');

const MANIFEST = {
  python: { supported: ['3.11', '3.12'] },
  packages: {
    numpy: '2.1.3',
    pandas: '2.2.3'
  }
};

function makeRuntimeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function stampPath(runtimeDir) {
  return path.join(runtimeDir, 'python', STAMP_FILENAME);
}

function readStamp(runtimeDir) {
  return JSON.parse(fs.readFileSync(stampPath(runtimeDir), 'utf8'));
}

function writeStamp(runtimeDir, data) {
  fs.mkdirSync(path.join(runtimeDir, 'python'), { recursive: true });
  fs.writeFileSync(stampPath(runtimeDir), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function pipCommand(args) {
  return args.slice(0, 3).join(' ');
}

test('probePython 使用 execFile 参数数组解析版本', async () => {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: 'Python 3.12.4\n', stderr: '' };
  };

  const result = await probePython('C:\\Python312\\python.exe', { runner });

  assert.deepEqual(result, { ok: true, version: '3.12.4' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\Python312\\python.exe');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].options.shell, false);
});

test('probePython 在可执行文件缺失时返回可读失败信息', async () => {
  const runner = async () => {
    const err = new Error('spawn python ENOENT');
    err.code = 'ENOENT';
    throw err;
  };

  const result = await probePython('missing-python', { runner });

  assert.equal(result.ok, false);
  assert.equal(result.version, null);
  assert.match(result.reason, /Python 探测失败/);
  assert.match(result.reason, /ENOENT/);
});

test('首次安装缺失包、写入 stamp，并在第二次调用时幂等跳过', async () => {
  const runtimeDir = makeRuntimeDir('dsh-py-first-');
  try {
    const calls = [];
    const runner = async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === '--version') {
        return { stdout: 'Python 3.12.4\n', stderr: '' };
      }
      if (pipCommand(args) === '-m pip show') {
        const err = new Error('pip show failed');
        err.code = 1;
        err.stderr = 'WARNING: Package(s) not found';
        throw err;
      }
      if (pipCommand(args) === '-m pip install') {
        return { stdout: 'Successfully installed', stderr: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    };

    const first = await ensurePythonRuntime({
      runtimeDir,
      pythonExe: 'python',
      manifest: MANIFEST,
      runner
    });

    assert.equal(first.ok, true);
    assert.equal(first.pythonPath, 'python');
    assert.deepEqual(first.installed, ['numpy', 'pandas']);
    assert.deepEqual(first.skipped, []);
    assert.equal(first.reason, 'ok');

    const stamp = readStamp(runtimeDir);
    assert.deepEqual(stamp.packages, { numpy: '2.1.3', pandas: '2.2.3' });
    assert.equal(stamp.python.version, '3.12.4');
    assert.equal(stamp.python.executable, 'python');
    assert.ok(stamp.updatedAt);

    const installs = calls.filter((call) => pipCommand(call.args) === '-m pip install');
    assert.equal(installs.length, 2);
    for (const call of installs) {
      assert.equal(call.file, 'python');
      assert.deepEqual(call.args.slice(0, 5), [
        '-m',
        'pip',
        'install',
        '--no-input',
        '--disable-pip-version-check'
      ]);
      assert.match(call.args[5], /^(numpy==2\.1\.3|pandas==2\.2\.3)$/);
      assert.equal(call.options.cwd, path.join(runtimeDir, 'python'));
      assert.equal(call.options.shell, false);
    }

    const secondCalls = [];
    const skipRunner = async (file, args, options) => {
      secondCalls.push({ file, args, options });
      if (args[0] === '--version') {
        return { stdout: 'Python 3.12.4\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    };

    const second = await ensurePythonRuntime({
      runtimeDir,
      pythonExe: 'python',
      manifest: MANIFEST,
      runner: skipRunner
    });

    assert.equal(second.ok, true);
    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.skipped, ['numpy', 'pandas']);
    assert.equal(secondCalls.length, 1);
  } finally {
    cleanup(runtimeDir);
  }
});

test('无 stamp 时通过 pip show 识别已安装版本并跳过安装', async () => {
  const runtimeDir = makeRuntimeDir('dsh-py-show-');
  const versions = { numpy: '2.1.3', pandas: '2.2.3' };
  try {
    const calls = [];
    const runner = async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === '--version') {
        return { stdout: 'Python 3.12.4\n', stderr: '' };
      }
      if (pipCommand(args) === '-m pip show') {
        const name = args[3];
        return { stdout: `Name: ${name}\nVersion: ${versions[name]}\n`, stderr: '' };
      }
      if (pipCommand(args) === '-m pip install') {
        throw new Error('install should not be called');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    };

    const result = await ensurePythonRuntime({
      runtimeDir,
      pythonExe: 'python',
      manifest: MANIFEST,
      runner
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.installed, []);
    assert.deepEqual(result.skipped, ['numpy', 'pandas']);
    assert.equal(calls.filter((call) => pipCommand(call.args) === '-m pip show').length, 2);
    assert.equal(calls.filter((call) => pipCommand(call.args) === '-m pip install').length, 0);
    assert.deepEqual(readStamp(runtimeDir).packages, { numpy: '2.1.3', pandas: '2.2.3' });
  } finally {
    cleanup(runtimeDir);
  }
});

test('安装失败时保留旧 stamp 并返回可读错误', async () => {
  const runtimeDir = makeRuntimeDir('dsh-py-fail-');
  try {
    const oldStamp = {
      schemaVersion: 1,
      python: { executable: 'python', version: '3.11.9' },
      packages: { numpy: '2.0.0' },
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    writeStamp(runtimeDir, oldStamp);
    const before = fs.readFileSync(stampPath(runtimeDir), 'utf8');

    const calls = [];
    const runner = async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === '--version') {
        return { stdout: 'Python 3.12.4\n', stderr: '' };
      }
      if (pipCommand(args) === '-m pip show') {
        const err = new Error('pip show failed');
        err.code = 1;
        throw err;
      }
      if (pipCommand(args) === '-m pip install') {
        const err = new Error('pip install failed');
        err.code = 1;
        err.stderr = 'ERROR: Could not find a version that satisfies the requirement numpy==2.1.3';
        throw err;
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    };

    const result = await ensurePythonRuntime({
      runtimeDir,
      pythonExe: 'python',
      manifest: MANIFEST,
      runner
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /numpy==2\.1\.3/);
    assert.match(result.reason, /已保留旧 stamp/);
    assert.match(result.reason, /Could not find a version/);
    assert.deepEqual(result.installed, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(fs.readFileSync(stampPath(runtimeDir), 'utf8'), before);
    assert.equal(calls.filter((call) => pipCommand(call.args) === '-m pip install').length, 1);
  } finally {
    cleanup(runtimeDir);
  }
});

test('包清单校验拒绝非法包名、非法版本与冲突声明', async () => {
  const runtimeDir = makeRuntimeDir('dsh-py-manifest-');
  try {
    let runnerCalls = 0;
    const runner = async () => {
      runnerCalls += 1;
      return { stdout: 'Python 3.12.4\n', stderr: '' };
    };

    const badName = await ensurePythonRuntime({
      runtimeDir,
      pythonExe: 'python',
      manifest: MANIFEST,
      packages: { 'bad name': '1.0.0' },
      runner
    });
    assert.equal(badName.ok, false);
    assert.match(badName.reason, /包清单校验失败/);
    assert.match(badName.reason, /包名/);

    const badVersion = await ensurePythonRuntime({
      runtimeDir,
      pythonExe: 'python',
      manifest: MANIFEST,
      packages: { numpy: '2.1.3 --index-url http://evil' },
      runner
    });
    assert.equal(badVersion.ok, false);
    assert.match(badVersion.reason, /版本号/);

    const empty = await ensurePythonRuntime({
      runtimeDir,
      pythonExe: 'python',
      manifest: MANIFEST,
      packages: {},
      runner
    });
    assert.equal(empty.ok, false);
    assert.match(empty.reason, /未声明任何包/);

    assert.equal(runnerCalls, 0);
    assert.throws(
      () => normalizePackages([
        { name: 'numpy', version: '2.1.3' },
        { name: 'numpy', version: '2.0.0' }
      ]),
      /冲突的版本声明/
    );

    const normalized = normalizePackages(['numpy==2.1.3', { name: 'pandas', version: '2.2.3' }]);
    assert.deepEqual(normalized, [
      { name: 'numpy', version: '2.1.3' },
      { name: 'pandas', version: '2.2.3' }
    ]);
  } finally {
    cleanup(runtimeDir);
  }
});

test('不受支持的 Python 版本会在安装前被拒绝', async () => {
  const runtimeDir = makeRuntimeDir('dsh-py-version-');
  try {
    let runnerCalls = 0;
    const runner = async (file, args) => {
      runnerCalls += 1;
      assert.deepEqual(args, ['--version']);
      return { stdout: 'Python 3.13.0\n', stderr: '' };
    };

    const result = await ensurePythonRuntime({
      runtimeDir,
      pythonExe: 'python',
      manifest: MANIFEST,
      runner
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /3\.13\.0 不受支持/);
    assert.equal(runnerCalls, 1);
    assert.equal(fs.existsSync(stampPath(runtimeDir)), false);
  } finally {
    cleanup(runtimeDir);
  }
});

test('所有子进程调用均使用参数数组且不经过 shell', async () => {
  const runtimeDir = makeRuntimeDir('dsh-py-shell-');
  try {
    const calls = [];
    const runner = async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === '--version') {
        return { stdout: 'Python 3.12.4\n', stderr: '' };
      }
      if (pipCommand(args) === '-m pip show') {
        const err = new Error('not installed');
        err.code = 1;
        throw err;
      }
      if (pipCommand(args) === '-m pip install') {
        return { stdout: 'ok', stderr: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    };

    await ensurePythonRuntime({
      runtimeDir,
      pythonExe: 'python',
      manifest: { ...MANIFEST, packages: { numpy: '2.1.3' } },
      runner
    });

    assert.ok(calls.length >= 3);
    for (const call of calls) {
      assert.equal(typeof call.file, 'string');
      assert.ok(Array.isArray(call.args));
      assert.equal(call.options.shell, false);
      for (const arg of call.args) {
        assert.equal(typeof arg, 'string');
        assert.doesNotMatch(arg, /&&|\|\||;|\$\(/);
      }
    }
  } finally {
    cleanup(runtimeDir);
  }
});

test('CLI 在 Python 不可用时返回退出码 1 与可读错误', () => {
  const runtimeDir = makeRuntimeDir('dsh-py-cli-');
  try {
    const script = path.join(__dirname, '..', 'scripts', 'prepare-python-runtime.js');
    const result = spawnSync(
      process.execPath,
      [script, '--runtime-dir', runtimeDir, '--python', path.join(runtimeDir, 'missing-python')],
      { encoding: 'utf8' }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Python 探测失败/);
    assert.match(result.stderr, /失败/);
  } finally {
    cleanup(runtimeDir);
  }
});
