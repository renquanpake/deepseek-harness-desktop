// 验证 backend.js：启动 → 端口就绪 → stop() 后进程树被杀干净
const { DshBackend } = require('../electron/backend');
const net = require('net');

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

(async () => {
  // 用不同端口避免冲突
  const be = new DshBackend({ host: '127.0.0.1', port: 3180, log: (m) => console.log(m) });
  try {
    const url = await be.start();
    console.log('STARTED:', url, '| port open:', await portOpen(3180));
    // 找到子进程
    const pid = be.child && be.child.pid;
    console.log('child pid:', pid);
    await be.stop();
    console.log('STOPPED | port still open:', await portOpen(3180));
    // 检查进程是否还在
    const { execFile } = require('child_process');
    execFile('tasklist', ['/FI', `PID eq ${pid}`], { windowsHide: true }, (err, stdout) => {
      const alive = stdout.includes(String(pid));
      console.log('child process alive after stop:', alive, '(expect false)');
      process.exit(alive ? 1 : 0);
    });
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
