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
  clipboard
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
const { hydratePresetPlugins, readJsonSafe } = require('./lib/preset-hydrator');
const { runSelfRepair } = require('./lib/self-repair');
const { isBackendHttp, isTrustedSender } = require('./lib/trusted-url');
const { decideRestart, MAX_CRASH_RESTARTS } = require('./lib/backend-lifecycle');
const { pickWorkspaceMode } = require('./lib/cli-workspace');
const { runRegCommands } = require('./lib/win-reg');
const { runGit, runReg, runTaskkill, runTasklist, readWindowsProcessCommandLine } = require('./lib/secure-exec');
const { isBackendReadyStatus } = require('./lib/readiness');
const { createSingleFlight } = require('./lib/restart-guard');
const { assertValid: assertIpcPayload } = require('./lib/ipc-schema');
const { createI18n } = require('./lib/i18n');
const {
  semverCompare,
  isNewer,
  decideUpdatePlan,
  buildProxyedUrls,
  pickInstallerUrl,
  downloadWithProxies,
  verifyInstallerIntegrity,
  checkRemoteCoreVersion: checkCoreFromUrls,
  checkRemoteShellVersion: checkShellFromUrls,
  checkRemoteReleaseAssets: checkReleaseFromUrls,
  resolveUpdateSources
} = require('./lib/updater');


let mainWindow = null;
let tray = null;
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
const WORKTREE_PROCESS_SCAN_TIMEOUT_MS = 4000;
const GIT_WORKTREE_COMMAND_TIMEOUT_MS = 30000;
const GIT_WORKTREE_ADD_TIMEOUT_MS = 180000;

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

function getBundledRuntimeDir() {
  const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh-runtime');
  if (fs.existsSync(unpackedPath)) return unpackedPath;
  const extraResPath = path.join(process.resourcesPath, 'dsh-runtime');
  if (fs.existsSync(extraResPath)) return extraResPath;
  return path.join(__dirname, 'dsh-runtime');
}

