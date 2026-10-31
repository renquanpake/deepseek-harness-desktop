'use strict';

const { resolveUpdateSources } = require('./update-source-policy');
const {
  checkRemoteCoreVersion,
  checkRemoteShellVersion
} = require('./updater');

const CONFIG = {
  CORE_REGISTRY_SOURCES: [
    { id: 'npmmirror-registry', kind: 'registry', url: 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest' },
    { id: 'npm-registry', kind: 'registry', url: 'https://registry.npmjs.org/@deepseek-ai/dsh/latest' }
  ],
  SHELL_MANIFEST_SOURCES: [
    { id: 'github-raw', kind: 'github-raw', url: 'https://raw.githubusercontent.com/renquanpake/deepseek-harness-desktop/main/package.json' }
  ],
  // 官方源优先；第三方镜像仅在显式设置 DSH_ALLOW_THIRD_PARTY_MIRROR=1 时参与，防止供应链投毒
  ALLOW_THIRD_PARTY_PROXY: /^(1|true|yes)$/i.test(String(process.env.DSH_ALLOW_THIRD_PARTY_MIRROR || '')),
  REPO_URL: 'https://github.com/renquanpake/deepseek-harness-desktop',
  REQUEST_TIMEOUT_MS: 8000,
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

async function checkCoreVersion() {
  return checkRemoteCoreVersion(coreRegistryCandidates());
}

async function checkShellVersion() {
  return checkRemoteShellVersion(shellManifestCandidates());
}

module.exports = {
  CONFIG,
  coreRegistryCandidates,
  shellManifestCandidates,
  checkCoreVersion,
  checkShellVersion
};
