'use strict';

const http = require('http');
const https = require('https');

function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null
  };
}

function comparePrerelease(preA, preB) {
  if (preA === preB) return 0;
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const idA = partsA[i];
    const idB = partsB[i];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    if (idA === idB) continue;
    const numA = /^\d+/.test(idA) ? parseInt(idA, 10) : NaN;
    const numB = /^\d+/.test(idB) ? parseInt(idB, 10) : NaN;
    const isNumA = !Number.isNaN(numA);
    const isNumB = !Number.isNaN(numB);
    if (isNumA && isNumB) {
      if (numA !== numB) return numA > numB ? 1 : -1;
    } else if (isNumA && !isNumB) {
      return -1;
    } else if (!isNumA && isNumB) {
      return 1;
    } else {
      return idA < idB ? -1 : 1;
    }
  }
  return 0;
}

function semverCompare(aStr, bStr) {
  const a = parseSemver(aStr);
  const b = parseSemver(bStr);
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease && b.prerelease) {
    return comparePrerelease(a.prerelease, b.prerelease);
  }
  return 0;
}

function isNewer(remote, current) {
  return semverCompare(remote, current) > 0;
}

function pickFirstAvailable(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    if (candidate != null && (typeof candidate !== 'string' || candidate.trim().length > 0)) {
      return candidate;
    }
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

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_MAX_REDIRECT_HOPS = 8;

function httpGetJson(url, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > DEFAULT_MAX_REDIRECT_HOPS) {
      return reject(new Error('Too many redirects (exceeded 8) for ' + url));
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': 'deepseek-harness-desktop/1.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json, text/plain, */*'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(httpGetJson(nextUrl, timeoutMs, redirects + 1));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timeout (' + timeoutMs + 'ms) for ' + url));
    });
  });
}

async function checkRemoteCoreVersion(candidateUrls) {
  const urls = Array.isArray(candidateUrls) ? candidateUrls : [candidateUrls].filter(Boolean);
  for (const url of urls) {
    try {
      const data = await httpGetJson(url);
      if (data && data.version) return data.version;
    } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
  }
  return null;
}

async function checkRemoteShellVersion(manifestUrls, releaseUrls = []) {
  const releases = Array.isArray(releaseUrls) ? releaseUrls : [releaseUrls].filter(Boolean);
  for (const url of releases) {
    try {
      const data = await httpGetJson(url);
      if (data && data.tag_name) {
        const version = String(data.tag_name).replace(/^v/, '');
        if (version) return version;
      }
    } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
  }
  const urls = Array.isArray(manifestUrls) ? manifestUrls : [manifestUrls].filter(Boolean);
  for (const url of urls) {
    try {
      const data = await httpGetJson(url);
      if (data && data.version) return data.version;
    } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
  }
  return null;
}

module.exports = {
  httpGetJson,
  checkRemoteCoreVersion,
  checkRemoteShellVersion,
  parseSemver,
  semverCompare,
  isNewer,
  pickFirstAvailable,
  decideUpdatePlan,
  formatUpdateDescription
};