function getLocalRuntimeDshCli() {
  return path.join(LOCAL_RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs');
}

function isLocalRuntimeUsable() {
  return fs.existsSync(getLocalRuntimeDshCli());
}

function getLocalDshVersion() {
  const pkgPath = path.join(LOCAL_RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
  } catch {
    return null;
  }
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

function getRuntimeBinDirs() {
  const dirs = [];
  const nodeExe = getBundledNodeExe();
  if (nodeExe && path.basename(nodeExe).toLowerCase() === 'node.exe') {
    dirs.push(path.dirname(nodeExe));
  }
  const pnpmCjs = getBundledPnpmCjs();
  if (pnpmCjs) dirs.push(path.dirname(pnpmCjs));
  return dirs;
}

// prependPathDirs imported from ./lib/env-utils

function currentRegistryUrl() {
  return UPDATER.REGISTRY + '/';
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

function getBundledNodeExe() {
  const bundledNode = path.join(getBundledRuntimeDir(), 'node.exe');
  if (fs.existsSync(bundledNode)) return bundledNode;
  return process.execPath;
}

function getBundledPnpmCjs() {
  const runtimeDir = getBundledRuntimeDir();
  const candidates = [
    path.join(runtimeDir, 'pnpm.cjs'),
    path.join(runtimeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(runtimeDir, 'node_modules', 'pnpm', 'dist', 'pnpm.cjs')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function getCurrentDshVersion() {
  const runtimeDir = getRuntimeDir();
  const source = path.resolve(runtimeDir) === path.resolve(LOCAL_RUNTIME_DIR) ? 'hot-update' : 'factory';
  const pkgPath = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { version: pkg.version || 'unknown', source };
  } catch {
    return { version: 'unknown', source };
  }
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event, currentPort, mainWindow)) {
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
  }
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
  const session = createIsolatedGitWorktree(baseDir);
  return { dir: session.worktreePath, worktreeSession: session };
}

function handleCliWorkspaceArgs(argv) {
  const request = resolveWorkspaceRequest(argv);
  if (request) {
    switchWorkspace(request.dir, request.worktreeSession);
  }
}

function createIsolatedGitWorktree(repoDir) {
  try {
    const stamp = Math.random().toString(36).substring(2, 7);
    const baseName = path.basename(repoDir);
    const parentDir = path.dirname(repoDir);
    const worktreePath = path.join(parentDir, `${baseName}-wt-${stamp}`);
    const branchName = `dsh/task-${stamp}`;
    runGit(['worktree', 'add', worktreePath, '-b', branchName], {
      cwd: repoDir,
      stdio: 'ignore',
      windowsHide: true,
      timeout: GIT_WORKTREE_ADD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
    return { created: true, worktreePath, repoPath: repoDir, branchName };
  } catch (err) {
    console.warn('[git-worktree] Fallback to original dir:', err.message);
    return { created: false, worktreePath: repoDir, repoPath: null, branchName: null };
  }
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function findWindowsProcessesWithWorkingDir(worktreePath) {
  const pids = new Set();
  if (!isWindowsPlatform() || !worktreePath) return [];
  try {
    const output = runTasklist(
      ['/V', '/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: WORKTREE_PROCESS_SCAN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
    );
    const normalizedPath = worktreePath.toLowerCase().replace(/\s/g, '');
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('"node.exe"')) continue;
      const pidMatch = trimmed.match(/,\s*"(\d+)",/);
      if (pidMatch && isProcessAlive(Number(pidMatch[1]))) {
        pids.add(pidMatch[1]);
      }
    }
    for (const pid of [...pids]) {
      const commandLine = readWindowsProcessCommandLine(Number(pid));
      if (!commandLine) continue;
      if (commandLine.replace(/\s/g, '').toLowerCase().includes(normalizedPath)) {
        try {
          runTaskkill(Number(pid));
          console.warn(`[git-worktree] 已结束工作区残留进程 PID ${pid}`);
        } catch (killErr) {
          console.warn(`[git-worktree] 结束残留进程失败 PID ${pid}: ${killErr.message}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[git-worktree] 残留进程扫描失败（继续回收）: ${err.message}`);
  }
}

function removeActiveWorktree() {
  const { worktreePath, repoPath, branchName } = activeWorktreeSession;
  if (!worktreePath) return false;
  findWindowsProcessesWithWorkingDir(worktreePath);
  try {
    runGit(['worktree', 'remove', worktreePath, '--force'], {
      cwd: repoPath || worktreePath,
      stdio: 'ignore',
      windowsHide: true,
      timeout: GIT_WORKTREE_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
  } catch (err) {
    console.warn(`[git-worktree] git worktree remove 失败，改为直接移除目录: ${err.message}`);
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[git-worktree] 目录移除失败: ${cleanupErr.message}`);
      return false;
    }
  }
  if (repoPath && branchName) {
    try {
      runGit(['branch', '-D', branchName], {
        cwd: repoPath,
        stdio: 'ignore',
        windowsHide: true,
        timeout: GIT_WORKTREE_COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
      });
      console.warn(`[git-worktree] 已删除临时分支 ${branchName}`);
    } catch (branchErr) {
      console.warn(`[git-worktree] 临时分支删除失败（可能未提交或已被占用）: ${branchErr.message}`);
    }
  }
  activeWorktreeSession.worktreePath = null;
  activeWorktreeSession.repoPath = null;
  activeWorktreeSession.branchName = null;
  targetWorkspaceIsWorktree = false;
  return true;
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
      const removed = removeActiveWorktree();
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

const CONTEXT_MENU_COMMAND_KEY_BG = 'HKCU\\Software\\Classes\\Directory\\Background\\shell';
const CONTEXT_MENU_COMMAND_KEY_DIR = 'HKCU\\Software\\Classes\\Directory\\shell';

function contextMenuRegisterCommands(exePath) {
  return [
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen`, '/ve', '/d', 'Open with DeepSeek Harness Studio', '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen`, '/v', 'Icon', '/d', `"${exePath}"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen\\command`, '/ve', '/d', `"${exePath}" --open-dir "%V%"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen`, '/ve', '/d', 'Open with DeepSeek Harness Studio', '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen`, '/v', 'Icon', '/d', `"${exePath}"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen\\command`, '/ve', '/d', `"${exePath}" --open-dir "%1"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree`, '/ve', '/d', 'Open in New Git Worktree (DSH Studio)', '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree`, '/v', 'Icon', '/d', `"${exePath}"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree\\command`, '/ve', '/d', `"${exePath}" --worktree-dir "%V%"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree`, '/ve', '/d', 'Open in New Git Worktree (DSH Studio)', '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree`, '/v', 'Icon', '/d', `"${exePath}"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree\\command`, '/ve', '/d', `"${exePath}" --worktree-dir "%1"`, '/f']
  ];
}

function contextMenuUnregisterCommands() {
  return [
    ['delete', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen`, '/f'],
    ['delete', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen`, '/f'],
    ['delete', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree`, '/f'],
    ['delete', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree`, '/f']
  ];
}

const regSync = (args) => runReg(args);
const warnReg = (cmd, err) => console.warn(`[reg-menu] Skipped key: ${cmd}\nReason: ${err.message}`);

function registerWindowsContextMenu() {
  if (process.platform !== 'win32') {
    return { ok: 0, failed: 0, total: 0 };
  }
  return runRegCommands(contextMenuRegisterCommands(process.execPath), regSync, warnReg);
}

function unregisterWindowsContextMenu() {
  if (process.platform !== 'win32') {
    return { ok: 0, failed: 0, total: 0 };
  }
  return runRegCommands(contextMenuUnregisterCommands(), regSync, warnReg);
}

const UPDATER = {
  CORE_REGISTRY_SOURCES: [
    { id: 'npmmirror-registry', kind: 'registry', url: 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest' },
    { id: 'npm-registry', kind: 'registry', url: 'https://registry.npmjs.org/@deepseek-ai/dsh/latest' }
  ],
  SHELL_MANIFEST_SOURCES: [
    { id: 'github-raw', kind: 'github-raw', url: 'https://raw.githubusercontent.com/renquanpake/deepseek-harness-desktop/main/package.json' }
  ],
  GITHUB_RELEASE_SOURCES: [
    { id: 'github-api', kind: 'github-api', url: 'https://api.github.com/repos/renquanpake/deepseek-harness-desktop/releases/latest' }
  ],
  GITHUB_DOWNLOAD_SOURCES: [
    { id: 'github-api', kind: 'github-api', url: 'https://api.github.com/repos/renquanpake/deepseek-harness-desktop/releases/latest' }
  ],
  // 官方源优先；第三方镜像仅在本开关显式开启时参与，防止供应链投毒
  ALLOW_THIRD_PARTY_PROXY: true,
  REQUEST_TIMEOUT_MS: 8000,
  DOWNLOAD_TIMEOUT_MS: 60000,
  REGISTRY: 'https://registry.npmmirror.com',
  isChecking: false
};

function coreRegistryCandidates() {
  return resolveUpdateSources({
    sources: UPDATER.CORE_REGISTRY_SOURCES,
    allowThirdPartyProxy: UPDATER.ALLOW_THIRD_PARTY_PROXY
  });
}

function shellManifestCandidates() {
  return resolveUpdateSources({
    sources: UPDATER.SHELL_MANIFEST_SOURCES,
    allowThirdPartyProxy: UPDATER.ALLOW_THIRD_PARTY_PROXY
  });
}

function releaseCandidates() {
  return resolveUpdateSources({
    sources: UPDATER.GITHUB_RELEASE_SOURCES,
    allowThirdPartyProxy: UPDATER.ALLOW_THIRD_PARTY_PROXY
  });
}

function downloadProxies() {
  return resolveUpdateSources({
    sources: UPDATER.GITHUB_DOWNLOAD_SOURCES,
    allowThirdPartyProxy: UPDATER.ALLOW_THIRD_PARTY_PROXY
  });
}

async function checkRemoteCoreVersion() {
  return checkCoreFromUrls(coreRegistryCandidates());
}

async function checkRemoteShellVersion() {
  return checkShellFromUrls(shellManifestCandidates(), releaseCandidates());
}

async function checkRemoteReleaseAssets() {
  return checkReleaseFromUrls(releaseCandidates());
}

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

// readJsonSafe is imported from ./lib/preset-hydrator

function readFactoryPresetPluginNames() {
  const runtimeDir = getBundledRuntimeDir();
  const manifest = readJsonSafe(path.join(runtimeDir, 'preset-manifest.json'));
  const preinstalled = readJsonSafe(path.join(runtimeDir, 'preinstalled-plugins.json'));
  const factoryPkg = readJsonSafe(path.join(runtimeDir, 'package.json'));
  const names = [
    ...(Array.isArray(manifest.plugins) ? manifest.plugins : []),
    ...(Array.isArray(preinstalled.plugins) ? preinstalled.plugins : []),
    ...Object.keys((factoryPkg && factoryPkg.dependencies) || {})
  ];
  const deduped = [...new Set(names.filter((name) => typeof name === 'string' && name.trim() && !name.startsWith('@deepseek-ai/dsh')))];
  return deduped;
}

function readLocalRuntimePkg() {
  return readJsonSafe(path.join(LOCAL_RUNTIME_DIR, 'package.json')) || {};
}

function writeLocalRuntimePkg(pkg) {
  try {
    fs.mkdirSync(LOCAL_RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_RUNTIME_DIR, 'package.json'), JSON.stringify(pkg, null, 2));
    return true;
  } catch (err) {
    console.warn(`[updater] 写入 local-runtime/package.json 失败: ${err.message}`);
    return false;
  }
}

function isPresetPluginInstalled(pluginName) {
  return fs.existsSync(path.join(LOCAL_RUNTIME_DIR, 'node_modules', pluginName));
}

function mergeLocalRuntimePresetDependencies(presetPlugins) {
  const pkg = readLocalRuntimePkg();
  const deps = { ...(pkg.dependencies || {}) };
  const added = [];
  for (const pluginName of presetPlugins) {
    if (!(pluginName in deps)) {
      deps[pluginName] = '*';
      added.push(pluginName);
    }
  }
  if (!added.length) return [];
  pkg.dependencies = deps;
  return writeLocalRuntimePkg(pkg) ? added : [];
}

function pruneLocalRuntimeDependencies(names) {
  if (!names.length) return;
  const pkg = readLocalRuntimePkg();
  const deps = { ...(pkg.dependencies || {}) };
  for (const name of names) {
    delete deps[name];
  }
  pkg.dependencies = deps;
  writeLocalRuntimePkg(pkg);
}

function runPnpmAdd(nodeExe, pnpmCjs, packages) {
  return new Promise((resolve) => {
    const args = [
      pnpmCjs,
      'add',
      ...packages,
      `--registry=${currentRegistryUrl()}`,
      '--package-import-method=copy',
      '--node-linker=hoisted'
    ];
    const pnpmProc = spawn(nodeExe, args, {
      cwd: LOCAL_RUNTIME_DIR,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NPM_CONFIG_REGISTRY: currentRegistryUrl(),
        NPM_CONFIG_PACKAGE_IMPORT_METHOD: 'copy',
        NPM_CONFIG_NODE_LINKER: 'hoisted',
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false'
      },
      stdio: 'pipe',
      windowsHide: true
    });
    let stderr = '';
    let settled = false;
    const settle = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    pnpmProc.stdout.on('data', (chunk) => console.log(`[updater] ${String(chunk)}`));
    pnpmProc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      console.warn(`[updater] ${String(chunk)}`);
    });
    pnpmProc.on('error', (err) => {
      console.warn(`[updater] pnpm 启动失败: ${err.message}`);
      settle(false);
    });
    pnpmProc.on('exit', (code) => {
      if (code === 0) {
        settle(true);
      } else {
        console.warn(`[updater] pnpm 安装失败 (exit ${code}): ${stderr.slice(0, 500)}`);
        settle(false);
      }
    });
  });
}

async function installHotUpdateCore(targetVersion) {
  console.log('[hot-update] 开始更新 DSH 内核至 ' + targetVersion);
  killProcessTree();
  const nodeExe = getBundledNodeExe();
  const pnpmCjs = getBundledPnpmCjs();
  if (!nodeExe || !pnpmCjs) {
    throw new Error(t('error.hotUpdateNodeMissing'));
  }
  fs.mkdirSync(LOCAL_RUNTIME_DIR, { recursive: true });
  const pkgJsonPath = path.join(LOCAL_RUNTIME_DIR, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name: 'dsh-local-hot-update', version: '0.0.0', private: true }, null, 2)
    );
  }
  setWindowProgress(t('dialog.progress.hotUpdateCore'));
  const corePackage = targetVersion
    ? `@deepseek-ai/dsh@${targetVersion}`
    : '@deepseek-ai/dsh@latest';
  const coreInstalled = await runPnpmAdd(nodeExe, pnpmCjs, [corePackage]);
  if (!coreInstalled) {
    throw new Error(t('error.hotUpdateFailed'));
  }
  const markerFile = path.join(LOCAL_RUNTIME_DIR, '.broken-marker.json');
  if (fs.existsSync(markerFile)) {
    try { fs.unlinkSync(markerFile); } catch {}
  }
  forceBundledRuntime = false;
  localRuntimeBrokenUntil = 0;
  const presetPluginNames = readFactoryPresetPluginNames();
  if (presetPluginNames.length) {
    const added = mergeLocalRuntimePresetDependencies(presetPluginNames);
    if (added.length) {
      setWindowProgress(t('dialog.progress.syncPresets', { count: presetPluginNames.length }));
      const pluginsInstalled = await runPnpmAdd(nodeExe, pnpmCjs, added.map((name) => `${name}@*`));
      const missing = added.filter((name) => !isPresetPluginInstalled(name));
      if (missing.length) {
        pruneLocalRuntimeDependencies(missing);
      }
      if (!pluginsInstalled || missing.length) {
        console.warn(
          `[updater] 出厂预置插件未全部保留（插件仍由 default-profile 预置包提供）；` +
            `已安装 ${presetPluginNames.length - missing.length}/${added.length}，` +
            `已从 local-runtime 清单移除不可安装的插件：${missing.join(', ') || '（无）'}`
        );
      }
    }
  }
  startDshBackend();
}

function cleanupOldBrokenRuntimeDirs(keepCount = 2) {
  let parent;
  try {
    parent = path.dirname(LOCAL_RUNTIME_DIR);
    const brokenNames = fs
      .readdirSync(parent)
      .filter((name) => name.startsWith('local-runtime.broken.'))
      .sort()
      .reverse();
    if (brokenNames.length <= keepCount) return;
    for (const name of brokenNames.slice(keepCount)) {
      try {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
        console.log(`[dsh-watchdog] 已清理历史隔离内核 ${name}`);
      } catch (err) {
        console.warn(`[dsh-watchdog] 清理历史隔离内核失败 ${name}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[dsh-watchdog] 扫描隔离内核失败: ${err.message}`);
  }
}

function isPortable() {
  if (PORTABLE_DATA_ROOT) return true;
  const exeDir = path.dirname(app.getPath('exe'));
  return fs.existsSync(path.join(exeDir, DSH_PORTABLE_MARKER_DIR));
}

async function revertToFactoryRuntime() {
  forceBundledRuntime = false;
  localRuntimeBrokenUntil = 0;
  clearLocalRuntimeWatchdog();
  if (fs.existsSync(LOCAL_RUNTIME_DIR)) {
    try {
      fs.rmSync(LOCAL_RUNTIME_DIR, { recursive: true, force: true });
    } catch (err) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: t('dialog.revert.failedTitle'),
        message: t('dialog.revert.failedMessage', { message: err.message })
      });
      return;
    }
  }
  cleanupOldBrokenRuntimeDirs(0);
  await restartWithCurrentConfig();
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: t('dialog.revert.doneTitle'),
      message: t('dialog.revert.doneMessage')
    });
  }
}

