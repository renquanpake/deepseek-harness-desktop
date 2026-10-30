'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPortableLayout, DEFAULT_MARKER_DIR } = require('../src/portable-paths');

function makeApp(root, exeName = 'DeepSeek Harness.exe') {
  const paths = {};
  return {
    paths,
    getPath: (name) => (name === 'exe' ? path.join(root, 'exe', exeName) : paths[name]),
    setPath: (name, value) => {
      paths[name] = value;
    }
  };
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-portable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'exe'), { recursive: true });
  return root;
}

test('falls back to the user home dsh directory without a portable marker', (t) => {
  const root = makeRoot(t);
  const app = makeApp(root);
  const layout = createPortableLayout({ app, env: {}, log: { warn: () => {} } });

  const home = layout.resolveDshHome();

  assert.strictEqual(path.basename(home), '.dsh');
  assert.strictEqual(layout.isPortable(), false);
  assert.strictEqual(layout.getDataRoot(), null);
  assert.deepStrictEqual(layout.buildEnvOverlay(), {});
});

test('activates portable layout when the marker directory exists next to the exe', (t) => {
  const root = makeRoot(t);
  const marker = path.join(root, 'exe', DEFAULT_MARKER_DIR);
  fs.mkdirSync(marker, { recursive: true });
  const app = makeApp(root);
  const layout = createPortableLayout({ app, env: {}, log: { warn: () => {} } });

  const home = layout.resolveDshHome();

  assert.strictEqual(home, path.join(marker, '.dsh'));
  assert.strictEqual(layout.isPortable(), true);
  assert.strictEqual(layout.getDataRoot(), marker);
  for (const dir of ['appdata-roaming', 'appdata-local', 'userprofile', 'home', 'temp-captures']) {
    assert.ok(fs.existsSync(path.join(marker, dir)), `${dir} must be created`);
  }
  assert.strictEqual(app.paths.userData, path.join(marker, 'electron-userdata'));

  const overlay = layout.buildEnvOverlay();
  assert.strictEqual(overlay.HOME, path.join(marker, 'home'));
  assert.strictEqual(overlay.USERPROFILE, path.join(marker, 'userprofile'));
  assert.strictEqual(overlay.APPDATA, path.join(marker, 'appdata-roaming'));
});

test('creates the portable marker when the launcher declares a portable directory', (t) => {
  const root = makeRoot(t);
  const declared = path.join(root, 'declared');
  fs.mkdirSync(declared, { recursive: true });
  const app = makeApp(root);
  const layout = createPortableLayout({
    app,
    env: { PORTABLE_EXECUTABLE_DIR: declared },
    log: { warn: () => {} }
  });

  layout.resolveDshHome();

  assert.strictEqual(layout.getDataRoot(), path.join(declared, DEFAULT_MARKER_DIR));
  assert.ok(fs.existsSync(path.join(declared, DEFAULT_MARKER_DIR)));
});

test('git config is copied into the portable home on windows only', (t) => {
  const root = makeRoot(t);
  const home = path.join(root, 'userhome');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = dev\n');
  const marker = path.join(root, 'exe', DEFAULT_MARKER_DIR);
  fs.mkdirSync(path.join(marker, 'home'), { recursive: true });
  const app = makeApp(root);
  const homedir = () => home;

  const winLayout = createPortableLayout({
    app,
    env: {},
    platform: 'win32',
    homedir,
    log: { warn: () => {} }
  });
  winLayout.resolveDshHome();
  const portableGitConfig = path.join(marker, 'home', '.gitconfig');
  assert.ok(fs.existsSync(portableGitConfig));
  assert.match(fs.readFileSync(portableGitConfig, 'utf8'), /\[include\]/);
  assert.ok(!fs.readFileSync(portableGitConfig, 'utf8').includes('\\'));

  fs.rmSync(portableGitConfig);
  const posixLayout = createPortableLayout({
    app,
    env: {},
    platform: 'linux',
    homedir,
    log: { warn: () => {} }
  });
  posixLayout.resolveDshHome();
  assert.strictEqual(fs.existsSync(portableGitConfig), false);
});

test('non-portable dsh home follows the injected user home', (t) => {
  const root = makeRoot(t);
  const home = path.join(root, 'userhome');
  const layout = createPortableLayout({
    app: makeApp(root),
    env: {},
    homedir: () => home,
    log: { warn: () => {} }
  });
  assert.strictEqual(layout.resolveDshHome(), path.join(home, '.dsh'));
});
