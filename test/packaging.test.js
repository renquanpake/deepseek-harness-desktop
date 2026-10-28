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

test('npm scripts expose python runtime preparation and keep dist order', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['runtime:prepare'], 'node prepare-runtime.js');
  assert.strictEqual(pkg.scripts['runtime:python'], 'node scripts/prepare-python-runtime.js');
  const preparePos = pkg.scripts.dist.indexOf('npm run runtime:prepare');
  assert.ok(preparePos >= 0, 'dist must run runtime:prepare');
  assert.ok(preparePos < pkg.scripts.dist.indexOf('electron-builder'), 'dist must prepare runtime before packaging');
});

test('prepare-runtime chains python prep as last optional step with allowFail', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'prepare-runtime.js'), 'utf8');
  assert.match(src, /node scripts\/prepare-python-runtime\.js/);
  assert.match(src, /--runtime-dir[\s\S]*RUNTIME_DIR[\s\S]*--manifest[\s\S]*PYTHON_MANIFEST_PATH/);
  assert.match(src, /ROOT_DIR,\s*true\s*\)/);
  assert.ok(
    src.indexOf('applyDirectoryPickerPatch') < src.indexOf('preparePythonRuntime();'),
    'python step must run after node runtime preparation'
  );
});

test('electron-builder ships python runtime dir when present and unpacks it with dsh-runtime', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { RUNTIME_SUBDIR } = require('../lib/python-runtime');
  const { parseArgs } = require('../scripts/prepare-python-runtime');
  const defaults = parseArgs([]);
  assert.strictEqual(defaults.manifest, path.join(root, 'build', 'runtime-manifest.json'));
  const runtimeRel = path.relative(root, defaults.runtimeDir).split(path.sep).join('/');
  assert.strictEqual(runtimeRel, 'dsh-runtime');
  const pythonGlob = `${runtimeRel}/${RUNTIME_SUBDIR}/**`;
  assert.ok(pkg.build.files.includes(pythonGlob), `build.files must include ${pythonGlob}`);
  assert.ok(
    pkg.build.asarUnpack.some(
      (pattern) => pattern === pythonGlob || pythonGlob.startsWith(pattern.replace('**', ''))
    ),
    'asarUnpack must cover the python runtime dir'
  );
});

test('prepare-python-runtime CLI creates the runtime subdir before installing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prepare-python-runtime.js'), 'utf8');
  assert.match(src, /mkdirSync\(path\.join\(options\.runtimeDir,\s*RUNTIME_SUBDIR\)/);
});
