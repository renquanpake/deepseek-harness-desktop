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
  net,
  session
} = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { toWslPath } = require('./lib/win-utils');
const { getAutoStart, setAutoStart } = require('./lib/auto-start');
const { findAvailablePort, prependPathDirs } = require('./lib/env-utils');
const { cleanStaleLocks } = require('./lib/lock-cleaner');
const { hydratePresetPlugins } = require('./lib/preset-hydrator');
const { runSelfRepair } = require('./lib/self-repair');
const { isBackendHttp, isTrustedSender, isFileInsideRoot } = require('./lib/trusted-url');
const { pickWorkspaceMode } = require('./lib/cli-workspace');
const { registerWindowsContextMenu, unregisterWindowsContextMenu } = require('./lib/context-menu');
const { createSingleFlight } = require('./lib/restart-guard');
const { registerIpcHandlers } = require('./src/ipc');
const { createBackend } = require('./src/backend');
const {
  APP_SCHEME,
  APP_HOST,
  isAppUrl,
  normalizeCspMode,
  registerAppSchemePrivileges
} = require('./lib/app-protocol');
const UPDATE_CHECK = require('./lib/update-check');
const { createI18n } = require('./lib/i18n');
const { createClipboardBridge } = require('./src/clipboard');
const { createWorktreeManager } = require('./src/worktree');
const { createRuntimeLayout } = require('./src/runtime-layout');
const { createSessionSecurity, hardenWebContents } = require('./src/security');
const { createPortableLayout } = require('./src/portable-paths');
const { createProtocolSetup } = require('./src/protocol-setup');
const { createWindowFactory } = require('./src/app-window');
const { createOperationLog } = require('./lib/operation-log');
const { createCrashReporter } = require('./lib/crash-reporter');
const { createQuitConfirmation } = require('./src/quit-confirmation');
const { getE2eBackendUrl } = require('./lib/e2e-backend');
const { createCliInstaller } = require('./lib/cli-install');
const { createWinUserPath } = require('./lib/win-user-path');
const { ensureKeybindingFile } = require('./lib/keybindings');
const { createCspViolationSink, isCspViolationMessage } = require('./lib/csp-report');
const { createWorkspaceStore } = require('./lib/workspace-store');
const { createShellUpdater } = require('./lib/shell-updater');
const { createUpdateJournal, markInterruptedRuntime } = require('./lib/update-journal');
const { createIpcActions } = require('./src/ipc-actions');
const { createRestartController } = require('./src/app-restart');
const { createShortcutController } = require('./src/shortcuts');
const { createPresetPlugins } = require('./src/preset-plugins');
const { createUpdateFlow } = require('./src/update-flow');
const { createUiMenus } = require('./src/ui-menus');
const { semverCompare } = require('./lib/updater');


let mainWindow = null;
let i18nInstance = null;
let isQuitting = false;
let currentPort = 3080;
let currentEngine = 'win-native';
let isSafeMode = false;
let targetWorkspaceDir = process.cwd();
let targetWorkspaceIsWorktree = false;

const DSH_PORTABLE_MARKER_DIR = 'portable-data';
const E2E_BACKEND_URL = getE2eBackendUrl();
const LOCAL_RUNTIME_WATCHDOG_MS = 15000;
const WATCHDOG_BACKEND_PROBE_MS = 5000;
const WATCHDOG_LOAD_FAILURE_THRESHOLD = 2;
const LOCAL_RUNTIME_BROKEN_WINDOW_MS = 6 * 60 * 60 * 1000;

let forceBundledRuntime = false;
let localRuntimeBrokenUntil = 0;
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
    } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
    i18nInstance = createI18n({ locale: locale || undefined });
  }
  return i18nInstance;
}

function t(key, params) {
  return getI18n().t(key, params);
}

const portableLayout = createPortableLayout({ app, markerDir: DSH_PORTABLE_MARKER_DIR });

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

