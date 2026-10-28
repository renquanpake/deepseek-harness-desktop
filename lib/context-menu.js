'use strict';

const { runRegCommands } = require('./win-reg');
const { runReg } = require('./secure-exec');

const CONTEXT_MENU_COMMAND_KEY_BG = 'HKCU\\Software\\Classes\\Directory\\Background\\shell';
const CONTEXT_MENU_COMMAND_KEY_DIR = 'HKCU\\Software\\Classes\\Directory\\shell';

function contextMenuRegisterCommands(exePath) {
  return [
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen`, '/ve', '/d', 'Open with DeepSeek Harness Studio', '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen`, '/v', 'Icon', '/d', `"${exePath}"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen\\command`, '/ve', '/d', `"${exePath}" --open-dir "%V%"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen`, '/ve', '/d', 'Open with DeepSeek Harness Studio', '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen`, '/v', 'Icon', '/d', `"${exePath}"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen\\command`, '/ve', '/d', `"${exePath}" --open-dir "%1"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree`, '/ve', '/d', 'Open in New Git Worktree (DSH Studio)', '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree`, '/v', 'Icon', '/d', `"${exePath}"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree\\command`, '/ve', '/d', `"${exePath}" --worktree-dir "%V%"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree`, '/ve', '/d', 'Open in New Git Worktree (DSH Studio)', '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree`, '/v', 'Icon', '/d', `"${exePath}"`, '/f'],
    ['add', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree\\command`, '/ve', '/d', `"${exePath}" --worktree-dir "%1"`, '/f']
  ];
}

function contextMenuUnregisterCommands() {
  return [
    ['delete', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioOpen`, '/f'],
    ['delete', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioOpen`, '/f'],
    ['delete', `${CONTEXT_MENU_COMMAND_KEY_BG}\\DSHStudioWorktree`, '/f'],
    ['delete', `${CONTEXT_MENU_COMMAND_KEY_DIR}\\DSHStudioWorktree`, '/f']
  ];
}

const regSync = (args) => runReg(args);
const warnReg = (cmd, err) => console.warn(`[reg-menu] Skipped key: ${cmd}\nReason: ${err.message}`);

function registerWindowsContextMenu({ platform = process.platform, exePath = process.execPath } = {}) {
  if (platform !== 'win32') {
    return { ok: 0, failed: 0, total: 0 };
  }
  return runRegCommands(contextMenuRegisterCommands(exePath), regSync, warnReg);
}

function unregisterWindowsContextMenu({ platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return { ok: 0, failed: 0, total: 0 };
  }
  return runRegCommands(contextMenuUnregisterCommands(), regSync, warnReg);
}

module.exports = {
  contextMenuRegisterCommands,
  contextMenuUnregisterCommands,
  registerWindowsContextMenu,
  unregisterWindowsContextMenu
};
