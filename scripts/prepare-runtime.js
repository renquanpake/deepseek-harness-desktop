// 打包准备：把 dsh 及其依赖复制到 dsh-runtime/，供 electron 自带 node 运行
// 用户无需安装 Node.js；dsh 随安装包内置
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules');
const dest = path.join(root, 'dsh-runtime', 'node_modules');

function main() {
  if (!fs.existsSync(src)) {
    console.error('node_modules 不存在，请先 npm install');
    process.exit(1);
  }
  fs.rmSync(path.join(root, 'dsh-runtime'), { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  // 复制 @deepseek-ai 作用域包
  copyDir(path.join(src, '@deepseek-ai'), path.join(dest, '@deepseek-ai'));

  // 复制 dsh 的全部依赖（去重：从 @deepseek-ai/dsh 的 package.json 里读）
  const dshPkg = require(path.join(src, '@deepseek-ai', 'dsh', 'package.json'));
  const deps = { ...(dshPkg.dependencies || {}) };
  const seen = new Set(Object.keys(deps));
  let queue = Object.keys(deps);

  // BFS 收集全部依赖树
  while (queue.length) {
    const name = queue.shift();
    const pkgDir = path.join(src, name);
    if (!fs.existsSync(pkgDir)) {
      // 可能嵌套在作用域里
      console.warn(`[warn] 依赖 ${name} 未在顶层 node_modules 找到，跳过`);
      continue;
    }
    copyDir(pkgDir, path.join(dest, name));
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const subDeps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
    for (const k of Object.keys(subDeps)) {
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(k);
      }
    }
  }

  // 复制 .bin（dsh CLI 入口）
  copyDir(path.join(src, '.bin'), path.join(dest, '.bin'));

  // 写一个 runtime 标记
  fs.writeFileSync(path.join(root, 'dsh-runtime', 'RUNTIME.json'), JSON.stringify({
    version: dshPkg.version,
    preparedAt: new Date().toISOString(),
  }, null, 2));

  const sizeMB = (getSize(dest) / 1024 / 1024).toFixed(1);
  console.log(`[runtime] dsh-runtime 准备完成: ${dshPkg.version}, 共 ${seen.size} 个依赖包, ${sizeMB} MB`);
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function getSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += getSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

main();
