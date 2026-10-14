const { test } = require('node:test');
const assert = require('node:assert');
const { toWslPath } = require('../lib/win-utils');

test('toWslPath converts a drive-letter Windows path', () => {
  assert.strictEqual(toWslPath('C:\\Users\\me\\repo'), '/mnt/c/Users/me/repo');
});

test('toWslPath converts forward-slash drive path', () => {
  assert.strictEqual(toWslPath('D:/work/app'), '/mnt/d/work/app');
});

test('toWslPath lowercases drive letter', () => {
  assert.strictEqual(toWslPath('E:\\Repo'), '/mnt/e/Repo');
});

test('toWslPath passes through paths without a drive letter', () => {
  assert.strictEqual(toWslPath('\\\\server\\share\\x'), '//server/share/x');
});
