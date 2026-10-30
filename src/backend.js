'use strict';

const { decideRestart, MAX_CRASH_RESTARTS } = require('../lib/backend-lifecycle');
const { isBackendReadyStatus } = require('../lib/readiness');
const {
  resolveDshEntry,
  resolveDshCommand,
  buildLaunchArgs,
  parseAuthenticatedUrl
} = require('../lib/dsh-adapter');
const { runTaskkill } = require('../lib/secure-exec');

// DSH 后端子进程生命周期 + local-runtime 启动看门狗/熔断。
// 通过依赖注入接收 Electron 与 main.js 组合根的可变状态，行为与抽取前的 main.js 一致。
function createBackend(deps) {
  const {
    spawn,
    http,
    fs,
    path,
    dialog,
    t,
    toWslPath,
    cleanStaleLocks,
    getDshHome,
    getLocalRuntimeDir,
    getPort,
    getEngine,
    isSafeMode,
    isQuitting,
    getWorkspaceDir,
    getMainWindow,
    getRuntimeDir,
    getBundledNodeExe,
    buildBackendEnv,
    currentRegistryUrl,
    cleanupOldBrokenRuntimeDirs,
    getLocalDshVersion,
    hydratePresetPlugins,
    setForceBundledRuntime,
    setLocalRuntimeBrokenUntil,
    sendRuntimeLog,
    watchdogMs,
    probeMs,
    loadFailureThreshold,
    brokenWindowMs
  } = deps;

  let dshProcess = null;
  let crashCount = 0;
  let useLocalRuntime = false;
  let exitRestartSuppressedFor = null;
  let watchedRuntimeExitCode = null;
  let localRuntimeSpawnError = null;
  let watchdogTimer = null;
  let backendLoadFailures = 0;
  let isBackendReadyState = false;
  let authenticatedBackendUrl = null;

  function killProcessTree() {
    isBackendReadyState = false;
    if (!dshProcess || !dshProcess.pid) return;
    const proc = dshProcess;
    proc.killedByUs = true;
    const pid = proc.pid;
    dshProcess = null;
    try {
      if (process.platform === 'win32') {
        runTaskkill(pid);
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
  }

  function clearLocalRuntimeWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function promoteLocalRuntimeSession(reason) {
    clearLocalRuntimeWatchdog();
    useLocalRuntime = false;
    console.log(`[dsh-watchdog] 热更内核通过启动看门狗${reason ? `（${reason}）` : ''}，交由常规崩溃重启策略接管。`);
  }

  function armLocalRuntimeWatchdog(proc) {
    if (!useLocalRuntime || !proc || !proc.pid) return;
    clearLocalRuntimeWatchdog();
    console.log(`[dsh-watchdog] 已启用 ${watchdogMs}ms 启动看门狗（local-runtime 热更内核）。`);
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      verifyLocalRuntimeHealth().catch((err) => {
        console.warn(`[dsh-watchdog] 健康校验异常: ${err.message}`);
      });
    }, watchdogMs);
  }

  async function verifyLocalRuntimeHealth() {
    if (isQuitting()) return;
    if (!dshProcess) {
      if (localRuntimeSpawnError) {
        await breakLocalRuntimeCircuit(`后端子进程启动失败: ${localRuntimeSpawnError.message}`);
      } else if (watchedRuntimeExitCode === null) {
        promoteLocalRuntimeSession('进程已按预期结束');
      } else {
        await breakLocalRuntimeCircuit(`15 秒内后端子进程异常退出 (code ${watchedRuntimeExitCode})`);
      }
      return;
    }
    if (await waitForBackendReady(probeMs)) {
      promoteLocalRuntimeSession('后端服务已就绪');
      return;
    }
    if (backendLoadFailures >= loadFailureThreshold) {
      await breakLocalRuntimeCircuit('15 秒内后端服务未就绪，且窗口已连续加载失败');
      return;
    }
    promoteLocalRuntimeSession('后端仍在启动中，放行观察');
  }

  async function breakLocalRuntimeCircuit(reason) {
    if (isQuitting() || !useLocalRuntime) return;
    setForceBundledRuntime(true);
    setLocalRuntimeBrokenUntil(Date.now() + brokenWindowMs);
    clearLocalRuntimeWatchdog();
    useLocalRuntime = false;
    const localRuntimeDir = getLocalRuntimeDir();
    let quarantinedTo = null;
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const brokenPath = `${localRuntimeDir}.broken.${timestamp}`;
      fs.renameSync(localRuntimeDir, brokenPath);
      quarantinedTo = brokenPath;
      cleanupOldBrokenRuntimeDirs(2);
    } catch (err) {
      try {
        const brokenVersion = getLocalDshVersion() || 'unknown';
        fs.mkdirSync(localRuntimeDir, { recursive: true });
        fs.writeFileSync(
          path.join(localRuntimeDir, '.broken-marker.json'),
          JSON.stringify(
            {
              brokenVersion,
              reason,
              at: new Date().toISOString(),
              detail: err.message
            },
            null,
            2
          )
        );
      } catch (markerErr) {
        console.warn(`[dsh-watchdog] 写入回退标志文件失败: ${markerErr.message}`);
      }
    }
    console.warn(`[dsh-watchdog] 触发熔断: ${reason}${quarantinedTo ? `，已隔离至 ${quarantinedTo}` : '，已写入回退标志文件'}`);
    exitRestartSuppressedFor = dshProcess;
    killProcessTree();
    crashCount = 0;
    startDshBackend(true);
    const ready = await waitForBackendReady();
    await showLocalRuntimeFallbackNotice(reason, ready);
  }

  async function showLocalRuntimeFallbackNotice(reason, ready) {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    if (ready) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: t('dialog.rollback.doneTitle'),
        message: t('dialog.rollback.doneMessage'),
        detail: t('dialog.rollback.doneDetail', { reason }),
        buttons: [t('dialog.common.ok')]
      });
      return;
    }
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: t('dialog.rollback.notReadyTitle'),
      message: t('dialog.rollback.notReadyMessage'),
      detail: t('dialog.rollback.notReadyDetail', { reason }),
      buttons: [t('dialog.common.ok')]
    });
  }

  function describeBackendUrl(value) {
    try {
      return new URL(value).origin;
    } catch {
      return '[已脱敏]';
    }
  }

  function startDshBackend(resetCrash = true) {
    killProcessTree();
    cleanStaleLocks(getDshHome());
    hydratePresetPlugins();
    if (resetCrash) {
      crashCount = 0;
    }
    const runtimeDir = getRuntimeDir();
    const port = getPort();
    const workspaceDir = getWorkspaceDir();
    const args = buildLaunchArgs({ port, safeMode: isSafeMode() });
    const env = buildBackendEnv();
    const isWindows = process.platform === 'win32';
    watchedRuntimeExitCode = null;
    localRuntimeSpawnError = null;
    useLocalRuntime = false;
    if (getEngine() === 'wsl2' && isWindows) {
      const rawWslWorkspace = toWslPath(workspaceDir);
      const cleanWslWorkspace = rawWslWorkspace.replace(/^["']|["']$/g, '');
      const safeWslWorkspace = "'" + cleanWslWorkspace.replace(/'/g, "'\\''") + "'";
      const wslArgs = buildLaunchArgs({ port, safeMode: isSafeMode() }).join(' ');
      const wslCmd = `cd ${safeWslWorkspace} && npx --yes @deepseek-ai/dsh ${wslArgs}`;
      dshProcess = spawn('wsl.exe', ['--', 'bash', '-lc', wslCmd], {
        stdio: 'pipe',
        windowsHide: true,
        env: {
          ...process.env,
          NPM_CONFIG_REGISTRY: currentRegistryUrl(),
          COREPACK_NPM_REGISTRY: currentRegistryUrl(),
          COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'
        }
      });
    } else {
      const dshCliJs = resolveDshEntry(runtimeDir, fs);
      const dshCmd = resolveDshCommand(runtimeDir, process.platform, fs);
      const bundledNode = getBundledNodeExe();
      const commonSpawnOpts = {
        cwd: workspaceDir,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'pipe',
        windowsHide: true,
        detached: !isWindows
      };
      if (bundledNode && dshCliJs) {
        dshProcess = spawn(bundledNode, [dshCliJs, ...args], commonSpawnOpts);
        useLocalRuntime = path.resolve(runtimeDir) === path.resolve(getLocalRuntimeDir());
      } else if (dshCmd) {
        dshProcess = spawn(dshCmd, args, {
          ...commonSpawnOpts,
          shell: isWindows
        });
        useLocalRuntime = path.resolve(runtimeDir) === path.resolve(getLocalRuntimeDir());
      } else {
        dshProcess = null;
        const missingMessage = [
          '[dsh-backend] 未找到可用的 DSH 运行时，已停止启动（不再通过 npx 联网安装）。',
          `runtimeDir: ${runtimeDir}`,
          '请重新安装应用，或先运行 npm run runtime:prepare 生成运行时后重试。'
        ].join('\n');
        console.error(missingMessage);
        if (!isQuitting() && getMainWindow()) {
          dialog.showErrorBox(t('error.runtimeMissing'), missingMessage);
        }
        return false;
      }
    }
    const proc = dshProcess;
    armLocalRuntimeWatchdog(proc);

    let stdoutAccumulator = '';
    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => {
        const line = String(chunk);
        const logLine = line.replace(
          /dsh web:\s*(https?:\/\/[^\s()]+)/gi,
          (_, url) => `dsh web: ${describeBackendUrl(url)}`
        );
        console.log(`[dsh] ${logLine}`);
        stdoutAccumulator += line;
        const lastNewline = stdoutAccumulator.lastIndexOf('\n');
        if (lastNewline >= 0) {
          const complete = stdoutAccumulator.slice(0, lastNewline);
          const captured = parseAuthenticatedUrl(complete, { port });
          if (captured) {
            authenticatedBackendUrl = captured;
            console.log(`[dsh-auth] 成功捕获启动认证 URL: ${describeBackendUrl(authenticatedBackendUrl)}`);
          }
        }
        if (stdoutAccumulator.length > 20000) {
          stdoutAccumulator = stdoutAccumulator.slice(-5000);
        }
        sendRuntimeLog(line);
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        const line = String(chunk);
        console.warn(`[dsh] ${line}`);
        sendRuntimeLog(line);
        if (!authenticatedBackendUrl) {
          const captured = parseAuthenticatedUrl(line, { port });
          if (captured) {
            authenticatedBackendUrl = captured;
            console.log(`[dsh-auth] 从 stderr 捕获启动认证 URL: ${describeBackendUrl(authenticatedBackendUrl)}`);
          }
        }
      });
    }

    proc.on('error', (err) => {
      console.error(`[dsh-backend] Failed to spawn backend: ${err.message}`);
      if (useLocalRuntime) {
        localRuntimeSpawnError = err;
      }
      if (dshProcess === proc) {
        dshProcess = null;
      }
      if (!isQuitting() && getMainWindow()) {
        dialog.showErrorBox(t('error.backendStartFailed'), String(err.message || err));
      }
    });

    proc.on('exit', (code) => {
      if (dshProcess === proc) {
        dshProcess = null;
      }
      if (exitRestartSuppressedFor === proc) {
        exitRestartSuppressedFor = null;
        console.warn(`[dsh-watchdog] 熔断接管的旧进程已退出 (code ${code})，跳过自动重启。`);
        return;
      }
      if (useLocalRuntime && !proc.killedByUs && !isQuitting() && !localRuntimeSpawnError) {
        watchedRuntimeExitCode = code;
      }
      const decision = decideRestart({
        isQuitting: isQuitting(),
        killedByUs: !!proc.killedByUs,
        code,
        failures: crashCount
      });
      crashCount = decision.failures;
      if (decision.action === 'give-up') {
        const msg = `[dsh-watchdog] Backend exited with code ${code} ${MAX_CRASH_RESTARTS + 1} times in a row. Auto-restart disabled — use the Engine menu to retry.`;
        console.error(msg);
        const mainWindow = getMainWindow();
        if (mainWindow) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: t('dialog.common.dsStudioTitle'),
            message: t('error.backendCrashLoop')
          });
        }
      } else if (decision.action === 'restart') {
        if (useLocalRuntime) {
          console.warn(
            `[dsh-watchdog] 热更内核启动期内异常退出 (code ${code})，交由 ${watchdogMs}ms 看门狗统一裁决。`
          );
          return;
        }
        console.warn(
          `[dsh-watchdog] Backend exited with code ${code}, re-attempting in ${decision.delayMs}ms (streak ${decision.failures}).`
        );
        setTimeout(() => {
          if (!isQuitting()) startDshBackend(false);
        }, decision.delayMs);
      }
    });
    return true;
  }

  function waitForBackendReady(timeoutMs = 30000) {
    const start = Date.now();
    const port = getPort();
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };
      const check = () => {
        if (done) return;
        const req = http.get(`http://127.0.0.1:${port}`, (res) => {
          const statusCode = res.statusCode;
          res.resume();
          if (isBackendReadyStatus(statusCode)) {
            finish(true);
          } else if (Date.now() - start > timeoutMs) {
            finish(false);
          } else {
            setTimeout(check, 400);
          }
        });
        req.on('error', () => {
          if (Date.now() - start > timeoutMs) {
            finish(false);
          } else {
            setTimeout(check, 400);
          }
        });
        req.setTimeout(5000, () => {
          req.destroy();
        });
        req.end();
      };
      check();
    });
  }

  return {
    startDshBackend,
    waitForBackendReady,
    killProcessTree,
    clearWatchdog: clearLocalRuntimeWatchdog,
    isRunning() {
      return Boolean(dshProcess);
    },
    isReady() {
      return isBackendReadyState;
    },
    markReady(value) {
      isBackendReadyState = Boolean(value);
    },
    getAuthUrl() {
      return authenticatedBackendUrl;
    },
    clearAuthUrl() {
      authenticatedBackendUrl = null;
    },
    getTargetUrl() {
      return authenticatedBackendUrl || `http://127.0.0.1:${getPort()}`;
    },
    noteLoadFailure(errorCode, errorDescription) {
      backendLoadFailures += 1;
      console.warn(`[dsh-watchdog] 后端页面加载失败 code=${errorCode} ${errorDescription}（连续 ${backendLoadFailures} 次）`);
    },
    resetLoadFailures() {
      backendLoadFailures = 0;
    }
  };
}

module.exports = { createBackend };
