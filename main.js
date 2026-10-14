const {
  app,
  BrowserWindow,
  Menu,
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
const stream = require('stream');
const { promisify } = require('util');
const { toWslPath } = require('./lib/win-utils');
const { isBackendHttp } = require('./lib/trusted-url');
const { decideRestart, MAX_CRASH_RESTARTS } = require('./lib/backend-lifecycle');
const { pickWorkspaceMode } = require('./lib/cli-workspace');
const { runRegCommands } = require('./lib/win-reg');
const {
  isNewer,
  decideUpdatePlan,
  formatUpdateDescription,
  buildProxyedUrls,
  pickInstallerUrl
} = require('./lib/updater');

const streamPipeline = promisify(stream.pipeline);

let mainWindow = null;
let dshProcess = null;
let crashCount = 0;
let isQuitting = false;
let currentPort = 3080;
let currentEngine = 'win-native';
let isSafeMode = false;
let useChinaMirror = false;
let targetWorkspaceDir = process.cwd();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', async (_event, argv) => {
    if (!mainWindow) return;
    const previousDir = targetWorkspaceDir;
    handleCliWorkspaceArgs(Array.isArray(argv) && argv.length > 1 ? argv : process.argv);
    if (targetWorkspaceDir !== previousDir) {
      mainWindow.setTitle(`DeepSeek Harness Studio — ${targetWorkspaceDir}`);
      await restartWithCurrentConfig();
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function resolveDshHome() {
  const exeDir = path.dirname(app.getPath('exe'));
  const portableDir = path.join(exeDir, 'portable-data');
  if (fs.existsSync(portableDir)) {
    const portableHome = path.join(portableDir, '.dsh');
    fs.mkdirSync(portableHome, { recursive: true });
    app.setPath('userData', path.join(portableDir, 'electron-userdata'));
    return portableHome;
  }
  return path.join(os.homedir(), '.dsh');
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

function getRuntimeDir() {
  if (isLocalRuntimeUsable()) return LOCAL_RUNTIME_DIR;
  return getBundledRuntimeDir();
}

function getBundledNodeExe() {
  const bundledNode = path.join(getBundledRuntimeDir(), 'node.exe');
  if (fs.existsSync(bundledNode)) return bundledNode;
  return null;
}

function getBundledPnpmCjs() {
  const pnpmCjs = path.join(getBundledRuntimeDir(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (fs.existsSync(pnpmCjs)) return pnpmCjs;
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
  const frameUrl = event.senderFrame ? event.senderFrame.url : '';
  if (!isBackendHttp(frameUrl, currentPort)) {
    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
  }
}

function cleanStaleLocks(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        cleanStaleLocks(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.lock')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8').trim();
          const pid = parseInt(content, 10);
          if (!pid || Number.isNaN(pid)) {
            fs.unlinkSync(fullPath);
          } else {
            try {
              process.kill(pid, 0);
            } catch {
              fs.unlinkSync(fullPath);
            }
          }
        } catch {
          try { fs.unlinkSync(fullPath); } catch {}
        }
      }
    }
  } catch (err) {
    console.warn('[lock-cleaner] Skip error:', err.message);
  }
}

function hydratePresetPluginsIfNeeded() {
  const runtimeDir = getRuntimeDir();
  const presetProfile = path.join(runtimeDir, 'default-profile');
  const markerFile = path.join(DSH_HOME, '.codex-studio-hydrated');
  if (!fs.existsSync(presetProfile) || fs.existsSync(markerFile)) return;
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true });
    fs.cpSync(presetProfile, DSH_HOME, { recursive: true, force: false });
    fs.writeFileSync(markerFile, new Date().toISOString());
  } catch (err) {
    console.warn('[preset-hydrator] Warning:', err.message);
  }
}

