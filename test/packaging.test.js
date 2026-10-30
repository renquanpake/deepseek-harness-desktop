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

test('build config targets Windows only', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const winTargets = pkg.build.win.target.map((entry) => entry.target);
  assert.ok(winTargets.includes('nsis'), 'Windows must ship an NSIS installer');
  assert.deepStrictEqual(pkg.build.win.target[0].arch, ['x64']);
  assert.strictEqual(pkg.build.mac, undefined, 'macOS targets are out of scope');
  assert.strictEqual(pkg.build.linux, undefined, 'Linux targets are out of scope');
  assert.strictEqual(pkg.scripts['dist:mac'], undefined);
  assert.strictEqual(pkg.scripts['dist:linux'], undefined);
});

test('build workflow builds and verifies the Windows package', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'build.yml'),
    'utf8'
  );
  assert.match(workflow, /build-windows:/);
  assert.doesNotMatch(workflow, /build-macos:/);
  assert.doesNotMatch(workflow, /build-linux:/);
  assert.match(workflow, /verify-packaging\.js --asar dist\/win-unpacked\/resources\/app\.asar/);
  assert.match(workflow, /needs: \[ build-windows \]/);
});

test('splash.html ships a restrictive CSP and no remote assets', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'splash.html'), 'utf8');
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /(src|href)="https?:\/\//, 'splash.html must not load remote assets');
});

test('build.files covers every runtime entry required by the main process', () => {
  const { collectRequiredEntries, findUncoveredEntries } = require('../scripts/verify-packaging');
  const missing = findUncoveredEntries();
  assert.deepStrictEqual(
    missing.map((item) => item.entry),
    [],
    'build.files must ship every module and asset the shell loads at runtime'
  );
  const entries = collectRequiredEntries().map((item) => item.entry);
  assert.ok(entries.includes('src/ipc.js'), 'src/ modules must be treated as runtime requirements');
  assert.ok(entries.includes('locales'), 'locales must be treated as a runtime requirement');
});

test('build.files ships the src and locales directories', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('src/'), 'build.files must include src/');
  assert.ok(pkg.build.files.includes('locales/'), 'build.files must include locales/');
});

test('packaging coverage matcher handles directory, exact and glob patterns', () => {
  const { isCovered } = require('../scripts/verify-packaging');
  assert.ok(isCovered('src/ipc.js', ['src/']));
  assert.ok(isCovered('locales', ['locales/']));
  assert.ok(isCovered('splash.html', ['splash.html']));
  assert.ok(isCovered('dsh-runtime/python/x.py', ['dsh-runtime/python/**']));
  assert.strictEqual(isCovered('src/ipc.js', ['lib/', 'main.js']), false);
});
