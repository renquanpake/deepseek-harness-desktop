'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  resolveDshEntry,
  buildLaunchArgs,
  parseAuthenticatedUrl,
  adoptCapturedPort,
  probeWebCapabilities,
  capabilityCacheKey,
  readCapabilityCache,
  writeCapabilityCache
} = require('../lib/dsh-adapter');

const DEFAULT_TIMEOUT_MS = 120_000;

function createLiteBackend({
  appDir,
  dshHome,
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  fsImpl = fs,
  log = { info: () => {}, error: () => {} },
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!appDir) throw new TypeError('appDir is required');
  if (!dshHome) throw new TypeError('dshHome is required');

  const runtimeDir = path.join(appDir, 'dsh-runtime');
  const cachePath = path.join(dshHome, 'lite-capabilities.json');
  let child = null;
  let output = '';
  let stopped = false;

  function tail(limit = 4000) {
    return output.length <= limit ? output : output.slice(-limit);
  }

  function resolveLaunch() {
    const entry = resolveDshEntry(runtimeDir, fsImpl);
    if (!entry) {
      throw new Error('未找到 dsh-runtime，请先运行一键部署脚本准备内核。');
    }
    const key = capabilityCacheKey(entry, fsImpl);
    let capabilities = key ? readCapabilityCache(cachePath, key, fsImpl) : null;
    if (!capabilities) {
      capabilities = probeWebCapabilities({ entry, spawnSyncFn });
      if (key && capabilities) writeCapabilityCache(cachePath, key, capabilities, fsImpl);
    }
    const nodeExe = path.join(runtimeDir, 'node.exe');
    const useBundledNode = fsImpl.existsSync(nodeExe);
    return {
      entry,
      args: buildLaunchArgs({ port: 0, capabilities }),
      command: useBundledNode ? nodeExe : process.execPath,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        ...(useBundledNode ? {} : { ELECTRON_RUN_AS_NODE: '1' })
      }
    };
  }

  async function start() {
    const launch = resolveLaunch();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stop();
        reject(new Error(`内核在 ${timeoutMs} ms 内没有输出认证 URL。\n${tail()}`));
      }, timeoutMs);

      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }

      function onData(chunk) {
        output += String(chunk);
        if (output.length > 200_000) output = output.slice(-50_000);
        const lastNewline = output.lastIndexOf('\n');
        if (lastNewline < 0) return;
        const captured = parseAuthenticatedUrl(output.slice(0, lastNewline));
        if (!captured || settled) return;
        settled = true;
        clearTimeout(timer);
        const port = adoptCapturedPort(captured, 0);
        log.info(`内核已就绪: ${new URL(captured).origin}`);
        resolve({ url: captured, port });
      }

      child = spawnFn(launch.command, [launch.entry, ...launch.args], {
        cwd: appDir,
        env: launch.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      child.once('error', (error) => fail(error));
      child.once('exit', (code) => {
        if (!settled) fail(new Error(`内核在输出认证 URL 前退出，code=${code}。\n${tail()}`));
      });
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
    });
  }

  function stop() {
    stopped = true;
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSyncFn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch (err) {
      log.error(`结束内核失败: ${err.message}`);
    }
  }

  return { start, stop, tail, isStopped: () => stopped };
}

module.exports = { createLiteBackend, DEFAULT_TIMEOUT_MS };
