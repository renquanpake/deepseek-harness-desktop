'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createClipboardBridge } = require('../src/clipboard');

function makeClipboard(overrides = {}) {
  return {
    readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    readText: () => '',
    ...overrides
  };
}

test('convertToWslMountPath trims and delegates, passes through empty input', () => {
  const bridge = createClipboardBridge({
    clipboard: makeClipboard(),
    getMainWindow: () => null,
    getPortableDataRoot: () => null,
    getEngine: () => 'win-native',
    isWindowsPlatform: () => false
  });
  assert.strictEqual(bridge.convertToWslMountPath(''), '');
  assert.strictEqual(bridge.convertToWslMountPath(null), null);
  assert.strictEqual(typeof bridge.convertToWslMountPath('C:\\Temp\\a.png'), 'string');
});

test('feedClipboardIntoEditor sends plain text when clipboard has text', () => {
  const sent = [];
  const bridge = createClipboardBridge({
    clipboard: makeClipboard({ readText: () => 'hello clipboard' }),
    getMainWindow: () => ({ webContents: { send: (ch, payload) => sent.push([ch, payload]) } }),
    getPortableDataRoot: () => null,
    getEngine: () => 'win-native',
    isWindowsPlatform: () => false
  });
  bridge.feedClipboardIntoEditor();
  assert.deepStrictEqual(sent, [['dsh:inject-clipboard-text', 'hello clipboard']]);
});

test('feedClipboardIntoEditor is a safe no-op without a window', () => {
  const bridge = createClipboardBridge({
    clipboard: makeClipboard({ readText: () => 'x' }),
    getMainWindow: () => null,
    getPortableDataRoot: () => null,
    getEngine: () => 'win-native',
    isWindowsPlatform: () => false
  });
  assert.doesNotThrow(() => bridge.feedClipboardIntoEditor());
});
