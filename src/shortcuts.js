'use strict';

function createShortcutController({
  globalShortcut,
  loadBindings,
  toggleWindow,
  rebuildMenus,
  operationLog = { append: () => {} },
  warn = console.warn
}) {
  let bindings = null;

  function current() {
    if (!bindings) bindings = loadBindings();
    return bindings;
  }

  function getBindings() {
    return current().bindings;
  }

  function register() {
    const { relayShortcut, relayFallback } = getBindings();
    if (globalShortcut.register(relayShortcut, toggleWindow)) {
      return relayShortcut;
    }
    warn(`[main] Global shortcut ${relayShortcut} is occupied by the system; falling back to ${relayFallback}.`);
    if (globalShortcut.register(relayFallback, toggleWindow)) {
      return relayFallback;
    }
    warn(`[main] Global shortcut ${relayFallback} is also unavailable.`);
    return null;
  }

  function reload() {
    const loaded = loadBindings();
    bindings = loaded;
    try {
      globalShortcut.unregisterAll();
    } catch (err) {
      warn(`[main] 释放全局快捷键失败: ${err.message}`);
    }
    const registered = register();
    rebuildMenus();
    operationLog.append('keybindings-reload', {
      source: loaded.source,
      errors: loaded.errors ? loaded.errors.length : 0,
      registered
    });
    return { ...loaded, registered };
  }

  return { register, reload, getBindings };
}

module.exports = { createShortcutController };