async function showUpdateCheckResult(hasUpdate, coreInfo, shellInfo, remoteCore, remoteShell) {
  if (!hasUpdate) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: t('dialog.updateCheck.title'),
      message: t('dialog.updateCheck.upToDate'),
      detail: t('dialog.updateCheck.upToDateDetail', { core: coreInfo.current, shell: shellInfo.current }),
      buttons: [t('dialog.common.close')]
    });
    return null;
  }
  const tagAvailable = t('dialog.updateCheck.tagAvailable');
  const tagLatest = t('dialog.updateCheck.tagLatest');
  const unknownVersion = t('dialog.updateCheck.unknownVersion');
  const coreTag = coreInfo.needsUpdate ? tagAvailable : tagLatest;
  const shellTag = shellInfo.needsUpdate ? tagAvailable : tagLatest;
  const detail = t('dialog.updateCheck.availableDetail', {
    coreCurrent: coreInfo.current,
    coreRemote: remoteCore || unknownVersion,
    coreTag,
    shellCurrent: shellInfo.current,
    shellRemote: remoteShell || unknownVersion,
    shellTag
  });
  let buttons;
  if (coreInfo.needsUpdate && shellInfo.needsUpdate) {
    buttons = [t('dialog.updateCheck.updateAll'), t('dialog.updateCheck.updateCoreOnly'), t('dialog.common.cancel')];
  } else {
    buttons = [t('dialog.updateCheck.updateNow'), t('dialog.common.cancel')];
  }
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: t('dialog.updateCheck.availableTitle'),
    message: t('dialog.updateCheck.availableMessage'),
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1
  });
  if (response.response === 0) {
    return { updateCore: true, updateShell: true };
  }
  if (response.response === 1 && buttons.length === 3) {
    return { updateCore: true, updateShell: false };
  }
  return null;
}