function handleCliWorkspaceArgs(argv) {
  const picked = pickWorkspaceMode(argv);
  if (picked.mode === 'open-dir') {
    targetWorkspaceDir = path.resolve(picked.value);
  } else if (picked.mode === 'worktree-dir') {
    const baseDir = path.resolve(picked.value);
    targetWorkspaceDir = createIsolatedGitWorktree(baseDir);
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
      windowsHide: true
    });
    return worktreePath;
  } catch (err) {
    console.warn('[git-worktree] Fallback to original dir:', err.message);
    return repoDir;
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
  const env = {
    ...process.env,
    DSH_HOME,
    PORT: String(currentPort)
  };
  if (useChinaMirror) {
    env.NPM_CONFIG_REGISTRY = 'https://registry.npmmirror.com';
  }
  const isWindows = process.platform === 'win32';
  if (currentEngine === 'wsl2' && isWindows) {
    const wslWorkspace = toWslPath(targetWorkspaceDir);
    const safeFlag = isSafeMode ? '--safe-mode' : '';
    const wslCmd = `cd "${wslWorkspace}" && npx --yes @deepseek-ai/dsh web --port ${currentPort} ${safeFlag}`;
    dshProcess = spawn('wsl.exe', ['--', 'bash', '-lc', wslCmd], {
      stdio: 'pipe',
      windowsHide: true
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
    } else if (fs.existsSync(dshCmd)) {
      dshProcess = spawn(dshCmd, args, {
        ...commonSpawnOpts,
        shell: isWindows
      });
    } else {
      dshProcess = spawn('npx', ['--yes', '@deepseek-ai/dsh', ...args], {
        ...commonSpawnOpts,
        shell: isWindows
      });
    }
  }
  const proc = dshProcess;

  if (proc.stdout) {
    proc.stdout.on('data', (chunk) => console.log(`[dsh] ${String(chunk)}`));
  }
  if (proc.stderr) {
    proc.stderr.on('data', (chunk) => console.warn(`[dsh] ${String(chunk)}`));
  }

  proc.on('error', (err) => {
    console.error(`[dsh-backend] Failed to spawn backend: ${err.message}`);
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

async function restartWithCurrentConfig() {
  startDshBackend();
  const ready = await waitForBackendReady();
  if (mainWindow) {
    mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
    buildNativeAppMenu();
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
  CORE_REGISTRY_URL: 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest',
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
  REQUEST_TIMEOUT_MS: 5000,
  DOWNLOAD_TIMEOUT_MS: 60000,
  REGISTRY: 'https://registry.npmmirror.com',
  isChecking: false
};

function httpGetJson(url, timeoutMs = UPDATER.REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const lib = url.startsWith('https:') ? https : http;
    let req;
    try {
      req = lib.get(url, { headers: { 'User-Agent': 'deepseek-harness-desktop/1.0' } }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          finish(null, new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            finish(JSON.parse(text));
          } catch (err) {
            finish(null, err);
          }
        });
      });
    } catch (err) {
      finish(null, err);
      return;
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => finish(null, err));
  });
}

async function checkRemoteCoreVersion() {
  try {
    const data = await httpGetJson(UPDATER.CORE_REGISTRY_URL);
    if (!data || !data.version) return null;
    return data.version;
  } catch {
    return null;
  }
}

async function checkRemoteShellVersion() {
  for (const url of UPDATER.SHELL_MANIFEST_URLS) {
    try {
      const data = await httpGetJson(url);
      if (data && data.version) return data.version;
    } catch {
      // try next mirror
    }
  }
  return null;
}

async function checkRemoteReleaseAssets() {
  for (const url of UPDATER.GITHUB_RELEASE_URLS) {
    try {
      const data = await httpGetJson(url);
      if (data && data.assets && data.assets.length > 0) {
        const installerUrl = pickInstallerUrl(data.assets);
        if (installerUrl) {
          return { tag: data.tag_name, installerUrl };
        }
      }
    } catch {
      // try next mirror
    }
  }
  return null;
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

function downloadWithProxies(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const candidates = buildProxyedUrls(url, UPDATER.GITHUB_DOWNLOAD_PROXIES);
    let activeReq = null;
    let activeWs = null;
    let settled = false;
    let attemptIndex = 0;

    const attemptDownload = () => {
      const currentUrl = candidates[attemptIndex];
      if (!currentUrl) {
        if (!settled) {
          settled = true;
          reject(new Error('All download mirrors exhausted'));
        }
        return;
      }
      const lib = currentUrl.startsWith('https:') ? https : http;
      const file = fs.createWriteStream(destPath);
      activeWs = file;

      let req;
      try {
        req = lib.get(currentUrl, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            cleanupAndNext();
            return;
          }
          const total = Number(res.headers['content-length'] || 0);
          let received = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            if (typeof onProgress === 'function' && total > 0) {
              const percent = Math.min(99, Math.floor((received / total) * 100));
              onProgress(percent, total, received);
            }
          });
          res.pipe(file);
        });
      } catch (err) {
        try { file.close(); } catch {}
        cleanupAndNext();
        return;
      }
      activeReq = req;
      req.setTimeout(UPDATER.DOWNLOAD_TIMEOUT_MS, () => {
        try { req.destroy(new Error('download timeout')); } catch {}
      });
      req.on('error', () => cleanupAndNext());
      file.on('error', () => cleanupAndNext());
      file.on('close', () => {
        if (settled) return;
        settled = true;
        resolve(destPath);
      });
    };

    const cleanupAndNext = () => {
      try {
        if (activeReq) activeReq.destroy();
      } catch {}
      try {
        if (activeWs) activeWs.close();
      } catch {}
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch {}
      attemptIndex += 1;
      if (!settled) attemptDownload();
    };

    attemptDownload();
  });
}

