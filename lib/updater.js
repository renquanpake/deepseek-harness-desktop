'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const {
  resolveUpdateSources,
  buildProxyUrl,
  THIRD_PARTY_PROXIES
} = require('./update-source-policy');
const {
  verifyManifest,
  verifyManifestFile
} = require('./update-manifest');
const { verifyUpdateManifest, isHttpUrl } = require('./update-trust');

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60000;
const DEFAULT_MAX_REDIRECTS = 5;

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

function isAbsoluteUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function joinRelativeProxy(prefix, baseUrl) {
  if (prefix.endsWith('/') && baseUrl.startsWith('/')) return prefix.slice(0, -1) + baseUrl;
  if (!prefix.endsWith('/') && !baseUrl.startsWith('/')) return `${prefix}/${baseUrl}`;
  return prefix + baseUrl;
}

const INSTALLER_NAME_PATTERN = /^[A-Za-z0-9 ._()@+-]+\.exe$/i;

function resolveInstallerFileName(rawUrl, fallback = 'DeepSeek-Harness-Setup.exe') {
  let candidate = '';
  try {
    const parsed = new URL(rawUrl);
    candidate = decodeURIComponent(path.posix.basename(parsed.pathname));
  } catch {
    candidate = '';
  }
  if (!candidate) return fallback;
  if (!/\.exe$/i.test(candidate)) return null;
  if (!INSTALLER_NAME_PATTERN.test(candidate)) return fallback;
  if (candidate === '.' || candidate === '..') return null;
  return candidate;
}

function buildProxyedUrls(baseUrl, proxies = []) {
  if (!baseUrl) return [];
  // 官方源优先，严防第三方代理供应链投毒
  const urls = [baseUrl];
  const absolute = isAbsoluteUrl(baseUrl);
  for (const prefix of proxies) {
    if (!prefix) continue;
    // 绝对地址统一走 update-source-policy 的代理规则（含 jsdelivr 重写），避免两套拼接逻辑漂移
    const proxied = absolute ? buildProxyUrl(prefix, baseUrl) : joinRelativeProxy(prefix, baseUrl);
    if (proxied && !urls.includes(proxied)) {
      urls.push(proxied);
    }
  }
  return urls;
}

function computeFileSha256(filePath) {
  const crypto = require('crypto');
  const fs = require('fs');
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex').toLowerCase();
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

// Node >=15: 服务端中断响应时客户端请求不触发 'error'，只在响应流上触发
// 'aborted'/'close'（complete=false）。必须监听 res 'close' 并检查 res.complete，
// 否则截断的下载会让 Promise 永不 settle，更新器将挂死且不会回退到下一个镜像源。
function downloadFromUrl(url, destPath, onProgress, opts = {}) {
  const maxRedirects = Number.isFinite(opts.maxRedirects) ? opts.maxRedirects : DEFAULT_MAX_REDIRECTS;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_DOWNLOAD_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let redirects = 0;
    let settled = false;
    let activeReq = null;
    let activeWs = null;

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    const cleanup = () => {
      if (activeReq) {
        try { activeReq.destroy(); } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
      }
      if (activeWs) {
        try { activeWs.close(); } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
      }
    };

    const fetch = (currentUrl) => {
      if (redirects >= maxRedirects) {
        settle(new Error(`Too many redirects for ${url}`));
        return;
      }
      redirects += 1;

      // 每次重定向/尝试都有独立的流与状态；被跳过的尝试不得影响最终结果
      const attempt = { superseded: false, bodyReceived: false };

      let req;
      try {
        req = (currentUrl.startsWith('https:') ? https : http).get(currentUrl, (res) => {
          if (attempt.superseded || settled) {
            res.resume();
            return;
          }
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            attempt.superseded = true;
            res.resume();
            cleanup();
            const redirectUrl = new URL(res.headers.location, currentUrl).toString();
            fetch(redirectUrl);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            attempt.superseded = true;
            res.resume();
            cleanup();
            settle(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
            return;
          }

          // 仅在明确收到 2xx 成功响应后才创建写盘文件流，避免重定向过程中产生 0 字节悬空文件或引发 Windows EBUSY 句柄占用冲突
          const file = fs.createWriteStream(destPath);
          activeWs = file;
          file.on('error', (err) => {
            if (attempt.superseded || settled) return;
            cleanup();
            settle(err);
          });
          file.on('close', () => {
            if (attempt.superseded || settled) return;
            if (attempt.bodyReceived) {
              settle(null, destPath);
            }
          });

          const total = Number(res.headers['content-length'] || 0);
          let received = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            if (typeof onProgress === 'function' && total > 0) {
              const percent = Math.min(99, Math.floor((received / total) * 100));
              onProgress(percent, total, received);
            }
          });
          res.on('end', () => {
            attempt.bodyReceived = true;
          });
          res.on('close', () => {
            if (attempt.superseded || settled) return;
            if (!res.complete) {
              cleanup();
              settle(new Error(`Download aborted: connection closed before response completed (${currentUrl})`));
            }
          });
          res.pipe(file);
        });
      } catch (err) {
        cleanup();
        settle(err);
        return;
      }
      activeReq = req;
      req.setTimeout(timeoutMs, () => {
        if (attempt.superseded || settled || attempt.bodyReceived) return;
        try { req.destroy(new Error(`download timeout after ${timeoutMs}ms`)); } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
      });
      req.on('error', (err) => {
        if (attempt.superseded || settled) return;
        cleanup();
        settle(err);
      });
    };

    fetch(url);
  });
}

