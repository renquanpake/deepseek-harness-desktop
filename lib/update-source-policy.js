'use strict';

const OFFICIAL_SOURCES = [
  {
    id: 'npmmirror-registry',
    kind: 'registry',
    url: 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest'
  },
  {
    id: 'npm-registry',
    kind: 'registry',
    url: 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'
  },
  {
    id: 'github-api',
    kind: 'github-api',
    url: 'https://api.github.com/repos/renquanpake/deepseek-harness-desktop/releases/latest'
  },
  {
    id: 'github-raw',
    kind: 'github-raw',
    url: 'https://raw.githubusercontent.com/renquanpake/deepseek-harness-desktop/main/package.json'
  }
];

const THIRD_PARTY_PROXIES = [
  'https://ghfast.top/',
  'https://mirror.ghproxy.com/',
  'https://fastly.jsdelivr.net/'
];

const GITHUB_HOSTS = new Set(['github.com', 'api.github.com', 'raw.githubusercontent.com']);

function sanitizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return { ok: false, reason: 'invalid-url' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'unsupported-protocol' };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: 'invalid-url' };
  }
  const hadCredentials = Boolean(parsed.username || parsed.password);
  parsed.username = '';
  parsed.password = '';
  return { ok: true, url: parsed.href, hadCredentials };
}

function normalizeProxyBase(proxyBase) {
  const sanitized = sanitizeUrl(proxyBase);
  if (!sanitized.ok) return null;
  return sanitized.url.endsWith('/') ? sanitized.url : `${sanitized.url}/`;
}

function buildProxyUrl(proxyBase, officialUrl) {
  const proxy = normalizeProxyBase(proxyBase);
  if (!proxy) return null;

  let official;
  try {
    official = new URL(officialUrl);
  } catch {
    return null;
  }

  if (official.hostname === 'fastly.jsdelivr.net' || proxy.includes('fastly.jsdelivr.net')) {
    if (official.hostname !== 'raw.githubusercontent.com') return null;
    const parts = official.pathname.split('/').filter(Boolean);
    if (parts.length < 4) return null;
    const owner = parts[0];
    const repo = parts[1];
    const ref = parts[2];
    const rest = parts.slice(3).join('/');
    return `https://fastly.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest}`;
  }

  if (!GITHUB_HOSTS.has(official.hostname)) return null;
  return `${proxy}${official.href}`;
}

function defaultSourceEntries() {
  return OFFICIAL_SOURCES.map((source) => ({ id: source.id, kind: source.kind, url: source.url }));
}

function normalizeSourceEntry(source, index) {
  if (typeof source === 'string') {
    return { id: `source-${index}`, kind: 'custom', url: source };
  }
  if (source && typeof source === 'object' && typeof source.url === 'string') {
    return {
      id: source.id || `source-${index}`,
      kind: source.kind || 'custom',
      url: source.url
    };
  }
  return { id: `source-${index}`, kind: 'custom', url: null };
}

function attachMetadata(sources, skipped, allowThirdPartyProxy) {
  Object.defineProperties(sources, {
    sources: { value: sources, enumerable: false, configurable: true },
    skipped: { value: skipped, enumerable: false, configurable: true },
    allowThirdPartyProxy: { value: allowThirdPartyProxy, enumerable: false, configurable: true }
  });
  return sources;
}

function resolveUpdateSources(options = {}) {
  const allowThirdPartyProxy = Boolean(options && options.allowThirdPartyProxy === true);
  const rawSources = Array.isArray(options && options.sources)
    ? options.sources
    : defaultSourceEntries();

  const sources = [];
  const seen = new Set();
  const skipped = [];
  const officialUrls = [];

  rawSources.forEach((rawSource, index) => {
    const source = normalizeSourceEntry(rawSource, index);
    const sanitized = sanitizeUrl(source.url);
    if (!sanitized.ok) {
      skipped.push({ id: source.id, kind: source.kind, url: source.url, reason: sanitized.reason });
      return;
    }
    officialUrls.push(sanitized.url);
    if (!seen.has(sanitized.url)) {
      seen.add(sanitized.url);
      sources.push(sanitized.url);
    }
  });

  if (allowThirdPartyProxy) {
    for (const proxyBase of THIRD_PARTY_PROXIES) {
      for (const officialUrl of officialUrls) {
        const proxied = buildProxyUrl(proxyBase, officialUrl);
        if (!proxied) continue;
        const sanitized = sanitizeUrl(proxied);
        if (!sanitized.ok) {
          skipped.push({ url: proxied, reason: sanitized.reason });
          continue;
        }
        if (!seen.has(sanitized.url)) {
          seen.add(sanitized.url);
          sources.push(sanitized.url);
        }
      }
    }
  }

  return attachMetadata(sources, skipped, allowThirdPartyProxy);
}

module.exports = {
  THIRD_PARTY_PROXIES,
  resolveUpdateSources,
  sanitizeUrl,
  buildProxyUrl
};
