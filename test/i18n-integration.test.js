'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createI18n } = require('../lib/i18n');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const MAIN_JS = path.join(__dirname, '..', 'main.js');
const I18N_SOURCES = [
  MAIN_JS,
  path.join(__dirname, '..', 'src', 'ui-menus.js'),
  path.join(__dirname, '..', 'src', 'update-flow.js')
];

function readLocale(name) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${name}.json`), 'utf8'));
}

function lookup(data, key) {
  let cursor = data;
  for (const segment of key.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

function collectKeys() {
  const keys = new Set();
  const pattern = /\bt\('([^']+)'/g;
  for (const file of I18N_SOURCES) {
    const source = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = pattern.exec(source)) !== null) {
      keys.add(match[1]);
    }
    pattern.lastIndex = 0;
  }
  return keys;
}

function placeholders(template) {
  const names = [];
  const pattern = /\{([A-Za-z0-9_]+)\}/g;
  let match;
  while ((match = pattern.exec(template)) !== null) {
    names.push(match[1]);
  }
  return names.sort();
}

test('main.js wires up the i18n singleton', () => {
  const source = fs.readFileSync(MAIN_JS, 'utf8');
  assert.ok(source.includes("require('./lib/i18n')"));
  assert.ok(source.includes('createI18n({ locale: locale || undefined })'));
});

test('every t() key referenced in main.js exists in both locales', () => {
  const keys = collectKeys();
  assert.ok(keys.size >= 40, `expected many translated keys, got ${keys.size}`);
  const zh = readLocale('zh-CN');
  const en = readLocale('en-US');
  for (const key of keys) {
    assert.notStrictEqual(lookup(zh, key), undefined, `zh-CN missing ${key}`);
    assert.notStrictEqual(lookup(en, key), undefined, `en-US missing ${key}`);
  }
});

test('zh and en templates share identical interpolation placeholders for main.js keys', () => {
  const keys = collectKeys();
  const zh = readLocale('zh-CN');
  const en = readLocale('en-US');
  for (const key of keys) {
    const zhPlaceholders = placeholders(lookup(zh, key));
    const enPlaceholders = placeholders(lookup(en, key));
    assert.deepStrictEqual(enPlaceholders, zhPlaceholders, `placeholder mismatch for ${key}`);
  }
});

test('engine status label interpolates shell, core and source in en-US', () => {
  const i18n = createI18n({ locale: 'en-US' });
  const label = i18n.t('menu.engine.status', {
    shell: '1.2.3',
    core: '4.5.6',
    source: i18n.t('menu.engine.sourceFactory')
  });
  assert.ok(label.includes('Shell v1.2.3'));
  assert.ok(label.includes('DSH Core v4.5.6'));
  assert.ok(label.includes('Bundled factory core'));
});

test('worktree close dialog uses interpolated path and branch values', () => {
  const i18n = createI18n({ locale: 'zh-CN' });
  const detail = i18n.t('dialog.worktreeClose.detail', {
    path: 'C:\\repo\\app-wt-ab12c',
    branch: i18n.t('dialog.common.unknown')
  });
  assert.ok(detail.includes('C:\\repo\\app-wt-ab12c'));
  assert.ok(detail.includes('（未知）'));
});
