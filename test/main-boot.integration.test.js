'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('module');
const { EventEmitter } = require('node:events');

const BACKEND_URL = 'http://127.0.0.1:43210/';

function makeWebContents(state) {
  const contents = new EventEmitter();
  contents.send = (channel, ...args) => state.sent.push({ channel, args });
  contents.setWindowOpenHandler = (handler) => {
    state.openHandler = handler;
  };
  contents.getURL = () => state.loadURLs[state.loadURLs.length - 1] || '';
  contents.getType = () => 'window';
  contents.toggleDevTools = () => {};
  contents.flashFrame = () => {};
  return contents;
}

function buildFakeElectron(state, root) {
  const appEvents = new Map();
  const userDataDir = path.join(root, 'userdata');
  const fsPaths = { userData: userDataDir };

  function makeWindow(options) {
    const window = new EventEmitter();
    window.options = options;
    window.webContents = makeWebContents(state);
    window.loadURL = (url) => state.loadURLs.push(url);
    window.loadFile = (file) => state.loadFiles.push(file);
    window.setTitle = (title) => state.titles.push(title);
    window.isDestroyed = () => false;
    window.isMinimized = () => false;
    window.isVisible = () => true;
    window.isFocused = () => true;
    window.show = () => {};
    window.focus = () => {};
    window.hide = () => {};
    window.restore = () => {};
    window.flashFrame = () => {};
    window.setAlwaysOnTop = () => {};
    window.isAlwaysOnTop = () => false;
    state.window = window;
    return window;
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      const window = makeWindow(options);
      for (const event of ['on', 'once']) window[event] = EventEmitter.prototype[event].bind(window);
      return window;
    }

    static getAllWindows() {
      return state.window ? [state.window] : [];
    }
  }

  class FakeTray {
    setToolTip() {}
    setContextMenu(menu) {
      state.trayMenu = menu;
    }
    on() {}
    destroy() {}
  }

  const app = {
    whenReady: () => Promise.resolve(),
    getPath: (name) => {
      if (name === 'exe') return path.join(root, 'app', 'DeepSeek Harness.exe');
      return fsPaths[name] || path.join(root, name);
    },
    setPath: (name, value) => {
      fsPaths[name] = value;
    },
    getAppPath: () => process.cwd(),
    on: (event, handler) => appEvents.set(event, handler),
    quit: () => {
      state.quit += 1;
    },
    exit: () => {
      state.exit += 1;
    },
    relaunch: () => {},
    requestSingleInstanceLock: () => true,
    getVersion: () => '9.9.9',
    getLocale: () => 'zh-CN',
    isReady: () => true
  };

  return {
    state,
    appEvents,
    electron: {
      app,
      BrowserWindow: FakeBrowserWindow,
      Menu: {
        buildFromTemplate: (items) => {
          state.menus.push(items);
          return { items };
        },
        setApplicationMenu: () => {}
      },
      Tray: FakeTray,
      nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
      globalShortcut: {
        register: (accelerator) => {
          state.shortcuts.push(accelerator);
          return true;
        },
        unregisterAll: () => {}
      },
      ipcMain: {
        handle: (channel) => state.ipcHandles.push(channel),
        on: (channel) => state.ipcOns.push(channel)
      },
      Notification: class {
        static isSupported() {
          return false;
        }
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
        showItemInFolder: () => {}
      },
      dialog: {
        showMessageBox: async () => ({ response: 1 }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showErrorBox: () => {}
      },
      clipboard: {
        readText: () => '',
        readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })
      },
      protocol: {
        registerSchemesAsPrivileged: () => {},
        handle: () => {}
      },
      net: { fetch: async () => new Response('') },
      session: {
        defaultSession: {
          webRequest: {
            onHeadersReceived: (handler) => {
              state.cspHandler = handler;
            }
          },
          setPermissionRequestHandler: (handler) => {
            state.permissionRequest = handler;
          },
          setPermissionCheckHandler: (handler) => {
            state.permissionCheck = handler;
          }
        }
      }
    }
  };
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function bootMain(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-'));
  const state = {
    loadURLs: [],
    loadFiles: [],
    titles: [],
    sent: [],
    menus: [],
    shortcuts: [],
    ipcHandles: [],
    ipcOns: [],
    quit: 0,
    exit: 0,
    openHandler: null,
    cspHandler: null,
    permissionRequest: null,
    permissionCheck: null,
    window: null,
    trayMenu: null
  };
  const { electron, appEvents } = buildFakeElectron(state, root);

  const mainPath = require.resolve('../main.js');
  const originalLoad = Module._load;
  const originalEnv = {
    DSH_E2E: process.env.DSH_E2E,
    DSH_E2E_BACKEND_URL: process.env.DSH_E2E_BACKEND_URL
  };

  process.env.DSH_E2E = '1';
  process.env.DSH_E2E_BACKEND_URL = BACKEND_URL;

  delete require.cache[mainPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };

  let loaded = false;
  try {
    require(mainPath);
    loaded = true;
  } finally {
    Module._load = originalLoad;
  }

  t.after(() => {
    delete require.cache[mainPath];
    if (originalEnv.DSH_E2E === undefined) delete process.env.DSH_E2E;
    else process.env.DSH_E2E = originalEnv.DSH_E2E;
    if (originalEnv.DSH_E2E_BACKEND_URL === undefined) delete process.env.DSH_E2E_BACKEND_URL;
    else process.env.DSH_E2E_BACKEND_URL = originalEnv.DSH_E2E_BACKEND_URL;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.strictEqual(loaded, true);
  return { state, appEvents, root, userDataDir: path.join(root, 'userdata') };
}

test('main boots the e2e workspace, loads the backend and wires security', async (t) => {
  const harness = bootMain(t);
  const { state, userDataDir } = harness;

  const loaded = await waitFor(() => state.loadURLs.includes(BACKEND_URL));
  assert.strictEqual(loaded, true, 'backend url must be loaded after boot');
  assert.ok(state.loadFiles.some((file) => file.endsWith('splash.html')), 'splash must load first');
  assert.ok(state.titles.some((title) => title.includes('DeepSeek Harness')), 'window title must update');
  assert.strictEqual(state.window.options.webPreferences.contextIsolation, true);
  assert.strictEqual(state.window.options.webPreferences.sandbox, true);

  assert.strictEqual(typeof state.permissionRequest, 'function');
  assert.strictEqual(typeof state.permissionCheck, 'function');
  assert.strictEqual(typeof state.cspHandler, 'function');
  assert.ok(state.shortcuts.includes('Alt+Space'));
  assert.ok(state.ipcHandles.includes('dsh:get-runtime-info'));

  const recentFile = path.join(userDataDir, 'recent-workspaces.json');
  assert.strictEqual(fs.existsSync(recentFile), true, 'recent workspaces file must be written');
  const recents = JSON.parse(fs.readFileSync(recentFile, 'utf8'));
  assert.ok(recents.workspaces.length >= 1);

  assert.strictEqual(fs.existsSync(path.join(userDataDir, 'keybindings.json')), true);
  const operations = fs.readFileSync(path.join(userDataDir, 'logs', 'operations.jsonl'), 'utf8');
  assert.match(operations, /"type":"e2e-backend"/);

  const cspResult = state.cspHandler(
    { resourceType: 'mainFrame', url: BACKEND_URL, responseHeaders: {} },
    () => {}
  );
  void cspResult;
});

test('second instance switches workspace and records it', async (t) => {
  const harness = bootMain(t);
  const { state, appEvents, root } = harness;
  await waitFor(() => state.loadURLs.includes(BACKEND_URL));

  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-other-'));
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));

  const secondInstance = appEvents.get('second-instance');
  assert.strictEqual(typeof secondInstance, 'function');
  await secondInstance({}, ['node', 'main.js', '--open-dir', otherDir]);

  const recents = JSON.parse(
    fs.readFileSync(path.join(root, 'userdata', 'recent-workspaces.json'), 'utf8')
  );
  assert.ok(
    recents.workspaces.some((entry) => path.resolve(entry.path) === path.resolve(otherDir)),
    'the switched workspace must be recorded'
  );
});

test('tray quit goes through the e2e fast path and exits the app', async (t) => {
  const harness = bootMain(t);
  const { state, root } = harness;
  await waitFor(() => state.loadURLs.includes(BACKEND_URL));

  const file = path.join(root, 'userdata', 'logs', 'operations.jsonl');
  assert.strictEqual(fs.existsSync(file), true);

  const quitItem = findMenuItem(state.menus, (item) => item.label && item.label.includes('退出'));
  assert.ok(quitItem, 'application menu must expose a quit item');
  await quitItem.click();
  assert.strictEqual(state.quit, 1);
});

function findMenuItem(templates, predicate) {
  for (const template of templates) {
    for (const item of template) {
      if (predicate(item)) return item;
      if (item.submenu) {
        const nested = findMenuItem([item.submenu], predicate);
        if (nested) return nested;
      }
    }
  }
  return null;
}
