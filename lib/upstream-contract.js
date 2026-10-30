'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  resolveDshEntry,
  buildLaunchArgs,
  parseAuthenticatedUrl,
  readDshVersion,
  isVersionSupported
} = require('./dsh-adapter');

const DEFAULT_TIMEOUT_MS = 90_000;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function launchRuntime({
  entry,
  port,
  workspaceDir,
  dshHome,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnFn = spawn,
  platform = process.platform
}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(process.execPath, [entry, ...buildLaunchArgs({ port })], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: 'pipe',
      windowsHide: true
    });

    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill(platform === 'win32' ? undefined : 'SIGTERM');
      } catch {
        /* 进程可能已经退出，忽略 */
      }
      reject(new Error(`上游内核在 ${timeoutMs}ms 内没有输出认证 URL\n--- 输出 ---\n${output.slice(-4000)}`));
    }, timeoutMs);

    function handle(chunk) {
      output += String(chunk);
      if (output.length > 200_000) output = output.slice(-50_000);
      const lastNewline = output.lastIndexOf('\n');
      if (lastNewline < 0) return;
      const captured = parseAuthenticatedUrl(output.slice(0, lastNewline), { port });
      if (captured && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: captured, child, output, stop: () => stopChild(child) });
      }
    }

    child.stdout?.on('data', handle);
    child.stderr?.on('data', handle);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`上游内核在输出认证 URL 前退出，code=${code}\n--- 输出 ---\n${output.slice(-4000)}`));
    });
  });
}

function stopChild(child) {
  if (!child || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 进程可能已经退出，忽略 */
      }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function probeIndex({ baseUrl, authenticatedUrl, fetchFn = fetch }) {
  const steps = [];
  const origin = new URL(baseUrl).origin;

  const anonymous = await fetchFn(`${origin}/`, { redirect: 'manual' });
  steps.push({ name: 'index without token returns 401', ok: anonymous.status === 401, detail: String(anonymous.status) });

  const tokenResponse = await fetchFn(authenticatedUrl, { redirect: 'manual' });
  const cookies = typeof tokenResponse.headers.getSetCookie === 'function'
    ? tokenResponse.headers.getSetCookie()
    : [];
  const issuedRedirect = tokenResponse.status >= 300 && tokenResponse.status < 400;
  steps.push({
    name: 'token url issues an auth redirect',
    ok: issuedRedirect && cookies.length > 0,
    detail: `${tokenResponse.status}, cookies=${cookies.length}`
  });

  const cookieHeader = cookies.map((cookie) => cookie.split(';')[0]).join('; ');
  const index = await fetchFn(`${origin}/`, {
    redirect: 'manual',
    headers: cookieHeader ? { cookie: cookieHeader } : {}
  });
  const html = await index.text();
  const isAppShell = /<div[^>]+id="root"|<base/i.test(html);
  steps.push({
    name: 'authenticated index serves the web shell',
    ok: index.status === 200 && isAppShell,
    detail: `${index.status}, ${html.length} bytes`
  });

  return { ok: steps.every((step) => step.ok), steps };
}

async function runContractCheck({
  runtimeDir,
  spawnFn = spawn,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  workspaceDir = os.tmpdir(),
  log = console
} = {}) {
  const version = readDshVersion(runtimeDir);
  const entry = resolveDshEntry(runtimeDir);
  const steps = [];

  if (!version) {
    steps.push({ name: 'runtime compatibility', ok: false, detail: '未找到内核版本' });
    return { ok: false, steps };
  }
  if (!isVersionSupported(version)) {
    steps.push({ name: 'runtime compatibility', ok: false, detail: `内核版本 ${version} 超出已验证范围` });
    return { ok: false, steps, version };
  }
  if (!entry) {
    steps.push({ name: 'runtime compatibility', ok: false, detail: '未找到可启动的 dsh 入口' });
    return { ok: false, steps, version };
  }

  const port = await findFreePort();
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-home-'));
  let session = null;

  try {
    try {
      session = await launchRuntime({ entry, port, workspaceDir, dshHome, timeoutMs, spawnFn });
      steps.push({ name: 'prints an authenticated url', ok: true, detail: new URL(session.url).origin });
    } catch (error) {
      steps.push({ name: 'prints an authenticated url', ok: false, detail: error.message.split('\n')[0] });
      return { ok: false, steps, version };
    }

    const probe = await probeIndex({
      baseUrl: `http://127.0.0.1:${port}/`,
      authenticatedUrl: session.url,
      fetchFn
    });
    steps.push(...probe.steps);

    const ok = steps.every((step) => step.ok);
    if (log) {
      log.log(`[contract] 内核 ${version} @ ${entry}`);
      for (const step of steps) {
        log.log(`[contract] ${step.ok ? 'PASS' : 'FAIL'} ${step.name}${step.detail ? ` (${step.detail})` : ''}`);
      }
      log.log(ok ? '[contract] 契约检查通过。' : '[contract] 契约检查失败。');
    }
    return { ok, steps, version, url: session.url };
  } finally {
    if (session) await session.stop();
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  findFreePort,
  launchRuntime,
  stopChild,
  probeIndex,
  runContractCheck
};