async function performAutoUpdate(coreInfo, shellInfo, remoteCore, remoteShell, options = { updateCore: true, updateShell: true }) {
  try {
    if (coreInfo.needsUpdate && options.updateCore) {
      forceBundledRuntime = false;
      localRuntimeBrokenUntil = 0;
      clearLocalRuntimeWatchdog();
      await installHotUpdateCore(remoteCore);
      cleanupOldBrokenRuntimeDirs(2);
    }

    if (shellInfo.needsUpdate && options.updateShell) {
      const release = await checkRemoteReleaseAssets();
      if (!release) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: t('dialog.shellUpdate.unavailableTitle'),
          message: t('dialog.shellUpdate.unavailableMessage')
        });
        clearWindowProgress();
      } else {
        const tmpDir = os.tmpdir();
        const installerName = `${path.basename(release.installerUrl).split('?')[0] || 'DeepSeek-Harness-Desktop-Setup.exe'}`;
        const installerPath = path.join(tmpDir, installerName);
        setWindowProgress(t('dialog.progress.downloadShell', { percent: 0 }));
        await downloadWithProxies(release.installerUrl, installerPath, (percent) => {
          setWindowProgress(t('dialog.progress.downloadShell', { percent }));
        }, { proxies: downloadProxies(), timeoutMs: UPDATER.DOWNLOAD_TIMEOUT_MS });

        const integrity = verifyInstallerIntegrity(installerPath, release.sha256);
        if (!integrity.ok) {
          clearWindowProgress();
          dialog.showErrorBox(
            t('error.integrityCheckFailed'),
            t('error.integrityCheckFailedMessage', { reason: integrity.reason })
          );
          return;
        }

        if (isPortable()) {
          const folder = path.dirname(installerPath);
          shell.showItemInFolder(installerPath);
          clearWindowProgress();
          await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: t('dialog.shellUpdate.portableTitle'),
            message: t('dialog.shellUpdate.portableMessage'),
            detail: t('dialog.shellUpdate.portableDetail', { folder })
          });
        } else {
          const verifyDesc = integrity.verified
            ? t('dialog.shellUpdate.verifyPassed', { hash: integrity.actual.slice(0, 16) })
            : t('dialog.shellUpdate.verifyLocal', { hash: integrity.actual ? integrity.actual.slice(0, 16) : t('dialog.updateCheck.unknownVersion') });
          const confirmInstall = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            title: t('dialog.shellUpdate.confirmTitle'),
            message: t('dialog.shellUpdate.confirmMessage', { version: remoteShell }),
            detail: t('dialog.shellUpdate.confirmDetail', { verify: verifyDesc }),
            buttons: [t('dialog.shellUpdate.installNow'), t('dialog.shellUpdate.installLater')],
            defaultId: 0,
            cancelId: 1
          });
          if (confirmInstall.response !== 0) {
            clearWindowProgress();
            return;
          }
          setWindowProgress(t('dialog.progress.launchInstaller'));
          killProcessTree();
          try {
            if (typeof app.releaseSingleInstanceLock === 'function') {
              app.releaseSingleInstanceLock();
            }
          } catch (lockErr) {
            console.warn(`[shell-update] 释放单实例锁失败: ${lockErr.message}`);
          }
          try {
            const installer = spawn(installerPath, [], { detached: true, stdio: 'ignore' });
            installer.unref();
          } catch (err) {
            dialog.showErrorBox(t('error.nsisInstallFailed'), String(err.message || err));
            clearWindowProgress();
            return;
          }
          clearWindowProgress();
          isQuitting = true;
          app.exit(0);
          return;
        }
      }
    }

    if (coreInfo.needsUpdate && options.updateCore) {
      const ready = await restartWithCurrentConfig();
      clearWindowProgress();
      if (ready) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: t('dialog.hotUpdate.successTitle'),
          message: t('dialog.hotUpdate.successMessage', { version: remoteCore }),
          detail: t('dialog.hotUpdate.successDetail')
        });
      } else {
        await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: t('dialog.hotUpdate.notReadyTitle'),
          message: t('dialog.hotUpdate.notReadyMessage', { version: remoteCore }),
          detail: t('dialog.hotUpdate.notReadyDetail')
        });
      }
    }
  } catch (err) {
    clearWindowProgress();
    dialog.showErrorBox(t('error.autoUpdateFailed'), String(err.message || err));
  }
}

