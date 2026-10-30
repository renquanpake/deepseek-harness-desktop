'use strict';

function createRestartController({
  backend,
  startDshBackend,
  waitForBackendReady,
  findAvailablePort,
  installAppProtocol,
  getMainWindow,
  getPort,
  setPort,
  defaultPort = 3080,
  authWaitMs = 10_000,
  pollMs = 100,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  onReady = () => {},
  rebuildMenus = () => {},
  operationLog = { append: () => {} },
  logContext = () => ({}),
  warn = console.warn
}) {
  async function performRestart() {
    backend.markReady(false);
    backend.clearAuthUrl();
    setPort(await findAvailablePort(getPort() || defaultPort));
    operationLog.append('restart', { port: getPort(), ...logContext() });

    if (!startDshBackend()) {
      backend.markReady(false);
      operationLog.append('restart-failed', { port: getPort(), stage: 'spawn' });
      return false;
    }

    const ready = await waitForBackendReady();
    backend.markReady(ready);
    operationLog.append(ready ? 'backend-ready' : 'backend-not-ready', { port: getPort() });
    if (ready) installAppProtocol();

    if (ready) {
      let authUrl = backend.getAuthUrl();
      if (!authUrl) {
        const deadline = now() + authWaitMs;
        while (!authUrl && now() < deadline) {
          await sleep(pollMs);
          authUrl = backend.getAuthUrl();
        }
        if (!authUrl) {
          warn('[restart] 后端已就绪但未捕获认证 URL，将加载裸地址；出现 401 时请检查上游输出格式。');
        }
      }
    }

    const targetUrl = backend.getTargetUrl();
    const window = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (window && !window.isDestroyed()) {
      if (ready) onReady(targetUrl, getPort());
      rebuildMenus();
    }
    return ready;
  }

  return { performRestart };
}

module.exports = { createRestartController };
