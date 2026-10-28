const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  globalShortcut,
  ipcMain,
  Notification,
  shell,
  dialog,
  clipboard,
  protocol,
  net
} = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { toWslPath } = require('./lib/win-utils');
const { getAutoStart, setAutoStart } = require('./lib/auto-start');
const { findAvailablePort, prependPathDirs } = require('./lib/env-utils');
const { cleanStaleLocks } = require('./lib/lock-cleaner');
const { hydratePresetPlugins } = require('./lib/preset-hydrator');
const { runSelfRepair } = require('./lib/self-repair');
const { isBackendHttp, isTrustedSender } = require('./lib/trusted-url');
const { decideRestart, MAX_CRASH_RESTARTS } = require('./lib/backend-lifecycle');
const { pickWorkspaceMode } = require('./lib/cli-workspace');
const { registerWindowsContextMenu, unregisterWindowsContextMenu } = require('./lib/context-menu');
const { runTaskkill } = require('./lib/secure-exec');
const { isBackendReadyStatus } = require('./lib/readiness');
const { createSingleFlight } = require('./lib/restart-guard');
const { registerIpcHandlers } = require('./src/ipc');
const {
  APP_SCHEME,
  APP_HOST,
  isAppUrl,
  buildCsp,
  registerAppSchemePrivileges,
  createAppProtocolHandler
} = require('./lib/app-protocol');
const UPDATE_CHECK = require('./lib/update-check');
const { createI18n } = require('./lib/i18n');
const { createClipboardBridge } = require('./src/clipboard');
const { createWorktreeManager } = require('./src/worktree');
const { createRuntimeLayout } = require('./src/runtime-layout');
const { createPresetPlugins } = require('./src/preset-plugins');
const { createUpdateFlow } = require('./src/update-flow');
const { createUiMenus } = require('./src/ui-menus');
const {
  semverCompare,
  isNewer,
  decideUpdatePlan,
  buildProxyedUrls,
  pickInstallerUrl,
  downloadWithProxies,
  verifyInstallerIntegrity
} = require('./lib/updater');


let mainWindow = null;
let i18nInstance = null;
let dshProcess = null;
let crashCount = 0;
let isQuitting = false;
let currentPort = 3080;
let currentEngine = 'win-native';
let isSafeMode = false;
let targetWorkspaceDir = process.cwd();
let targetWorkspaceIsWorktree = false;

const DSH_PORTABLE_MARKER_DIR = 'portable-data';
const LOCAL_RUNTIME_WATCHDOG_MS = 15000;
const WATCHDOG_BACKEND_PROBE_MS = 5000;
const WATCHDOG_LOAD_FAILURE_THRESHOLD = 2;
const LOCAL_RUNTIME_BROKEN_WINDOW_MS = 6 * 60 * 60 * 1000;

let PORTABLE_DATA_ROOT = null;
let PORTABLE_APPDATA = null;
let PORTABLE_LOCALAPPDATA = null;
let PORTABLE_USERPROFILE = null;
let useLocalRuntime = false;
let forceBundledRuntime = false;
let localRuntimeBrokenUntil = 0;
let exitRestartSuppressedFor = null;
let watchedRuntimeExitCode = null;
let localRuntimeSpawnError = null;
let watchdogTimer = null;
let backendLoadFailures = 0;
let isBackendReadyState = false;
let authenticatedBackendUrl = null;
let worktreeCloseDialogShowing = false;
const activeWorktreeSession = { worktreePath: null, repoPath: null, branchName: null };

const worktreeManager = createWorktreeManager({
  session: activeWorktreeSession,
  isWindowsPlatform,
  clearWorkspaceFlag: () => {
    targetWorkspaceIsWorktree = false;
  }
});

// app.getLocale() only has a reliable value after ready, so build the i18n singleton lazily on first use.
function getI18n() {
  if (!i18nInstance) {
    let locale = null;
    try {
      locale = app.getLocale();
    } catch {}
    i18nInstance = createI18n({ locale: locale || undefined });
  }
  return i18nInstance;
}

function t(key, params) {
  return getI18n().t(key, params);
}

