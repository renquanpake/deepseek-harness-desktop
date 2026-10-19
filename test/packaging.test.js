'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('splash.html exists and is included in the packager file list', () => {
  const root = path.join(__dirname, '..');
  const splash = path.join(root, 'splash.html');
  assert.ok(fs.existsSync(splash), 'splash.html must exist at repo root');
  const html = fs.readFileSync(splash, 'utf8');
  assert.match(html, /DeepSeek Harness/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.build.files) && pkg.build.files.includes('splash.html'));
  assert.strictEqual(pkg.build.publish, null);
});
