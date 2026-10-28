'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const trustedSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'trusted-url.js'), 'utf8');

test('main.js registers dsh-app privileges before app.whenReady', () => {
  const registerIndex = mainSrc.indexOf('registerAppSchemePrivileges(protocol)');
  const readyIndex = mainSrc.indexOf('app.whenReady()');
  assert.ok(registerIndex !== -1, 'registerAppSchemePrivileges call missing');
  assert.ok(readyIndex !== -1, 'app.whenReady missing');
  assert.ok(!mainSrc.slice(mainSrc.lastIndexOf('\n', registerIndex) + 1, registerIndex).match(/^\s/), 'privilege registration must run at module load');
  assert.ok(registerIndex < readyIndex, 'privileges must be registered before whenReady usage');
});

test('main.js installs protocol handler gated by DSH_ENABLE_APP_PROTOCOL', () => {
  assert.match(mainSrc, /DSH_ENABLE_APP_PROTOCOL/);
  assert.match(mainSrc, /function installAppProtocolHandler\(\) \{\s*\n\s*if \(!ENABLE_APP_PROTOCOL\) return;/);
  assert.match(mainSrc, /createAppProtocolHandler\(\{/);
  assert.match(mainSrc, /registerPrivileges: false/);
  assert.match(mainSrc, /headers\.set\('content-security-policy', csp\)/);
});

test('main.js refreshes protocol origin after backend ready and guards navigation', () => {
  assert.match(mainSrc, /if \(ready\) installAppProtocolHandler\(\);/);
  assert.match(mainSrc, /will-navigate[\s\S]{0,120}isAppUrl\(url\)/);
  assert.match(mainSrc, /loadURL\(`\$\{APP_SCHEME\}:\/\/\$\{APP_HOST\}\/splash\.html`\)/);
});

test('trusted-url accepts dsh-app origin only through strict isAppUrl check', () => {
  assert.match(trustedSrc, /require\('\.\/app-protocol'\)/);
  assert.match(trustedSrc, /if \(isAppUrl\(frameUrl\)\) \{/);
});
