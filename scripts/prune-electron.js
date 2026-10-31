'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEEP_LOCALES = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);

function pruneElectron({ distDir, dryRun = false, fsImpl = fs, log = console } = {}) {
  if (!distDir) throw new TypeError('distDir is required');
  const resolved = path.resolve(distDir);
  const localesDir = path.join(resolved, 'locales');
  const executable = ['electron.exe', 'electron']
    .map((name) => path.join(resolved, name))
    .find((file) => {
      try {
        return fsImpl.existsSync(file);
      } catch {
        return false;
      }
    });

  if (!executable) {
    return { ok: false, reason: 'electron-dist-missing', distDir: resolved };
  }
  if (!fsImpl.existsSync(localesDir)) {
    return { ok: true, distDir: resolved, removed: 0, freedBytes: 0 };
  }

  let removed = 0;
  let freedBytes = 0;
  for (const entry of fsImpl.readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.pak') || KEEP_LOCALES.has(entry.name)) continue;
    const full = path.join(localesDir, entry.name);
    try {
      freedBytes += fsImpl.statSync(full).size;
      if (!dryRun) fsImpl.unlinkSync(full);
      removed += 1;
    } catch (err) {
      log.warn(`[prune-electron] 删除失败 ${entry.name}: ${err.message}`);
    }
  }

  return { ok: true, distDir: resolved, removed, freedBytes, dryRun };
}

function parseArgs(argv) {
  const options = {
    distDir: path.join(process.cwd(), 'node_modules', 'electron', 'dist'),
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dist-dir') options.distDir = path.resolve(argv[++index] || '');
    else if (arg === '--dry-run') options.dryRun = true;
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = pruneElectron(options);
  if (!result.ok) {
    console.error(`[prune-electron] 未找到 Electron 发行目录: ${result.distDir}`);
    return 0;
  }
  const prefix = result.dryRun ? '[prune-electron] 预演' : '[prune-electron] 已裁剪';
  console.log(`${prefix} ${result.removed} 个语言包，释放 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { pruneElectron, parseArgs, KEEP_LOCALES };
