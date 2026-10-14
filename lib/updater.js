'use strict';

function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function semverCompare(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

function isNewer(remote, current) {
  return semverCompare(remote, current) > 0;
}

function pickFirstAvailable(candidates) {
  for (const candidate of candidates) {
    if (candidate && (typeof candidate !== 'object' || candidate !== null)) return candidate;
  }
  return null;
}

function decideUpdatePlan({ core, shell }) {
  const hasCore = core && isNewer(core.remoteVersion, core.currentVersion);
  const hasShell = shell && isNewer(shell.remoteVersion, shell.currentVersion);
  return {
    coreNeedsUpdate: !!hasCore,
    shellNeedsUpdate: !!hasShell,
    hasUpdate: !!hasCore || !!hasShell
  };
}

function formatUpdateDescription({ core, shell, plan }) {
  const lines = [];
  if (plan.coreNeedsUpdate) {
    lines.push(`DSH 官方内核：${core.currentVersion} -> ${core.remoteVersion}`);
  }
  if (plan.shellNeedsUpdate) {
    lines.push(`客户端外壳：${shell.currentVersion} -> ${shell.remoteVersion}`);
  }
  return lines.join('\n');
}

function buildProxyedUrls(baseUrl, proxies) {
  if (!baseUrl) return [];
  const urls = [];
  for (const prefix of proxies) {
    if (!prefix) continue;
    let candidate = prefix;
    if (candidate.endsWith('/') && baseUrl.startsWith('http')) {
      candidate = `${prefix}${baseUrl}`;
    } else if (!candidate.endsWith('/') && !baseUrl.startsWith('/')) {
      candidate = `${prefix}/${baseUrl}`;
    }
    urls.push(candidate);
  }
  urls.push(baseUrl);
  return urls;
}

function pickInstallerUrl(assets) {
  if (!Array.isArray(assets)) return null;
  const winExe = assets.find((a) => {
    const name = String((a && a.name) || '').toLowerCase();
    return name.endsWith('.exe') && !name.includes('portable');
  });
  if (winExe && winExe.browser_download_url) return winExe.browser_download_url;
  const anyExe = assets.find((a) => {
    const name = String((a && a.name) || '').toLowerCase();
    return name.endsWith('.exe');
  });
  return anyExe && anyExe.browser_download_url ? anyExe.browser_download_url : null;
}

module.exports = {
  parseSemver,
  semverCompare,
  isNewer,
  pickFirstAvailable,
  decideUpdatePlan,
  formatUpdateDescription,
  buildProxyedUrls,
  pickInstallerUrl
};
