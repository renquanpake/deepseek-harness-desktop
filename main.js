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
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');
const stream = require('stream');
const { promisify } = require('util');
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
const {
  semverCompare,
  isNewer,
  decideUpdatePlan,
  formatUpdateDescription,
  buildProxyedUrls,
  pickInstallerUrl,
  downloadWithProxies,
  httpGetJson,
  checkRemoteCoreVersion: checkCoreFromUrls,
  checkRemoteShellVersion: checkShellFromUrls,
  checkRemoteReleaseAssets: checkReleaseFromUrls
} = require('./lib/updater');

const streamPipeline = promisify(stream.pipeline);

let mainWindow = null;
let tray = null;
let dshProcess = null;
let crashCount = 0;
let isQuitting = false;
let currentPort = 3080;
let currentEngine = 'win-native';
let isSafeMode = false;
const useChinaMirror = true;
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
let worktreeCloseDialogShowing = false;
const activeWorktreeSession = { worktreePath: null, repoPath: null, branchName: null };

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
  if (nodeExe) dirs.push(path.dirname(nodeExe));
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
  return null;
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
  const pkgPath = path.join(getRuntimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { version: pkg.version || 'unknown', source: isLocalRuntimeUsable() ? 'hot-update' : 'factory' };
  } catch {
    return { version: 'unknown', source: isLocalRuntimeUsable() ? 'hot-update' : 'factory' };
  }
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event, currentPort, mainWindow)) {
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
  }
}

// cleanStaleLocks is imported from ./lib/lock-cleaner

function hydratePresetPluginsIfNeeded() {
  const runtimeDir = getRuntimeDir();
  const presetProfile = path.join(runtimeDir, 'default-profile');
  const res = hydratePresetPlugins(presetProfile, DSH_HOME);
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
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
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

function readProcessCommandLine(pid) {
  const attempts = [
    `wmic process where "ProcessId=${pid}" get CommandLine /FORMAT:LIST`,
    `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine"`
  ];
  for (const command of attempts) {
    try {
      const output = execSync(command, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: WORKTREE_PROCESS_SCAN_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024
      });
      if (output && String(output).trim()) return String(output);
    } catch {
      // wmic 在新版系统上可能已移除，继续尝试下一方式
    }
  }
  return '';
}