function resolveDownloadProxies(opts = {}) {
  if (Array.isArray(opts.proxies)) return opts.proxies;
  return opts.allowThirdPartyProxy === true ? THIRD_PARTY_PROXIES : [];
}

function downloadWithProxies(url, destPath, onProgress, opts = {}) {
  return new Promise((resolve, reject) => {
    const candidates = buildProxyedUrls(url, resolveDownloadProxies(opts));
    let attemptIndex = 0;
    let settled = false;

    const attemptDownload = () => {
      if (settled) return;
      const currentUrl = candidates[attemptIndex];
      if (!currentUrl) {
        settled = true;
        reject(new Error('All download mirrors exhausted'));
        return;
      }
      downloadFromUrl(currentUrl, destPath, onProgress, opts)
        .then(resolve)
        .catch(() => {
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
          attemptIndex += 1;
          attemptDownload();
        });
    };

    attemptDownload();
  });
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

function extractInstallerSha256(releaseData, installerUrl) {
  if (!releaseData || typeof releaseData !== 'object') return null;
  const assets = Array.isArray(releaseData.assets) ? releaseData.assets : [];
  const targetAsset = assets.find((a) => a && a.browser_download_url === installerUrl);
  if (targetAsset && typeof targetAsset.digest === 'string') {
    const m = targetAsset.digest.trim().match(/^sha256:([0-9a-fA-F]{64})$/);
    if (m) return m[1].toLowerCase();
  }
  if (targetAsset && typeof targetAsset.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(targetAsset.sha256.trim())) {
    return targetAsset.sha256.trim().toLowerCase();
  }
  if (typeof releaseData.body === 'string') {
    const fileName = targetAsset && targetAsset.name ? targetAsset.name : '';
    if (fileName) {
      const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lineRegex = new RegExp(`([0-9a-fA-F]{64})\\s+\\*?${escaped}`, 'i');
      const lineMatch = releaseData.body.match(lineRegex);
      if (lineMatch) return lineMatch[1].toLowerCase();
    }
    const genericMatch = releaseData.body.match(/sha256\s*[:=]\s*([0-9a-fA-F]{64})/i);
    if (genericMatch) return genericMatch[1].toLowerCase();
  }
  return null;
}

function verifyInstallerIntegrity(filePath, expectedSha256 = null) {
  const actual = computeFileSha256(filePath);
  if (!actual) {
    return { ok: false, verified: false, reason: 'file-missing', actual: null, expected: expectedSha256 || null };
  }
  if (expectedSha256 && typeof expectedSha256 === 'string' && expectedSha256.trim()) {
    const expected = expectedSha256.replace(/^sha256:/i, '').trim().toLowerCase();
    if (actual !== expected) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
      return { ok: false, verified: false, reason: 'hash-mismatch', actual, expected };
    }
    return { ok: true, verified: true, actual, expected };
  }
  return { ok: true, verified: false, actual, expected: null };
}

async function checkRemoteReleaseAssets(candidateUrls, options = {}) {
  const urls = Array.isArray(candidateUrls) ? candidateUrls : [candidateUrls].filter(Boolean);
  const fetchJson = typeof options.fetchJson === 'function' ? options.fetchJson : httpGetJson;
  const trust = options.trust && options.trust.publicKeyPem ? options.trust : null;
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      if (!data || !Array.isArray(data.assets) || data.assets.length === 0) continue;

      if (trust) {
        const manifestAsset = data.assets.find((asset) => asset && asset.name === 'latest.json');
        if (!manifestAsset) {
          if (trust.requireSignature) continue;
        } else {
          const manifestUrl = manifestAsset.browser_download_url || manifestAsset.url;
          let document;
          try {
            document = await fetchJson(manifestUrl);
          } catch {
            continue;
          }
          const verdict = verifyUpdateManifest(document, trust.publicKeyPem);
          if (!verdict.ok) continue;
          const manifest = verdict.manifest;
          if (!isHttpUrl(manifest.installerUrl)) continue;
          if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) continue;
          return {
            tag: data.tag_name,
            installerUrl: manifest.installerUrl,
            sha256: manifest.sha256.toLowerCase(),
            trusted: true
          };
        }
      }

      const installerUrl = pickInstallerUrl(data.assets);
      if (installerUrl) {
        const sha256 = extractInstallerSha256(data, installerUrl);
        return { tag: data.tag_name, installerUrl, sha256, trusted: false };
      }
    } catch {
    /* 尽力而为：失败不阻断主流程 */
  }
  }
  return null;
}

module.exports = {
  resolveInstallerFileName,
  extractInstallerSha256,
  verifyInstallerIntegrity,
  httpGetJson,
  checkRemoteCoreVersion,
  checkRemoteShellVersion,
  checkRemoteReleaseAssets,
  parseSemver,
  semverCompare,
  isNewer,
  pickFirstAvailable,
  decideUpdatePlan,
  formatUpdateDescription,
  buildProxyedUrls,
  pickInstallerUrl,
  downloadFromUrl,
  computeFileSha256,
  downloadWithProxies,
  resolveUpdateSources,
  THIRD_PARTY_PROXIES,
  verifyManifest,
  verifyManifestFile
};
