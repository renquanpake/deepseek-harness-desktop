'use strict';

const fs = require('fs');
const path = require('path');

function createUiMenus({
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
  actions
}) {
  let tray = null;

  function getTrayIconPath(appDir) {
    const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : null;
    const candidates = [
      path.join(appDir, 'build', 'icon.png'),
      resourcesPath ? path.join(resourcesPath, 'icon.png') : null,
      resourcesPath ? path.join(resourcesPath, 'build', 'icon.png') : null
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
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
            actions.requestQuit();
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
          { type: 'separator' },
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
              actions.requestQuit();
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
          { type: 'separator' },
          {
            label: t('menu.system.openDataDir'),
            click: () => shell.openPath(actions.getDshHome())
          },
          {
            label: t('menu.system.openCrashReports'),
            click: () => shell.openPath(actions.getCrashReportDir())
          },
          ...(isWindowsPlatform() ? [
            { type: 'separator' },
            {
              label: t('menu.system.installCli'),
              click: async () => {
                const result = await actions.installCli();
                dialog.showMessageBox(getMainWindow(), {
                  type: result.ok ? 'info' : 'error',
                  title: t('dialog.cliInstall.title'),
                  message: result.ok
                    ? t('dialog.cliInstall.success', { path: result.binDir })
                    : t('dialog.cliInstall.failure', { reason: result.reason }),
                  detail: result.ok ? t('dialog.cliInstall.detail') : undefined
                });
              }
            },
            {
              label: t('menu.system.removeCli'),
              click: async () => {
                const result = await actions.removeCli();
                dialog.showMessageBox(getMainWindow(), {
                  type: result.ok ? 'info' : 'error',
                  title: t('dialog.cliRemove.title'),
                  message: result.ok
                    ? t('dialog.cliRemove.success')
                    : t('dialog.cliRemove.failure', { reason: result.reason })
                });
              }
            }
          ] : []),
          {
            label: t('menu.system.openDevTools'),
            accelerator: 'F12',
            click: () => {
              const activeWindow = getMainWindow();
              if (activeWindow) activeWindow.webContents.toggleDevTools();
            }
          },
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
