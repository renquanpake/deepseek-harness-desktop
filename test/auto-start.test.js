'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { getAutoStart, setAutoStart } = require('../lib/auto-start');

test('getAutoStart: returns false when app is null or missing method', () => {
  assert.strictEqual(getAutoStart(null), false);
  assert.strictEqual(getAutoStart({}), false);
});

test('getAutoStart: returns openAtLogin boolean from app.getLoginItemSettings', () => {
  const mockAppTrue = {
    getLoginItemSettings: () => ({ openAtLogin: true })
  };
  assert.strictEqual(getAutoStart(mockAppTrue), true);

  const mockAppFalse = {
    getLoginItemSettings: () => ({ openAtLogin: false })
  };
  assert.strictEqual(getAutoStart(mockAppFalse), false);
});

test('getAutoStart: catches errors gracefully and returns false', () => {
  const throwingApp = {
    getLoginItemSettings: () => { throw new Error('Registry access denied'); }
  };
  assert.strictEqual(getAutoStart(throwingApp), false);
});

test('setAutoStart: sets openAtLogin with --hidden flag and updates status', () => {
  let recordedSettings = null;
  let currentState = false;

  const mockApp = {
    setLoginItemSettings: (opts) => {
      recordedSettings = opts;
      currentState = opts.openAtLogin;
    },
    getLoginItemSettings: () => ({ openAtLogin: currentState })
  };

  const enabledResult = setAutoStart(mockApp, true, 'C:\\custom\\app.exe');
  assert.strictEqual(enabledResult, true);
  assert.deepStrictEqual(recordedSettings, {
    openAtLogin: true,
    path: 'C:\\custom\\app.exe',
    args: ['--hidden']
  });

  const disabledResult = setAutoStart(mockApp, false, 'C:\\custom\\app.exe');
  assert.strictEqual(disabledResult, false);
  assert.deepStrictEqual(recordedSettings, {
    openAtLogin: false,
    path: 'C:\\custom\\app.exe',
    args: []
  });
});

test('setAutoStart: catches setter errors and returns current status without crashing', () => {
  const mockApp = {
    setLoginItemSettings: () => { throw new Error('Permission denied'); },
    getLoginItemSettings: () => ({ openAtLogin: false })
  };
  assert.strictEqual(setAutoStart(mockApp, true), false);
});
