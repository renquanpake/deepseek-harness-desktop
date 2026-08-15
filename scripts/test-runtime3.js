// 验证 runtime：启动 dsh → 轮询端口 → 请求页面 → 退出
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
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
  const ok = await waitPort(3099, 60000);
  console.log('port ready:', ok);
  if (ok) {
    http.get('http://127.0.0.1:3099/', (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        console.log('HTTP', res.statusCode, '| bytes:', body.length, '| title:', (body.match(/<title>(.*?)<\/title>/) || [])[1]);
        c.kill();
        process.exit(0);
      });
    }).on('error', (e) => { console.log('req error:', e.message); c.kill(); process.exit(1); });
  } else {
    console.log('OUTPUT:', out.slice(0, 2000));
    c.kill();
    process.exit(1);
  }
})();
