'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { schemas } = require('../lib/ipc-schema');

function buildFakeElectron(state) {
  const noop = () => {};
  const app = {
    whenReady: () => new Promise(() => {}),
    getPath: (name) => (name === 'exe' ? '/tmp/dsh-smoke/bin/deepseek-harness.exe' : '/tmp/dsh-smoke/userdata'),
    setPath: noop,
    getAppPath: () => process.cwd(),
    on: (channel, _fn) => {
      state.appEvents.push(channel);
    },
    quit: noop,
    exit: noop,
    relaunch: noop,
    requestSingleInstanceLock: () => true,
    getVersion: () => '0.0.0-smoke',
    getLocale: () => 'zh-CN',
    isReady: () => false
  };
  class FakeBrowserWindow {
    static getAllWindows() { return []; }
  }
  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: { buildFromTemplate: (items) => ({ items }), setApplicationMenu: noop },
    Tray: class {},
    nativeImage: { createFromPath: () => ({}) },
    globalShortcut: { register: () => true, unregisterAll: noop },
    ipcMain: {
      handle: (channel) => state.handleChannels.push(channel),
      on: (channel) => state.onChannels.push(channel)
    },
    Notification: class { static isSupported() { return false; } },
    shell: { openExternal: noop, showItemInFolder: noop, openPath: () => Promise.resolve() },
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showOpenDialog: async () => ({ canceled: true }),
      showErrorBox: noop
    },
    clipboard: { readText: () => '', readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
    protocol: {
      registerSchemesAsPrivileged: (schemes) => { state.privileges = schemes; },
      handle: (scheme) => state.protocolSchemes.push(scheme)
    },
    net: { fetch: () => Promise.reject(new Error('smoke')) }
  };
}

test('main.js loads under stub electron and registers every schema channel', () => {
  const state = {
    handleChannels: [],
    onChannels: [],
    appEvents: [],
    privileges: null,
    protocolSchemes: []
  };
  const electron = buildFakeElectron(state);
  const mainPath = require.resolve('../main.js');

  delete require.cache[mainPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(mainPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[mainPath];
  }

  const registered = new Set([...state.handleChannels, ...state.onChannels]);
  for (const channel of Object.keys(schemas)) {
    assert.ok(registered.has(channel), `ipc channel not registered: ${channel}`);
  }
  assert.ok(state.appEvents.includes('second-instance'));
  assert.ok(state.appEvents.includes('window-all-closed'));

  assert.ok(Array.isArray(state.privileges));
  const dshPriv = state.privileges.find((entry) => entry.scheme === 'dsh-app');
  assert.ok(dshPriv, 'dsh-app privileges must be registered at module load');
  assert.strictEqual(dshPriv.privileges.secure, true);
  assert.strictEqual(dshPriv.privileges.standard, true);
});