async function runUpdateCheck(silent = false) {
  if (UPDATER.isChecking) return;
  UPDATER.isChecking = true;
  try {
    const currentCore = getCurrentDshVersion();
    const currentShell = getShellVersion();
    const [remoteCore, remoteShell] = await Promise.all([
      checkRemoteCoreVersion(),
      checkRemoteShellVersion()
    ]);
    const coreInfo = {
      current: currentCore.version,
      source: currentCore.source === 'hot-update' ? '热更新内核' : '内置出厂内核',
      needsUpdate: !!(remoteCore && isNewer(remoteCore, currentCore.version))
    };
    const shellInfo = {
      current: currentShell,
      needsUpdate: !!(remoteShell && isNewer(remoteShell, currentShell))
    };
    const plan = decideUpdatePlan({
      core: { currentVersion: currentCore.version, remoteVersion: remoteCore },
      shell: { currentVersion: currentShell, remoteVersion: remoteShell }
    });
    if (plan.hasUpdate) {
      const options = await showUpdateCheckResult(true, coreInfo, shellInfo, remoteCore, remoteShell);
      if (options) {
        await performAutoUpdate(coreInfo, shellInfo, remoteCore, remoteShell, options);
      }
    } else if (!silent) {
      await showUpdateCheckResult(false, coreInfo, shellInfo, remoteCore, remoteShell);
    }
  } finally {
    UPDATER.isChecking = false;
  }
}


