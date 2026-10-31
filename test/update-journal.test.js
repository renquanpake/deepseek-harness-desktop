'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUpdateJournal, markInterruptedRuntime, EVENTS } = require('../lib/update-journal');

function makeJournal(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
  const journal = createUpdateJournal({
    dir: path.join(root, 'journal'),
    now: () => {
      const value = clock;
      clock += 1000;
      return value;
    },
    log: { warn: () => {} },
    ...options
  });
  return { journal, root };
}

test('records events with sequence and timestamp, filtering unknown fields', (t) => {
  const { journal } = makeJournal(t);

  journal.record('install-start', { version: '0.2.1', reason: 'manual', secret: 'nope' });
  journal.record('promote', { version: '0.2.1' });

  const entries = journal.read();
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].seq, 0);
  assert.strictEqual(entries[0].event, 'install-start');
  assert.strictEqual(entries[0].version, '0.2.1');
  assert.strictEqual(entries[0].secret, undefined);
  assert.ok(entries[0].at.startsWith('2026-01-01'));
  assert.strictEqual(entries[1].event, 'promote');
});

test('reason is truncated and events are validated', (t) => {
  const { journal } = makeJournal(t);
  journal.record('verify-failed', { reason: 'x'.repeat(500) });
  assert.strictEqual(journal.last().reason.length, 160);
  assert.throws(() => journal.record('not-an-event'), TypeError);
});

test('interruption is detected only after a non-terminal install step', (t) => {
  const { journal } = makeJournal(t);
  assert.strictEqual(journal.isInterrupted(), false);

  journal.record('install-start', { version: '0.2.1' });
  assert.strictEqual(journal.isInterrupted(), true);

  journal.record('verify-ok', { version: '0.2.1' });
  assert.strictEqual(journal.isInterrupted(), true);

  journal.record('promote', { version: '0.2.1' });
  assert.strictEqual(journal.isInterrupted(), false);

  journal.record('install-start', { version: '0.2.2' });
  journal.record('restore', { version: '0.2.1' });
  assert.strictEqual(journal.isInterrupted(), false);
});

test('corrupt lines are skipped and read honours the limit', (t) => {
  const { journal } = makeJournal(t);
  journal.record('check-start');
  fs.appendFileSync(journal.getFilePath(), '{not json\n');
  journal.record('check-done');

  assert.deepStrictEqual(journal.read().map((entry) => entry.event), ['check-start', 'check-done']);
  assert.strictEqual(journal.read(1).length, 1);
  assert.deepStrictEqual(journal.read(0), []);
});

test('write failures are reported without throwing', () => {
  const warnings = [];
  const journal = createUpdateJournal({
    dir: '/tmp/unused-update-journal',
    fsImpl: {
      mkdirSync: () => {},
      appendFileSync: () => {
        throw new Error('EACCES');
      },
      readFileSync: () => ''
    },
    log: { warn: (message) => warnings.push(message) }
  });

  assert.doesNotThrow(() => journal.record('check-start'));
  assert.match(warnings[0], /EACCES/);
});

test('markInterruptedRuntime writes a broken marker only when the runtime exists', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-mark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'local-runtime');

  assert.strictEqual(markInterruptedRuntime({ runtimeDir, log: { warn: () => {} } }), false);

  fs.mkdirSync(runtimeDir, { recursive: true });
  assert.strictEqual(markInterruptedRuntime({ runtimeDir, log: { warn: () => {} } }), true);
  const marker = JSON.parse(fs.readFileSync(path.join(runtimeDir, '.broken-marker.json'), 'utf8'));
  assert.strictEqual(marker.reason, 'interrupted-update');
});

test('the event list stays explicit', () => {
  assert.deepStrictEqual([...EVENTS].sort(), [
    'check-done',
    'check-start',
    'factory-fallback',
    'install-start',
    'promote',
    'restore',
    'verify-failed',
    'verify-ok'
  ]);
});
