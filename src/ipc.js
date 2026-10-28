'use strict';

const { assertValid } = require('../lib/ipc-schema');

const ON_REJECT_LABELS = {
  'dsh:native-notify': 'native-notify',
  'dsh:request-clipboard-paste': 'clipboard-paste'
};

const NO_ARG_CHANNELS = [
  'dsh:get-runtime-info',
  'dsh:get-backend-status',
  'dsh:get-plugin-inventory',
  'dsh:rehydrate-plugins',
  'dsh:create-worktree-dialog',
  'dsh:restart-safe-mode',
  'dsh:register-context-menu',
  'dsh:unregister-context-menu',
  'dsh:get-auto-start',
  'dsh:get-workspace-status',
  'dsh:run-self-repair',
  'dsh:check-update'
];

function createIpcGuard({ assertTrustedSender, log = console }) {
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
  const { guardPayload, wrapInvoke } = createIpcGuard({ assertTrustedSender, log });

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
