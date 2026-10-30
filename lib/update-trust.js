'use strict';

const fs = require('node:fs');

const { verifyManifest } = require('./update-manifest');

const PUBLIC_KEY_MARKER = 'BEGIN PUBLIC KEY';

function loadUpdatePublicKey(publicKeyPath, fsImpl = fs) {
  if (typeof publicKeyPath !== 'string' || publicKeyPath.length === 0) return null;
  try {
    const pem = String(fsImpl.readFileSync(publicKeyPath, 'utf8')).trim();
    if (!pem.includes(PUBLIC_KEY_MARKER)) return null;
    return pem;
  } catch {
    return null;
  }
}

function buildUpdateTrust({ publicKeyPath, fsImpl = fs, requireSignature = true } = {}) {
  const publicKeyPem = publicKeyPath ? loadUpdatePublicKey(publicKeyPath, fsImpl) : null;
  return {
    publicKeyPem,
    requireSignature: Boolean(publicKeyPem && requireSignature)
  };
}

function verifyUpdateManifest(document, publicKeyPem) {
  if (!document || typeof document !== 'object') {
    return { ok: false, reason: 'document-missing' };
  }
  const manifest = document.manifest;
  const signature = document.signature;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, reason: 'manifest-missing' };
  }
  if (typeof signature !== 'string' || signature.trim().length === 0) {
    return { ok: false, reason: 'signature-missing' };
  }
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.includes(PUBLIC_KEY_MARKER)) {
    return { ok: false, reason: 'public-key-missing' };
  }
  let verdict;
  try {
    verdict = verifyManifest(manifest, signature, publicKeyPem, { allowUnsigned: false });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!verdict || !verdict.ok) {
    return { ok: false, reason: (verdict && verdict.reason) || 'signature-invalid' };
  }
  return { ok: true, manifest };
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

module.exports = {
  loadUpdatePublicKey,
  buildUpdateTrust,
  verifyUpdateManifest,
  isHttpUrl
};
