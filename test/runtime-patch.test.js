'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { applyDirectoryPickerPatch } = require('../scripts/patch-dsh-runtime');

test('applyDirectoryPickerPatch: returns false when target does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-empty-'));
  try {
    const res = applyDirectoryPickerPatch(tmpDir);
    assert.strictEqual(res, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('applyDirectoryPickerPatch: successfully patches koffi.view pattern and is idempotent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-test-'));
  try {
    const workerDir = path.join(
      tmpDir,
      'node_modules',
      '@deepseek-ai',
      'dsh-host-directory-picker-native',
      'lib'
    );
    fs.mkdirSync(workerDir, { recursive: true });
    const workerFile = path.join(workerDir, 'worker.cjs');

    const mockOldCode = `
const koffi = require("koffi");
function readUtf16(koffi, address) {
  const bytes = Buffer.from(koffi.view(address, 32768));
  let end = 0;
  while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;
  return bytes.toString("utf16le", 0, end);
}
module.exports = { readUtf16 };
`;
    fs.writeFileSync(workerFile, mockOldCode, 'utf8');

    // First run -> should patch
    const patchRes1 = applyDirectoryPickerPatch(tmpDir);
    assert.strictEqual(patchRes1, true);

    const patchedContent = fs.readFileSync(workerFile, 'utf8');
    assert.strictEqual(patchedContent.includes('koffi.view(address, 32768)'), false);
    assert.strictEqual(patchedContent.includes('lstrlenW'), true);
    assert.strictEqual(patchedContent.includes('memcpy'), true);

    // Second run -> idempotent, should return true without changing
    const patchRes2 = applyDirectoryPickerPatch(tmpDir);
    assert.strictEqual(patchRes2, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
