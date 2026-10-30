'use strict';

const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');

const { createFixtureServer } = require('./fixture-server');

const ROOT = path.resolve(__dirname, '..', '..');

let fixture;
let backendUrl;

test.beforeAll(async () => {
  fixture = createFixtureServer();
  backendUrl = await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

test('shell boots, loads the backend page and exposes the preload bridge', async () => {
  const electronApp = await electron.launch({
    args: [ROOT, '--hidden'],
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_E2E: '1',
      DSH_E2E_BACKEND_URL: backendUrl,
      DSH_ENABLE_APP_PROTOCOL: '0'
    }
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 20_000 });
    await window.waitForLoadState('domcontentloaded');

    await expect(window.locator('#app')).toHaveText('fixture-ready');

    await window.waitForFunction(() => Boolean(window.__probe && (window.__probe.ok || window.__probe.error)));
    const probe = await window.evaluate(() => window.__probe);

    expect(probe.error).toBeUndefined();
    expect(probe.ok).toBe(true);
    expect(probe.bridge).toBe(true);
    expect(probe.info).toBeTruthy();
    expect(typeof probe.info.port).toBe('number');
    expect(typeof probe.info.workspaceDir).toBe('string');

    const title = await window.title();
    expect(title).toContain('DeepSeek Harness');
  } finally {
    await electronApp.close();
  }
});

test('backend main document receives the shell CSP hardening', async () => {
  const electronApp = await electron.launch({
    args: [ROOT, '--hidden'],
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_E2E: '1',
      DSH_E2E_BACKEND_URL: backendUrl,
      DSH_ENABLE_APP_PROTOCOL: '0'
    }
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 20_000 });
    await window.waitForLoadState('domcontentloaded');

    const csp = await window.evaluate(async () => {
      const response = await fetch(window.location.href, { cache: 'no-store' });
      return response.headers.get('content-security-policy');
    });

    expect(csp).toBeTruthy();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  } finally {
    await electronApp.close();
  }
});

test('renderer cannot open new windows to untrusted origins', async () => {
  const electronApp = await electron.launch({
    args: [ROOT, '--hidden'],
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_E2E: '1',
      DSH_E2E_BACKEND_URL: backendUrl,
      DSH_ENABLE_APP_PROTOCOL: '0'
    }
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 20_000 });
    await window.waitForLoadState('domcontentloaded');

    const opened = await window.evaluate(() => {
      const handle = window.open('https://example.invalid/escape', '_blank');
      return handle !== null;
    });

    expect(opened).toBe(false);
    expect(window.url()).toBe(backendUrl);
  } finally {
    await electronApp.close();
  }
});
