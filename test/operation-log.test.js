'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createOperationLog } = require('../lib/operation-log');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-op-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('append writes JSONL entries and creates the log directory', (t) => {
  const root = makeRoot(t);
  const dir = path.join(root, 'nested', 'logs');
  const log = createOperationLog({ dir, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });

  const entry = log.append('restart', { port: 3080 });

  assert.deepStrictEqual(entry, {
    ts: '2026-01-02T03:04:05.000Z',
    type: 'restart',
    port: 3080
  });
  const raw = fs.readFileSync(log.getFilePath(), 'utf8');
  assert.strictEqual(raw.trim().split('\n').length, 1);
  assert.deepStrictEqual(log.read(), [entry]);
});

test('read returns the most recent entries in order and skips corrupt lines', (t) => {
  const root = makeRoot(t);
  const log = createOperationLog({ dir: root, now: () => 0 });
  log.append('a', { n: 1 });
  fs.appendFileSync(log.getFilePath(), 'not-json\n');
  log.append('b', { n: 2 });
  log.append('c', { n: 3 });

  const entries = log.read(2);

  assert.deepStrictEqual(entries.map((entry) => entry.type), ['b', 'c']);
  assert.deepStrictEqual(log.read().map((entry) => entry.type), ['a', 'b', 'c']);
  assert.deepStrictEqual(log.read(0), []);
});

test('rotates the log when it exceeds the size budget and keeps archives', (t) => {
  const root = makeRoot(t);
  const log = createOperationLog({ dir: root, maxBytes: 120, maxArchives: 2, now: () => 0 });

  for (let index = 0; index < 12; index += 1) {
    log.append('tick', { index });
  }

  assert.ok(fs.existsSync(`${log.getFilePath()}.1`), 'first archive must exist');
  assert.ok(fs.statSync(log.getFilePath()).size < 400);
  const archived = fs.readFileSync(`${log.getFilePath()}.1`, 'utf8');
  assert.match(archived, /"type":"tick"/);
});

test('append rejects a missing type', (t) => {
  const root = makeRoot(t);
  const log = createOperationLog({ dir: root });
  assert.throws(() => log.append(''), TypeError);
});

test('read tolerates a missing file', (t) => {
  const root = makeRoot(t);
  const log = createOperationLog({ dir: path.join(root, 'absent') });
  assert.deepStrictEqual(log.read(), []);
});
