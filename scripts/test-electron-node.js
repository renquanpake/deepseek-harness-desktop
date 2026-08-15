// 模拟打包后运行方式：ELECTRON_RUN_AS_NODE=1 用 electron.exe 跑 dsh-runtime
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const electronExe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const runtimeDir = path.join(__dirname, '..', 'dsh-runtime');
const script = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

console.log('electron.exe:', electronExe);
console.log('script:', script);

const c = spawn(electronExe, ['--no-warnings', script, 'web', '--host', '127.0.0.1', '--port', '3181'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
  cwd: runtimeDir,
  windowsHide: true,
});
let out = '';
c.stdout.on('data', (d) => { out += String(d); });
c.stderr.on('data', (d) => { out += '[ERR] ' + String(d); });
c.on('exit', (code) => console.log('EXIT:', code));

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.setTimeout(1000);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tryOnce, 800); });
      s.once('timeout', () => { s.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tryOnce, 800); });
    };
    tryOnce();
  });
}

(async () => {
  const ok = await waitPort(3181, 90000);
  console.log('ELECTRON-RUN-AS-NODE port ready:', ok);
  if (ok) {
    http.get('http://127.0.0.1:3181/', (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        console.log('HTTP', res.statusCode, '| bytes:', body.length, '| title:', (body.match(/<title>(.*?)<\/title>/) || [])[1]);
        c.kill();
        process.exit(0);
      });
    }).on('error', (e) => { console.log('req error:', e.message); c.kill(); process.exit(1); });
  } else {
    console.log('OUTPUT:', out.slice(0, 3000));
    c.kill();
    process.exit(1);
  }
})();
