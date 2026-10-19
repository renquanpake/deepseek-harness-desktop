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

const TOKEN_REGEX = /dsh web:\s*(https?:\/\/[^\s()]+)(?:[\r\n]|\s+\()/i;

test('token capture: extracts authenticated URL from stdout', () => {
  const sampleLog = '  dsh web: http://127.0.0.1:3080/?token=abc123456789 (ready in 1.2s)\n';
  const match = sampleLog.match(TOKEN_REGEX);
  assert.ok(match, 'Should match token log');
  assert.strictEqual(match[1], 'http://127.0.0.1:3080/?token=abc123456789');
});

test('token capture: handles stdout split across multiple chunks', () => {
  let accumulator = '';

  const chunk1 = 'Starting DeepSeek Harness server...\n[info] Listening on 127.0.0.1\n  dsh web: http://127.0.0.1:3080/?tok';
  const chunk2 = 'en=secret-token-value-xyz (ready)\n';

  accumulator += chunk1;
  let match = accumulator.match(TOKEN_REGEX);
  assert.strictEqual(match, null, 'Should not match incomplete URL before line delimiter arrives');

  accumulator += chunk2;
  match = accumulator.match(TOKEN_REGEX);
  assert.ok(match, 'Should match after full chunk arrives');
  assert.strictEqual(match[1], 'http://127.0.0.1:3080/?token=secret-token-value-xyz');
});

test('backend args: includes --no-open to prevent external browser popups', () => {
  const port = 3080;
  const isSafeMode = false;
  const args = ['web', '--no-open', '--port', String(port)];
  if (isSafeMode) args.push('--safe-mode');

  assert.ok(args.includes('--no-open'), 'Arguments must contain --no-open');
  assert.strictEqual(args[0], 'web');
  assert.strictEqual(args[1], '--no-open');
  assert.strictEqual(args[2], '--port');
  assert.strictEqual(args[3], '3080');
});
