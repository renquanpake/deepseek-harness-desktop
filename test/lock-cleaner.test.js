'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanStaleLocks, isPidAlive } = require('../lib/lock-cleaner');

test('isPidAlive: correctly identifies current process as alive', () => {
  assert.strictEqual(isPidAlive(process.pid), true);
  assert.strictEqual(isPidAlive(null), false);
  assert.strictEqual(isPidAlive('abc'), false);
  assert.strictEqual(isPidAlive(-1), false);
  assert.strictEqual(isPidAlive(9999999), false);
});

test('cleanStaleLocks: unlinks locks with non-numeric or dead PIDs, preserves live PIDs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-test-'));

  try {
    const deadLock = path.join(tmpDir, 'dead.lock');
    const invalidLock = path.join(tmpDir, 'corrupt.lock');
    const liveLock = path.join(tmpDir, 'live.lock');
    const nonLockFile = path.join(tmpDir, 'important.txt');

    fs.writeFileSync(deadLock, '9999999');
    fs.writeFileSync(invalidLock, 'not-a-number');
    fs.writeFileSync(liveLock, String(process.pid));
    fs.writeFileSync(nonLockFile, 'keep me');

    const nodeModulesDir = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(nodeModulesDir);
    const nmLock = path.join(nodeModulesDir, 'nested.lock');
    fs.writeFileSync(nmLock, '9999999');

    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    const subDeadLock = path.join(subDir, 'subdead.lock');
    fs.writeFileSync(subDeadLock, '9999999');

    const cleaned = cleanStaleLocks(tmpDir);

    assert.strictEqual(cleaned, 3);
    assert.strictEqual(fs.existsSync(deadLock), false);
    assert.strictEqual(fs.existsSync(invalidLock), false);
    assert.strictEqual(fs.existsSync(subDeadLock), false);
    assert.strictEqual(fs.existsSync(liveLock), true);
    assert.strictEqual(fs.existsSync(nonLockFile), true);
    assert.strictEqual(fs.existsSync(nmLock), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cleanStaleLocks: returns 0 on non-existent directory without throwing', () => {
  const nonExistent = path.join(os.tmpdir(), 'non-existent-dir-' + Date.now());
  assert.strictEqual(cleanStaleLocks(nonExistent), 0);
});