function getTrayIconPath() {
  const candidates = [
    path.join(__dirname, 'build', 'icon.png'),
    path.join(process.resourcesPath, 'icon.png'),
    path.join(process.resourcesPath, 'build', 'icon.png')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function updateTrayMenu() {
  if (!tray) return;
  try {
    const isAuto = getAutoStart(app);
    const menu = Menu.buildFromTemplate([
      {
        label: t('tray.showWindow'),
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: t('tray.checkUpdates'),
        click: () => runUpdateCheck(false)
      },
      {
        label: t('tray.autoStart'),
        type: 'checkbox',
        checked: isAuto,
        click: (item) => {
          const result = setAutoStart(app, item.checked);
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('dsh:auto-start-changed', result);
          }
          buildNativeAppMenu();
          updateTrayMenu();
        }
      },
      { type: 'separator' },
      {
        label: t('tray.quit'),
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(menu);
  } catch (err) {
    console.warn(`[tray] 更新托盘菜单异常: ${err.message}`);
  }
}

function createTray() {
  if (tray) return;
  const iconPath = getTrayIconPath();
  if (!iconPath) {
    console.warn('[tray] No tray icon found, skipping tray creation');
    return;
  }
  try {
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      console.warn('[tray] Tray icon is empty, skipping tray creation');
      return;
    }
    tray = new Tray(icon);
    updateTrayMenu();
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn(`[tray] Failed to create tray: ${err.message}`);
  }
}

function buildNativeAppMenu() {
  const template = [
    {
      label: t('menu.studio.title'),
      submenu: [
        {
          label: t('menu.studio.newWorktree'),
          click: async () => {
            const res = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
              title: t('dialog.openWorktreeDir.title')
            });
            if (!res.canceled && res.filePaths[0]) {
              const session = createIsolatedGitWorktree(res.filePaths[0]);
              switchWorkspace(session.worktreePath, session);
              if (mainWindow) {
                mainWindow.setTitle(`DeepSeek Harness Studio — ${targetWorkspaceDir}`);
              }
              await restartWithCurrentConfig();
            }
          }
        },
        {
          label: t('menu.studio.pasteClipboard'),
          accelerator: 'Alt+Shift+V',
          click: () => {
            feedClipboardIntoEditor();
          }
        },
        { type: 'separator' },
        {
          label: t('menu.studio.alwaysOnTop'),
          type: 'checkbox',
          checked: mainWindow ? mainWindow.isAlwaysOnTop() : false,
          click: (item) => {
            if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
          }
        },
        {
          label: t('menu.studio.autoStart'),
          type: 'checkbox',
          checked: getAutoStart(app),
          click: (item) => {
            const result = setAutoStart(app, item.checked);
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.send('dsh:auto-start-changed', result);
            }
            buildNativeAppMenu();
            updateTrayMenu();
          }
        },
        { type: 'separator' },
        {
          label: t('menu.app.quit'),
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: t('menu.engine.title'),
      submenu: [
        {
          label: (() => {
            const core = getCurrentDshVersion();
            const sourceLabel = core.source === 'hot-update'
              ? t('menu.engine.sourceHotUpdate')
              : t('menu.engine.sourceFactory');
            return t('menu.engine.status', { shell: getShellVersion(), core: core.version, source: sourceLabel });
          })(),
          enabled: false
        },
        { type: 'separator' },
        {
          label: t('menu.engine.selfRepair'),
          click: async () => {
            const report = runSelfRepair({
              dshHome: DSH_HOME,
              runtimeDir: getRuntimeDir(),
              killOrphanProcess: () => killProcessTree()
            });
            const ready = await restartWithCurrentConfig();
            if (mainWindow) {
              const actionList = report.actions && report.actions.length
                ? report.actions.map((a) => `• ${a}`).join('\n')
                : t('dialog.selfRepair.noActions');
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: t('dialog.selfRepair.title'),
                message: ready ? t('dialog.selfRepair.readyMessage') : t('dialog.selfRepair.pendingMessage'),
                detail: t('dialog.selfRepair.detail', { actions: actionList, port: currentPort, engine: currentEngine })
              });
            }
          }
        },
        {
          label: t('menu.engine.checkUpdates'),
          click: () => {
            runUpdateCheck(false);
          }
        },
        {
          label: t('menu.engine.revertFactory'),
          click: () => {
            revertToFactoryRuntime();
          }
        },
        { type: 'separator' },
        {
          label: t('menu.engine.winNative'),
          type: 'radio',
          checked: currentEngine === 'win-native',
          click: async () => {
            currentEngine = 'win-native';
            await restartWithCurrentConfig();
          }
        },
        {
          label: t('menu.engine.wsl2'),
          type: 'radio',
          checked: currentEngine === 'wsl2',
          click: async () => {
            if (!isWindowsPlatform()) {
              dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: t('dialog.common.dsStudioTitle'),
                message: t('dialog.wsl2Unavailable.message')
              });
              currentEngine = 'win-native';
              return;
            }
            currentEngine = 'wsl2';
            await restartWithCurrentConfig();
          }
        },
        { type: 'separator' },
        {
          label: t('menu.engine.safeMode'),
          type: 'checkbox',
          checked: isSafeMode,
          click: async (item) => {
            isSafeMode = item.checked;
            await restartWithCurrentConfig();
          }
        },
        {
          label: t('menu.engine.restorePresets'),
          click: async () => {
            hydratePresetPluginsIfNeeded(true);
            await restartWithCurrentConfig();
            if (mainWindow) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: t('dialog.presetReset.title'),
                message: t('dialog.presetReset.message')
              });
            }
          }
        }
      ]
    },
    {
      label: t('menu.system.title'),
      submenu: [
        {
          label: t('menu.system.registerContextMenu'),
          click: () => {
            const result = registerWindowsContextMenu();
            if (result.total === 0) {
              dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: t('dialog.contextMenu.title'),
                message: t('dialog.contextMenu.registerUnavailable')
              });
              return;
            }
            const ok = result.failed === 0;
            dialog.showMessageBox(mainWindow, {
              type: ok ? 'info' : 'warning',
              title: t('dialog.contextMenu.title'),
              message: ok
                ? t('dialog.contextMenu.registerSuccess', { ok: result.ok, total: result.total })
                : t('dialog.contextMenu.registerPartial', { ok: result.ok, total: result.total, failed: result.failed })
            });
          }
        },
        {
          label: t('menu.system.unregisterContextMenu'),
          click: () => {
            const result = unregisterWindowsContextMenu();
            if (result.total === 0) {
              dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: t('dialog.contextMenu.title'),
                message: t('dialog.contextMenu.unregisterUnavailable')
              });
              return;
            }
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: t('dialog.contextMenu.title'),
              message: t('dialog.contextMenu.unregisterResult', { total: result.total, ok: result.ok, failed: result.failed })
            });
          }
        },
        { type: 'separator' },
        {
          label: t('menu.system.openDataDir'),
          click: () => shell.openPath(DSH_HOME)
        },
        {
          label: t('menu.system.openDevTools'),
          accelerator: 'F12',
          click: () => {
            if (mainWindow) mainWindow.webContents.toggleDevTools();
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function isWindowsPlatform() {
  return process.platform === 'win32';
}

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
  mainWindow.loadFile(path.join(__dirname, 'splash.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isBackendHttp(url, currentPort)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isBackendHttp(url, currentPort) || url.startsWith('file://')) return;
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
    if (!tray) {
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

function saveClipboardImage(image) {
  const captureDir = PORTABLE_DATA_ROOT
    ? path.join(PORTABLE_DATA_ROOT, 'temp-captures')
    : path.join(os.tmpdir(), 'dsh-studio-captures');
  const target = path.join(
    captureDir,
    `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );
  try {
    fs.mkdirSync(captureDir, { recursive: true });
    fs.writeFileSync(target, image.toPNG());
    console.warn(`[clipboard] 截图已落盘: ${target}`);
    return target;
  } catch (err) {
    console.warn(`[clipboard] 截图落盘失败: ${err.message}`);
    return null;
  }
}

function convertToWslMountPath(windowsPath) {
  if (typeof windowsPath !== 'string' || !windowsPath.trim()) return windowsPath;
  return toWslPath(windowsPath.trim());
}

function feedClipboardIntoEditor() {
  if (!mainWindow || !mainWindow.webContents) return;
  if (currentEngine === 'wsl2' && isWindowsPlatform()) {
    try {
      const image = clipboard.readImage();
      if (image && !image.isEmpty()) {
        const imagePath = saveClipboardImage(image);
        if (imagePath) {
          mainWindow.webContents.send('dsh:inject-clipboard-text', convertToWslMountPath(imagePath));
          return;
        }
      }
    } catch (err) {
      console.warn(`[clipboard] 读取剪贴板截图失败: ${err.message}`);
    }
  }
  let text = '';
  try {
    text = clipboard.readText() || '';
  } catch (err) {
    console.warn(`[clipboard] 读取剪贴板文本失败: ${err.message}`);
  }
  if (text) {
    mainWindow.webContents.send('dsh:inject-clipboard-text', text);
  }
}

ipcMain.on('dsh:native-notify', (event, payload) => {
  try {
    assertTrustedSender(event);
    assertIpcPayload('dsh:native-notify', payload);
  } catch (err) {
    console.warn(`[ipc] native-notify rejected: ${err.message}`);
    return;
  }
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
});

ipcMain.handle('dsh:get-runtime-info', (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:get-runtime-info', undefined);
  return {
    version: getShellVersion(),
    coreVersion: getCurrentDshVersion().version,
    port: currentPort,
    engine: currentEngine,
    safeMode: isSafeMode,
    home: DSH_HOME,
    workspaceDir: targetWorkspaceDir
  };
});

ipcMain.handle('dsh:get-backend-status', (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:get-backend-status', undefined);
  return {
    ready: Boolean(isBackendReadyState && dshProcess),
    url: authenticatedBackendUrl || `http://127.0.0.1:${currentPort}`,
    port: currentPort,
    engine: currentEngine,
    workspaceDir: targetWorkspaceDir
  };
});

ipcMain.handle('dsh:set-always-on-top', (event, enable) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:set-always-on-top', enable);
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(Boolean(enable));
  }
  return Boolean(enable);
});

ipcMain.handle('dsh:get-plugin-inventory', (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:get-plugin-inventory', undefined);
  const names = readFactoryPresetPluginNames();
  return { plugins: names };
});

ipcMain.handle('dsh:rehydrate-plugins', (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:rehydrate-plugins', undefined);
  hydratePresetPluginsIfNeeded();
  return { ok: true };
});

ipcMain.handle('dsh:create-worktree-dialog', async (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:create-worktree-dialog', undefined);
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: t('dialog.openWorktreeDir.title')
  });
  if (!res.canceled && res.filePaths[0]) {
    const session = createIsolatedGitWorktree(res.filePaths[0]);
    if (session.created) {
      switchWorkspace(session.worktreePath, session);
      await restartWithCurrentConfig();
    }
  }
  return { ok: true };
});

