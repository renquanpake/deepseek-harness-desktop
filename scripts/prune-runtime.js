'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE_PATTERNS = [/\.map$/i, /\.md$/i, /\.d\.ts$/i, /\.ts$/i];
const KEEP_BASENAME = /^(LICEN[CS]E|COPYING|NOTICE|AUTHORS|PATENTS)/i;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__', 'spec']);
const REQUIRED = path.join('node_modules', '@deepseek-ai', 'dsh');

function shouldKeepFile(name) {
  return KEEP_BASENAME.test(name);
}

function shouldRemoveFile(name) {
  if (shouldKeepFile(name)) return false;
  return FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function collectTargets(nodeModulesDir) {
  const files = [];
  const dirs = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (TEST_DIRS.has(entry.name.toLowerCase()) && dir !== nodeModulesDir) {
          dirs.push(full);
          continue;
        }
        walk(full);
      } else if (entry.isFile() && shouldRemoveFile(entry.name)) {
        files.push(full);
      }
    }
  }

  walk(nodeModulesDir);
  return { files, dirs };
}

function sizeOf(target) {
  let total = 0;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isFile()) return stat.size;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      total += sizeOf(path.join(target, entry.name));
    }
  } catch {
    return 0;
  }
  return total;
}

function pruneRuntime({ runtimeDir, dryRun = false, fsImpl = fs, log = console } = {}) {
  if (!runtimeDir) throw new TypeError('runtimeDir is required');
  const resolved = path.resolve(runtimeDir);
  const nodeModulesDir = path.join(resolved, 'node_modules');
  const requiredDir = path.join(resolved, REQUIRED);

  if (!fsImpl.existsSync(requiredDir)) {
    return { ok: false, reason: 'runtime-not-prepared', runtimeDir: resolved };
  }

  const { files, dirs } = collectTargets(nodeModulesDir);
  let bytes = 0;
  for (const target of [...files, ...dirs]) bytes += sizeOf(target);

  if (!dryRun) {
    for (const target of files) {
      try {
        fsImpl.unlinkSync(target);
      } catch (err) {
        log.warn(`[prune] 删除失败 ${target}: ${err.message}`);
      }
    }
    for (const target of dirs) {
      try {
        fsImpl.rmSync(target, { recursive: true, force: true });
      } catch (err) {
        log.warn(`[prune] 删除失败 ${target}: ${err.message}`);
      }
    }
  }

  return {
    ok: true,
    runtimeDir: resolved,
    dryRun,
    files: files.length,
    dirs: dirs.length,
    freedBytes: bytes
  };
}

function parseArgs(argv) {
  const options = {
    runtimeDir: path.join(process.cwd(), 'dsh-runtime'),
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime-dir') options.runtimeDir = path.resolve(argv[++index] || '');
    else if (arg === '--dry-run') options.dryRun = true;
  }
  return options;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = pruneRuntime(options);
  if (!result.ok) {
    console.error(`[prune] 内核未准备好: ${result.runtimeDir}`);
    return 2;
  }
  const prefix = result.dryRun ? '[prune] 预演' : '[prune] 已裁剪';
  console.log(`${prefix} ${result.files} 个文件、${result.dirs} 个测试目录，释放 ${mb(result.freedBytes)} MB`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { pruneRuntime, parseArgs, collectTargets, shouldRemoveFile, shouldKeepFile, TEST_DIRS };
