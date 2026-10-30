'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createSessionSecurity, hardenWebContents, isAudioOnlyRequest } = require('../src/security');

const ALLOWED_ORIGIN = 'http://127.0.0.1:3080';

function makeContents({ type = 'window', url = `${ALLOWED_ORIGIN}/workspace` } = {}) {
  return {
    getType: () => type,
    getURL: () => url
  };
}

function makeSession() {
  const handlers = {};
  return {
    handlers,
    setPermissionRequestHandler: (fn) => {
      handlers.request = fn;
    },
    setPermissionCheckHandler: (fn) => {
      handlers.check = fn;
    }
  };
}

function makeHarness() {
  const warnings = [];
  const security = createSessionSecurity({
    getAllowedOrigin: () => ALLOWED_ORIGIN,
    log: { warn: (message) => warnings.push(message) }
  });
  const session = makeSession();
  security.install(session);
  return { security, session, warnings };
}

function requestPermission(session, contents, permission, details) {
  let granted = null;
  session.handlers.request(contents, permission, (value) => {
    granted = value;
  }, details);
  return granted;
}

test('isAudioOnlyRequest accepts audio-only and rejects mixed or empty requests', () => {
  assert.strictEqual(isAudioOnlyRequest({ mediaTypes: ['audio'] }), true);
  assert.strictEqual(isAudioOnlyRequest({ mediaTypes: ['audio', 'video'] }), false);
  assert.strictEqual(isAudioOnlyRequest({ mediaTypes: [] }), false);
  assert.strictEqual(isAudioOnlyRequest({}), false);
  assert.strictEqual(isAudioOnlyRequest(null), false);
});

test('microphone access is granted for the primary backend document', () => {
  const { session } = makeHarness();
  const granted = requestPermission(
    session,
    makeContents(),
    'media',
    { mediaTypes: ['audio'] }
  );
  assert.strictEqual(granted, true);
});

test('video capture is denied even from the primary document', () => {
  const { session } = makeHarness();
  const granted = requestPermission(
    session,
    makeContents(),
    'media',
    { mediaTypes: ['video'] }
  );
  assert.strictEqual(granted, false);
});

test('permissions are denied for foreign origins and non-window contents', () => {
  const { session } = makeHarness();
  const foreign = makeContents({ url: 'https://evil.example/workspace' });
  assert.strictEqual(requestPermission(session, foreign, 'media', { mediaTypes: ['audio'] }), false);

  const iframe = makeContents({ type: 'webview' });
  assert.strictEqual(requestPermission(session, iframe, 'media', { mediaTypes: ['audio'] }), false);
});

test('non-media permissions are always denied and logged', () => {
  const { session, warnings } = makeHarness();
  for (const permission of ['geolocation', 'notifications', 'openExternal', 'clipboard-read']) {
    assert.strictEqual(requestPermission(session, makeContents(), permission), false);
  }
  assert.strictEqual(warnings.length, 4);
});

test('permission check handler only approves media on the primary origin', () => {
  const { session } = makeHarness();
  assert.strictEqual(session.handlers.check(makeContents(), 'media', ALLOWED_ORIGIN), true);
  assert.strictEqual(session.handlers.check(makeContents(), 'media', 'https://evil.example'), false);
  assert.strictEqual(session.handlers.check(makeContents(), 'notifications', ALLOWED_ORIGIN), false);
  assert.strictEqual(
    session.handlers.check(makeContents({ type: 'webview' }), 'media', ALLOWED_ORIGIN),
    false
  );
});

test('hardenWebContents blocks webview attach attempts', () => {
  const handlers = {};
  const warnings = [];
  const contents = {
    on: (event, fn) => {
      handlers[event] = fn;
    }
  };
  hardenWebContents(contents, { log: { warn: (message) => warnings.push(message) } });
  let prevented = false;
  handlers['will-attach-webview']({ preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true);
  assert.strictEqual(warnings.length, 1);
});

test('install rejects a missing session', () => {
  const security = createSessionSecurity({ getAllowedOrigin: () => ALLOWED_ORIGIN });
  assert.throws(() => security.install(null), TypeError);
});

test('allowed origin falls back to null for invalid backend urls', () => {
  const security = createSessionSecurity({ getAllowedOrigin: () => 'not-a-url' });
  assert.strictEqual(security.allowedOrigin(), null);
  assert.strictEqual(security.isAllowedUrl(`${ALLOWED_ORIGIN}/x`), false);
});