function resolvePortableDataRoot() {
  const declaredExeDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const exeDir = path.dirname(app.getPath('exe'));
  const candidates = [];
  if (declaredExeDir && path.resolve(declaredExeDir) !== path.resolve(exeDir)) {
    candidates.push(path.join(declaredExeDir, DSH_PORTABLE_MARKER_DIR));
  }
  candidates.push(path.join(exeDir, DSH_PORTABLE_MARKER_DIR));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {}
  }
  if (declaredExeDir) {
    const portableRoot = path.join(path.resolve(declaredExeDir), DSH_PORTABLE_MARKER_DIR);
    try {
      fs.mkdirSync(portableRoot, { recursive: true });
      return portableRoot;
    } catch {}
  }
  return null;
}

function ensurePortableSubDir(name) {
  if (!PORTABLE_DATA_ROOT) return null;
  try {
    const target = path.join(PORTABLE_DATA_ROOT, name);
    fs.mkdirSync(target, { recursive: true });
    return target;
  } catch (err) {
    console.warn(`[portable] 创建便携数据子目录失败 ${name}: ${err.message}`);
    return null;
  }
}

function ensurePortableGitConfig() {
  if (!PORTABLE_DATA_ROOT || process.platform !== 'win32') return;
  const portableGitConfig = path.join(PORTABLE_DATA_ROOT, 'home', '.gitconfig');
  if (fs.existsSync(portableGitConfig)) return;
  const systemGitConfig = path.join(os.homedir(), '.gitconfig');
  let content = '';
  try {
    if (fs.existsSync(systemGitConfig)) {
      content = `[include]\n\tpath = "${systemGitConfig.replace(/\\/g, "/")}"\n`;
    }
  } catch {
    return;
  }
  if (!content) return;
  try {
    fs.writeFileSync(portableGitConfig, content);
  } catch (err) {
    console.warn(`[portable] 写入便携 .gitconfig 失败: ${err.message}`);
  }
}

