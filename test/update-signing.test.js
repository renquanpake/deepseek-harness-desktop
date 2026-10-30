'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { generateKeypair } = require('../scripts/generate-update-keypair');
const {
  buildManifest,
  buildSignedDocument,
  sha256File
} = require('../scripts/sign-update-manifest');
const { verifyUpdateManifest, buildUpdateTrust } = require('../lib/update-trust');
const { checkRemoteReleaseAssets } = require('../lib/updater');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-signing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a signed update manifest verifies with the matching public key', () => {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const manifest = buildManifest({
    version: '0.3.0',
    tag: 'v0.3.0',
    repo: 'owner/repo',
    installerPath: '/tmp/DeepSeek Harness Setup 0.3.0.exe',
    sha256: 'a'.repeat(64),
    now: new Date('2026-10-29T00:00:00.000Z')
  });
  const document = buildSignedDocument(manifest, privateKeyPem);

  const verdict = verifyUpdateManifest(document, publicKeyPem);
  assert.strictEqual(verdict.ok, true);
  assert.deepStrictEqual(verdict.manifest, manifest);
  assert.strictEqual(manifest.installerUrl, 'https://github.com/owner/repo/releases/download/v0.3.0/DeepSeek%20Harness%20Setup%200.3.0.exe');
});

test('tampering with the manifest invalidates the signature', () => {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const manifest = buildManifest({
    version: '0.3.0',
    tag: 'v0.3.0',
    repo: 'owner/repo',
    installerPath: '/tmp/setup.exe',
    sha256: 'b'.repeat(64)
  });
  const document = buildSignedDocument(manifest, privateKeyPem);
  document.manifest.sha256 = 'c'.repeat(64);

  const verdict = verifyUpdateManifest(document, publicKeyPem);
  assert.strictEqual(verdict.ok, false);
});

test('a foreign public key does not verify the document', () => {
  const signer = generateKeypair();
  const other = generateKeypair();
  const manifest = buildManifest({
    version: '0.3.0',
    tag: 'v0.3.0',
    repo: 'owner/repo',
    installerPath: '/tmp/setup.exe',
    sha256: 'd'.repeat(64)
  });
  const document = buildSignedDocument(manifest, signer.privateKeyPem);

  assert.strictEqual(verifyUpdateManifest(document, other.publicKeyPem).ok, false);
  assert.strictEqual(verifyUpdateManifest({ ...document, signature: '' }, signer.publicKeyPem).reason, 'signature-missing');
});

test('trust loads a public key file and requires signatures when present', (t) => {
  const root = makeRoot(t);
  const { publicKeyPem } = generateKeypair();
  const keyPath = path.join(root, 'update-public-key.pem');
  fs.writeFileSync(keyPath, publicKeyPem);

  const trust = buildUpdateTrust({ publicKeyPath: keyPath });
  assert.strictEqual(trust.publicKeyPem, publicKeyPem.trim());
  assert.strictEqual(trust.requireSignature, true);

  const missing = buildUpdateTrust({ publicKeyPath: path.join(root, 'absent.pem') });
  assert.strictEqual(missing.publicKeyPem, null);
  assert.strictEqual(missing.requireSignature, false);
});

test('release check accepts a valid signed manifest and rejects a tampered one', async (t) => {
  const root = makeRoot(t);
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const installerPath = path.join(root, 'setup.exe');
  fs.writeFileSync(installerPath, 'installer-bytes');
  const sha256 = sha256File(installerPath);
  const manifest = buildManifest({
    version: '0.3.0',
    tag: 'v0.3.0',
    repo: 'owner/repo',
    installerPath,
    sha256
  });
  const document = buildSignedDocument(manifest, privateKeyPem);

  const releaseUrl = 'https://api.github.com/repos/owner/repo/releases/latest';
  const manifestUrl = 'https://github.com/owner/repo/releases/download/v0.3.0/latest.json';
  const release = {
    tag_name: 'v0.3.0',
    assets: [
      { name: 'DeepSeek Harness Setup 0.3.0.exe', browser_download_url: 'https://example.com/setup.exe' },
      { name: 'latest.json', browser_download_url: manifestUrl }
    ]
  };

  const fetchJson = async (url) => {
    if (url === releaseUrl) return release;
    if (url === manifestUrl) return document;
    throw new Error(`unexpected url ${url}`);
  };

  const trusted = await checkRemoteReleaseAssets([releaseUrl], {
    fetchJson,
    trust: { publicKeyPem, requireSignature: true }
  });
  assert.strictEqual(trusted.trusted, true);
  assert.strictEqual(trusted.installerUrl, manifest.installerUrl);
  assert.strictEqual(trusted.sha256, sha256);

  const tampered = JSON.parse(JSON.stringify(document));
  tampered.manifest.sha256 = 'e'.repeat(64);
  const rejected = await checkRemoteReleaseAssets([releaseUrl], {
    fetchJson: async (url) => (url === releaseUrl ? release : tampered),
    trust: { publicKeyPem, requireSignature: true }
  });
  assert.strictEqual(rejected, null);
});

test('unsigned releases still work when no public key is bundled', async () => {
  const releaseUrl = 'https://api.github.com/repos/owner/repo/releases/latest';
  const release = {
    tag_name: 'v0.3.0',
    assets: [{ name: 'DeepSeek Harness Setup 0.3.0.exe', browser_download_url: 'https://example.com/setup.exe' }],
    body: ''
  };
  const result = await checkRemoteReleaseAssets([releaseUrl], {
    fetchJson: async () => release,
    trust: { publicKeyPem: null, requireSignature: false }
  });
  assert.strictEqual(result.trusted, false);
  assert.strictEqual(result.installerUrl, 'https://example.com/setup.exe');
});
