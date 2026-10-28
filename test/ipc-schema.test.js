'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { IpcValidationError, schemas, assertValid, hasSchema } = require('../lib/ipc-schema');

const NO_ARG_CHANNELS = [
  'dsh:get-runtime-info',
  'dsh:get-backend-status',
  'dsh:get-plugin-inventory',
  'dsh:rehydrate-plugins',
  'dsh:create-worktree-dialog',
  'dsh:restart-safe-mode',
  'dsh:register-context-menu',
  'dsh:unregister-context-menu',
  'dsh:request-clipboard-paste',
  'dsh:get-auto-start',
  'dsh:get-workspace-status',
  'dsh:run-self-repair',
  'dsh:check-update'
];

const ALL_CHANNELS = [
  'dsh:native-notify',
  'dsh:set-always-on-top',
  'dsh:switch-engine',
  'dsh:set-auto-start',
  'dsh:convert-to-wsl-path',
  ...NO_ARG_CHANNELS
];

function expectInvalid(channel, payload, path) {
  assert.throws(
    () => assertValid(channel, payload),
    (err) => {
      assert.ok(err instanceof IpcValidationError, `expected IpcValidationError, got ${err}`);
      assert.strictEqual(err.name, 'IpcValidationError');
      assert.strictEqual(err.channel, channel);
      assert.strictEqual(err.path, path);
      assert.ok(err.message.includes(channel), `message should include channel: ${err.message}`);
      assert.ok(err.message.includes(path), `message should include field path ${path}: ${err.message}`);
      return true;
    }
  );
}

test('schemas: exposes a validator for every known channel', () => {
  for (const channel of ALL_CHANNELS) {
    assert.strictEqual(typeof schemas[channel], 'function', `missing validator for ${channel}`);
    assert.strictEqual(hasSchema(channel), true);
  }
  assert.strictEqual(Object.keys(schemas).length, ALL_CHANNELS.length);
});

test('hasSchema: rejects unknown channels and prototype keys', () => {
  assert.strictEqual(hasSchema('dsh:unknown'), false);
  assert.strictEqual(hasSchema(''), false);
  assert.strictEqual(hasSchema('constructor'), false);
  assert.strictEqual(hasSchema('__proto__'), false);
  assert.strictEqual(hasSchema('toString'), false);
});

test('assertValid: unknown channel throws IpcValidationError with channel and root path', () => {
  expectInvalid('dsh:unknown', undefined, '$');
  expectInvalid('dsh:unknown', { any: 'value' }, '$');
});

test('no-arg channels: accept undefined, null, and empty object', () => {
  for (const channel of NO_ARG_CHANNELS) {
    assert.doesNotThrow(() => assertValid(channel, undefined), `${channel} should accept undefined`);
    assert.doesNotThrow(() => assertValid(channel, null), `${channel} should accept null`);
    assert.doesNotThrow(() => assertValid(channel, {}), `${channel} should accept {}`);
  }
});

test('no-arg channels: reject non-empty objects with root path', () => {
  for (const channel of NO_ARG_CHANNELS) {
    expectInvalid(channel, { unexpected: true }, '$');
  }
});

test('no-arg channels: reject strings, numbers, booleans, and arrays', () => {
  for (const channel of NO_ARG_CHANNELS) {
    expectInvalid(channel, 'payload', '$');
    expectInvalid(channel, 0, '$');
    expectInvalid(channel, false, '$');
    expectInvalid(channel, [], '$');
  }
});

test('dsh:native-notify: accepts valid title and body at the size limits', () => {
  assert.doesNotThrow(() => assertValid('dsh:native-notify', { title: 'Build done', body: 'All checks passed' }));
  assert.doesNotThrow(() => assertValid('dsh:native-notify', { title: '', body: '' }));
  assert.doesNotThrow(() => assertValid('dsh:native-notify', { title: 'a'.repeat(100), body: 'b'.repeat(500) }));
  assert.doesNotThrow(() => assertValid('dsh:native-notify', { title: 't', body: 'b', extra: 'ignored' }));
});