function resolveDshHome() {
  PORTABLE_DATA_ROOT = resolvePortableDataRoot();
  if (PORTABLE_DATA_ROOT) {
    try {
      fs.mkdirSync(PORTABLE_DATA_ROOT, { recursive: true });
      PORTABLE_APPDATA = ensurePortableSubDir('appdata-roaming');
      PORTABLE_LOCALAPPDATA = ensurePortableSubDir('appdata-local');
      PORTABLE_USERPROFILE = ensurePortableSubDir('userprofile');
      ensurePortableSubDir('home');
      ensurePortableSubDir('temp-captures');
      ensurePortableGitConfig();
      app.setPath('userData', path.join(PORTABLE_DATA_ROOT, 'electron-userdata'));
      return path.join(PORTABLE_DATA_ROOT, '.dsh');
    } catch (err) {
      console.warn(`[portable] 便携数据根目录不可写，回退至用户主目录: ${err.message}`);
      PORTABLE_DATA_ROOT = null;
      PORTABLE_APPDATA = null;
      PORTABLE_LOCALAPPDATA = null;
      PORTABLE_USERPROFILE = null;
    }
  }
  return path.join(os.homedir(), '.dsh');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', async (event, argv) => {
    if (!mainWindow) return;
    const secondArgv = Array.isArray(argv) && argv.length > 1 ? argv : process.argv;
    const request = resolveWorkspaceRequest(secondArgv);
    const desiredDir = request ? request.dir : targetWorkspaceDir;
    if (desiredDir !== targetWorkspaceDir) {
      switchWorkspace(desiredDir, request ? request.worktreeSession : null);
      mainWindow.setTitle(`DeepSeek Harness Studio — ${targetWorkspaceDir}`);
      await restartWithCurrentConfig();
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

const DSH_HOME = resolveDshHome();
const LOCAL_RUNTIME_DIR = path.join(DSH_HOME, 'local-runtime');

const runtimeLayout = createRuntimeLayout({
  localRuntimeDir: LOCAL_RUNTIME_DIR,
  appDir: __dirname
});
const {
  getBundledRuntimeDir,
  isLocalRuntimeUsable,
  getLocalDshVersion,
  getBundledNodeExe,
  getBundledPnpmCjs,
  getRuntimeBinDirs
} = runtimeLayout;

function getCurrentDshVersion() {
  return runtimeLayout.getCurrentDshVersion(getRuntimeDir());
}

function isLocalRuntimeAvailable() {
  if (forceBundledRuntime || Date.now() < localRuntimeBrokenUntil) {
    return false;
  }
  const markerPath = path.join(LOCAL_RUNTIME_DIR, '.broken-marker.json');
  try {
    if (fs.existsSync(markerPath)) {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      const currentVer = getLocalDshVersion();
      if (currentVer && marker.brokenVersion && semverCompare(currentVer, marker.brokenVersion) > 0) {
        try { fs.unlinkSync(markerPath); } catch {}
        localRuntimeBrokenUntil = 0;
      } else {
        return false;
      }
    }
  } catch {}
  return isLocalRuntimeUsable();
}

function getRuntimeDir() {
  if (isLocalRuntimeAvailable()) return LOCAL_RUNTIME_DIR;
  return getBundledRuntimeDir();
}

// prependPathDirs imported from ./lib/env-utils

function currentRegistryUrl() {
  return UPDATE_CHECK.CONFIG.REGISTRY + '/';
}

function buildBackendEnv() {
  const env = {
    ...process.env,
    DSH_HOME,
    PORT: String(currentPort),
    NPM_CONFIG_REGISTRY: currentRegistryUrl(),
    COREPACK_NPM_REGISTRY: currentRegistryUrl(),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    ADBLOCK: '1',
    DISABLE_OPENCOLLECTIVE: '1',
    NPM_CONFIG_PACKAGE_IMPORT_METHOD: 'copy',
    NPM_CONFIG_NODE_LINKER: 'hoisted'
  };
  if (PORTABLE_DATA_ROOT) {
    if (PORTABLE_USERPROFILE) env.USERPROFILE = PORTABLE_USERPROFILE;
    if (PORTABLE_APPDATA) env.APPDATA = PORTABLE_APPDATA;
    const portableHome = path.join(PORTABLE_DATA_ROOT, 'home');
    env.HOME = portableHome;
    if (process.platform === 'win32') {
      env.AppData = PORTABLE_APPDATA || path.join(PORTABLE_DATA_ROOT, 'appdata-roaming');
      env.LocalAppData = PORTABLE_LOCALAPPDATA || path.join(PORTABLE_DATA_ROOT, 'appdata-local');
    }
  }
  const binDirs = getRuntimeBinDirs();
  if (binDirs.length) {
    const rawPath = env.PATH || env.Path || process.env.PATH || process.env.Path || '';
    const updatedPath = prependPathDirs(rawPath, binDirs);
    env.PATH = updatedPath;
    if (isWindowsPlatform()) {
      env.Path = updatedPath;
    }
  }
  return env;
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event, currentPort, mainWindow)) {
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
  }
}

const ENABLE_APP_PROTOCOL = /^(1|true|yes)$/i.test(String(process.env.DSH_ENABLE_APP_PROTOCOL || ''));

// registerSchemesAsPrivileged 必须在 app.whenReady 之前完成
registerAppSchemePrivileges(protocol);

function backendProtocolOrigin() {
  const targetUrl = authenticatedBackendUrl || `http://127.0.0.1:${currentPort}`;
  try {
    return new URL(targetUrl).origin;
  } catch {
    return null;
  }
}

function installAppProtocolHandler() {
  if (!ENABLE_APP_PROTOCOL) return;
  const origin = backendProtocolOrigin();
  const csp = buildCsp({ backendOrigin: origin, dev: process.env.DSH_DEV === '1' });
  const handler = createAppProtocolHandler({
    protocol,
    net,
    appRoot: __dirname,
    backendOrigin: origin,
    registerPrivileges: false
  });
  protocol.handle(APP_SCHEME, async (request) => {
    const response = await handler(request);
    const headers = new Headers(response.headers);
    headers.set('content-security-policy', csp);
    const hasBody = request.method !== 'HEAD' && response.body !== null;
    return new Response(hasBody ? response.body : null, {
      status: response.status,
      statusText: response.statusText || '',
      headers
    });
  });
}

// cleanStaleLocks is imported from ./lib/lock-cleaner

function hydratePresetPluginsIfNeeded(force = false) {
  const runtimeDir = getRuntimeDir();
  const presetProfile = path.join(runtimeDir, 'default-profile');
  const res = hydratePresetPlugins(presetProfile, DSH_HOME, { force });
  if (res.hydrated) {
    console.log('[preset] 已深度校准并补齐出厂增强插件配置');
  }
}

