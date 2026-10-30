'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createQuitConfirmation({
  dialog,
  t,
  getMainWindow,
  getBackendStatus,
  markerPath,
  fsImpl = fs,
  log = console
}) {
  let backgroundHideConfirmed = false;

  try {
    backgroundHideConfirmed = Boolean(markerPath && fsImpl.existsSync(markerPath));
  } catch {
    backgroundHideConfirmed = false;
  }

  function persistBackgroundHideConfirmation() {
    if (!markerPath) return;
    try {
      fsImpl.mkdirSync(path.dirname(markerPath), { recursive: true });
      fsImpl.writeFileSync(markerPath, `${new Date().toISOString()}\n`);
    } catch (err) {
      log.warn(`[quit] 写入后台隐藏确认标记失败: ${err.message}`);
    }
    backgroundHideConfirmed = true;
  }

  async function confirmBackgroundHide() {
    if (backgroundHideConfirmed) return true;
    const window = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!window) return true;
    let response;
    try {
      response = await dialog.showMessageBox(window, {
        type: 'info',
        title: t('dialog.backgroundClose.title'),
        message: t('dialog.backgroundClose.message'),
        detail: t('dialog.backgroundClose.detail'),
        buttons: [t('dialog.common.cancel'), t('dialog.backgroundClose.confirm')],
        defaultId: 1,
        cancelId: 0
      });
    } catch (err) {
      log.warn(`[quit] 后台隐藏确认弹窗失败: ${err.message}`);
      return false;
    }
    if (!response || response.response !== 1) return false;
    persistBackgroundHideConfirmation();
    return true;
  }

  function describeActivity(status) {
    const parts = [];
    if (status && status.engine) parts.push(status.engine);
    if (status && Number.isInteger(status.port)) parts.push(`127.0.0.1:${status.port}`);
    return parts.join(' · ');
  }

  async function confirmQuit() {
    let status = null;
    try {
      status = typeof getBackendStatus === 'function' ? getBackendStatus() : null;
    } catch (err) {
      log.warn(`[quit] 读取后端状态失败: ${err.message}`);
      status = null;
    }
    if (!status || !status.ready) return true;

    const window = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!window) return true;

    let response;
    try {
      response = await dialog.showMessageBox(window, {
        type: 'question',
        title: t('dialog.quitConfirm.title'),
        message: t('dialog.quitConfirm.message'),
        detail: t('dialog.quitConfirm.detail', { context: describeActivity(status) }),
        buttons: [t('dialog.quitConfirm.quit'), t('dialog.common.cancel')],
        defaultId: 1,
        cancelId: 1
      });
    } catch (err) {
      log.warn(`[quit] 退出确认弹窗失败: ${err.message}`);
      return false;
    }
    return Boolean(response) && response.response === 0;
  }

  return {
    confirmBackgroundHide,
    confirmQuit,
    isBackgroundHideConfirmed: () => backgroundHideConfirmed
  };
}

module.exports = { createQuitConfirmation };
