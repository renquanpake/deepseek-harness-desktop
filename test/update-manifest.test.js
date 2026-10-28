'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  canonicalize,
  signManifest,
  verifyManifest,
  verifyManifestFile
} = require('../lib/update-manifest');
const {
  THIRD_PARTY_PROXIES,
  resolveUpdateSources
} = require('../lib/update-source-policy');

function createKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

const { publicKeyPem, privateKeyPem } = createKeyPair();

function sampleManifest() {
  return {
    version: '1.2.3',
    channel: 'stable',
    files: [
      { name: 'app.exe', sha256: 'a'.repeat(64) },
      { name: 'runtime.zip', sha256: 'b'.repeat(64) }
    ]
  };
}

test('canonicalize: sorts keys recursively and is stable across input order', () => {
  const first = {
    z: 1,
    a: { y: 2, b: 3 },
    list: [{ d: 4, c: 5 }],
    flag: true
  };
  const second = {
    flag: true,
    list: [{ c: 5, d: 4 }],
    a: { b: 3, y: 2 },
    z: 1
  };

  assert.strictEqual(canonicalize(first), canonicalize(second));
  assert.strictEqual(
    canonicalize(first),
    '{"a":{"b":3,"y":2},"flag":true,"list":[{"c":5,"d":4}],"z":1}'
  );
});

test('signManifest/verifyManifest: accepts reordered manifest with valid signature', () => {
  const manifest = sampleManifest();
  const signature = signManifest(manifest, privateKeyPem);
  const reordered = {
    files: [
      { sha256: 'a'.repeat(64), name: 'app.exe' },
      { sha256: 'b'.repeat(64), name: 'runtime.zip' }
    ],
    channel: 'stable',
    version: '1.2.3'
  };

  assert.strictEqual(typeof signature, 'string');
  assert.deepStrictEqual(verifyManifest(reordered, signature, publicKeyPem), {
    ok: true,
    reason: null,
    unsigned: false
  });
});

test('verifyManifest: rejects a tampered manifest', () => {
  const manifest = sampleManifest();
  const signature = signManifest(manifest, privateKeyPem);
  const tampered = { ...manifest, version: '1.2.4' };

  const result = verifyManifest(tampered, signature, publicKeyPem);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.unsigned, false);
  assert.strictEqual(result.reason, 'signature-mismatch');
});

test('verifyManifest: rejects a tampered signature', () => {
  const manifest = sampleManifest();
  const signature = signManifest(manifest, privateKeyPem);
  const signatureBytes = Buffer.from(signature, 'base64');
  signatureBytes[0] ^= 0xff;
  const tamperedSignature = signatureBytes.toString('base64');

  const result = verifyManifest(manifest, tamperedSignature, publicKeyPem);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.unsigned, false);
  assert.strictEqual(result.reason, 'signature-mismatch');
});

test('verifyManifest: unsigned manifest is rejected by default', () => {
  const manifest = sampleManifest();

  assert.deepStrictEqual(verifyManifest(manifest, null, publicKeyPem), {
    ok: false,
    reason: 'missing-signature',
    unsigned: true
  });
  assert.deepStrictEqual(verifyManifest(manifest, '', publicKeyPem), {
    ok: false,
    reason: 'missing-signature',
    unsigned: true
  });
});

test('verifyManifest: allowUnsigned explicitly permits unsigned manifest', () => {
  const manifest = sampleManifest();

  assert.deepStrictEqual(
    verifyManifest(manifest, undefined, publicKeyPem, { allowUnsigned: true }),
    { ok: true, reason: 'unsigned-allowed', unsigned: true }
  );
});

test('verifyManifest: malformed signature is reported as reason without throwing', () => {
  const result = verifyManifest(sampleManifest(), 'not-a-valid-signature', publicKeyPem);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.unsigned, false);
  assert.strictEqual(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

test('verifyManifestFile: verifies signature file and handles unsigned policy', () => {
  const manifest = sampleManifest();
  const signature = signManifest(manifest, privateKeyPem);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-manifest-'));
  const manifestPath = path.join(tmpDir, 'update-manifest.json');
  const signaturePath = path.join(tmpDir, 'update-manifest.json.sig');
  const missingSignaturePath = path.join(tmpDir, 'missing.sig');

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(signaturePath, `${signature}\n`);

    assert.deepStrictEqual(verifyManifestFile(manifestPath, signaturePath, publicKeyPem), {
      ok: true,
      reason: null,
      unsigned: false
    });
    assert.deepStrictEqual(verifyManifestFile(manifestPath, missingSignaturePath, publicKeyPem), {
      ok: false,
      reason: 'missing-signature',
      unsigned: true
    });
    assert.deepStrictEqual(
      verifyManifestFile(manifestPath, missingSignaturePath, publicKeyPem, { allowUnsigned: true }),
      { ok: true, reason: 'unsigned-allowed', unsigned: true }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveUpdateSources: official sources only and third-party proxies disabled by default', () => {
  const sources = resolveUpdateSources();
  const proxyHosts = new Set(THIRD_PARTY_PROXIES.map((proxy) => new URL(proxy).hostname));

  assert.ok(Array.isArray(sources));
  assert.ok(sources.some((url) => url.includes('registry.npmjs.org')));
  assert.ok(sources.some((url) => url.includes('api.github.com')));
  assert.ok(sources.some((url) => url.includes('raw.githubusercontent.com')));
  assert.ok(sources.every((url) => !proxyHosts.has(new URL(url).hostname)));
  assert.deepStrictEqual(sources.skipped, []);
});

test('resolveUpdateSources: proxies are appended after official sources when enabled', () => {
  const official = resolveUpdateSources();
  const withProxy = resolveUpdateSources({ allowThirdPartyProxy: true });
  const appended = withProxy.slice(official.length);
  const proxyHosts = new Set(THIRD_PARTY_PROXIES.map((proxy) => new URL(proxy).hostname));

  assert.deepStrictEqual(withProxy.slice(0, official.length), official);
  assert.ok(appended.length > 0);
  assert.ok(appended.some((url) => url.startsWith('https://ghfast.top/')));
  assert.ok(appended.some((url) => url.startsWith('https://mirror.ghproxy.com/')));
  assert.ok(appended.some((url) => url.startsWith('https://fastly.jsdelivr.net/gh/')));
  assert.ok(appended.every((url) => proxyHosts.has(new URL(url).hostname)));
});

test('resolveUpdateSources: strips userinfo credentials and records skipped invalid URLs', () => {
  const sources = resolveUpdateSources({
    sources: [
      'https://user:secret@example.com/update.json',
      'not a valid url',
      'ftp://example.com/update.json',
      'https://example.com/ok.json?channel=stable'
    ]
  });

  assert.deepStrictEqual([...sources], [
    'https://example.com/update.json',
    'https://example.com/ok.json?channel=stable'
  ]);
  assert.ok(!JSON.stringify([...sources]).includes('secret'));
  assert.strictEqual(sources.skipped.length, 2);
  assert.ok(sources.skipped.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0));
});

test('updater: keeps compatible exports and exposes hardening helpers', () => {
  const updater = require('../lib/updater');

  assert.strictEqual(typeof updater.buildProxyedUrls, 'function');
  assert.strictEqual(typeof updater.downloadWithProxies, 'function');
  assert.strictEqual(updater.THIRD_PARTY_PROXIES, THIRD_PARTY_PROXIES);
  assert.strictEqual(typeof updater.resolveUpdateSources, 'function');
  assert.strictEqual(typeof updater.verifyManifest, 'function');
  assert.strictEqual(typeof updater.verifyManifestFile, 'function');
});
