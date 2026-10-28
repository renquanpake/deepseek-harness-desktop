'use strict';

const crypto = require('crypto');
const fs = require('fs');

const ED25519_SIGNATURE_BYTES = 64;

function canonicalize(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (type === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const itemType = typeof item;
      if (item === undefined || itemType === 'function' || itemType === 'symbol') return 'null';
      return canonicalize(item);
    });
    return `[${items.join(',')}]`;
  }
  if (type === 'object') {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      const itemType = typeof item;
      if (item === undefined || itemType === 'function' || itemType === 'symbol') continue;
      parts.push(`${JSON.stringify(key)}:${canonicalize(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

function signatureText(signature) {
  if (Buffer.isBuffer(signature)) return signature.toString('base64').trim();
  if (typeof signature === 'string') return signature.trim();
  if (signature && typeof signature === 'object' && typeof signature.signature === 'string') {
    return signature.signature.trim();
  }
  return '';
}

function decodeSignature(text) {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function signManifest(manifest, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`Unsupported signing key type: ${key.asymmetricKeyType}`);
  }
  const payload = Buffer.from(canonicalize(manifest), 'utf8');
  return crypto.sign(null, payload, key).toString('base64');
}

function verifyManifest(manifest, signatureBase64, publicKeyPem, options = {}) {
  const allowUnsigned = Boolean(options && options.allowUnsigned === true);

  let canonical;
  try {
    canonical = canonicalize(manifest);
  } catch {
    return { ok: false, reason: 'manifest-not-serializable', unsigned: false };
  }

  const text = signatureText(signatureBase64);
  if (!text) {
    if (allowUnsigned) return { ok: true, reason: 'unsigned-allowed', unsigned: true };
    return { ok: false, reason: 'missing-signature', unsigned: true };
  }

  if (!publicKeyPem) {
    return { ok: false, reason: 'missing-public-key', unsigned: false };
  }

  let key;
  try {
    key = crypto.createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: 'invalid-public-key', unsigned: false };
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    return { ok: false, reason: 'unsupported-key-type', unsigned: false };
  }

  let signature;
  try {
    signature = decodeSignature(text);
  } catch {
    return { ok: false, reason: 'invalid-signature-format', unsigned: false };
  }
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    return { ok: false, reason: 'invalid-signature-format', unsigned: false };
  }

  try {
    const ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), key, signature);
    return ok
      ? { ok: true, reason: null, unsigned: false }
      : { ok: false, reason: 'signature-mismatch', unsigned: false };
  } catch {
    return { ok: false, reason: 'signature-verification-failed', unsigned: false };
  }
}

function verifyManifestFile(manifestPath, sigPath, publicKeyPem, options = {}) {
  const allowUnsigned = Boolean(options && options.allowUnsigned === true);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    const reason = err && err.code === 'ENOENT' ? 'manifest-missing' : 'manifest-invalid';
    return { ok: false, reason, unsigned: false };
  }

  let text = '';
  try {
    text = fs.readFileSync(sigPath, 'utf8');
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) {
      return { ok: false, reason: 'signature-read-failed', unsigned: false };
    }
  }

  return verifyManifest(manifest, text, publicKeyPem, { allowUnsigned });
}

module.exports = {
  canonicalize,
  signManifest,
  verifyManifest,
  verifyManifestFile
};
