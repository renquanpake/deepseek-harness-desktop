'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { isCspViolationMessage, createCspViolationSink, MAX_MESSAGE_LENGTH } = require('../lib/csp-report');

test('isCspViolationMessage matches chromium csp console output only', () => {
  assert.strictEqual(
    isCspViolationMessage("Refused to load the script 'x' because it violates the following Content Security Policy directive"),
    true
  );
  assert.strictEqual(isCspViolationMessage('[Report Only] CSP violation in connect-src'), true);
  assert.strictEqual(isCspViolationMessage('Uncaught TypeError: x is not a function'), false);
  assert.strictEqual(isCspViolationMessage(null), false);
  assert.strictEqual(isCspViolationMessage(undefined), false);
});

test('sink appends matching messages and ignores unrelated ones', () => {
  const entries = [];
  const sink = createCspViolationSink({ append: (message) => entries.push(message), now: () => 0 });

  assert.strictEqual(sink.report('ordinary log line'), false);
  assert.strictEqual(sink.report('Content Security Policy: blocked inline script'), true);
  assert.deepStrictEqual(entries, ['Content Security Policy: blocked inline script']);
});

test('sink throttles identical messages inside the window and re-reports later', () => {
  let clock = 1000;
  const entries = [];
  const sink = createCspViolationSink({
    append: (message) => entries.push(message),
    throttleMs: 5000,
    now: () => clock
  });

  sink.report('CSP violation A');
  clock += 1000;
  sink.report('CSP violation A');
  clock += 1000;
  sink.report('CSP violation B');
  assert.deepStrictEqual(entries, ['CSP violation A', 'CSP violation B']);

  clock += 6000;
  sink.report('CSP violation A');
  assert.deepStrictEqual(entries, ['CSP violation A', 'CSP violation B', 'CSP violation A']);
});

test('sink truncates very long messages', () => {
  const entries = [];
  const sink = createCspViolationSink({ append: (message) => entries.push(message), now: () => 0 });

  sink.report(`Content Security Policy ${'x'.repeat(2000)}`);

  assert.strictEqual(entries[0].length, MAX_MESSAGE_LENGTH);
});

test('a failing append never throws', () => {
  const warnings = [];
  const sink = createCspViolationSink({
    append: () => {
      throw new Error('disk full');
    },
    now: () => 0,
    log: { warn: (message) => warnings.push(message) }
  });

  assert.strictEqual(sink.report('CSP violation'), true);
  assert.match(warnings[0], /disk full/);
});