function findWindowsProcessesWithWorkingDir(worktreePath) {
  const pids = new Set();
  if (!isWindowsPlatform() || !worktreePath) return [];
  try {
    const output = execSync(
      `tasklist /V /FI "IMAGENAME eq node.exe" /FO CSV /NH`,
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
      const commandLine = readProcessCommandLine(pid);
      if (!commandLine) continue;
      if (commandLine.replace(/\s/g, '').toLowerCase().includes(normalizedPath)) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
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
    execSync(`git worktree remove "${worktreePath}" --force`, {
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
      execSync(`git branch -D "${branchName}"`, {
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
      title: 'Worktree 沙箱会话关闭',
      message: '当前窗口使用了独立的 Git Worktree 沙箱，请选择处理方式：',
      detail: `Worktree 路径：${activeWorktreeSession.worktreePath || targetWorkspaceDir}\n分支：${activeWorktreeSession.branchName || '（未知）'}`,
      buttons: ['保留目录并关闭', '销毁 Worktree 并清理分支（推荐）', '取消'],
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
  if (!dshProcess || !dshProcess.pid) return;
  const proc = dshProcess;
  proc.killedByUs = true;
  const pid = proc.pid;
  dshProcess = null;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
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
      title: '已自动回滚内核',
      message: '检测到新版官方内核存在兼容性异常，系统已自动为您无感回滚至出厂稳定版。',
      detail: `触发原因：${reason}\n当前已恢复由出厂内置 runtime 提供服务，工作台配置不受影响。`,
      buttons: ['我知道了']
    });
    return;
  }
  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: '回滚后仍未就绪',
    message: '已回滚至出厂稳定版，但后端服务仍未就绪。',
    detail: `触发原因：${reason}\n可在「引擎与救援」菜单切换引擎或启用故障隔离安全模式。`,
    buttons: ['我知道了']
  });
}

function startDshBackend(resetCrash = true) {
  killProcessTree();
  cleanStaleLocks(DSH_HOME);
  hydratePresetPluginsIfNeeded();
  if (resetCrash) {
    crashCount = 0;
  }
  const runtimeDir = getRuntimeDir();
  const args = ['web', '--port', String(currentPort)];
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
    const wslCmd = `cd "${cleanWslWorkspace}" && npx --yes @deepseek-ai/dsh web --port ${currentPort} ${safeFlag}`;
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
      env,
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
      dshProcess = spawn('npx', ['--yes', '@deepseek-ai/dsh', ...args], {
        ...commonSpawnOpts,
        shell: isWindows
      });
      useLocalRuntime = false;
    }
  }
  const proc = dshProcess;
  armLocalRuntimeWatchdog(proc);

  if (proc.stdout) {
    proc.stdout.on('data', (chunk) => {
      const line = String(chunk);
      console.log(`[dsh] ${line}`);
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
      dialog.showErrorBox('dsh 后端启动失败', String(err.message || err));
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
          title: 'DSH Studio',
          message: '后端连续崩溃，已停止自动重启。'
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
        res.resume();
        finish(true);
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

async function restartWithCurrentConfig() {
  currentPort = await findAvailablePort(currentPort || 3080);
  startDshBackend();
  const ready = await waitForBackendReady();
  if (mainWindow && mainWindow.webContents) {
    if (ready) {
      mainWindow.webContents.send('dsh:backend-ready', `http://127.0.0.1:${currentPort}`, currentPort);
    }
    buildNativeAppMenu();
    updateTrayMenu();
  }
  return ready;
}

const CONTEXT_MENU_COMMAND_KEY_BG = 'HKCU\\Software\\Classes\\Directory\\Background\\shell';
const CONTEXT_MENU_COMMAND_KEY_DIR = 'HKCU\\Software\\Classes\\Directory\\shell';

function contextMenuRegisterCommands(exePath) {
  return [
    `reg add "${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen" /ve /d "Open with DeepSeek Harness Studio" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen" /v "Icon" /d "\\"${exePath}\\"" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen\\command" /ve /d "\\"${exePath}\\" --open-dir \\"%V\\"" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen" /ve /d "Open with DeepSeek Harness Studio" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen" /v "Icon" /d "\\"${exePath}\\"" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen\\command" /ve /d "\\"${exePath}\\" --open-dir \\"%1\\"" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree" /ve /d "Open in New Git Worktree (DSH Studio)" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree" /v "Icon" /d "\\"${exePath}\\"" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree\\command" /ve /d "\\"${exePath}\\" --worktree-dir \\"%V\\"" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree" /ve /d "Open in New Git Worktree (DSH Studio)" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree" /v "Icon" /d "\\"${exePath}\\"" /f`,
    `reg add "${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree\\command" /ve /d "\\"${exePath}\\" --worktree-dir \\"%1\\"" /f`
  ];
}

function contextMenuUnregisterCommands() {
  return [
    `reg delete "${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen" /f`,
    `reg delete "${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen" /f`,
    `reg delete "${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree" /f`,
    `reg delete "${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree" /f`
  ];
}

const regSync = (cmd) => execSync(cmd, { windowsHide: true });
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
  CORE_REGISTRY_URLS: [
    'https://registry.npmmirror.com/@deepseek-ai/dsh/latest',
    'https://registry.npmjs.org/@deepseek-ai/dsh/latest'
  ],
  SHELL_MANIFEST_URLS: [
    'https://fastly.jsdelivr.net/gh/renquanpake/deepseek-harness-desktop@main/package.json',
    'https://ghfast.top/https://raw.githubusercontent.com/renquanpake/deepseek-harness-desktop/main/package.json',
    'https://raw.githubusercontent.com/renquanpake/deepseek-harness-desktop/main/package.json'
  ],
  GITHUB_RELEASE_URLS: [
    'https://api.github.com/repos/renquanpake/deepseek-harness-desktop/releases/latest',
    'https://ghfast.top/https://api.github.com/repos/renquanpake/deepseek-harness-desktop/releases/latest'
  ],
  GITHUB_DOWNLOAD_PROXIES: [
    'https://ghfast.top/',
    'https://mirror.ghproxy.com/'
  ],
  REQUEST_TIMEOUT_MS: 8000,
  DOWNLOAD_TIMEOUT_MS: 60000,
  REGISTRY: 'https://registry.npmmirror.com',
  isChecking: false
};

async function checkRemoteCoreVersion() {
  return checkCoreFromUrls(UPDATER.CORE_REGISTRY_URLS);
}

async function checkRemoteShellVersion() {
  return checkShellFromUrls(UPDATER.SHELL_MANIFEST_URLS, UPDATER.GITHUB_RELEASE_URLS);
}

async function checkRemoteReleaseAssets() {
  return checkReleaseFromUrls(UPDATER.GITHUB_RELEASE_URLS);
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
    throw new Error('内置 node.exe 或 pnpm.cjs 缺失，无法执行内核热更新');
  }
  fs.mkdirSync(LOCAL_RUNTIME_DIR, { recursive: true });
  const pkgJsonPath = path.join(LOCAL_RUNTIME_DIR, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name: 'dsh-local-hot-update', version: '0.0.0', private: true }, null, 2)
    );
  }
  setWindowProgress('正在通过国内镜像热更新 DSH 内核...');
  const corePackage = targetVersion
    ? `@deepseek-ai/dsh@${targetVersion}`
    : '@deepseek-ai/dsh@latest';
  const coreInstalled = await runPnpmAdd(nodeExe, pnpmCjs, [corePackage]);
  if (!coreInstalled) {
    throw new Error('DSH 内核热更新失败，请检查网络或稍后重试');
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
      setWindowProgress(`正在同步出厂预置插件（${presetPluginNames.length} 项）...`);
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
        title: '回退失败',
        message: `删除 local-runtime 目录失败: ${err.message}`
      });
      return;
    }
  }
  cleanupOldBrokenRuntimeDirs(0);
  await restartWithCurrentConfig();
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '已回退至出厂内置内核',
      message: '本地热更新内核已清理，当前使用安装包自带的出厂 dsh-runtime。'
    });
  }
}

