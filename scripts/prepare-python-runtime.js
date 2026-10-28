#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ensurePythonRuntime, STAMP_FILENAME, RUNTIME_SUBDIR } = require('../lib/python-runtime');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_RUNTIME_DIR = path.join(ROOT_DIR, 'dsh-runtime');
const DEFAULT_MANIFEST_PATH = path.join(ROOT_DIR, 'build', 'runtime-manifest.json');

function usage() {
  return [
    '用法: node scripts/prepare-python-runtime.js [选项]',
    '',
    '选项:',
    '  --runtime-dir <dir>   运行时根目录，默认 <项目>/dsh-runtime',
    '  --python <exe>        Python 可执行文件，默认环境变量 DSH_PYTHON 或 python',
    '  --manifest <file>     运行时清单，默认 <项目>/build/runtime-manifest.json',
    '  -h, --help            显示帮助',
    '',
    '退出码: 0 表示运行时可用或安装成功；1 表示检查/安装失败。'
  ].join('\n');
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} 缺少参数值`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    runtimeDir: DEFAULT_RUNTIME_DIR,
    python: process.env.DSH_PYTHON || 'python',
    manifest: DEFAULT_MANIFEST_PATH,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--runtime-dir') {
      options.runtimeDir = path.resolve(takeValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith('--runtime-dir=')) {
      options.runtimeDir = path.resolve(arg.slice('--runtime-dir='.length));
    } else if (arg === '--python') {
      options.python = takeValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--python=')) {
      options.python = arg.slice('--python='.length);
    } else if (arg === '--manifest') {
      options.manifest = path.resolve(takeValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith('--manifest=')) {
      options.manifest = path.resolve(arg.slice('--manifest='.length));
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return options;
}

function formatList(items) {
  return items.length > 0 ? items.join(', ') : '(无)';
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`[prepare-python-runtime] 参数错误: ${err.message}`);
    console.error(usage());
    return 1;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  console.log(`[prepare-python-runtime] Python: ${options.python}`);
  console.log(`[prepare-python-runtime] 运行时目录: ${path.join(options.runtimeDir, RUNTIME_SUBDIR)}`);
  console.log(`[prepare-python-runtime] 清单: ${options.manifest}`);

  fs.mkdirSync(path.join(options.runtimeDir, RUNTIME_SUBDIR), { recursive: true });

  const result = await ensurePythonRuntime({
    runtimeDir: options.runtimeDir,
    pythonExe: options.python,
    manifest: options.manifest
  });

  if (!result.ok) {
    console.error(`[prepare-python-runtime] 失败: ${result.reason}`);
    return 1;
  }

  console.log(`[prepare-python-runtime] 新安装 (${result.installed.length}): ${formatList(result.installed)}`);
  console.log(`[prepare-python-runtime] 已跳过 (${result.skipped.length}): ${formatList(result.skipped)}`);
  console.log(`[prepare-python-runtime] stamp: ${path.join(options.runtimeDir, RUNTIME_SUBDIR, STAMP_FILENAME)}`);
  console.log('[prepare-python-runtime] 完成');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[prepare-python-runtime] 未捕获错误: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}

module.exports = { main, parseArgs };
