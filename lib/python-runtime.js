'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const STAMP_FILENAME = 'python-runtime.json';
const RUNTIME_SUBDIR = 'python';
const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', 'build', 'runtime-manifest.json');

const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PACKAGE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+!-]*$/;

function defaultRunner(file, args, options = {}) {
  return execFileAsync(file, args, {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
    shell: false
  });
}

function formatError(err) {
  if (!err) return '未知错误';
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
  const raw = stderr || err.message || String(err);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-3).join(' | ').slice(0, 500);
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadManifest(manifest) {
  let data = manifest;
  if (data == null) data = DEFAULT_MANIFEST_PATH;
  if (typeof data === 'string') {
    const manifestPath = path.resolve(data);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`运行时清单不存在: ${manifestPath}`);
    }
    try {
      data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      throw new Error(`运行时清单解析失败: ${formatError(err)}`);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('运行时清单格式无效');
  }
  return data;
}

function normalizePackages(input) {
  if (input == null) return [];
  if (typeof input !== 'object') {
    throw new TypeError('包清单必须是对象或数组');
  }

  const entries = Array.isArray(input)
    ? input.map((entry) => {
      if (typeof entry === 'string') {
        const separator = entry.indexOf('==');
        if (separator <= 0) {
          throw new TypeError(`无效的包声明: ${entry}（需要 name==version）`);
        }
        return [entry.slice(0, separator), entry.slice(separator + 2)];
      }
      if (Array.isArray(entry) && entry.length === 2) {
        return [entry[0], entry[1]];
      }
      if (entry && typeof entry === 'object') {
        return [entry.name, entry.version];
      }
      throw new TypeError(`无效的包声明: ${JSON.stringify(entry)}`);
    })
    : Object.entries(input);

  const packages = [];
  const seen = new Map();

  for (const [rawName, rawVersion] of entries) {
    const name = String(rawName == null ? '' : rawName).trim();
    const version = String(rawVersion == null ? '' : rawVersion).trim();
    if (!PACKAGE_NAME_PATTERN.test(name)) {
      throw new TypeError(`无效的包名: ${JSON.stringify(rawName)}`);
    }
    if (!PACKAGE_VERSION_PATTERN.test(version)) {
      throw new TypeError(`无效的版本号: ${name}@${JSON.stringify(rawVersion)}`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      if (seen.get(key) !== version) {
        throw new TypeError(`包 ${name} 存在冲突的版本声明`);
      }
      continue;
    }
    seen.set(key, version);
    packages.push({ name, version });
  }

  return packages;
}

function isSupportedPython(version, manifest) {
  const supported = manifest && manifest.python && Array.isArray(manifest.python.supported)
    ? manifest.python.supported
    : null;
  if (!supported || supported.length === 0) return true;
  const minor = String(version || '').split('.').slice(0, 2).join('.');
  return supported.includes(version) || supported.includes(minor);
}

async function probePython(pythonExe, { runner = defaultRunner } = {}) {
  if (!pythonExe || typeof pythonExe !== 'string') {
    return { ok: false, version: null, reason: '未提供 Python 可执行文件路径' };
  }
  try {
    const result = await runner(pythonExe, ['--version'], {
      windowsHide: true,
      shell: false,
      encoding: 'utf8'
    });
    const output = `${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`;
    const match = output.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/i);
    if (!match) {
      return {
        ok: false,
        version: null,
        reason: `无法解析 Python 版本输出: ${output.trim().slice(0, 200) || '(空)'}`
      };
    }
    return { ok: true, version: match[1] };
  } catch (err) {
    return { ok: false, version: null, reason: `Python 探测失败: ${formatError(err)}` };
  }
}