const DSH_HOME = portableLayout.resolveDshHome();
const LOCAL_RUNTIME_DIR = path.join(DSH_HOME, 'local-runtime');
const USER_DATA_DIR = app.getPath('userData');
const KEYBINDINGS_PATH = path.join(USER_DATA_DIR, 'keybindings.json');
const loadKeybindings = () => ensureKeybindingFile(KEYBINDINGS_PATH);
const CRASH_REPORT_DIR = path.join(USER_DATA_DIR, 'crash-reports');
const operationLog = createOperationLog({ dir: path.join(USER_DATA_DIR, 'logs') });
const BACKEND_CSP_MODE = normalizeCspMode(process.env.DSH_BACKEND_CSP || 'report');
const shellUpdater = createShellUpdater({ appDir: __dirname });
const updateJournal = createUpdateJournal({ dir: path.join(DSH_HOME, 'update-journal') });
const workspaceStore = createWorkspaceStore({
  filePath: path.join(USER_DATA_DIR, 'recent-workspaces.json')
});
const cspViolationSink = createCspViolationSink({
  append: (message) => operationLog.append('csp-violation', { message })
});
const crashReporter = createCrashReporter({
  dir: CRASH_REPORT_DIR,
  appVersion: (() => {
    try {
      return app.getVersion();
    } catch {
      return 'unknown';
    }
  })()
});
if (!E2E_BACKEND_URL) crashReporter.installProcessHooks();
const quitConfirmation = createQuitConfirmation({
  dialog,
  t,
  getMainWindow: () => mainWindow,
  getBackendStatus: () => ({
    ready: Boolean(backend.isReady() && backend.isRunning()),
    engine: currentEngine,
    port: currentPort
  }),
  markerPath: path.join(USER_DATA_DIR, 'background-close-confirmed')
});

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
const CLI_BIN_DIR = portableLayout.isPortable()
  ? path.join(portableLayout.getDataRoot(), 'bin')
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DeepSeek Harness', 'bin');
const winUserPath = createWinUserPath();
const cliInstaller = createCliInstaller({
  binDir: CLI_BIN_DIR,
  getNodeExe: () => getBundledNodeExe(),
  getDshEntry: () => path.join(getBundledRuntimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs'),
  readUserPath: winUserPath.readUserPath,
  writeUserPath: winUserPath.writeUserPath
});


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
        try { fs.unlinkSync(markerPath); } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
        localRuntimeBrokenUntil = 0;
      } else {
        return false;
      }
    }
  } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
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
  Object.assign(env, portableLayout.buildEnvOverlay());
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
  const recentPath = targetWorkspaceIsWorktree
    ? activeWorktreeSession.repoPath || dir
    : dir;
  workspaceStore.touch(recentPath);
}

async function switchToWorkspace(dir) {
  try {
    const resolved = path.resolve(dir);
    if (resolved === path.resolve(targetWorkspaceDir)) {
      return { ok: true, changed: false, dir: resolved };
    }
    switchWorkspace(resolved, null);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`DeepSeek Harness Studio — ${targetWorkspaceDir}`);
    }
    operationLog.append('workspace-switch', { dir: resolved });
    const ready = await restartWithCurrentConfig();
    return { ok: true, changed: true, ready, dir: resolved };
  } catch (err) {
    operationLog.append('workspace-switch-failed', { dir: String(dir), error: err.message });
    return { ok: false, changed: false, error: err.message };
  }
}

async function openWorkspaceDialog() {
  try {
    const options = {
      title: t('dialog.workspace.title'),
      properties: ['openDirectory']
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { ok: true, changed: false };
    }
    return await switchToWorkspace(result.filePaths[0]);
  } catch (err) {
    return { ok: false, changed: false, error: err.message };
  }
}

function resolveWorkspaceRequest(argv) {
  const picked = pickWorkspaceMode(argv);
  if (!picked || !picked.mode || typeof picked.value !== 'string' || picked.value.length === 0) {
    return null;
  }
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
    // 先确认退出，再做不可逆的 worktree 回收，避免用户取消退出后目录已被删除
    const approved = await quitConfirmation.confirmQuit();
    if (!approved) return;
    if (response.response === 1) {
      killProcessTree();
      const removed = worktreeManager.removeActiveWorktree();
      if (!removed && activeWorktreeSession.worktreePath) {
        console.warn('[git-worktree] Worktree 回收未完全成功，请手动检查磁盘目录。');
      }
    }
    quitApproved = true;
    isQuitting = true;
    app.quit();
  } finally {
    worktreeCloseDialogShowing = false;
  }
}

