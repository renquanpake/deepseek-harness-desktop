'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const ENTRY_FILES = ['main.js', 'preload.js'];
const SOURCE_DIRS = ['lib', 'src'];

const STATIC_ASSETS = [
  { entry: 'splash.html', kind: 'file', reason: 'main.js 通过 loadFile 加载启动页' },
  { entry: 'locales', kind: 'dir', reason: 'lib/i18n.js 从 __dirname/../locales 读取语言包' },
  { entry: 'build', kind: 'dir', reason: 'src/ui-menus.js 从 appDir/build 读取托盘图标' }
];

const REQUIRE_PATTERN = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function listJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function resolveRuntimeTarget(root, fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) return base;
  return null;
}

function collectRuntimeRequires(root = ROOT) {
  const files = [];
  for (const entry of ENTRY_FILES) {
    const full = path.join(root, entry);
    if (fs.existsSync(full)) files.push(full);
  }
  for (const dir of SOURCE_DIRS) {
    files.push(...listJsFiles(path.join(root, dir)));
  }

  const requires = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    REQUIRE_PATTERN.lastIndex = 0;
    let match = REQUIRE_PATTERN.exec(source);
    while (match) {
      const resolved = resolveRuntimeTarget(root, file, match[1]);
      if (resolved) {
        const rel = toPosix(path.relative(root, resolved));
        if (!rel.startsWith('..')) {
          requires.push({ entry: rel, kind: 'file', reason: `${toPosix(path.relative(root, file))} 通过 require 加载` });
        }
      }
      match = REQUIRE_PATTERN.exec(source);
    }
  }
  return requires;
}

function collectRequiredEntries(root = ROOT) {
  const seen = new Map();
  const add = (item) => {
    if (!item || !item.entry) return;
    if (!seen.has(item.entry)) seen.set(item.entry, item);
  };
  add({ entry: 'package.json', kind: 'file', reason: 'electron-builder 应用清单与主进程入口' });
  for (const item of collectRuntimeRequires(root)) add(item);
  for (const item of STATIC_ASSETS) add(item);
  return [...seen.values()].sort((a, b) => a.entry.localeCompare(b.entry));
}

function matchesPattern(rel, pattern) {
  const normalized = toPosix(pattern);
  if (normalized.endsWith('/')) {
    const dir = normalized.slice(0, -1);
    return rel === dir || rel.startsWith(normalized);
  }
  const globIndex = normalized.indexOf('**');
  if (globIndex >= 0) return rel.startsWith(normalized.slice(0, globIndex));
  return rel === normalized;
}

function isCovered(rel, patterns) {
  const normalized = toPosix(rel);
  return (patterns || []).some((pattern) => matchesPattern(normalized, pattern));
}

function findUncoveredEntries(root = ROOT, patterns) {
  const files = patterns || readBuildFiles(root);
  return collectRequiredEntries(root).filter((item) => !isCovered(item.entry, files));
}

function readBuildFiles(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = pkg && pkg.build && pkg.build.files;
  return Array.isArray(files) ? files : [];
}

function loadAsar() {
  try {
    return require('@electron/asar');
  } catch {
    return null;
  }
}

function checkAsar(asarPath, root = ROOT) {
  if (!asarPath) return { checked: false, reason: '未指定 asar 路径' };
  if (!fs.existsSync(asarPath)) {
    return { checked: false, ok: false, reason: `未找到打包产物: ${asarPath}` };
  }
  const asar = loadAsar();
  if (!asar) {
    return { checked: false, skipped: true, reason: '当前环境未安装 @electron/asar，跳过产物内文件校验' };
  }

  const entries = asar.listPackage(asarPath).map((entry) => toPosix(entry).replace(/^\/+/, ''));
  const entrySet = new Set(entries);
  const missing = [];
  for (const item of collectRequiredEntries(root)) {
    const rel = toPosix(item.entry);
    if (item.kind === 'dir') {
      const hasChildren = entries.some((entry) => entry.startsWith(`${rel}/`));
      if (!hasChildren) missing.push(item);
      continue;
    }
    if (!entrySet.has(rel)) missing.push(item);
  }
  return { checked: true, ok: missing.length === 0, missing };
}

function formatMissing(missing) {
  return missing.map((item) => `  - ${item.entry}  (${item.reason})`).join('\n');
}

function runCli(argv) {
  const asarIndex = argv.indexOf('--asar');
  const asarPath = asarIndex >= 0 ? argv[asarIndex + 1] : null;
  const root = ROOT;

  const files = readBuildFiles(root);
  const missing = findUncoveredEntries(root, files);
  let failed = false;

  if (missing.length > 0) {
    failed = true;
    console.error('[verify-packaging] build.files 未覆盖以下运行时必需条目:');
    console.error(formatMissing(missing));
  } else {
    console.log(`[verify-packaging] build.files 已覆盖全部 ${collectRequiredEntries(root).length} 个运行时必需条目。`);
    console.log(`[verify-packaging] build.files = ${JSON.stringify(files)}`);
  }

  if (asarPath) {
    const result = checkAsar(asarPath, root);
    if (!result.checked) {
      if (result.skipped) {
        console.log(`[verify-packaging] ${result.reason}`);
      } else {
        failed = true;
        console.error(`[verify-packaging] ${result.reason}`);
      }
    } else if (result.ok) {
      console.log(`[verify-packaging] 产物 ${asarPath} 包含全部必需条目。`);
    } else {
      failed = true;
      console.error('[verify-packaging] 打包产物缺少以下必需条目:');
      console.error(formatMissing(result.missing));
    }
  }

  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

module.exports = {
  collectRequiredEntries,
  collectRuntimeRequires,
  findUncoveredEntries,
  isCovered,
  matchesPattern,
  readBuildFiles,
  checkAsar
};