async function showUpdateCheckResult(hasUpdate, coreInfo, shellInfo, remoteCore, remoteShell) {
  if (!hasUpdate) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '检查更新',
      message: '当前已是最新状态！',
      detail: `- DSH 官方内核版本：v${coreInfo.current} (最新)\n- 桌面外壳版本：v${shellInfo.current} (最新)`,
      buttons: ['关闭']
    });
    return null;
  }
  const coreTag = coreInfo.needsUpdate ? '[可更新]' : '[已最新]';
  const shellTag = shellInfo.needsUpdate ? '[可更新]' : '[已最新]';
  const detail = `检测到可用更新：\n- DSH 官方内核：v${coreInfo.current} -> v${remoteCore || '未知'} ${coreTag}\n- 桌面宿主外壳：v${shellInfo.current} -> v${remoteShell || '未知'} ${shellTag}\n\n是否立即自动下载并更新？`;
  let buttons;
  if (coreInfo.needsUpdate && shellInfo.needsUpdate) {
    buttons = ['立即一键更新', '仅更新 DSH 内核', '取消'];
  } else {
    buttons = ['立即更新', '取消'];
  }
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: '检测到可用更新',
    message: '发现可升级项，是否立即执行自动更新？',
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
          title: '外壳更新',
          message: '无法获取最新外壳安装包下载地址，请稍后重试或手动下载安装包。'
        });
        clearWindowProgress();
      } else {
        const tmpDir = os.tmpdir();
        const installerName = `${path.basename(release.installerUrl).split('?')[0] || 'DeepSeek-Harness-Desktop-Setup.exe'}`;
        const installerPath = path.join(tmpDir, installerName);
        setWindowProgress('正在下载客户端外壳更新 (0%)...');
        await downloadWithProxies(release.installerUrl, installerPath, (percent) => {
          setWindowProgress(`正在下载客户端外壳更新 (${percent}%)...`);
        }, { proxies: UPDATER.GITHUB_DOWNLOAD_PROXIES, timeoutMs: UPDATER.DOWNLOAD_TIMEOUT_MS });

        if (isPortable()) {
          const folder = path.dirname(installerPath);
          shell.showItemInFolder(installerPath);
          clearWindowProgress();
          await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '便携版更新',
            message: '便携版更新已下载完成',
            detail: `解压或覆盖 ${folder} 中的旧安装文件即可。用户数据保存在 portable-data 中，不会丢失。`
          });
        } else {
          setWindowProgress('正在启动 NSIS 静默覆盖安装...');
          killProcessTree();
          try {
            if (typeof app.releaseSingleInstanceLock === 'function') {
              app.releaseSingleInstanceLock();
            }
          } catch (lockErr) {
            console.warn(`[shell-update] 释放单实例锁失败: ${lockErr.message}`);
          }
          try {
            const installer = spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore' });
            installer.unref();
          } catch (err) {
            dialog.showErrorBox('NSIS 安装启动失败', String(err.message || err));
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
          title: '热更新成功',
          message: `DSH 内核已热更新到 ${remoteCore}`,
          detail: '后端已自动重启。若新版出现异常，可在「引擎与救援」→「⏪ 回退至出厂内置内核」一键回滚。'
        });
      } else {
        await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '热更新完成但后端未就绪',
          message: `DSH 内核已热更新到 ${remoteCore}，但后端未能就绪。`,
          detail: '请在「引擎与救援」菜单检查引擎状态，或点击「⏪ 回退至出厂内置内核」回滚。'
        });
      }
    }
  } catch (err) {
    clearWindowProgress();
    dialog.showErrorBox('自动更新失败', String(err.message || err));
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
    path.join(__dirname, 'electron', 'assets', 'icon.png'),
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
        label: '显示主窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: '检查更新',
        click: () => runUpdateCheck(false)
      },
      {
        label: '开机自动启动',
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
        label: '退出 DSH Studio',
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
      label: '工作台 (Studio)',
      submenu: [
        {
          label: '新建独立工作区分支 (Git Worktree)...',
          click: async () => {
            const res = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
              title: '选择 Git 仓库目录以自动创建隔离 Worktree'
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
          label: '粘贴剪贴板截图/文本至输入框 (Alt+Shift+V)',
          accelerator: 'Alt+Shift+V',
          click: () => {
            feedClipboardIntoEditor();
          }
        },
        { type: 'separator' },
        {
          label: '窗口始终置顶 (悬浮伴侣模式)',
          type: 'checkbox',
          checked: mainWindow ? mainWindow.isAlwaysOnTop() : false,
          click: (item) => {
            if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
          }
        },
        {
          label: '开机自动启动 (Windows 登录自启)',
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
          label: '退出程序',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: '引擎与更新 (Engine & Updates)',
      submenu: [
        {
          label: (() => {
            const core = getCurrentDshVersion();
            const sourceLabel = core.source === 'hot-update' ? '热更新内核' : '内置出厂内核';
            return `外壳 v${getShellVersion()}  ·  DSH 内核 v${core.version} (${sourceLabel})`;
          })(),
          enabled: false
        },
        { type: 'separator' },
        {
          label: '🔄 检查更新 (自动联检内核与外壳)',
          click: () => {
            runUpdateCheck(false);
          }
        },
        {
          label: '⏪ 回退至出厂内置内核',
          click: () => {
            revertToFactoryRuntime();
          }
        },
        { type: 'separator' },
        {
          label: '运行引擎：Windows 原生模式 (推荐，速度最快)',
          type: 'radio',
          checked: currentEngine === 'win-native',
          click: async () => {
            currentEngine = 'win-native';
            await restartWithCurrentConfig();
          }
        },
        {
          label: '运行引擎：WSL2 兼容模式 (适用于 Linux 依赖工具)',
          type: 'radio',
          checked: currentEngine === 'wsl2',
          click: async () => {
            if (!isWindowsPlatform()) {
              dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: 'DSH Studio',
                message: 'WSL2 引擎仅在 Windows 主机上可用。'
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
          label: '故障排查安全模式 (临时禁用第三方插件)',
          type: 'checkbox',
          checked: isSafeMode,
          click: async (item) => {
            isSafeMode = item.checked;
            await restartWithCurrentConfig();
          }
        },
        {
          label: '恢复出厂预置插件 (重置界面增强组件)',
          click: async () => {
            const markerFile = path.join(DSH_HOME, '.codex-studio-hydrated');
            if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
            hydratePresetPluginsIfNeeded();
            await restartWithCurrentConfig();
          }
        }
      ]
    },
    {
      label: 'Windows 系统集成',
      submenu: [
        {
          label: '添加 Windows 文件夹右键快捷启动',
          click: () => {
            const result = registerWindowsContextMenu();
            if (result.total === 0) {
              dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: '右键菜单集成',
                message: '右键菜单注册仅在 Windows 主机上可用。'
              });
              return;
            }
            const ok = result.failed === 0;
            dialog.showMessageBox(mainWindow, {
              type: ok ? 'info' : 'warning',
              title: '右键菜单集成',
              message: ok
                ? `注册成功（${result.ok}/${result.total}）！现在可在任意文件夹右键选择「Open in New Git Worktree (DSH Studio)」。`
                : `部分成功（${result.ok}/${result.total}），${result.failed} 项写入失败，请检查系统权限。`
            });
          }
        },
        {
          label: '移除 Windows 文件夹右键快捷项',
          click: () => {
            const result = unregisterWindowsContextMenu();
            if (result.total === 0) {
              dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: '右键菜单集成',
                message: '右键菜单移除仅在 Windows 主机上可用。'
              });
              return;
            }
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '右键菜单集成',
              message: `已尝试移除 ${result.total} 组资源管理器右键菜单项（成功 ${result.ok}，跳过 ${result.failed}）。`
            });
          }
        },
        { type: 'separator' },
        {
          label: '打开 DSH 数据与插件目录',
          click: () => shell.openPath(DSH_HOME)
        },
        {
          label: '打开开发者调试工具 (DevTools)',
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
      webviewTag: true
    }
  });
  buildNativeAppMenu();
  mainWindow.loadFile(path.join(__dirname, 'shell', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isBackendHttp(url, currentPort)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isBackendHttp(url, currentPort)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    backendLoadFailures += 1;
    console.warn(
      `[dsh-watchdog] 后端页面加载失败 code=${errorCode} ${errorDescription}（连续 ${backendLoadFailures} 次）`
    );
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
  return {
    port: currentPort,
    engine: currentEngine,
    safeMode: isSafeMode,
    home: DSH_HOME,
    workspaceDir: targetWorkspaceDir
  };
});

