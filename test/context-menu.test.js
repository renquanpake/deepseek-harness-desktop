'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  contextMenuRegisterCommands,
  contextMenuUnregisterCommands,
  registerWindowsContextMenu,
  unregisterWindowsContextMenu
} = require('../lib/context-menu');

test('contextMenuRegisterCommands builds add commands for open and worktree entries', () => {
  const cmds = contextMenuRegisterCommands('C:\\Apps\\dsh.exe');
  assert.ok(Array.isArray(cmds));
  assert.ok(cmds.every((c) => c[0] === 'add'));
  const joined = cmds.map((c) => c.join(' ')).join('\n');
  assert.match(joined, /DSHStudioOpen/);
  assert.match(joined, /DSHStudioWorktree/);
  assert.match(joined, /--open-dir/);
  assert.match(joined, /--worktree-dir/);
  assert.match(joined, /C:\\Apps\\dsh\.exe/);
  assert.strictEqual(cmds.length, 12);
});

test('contextMenuUnregisterCommands issues delete for four roots', () => {
  const cmds = contextMenuUnregisterCommands();
  assert.strictEqual(cmds.length, 4);
  assert.ok(cmds.every((c) => c[0] === 'delete' && c[2] === '/f'));
});

test('registerWindowsContextMenu is a no-op on non-win32 platforms', () => {
  const res = registerWindowsContextMenu({ platform: 'linux', exePath: '/usr/bin/x' });
  assert.deepStrictEqual(res, { ok: 0, failed: 0, total: 0 });
  const un = unregisterWindowsContextMenu({ platform: 'linux' });
  assert.deepStrictEqual(un, { ok: 0, failed: 0, total: 0 });
});
