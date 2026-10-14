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

let mainWindow = null;
let dshProcess = null;
let isQuitting = false;
let currentPort = 3080;
let currentEngine = 'win-native';
let isSafeMode = false;
let useChinaMirror = false;
let targetWorkspaceDir = process.cwd();

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

function getRuntimeDir() {
  const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh-runtime');
  if (fs.existsSync(unpackedPath)) return unpackedPath;
  const extraResPath = path.join(process.resourcesPath, 'dsh-runtime');
  if (fs.existsSync(extraResPath)) return extraResPath;
  return path.join(__dirname, 'dsh-runtime');
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
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--open-dir' && argv[i + 1]) {
      targetWorkspaceDir = path.resolve(argv[i + 1]);
      break;
    }
    if (arg === '--worktree-dir' && argv[i + 1]) {
      const baseDir = path.resolve(argv[i + 1]);
      targetWorkspaceDir = createIsolatedGitWorktree(baseDir);
      break;
    }
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
  const pid = dshProcess.pid;
  dshProcess = null;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {}
}

function toWslPath(winPath) {
  const normalized = path.resolve(winPath).replace(/\\/g, '/');
  const match = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (match) {
    return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  }
  return normalized;
}

function startDshBackend() {
  killProcessTree();
  cleanStaleLocks(DSH_HOME);
  hydratePresetPluginsIfNeeded();
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
  if (currentEngine === 'wsl2' && process.platform === 'win32') {
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
      process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
    );
    const bundledNode = path.join(process.resourcesPath, 'node.exe');
    if (process.platform === 'win32' && fs.existsSync(bundledNode) && fs.existsSync(dshCliJs)) {
      dshProcess = spawn(bundledNode, [dshCliJs, ...args], {
        cwd: targetWorkspaceDir,
        env,
        stdio: 'pipe',
        windowsHide: true
      });
    } else if (fs.existsSync(dshCmd)) {
      dshProcess = spawn(dshCmd, args, {
        cwd: targetWorkspaceDir,
        env,
        shell: process.platform === 'win32',
        stdio: 'pipe',
        windowsHide: true
      });
    } else {
      dshProcess = spawn('npx', ['--yes', '@deepseek-ai/dsh', ...args], {
        cwd: targetWorkspaceDir,
        env,
        shell: process.platform === 'win32',
        stdio: 'pipe',
        windowsHide: true
      });
    }
  }
  dshProcess.on('exit', (code) => {
    if (!isQuitting && code !== 0) {
      console.warn(`[dsh-watchdog] Backend exited with code ${code}, auto-restarting in 1.5s...`);
      setTimeout(() => {
        if (!isQuitting) startDshBackend();
      }, 1500);
    }
  });
}

function waitForBackendReady(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${currentPort}`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 400);
        }
      });
      req.end();
    };
    check();
  });
}

function registerWindowsContextMenu() {
  if (process.platform !== 'win32') return false;
  const exePath = process.execPath;
  try {
    const baseKeyBg = 'HKCU\\Software\\Classes\\Directory\\Background\\shell';
    const baseKeyDir = 'HKCU\\Software\\Classes\\Directory\\shell';
    execSync(`reg add "${baseKeyBg}\\DSHStudioOpen" /ve /d "Open with DeepSeek Harness Studio" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyBg}\\DSHStudioOpen" /v "Icon" /d "\\"${exePath}\\"" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyBg}\\DSHStudioOpen\\command" /ve /d "\\"${exePath}\\" --open-dir \\"%V\\"" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyDir}\\DSHStudioOpen" /ve /d "Open with DeepSeek Harness Studio" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyDir}\\DSHStudioOpen" /v "Icon" /d "\\"${exePath}\\"" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyDir}\\DSHStudioOpen\\command" /ve /d "\\"${exePath}\\" --open-dir \\"%1\\"" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyBg}\\DSHStudioWorktree" /ve /d "Open in New Git Worktree (DSH Studio)" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyBg}\\DSHStudioWorktree" /v "Icon" /d "\\"${exePath}\\"" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyBg}\\DSHStudioWorktree\\command" /ve /d "\\"${exePath}\\" --worktree-dir \\"%V\\"" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyDir}\\DSHStudioWorktree" /ve /d "Open in New Git Worktree (DSH Studio)" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyDir}\\DSHStudioWorktree" /v "Icon" /d "\\"${exePath}\\"" /f`, { windowsHide: true });
    execSync(`reg add "${baseKeyDir}\\DSHStudioWorktree\\command" /ve /d "\\"${exePath}\\" --worktree-dir \\"%1\\"" /f`, { windowsHide: true });
    return true;
  } catch (err) {
    console.error('[reg-menu] Failed:', err.message);
    return false;
  }
}

function unregisterWindowsContextMenu() {
  if (process.platform !== 'win32') return false;
  try {
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\DSHStudioOpen" /f', { windowsHide: true });
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\shell\\DSHStudioOpen" /f', { windowsHide: true });
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\DSHStudioWorktree" /f', { windowsHide: true });
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\shell\\DSHStudioWorktree" /f', { windowsHide: true });
    return true;
  } catch {
    return false;
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
              startDshBackend();
              await waitForBackendReady();
              mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
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
          label: '运行引擎：Windows 原生控制台 Node (推荐)',
          type: 'radio',
          checked: currentEngine === 'win-native',
          click: async () => {
            currentEngine = 'win-native';
            startDshBackend();
            await waitForBackendReady();
            mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
          }
        },
        {
          label: '运行引擎：本机 WSL2 Linux 宿主桥接',
          type: 'radio',
          checked: currentEngine === 'wsl2',
          click: async () => {
            currentEngine = 'wsl2';
            startDshBackend();
            await waitForBackendReady();
            mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
          }
        },
        { type: 'separator' },
        {
          label: '故障隔离安全模式 (--safe-mode 禁用故障插件)',
          type: 'checkbox',
          checked: isSafeMode,
          click: async (item) => {
            isSafeMode = item.checked;
            startDshBackend();
            await waitForBackendReady();
            mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
          }
        },
        {
          label: '启用国内 npm 镜像源加速插件安装',
          type: 'checkbox',
          checked: useChinaMirror,
          click: async (item) => {
            useChinaMirror = item.checked;
            startDshBackend();
            await waitForBackendReady();
            mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
          }
        },
        {
          label: '一键重新释放内置 Codex 黄金插件包',
          click: async () => {
            const markerFile = path.join(DSH_HOME, '.codex-studio-hydrated');
            if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
            hydratePresetPluginsIfNeeded();
            startDshBackend();
            await waitForBackendReady();
            mainWindow.reload();
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
            const ok = registerWindowsContextMenu();
            dialog.showMessageBox(mainWindow, {
              type: ok ? 'info' : 'error',
              title: '右键菜单集成',
              message: ok
                ? '注册成功！现在可在任意文件夹右键选择「Open in New Git Worktree (DSH Studio)」。'
                : '注册失败，请检查系统权限。'
            });
          }
        },
        {
          label: '移除右键菜单',
          click: () => {
            unregisterWindowsContextMenu();
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '右键菜单集成',
              message: '已移除 Windows 资源管理器右键菜单项。'
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
      nodeIntegration: false
    }
  });
  buildNativeAppMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform === 'win32') {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

ipcMain.on('dsh:native-notify', (_event, { title, body }) => {
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

app.whenReady().then(async () => {
  handleCliWorkspaceArgs(process.argv);
  createMainWindow();
  startDshBackend();
  globalShortcut.register('Alt+Space', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  await waitForBackendReady();
  if (mainWindow) {
    mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
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