ipcMain.handle('dsh:get-backend-status', (event) => {
  assertTrustedSender(event);
  return {
    ready: isBackendHttp(`http://127.0.0.1:${currentPort}`, currentPort),
    url: `http://127.0.0.1:${currentPort}`,
    port: currentPort,
    engine: currentEngine,
    workspaceDir: targetWorkspaceDir
  };
});

ipcMain.handle('dsh:set-always-on-top', (event, enable) => {
  assertTrustedSender(event);
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(Boolean(enable));
  }
  return Boolean(enable);
});

ipcMain.handle('dsh:get-plugin-inventory', (event) => {
  assertTrustedSender(event);
  const names = readFactoryPresetPluginNames();
  return { plugins: names };
});

ipcMain.handle('dsh:rehydrate-plugins', (event) => {
  assertTrustedSender(event);
  hydratePresetPluginsIfNeeded();
  return { ok: true };
});

ipcMain.handle('dsh:create-worktree-dialog', async (event) => {
  assertTrustedSender(event);
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择 Git 仓库目录以自动创建隔离 Worktree'
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
  isSafeMode = !isSafeMode;
  await restartWithCurrentConfig();
  return { safeMode: isSafeMode };
});

ipcMain.handle('dsh:register-context-menu', (event) => {
  assertTrustedSender(event);
  const result = registerWindowsContextMenu();
  return result.total > 0 && result.failed === 0;
});

