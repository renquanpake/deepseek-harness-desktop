'use strict';

const path = require('node:path');
const { resolveUpdateSources } = require('./update-source-policy');
const { buildUpdateTrust } = require('./update-trust');
const {
  checkRemoteCoreVersion,
  checkRemoteShellVersion,
  checkRemoteReleaseAssets
} = require('./updater');

const CONFIG = {
  CORE_REGISTRY_SOURCES: [
    { id: 'npmmirror-registry', kind: 'registry', url: 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest' },
    { id: 'npm-registry', kind: 'registry', url: 'https://registry.npmjs.org/@deepseek-ai/dsh/latest' }
  ],
  SHELL_MANIFEST_SOURCES: [
    { id: 'github-raw', kind: 'github-raw', url: 'https://raw.githubusercontent.com/renquanpake/deepseek-harness-desktop/main/package.json' }
  ],
  GITHUB_RELEASE_SOURCES: [
    { id: 'github-api', kind: 'github-api', url: 'https://api.github.com/repos/renquanpake/deepseek-harness-desktop/releases/latest' }
  ],
  GITHUB_DOWNLOAD_SOURCES: [
    { id: 'github-api', kind: 'github-api', url: 'https://api.github.com/repos/renquanpake/deepseek-harness-desktop/releases/latest' }
  ],
  // 官方源优先；第三方镜像仅在显式设置 DSH_ALLOW_THIRD_PARTY_MIRROR=1 时参与，防止供应链投毒
  ALLOW_THIRD_PARTY_PROXY: /^(1|true|yes)$/i.test(String(process.env.DSH_ALLOW_THIRD_PARTY_MIRROR || '')),
  UPDATE_TRUST_PUBLIC_KEY_PATH: path.join(__dirname, '..', 'build', 'update-public-key.pem'),
  REQUEST_TIMEOUT_MS: 8000,
  DOWNLOAD_TIMEOUT_MS: 60000,
  REGISTRY: 'https://registry.npmmirror.com'
};

function buildCandidates(sources) {
  return resolveUpdateSources({
    sources,
    allowThirdPartyProxy: CONFIG.ALLOW_THIRD_PARTY_PROXY
  });
}

function coreRegistryCandidates() {
  return buildCandidates(CONFIG.CORE_REGISTRY_SOURCES);
}

function shellManifestCandidates() {
  return buildCandidates(CONFIG.SHELL_MANIFEST_SOURCES);
}

function releaseCandidates() {
  return buildCandidates(CONFIG.GITHUB_RELEASE_SOURCES);
}

function downloadProxies() {
  return buildCandidates(CONFIG.GITHUB_DOWNLOAD_SOURCES);
}

async function checkCoreVersion() {
  return checkRemoteCoreVersion(coreRegistryCandidates());
}

async function checkShellVersion() {
  return checkRemoteShellVersion(shellManifestCandidates(), releaseCandidates());
}

function updateTrust() {
  return buildUpdateTrust({ publicKeyPath: CONFIG.UPDATE_TRUST_PUBLIC_KEY_PATH });
}

async function checkReleaseAssets() {
  return checkRemoteReleaseAssets(releaseCandidates(), { trust: updateTrust() });
}

module.exports = {
  CONFIG,
  coreRegistryCandidates,
  shellManifestCandidates,
  releaseCandidates,
  downloadProxies,
  checkCoreVersion,
  checkShellVersion,
  checkReleaseAssets,
  updateTrust
};
