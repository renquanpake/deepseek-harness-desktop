'use strict';

// 自动清理历史遗留死代码与临时过程文件，确保 Git 工作树 100% 纯净
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const LEGACY_PATHS = [
  'shell',
  'electron',
  'docs/superpowers',
  'CHANGES.patch',
  'CHANGELOG_AI.md',
  'README_PUSH_GUIDE.md',
  'main.old.js',
  'main.stage1.js',
  'main.stage2.js',
  'main.stage3.js',
  'preload.old.js',
  'prepare-runtime.old.js',
  'README.old.md',
  'scripts/test-backend.js',
  'scripts/test-electron-node.js',
  'scripts/test-runtime.js',
  'scripts/test-runtime2.js',
  'scripts/test-runtime3.js',
  'scripts/dl-electron.js',
  'scripts/extract-7z.py',
  'scripts/prepare-runtime.deprecated.js',
  'scripts/patch-dsh-runtime.old.js'
];

for (const rel of LEGACY_PATHS) {
  const fullPath = path.join(ROOT, rel);
  try {
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`[clean-legacy] Removed obsolete path: ${rel}`);
    }
  } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
}
