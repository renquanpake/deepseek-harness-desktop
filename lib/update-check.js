'use strict';

const { resolveUpdateSources } = require('./update-source-policy');
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
  // 官方源优先；第三方镜像仅在本开关显式开启时参与，防止供应链投毒
  ALLOW_THIRD_PARTY_PROXY: true,
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

async function checkReleaseAssets() {
  return checkRemoteReleaseAssets(releaseCandidates());
}

module.exports = {
  CONFIG,
  coreRegistryCandidates,
  shellManifestCandidates,
  releaseCandidates,
  downloadProxies,
  checkCoreVersion,
  checkShellVersion,
  checkReleaseAssets
};
