// 验证 dsh-runtime 完整性：用系统 node 启动 runtime 里的 dsh
const { spawn } = require('child_process');
const path = require('path');

const nodeBin = process.execPath; // 当前 node
const runtimeDir = path.join(__dirname, '..', 'dsh-runtime');
const script = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

console.log('node:', nodeBin);
console.log('script:', script);

const c = spawn(nodeBin, [script, 'web', '--host', '127.0.0.1', '--port', '3099'], {
  cwd: runtimeDir,
  windowsHide: true,
});
c.stdout.on('data', (d) => console.log('OUT:', String(d).trim().slice(0, 160)));
c.stderr.on('data', (d) => console.log('ERR:', String(d).trim().slice(0, 160)));
c.on('exit', (code) => console.log('EXIT:', code));

setTimeout(() => {
  c.kill();
  process.exit(0);
}, 25000);