test('dsh:native-notify: rejects non-object payload at root path', () => {
  expectInvalid('dsh:native-notify', undefined, '$');
  expectInvalid('dsh:native-notify', null, '$');
  expectInvalid('dsh:native-notify', 'notice', '$');
  expectInvalid('dsh:native-notify', ['notice'], '$');
});

test('dsh:native-notify: rejects missing or non-string title with title path', () => {
  expectInvalid('dsh:native-notify', { body: 'b' }, 'title');
  expectInvalid('dsh:native-notify', { title: 1, body: 'b' }, 'title');
  expectInvalid('dsh:native-notify', { title: null, body: 'b' }, 'title');
});

test('dsh:native-notify: rejects title longer than 100 characters with title path', () => {
  expectInvalid('dsh:native-notify', { title: 'a'.repeat(101), body: 'b' }, 'title');
});

test('dsh:native-notify: rejects missing or non-string body with body path', () => {
  expectInvalid('dsh:native-notify', { title: 't' }, 'body');
  expectInvalid('dsh:native-notify', { title: 't', body: 42 }, 'body');
  expectInvalid('dsh:native-notify', { title: 't', body: undefined }, 'body');
});

test('dsh:native-notify: rejects body longer than 500 characters with body path', () => {
  expectInvalid('dsh:native-notify', { title: 't', body: 'b'.repeat(501) }, 'body');
});

test('dsh:set-always-on-top: accepts only booleans', () => {
  assert.doesNotThrow(() => assertValid('dsh:set-always-on-top', true));
  assert.doesNotThrow(() => assertValid('dsh:set-always-on-top', false));
  expectInvalid('dsh:set-always-on-top', 'true', 'enable');
  expectInvalid('dsh:set-always-on-top', 1, 'enable');
  expectInvalid('dsh:set-always-on-top', undefined, 'enable');
  expectInvalid('dsh:set-always-on-top', null, 'enable');
  expectInvalid('dsh:set-always-on-top', {}, 'enable');
});

test('dsh:set-auto-start: accepts only booleans', () => {
  assert.doesNotThrow(() => assertValid('dsh:set-auto-start', true));
  assert.doesNotThrow(() => assertValid('dsh:set-auto-start', false));
  expectInvalid('dsh:set-auto-start', 'false', 'enable');
  expectInvalid('dsh:set-auto-start', 0, 'enable');
  expectInvalid('dsh:set-auto-start', undefined, 'enable');
  expectInvalid('dsh:set-auto-start', null, 'enable');
  expectInvalid('dsh:set-auto-start', [], 'enable');
});

test('dsh:switch-engine: accepts only win-native and wsl2', () => {
  assert.doesNotThrow(() => assertValid('dsh:switch-engine', 'win-native'));
  assert.doesNotThrow(() => assertValid('dsh:switch-engine', 'wsl2'));
  expectInvalid('dsh:switch-engine', 'docker', 'mode');
  expectInvalid('dsh:switch-engine', 'WSL2', 'mode');
  expectInvalid('dsh:switch-engine', '', 'mode');
  expectInvalid('dsh:switch-engine', undefined, 'mode');
  expectInvalid('dsh:switch-engine', 1, 'mode');
});

test('dsh:convert-to-wsl-path: accepts non-empty strings up to 32767 characters', () => {
  assert.doesNotThrow(() => assertValid('dsh:convert-to-wsl-path', 'C:\\Users\\dev\\project'));
  assert.doesNotThrow(() => assertValid('dsh:convert-to-wsl-path', '/mnt/c/Users/dev'));
  assert.doesNotThrow(() => assertValid('dsh:convert-to-wsl-path', 'a'.repeat(32767)));
});

test('dsh:convert-to-wsl-path: rejects empty, oversized, and non-string values', () => {
  expectInvalid('dsh:convert-to-wsl-path', '', 'windowsPath');
  expectInvalid('dsh:convert-to-wsl-path', 'a'.repeat(32768), 'windowsPath');
  expectInvalid('dsh:convert-to-wsl-path', undefined, 'windowsPath');
  expectInvalid('dsh:convert-to-wsl-path', null, 'windowsPath');
  expectInvalid('dsh:convert-to-wsl-path', 123, 'windowsPath');
  expectInvalid('dsh:convert-to-wsl-path', ['C:\\path'], 'windowsPath');
});
