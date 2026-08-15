// 前台验证 runtime：打印全部输出，20秒后退出
const { spawn } = require('child_process');
const path = require('path');

const nodeBin = process.execPath;
const runtimeDir = path.join(__dirname, '..', 'dsh-runtime');
const script = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const c = spawn(nodeBin, [script, 'web', '--host', '127.0.0.1', '--port', '3099'], {
  cwd: runtimeDir,
  windowsHide: true,
});
let out = '';
c.stdout.on('data', (d) => { out += String(d); });
c.stderr.on('data', (d) => { out += '[ERR] ' + String(d); });
c.on('exit', (code) => { console.log('EXIT:', code); });

setTimeout(() => {
  console.log('--- OUTPUT ---');
  console.log(out.slice(0, 3000));
  c.kill();
  process.exit(0);
}, 20000);
