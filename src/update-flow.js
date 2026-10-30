'use strict';

const fs = require('fs');
const path = require('path');
const UPDATE_CHECK = require('../lib/update-check');
const { isNewer, decideUpdatePlan } = require('../lib/updater');
const {
  isVersionSupported,
  describeSupportRange,
  readDshVersion
} = require('../lib/dsh-adapter');
const { runContractCheck } = require('../lib/upstream-contract');

function createUpdateFlow({
  dialog,
  shell,
  getMainWindow,
  t,
  getCurrentDshVersion,
  getShellVersion,
  localRuntimeDir,
  getBundledNodeExe,
  getBundledPnpmCjs,
  preset,
  hooks,
  verifyRuntime = async (runtimeDir) => runContractCheck({
    runtimeDir,
    timeoutMs: 120_000,
    log: null
  })
}) {
  let inFlight = false;
  const lastGoodPath = path.join(path.dirname(localRuntimeDir), 'last-good-core.json');

  function readLastGood() {
    try {
      const parsed = JSON.parse(fs.readFileSync(lastGoodPath, 'utf8'));
      return parsed && typeof parsed.version === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeLastGood(version) {
    if (!version) return;
    try {
      fs.mkdirSync(path.dirname(lastGoodPath), { recursive: true });
      fs.writeFileSync(
        lastGoodPath,
        `${JSON.stringify({ version, verifiedAt: new Date().toISOString() }, null, 2)}\n`
      );
    } catch (err) {
      console.warn(`[hot-update] 写入 last-good 记录失败: ${err.message}`);
    }
  }

  async function restoreLastGood(nodeExe, pnpmCjs, lastGood) {
    try {
      fs.mkdirSync(localRuntimeDir, { recursive: true });
      const pkgJsonPath = path.join(localRuntimeDir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) {
        fs.writeFileSync(
          pkgJsonPath,
          JSON.stringify({ name: 'dsh-local-hot-update', version: '0.0.0', private: true }, null, 2)
        );
      }
      hooks.setWindowProgress(t('dialog.progress.restoreLastGood', { version: lastGood.version }));
      const restored = await preset.runPnpmAdd(nodeExe, pnpmCjs, [`@deepseek-ai/dsh@${lastGood.version}`]);
      if (!restored) {
        console.warn('[hot-update] last-good 版本恢复失败');
        return false;
      }
      hooks.setForceBundledRuntime(false);
      hooks.resetLocalRuntimeBrokenUntil();
      await hooks.restartWithCurrentConfig();
      return true;
    } catch (err) {
      console.warn(`[hot-update] 恢复 last-good 出错: ${err.message}`);
      return false;
    }
  }

  function quarantineLocalRuntime(reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const brokenPath = `${localRuntimeDir}.broken.${stamp}`;
    try {
      if (fs.existsSync(localRuntimeDir)) {
        fs.renameSync(localRuntimeDir, brokenPath);
        console.warn(`[hot-update] 内核验证失败，已隔离到 ${brokenPath}`);
        return brokenPath;
      }
    } catch (err) {
      console.warn(`[hot-update] 隔离失败，改写坏标记: ${err.message}`);
    }
    try {
      fs.mkdirSync(localRuntimeDir, { recursive: true });
      fs.writeFileSync(
        path.join(localRuntimeDir, '.broken-marker.json'),
        JSON.stringify({ brokenVersion: null, reason, at: new Date().toISOString() }, null, 2)
      );
    } catch (err) {
      console.warn(`[hot-update] 写入坏标记失败: ${err.message}`);
    }
    return null;
  }

  function describeVerdict(verdict) {
    if (!verdict || !Array.isArray(verdict.steps)) return 'unknown';
    const failed = verdict.steps.filter((step) => !step.ok);
    if (!failed.length) return 'unknown';
    return failed.map((step) => `${step.name}${step.detail ? ` (${step.detail})` : ''}`).join('; ');
  }

  async function installHotUpdateCore(targetVersion) {
    if (targetVersion && !isVersionSupported(targetVersion)) {
      throw new Error(
        t('error.hotUpdateUnsupported', {
          version: targetVersion,
          range: describeSupportRange()
        })
      );
    }
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
    hooks.setWindowProgress(t('dialog.progress.verifyCore'));
    const verdict = await verifyRuntime(localRuntimeDir);
    if (!verdict || !verdict.ok) {
      const reason = describeVerdict(verdict);
      const lastGood = readLastGood();
      quarantineLocalRuntime(reason);
      if (lastGood && lastGood.version && lastGood.version !== targetVersion) {
        const restored = await restoreLastGood(nodeExe, pnpmCjs, lastGood);
        if (restored) {
          throw new Error(t('error.hotUpdateRolledBackToLastGood', {
            version: lastGood.version,
            reason
          }));
        }
      }
      hooks.setForceBundledRuntime(true);
      hooks.resetLocalRuntimeBrokenUntil();
      await hooks.restartWithCurrentConfig();
      throw new Error(t('error.hotUpdateIncompatible', { reason }));
    }
    writeLastGood(targetVersion || readDshVersion(localRuntimeDir));

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
        const versionLabel = remoteShell || t('dialog.updateCheck.unknownVersion');
        const choice = await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: t('dialog.shellUpdate.manualTitle'),
          message: t('dialog.shellUpdate.manualMessage', { version: versionLabel }),
          detail: t('dialog.shellUpdate.manualDetail'),
          buttons: [t('dialog.shellUpdate.openRepo'), t('dialog.common.close')],
          defaultId: 0,
          cancelId: 1
        });
        if (choice.response === 0) {
          shell.openExternal(UPDATE_CHECK.CONFIG.REPO_URL);
        }
        hooks.clearWindowProgress();
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
      const coreSupported = remoteCore ? isVersionSupported(remoteCore) : true;
      if (remoteCore && !coreSupported) {
        console.warn(
          `[updater] 内核 ${remoteCore} 超出已验证范围 ${describeSupportRange()}，暂不提供热更新；请先更新外壳。`
        );
      }
      const effectiveRemoteCore = coreSupported ? remoteCore : null;
      const coreInfo = {
        current: currentCore.version,
        source: currentCore.source === 'hot-update' ? '热更新内核' : '内置出厂内核',
        needsUpdate: !!(effectiveRemoteCore && isNewer(effectiveRemoteCore, currentCore.version))
      };
      const shellInfo = {
        current: currentShell,
        needsUpdate: !!(remoteShell && isNewer(remoteShell, currentShell))
      };
      const plan = decideUpdatePlan({
        core: { currentVersion: currentCore.version, remoteVersion: effectiveRemoteCore },
        shell: { currentVersion: currentShell, remoteVersion: remoteShell }
      });
      if (plan.hasUpdate) {
        const options = await showUpdateCheckResult(true, coreInfo, shellInfo, effectiveRemoteCore, remoteShell);
        if (options) {
          await performAutoUpdate(coreInfo, shellInfo, effectiveRemoteCore, remoteShell, options);
        }
      } else if (!silent) {
        await showUpdateCheckResult(false, coreInfo, shellInfo, effectiveRemoteCore, remoteShell);
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    runUpdateCheck,
    revertToFactoryRuntime,
    cleanupOldBrokenRuntimeDirs
  };
}

module.exports = { createUpdateFlow };