const backend = createBackend({
  spawn,
  http,
  fs,
  path,
  dialog,
  t,
  toWslPath,
  cleanStaleLocks,
  getDshHome: () => DSH_HOME,
  getLocalRuntimeDir: () => LOCAL_RUNTIME_DIR,
  getPort: () => currentPort,
  setPort: (port) => {
    currentPort = port;
  },
  getEngine: () => currentEngine,
  isSafeMode: () => isSafeMode,
  isQuitting: () => isQuitting,
  getWorkspaceDir: () => targetWorkspaceDir,
  getMainWindow: () => mainWindow,
  getRuntimeDir,
  getBundledNodeExe,
  buildBackendEnv,
  currentRegistryUrl,
  cleanupOldBrokenRuntimeDirs: (keep) => cleanupOldBrokenRuntimeDirs(keep),
  getLocalDshVersion,
  hydratePresetPlugins: () => hydratePresetPluginsIfNeeded(),
  setForceBundledRuntime: (value) => {
    forceBundledRuntime = value;
  },
  setLocalRuntimeBrokenUntil: (timestamp) => {
    localRuntimeBrokenUntil = timestamp;
  },
  sendRuntimeLog: (line) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('dsh:runtime-log', line);
    }
  },
  watchdogMs: LOCAL_RUNTIME_WATCHDOG_MS,
  probeMs: WATCHDOG_BACKEND_PROBE_MS,
  loadFailureThreshold: WATCHDOG_LOAD_FAILURE_THRESHOLD,
  brokenWindowMs: LOCAL_RUNTIME_BROKEN_WINDOW_MS
});
const { startDshBackend, waitForBackendReady, killProcessTree } = backend;
const protocolSetup = createProtocolSetup({
  session,
  protocol,
  net,
  appRoot: __dirname,
  appProtocolEnabled: ENABLE_APP_PROTOCOL,
  dev: process.env.DSH_DEV === '1',
  isBackendDocument: (url) => isBackendHttp(url, currentPort),
  backendCspMode: BACKEND_CSP_MODE,
  getBackendOrigin: () => {
    try {
      return new URL(backend.getTargetUrl()).origin;
    } catch {
      return null;
    }
  }
});


// findAvailablePort imported from ./lib/env-utils

const restartController = createRestartController({
  backend,
  startDshBackend,
  waitForBackendReady,
  findAvailablePort,
  installAppProtocol: () => protocolSetup.installAppProtocol(),
  getMainWindow: () => mainWindow,
  getPort: () => currentPort,
  setPort: (port) => {
    currentPort = port;
  },
  onReady: (targetUrl, port) => {
    mainWindow.loadURL(targetUrl);
    mainWindow.setTitle(`DeepSeek Harness — ${targetWorkspaceDir}`);
    mainWindow.webContents.send('dsh:backend-ready', targetUrl, port);
  },
  rebuildMenus: () => {
    buildNativeAppMenu();
    updateTrayMenu();
  },
  operationLog,
  logContext: () => ({ engine: currentEngine, safeMode: isSafeMode })
});

async function performRestartWithCurrentConfig() {
  if (E2E_BACKEND_URL) {
    // e2e 模式：跳过真实后端，直接加载测试夹具页面
    try {
      currentPort = Number(new URL(E2E_BACKEND_URL).port) || 80;
    } catch {
      /* 尽力而为：失败不阻断主流程 */
    }
    backend.markReady(true);
    operationLog.append('e2e-backend', { url: E2E_BACKEND_URL, port: currentPort });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(E2E_BACKEND_URL);
      mainWindow.setTitle(`DeepSeek Harness — ${targetWorkspaceDir}`);
      mainWindow.webContents.send('dsh:backend-ready', E2E_BACKEND_URL, currentPort);
    }
    return true;
  }
  return restartController.performRestart();
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
const { readFactoryPresetPluginNames } = presetPlugins;

