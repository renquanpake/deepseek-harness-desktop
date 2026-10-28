'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FALLBACK_LOCALE = 'zh-CN';
const BLOCKED_KEY_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const INTERPOLATION_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

function mapLocale(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().replace(/_/g, '-').toLowerCase();
  if (!value) return null;
  if (value === 'zh' || value === 'zh-cn' || value.startsWith('zh-')) return 'zh-CN';
  if (value === 'en' || value === 'en-us' || value.startsWith('en-')) return 'en-US';
  return null;
}

function normalizeLocale(input, fallbackLocale = DEFAULT_FALLBACK_LOCALE) {
  return (
    mapLocale(input) ||
    mapLocale(fallbackLocale) ||
    DEFAULT_FALLBACK_LOCALE
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function interpolate(template, params) {
  if (!params || typeof params !== 'object') return template;
  return template.replace(INTERPOLATION_PATTERN, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

function createI18n(options = {}) {
  const localesDir = options.localesDir || path.join(__dirname, '..', 'locales');
  const fallbackLocale = normalizeLocale(
    options.fallbackLocale || DEFAULT_FALLBACK_LOCALE,
    DEFAULT_FALLBACK_LOCALE
  );
  const locale = normalizeLocale(options.locale || fallbackLocale, fallbackLocale);

  const localeCache = new Map();
  const warnedMissingKeys = new Set();
  const warnedLoadFailures = new Set();

  function loadLocale(localeCode) {
    if (localeCache.has(localeCode)) return localeCache.get(localeCode);

    let data = null;
    try {
      const filePath = path.join(localesDir, `${localeCode}.json`);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (isPlainObject(parsed)) {
        data = parsed;
        localeCache.set(localeCode, data);
      }
    } catch (err) {
      if (!warnedLoadFailures.has(localeCode)) {
        warnedLoadFailures.add(localeCode);
        console.warn(`[i18n] Failed to load locale "${localeCode}": ${err.message}`);
      }
    }
    return data;
  }

  function lookup(localeCode, key) {
    const data = loadLocale(localeCode);
    if (!data) return undefined;

    const segments = key.split('.');
    let cursor = data;
    for (const segment of segments) {
      if (BLOCKED_KEY_SEGMENTS.has(segment)) return undefined;
      if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
        return undefined;
      }
      cursor = cursor[segment];
    }
    return typeof cursor === 'string' ? cursor : undefined;
  }

  function t(key, params) {
    const lookupKey = typeof key === 'string' ? key : String(key);
    let template = lookup(locale, lookupKey);

    if (template === undefined && fallbackLocale !== locale) {
      template = lookup(fallbackLocale, lookupKey);
    }

    if (template === undefined) {
      if (!warnedMissingKeys.has(lookupKey)) {
        warnedMissingKeys.add(lookupKey);
        console.warn(
          `[i18n] Missing translation for key "${lookupKey}" (locale: ${locale}, fallback: ${fallbackLocale})`
        );
      }
      return lookupKey;
    }

    return interpolate(template, params);
  }

  function availableLocales() {
    try {
      return fs
        .readdirSync(localesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length))
        .sort();
    } catch (err) {
      return [];
    }
  }

  return {
    locale,
    fallbackLocale,
    t,
    availableLocales
  };
}

module.exports = { createI18n, normalizeLocale };
