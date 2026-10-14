const { test } = require('node:test');
const assert = require('node:assert');
const { decideRestart } = require('../lib/backend-lifecycle');

test('quitting: never restart and keep failures for teardown state', () => {
  const out = decideRestart({ isQuitting: true, killedByUs: false, code: 1, failures: 2 });
  assert.strictEqual(out.action, 'ignore');
  assert.strictEqual(out.failures, 2);
});

test('clean exit code 0 is not a crash', () => {
  const out = decideRestart({ isQuitting: false, killedByUs: false, code: 0, failures: 0 });
  assert.strictEqual(out.action, 'ignore');
});

test('killedByUs reset counter to 0 (menu restart does not crash-loop)', () => {
  const out = decideRestart({ isQuitting: false, killedByUs: true, code: null, failures: 4 });
  assert.strictEqual(out.action, 'ignore');
  assert.strictEqual(out.failures, 0);
});

test('crashes schedule exponential backoff until the cap', () => {
  assert.deepStrictEqual(decideRestart({ failures: 0 }), { action: 'restart', delayMs: 1500, failures: 1 });
  assert.deepStrictEqual(decideRestart({ failures: 3 }), { action: 'restart', delayMs: 12000, failures: 4 });
  assert.deepStrictEqual(decideRestart({ failures: 4 }), { action: 'restart', delayMs: 15000, failures: 5 });
});

test('restarts are capped: give up once at MAX_CRASH_RESTARTS', () => {
  const out = decideRestart({ failures: 5 });
  assert.strictEqual(out.action, 'give-up');
});

test('signal death counts as crash', () => {
  assert.strictEqual(decideRestart({ failures: 0, code: null }).action, 'restart');
});
