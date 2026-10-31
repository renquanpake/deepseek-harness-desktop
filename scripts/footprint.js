'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHELL_FILES = ['main.js', 'preload.js', 'prepare-runtime.js'];

function listFiles(dir, predicate) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, predicate));
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

function lineCount(files) {
  let total = 0;
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      total += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch {
      /* 读不到的文件跳过 */
    }
  }
  return total;
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const file of listFiles(dir, () => true)) {
    try {
      total += fs.statSync(file).size;
    } catch {
      /* 读不到的文件跳过 */
    }
  }
  return total;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function measureShell() {
  const jsFiles = SHELL_FILES.map((file) => path.join(ROOT, file)).filter((file) => fs.existsSync(file))
    .concat(listFiles(path.join(ROOT, 'src'), (file) => file.endsWith('.js')))
    .concat(listFiles(path.join(ROOT, 'lib'), (file) => file.endsWith('.js')))
    .concat(listFiles(path.join(ROOT, 'scripts'), (file) => file.endsWith('.js')));
  const testFiles = listFiles(path.join(ROOT, 'test'), (file) => file.endsWith('.js'));
  return {
    files: jsFiles.length,
    lines: lineCount(jsFiles),
    testFiles: testFiles.length,
    testLines: lineCount(testFiles)
  };
}

function measure({ full = false } = {}) {
  const shell = measureShell();
  const result = {
    shell,
    runtime: fs.existsSync(path.join(ROOT, 'dsh-runtime')) ? mb(dirSize(path.join(ROOT, 'dsh-runtime'))) : 'not prepared'
  };
  if (full) result.nodeModules = mb(dirSize(path.join(ROOT, 'node_modules')));
  return result;
}

function main(argv = process.argv.slice(2)) {
  const full = argv.includes('--full');
  const result = measure({ full });
  console.log(`[footprint] 外壳源码: ${result.shell.files} 个文件 / ${result.shell.lines} 行`);
  console.log(`[footprint] 测试: ${result.shell.testFiles} 个文件 / ${result.shell.testLines} 行`);
  console.log(`[footprint] 内置运行时: ${result.runtime}`);
  if (full) console.log(`[footprint] node_modules: ${result.nodeModules}`);
  console.log('[footprint] 生产依赖: 0（运行时全部内置）');
  return result;
}

if (require.main === module) {
  main();
}

module.exports = { measure, measureShell, dirSize, lineCount, mb };
