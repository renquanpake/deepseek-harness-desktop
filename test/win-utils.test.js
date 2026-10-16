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

test('toWslPath wraps path with double quotes when spaces are present', () => {
  assert.strictEqual(toWslPath('C:\\Users\\John Doe\\Desktop\\clip.png'), '"/mnt/c/Users/John Doe/Desktop/clip.png"');
  assert.strictEqual(toWslPath('D:/my project/code/app.js'), '"/mnt/d/my project/code/app.js"');
});

test('toWslPath handles already quoted paths with spaces correctly without double quoting', () => {
  assert.strictEqual(toWslPath('"C:\\Users\\John Doe\\Desktop\\clip.png"'), '"/mnt/c/Users/John Doe/Desktop/clip.png"');
});
