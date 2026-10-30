'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODIFIERS = [
  'CommandOrControl',
  'Command',
  'Control',
  'Ctrl',
  'Alt',
  'AltGr',
  'Shift',
  'Super',
  'Meta'
];

const MODIFIER_ALIASES = {
  cmdorctrl: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
  cmd: 'Command',
  command: 'Command',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Meta'
};

const KEY_TOKENS = /^(F([1-9]|1[0-9]|2[0-4])|[A-Z0-9]|Space|Tab|Enter|Return|Escape|Esc|Up|Down|Left|Right|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Plus|Minus|Comma|Period)$/i;

const DEFAULTS = Object.freeze({
  relayShortcut: 'Alt+Space',
  relayFallback: 'CommandOrControl+Alt+D',
  toggleDevTools: 'F12'
});

const MAX_ACCELERATOR_LENGTH = 64;

function normalizeAccelerator(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s*\+\s*/g, '+');
  if (!trimmed || trimmed.length > MAX_ACCELERATOR_LENGTH) return null;

  const parts = trimmed.split('+');
  if (parts.some((part) => part.length === 0)) return null;

  const modifiers = [];
  const keys = [];
  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase()];
    if (alias) {
      if (!modifiers.includes(alias)) modifiers.push(alias);
      continue;
    }
    if (!KEY_TOKENS.test(part)) return null;
    keys.push(part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1).toLowerCase());
  }

  if (keys.length !== 1) return null;
  return [...modifiers, keys[0]].join('+');
}

function normalizeBindings(raw) {
  const errors = [];
  const bindings = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { bindings, errors: ['bindings must be an object'], valid: false };
  }

  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in raw) || raw[key] === undefined) continue;
    const normalized = normalizeAccelerator(raw[key]);
    if (!normalized) {
      errors.push(`${key}: invalid accelerator`);
      continue;
    }
    bindings[key] = normalized;
  }

  if (bindings.relayShortcut === bindings.relayFallback) {
    errors.push('relayFallback must differ from relayShortcut');
    bindings.relayFallback = DEFAULTS.relayFallback;
  }

  return { bindings, errors, valid: errors.length === 0 };
}

function loadKeybindings(filePath, fsImpl = fs) {
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { bindings: { ...DEFAULTS }, source: 'default', errors: [] };
    }
    return { bindings: { ...DEFAULTS }, source: 'default', errors: [err.message] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { bindings: { ...DEFAULTS }, source: 'invalid', errors: ['file is not valid JSON'] };
  }

  const normalized = normalizeBindings(parsed);
  return {
    bindings: normalized.bindings,
    source: normalized.valid ? 'file' : 'invalid',
    errors: normalized.errors
  };
}

function saveKeybindings(filePath, bindings, fsImpl = fs) {
  const normalized = normalizeBindings(bindings);
  try {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fsImpl.writeFileSync(tempPath, `${JSON.stringify(normalized.bindings, null, 2)}\n`, 'utf8');
    fsImpl.renameSync(tempPath, filePath);
    return { ok: true, bindings: normalized.bindings };
  } catch (err) {
    return { ok: false, error: err.message, bindings: normalized.bindings };
  }
}

function ensureKeybindingFile(filePath, fsImpl = fs) {
  const loaded = loadKeybindings(filePath, fsImpl);
  if (loaded.source === 'default') {
    saveKeybindings(filePath, loaded.bindings, fsImpl);
    return { ...loaded, created: true };
  }
  return { ...loaded, created: false };
}

module.exports = {
  DEFAULTS,
  MODIFIERS,
  normalizeAccelerator,
  normalizeBindings,
  loadKeybindings,
  saveKeybindings,
  ensureKeybindingFile
};
