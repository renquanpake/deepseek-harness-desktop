'use strict';

const fs = require('fs');
const path = require('path');

function createUiMenus({
  app,
  dialog,
  shell,
  Menu,
  Tray,
  nativeImage,
  t,
  getMainWindow,
  isWindowsPlatform,
  getState,
  setEngine,
  setSafeMode,
  setQuitting,
  actions
}) {
  let tray = null;

  function getTrayIconPath(appDir) {
    const candidates = [
      path.join(appDir, 'build', 'icon.png'),
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
      const isAuto = actions.getAutoStart();
      const menu = Menu.buildFromTemplate([
        {
          label: t('tray.showWindow'),
          click: () => {
            const mainWindow = getMainWindow();
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
            }
          }
        },
        {
          label: t('tray.checkUpdates'),
          click: () => actions.runUpdateCheck(false)
        },
        {
          label: t('tray.autoStart'),
          type: 'checkbox',
          checked: isAuto,
          click: (item) => {
            actions.setAutoStart(item.checked);
            updateTrayMenu();
          }
        },
        { type: 'separator' },
        {
          label: t('tray.quit'),
          click: () => {
            setQuitting();
            app.quit();
          }
        }
      ]);
      tray.setContextMenu(menu);
    } catch (err) {
      console.warn(`[tray] 更新托盘菜单异常: ${err.message}`);
    }
  }

  function createTray(appDir) {
    if (tray) return;
    const iconPath = getTrayIconPath(appDir);
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
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
    } catch (err) {
      console.warn(`[tray] Failed to create tray: ${err.message}`);
    }
  }

  function syncAutoStartChange(result) {
    const mainWindow = getMainWindow();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('dsh:auto-start-changed', result);
    }
    buildNativeAppMenu();
    updateTrayMenu();
  }

  function buildNativeAppMenu() {
    const mainWindow = getMainWindow();
    const state = getState();
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
                const session = actions.createWorktreeSession(res.filePaths[0]);
                actions.switchWorkspace(session.worktreePath, session);
                if (mainWindow) {
                  mainWindow.setTitle(actions.composeWindowTitle());
                }
                await actions.restartWithCurrentConfig();
              }
            }
          },
          {
            label: t('menu.studio.pasteClipboard'),
            accelerator: 'Alt+Shift+V',
            click: () => {
              actions.pasteClipboard();
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
            checked: actions.getAutoStart(),
            click: (item) => {
              syncAutoStartChange(actions.setAutoStart(item.checked));
            }
          },
          { type: 'separator' },
          {
            label: t('menu.app.quit'),
            click: () => {
              setQuitting();
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
              const core = actions.getCurrentDshVersion();
              const sourceLabel = core.source === 'hot-update'
                ? t('menu.engine.sourceHotUpdate')
                : t('menu.engine.sourceFactory');
              return t('menu.engine.status', { shell: actions.getShellVersion(), core: core.version, source: sourceLabel });
            })(),
            enabled: false
          },
          { type: 'separator' },
          {
            label: t('menu.engine.selfRepair'),
            click: async () => {
              const { report, ready } = await actions.runSelfRepairSession();
              const fresh = getState();
              const activeWindow = getMainWindow();
              if (activeWindow) {
                const actionList = report.actions && report.actions.length
                  ? report.actions.map((a) => `• ${a}`).join('\n')
                  : t('dialog.selfRepair.noActions');
                dialog.showMessageBox(activeWindow, {
                  type: 'info',
                  title: t('dialog.selfRepair.title'),
                  message: ready ? t('dialog.selfRepair.readyMessage') : t('dialog.selfRepair.pendingMessage'),
                  detail: t('dialog.selfRepair.detail', { actions: actionList, port: fresh.port, engine: fresh.engine })
                });
              }
            }
          },
          {
            label: t('menu.engine.checkUpdates'),
            click: () => {
              actions.runUpdateCheck(false);
            }
          },
          {
            label: t('menu.engine.revertFactory'),
            click: () => {
              actions.revertToFactoryRuntime();
            }
          },
          { type: 'separator' },
          {
            label: t('menu.engine.winNative'),
            type: 'radio',
            checked: state.engine === 'win-native',
            click: async () => {
              setEngine('win-native');
              await actions.restartWithCurrentConfig();
            }
          },
          {
            label: t('menu.engine.wsl2'),
            type: 'radio',
            checked: state.engine === 'wsl2',
            click: async () => {
              if (!isWindowsPlatform()) {
                dialog.showMessageBox(getMainWindow(), {
                  type: 'warning',
                  title: t('dialog.common.dsStudioTitle'),
                  message: t('dialog.wsl2Unavailable.message')
                });
                setEngine('win-native');
                return;
              }
              setEngine('wsl2');
              await actions.restartWithCurrentConfig();
            }
          },
          { type: 'separator' },
          {
            label: t('menu.engine.safeMode'),
            type: 'checkbox',
            checked: state.safeMode,
            click: async (item) => {
              setSafeMode(item.checked);
              await actions.restartWithCurrentConfig();
            }
          },
          {
            label: t('menu.engine.restorePresets'),
            click: async () => {
              actions.hydratePresetPlugins(true);
              await actions.restartWithCurrentConfig();
              const activeWindow = getMainWindow();
              if (activeWindow) {
                dialog.showMessageBox(activeWindow, {
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
              const result = actions.registerContextMenu();
              const activeWindow = getMainWindow();
              if (result.total === 0) {
                dialog.showMessageBox(activeWindow, {
                  type: 'warning',
                  title: t('dialog.contextMenu.title'),
                  message: t('dialog.contextMenu.registerUnavailable')
                });
                return;
              }
              const ok = result.failed === 0;
              dialog.showMessageBox(activeWindow, {
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
              const result = actions.unregisterContextMenu();
              const activeWindow = getMainWindow();
              if (result.total === 0) {
                dialog.showMessageBox(activeWindow, {
                  type: 'warning',
                  title: t('dialog.contextMenu.title'),
                  message: t('dialog.contextMenu.unregisterUnavailable')
                });
                return;
              }
              dialog.showMessageBox(activeWindow, {
                type: 'info',
                title: t('dialog.contextMenu.title'),
                message: t('dialog.contextMenu.unregisterResult', { total: result.total, ok: result.ok, failed: result.failed })
              });
            }
          },
          { type: 'separator' },
          {
            label: t('menu.system.openDataDir'),
            click: () => shell.openPath(actions.getDshHome())
          },
          {
            label: t('menu.system.openDevTools'),
            accelerator: 'F12',
            click: () => {
              const activeWindow = getMainWindow();
              if (activeWindow) activeWindow.webContents.toggleDevTools();
            }
          }
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function getTray() {
    return tray;
  }

  return { buildNativeAppMenu, createTray, updateTrayMenu, getTray };
}

module.exports = { createUiMenus };
