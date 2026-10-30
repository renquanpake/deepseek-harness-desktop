'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkspaceStore } = require('../lib/workspace-store');

function makeStore(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
  const store = createWorkspaceStore({
    filePath: path.join(root, 'recent-workspaces.json'),
    now: () => {
      const value = clock;
      clock += 1000;
      return value;
    },
    log: { warn: () => {} },
    ...options
  });
  return { store, root };
}

test('touch adds a workspace and list returns newest first', (t) => {
  const { store } = makeStore(t);

  store.touch('/work/alpha');
  const entries = store.touch('/work/beta');

  assert.deepStrictEqual(entries.map((entry) => entry.name), ['beta', 'alpha']);
  assert.ok(path.isAbsolute(entries[0].path));
  assert.ok(entries[0].lastOpenedAt);
});

test('touch on an existing workspace moves it to the top without duplicating', (t) => {
  const { store } = makeStore(t);
  store.touch('/work/alpha');
  store.touch('/work/beta');
  const entries = store.touch('/work/alpha');

  assert.deepStrictEqual(entries.map((entry) => entry.name), ['alpha', 'beta']);
  assert.strictEqual(entries.length, 2);
});

test('duplicate paths are matched case-insensitively on windows', (t) => {
  const { store } = makeStore(t, { platform: 'win32', pathImpl: path.win32 });
  store.touch('C:\\Work\\Alpha');
  const entries = store.touch('c:\\work\\alpha\\');

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].path, 'C:\\Work\\Alpha');
});

test('the store keeps at most maxEntries and drops the oldest', (t) => {
  const { store } = makeStore(t, { maxEntries: 3 });
  store.touch('/work/a');
  store.touch('/work/b');
  store.touch('/work/c');
  const entries = store.touch('/work/d');

  assert.deepStrictEqual(entries.map((entry) => entry.name), ['d', 'c', 'b']);
});

test('remove drops only the matching workspace', (t) => {
  const { store } = makeStore(t);
  store.touch('/work/alpha');
  store.touch('/work/beta');

  const entries = store.remove('/work/alpha');
  assert.deepStrictEqual(entries.map((entry) => entry.name), ['beta']);

  const untouched = store.remove('/work/missing');
  assert.deepStrictEqual(untouched.map((entry) => entry.name), ['beta']);
});

test('clear empties the list', (t) => {
  const { store } = makeStore(t);
  store.touch('/work/alpha');
  assert.deepStrictEqual(store.clear(), []);
  assert.deepStrictEqual(store.list(), []);
});

test('a corrupt file falls back to an empty list and survives the next write', (t) => {
  const { store } = makeStore(t);
  fs.writeFileSync(store.getFilePath(), '{ not json');
  assert.deepStrictEqual(store.list(), []);

  const entries = store.touch('/work/alpha');
  assert.strictEqual(entries.length, 1);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(store.getFilePath(), 'utf8')));
});

test('invalid persisted entries are dropped on read', (t) => {
  const { store } = makeStore(t);
  fs.mkdirSync(path.dirname(store.getFilePath()), { recursive: true });
  fs.writeFileSync(
    store.getFilePath(),
    JSON.stringify({
      version: 1,
      workspaces: [
        { path: '/work/valid', name: 'valid', lastOpenedAt: '2026-01-01T00:00:00.000Z' },
        { path: 'relative/path', name: 'bad' },
        { name: 'no-path' },
        null
      ]
    })
  );

  const entries = store.list();
  assert.deepStrictEqual(entries.map((entry) => entry.name), ['valid']);
});

test('write failures are reported but never throw', () => {
  const warnings = [];
  const store = createWorkspaceStore({
    filePath: '/tmp/unused/recent.json',
    fsImpl: {
      readFileSync: () => {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
      },
      mkdirSync: () => {},
      writeFileSync: () => {
        throw new Error('EACCES');
      },
      renameSync: () => {}
    },
    log: { warn: (message) => warnings.push(message) }
  });

  const entries = store.touch('/work/alpha');
  assert.strictEqual(entries.length, 1);
  assert.match(warnings[0], /EACCES/);
});

test('touch ignores empty input', (t) => {
  const { store } = makeStore(t);
  assert.deepStrictEqual(store.touch(''), []);
});
