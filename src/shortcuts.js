'use strict';

const RELAY_SHORTCUT = 'Alt+Space';
const RELAY_FALLBACK = 'CommandOrControl+Alt+D';

function createShortcutController({ globalShortcut, toggleWindow, warn = console.warn }) {
  function register() {
    if (globalShortcut.register(RELAY_SHORTCUT, toggleWindow)) {
      return RELAY_SHORTCUT;
    }
    warn(`[main] Global shortcut ${RELAY_SHORTCUT} is occupied by the system; falling back to ${RELAY_FALLBACK}.`);
    if (globalShortcut.register(RELAY_FALLBACK, toggleWindow)) {
      return RELAY_FALLBACK;
    }
    warn(`[main] Global shortcut ${RELAY_FALLBACK} is also unavailable.`);
    return null;
  }

  return { register };
}

module.exports = { createShortcutController, RELAY_SHORTCUT, RELAY_FALLBACK };
