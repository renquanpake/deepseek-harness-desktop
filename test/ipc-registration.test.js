'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers, NO_ARG_CHANNELS } = require('../src/ipc');

const PARAM_CHANNELS = [
  'dsh:set-always-on-top',
  'dsh:switch-engine',
  'dsh:set-auto-start',
  'dsh:convert-to-wsl-path'
];
const ON_CHANNELS = ['dsh:native-notify', 'dsh:request-clipboard-paste'];

const ALL_CHANNELS = [...NO_ARG_CHANNELS, ...PARAM_CHANNELS];

function makeFixtures(overrides = {}) {
  const handles = new Map();
  const ons = new Map();
  const logs = [];
  const actions = {};
  for (const channel of NO_ARG_CHANNELS) actions[channel] = () => `result:${channel}`;
  for (const channel of PARAM_CHANNELS) {
    actions[channel] = (payload) =>({ channel, payload, echo: overrides.echo });
  }
  let notifyCalled = null;
  let pasteCalled = 0;
  actions.nativeNotify = (p) => { notifyCalled = p; };
  actions.requestClipboardPaste = () => { pasteCalled += 1; };
  if (overrides.missing) delete actions[overrides.missing];

  const ipcMain = {
    handle: (channel, fn) => handles.set(channel, fn),
    on: (channel, fn) => ons.set(channel, fn)
  };
  const trusted = overrides.untrusted ? () => { throw new Error('Untrusted IPC sender: x'); } : () => {};
  registerIpcHandlers({
    ipcMain,
    assertTrustedSender: trusted,
    actions,
    log: { warn: (m) => logs.push(m) }
  });
  return { handles, ons, logs, actions, notifyResult: () => notifyCalled, pasteCount: () => pasteCalled };
}

test('registerIpcHandlers wires every inbound channel exactly once', () => {
  const { handles, ons } = makeFixtures();
  assert.deepStrictEqual([...handles.keys()].sort(), ALL_CHANNELS.slice().sort());
  assert.deepStrictEqual([...ons.keys()].sort(), ON_CHANNELS.slice().sort());
});

test('missing action for a channel throws at registration time', () => {
  assert.throws(
    () => makeFixtures({ missing: 'dsh:check-update' }),
    /missing ipc action for channel dsh:check-update/
  );
});

test('invoke wrappers enforce sender trust and schema', async () => {
  const { handles } = makeFixtures({ untrusted: true });
  await assert.rejects(handles.get('dsh:get-runtime-info')({}), /Untrusted IPC sender/);
});

test('no-arg channels reject unexpected payloads', async () => {
  const { handles } = makeFixtures();
  await assert.rejects(
    handles.get('dsh:get-runtime-info')({}, { injected: true }),
    /dsh:get-runtime-info/
  );
  const value = await handles.get('dsh:get-runtime-info')({});
  assert.strictEqual(value, 'result:dsh:get-runtime-info');
});

test('param channels validate their payloads', async () => {
  const { handles } = makeFixtures({ echo: true });
  await assert.rejects(handles.get('dsh:switch-engine')({}, 'bogus'), /expected one of/);
  const res = await handles.get('dsh:switch-engine')({}, 'wsl2');
  assert.strictEqual(res.payload, 'wsl2');
  await assert.rejects(handles.get('dsh:convert-to-wsl-path')({}, ''), /non-empty string/);
  await assert.rejects(handles.get('dsh:set-always-on-top')({}, 'yes'), /expected a boolean/);
});

test('on channels warn and skip action on invalid payload', () => {
  const { ons, logs, notifyResult, pasteCount } = makeFixtures();
  const ev = {};
  ons.get('dsh:native-notify')(ev, { title: 'x'.repeat(200), body: 'b' });
  assert.strictEqual(notifyResult(), null);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /\[ipc\] native-notify rejected:/);
  const good = { title: 'ok', body: 'body' };
  ons.get('dsh:native-notify')(ev, good);
  assert.deepStrictEqual(notifyResult(), good);
  ons.get('dsh:request-clipboard-paste')(ev);
  assert.strictEqual(pasteCount(), 1);
});
