'use strict';

const { assertValid, NO_ARG_CHANNELS: SCHEMA_NO_ARG_CHANNELS } = require('../lib/ipc-schema');

const ON_REJECT_LABELS = {
  'dsh:native-notify': 'native-notify',
  'dsh:request-clipboard-paste': 'clipboard-paste'
};

// 无参通道以 lib/ipc-schema.js 中的校验器为准，这里只排除走 ipcMain.on 的通道
const NO_ARG_CHANNELS = SCHEMA_NO_ARG_CHANNELS.filter(
  (channel) => !Object.prototype.hasOwnProperty.call(ON_REJECT_LABELS, channel)
);

function createIpcGuard({ assertTrustedSender }) {
  function guardPayload(channel, payload) {
    assertValid(channel, payload);
  }

  function wrapInvoke(channel, action, payloadOf = (p) => p) {
    return async (event, payload) => {
      assertTrustedSender(event);
      guardPayload(channel, payloadOf(payload));
      return action(payload);
    };
  }

  return { guardPayload, wrapInvoke };
}

function registerIpcHandlers({ ipcMain, assertTrustedSender, actions, log = console }) {
  const { guardPayload, wrapInvoke } = createIpcGuard({ assertTrustedSender });

  ipcMain.on('dsh:native-notify', (event, payload) => {
    try {
      assertTrustedSender(event);
      guardPayload('dsh:native-notify', payload);
    } catch (err) {
      log.warn(`[ipc] ${ON_REJECT_LABELS['dsh:native-notify']} rejected: ${err.message}`);
      return;
    }
    actions.nativeNotify(payload);
  });

  ipcMain.on('dsh:request-clipboard-paste', (event) => {
    try {
      assertTrustedSender(event);
      guardPayload('dsh:request-clipboard-paste', undefined);
    } catch (err) {
      log.warn(`[ipc] ${ON_REJECT_LABELS['dsh:request-clipboard-paste']} rejected: ${err.message}`);
      return;
    }
    actions.requestClipboardPaste();
  });

  const PARAM_CHANNELS = [
    'dsh:set-always-on-top',
    'dsh:switch-engine',
    'dsh:set-auto-start',
    'dsh:convert-to-wsl-path'
  ];

  for (const channel of NO_ARG_CHANNELS) {
    const action = actions[channel];
    if (typeof action !== 'function') {
      throw new TypeError(`missing ipc action for channel ${channel}`);
    }
    ipcMain.handle(channel, wrapInvoke(channel, action));
  }

  for (const channel of PARAM_CHANNELS) {
    const action = actions[channel];
    if (typeof action !== 'function') {
      throw new TypeError(`missing ipc action for channel ${channel}`);
    }
    ipcMain.handle(channel, wrapInvoke(channel, action));
  }
}

module.exports = { registerIpcHandlers, createIpcGuard, NO_ARG_CHANNELS, ON_REJECT_LABELS };