function switchWorkspace(dir, worktreeSession) {
  targetWorkspaceDir = dir;
  targetWorkspaceIsWorktree = false;
  activeWorktreeSession.worktreePath = null;
  activeWorktreeSession.repoPath = null;
  activeWorktreeSession.branchName = null;
  if (worktreeSession && worktreeSession.created) {
    targetWorkspaceIsWorktree = true;
    activeWorktreeSession.worktreePath = worktreeSession.worktreePath;
    activeWorktreeSession.repoPath = worktreeSession.repoPath;
    activeWorktreeSession.branchName = worktreeSession.branchName;
  }
}

function resolveWorkspaceRequest(argv) {
  const picked = pickWorkspaceMode(argv);
  if (!picked) return null;
  if (picked.mode === 'open-dir') {
    return { dir: path.resolve(picked.value), worktreeSession: null };
  }
  const baseDir = path.resolve(picked.value);
  const session = worktreeManager.createIsolatedGitWorktree(baseDir);
  return { dir: session.worktreePath, worktreeSession: session };
}

function handleCliWorkspaceArgs(argv) {
  const request = resolveWorkspaceRequest(argv);
  if (request) {
    switchWorkspace(request.dir, request.worktreeSession);
  }
}


async function handleWorktreeWindowClose() {
  if (worktreeCloseDialogShowing || !mainWindow) return;
  worktreeCloseDialogShowing = true;
  try {
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: t('dialog.worktreeClose.title'),
      message: t('dialog.worktreeClose.message'),
      detail: t('dialog.worktreeClose.detail', {
        path: activeWorktreeSession.worktreePath || targetWorkspaceDir,
        branch: activeWorktreeSession.branchName || t('dialog.common.unknown')
      }),
      buttons: [t('dialog.worktreeClose.keep'), t('dialog.worktreeClose.destroy'), t('dialog.worktreeClose.cancel')],
      defaultId: 1,
      cancelId: 2
    });
    if (response.response === 2) return;
    if (response.response === 1) {
      killProcessTree();
      const removed = worktreeManager.removeActiveWorktree();
      if (!removed && activeWorktreeSession.worktreePath) {
        console.warn('[git-worktree] Worktree 回收未完全成功，请手动检查磁盘目录。');
      }
    }
    isQuitting = true;
    app.quit();
  } finally {
    worktreeCloseDialogShowing = false;
  }
}

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
  } catch {}
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
  console.log(`[dsh-watchdog] 已启用 ${LOCAL_RUNTIME_WATCHDOG_MS}ms 启动看门狗（local-runtime 热更内核）。`);
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    verifyLocalRuntimeHealth().catch((err) => {
      console.warn(`[dsh-watchdog] 健康校验异常: ${err.message}`);
    });
  }, LOCAL_RUNTIME_WATCHDOG_MS);
}

async function verifyLocalRuntimeHealth() {
  if (isQuitting) return;
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
  if (await waitForBackendReady(WATCHDOG_BACKEND_PROBE_MS)) {
    promoteLocalRuntimeSession('后端服务已就绪');
    return;
  }
  if (backendLoadFailures >= WATCHDOG_LOAD_FAILURE_THRESHOLD) {
    await breakLocalRuntimeCircuit('15 秒内后端服务未就绪，且窗口已连续加载失败');
    return;
  }
  promoteLocalRuntimeSession('后端仍在启动中，放行观察');
}

