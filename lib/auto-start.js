'use strict';

function getAutoStart(appInstance) {
  if (!appInstance || typeof appInstance.getLoginItemSettings !== 'function') {
    return false;
  }
  try {
    const settings = appInstance.getLoginItemSettings();
    return Boolean(settings && settings.openAtLogin);
  } catch (err) {
    console.warn();
    return false;
  }
}

function setAutoStart(appInstance, enable, customPath) {
  if (!appInstance || typeof appInstance.setLoginItemSettings !== 'function') {
    return false;
  }
  const shouldEnable = Boolean(enable);
  try {
    const targetPath = customPath || (typeof process !== 'undefined' ? process.execPath : '');
    appInstance.setLoginItemSettings({
      openAtLogin: shouldEnable,
      path: targetPath,
      args: shouldEnable ? ['--hidden'] : []
    });
    return getAutoStart(appInstance);
  } catch (err) {
    console.warn();
    return getAutoStart(appInstance);
  }
}

module.exports = { getAutoStart, setAutoStart };