ipcMain.handle('dsh:switch-engine', async (event, mode) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:switch-engine', mode);
  if (mode !== 'win-native' && mode !== 'wsl2') {
    throw new Error(`Unsupported engine mode: ${mode}`);
  }
  if (mode === 'wsl2' && process.platform !== 'win32') {
    throw new Error('wsl2 engine is only available on Windows hosts');
  }
  currentEngine = mode;
  await restartWithCurrentConfig();
  return { engine: currentEngine };
});

ipcMain.handle('dsh:restart-safe-mode', async (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:restart-safe-mode', undefined);
  isSafeMode = !isSafeMode;
  await restartWithCurrentConfig();
  return { safeMode: isSafeMode };
});

ipcMain.handle('dsh:register-context-menu', (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:register-context-menu', undefined);
  const result = registerWindowsContextMenu();
  return result.total > 0 && result.failed === 0;
});

ipcMain.handle('dsh:unregister-context-menu', (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:unregister-context-menu', undefined);
  const result = unregisterWindowsContextMenu();
  return result.total > 0 && result.failed === 0;
});

ipcMain.on('dsh:request-clipboard-paste', (event) => {
  try {
    assertTrustedSender(event);
    assertIpcPayload('dsh:request-clipboard-paste', undefined);
  } catch (err) {
    console.warn(`[ipc] clipboard-paste rejected: ${err.message}`);
    return;
  }
  feedClipboardIntoEditor();
});

ipcMain.handle('dsh:get-auto-start', (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:get-auto-start', undefined);
  return getAutoStart(app);
});

ipcMain.handle('dsh:set-auto-start', (event, enable) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:set-auto-start', enable);
  const result = setAutoStart(app, Boolean(enable));
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('dsh:auto-start-changed', result);
  }
  buildNativeAppMenu();
  updateTrayMenu();
  return result;
});

ipcMain.handle('dsh:convert-to-wsl-path', (event, windowsPath) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:convert-to-wsl-path', windowsPath);
  return convertToWslMountPath(windowsPath);
});

ipcMain.handle('dsh:get-workspace-status', (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:get-workspace-status', undefined);
  return {
    isWorktree: targetWorkspaceIsWorktree,
    worktreePath: activeWorktreeSession.worktreePath,
    worktreeBranch: activeWorktreeSession.branchName,
    engine: currentEngine
  };
});

ipcMain.handle('dsh:run-self-repair', async (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:run-self-repair', undefined);
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
});

ipcMain.handle('dsh:check-update', (event) => {
  assertTrustedSender(event);
  assertIpcPayload('dsh:check-update', undefined);
  runUpdateCheck(false);
  return { ok: true };
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