async function installHotUpdateCore(targetVersion) {
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
  setWindowProgress('正在通过国内镜像热更新 DSH 内核与插件...');
  return new Promise((resolve, reject) => {
    const pkgName = targetVersion
      ? `@deepseek-ai/dsh@${targetVersion}`
      : '@deepseek-ai/dsh@latest';
    const args = [
      pnpmCjs,
      'add',
      pkgName,
      `--registry=${UPDATER.REGISTRY}`
    ];
    const pnpmProc = spawn(nodeExe, args, {
      cwd: LOCAL_RUNTIME_DIR,
      env: {
        ...process.env,
        DSH_HOME: LOCAL_RUNTIME_DIR,
        NPM_CONFIG_REGISTRY: UPDATER.REGISTRY,
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false'
      },
      stdio: 'pipe',
      windowsHide: true
    });
    let stderr = '';
    pnpmProc.stdout.on('data', (chunk) => console.log(`[updater] ${String(chunk)}`));
    pnpmProc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      console.warn(`[updater] ${String(chunk)}`);
    });
    pnpmProc.on('error', (err) => {
      reject(new Error(`pnpm 启动失败: ${err.message}`));
    });
    pnpmProc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pnpm 安装失败 (exit ${code}): ${stderr.slice(0, 500)}`));
      }
    });
  });
}

function isPortable() {
  const exeDir = path.dirname(app.getPath('exe'));
  return fs.existsSync(path.join(exeDir, 'portable-data'));
}

async function revertToFactoryRuntime() {
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
      message: '当前外壳与 DSH 官方内核均已是最新版本',
      detail: `外壳版本：${shellInfo.current}\nDSH 内核版本：${coreInfo.current}（${coreInfo.source}）`,
      buttons: ['关闭']
    });
    return;
  }
  const description = formatUpdateDescription({
    core: { currentVersion: coreInfo.current, remoteVersion: remoteCore },
    shell: { currentVersion: shellInfo.current, remoteVersion: remoteShell },
    plan: { coreNeedsUpdate: coreInfo.needsUpdate, shellNeedsUpdate: shellInfo.needsUpdate }
  });
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '检测到可用更新',
    message: '发现可升级项，是否立即执行全自动更新？',
    detail: description,
    buttons: ['立即全自动更新', '稍后'],
    defaultId: 0
  });
  return response.response === 0;
}

async function performAutoUpdate(coreInfo, shellInfo, remoteCore, remoteShell) {
  try {
    if (coreInfo.needsUpdate) {
      await installHotUpdateCore(remoteCore);
    }

    if (shellInfo.needsUpdate) {
      const release = await checkRemoteReleaseAssets();
      if (!release) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '外壳更新',
          message: '无法获取最新外壳安装包下载地址，请稍后重试或手动下载安装包。'
        });
        clearWindowProgress();
        return;
      }
      const tmpDir = os.tmpdir();
      const installerName = `${path.basename(release.installerUrl).split('?')[0] || 'DeepSeek-Harness-Desktop-Setup.exe'}`;
      const installerPath = path.join(tmpDir, installerName);
      setWindowProgress('正在下载客户端外壳更新 (0%)...');
      await downloadWithProxies(release.installerUrl, installerPath, (percent) => {
        setWindowProgress(`正在下载客户端外壳更新 (${percent}%)...`);
      });

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
        try {
          const installer = spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore' });
          installer.unref();
        } catch (err) {
          dialog.showErrorBox('NSIS 安装启动失败', String(err.message || err));
        }
        clearWindowProgress();
        isQuitting = true;
        setTimeout(() => app.quit(), 500);
        return;
      }
    }

    if (coreInfo.needsUpdate) {
      await restartWithCurrentConfig();
      clearWindowProgress();
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '热更新成功',
        message: `DSH 内核已热更新到 ${remoteCore}`,
        detail: '后端已自动重启。若新版出现异常，可在「引擎与救援」→「⏪ 回退至出厂内置内核」一键回滚。'
      });
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
      needsUpdate: remoteCore && isNewer(remoteCore, currentCore.version)
    };
    const shellInfo = {
      current: currentShell,
      needsUpdate: remoteShell && isNewer(remoteShell, currentShell)
    };
    const plan = decideUpdatePlan({
      core: { currentVersion: currentCore.version, remoteVersion: remoteCore },
      shell: { currentVersion: currentShell, remoteVersion: remoteShell }
    });
    if (plan.hasUpdate) {
      const confirmed = await showUpdateCheckResult(true, coreInfo, shellInfo, remoteCore, remoteShell);
      if (confirmed) {
        await performAutoUpdate(coreInfo, shellInfo, remoteCore, remoteShell);
      }
    } else if (!silent) {
      await showUpdateCheckResult(false, coreInfo, shellInfo, remoteCore, remoteShell);
    }
  } finally {
    UPDATER.isChecking = false;
  }
}


function buildNativeAppMenu() {
  const template = [
    {
      label: '工作台 (Studio)',
      submenu: [
        {
          label: '新建独立 Git Worktree 沙箱会话...',
          click: async () => {
            const res = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
              title: '选择 Git 仓库目录以自动创建隔离 Worktree'
            });
            if (!res.canceled && res.filePaths[0]) {
              targetWorkspaceDir = createIsolatedGitWorktree(res.filePaths[0]);
              if (mainWindow) {
                mainWindow.setTitle(`DeepSeek Harness Studio — ${targetWorkspaceDir}`);
              }
              await restartWithCurrentConfig();
            }
          }
        },
        {
          label: '将剪贴板内容投喂至当前输入框 (Alt+Shift+V)',
          accelerator: 'Alt+Shift+V',
          click: () => {
            const text = clipboard.readText();
            if (mainWindow && text) {
              mainWindow.webContents.send('dsh:inject-clipboard-text', text);
            }
          }
        },
        { type: 'separator' },
        {
          label: '窗口始终置顶 (伴侣悬浮模式)',
          type: 'checkbox',
          checked: mainWindow ? mainWindow.isAlwaysOnTop() : false,
          click: (item) => {
            if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
          }
        },
        { type: 'separator' },
        {
          label: '彻底退出 DSH Studio',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: '引擎与救援 (Engine & Rescue)',
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
          label: '运行引擎：Windows 原生控制台 Node (推荐)',
          type: 'radio',
          checked: currentEngine === 'win-native',
          click: async () => {
            currentEngine = 'win-native';
            await restartWithCurrentConfig();
          }
        },
        {
          label: '运行引擎：本机 WSL2 Linux 宿主桥接',
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
          label: '故障隔离安全模式 (--safe-mode 禁用故障插件)',
          type: 'checkbox',
          checked: isSafeMode,
          click: async (item) => {
            isSafeMode = item.checked;
            await restartWithCurrentConfig();
          }
        },
        {
          label: '启用国内 npm 镜像源加速插件安装',
          type: 'checkbox',
          checked: useChinaMirror,
          click: async (item) => {
            useChinaMirror = item.checked;
            await restartWithCurrentConfig();
          }
        },
        {
          label: '一键重新释放内置 Codex 黄金插件包',
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
          label: '注册右键菜单 (Open with DSH / New Git Worktree)',
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
          label: '移除右键菜单',
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
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: `DeepSeek Harness Studio — ${targetWorkspaceDir}`,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  buildNativeAppMenu();
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
  mainWindow.on('close', (event) => {
    if (!isQuitting && isWindowsPlatform()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
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
    workspace: targetWorkspaceDir
  };
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

app.whenReady().then(async () => {
  if (!gotLock) return;
  handleCliWorkspaceArgs(process.argv);
  createMainWindow();
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
