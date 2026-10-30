'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createCrashReporter, serializeError } = require('../lib/crash-reporter');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-crash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('serializeError keeps name, message and stack', () => {
  const error = new TypeError('boom');
  const serialized = serializeError(error);
  assert.strictEqual(serialized.name, 'TypeError');
  assert.strictEqual(serialized.message, 'boom');
  assert.match(serialized.stack, /TypeError: boom/);

  assert.deepStrictEqual(serializeError('plain'), { name: 'Error', message: 'plain', stack: '' });
  assert.strictEqual(serializeError({ code: 'E_FAIL' }).name, 'NonError');

  const circular = {};
  circular.self = circular;
  assert.strictEqual(serializeError(circular).message, '[object Object]');
});

test('capture writes a timestamped report with context', (t) => {
  const root = makeRoot(t);
  const reporter = createCrashReporter({
    dir: path.join(root, 'crash-reports'),
    appVersion: '0.2.1',
    now: () => Date.UTC(2026, 9, 29, 12, 0, 0)
  });

  const file = reporter.capture('renderer-gone', new Error('renderer died'), {
    reason: 'crashed',
    exitCode: 1
  });

  assert.strictEqual(file, path.join(root, 'crash-reports', 'crash-2026-10-29T12-00-00-000Z-renderer-gone.json'));
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(payload.kind, 'renderer-gone');
  assert.strictEqual(payload.appVersion, '0.2.1');
  assert.strictEqual(payload.reason, 'crashed');
  assert.strictEqual(payload.exitCode, 1);
  assert.strictEqual(payload.error.message, 'renderer died');
  assert.ok(payload.timestamp);
});

test('capture prunes reports beyond the retention limit', (t) => {
  const root = makeRoot(t);
  let tick = 0;
  const reporter = createCrashReporter({
    dir: root,
    maxReports: 3,
    now: () => Date.UTC(2026, 0, 1, 0, 0, tick++)
  });

  for (let index = 0; index < 7; index += 1) {
    reporter.capture('boom', new Error(`e${index}`));
  }

  const reports = reporter.listReports();
  assert.strictEqual(reports.length, 3);
  assert.strictEqual(reports[0], 'crash-2026-01-01T00-00-06-000Z-boom.json');
});

test('capture returns null instead of throwing when the disk write fails', (t) => {
  const root = makeRoot(t);
  const warnings = [];
  const reporter = createCrashReporter({
    dir: root,
    log: { warn: (message) => warnings.push(message), error: () => {} },
    fsImpl: {
      mkdirSync: () => {},
      writeFileSync: () => {
        throw new Error('EACCES');
      },
      readdirSync: () => [],
      unlinkSync: () => {}
    }
  });

  assert.strictEqual(reporter.capture('boom', new Error('x')), null);
  assert.strictEqual(warnings.length, 1);
});

test('installProcessHooks records uncaught exceptions, removes the listener and rethrows', (t) => {
  const root = makeRoot(t);
  const reporter = createCrashReporter({
    dir: root,
    log: { warn: () => {}, error: () => {} }
  });
  const target = new EventEmitter();
  const rethrown = [];
  reporter.installProcessHooks(target, { rethrow: (error) => rethrown.push(error) });

  const error = new Error('fatal');
  target.emit('uncaughtException', error);

  assert.strictEqual(target.listenerCount('uncaughtException'), 0);
  assert.strictEqual(rethrown[0], error);
  const reports = reporter.listReports();
  assert.strictEqual(reports.length, 1);
  assert.match(reports[0], /uncaught-exception\.json$/);
});

test('installProcessHooks records unhandled rejections', (t) => {
  const root = makeRoot(t);
  const reporter = createCrashReporter({
    dir: root,
    log: { warn: () => {}, error: () => {} }
  });
  const target = new EventEmitter();
  const rethrown = [];
  reporter.installProcessHooks(target, { rethrow: (reason) => rethrown.push(reason) });

  target.emit('unhandledRejection', 'promise failed');

  assert.strictEqual(rethrown[0], 'promise failed');
  const reports = reporter.listReports();
  assert.match(reports[0], /unhandled-rejection\.json$/);
});
