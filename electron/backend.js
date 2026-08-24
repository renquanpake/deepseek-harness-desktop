// 后端管理：spawn dsh web 服务 → 端口轮询就绪 → 进程树清理
const { spawn, execFile } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const DEFAULT_PORT = 3080;
const DEFAULT_HOST = '127.0.0.1';

class DshBackend {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, log = console.log } = {}) {
    this.host = host;
    this.port = port;
    this.log = log;
    this.child = null;
    this._shuttingDown = false;
  }

  // 定位 dsh 入口：打包后用 resources/dsh-runtime（electron 自带 node 跑），开发模式用本地 node_modules
  _resolveDshEntry() {
    // 打包后 process.resourcesPath 指向 <app>/resources，dsh-runtime 由 extraResources 放进去
    const packaged = process.resourcesPath
      ? path.join(process.resourcesPath, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : null;
    if (packaged && fs.existsSync(packaged)) {
      return { mode: 'electron-node', script: packaged };
    }
    // 开发模式：系统 node 运行本地 node_modules
    const local = path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    return { mode: 'system-node', script: local };
  }

  // 定位桌面端内嵌 profile（打包后在 resources/profiles，开发模式在项目根 profiles）
  _resolveBundledProfile() {
    const packaged = process.resourcesPath
      ? path.join(process.resourcesPath, 'profiles')
      : null;
    if (packaged && fs.existsSync(packaged)) return packaged;
    const dev = path.join(__dirname, '..', 'profiles');
    return fs.existsSync(dev) ? dev : null;
  }

  async start() {
    if (this.child) return; // 已在运行
    const entry = this._resolveDshEntry();
    if (!fs.existsSync(entry.script)) {
      throw new Error(`dsh 入口不存在: ${entry.script}，请先 npm install`);
    }

    this.log(`[backend] 启动 dsh web (${entry.mode}): ${entry.script}`);

    // 用内嵌 profile 覆盖 DSH_HOME，避免用户系统 profile 缺依赖导致启动失败
    const bundledProfile = this._resolveBundledProfile();
    const baseEnv = { ...process.env };
    if (bundledProfile) {
      // DSH_HOME = profiles 的父目录（dsh 会在下面找 profiles/web/）
      baseEnv.DSH_HOME = path.dirname(bundledProfile);
      this.log(`[backend] DSH_HOME → ${baseEnv.DSH_HOME}`);
    }

    if (entry.mode === 'electron-node') {
      // ELECTRON_RUN_AS_NODE=1 让 electron.exe 当纯 node 用，用户无需安装 Node
      // cwd 必须指向 runtime 根目录 (bin.js → lib → dsh → @deepseek-ai → node_modules → runtime)
      const runtimeDir = path.join(path.dirname(entry.script), '..', '..', '..', '..');
      this.child = spawn(process.execPath, ['--no-warnings', entry.script, 'web', '--host', this.host, '--port', String(this.port)], {
        cwd: runtimeDir,
        env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      const nodeBin = process.env.DSH_NODE_BIN || 'node';
      this.child = spawn(nodeBin, [entry.script, 'web', '--host', this.host, '--port', String(this.port)], {
        env: { ...baseEnv, NODE_ENV: 'development' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    this.child.stdout.on('data', (d) => this.log(`[dsh] ${String(d).trimEnd()}`));
    this.child.stderr.on('data', (d) => this.log(`[dsh:err] ${String(d).trimEnd()}`));
    this.child.on('exit', (code, signal) => {
      this.log(`[backend] dsh 进程退出 code=${code} signal=${signal}`);
      this.child = null;
      if (!this._shuttingDown) {
        // 非主动关闭时退出应用，避免窗口挂在一个死服务上
        this.onBackendCrashed && this.onBackendCrashed(code);
      }
    });

    // 轮询端口就绪（最长 120s）
    const ok = await this._waitForPort(this.host, this.port, 120000);
    if (!ok) {
      this.stop();
      throw new Error(`等待 dsh 服务就绪超时 (${this.host}:${this.port})`);
    }
    this.log(`[backend] dsh 服务就绪: http://${this.host}:${this.port}`);
    return `http://${this.host}:${this.port}`;
  }

  _waitForPort(host, port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tryOnce = () => {
        const sock = net.connect({ host, port });
        sock.setTimeout(1500);
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('timeout', () => { sock.destroy(); retry(); });
        sock.once('error', () => { sock.destroy(); retry(); });
      };
      const retry = () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tryOnce, 800);
      };
      tryOnce();
    });
  }

  // 杀掉整个进程树（Windows 用 taskkill /T）
  async stop() {
    if (!this.child) return;
    this._shuttingDown = true;
    const pid = this.child.pid;
    this.log(`[backend] 停止 dsh (pid=${pid})`);
    try {
      this.child.kill();
    } catch (_) { /* 忽略 */ }
    await new Promise((r) => {
      const timer = setTimeout(r, 5000);
      this.child.once('exit', () => { clearTimeout(timer); r(); });
    });
    if (this.child) {
      // 仍未退出，Windows 上强制杀进程树
      await new Promise((resolve) => {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      });
      this.child = null;
    }
    this._shuttingDown = false;
    this.log('[backend] dsh 已停止');
  }
}

module.exports = { DshBackend, DEFAULT_HOST, DEFAULT_PORT };
