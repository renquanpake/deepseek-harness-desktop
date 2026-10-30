'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const UPDATE_CHECK = require('../lib/update-check');
const {
  isNewer,
  decideUpdatePlan,
  downloadWithProxies,
  verifyInstallerIntegrity,
  resolveInstallerFileName
} = require('../lib/updater');

function createUpdateFlow({
  app,
  dialog,
  shell,
  getMainWindow,
  t,
  getCurrentDshVersion,
  getShellVersion,
  localRuntimeDir,
  portableMarkerDir,
  getPortableDataRoot,
  getBundledNodeExe,
  getBundledPnpmCjs,
  preset,
  hooks
}) {
  let inFlight = false;

  async function installHotUpdateCore(targetVersion) {
    console.log('[hot-update] 开始更新 DSH 内核至 ' + targetVersion);
    hooks.killProcessTree();
    const nodeExe = getBundledNodeExe();
    const pnpmCjs = getBundledPnpmCjs();
    if (!nodeExe || !pnpmCjs) {
      throw new Error(t('error.hotUpdateNodeMissing'));
    }
    fs.mkdirSync(localRuntimeDir, { recursive: true });
    const pkgJsonPath = path.join(localRuntimeDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      fs.writeFileSync(
        pkgJsonPath,
        JSON.stringify({ name: 'dsh-local-hot-update', version: '0.0.0', private: true }, null, 2)
      );
    }
    hooks.setWindowProgress(t('dialog.progress.hotUpdateCore'));
    const corePackage = targetVersion
      ? `@deepseek-ai/dsh@${targetVersion}`
      : '@deepseek-ai/dsh@latest';
    const coreInstalled = await preset.runPnpmAdd(nodeExe, pnpmCjs, [corePackage]);
    if (!coreInstalled) {
      throw new Error(t('error.hotUpdateFailed'));
    }
    const markerFile = path.join(localRuntimeDir, '.broken-marker.json');
    if (fs.existsSync(markerFile)) {
      try { fs.unlinkSync(markerFile); } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
    }
    hooks.setForceBundledRuntime(false);
    hooks.resetLocalRuntimeBrokenUntil();
    const presetPluginNames = preset.readFactoryPresetPluginNames();
    if (presetPluginNames.length) {
      const added = preset.mergeLocalRuntimePresetDependencies(presetPluginNames);
      if (added.length) {
        hooks.setWindowProgress(t('dialog.progress.syncPresets', { count: presetPluginNames.length }));
        const pluginsInstalled = await preset.runPnpmAdd(nodeExe, pnpmCjs, added.map((name) => `${name}@*`));
        const missing = added.filter((name) => !preset.isPresetPluginInstalled(name));
        if (missing.length) {
          preset.pruneLocalRuntimeDependencies(missing);
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
    hooks.startDshBackend();
  }

  function cleanupOldBrokenRuntimeDirs(keepCount = 2) {
    try {
      const parent = path.dirname(localRuntimeDir);
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
    if (getPortableDataRoot()) return true;
    const exeDir = path.dirname(app.getPath('exe'));
    return fs.existsSync(path.join(exeDir, portableMarkerDir));
  }

  async function revertToFactoryRuntime() {
    hooks.setForceBundledRuntime(false);
    hooks.resetLocalRuntimeBrokenUntil();
    hooks.clearLocalRuntimeWatchdog();
    if (fs.existsSync(localRuntimeDir)) {
      try {
        fs.rmSync(localRuntimeDir, { recursive: true, force: true });
      } catch (err) {
        dialog.showMessageBox(getMainWindow(), {
          type: 'error',
          title: t('dialog.revert.failedTitle'),
          message: t('dialog.revert.failedMessage', { message: err.message })
        });
        return;
      }
    }
    cleanupOldBrokenRuntimeDirs(0);
    await hooks.restartWithCurrentConfig();
    const mainWindow = getMainWindow();
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
      await dialog.showMessageBox(getMainWindow(), {
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
    const response = await dialog.showMessageBox(getMainWindow(), {
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
    const mainWindow = getMainWindow();
    try {
      if (coreInfo.needsUpdate && options.updateCore) {
        hooks.setForceBundledRuntime(false);
        hooks.resetLocalRuntimeBrokenUntil();
        hooks.clearLocalRuntimeWatchdog();
        await installHotUpdateCore(remoteCore);
        cleanupOldBrokenRuntimeDirs(2);
      }

      if (shellInfo.needsUpdate && options.updateShell) {
        const release = await UPDATE_CHECK.checkReleaseAssets();
        if (!release) {
          dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: t('dialog.shellUpdate.unavailableTitle'),
            message: t('dialog.shellUpdate.unavailableMessage')
          });
          hooks.clearWindowProgress();
        } else {
          const installerName = resolveInstallerFileName(release.installerUrl);
          if (!installerName) {
            hooks.clearWindowProgress();
            dialog.showErrorBox(
              t('error.integrityCheckFailed'),
              t('error.integrityCheckFailedMessage', { reason: 'installer-name-rejected' })
            );
            return;
          }
          const installerDir = path.join(os.tmpdir(), 'dsh-shell-update');
          fs.mkdirSync(installerDir, { recursive: true });
          const installerPath = path.join(installerDir, installerName);
          hooks.setWindowProgress(t('dialog.progress.downloadShell', { percent: 0 }));
          await downloadWithProxies(release.installerUrl, installerPath, (percent) => {
            hooks.setWindowProgress(t('dialog.progress.downloadShell', { percent }));
          }, { proxies: UPDATE_CHECK.downloadProxies(), timeoutMs: UPDATE_CHECK.CONFIG.DOWNLOAD_TIMEOUT_MS });

          const integrity = verifyInstallerIntegrity(installerPath, release.sha256);
          if (!integrity.ok) {
            hooks.clearWindowProgress();
            dialog.showErrorBox(
              t('error.integrityCheckFailed'),
              t('error.integrityCheckFailedMessage', { reason: integrity.reason })
            );
            return;
          }

          if (isPortable()) {
            const folder = path.dirname(installerPath);
            shell.showItemInFolder(installerPath);
            hooks.clearWindowProgress();
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
              hooks.clearWindowProgress();
              return;
            }
            hooks.setWindowProgress(t('dialog.progress.launchInstaller'));
            hooks.killProcessTree();
            try {
              if (typeof app.releaseSingleInstanceLock === 'function') {
                app.releaseSingleInstanceLock();
              }
            } catch (lockErr) {
              console.warn(`[shell-update] 释放单实例锁失败: ${lockErr.message}`);
            }
            if (!/\.exe$/i.test(installerPath)) {
              dialog.showErrorBox(t('error.nsisInstallFailed'), 'refusing to run a non-exe installer');
              hooks.clearWindowProgress();
              return;
            }
            try {
              const installer = spawn(installerPath, [], { detached: true, stdio: 'ignore' });
              installer.unref();
            } catch (err) {
              dialog.showErrorBox(t('error.nsisInstallFailed'), String(err.message || err));
              hooks.clearWindowProgress();
              return;
            }
            hooks.clearWindowProgress();
            hooks.setQuitting();
            app.exit(0);
            return;
          }
        }
      }

      if (coreInfo.needsUpdate && options.updateCore) {
        const ready = await hooks.restartWithCurrentConfig();
        hooks.clearWindowProgress();
        if (ready) {
          await dialog.showMessageBox(getMainWindow(), {
            type: 'info',
            title: t('dialog.hotUpdate.successTitle'),
            message: t('dialog.hotUpdate.successMessage', { version: remoteCore }),
            detail: t('dialog.hotUpdate.successDetail')
          });
        } else {
          await dialog.showMessageBox(getMainWindow(), {
            type: 'warning',
            title: t('dialog.hotUpdate.notReadyTitle'),
            message: t('dialog.hotUpdate.notReadyMessage', { version: remoteCore }),
            detail: t('dialog.hotUpdate.notReadyDetail')
          });
        }
      }
    } catch (err) {
      hooks.clearWindowProgress();
      dialog.showErrorBox(t('error.autoUpdateFailed'), String(err.message || err));
    }
  }

  async function runUpdateCheck(silent = false) {
    if (inFlight) return;
    inFlight = true;
    try {
      const currentCore = getCurrentDshVersion();
      const currentShell = getShellVersion();
      const [remoteCore, remoteShell] = await Promise.all([
        UPDATE_CHECK.checkCoreVersion(),
        UPDATE_CHECK.checkShellVersion()
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
      inFlight = false;
    }
  }

  return {
    runUpdateCheck,
    revertToFactoryRuntime,
    cleanupOldBrokenRuntimeDirs,
    isPortable
  };
}

module.exports = { createUpdateFlow };
