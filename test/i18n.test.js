'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createI18n, normalizeLocale } = require('../lib/i18n');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');

function flattenKeys(value, prefix = '', out = []) {
  for (const [name, child] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenKeys(child, key, out);
    } else {
      out.push(key);
    }
  }
  return out;
}

function readLocale(name) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${name}.json`), 'utf8'));
}

function makeTempLocales(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-i18n-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  return dir;
}

test('locale files expose identical nested key sets', () => {
  const zhKeys = flattenKeys(readLocale('zh-CN')).sort();
  const enKeys = flattenKeys(readLocale('en-US')).sort();

  assert.ok(zhKeys.length > 0);
  assert.deepStrictEqual(enKeys, zhKeys);
});

test('locale files group keys under the required namespaces', () => {
  const zh = readLocale('zh-CN');
  assert.deepStrictEqual(
    Object.keys(zh).sort(),
    ['dialog', 'error', 'menu', 'notify', 'tray']
  );
});

test('covers required shell surfaces in both locales', () => {
  const requiredKeys = [
    'menu.app.about',
    'menu.app.quit',
    'menu.system.openDataDir',
    'menu.studio.newWorktree',
    'menu.engine.winNative',
    'menu.engine.safeMode',
    'menu.engine.selfRepair',
    'menu.engine.checkUpdates',
    'menu.studio.autoStart',
    'menu.system.registerContextMenu',
    'dialog.backendNotReady.message',
    'error.backendCrashLoop',
    'dialog.worktreeClose.keep',
    'dialog.worktreeClose.destroy',
    'dialog.worktreeClose.cancel'
  ];

  for (const locale of ['zh-CN', 'en-US']) {
    const i18n = createI18n({ locale, localesDir: LOCALES_DIR });
    for (const key of requiredKeys) {
      assert.notStrictEqual(i18n.t(key), key, `${locale} is missing ${key}`);
    }
  }
});

test('interpolates named params and preserves unknown placeholders', () => {
  const i18n = createI18n({ locale: 'zh-CN', localesDir: LOCALES_DIR });

  const detail = i18n.t('dialog.worktreeClose.detail', {
    path: 'C:\\repo\\feature',
    branch: 'feat/i18n'
  });
  assert.ok(detail.includes('C:\\repo\\feature'));
  assert.ok(detail.includes('feat/i18n'));

  assert.strictEqual(
    i18n.t('dialog.hotUpdate.successMessage'),
    'DSH 内核已热更新到 {version}'
  );
});

test('falls back to fallback locale, then to the key, warning once', () => {
  const dir = makeTempLocales({
    'zh-CN.json': { greet: { hello: '你好 {name}' } },
    'en-US.json': { greet: {} }
  });
  const i18n = createI18n({ locale: 'en-US', localesDir: dir, fallbackLocale: 'zh-CN' });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.strictEqual(i18n.t('greet.hello', { name: 'Ada' }), '你好 Ada');
    assert.strictEqual(warnings.length, 0);

    assert.strictEqual(i18n.t('greet.missing'), 'greet.missing');
    assert.strictEqual(i18n.t('greet.missing'), 'greet.missing');
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /greet\.missing/);
  } finally {
    console.warn = originalWarn;
  }
});

test('normalizeLocale handles aliases and unknown values', () => {
  for (const input of ['zh-CN', 'zh_CN', 'ZH_cn', 'zh']) {
    assert.strictEqual(normalizeLocale(input), 'zh-CN');
  }
  for (const input of ['en-US', 'en_US', 'EN_us', 'en']) {
    assert.strictEqual(normalizeLocale(input), 'en-US');
  }

  assert.strictEqual(normalizeLocale('fr-FR'), 'zh-CN');
  assert.strictEqual(normalizeLocale('fr-FR', 'en-US'), 'en-US');
  assert.strictEqual(normalizeLocale(undefined), 'zh-CN');
  assert.strictEqual(normalizeLocale(''), 'zh-CN');
});

test('unknown locale falls back to the configured fallback locale', () => {
  const dir = makeTempLocales({
    'zh-CN.json': { hello: '你好' },
    'en-US.json': { hello: 'Hello' }
  });

  const zhI18n = createI18n({ locale: 'de-DE', localesDir: dir });
  assert.strictEqual(zhI18n.locale, 'zh-CN');
  assert.strictEqual(zhI18n.t('hello'), '你好');

  const enI18n = createI18n({ locale: 'de-DE', localesDir: dir, fallbackLocale: 'en-US' });
  assert.strictEqual(enI18n.locale, 'en-US');
  assert.strictEqual(enI18n.t('hello'), 'Hello');
});

test('loads locale JSON lazily and caches it after the first read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-i18n-lazy-'));
  const i18n = createI18n({ locale: 'zh-CN', localesDir: dir });

  fs.writeFileSync(path.join(dir, 'zh-CN.json'), JSON.stringify({ hello: '你好' }));
  fs.writeFileSync(path.join(dir, 'en-US.json'), JSON.stringify({ hello: 'Hello' }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

  assert.deepStrictEqual(i18n.availableLocales(), ['en-US', 'zh-CN']);
  assert.strictEqual(i18n.t('hello'), '你好');

  fs.writeFileSync(path.join(dir, 'zh-CN.json'), JSON.stringify({ hello: '你好，世界' }));
  assert.strictEqual(i18n.t('hello'), '你好');
});