async function pipShowVersion(pythonExe, packageName, { runner, cwd }) {
  try {
    const result = await runner(pythonExe, ['-m', 'pip', 'show', packageName], {
      cwd,
      windowsHide: true,
      shell: false,
      encoding: 'utf8'
    });
    const output = `${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`;
    const match = output.match(/^Version:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function stampMatchesPython(stamp, pythonVersion) {
  if (!stamp || !stamp.python || !stamp.python.version) return true;
  return stamp.python.version === pythonVersion;
}

function writeStamp(stampPath, stamp) {
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
}

function failedResult(pythonPath, installed, skipped, reason) {
  return { ok: false, pythonPath: pythonPath || null, installed, skipped, reason };
}

async function ensurePythonRuntime(options = {}) {
  const {
    runtimeDir,
    pythonExe = process.env.DSH_PYTHON || 'python',
    packages,
    runner = defaultRunner,
    manifest: manifestInput
  } = options;

  let manifest;
  try {
    manifest = loadManifest(manifestInput);
  } catch (err) {
    return failedResult(pythonExe, [], [], `读取运行时清单失败: ${formatError(err)}`);
  }

  let normalized;
  try {
    const source = packages !== undefined ? packages : manifest.packages;
    normalized = normalizePackages(source);
    if (normalized.length === 0) {
      throw new TypeError('运行时清单未声明任何包');
    }
  } catch (err) {
    return failedResult(pythonExe, [], [], `包清单校验失败: ${err.message}`);
  }

  if (!runtimeDir || typeof runtimeDir !== 'string') {
    return failedResult(pythonExe, [], [], '未提供 runtimeDir');
  }

  const resolvedRuntimeDir = path.resolve(runtimeDir);
  const pythonDir = path.join(resolvedRuntimeDir, RUNTIME_SUBDIR);
  const stampPath = path.join(pythonDir, STAMP_FILENAME);

  const probed = await probePython(pythonExe, { runner });
  if (!probed.ok) {
    return failedResult(pythonExe, [], [], probed.reason);
  }
  if (!isSupportedPython(probed.version, manifest)) {
    const supported = manifest.python.supported.join(', ');
    return failedResult(
      pythonExe,
      [],
      [],
      `Python ${probed.version} 不受支持，请使用 ${supported}`
    );
  }

  const stamp = readJsonSafe(stampPath);
  const stampPackages = stamp && stamp.packages && typeof stamp.packages === 'object'
    ? stamp.packages
    : {};
  const trustStamp = stampMatchesPython(stamp, probed.version);

  const installed = [];
  const skipped = [];
  const finalPackages = {};

  for (const { name, version } of normalized) {
    if (trustStamp && stampPackages[name] === version) {
      finalPackages[name] = version;
      skipped.push(name);
      continue;
    }

    const reportedVersion = await pipShowVersion(pythonExe, name, { runner, cwd: pythonDir });
    if (reportedVersion === version) {
      finalPackages[name] = version;
      skipped.push(name);
      continue;
    }

    try {
      await runner(
        pythonExe,
        ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', `${name}==${version}`],
        {
          cwd: pythonDir,
          windowsHide: true,
          shell: false,
          encoding: 'utf8'
        }
      );
    } catch (err) {
      return failedResult(
        pythonExe,
        installed,
        skipped,
        `安装 ${name}==${version} 失败（已保留旧 stamp）: ${formatError(err)}`
      );
    }

    finalPackages[name] = version;
    installed.push(name);
  }

  const stampData = {
    schemaVersion: 1,
    python: {
      executable: pythonExe,
      version: probed.version
    },
    packages: finalPackages,
    updatedAt: new Date().toISOString()
  };

  try {
    writeStamp(stampPath, stampData);
  } catch (err) {
    return failedResult(
      pythonExe,
      installed,
      skipped,
      `依赖已就绪但写入 stamp 失败: ${formatError(err)}`
    );
  }

  return { ok: true, pythonPath: pythonExe, installed, skipped, reason: 'ok' };
}

module.exports = {
  STAMP_FILENAME,
  RUNTIME_SUBDIR,
  DEFAULT_MANIFEST_PATH,
  defaultRunner,
  normalizePackages,
  probePython,
  ensurePythonRuntime
};
