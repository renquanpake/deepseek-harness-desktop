'use strict';

function createIpcActions({
  Notification,
  dialog,
  t,
  app,
  backend,
  clipboardBridge,
  worktreeManager,
  getMainWindow,
  getPort,
  getEngine,
  setEngine,
  isSafeMode,
  setSafeMode,
  getShellVersion,
  getCurrentDshVersion,
  getDshHome,
  getWorkspaceDir,
  getWorktreeStatus,
  readFactoryPresetPluginNames,
  hydratePresetPlugins,
  switchWorkspace,
  restartWithCurrentConfig,
  registerWindowsContextMenu,
  unregisterWindowsContextMenu,
  getAutoStart,
  setAutoStart,
  rebuildMenus,
  runSelfRepair,
  getRuntimeDir,
  killProcessTree,
  runUpdateCheck,
  log = console
}) {
  function mainWindow() {
    return typeof getMainWindow === 'function' ? getMainWindow() : null;
  }

  return {
    nativeNotify(payload) {
      const { title, body } = payload || {};
      const window = mainWindow();
      if (window && !window.isFocused()) {
        window.flashFrame(true);
      }
      if (Notification.isSupported()) {
        const notice = new Notification({ title, body });
        notice.on('click', () => {
          const active = mainWindow();
          if (active) {
            active.show();
            active.focus();
            active.flashFrame(false);
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
        port: getPort(),
        engine: getEngine(),
        safeMode: isSafeMode(),
        home: getDshHome(),
        workspaceDir: getWorkspaceDir()
      };
    },

    'dsh:get-backend-status'() {
      return {
        ready: Boolean(backend.isReady() && backend.isRunning()),
        url: backend.getTargetUrl(),
        port: getPort(),
        engine: getEngine(),
        workspaceDir: getWorkspaceDir()
      };
    },

    'dsh:set-always-on-top'(enable) {
      const window = mainWindow();
      if (window) {
        window.setAlwaysOnTop(Boolean(enable));
      }
      return Boolean(enable);
    },

    'dsh:get-plugin-inventory'() {
      return { plugins: readFactoryPresetPluginNames() };
    },

    'dsh:rehydrate-plugins'() {
      hydratePresetPlugins();
      return { ok: true };
    },

    async 'dsh:create-worktree-dialog'() {
      const result = await dialog.showOpenDialog(mainWindow(), {
        properties: ['openDirectory'],
        title: t('dialog.openWorktreeDir.title')
      });
      if (!result.canceled && result.filePaths[0]) {
        const session = worktreeManager.createIsolatedGitWorktree(result.filePaths[0]);
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
      setEngine(mode);
      await restartWithCurrentConfig();
      return { engine: getEngine() };
    },

    async 'dsh:restart-safe-mode'() {
      setSafeMode(!isSafeMode());
      await restartWithCurrentConfig();
      return { safeMode: isSafeMode() };
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
      const window = mainWindow();
      if (window && window.webContents) {
        window.webContents.send('dsh:auto-start-changed', result);
      }
      rebuildMenus();
      return result;
    },

    'dsh:convert-to-wsl-path'(windowsPath) {
      return clipboardBridge.convertToWslMountPath(windowsPath);
    },

    'dsh:get-workspace-status'() {
      const status = typeof getWorktreeStatus === 'function' ? getWorktreeStatus() : {};
      return {
        isWorktree: Boolean(status.isWorktree),
        worktreePath: status.worktreePath || null,
        worktreeBranch: status.worktreeBranch || null,
        engine: getEngine()
      };
    },

    async 'dsh:run-self-repair'() {
      log.log('[self-repair] 触发自动检修与自愈...');
      const report = runSelfRepair({
        dshHome: getDshHome(),
        runtimeDir: getRuntimeDir(),
        killOrphanProcess: () => killProcessTree()
      });
      const ready = await restartWithCurrentConfig();
      report.ready = ready;
      report.port = getPort();
      report.url = `http://127.0.0.1:${getPort()}`;
      return report;
    },

    'dsh:check-update'() {
      runUpdateCheck(false);
      return { ok: true };
    }
  };
}

module.exports = { createIpcActions };
