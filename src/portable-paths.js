'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MARKER_DIR = 'portable-data';

function createPortableLayout({
  app,
  markerDir = DEFAULT_MARKER_DIR,
  platform = process.platform,
  env = process.env,
  homedir = os.homedir,
  log = console
}) {
  const state = {
    dataRoot: null,
    appData: null,
    localAppData: null,
    userProfile: null
  };

  function setState(next) {
    state.dataRoot = next.dataRoot ?? null;
    state.appData = next.appData ?? null;
    state.localAppData = next.localAppData ?? null;
    state.userProfile = next.userProfile ?? null;
  }

  function resolveDataRoot() {
    const declaredExeDir = env.PORTABLE_EXECUTABLE_DIR;
    const exeDir = path.dirname(app.getPath('exe'));
    const candidates = [];
    if (declaredExeDir && path.resolve(declaredExeDir) !== path.resolve(exeDir)) {
      candidates.push(path.join(declaredExeDir, markerDir));
    }
    candidates.push(path.join(exeDir, markerDir));
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
    }
    if (declaredExeDir) {
      const portableRoot = path.join(path.resolve(declaredExeDir), markerDir);
      try {
        fs.mkdirSync(portableRoot, { recursive: true });
        return portableRoot;
      } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
    }
    return null;
  }

  function ensureSubDir(name) {
    if (!state.dataRoot) return null;
    try {
      const target = path.join(state.dataRoot, name);
      fs.mkdirSync(target, { recursive: true });
      return target;
    } catch (err) {
      log.warn(`[portable] 创建便携数据子目录失败 ${name}: ${err.message}`);
      return null;
    }
  }

  function ensureGitConfig() {
    if (!state.dataRoot || platform !== 'win32') return;
    const portableGitConfig = path.join(state.dataRoot, 'home', '.gitconfig');
    if (fs.existsSync(portableGitConfig)) return;
    const systemGitConfig = path.join(homedir(), '.gitconfig');
    let content = '';
    try {
      if (fs.existsSync(systemGitConfig)) {
        content = `[include]\n\tpath = "${systemGitConfig.replace(/\\/g, '/')}"\n`;
      }
    } catch {
      return;
    }
    if (!content) return;
    try {
      fs.writeFileSync(portableGitConfig, content);
    } catch (err) {
      log.warn(`[portable] 写入便携 .gitconfig 失败: ${err.message}`);
    }
  }

  function resolveDshHome() {
    const dataRoot = resolveDataRoot();
    if (dataRoot) {
      try {
        fs.mkdirSync(dataRoot, { recursive: true });
        state.dataRoot = dataRoot;
        state.appData = ensureSubDir('appdata-roaming');
        state.localAppData = ensureSubDir('appdata-local');
        state.userProfile = ensureSubDir('userprofile');
        ensureSubDir('home');
        ensureSubDir('temp-captures');
        ensureGitConfig();
        app.setPath('userData', path.join(dataRoot, 'electron-userdata'));
        return path.join(dataRoot, '.dsh');
      } catch (err) {
        log.warn(`[portable] 便携数据根目录不可写，回退至用户主目录: ${err.message}`);
        setState({});
      }
    }
    return path.join(homedir(), '.dsh');
  }

  function buildEnvOverlay() {
    if (!state.dataRoot) return {};
    const overlay = {
      HOME: path.join(state.dataRoot, 'home')
    };
    if (state.userProfile) overlay.USERPROFILE = state.userProfile;
    if (state.appData) overlay.APPDATA = state.appData;
    if (platform === 'win32') {
      overlay.AppData = state.appData || path.join(state.dataRoot, 'appdata-roaming');
      overlay.LocalAppData = state.localAppData || path.join(state.dataRoot, 'appdata-local');
    }
    return overlay;
  }

  function isPortable() {
    return Boolean(state.dataRoot);
  }

  return {
    resolveDshHome,
    buildEnvOverlay,
    isPortable,
    getDataRoot: () => state.dataRoot
  };
}

module.exports = { createPortableLayout, DEFAULT_MARKER_DIR };
