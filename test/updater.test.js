const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  semverCompare,
  isNewer,
  decideUpdatePlan,
  buildProxyedUrls,
  pickInstallerUrl,
  pickFirstAvailable,
  extractInstallerSha256,
  verifyInstallerIntegrity
} = require('../lib/updater');

test('semverCompare: strict ordering', () => {
  assert.strictEqual(semverCompare('1.0.0', '1.0.0'), 0);
  assert.strictEqual(semverCompare('1.0.1', '1.0.0'), 1);
  assert.strictEqual(semverCompare('1.2.0', '1.10.0'), -1);
});

test('isNewer: ignores prerelease suffixes on equal base', () => {
  assert.strictEqual(isNewer('0.2.5', '0.2.4'), true);
  assert.strictEqual(isNewer('0.2.4', '0.2.4'), false);
  assert.strictEqual(isNewer('0.2.4-rc.1', '0.2.4'), false);
});

test('decideUpdatePlan: only when remote is newer', () => {
  const base = {
    core: { currentVersion: '0.1.0-rc.6', remoteVersion: '0.2.0' },
    shell: { currentVersion: '0.1.0', remoteVersion: '0.1.0' }
  };
  assert.deepStrictEqual(decideUpdatePlan(base), {
    coreNeedsUpdate: true,
    shellNeedsUpdate: false,
    hasUpdate: true
  });
});

test('decideUpdatePlan: null remote treated as no update', () => {
  const base = {
    core: { currentVersion: '1.0.0', remoteVersion: null },
    shell: { currentVersion: '1.0.0', remoteVersion: null }
  };
  assert.deepStrictEqual(decideUpdatePlan(base), {
    coreNeedsUpdate: false,
    shellNeedsUpdate: false,
    hasUpdate: false
  });
});

test('buildProxyedUrls: official URL is first, followed by proxy fallbacks', () => {
  const out = buildProxyedUrls('https://raw.githubusercontent.com/foo/bar', [
    'https://ghfast.top/',
    'https://mirror.ghproxy.com/'
  ]);
  assert.deepStrictEqual(out, [
    'https://raw.githubusercontent.com/foo/bar',
    'https://ghfast.top/https://raw.githubusercontent.com/foo/bar',
    'https://mirror.ghproxy.com/https://raw.githubusercontent.com/foo/bar'
  ]);
});

test('buildProxyedUrls: handles prefix without trailing slash', () => {
  const out = buildProxyedUrls('https://github.com/x/y.exe', [
    'https://ghfast.top'
  ]);
  assert.deepStrictEqual(out, [
    'https://github.com/x/y.exe',
    'https://ghfast.top/https://github.com/x/y.exe'
  ]);
});

test('buildProxyedUrls: handles relative baseUrl without double slash', () => {
  const out = buildProxyedUrls('/foo/bar.exe', [
    'https://ghfast.top/',
    'https://ghfast.top'
  ]);
  assert.deepStrictEqual(out, [
    '/foo/bar.exe',
    'https://ghfast.top/foo/bar.exe'
  ]);
});

test('buildProxyedUrls: empty proxy list returns original only', () => {
  const out = buildProxyedUrls('https://example.com/x', []);
  assert.deepStrictEqual(out, ['https://example.com/x']);
});

test('pickInstallerUrl: prefers non-portable .exe', () => {
  const assets = [
    { name: 'app-portable-1.0.0.exe', browser_download_url: 'https://x/portable.exe' },
    { name: 'app-setup-1.0.0.exe', browser_download_url: 'https://x/setup.exe' },
    { name: 'notes.txt', browser_download_url: 'https://x/notes.txt' }
  ];
  assert.strictEqual(pickInstallerUrl(assets), 'https://x/setup.exe');
});

test('pickFirstAvailable: returns first non-null candidate', () => {
  assert.strictEqual(pickFirstAvailable([null, 'a', 'b']), 'a');
  assert.strictEqual(pickFirstAvailable([null, undefined, null]), null);
});

test('extractInstallerSha256: extracts digest from GitHub asset or release body', () => {
  const fakeHash = 'a'.repeat(64);
  const rel1 = {
    assets: [
      {
        name: 'setup.exe',
        browser_download_url: 'https://x/setup.exe',
        digest: `sha256:${fakeHash.toUpperCase()}`
      }
    ]
  };
  assert.strictEqual(extractInstallerSha256(rel1, 'https://x/setup.exe'), fakeHash);

  const rel2 = {
    assets: [{ name: 'setup.exe', browser_download_url: 'https://x/setup.exe' }],
    body: `Release notes\n${fakeHash}  setup.exe\n`
  };
  assert.strictEqual(extractInstallerSha256(rel2, 'https://x/setup.exe'), fakeHash);
});

test('verifyInstallerIntegrity: validates matching hash and deletes tampered file on mismatch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-sha-'));
  const filePath = path.join(tmpDir, 'installer.exe');
  const payload = Buffer.from('trusted-installer-binary-payload', 'utf8');
  fs.writeFileSync(filePath, payload);
  const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

  const okRes = verifyInstallerIntegrity(filePath, expectedHash);
  assert.strictEqual(okRes.ok, true);
  assert.strictEqual(okRes.verified, true);
  assert.strictEqual(fs.existsSync(filePath), true);

  const badRes = verifyInstallerIntegrity(filePath, 'b'.repeat(64));
  assert.strictEqual(badRes.ok, false);
  assert.strictEqual(badRes.reason, 'hash-mismatch');
  assert.strictEqual(fs.existsSync(filePath), false, 'Tampered installer must be unlinked immediately');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