async function breakLocalRuntimeCircuit(reason) {
  if (isQuitting || !useLocalRuntime) return;
  forceBundledRuntime = true;
  localRuntimeBrokenUntil = Date.now() + LOCAL_RUNTIME_BROKEN_WINDOW_MS;
  clearLocalRuntimeWatchdog();
  useLocalRuntime = false;
  let quarantinedTo = null;
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const brokenPath = `${LOCAL_RUNTIME_DIR}.broken.${timestamp}`;
    fs.renameSync(LOCAL_RUNTIME_DIR, brokenPath);
    quarantinedTo = brokenPath;
    cleanupOldBrokenRuntimeDirs(2);
  } catch (err) {
    try {
      const brokenVersion = getLocalDshVersion() || 'unknown';
      fs.mkdirSync(LOCAL_RUNTIME_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(LOCAL_RUNTIME_DIR, '.broken-marker.json'),
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
  cleanStaleLocks(DSH_HOME);
  hydratePresetPluginsIfNeeded();
  if (resetCrash) {
    crashCount = 0;
  }
  const runtimeDir = getRuntimeDir();
  const args = ['web', '--no-open', '--port', String(currentPort)];
  if (isSafeMode) {
    args.push('--safe-mode');
  }
  const env = buildBackendEnv();
  const isWindows = process.platform === 'win32';
  watchedRuntimeExitCode = null;
  localRuntimeSpawnError = null;
  useLocalRuntime = false;
  if (currentEngine === 'wsl2' && isWindows) {
    const rawWslWorkspace = toWslPath(targetWorkspaceDir);
    const cleanWslWorkspace = rawWslWorkspace.replace(/^["']|["']$/g, '');
    const safeFlag = isSafeMode ? '--safe-mode' : '';
    const safeWslWorkspace = "'" + cleanWslWorkspace.replace(/'/g, "'\\''") + "'";
    const wslCmd = `cd ${safeWslWorkspace} && npx --yes @deepseek-ai/dsh web --no-open --port ${currentPort} ${safeFlag}`;
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
    const dshCliJs = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs');
    const dshCmd = path.join(
      runtimeDir,
      'node_modules',
      '.bin',
      isWindows ? 'dsh.cmd' : 'dsh'
    );
    const bundledNode = getBundledNodeExe();
    const commonSpawnOpts = {
      cwd: targetWorkspaceDir,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
      windowsHide: true,
      detached: !isWindows
    };
    if (bundledNode && fs.existsSync(dshCliJs)) {
      dshProcess = spawn(bundledNode, [dshCliJs, ...args], commonSpawnOpts);
      useLocalRuntime = path.resolve(runtimeDir) === path.resolve(LOCAL_RUNTIME_DIR);
    } else if (fs.existsSync(dshCmd)) {
      dshProcess = spawn(dshCmd, args, {
        ...commonSpawnOpts,
        shell: isWindows
      });
      useLocalRuntime = path.resolve(runtimeDir) === path.resolve(LOCAL_RUNTIME_DIR);
    } else {
      dshProcess = null;
      const missingMessage = [
        '[dsh-backend] 未找到可用的 DSH 运行时，已停止启动（不再通过 npx 联网安装）。',
        `runtimeDir: ${runtimeDir}`,
        '请重新安装应用，或先运行 npm run runtime:prepare 生成运行时后重试。'
      ].join('\n');
      console.error(missingMessage);
      if (!isQuitting && mainWindow) {
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
      const match = stdoutAccumulator.match(/dsh web:\s*(https?:\/\/[^\s()]+)(?:[\r\n]|\s+\()/i);
      if (match && match[1]) {
        authenticatedBackendUrl = match[1].trim();
        console.log(`[dsh-auth] 成功捕获启动认证 URL: ${describeBackendUrl(authenticatedBackendUrl)}`);
      }
      if (stdoutAccumulator.length > 20000) {
        stdoutAccumulator = stdoutAccumulator.slice(-5000);
      }
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('dsh:runtime-log', line);
      }
    });
  }
  if (proc.stderr) {
    proc.stderr.on('data', (chunk) => {
      const line = String(chunk);
      console.warn(`[dsh] ${line}`);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('dsh:runtime-log', line);
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
    if (!isQuitting && mainWindow) {
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
    if (useLocalRuntime && !proc.killedByUs && !isQuitting && !localRuntimeSpawnError) {
      watchedRuntimeExitCode = code;
    }
    const decision = decideRestart({
      isQuitting,
      killedByUs: !!proc.killedByUs,
      code,
      failures: crashCount
    });
    crashCount = decision.failures;
    if (decision.action === 'give-up') {
      const msg = `[dsh-watchdog] Backend exited with code ${code} ${MAX_CRASH_RESTARTS + 1} times in a row. Auto-restart disabled — use the Engine menu to retry.`;
      console.error(msg);
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
          `[dsh-watchdog] 热更内核启动期内异常退出 (code ${code})，交由 ${LOCAL_RUNTIME_WATCHDOG_MS}ms 看门狗统一裁决。`
        );
        return;
      }
      console.warn(
        `[dsh-watchdog] Backend exited with code ${code}, re-attempting in ${decision.delayMs}ms (streak ${decision.failures}).`
      );
      setTimeout(() => {
        if (!isQuitting) startDshBackend(false);
      }, decision.delayMs);
    }
  });
  return true;
}

function waitForBackendReady(timeoutMs = 30000) {
  const start = Date.now();
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
      const req = http.get(`http://127.0.0.1:${currentPort}`, (res) => {
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

// findAvailablePort imported from ./lib/env-utils

async function performRestartWithCurrentConfig() {
  isBackendReadyState = false;
  authenticatedBackendUrl = null;
  currentPort = await findAvailablePort(currentPort || 3080);
  if (!startDshBackend()) {
    isBackendReadyState = false;
    return false;
  }
  const ready = await waitForBackendReady();
  isBackendReadyState = Boolean(ready);
  if (ready) installAppProtocolHandler();
  if (ready && !authenticatedBackendUrl) {
    const deadline = Date.now() + 1500;
    while (!authenticatedBackendUrl && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const targetUrl = authenticatedBackendUrl || `http://127.0.0.1:${currentPort}`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (ready) {
      mainWindow.loadURL(targetUrl);
      mainWindow.setTitle(`DeepSeek Harness — ${targetWorkspaceDir}`);
      mainWindow.webContents.send('dsh:backend-ready', targetUrl, currentPort);
    }
    buildNativeAppMenu();
    updateTrayMenu();
  }
  return ready;
}

const restartWithCurrentConfig = createSingleFlight(performRestartWithCurrentConfig);



function setWindowProgress(title) {
  if (mainWindow) mainWindow.setTitle(title);
}

function clearWindowProgress() {
  if (mainWindow) mainWindow.setTitle(`DeepSeek Harness Studio — ${targetWorkspaceDir}`);
}

function getShellVersion() {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}

const presetPlugins = createPresetPlugins({
  getBundledRuntimeDir,
  localRuntimeDir: LOCAL_RUNTIME_DIR,
  registryUrl: () => currentRegistryUrl()
});
const {
  readFactoryPresetPluginNames,
  readLocalRuntimePkg,
  writeLocalRuntimePkg,
  isPresetPluginInstalled,
  mergeLocalRuntimePresetDependencies,
  pruneLocalRuntimeDependencies,
  runPnpmAdd
} = presetPlugins;

const updateFlow = createUpdateFlow({
  app,
  dialog,
  shell,
  getMainWindow: () => mainWindow,
  t,
  getCurrentDshVersion,
  getShellVersion,
  localRuntimeDir: LOCAL_RUNTIME_DIR,
  portableMarkerDir: DSH_PORTABLE_MARKER_DIR,
  getPortableDataRoot: () => PORTABLE_DATA_ROOT,
  getBundledNodeExe,
  getBundledPnpmCjs,
  preset: presetPlugins,
  hooks: {
    killProcessTree,
    startDshBackend,
    restartWithCurrentConfig,
    clearLocalRuntimeWatchdog,
    setForceBundledRuntime: (value) => {
      forceBundledRuntime = value;
    },
    resetLocalRuntimeBrokenUntil: () => {
      localRuntimeBrokenUntil = 0;
    },
    setWindowProgress,
    clearWindowProgress,
    setQuitting: () => {
      isQuitting = true;
    }
  }
});
const runUpdateCheck = updateFlow.runUpdateCheck;
const revertToFactoryRuntime = updateFlow.revertToFactoryRuntime;
const cleanupOldBrokenRuntimeDirs = updateFlow.cleanupOldBrokenRuntimeDirs;
const isPortable = updateFlow.isPortable;


const uiMenus = createUiMenus({
  app,
  dialog,
  shell,
  Menu,
  Tray,
  nativeImage,
  t,
  getMainWindow: () => mainWindow,
  isWindowsPlatform,
  getState: () => ({ port: currentPort, engine: currentEngine, safeMode: isSafeMode }),
  setEngine: (value) => {
    currentEngine = value;
  },
  setSafeMode: (value) => {
    isSafeMode = value;
  },
  setQuitting: () => {
    isQuitting = true;
  },
  actions: {
    getAutoStart: () => getAutoStart(app),
    setAutoStart: (enable) => setAutoStart(app, enable),
    runUpdateCheck,
    revertToFactoryRuntime,
    restartWithCurrentConfig,
    createWorktreeSession: (dir) => worktreeManager.createIsolatedGitWorktree(dir),
    switchWorkspace,
    pasteClipboard: () => clipboardBridge.feedClipboardIntoEditor(),
    hydratePresetPlugins: (force) => hydratePresetPluginsIfNeeded(force),
    async runSelfRepairSession() {
      const report = runSelfRepair({
        dshHome: DSH_HOME,
        runtimeDir: getRuntimeDir(),
        killOrphanProcess: () => killProcessTree()
      });
      const ready = await restartWithCurrentConfig();
      return { report, ready };
    },
    registerContextMenu: () => registerWindowsContextMenu(),
    unregisterContextMenu: () => unregisterWindowsContextMenu(),
    getCurrentDshVersion,
    getShellVersion,
    getDshHome: () => DSH_HOME,
    composeWindowTitle: () => `DeepSeek Harness Studio — ${targetWorkspaceDir}`
  }
});
const { buildNativeAppMenu, updateTrayMenu, getTray } = uiMenus;
function createTray() {
  uiMenus.createTray(__dirname);
}

function isWindowsPlatform() {
  return process.platform === 'win32';
}

const clipboardBridge = createClipboardBridge({
  clipboard,
  getMainWindow: () => mainWindow,
  getPortableDataRoot: () => PORTABLE_DATA_ROOT,
  getEngine: () => currentEngine,
  isWindowsPlatform
});

function registerRelayShortcut() {
  const preferred = 'Alt+Space';
  const ok = globalShortcut.register(preferred, toggleMainWindowVisibility);
  if (ok) return;
  console.warn(`[main] Global shortcut ${preferred} is occupied by the system; falling back to CommandOrControl+Alt+D.`);
  globalShortcut.register('CommandOrControl+Alt+D', toggleMainWindowVisibility);
}

function toggleMainWindowVisibility() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createMainWindow() {
  const isHiddenLaunch = process.argv.includes('--hidden') || process.argv.includes('--minimized');
  const isWindows = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    show: !isHiddenLaunch,
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: `DeepSeek Harness Studio — ${targetWorkspaceDir}`,
    autoHideMenuBar: true,
    titleBarStyle: isWindows ? 'hidden' : 'default',
    titleBarOverlay: isWindows ? {
      color: '#18181b',
      symbolColor: '#a1a1aa',
      height: 38
    } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  });
  buildNativeAppMenu();
  installAppProtocolHandler();
  if (ENABLE_APP_PROTOCOL) {
    mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/splash.html`);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'splash.html'));
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isBackendHttp(url, currentPort)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isBackendHttp(url, currentPort) || isAppUrl(url) || url.startsWith('file://')) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (validatedURL === 'about:blank' || (validatedURL && validatedURL.endsWith('splash.html'))) return;
    backendLoadFailures += 1;
    console.warn(`[dsh-watchdog] 后端页面加载失败 code=${errorCode} ${errorDescription}（连续 ${backendLoadFailures} 次）`);
  });
  mainWindow.webContents.on('dom-ready', () => {
    backendLoadFailures = 0;
  });
  mainWindow.on('close', (event) => {
    if (isQuitting || !isWindowsPlatform()) return;
    if (!getTray()) {
      isQuitting = true;
      app.quit();
      return;
    }
    event.preventDefault();
    if (targetWorkspaceIsWorktree) {
      handleWorktreeWindowClose();
      return;
    }
    mainWindow.hide();
  });
}

registerIpcHandlers({
  ipcMain,
  assertTrustedSender,
  actions: {
    nativeNotify(payload) {
      const { title, body } = payload || {};
      if (mainWindow && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
      }
      if (Notification.isSupported()) {
        const notice = new Notification({ title, body });
        notice.on('click', () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.flashFrame(false);
          }
        });
        notice.show();
      }
    },
    requestClipboardPaste() {
      clipboardBridge.feedClipboardIntoEditor();
    },
    'dsh:get-runtime-info'() {
      return {
        version: getShellVersion(),
        coreVersion: getCurrentDshVersion().version,
        port: currentPort,
        engine: currentEngine,
        safeMode: isSafeMode,
        home: DSH_HOME,
        workspaceDir: targetWorkspaceDir
      };
    },
    'dsh:get-backend-status'() {
      return {
        ready: Boolean(isBackendReadyState && dshProcess),
        url: authenticatedBackendUrl || `http://127.0.0.1:${currentPort}`,
        port: currentPort,
        engine: currentEngine,
        workspaceDir: targetWorkspaceDir
      };
    },
    'dsh:set-always-on-top'(enable) {
      if (mainWindow) {
        mainWindow.setAlwaysOnTop(Boolean(enable));
      }
      return Boolean(enable);
    },
    'dsh:get-plugin-inventory'() {
      const names = readFactoryPresetPluginNames();
      return { plugins: names };
    },
    'dsh:rehydrate-plugins'() {
      hydratePresetPluginsIfNeeded();
      return { ok: true };
    },
    async 'dsh:create-worktree-dialog'() {
      const res = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: t('dialog.openWorktreeDir.title')
      });
      if (!res.canceled && res.filePaths[0]) {
        const session = worktreeManager.createIsolatedGitWorktree(res.filePaths[0]);
        if (session.created) {
          switchWorkspace(session.worktreePath, session);
          await restartWithCurrentConfig();
        }
      }
      return { ok: true };
    },
    async 'dsh:switch-engine'(mode) {
      if (mode === 'wsl2' && process.platform !== 'win32') {
        throw new Error('wsl2 engine is only available on Windows hosts');
      }
      currentEngine = mode;
      await restartWithCurrentConfig();
      return { engine: currentEngine };
    },
    async 'dsh:restart-safe-mode'() {
      isSafeMode = !isSafeMode;
      await restartWithCurrentConfig();
      return { safeMode: isSafeMode };
    },
    'dsh:register-context-menu'() {
      const result = registerWindowsContextMenu();
      return result.total > 0 && result.failed === 0;
    },
    'dsh:unregister-context-menu'() {
      const result = unregisterWindowsContextMenu();
      return result.total > 0 && result.failed === 0;
    },
    'dsh:get-auto-start'() {
      return getAutoStart(app);
    },
    'dsh:set-auto-start'(enable) {
      const result = setAutoStart(app, Boolean(enable));
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('dsh:auto-start-changed', result);
      }
      buildNativeAppMenu();
      updateTrayMenu();
      return result;
    },
    'dsh:convert-to-wsl-path'(windowsPath) {
      return clipboardBridge.convertToWslMountPath(windowsPath);
    },
    'dsh:get-workspace-status'() {
      return {
        isWorktree: targetWorkspaceIsWorktree,
        worktreePath: activeWorktreeSession.worktreePath,
        worktreeBranch: activeWorktreeSession.branchName,
        engine: currentEngine
      };
    },
    async 'dsh:run-self-repair'() {
      console.log('[self-repair] 触发自动检修与自愈...');
      const report = runSelfRepair({
        dshHome: DSH_HOME,
        runtimeDir: getRuntimeDir(),
        killOrphanProcess: () => killProcessTree()
      });
      const ready = await restartWithCurrentConfig();
      report.ready = ready;
      report.port = currentPort;
      report.url = 'http://127.0.0.1:' + currentPort;
      return report;
    },
    'dsh:check-update'() {
      runUpdateCheck(false);
      return { ok: true };
    }
  }
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  handleCliWorkspaceArgs(process.argv);
  createMainWindow();
  createTray();
  registerRelayShortcut();
  const ready = await restartWithCurrentConfig();
  if (!ready && mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: t('dialog.common.dsStudioTitle'),
      message: t('dialog.backendNotReady.message')
    });
  }
  setTimeout(() => {
    if (!isQuitting) runUpdateCheck(true);
  }, 5000);
});

app.on('before-quit', () => {
  isQuitting = true;
  clearLocalRuntimeWatchdog();
  globalShortcut.unregisterAll();
  killProcessTree();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    killProcessTree();
    app.quit();
  }
});
