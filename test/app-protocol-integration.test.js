'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const protocolSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'protocol-setup.js'), 'utf8');
const restartSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app-restart.js'), 'utf8');
const windowSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app-window.js'), 'utf8');
const trustedSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'trusted-url.js'), 'utf8');

test('main.js registers dsh-app privileges before app.whenReady', () => {
  const registerIndex = mainSrc.indexOf('registerAppSchemePrivileges(protocol)');
  const readyIndex = mainSrc.indexOf('app.whenReady()');
  assert.ok(registerIndex !== -1, 'registerAppSchemePrivileges call missing');
  assert.ok(readyIndex !== -1, 'app.whenReady missing');
  assert.ok(!mainSrc.slice(mainSrc.lastIndexOf('\n', registerIndex) + 1, registerIndex).match(/^\s/), 'privilege registration must run at module load');
  assert.ok(registerIndex < readyIndex, 'privileges must be registered before whenReady usage');
});

test('protocol setup installs the handler gated by DSH_ENABLE_APP_PROTOCOL', () => {
  assert.match(mainSrc, /DSH_ENABLE_APP_PROTOCOL/);
  assert.match(mainSrc, /appProtocolEnabled: ENABLE_APP_PROTOCOL/);
  assert.match(protocolSrc, /if \(!appProtocolEnabled\) return false;/);
  assert.match(protocolSrc, /createAppProtocolHandler\(\{/);
  assert.match(protocolSrc, /registerPrivileges: false/);
  assert.match(protocolSrc, /headers\.set\('content-security-policy', csp\)/);
});

test('protocol origin refreshes after backend ready and the window guards navigation', () => {
  assert.match(mainSrc, /installAppProtocol: \(\) => protocolSetup\.installAppProtocol\(\)/);
  assert.match(restartSrc, /if \(ready\) installAppProtocol\(\);/);
  assert.match(mainSrc, /getBackendOrigin: \(\) => \{/);
  assert.match(windowSrc, /will-navigate[\s\S]{0,160}isAppUrl\(url\)/);
  assert.match(windowSrc, /loadURL\(`\$\{appScheme\}:\/\/\$\{appHost\}\/splash\.html`\)/);
});

test('trusted-url accepts dsh-app origin only through strict isAppUrl check', () => {
  assert.match(trustedSrc, /require\('\.\/app-protocol'\)/);
  assert.match(trustedSrc, /if \(isAppUrl\(frameUrl\)\) \{/);
});