ipcMain.handle('dsh:unregister-context-menu', (event) => {
  assertTrustedSender(event);
  const result = unregisterWindowsContextMenu();
  return result.total > 0 && result.failed === 0;
});

ipcMain.on('dsh:request-clipboard-paste', (event) => {
  try {
    assertTrustedSender(event);
  } catch (err) {
    console.warn(`[ipc] clipboard-paste rejected: ${err.message}`);
    return;
  }
  feedClipboardIntoEditor();
});

ipcMain.handle('dsh:get-auto-start', (event) => {
  assertTrustedSender(event);
  return getAutoStart(app);
});

ipcMain.handle('dsh:set-auto-start', (event, enable) => {
  assertTrustedSender(event);
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
  return convertToWslMountPath(windowsPath);
});

ipcMain.handle('dsh:get-workspace-status', (event) => {
  assertTrustedSender(event);
  return {
    isWorktree: targetWorkspaceIsWorktree,
    worktreePath: activeWorktreeSession.worktreePath,
    worktreeBranch: activeWorktreeSession.branchName,
    engine: currentEngine
  };
});

ipcMain.handle('dsh:run-self-repair', async (event) => {
  assertTrustedSender(event);
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
      title: 'DSH Studio',
      message: '后端未能就绪，当前显示空白页。可在「引擎与救援」菜单切换引擎或选择安全模式。'
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
  if (process.platform !== 'darwin' || !isWindowsPlatform()) {
    isQuitting = true;
    killProcessTree();
    app.quit();
  }
});
