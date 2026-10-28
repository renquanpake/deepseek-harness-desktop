'use strict';

const MAX_NOTIFY_TITLE = 100;
const MAX_NOTIFY_BODY = 500;
const MAX_WSL_PATH_LENGTH = 32767;
const ENGINE_MODES = ['win-native', 'wsl2'];

class IpcValidationError extends Error {
  constructor(channel, path, detail) {
    super(`${channel}: ${path}: ${detail}`);
    this.name = 'IpcValidationError';
    this.channel = channel;
    this.path = path;
  }
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === undefined || value === null) {
    return String(value);
  }
  return describeValue(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function noArgsValidator(channel) {
  return function validateNoArgs(payload) {
    if (payload === undefined || payload === null) return;
    if (isPlainObject(payload) && Object.keys(payload).length === 0) return;
    throw new IpcValidationError(
      channel,
      '$',
      `expected undefined, null, or an empty object (got ${describeValue(payload)})`
    );
  };
}

function booleanValidator(channel, field) {
  return function validateBoolean(payload) {
    if (typeof payload === 'boolean') return;
    throw new IpcValidationError(
      channel,
      field,
      `expected a boolean (got ${describeValue(payload)})`
    );
  };
}

function enumValidator(channel, field, allowed) {
  return function validateEnum(payload) {
    if (typeof payload === 'string' && allowed.includes(payload)) return;
    const expected = allowed.map((value) => JSON.stringify(value)).join(' | ');
    throw new IpcValidationError(
      channel,
      field,
      `expected one of ${expected} (got ${formatValue(payload)})`
    );
  };
}

function nonEmptyStringValidator(channel, field, maxLength) {
  return function validateNonEmptyString(payload) {
    if (typeof payload !== 'string') {
      throw new IpcValidationError(
        channel,
        field,
        `expected a string (got ${describeValue(payload)})`
      );
    }
    if (payload.length === 0) {
      throw new IpcValidationError(channel, field, 'expected a non-empty string');
    }
    if (payload.length > maxLength) {
      throw new IpcValidationError(
        channel,
        field,
        `expected length <= ${maxLength} (got ${payload.length})`
      );
    }
  };
}

function notifyValidator(channel) {
  return function validateNotify(payload) {
    if (!isPlainObject(payload)) {
      throw new IpcValidationError(
        channel,
        '$',
        `expected an object with title and body (got ${describeValue(payload)})`
      );
    }
    if (typeof payload.title !== 'string') {
      throw new IpcValidationError(
        channel,
        'title',
        `expected a string (got ${describeValue(payload.title)})`
      );
    }
    if (payload.title.length > MAX_NOTIFY_TITLE) {
      throw new IpcValidationError(
        channel,
        'title',
        `expected length <= ${MAX_NOTIFY_TITLE} (got ${payload.title.length})`
      );
    }
    if (typeof payload.body !== 'string') {
      throw new IpcValidationError(
        channel,
        'body',
        `expected a string (got ${describeValue(payload.body)})`
      );
    }
    if (payload.body.length > MAX_NOTIFY_BODY) {
      throw new IpcValidationError(
        channel,
        'body',
        `expected length <= ${MAX_NOTIFY_BODY} (got ${payload.body.length})`
      );
    }
  };
}

const schemas = {
  'dsh:native-notify': notifyValidator('dsh:native-notify'),
  'dsh:get-runtime-info': noArgsValidator('dsh:get-runtime-info'),
  'dsh:get-backend-status': noArgsValidator('dsh:get-backend-status'),
  'dsh:set-always-on-top': booleanValidator('dsh:set-always-on-top', 'enable'),
  'dsh:get-plugin-inventory': noArgsValidator('dsh:get-plugin-inventory'),
  'dsh:rehydrate-plugins': noArgsValidator('dsh:rehydrate-plugins'),
  'dsh:create-worktree-dialog': noArgsValidator('dsh:create-worktree-dialog'),
  'dsh:switch-engine': enumValidator('dsh:switch-engine', 'mode', ENGINE_MODES),
  'dsh:restart-safe-mode': noArgsValidator('dsh:restart-safe-mode'),
  'dsh:register-context-menu': noArgsValidator('dsh:register-context-menu'),
  'dsh:unregister-context-menu': noArgsValidator('dsh:unregister-context-menu'),
  'dsh:request-clipboard-paste': noArgsValidator('dsh:request-clipboard-paste'),
  'dsh:get-auto-start': noArgsValidator('dsh:get-auto-start'),
  'dsh:set-auto-start': booleanValidator('dsh:set-auto-start', 'enable'),
  'dsh:convert-to-wsl-path': nonEmptyStringValidator(
    'dsh:convert-to-wsl-path',
    'windowsPath',
    MAX_WSL_PATH_LENGTH
  ),
  'dsh:get-workspace-status': noArgsValidator('dsh:get-workspace-status'),
  'dsh:run-self-repair': noArgsValidator('dsh:run-self-repair'),
  'dsh:check-update': noArgsValidator('dsh:check-update')
};

function hasSchema(channel) {
  return Object.prototype.hasOwnProperty.call(schemas, channel);
}

function assertValid(channel, payload) {
  if (!hasSchema(channel)) {
    throw new IpcValidationError(channel, '$', 'no schema registered for channel');
  }
  schemas[channel](payload);
}

module.exports = { IpcValidationError, schemas, assertValid, hasSchema };
