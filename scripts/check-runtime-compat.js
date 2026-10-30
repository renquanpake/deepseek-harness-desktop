'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  resolveDshEntry,
  resolveDshCommand,
  readDshVersion,
  isVersionSupported,
  describeSupportRange,
  readProfileManifest,
  validateProfileManifest
} = require('../lib/dsh-adapter');

function findPnpm(runtimeDir, fsImpl = fs) {
  const candidates = [
    path.join(runtimeDir, 'pnpm.cjs'),
    path.join(runtimeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(runtimeDir, 'node_modules', 'pnpm', 'dist', 'pnpm.cjs')
  ];
  return candidates.find((candidate) => {
    try {
      return fsImpl.existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;
}

function checkRuntime({ runtimeDir, fsImpl = fs, platform = process.platform } = {}) {
  if (!runtimeDir) throw new TypeError('runtimeDir is required');
  const problems = [];
  const warnings = [];

  const version = readDshVersion(runtimeDir, fsImpl);
  if (!version) {
    problems.push('未找到 @deepseek-ai/dsh 的 package.json 或 version 字段');
  } else if (!isVersionSupported(version)) {
    problems.push(`内核版本 ${version} 超出已验证范围 ${describeSupportRange()}`);
  }

  const entry = resolveDshEntry(runtimeDir, fsImpl);
  const command = resolveDshCommand(runtimeDir, platform, fsImpl);
  if (!entry && !command) {
    problems.push('未找到可启动的 dsh 入口（bin 映射与常见布局都缺失）');
  }

  const pnpm = findPnpm(runtimeDir, fsImpl);
  if (!pnpm) warnings.push('未找到内置 pnpm，内核热更新将不可用');

  const presetProfile = path.join(runtimeDir, 'default-profile', 'profiles', 'web', 'package.json');
  let hasPreset = false;
  try {
    hasPreset = fsImpl.existsSync(presetProfile);
  } catch {
    /* 检查失败按缺失处理 */
  }
  if (!hasPreset) {
    warnings.push('未找到 default-profile，预置插件不会生效');
  } else {
    const manifest = readProfileManifest(path.dirname(presetProfile), fsImpl);
    const verdict = validateProfileManifest(manifest);
    if (!verdict.ok) {
      problems.push(`default-profile 结构不符合当前上游格式：${verdict.errors.join('; ')}`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    version,
    entry,
    command,
    pnpm
  };
}

function parseArgs(argv) {
  const options = { runtimeDir: path.join(process.cwd(), 'dsh-runtime'), quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime-dir') options.runtimeDir = path.resolve(argv[++index] || '');
    else if (arg === '--quiet') options.quiet = true;
  }
  return options;
}

function run(argv = process.argv.slice(2), fsImpl = fs) {
  const options = parseArgs(argv);
  const result = checkRuntime({ runtimeDir: options.runtimeDir, fsImpl });

  if (!options.quiet) {
    console.log(`[compat] 运行时目录: ${options.runtimeDir}`);
    if (result.version) console.log(`[compat] 内核版本: ${result.version}（已验证范围 ${describeSupportRange()}）`);
    if (result.entry) console.log(`[compat] 入口: ${result.entry}`);
    else if (result.command) console.log(`[compat] 入口: ${result.command}`);
    for (const warning of result.warnings) console.warn(`[compat] 警告: ${warning}`);
    for (const problem of result.problems) console.error(`[compat] 错误: ${problem}`);
    console.log(result.ok ? '[compat] 运行时与外壳兼容。' : '[compat] 运行时与外壳不兼容，已阻止继续。');
  }

  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = { checkRuntime, findPnpm, parseArgs, run };