const updateFlow = createUpdateFlow({
  dialog,
  shell,
  getMainWindow: () => mainWindow,
  t,
  getCurrentDshVersion,
  getShellVersion,
  localRuntimeDir: LOCAL_RUNTIME_DIR,
  getBundledNodeExe,
  getBundledPnpmCjs,
  preset: presetPlugins,
  journal: updateJournal,
  hooks: {
    killProcessTree,
    startDshBackend,
    restartWithCurrentConfig,
    clearLocalRuntimeWatchdog: () => backend.clearWatchdog(),
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
const runUpdateCheck = (silent = false) => {
  operationLog.append('update-check', { silent });
  return updateFlow.runUpdateCheck(silent);
};
const revertToFactoryRuntime = updateFlow.revertToFactoryRuntime;
const cleanupOldBrokenRuntimeDirs = updateFlow.cleanupOldBrokenRuntimeDirs;


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
  getState: () => ({
    port: currentPort,
    engine: currentEngine,
    safeMode: isSafeMode,
    workspaceDir: targetWorkspaceDir
  }),
  getKeybindings: () => shortcutController.getBindings(),
  setEngine: (value) => {
    currentEngine = value;
  },
  setSafeMode: (value) => {
    isSafeMode = value;
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
      operationLog.append('self-repair:start');
      const report = runSelfRepair({
        dshHome: DSH_HOME,
        runtimeDir: getRuntimeDir(),
        killOrphanProcess: () => killProcessTree()
      });
      const ready = await restartWithCurrentConfig();
      operationLog.append('self-repair:done', {
        ready,
        actions: report.actions ? report.actions.length : 0
      });
      return { report, ready };
    },
    registerContextMenu: () => registerWindowsContextMenu(),
    unregisterContextMenu: () => unregisterWindowsContextMenu(),
    getCurrentDshVersion,
    getShellVersion,
    getDshHome: () => DSH_HOME,
    getCrashReportDir: () => CRASH_REPORT_DIR,
    openKeybindingFile: () => shell.openPath(KEYBINDINGS_PATH),
    getShellUpdateStatus: async () => {
      try {
        return await shellUpdater.status();
      } catch (err) {
        return { supported: false, reason: 'exception', message: err.message };
      }
    },
    updateShell: async () => {
      try {
        return await shellUpdater.update();
      } catch (err) {
        return { ok: false, reason: 'exception', message: err.message };
      }
    },
    relaunchApp: () => {
      app.relaunch();
      app.exit(0);
    },
    getRecentWorkspaces: () => workspaceStore.list(),
    openWorkspaceDialog,
    switchToWorkspace,
    removeRecentWorkspace: (dir) => workspaceStore.remove(dir),
    reloadKeybindings,
    requestQuit,
    getCliStatus: () => cliInstaller.status(),
    installCli: () => {
      try {
        return cliInstaller.install();
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    },
    removeCli: () => {
      try {
        return cliInstaller.remove();
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    },
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
  getPortableDataRoot: () => portableLayout.getDataRoot(),
  getEngine: () => currentEngine,
  isWindowsPlatform
});

const shortcutController = createShortcutController({
  globalShortcut,
  loadBindings: loadKeybindings,
  toggleWindow: () => toggleMainWindowVisibility(),
  rebuildMenus: () => buildNativeAppMenu(),
  operationLog
});

function registerRelayShortcut() {
  return shortcutController.register();
}

function reloadKeybindings() {
  return shortcutController.reload();
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

let quitApproved = false;
let quitPromptOpen = false;

async function requestQuit() {
  if (quitApproved) return true;
  if (E2E_BACKEND_URL) {
    quitApproved = true;
    isQuitting = true;
    app.quit();
    return true;
  }
  if (quitPromptOpen) return false;
  quitPromptOpen = true;
  let approved = false;
  try {
    approved = await quitConfirmation.confirmQuit();
  } finally {
    quitPromptOpen = false;
  }
  if (!approved) {
    isQuitting = false;
    return false;
  }
  quitApproved = true;
  isQuitting = true;
  app.quit();
  return true;
}

function handleMainWindowClose(event) {
  if (isQuitting || !isWindowsPlatform()) return;
  event.preventDefault();
  if (!getTray()) {
    void requestQuit();
    return;
  }
  if (targetWorkspaceIsWorktree) {
    void handleWorktreeWindowClose();
    return;
  }
  void (async () => {
    if (await quitConfirmation.confirmBackgroundHide()) {
      mainWindow.hide();
    }
  })();
}

const createAppWindow = createWindowFactory({
  BrowserWindow,
  shell,
  appRoot: __dirname,
  preloadPath: path.join(__dirname, 'preload.js'),
  appScheme: APP_SCHEME,
  appHost: APP_HOST,
  appProtocolEnabled: ENABLE_APP_PROTOCOL,
  isBackendHttp,
  isAppUrl,
  isAllowedFileUrl: (url) => isFileInsideRoot(url, __dirname),
  getPort: () => currentPort,
  getWorkspaceDir: () => targetWorkspaceDir,
  isHiddenLaunch: () => process.argv.includes('--hidden') || process.argv.includes('--minimized'),
  beforeLoad: () => {
    buildNativeAppMenu();
    protocolSetup.installAppProtocol();
  },
  onLoadFailure: (errorCode, errorDescription) => backend.noteLoadFailure(errorCode, errorDescription),
  onLoadReady: () => backend.resetLoadFailures(),
  onCloseRequest: handleMainWindowClose,
  onRendererGone: (details) => {
    crashReporter.capture('renderer-gone', new Error(`renderer process gone: ${details.reason}`), {
      reason: details.reason,
      exitCode: details.exitCode
    });
  }
});

function createMainWindow() {
  mainWindow = createAppWindow();
}

const ipcActions = createIpcActions({
  Notification,
  dialog,
  t,
  app,
  backend,
  clipboardBridge,
  worktreeManager,
  getMainWindow: () => mainWindow,
  getPort: () => currentPort,
  setPort: (port) => {
    currentPort = port;
  },
  getEngine: () => currentEngine,
  setEngine: (value) => {
    currentEngine = value;
  },
  isSafeMode: () => isSafeMode,
  setSafeMode: (value) => {
    isSafeMode = value;
  },
  getShellVersion,
  getCurrentDshVersion,
  getDshHome: () => DSH_HOME,
  getWorkspaceDir: () => targetWorkspaceDir,
  getWorktreeStatus: () => ({
    isWorktree: targetWorkspaceIsWorktree,
    worktreePath: activeWorktreeSession.worktreePath,
    worktreeBranch: activeWorktreeSession.branchName
  }),
  readFactoryPresetPluginNames,
  hydratePresetPlugins: () => hydratePresetPluginsIfNeeded(),
  switchWorkspace,
  restartWithCurrentConfig,
  registerWindowsContextMenu,
  unregisterWindowsContextMenu,
  getAutoStart,
  setAutoStart,
  rebuildMenus: () => {
    buildNativeAppMenu();
    updateTrayMenu();
  },
  runSelfRepair,
  getRuntimeDir,
  killProcessTree,
  runUpdateCheck
});

registerIpcHandlers({
  ipcMain,
  assertTrustedSender,
  actions: ipcActions
});

app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents);
  if (!contents || typeof contents.on !== 'function') return;
  contents.on('console-message', (...args) => {
    const details = args.find(
      (arg) => arg && typeof arg === 'object' && typeof arg.message === 'string'
    );
    const message = details ? details.message : args.find((arg) => typeof arg === 'string');
    if (isCspViolationMessage(message)) cspViolationSink.report(message);
  });
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  handleCliWorkspaceArgs(process.argv);
  if (updateJournal.isInterrupted()) {
    const marked = markInterruptedRuntime({ runtimeDir: LOCAL_RUNTIME_DIR });
    operationLog.append('update-interrupted', { marked });
    if (marked) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: t('dialog.updateInterrupted.title'),
        message: t('dialog.updateInterrupted.message')
      });
    }
  }
  workspaceStore.touch(
    targetWorkspaceIsWorktree ? activeWorktreeSession.repoPath || targetWorkspaceDir : targetWorkspaceDir
  );
  protocolSetup.installBackendCsp();
  createSessionSecurity({ getAllowedOrigin: () => backend.getTargetUrl() }).install(session.defaultSession);
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
  if (!E2E_BACKEND_URL) {
    setTimeout(() => {
      if (!isQuitting) runUpdateCheck(true);
    }, 5000);
  }
});

app.on('before-quit', (event) => {
  if (!quitApproved) {
    event.preventDefault();
    void requestQuit();
    return;
  }
  backend.clearWatchdog();
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
