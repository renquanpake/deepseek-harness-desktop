const { test } = require('node:test');
const assert = require('node:assert');
const { runRegCommands } = require('../lib/win-reg');

test('runRegCommands counts partial failures', () => {
  const failed = [];
  const result = runRegCommands(
    ['a', 'b', 'c'],
    (cmd) => { if (cmd === 'b') throw new Error('reg denied'); },
    (cmd, err) => failed.push([cmd, err.message])
  );
  assert.strictEqual(result.ok, 2);
  assert.strictEqual(result.failed, 1);
  assert.deepStrictEqual(failed, [['b', 'reg denied']]);
});

test('runRegCommands all-fail returns ok 0', () => {
  const result = runRegCommands(['x'], () => { throw new Error('boom'); }, () => {});
  assert.strictEqual(result.ok, 0);
  assert.strictEqual(result.failed, 1);
});
