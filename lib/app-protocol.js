'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_SCHEME = 'dsh-app';
const APP_HOST = 'app';
const API_PREFIX = '/api/';

const SCHEME_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true
});

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
});

function fail(status, reason) {
  return { ok: false, status, reason };
}

function mimeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function extractRawPath(requestUrl) {
  const schemeIndex = requestUrl.indexOf('://');
  if (schemeIndex === -1) return null;
  const afterAuthority = requestUrl.slice(schemeIndex + 3).split(/[?#]/, 1)[0];
  const pathIndex = afterAuthority.indexOf('/');
  if (pathIndex === -1) return '/';
  return afterAuthority.slice(pathIndex) || '/';
}

function resolveAppRequest(requestUrl, { appRoot } = {}) {
  if (typeof requestUrl !== 'string' || requestUrl.length === 0) {
    return fail(400, 'invalid-url');
  }
  if (typeof appRoot !== 'string' || appRoot.length === 0) {
    return fail(400, 'invalid-app-root');
  }

  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return fail(400, 'invalid-url');
  }

  if (parsed.protocol !== `${APP_SCHEME}:`) return fail(400, 'invalid-scheme');
  if ((parsed.hostname || '').toLowerCase() !== APP_HOST) return fail(403, 'forbidden-host');
  if (parsed.port !== '') return fail(403, 'forbidden-port');
  if (parsed.username || parsed.password) return fail(403, 'forbidden-credentials');

  const rawPath = extractRawPath(requestUrl);
  if (rawPath === null) return fail(400, 'invalid-url');

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return fail(400, 'invalid-encoding');
  }

  if (decodedPath.includes('\0')) return fail(400, 'invalid-path');
  if (/%2e|%2f|%5c/i.test(decodedPath)) return fail(403, 'path-traversal');

  const normalizedSlashes = decodedPath.replace(/\\/g, '/');
  const segments = normalizedSlashes.split('/');
  if (segments.includes('..')) return fail(403, 'path-traversal');
  if (!normalizedSlashes.startsWith('/') || normalizedSlashes.startsWith('//')) {
    return fail(403, 'absolute-path');
  }

  let relativePath = normalizedSlashes.slice(1);
  if (relativePath === '') {
    relativePath = 'index.html';
  } else {
    if (path.win32.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
      return fail(403, 'absolute-path');
    }
    if (relativePath.endsWith('/') || path.posix.extname(relativePath) === '') {
      relativePath = path.posix.join(relativePath, 'index.html');
    }
  }

  const normalizedRelative = path.normalize(relativePath);
  if (
    normalizedRelative === '..' ||
    normalizedRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalizedRelative)
  ) {
    return fail(403, 'path-traversal');
  }

  const root = path.resolve(appRoot);
  const filePath = path.resolve(root, normalizedRelative);
  if (filePath === root || !isPathInside(root, filePath)) {
    return fail(403, 'path-escape');
  }

  return {
    ok: true,
    filePath,
    mime: mimeFor(filePath),
    status: 200
  };
}

function normalizeBackendOrigin(backendOrigin) {
  if (!backendOrigin) return null;
  let parsed;
  try {
    parsed = new URL(backendOrigin);
  } catch {
    throw new TypeError('backendOrigin must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('backendOrigin must use http or https');
  }
  return parsed.origin;
}

function buildCsp({ backendOrigin, dev = false } = {}) {
  const origin = normalizeBackendOrigin(backendOrigin);
  const scriptSrc = ["'self'"];
  const connectSrc = ["'self'"];

  if (dev) scriptSrc.push("'unsafe-eval'");
  if (origin) {
    connectSrc.push(origin);
    if (dev && origin.startsWith('http://')) connectSrc.push(origin.replace(/^http:/, 'ws:'));
    if (dev && origin.startsWith('https://')) connectSrc.push(origin.replace(/^https:/, 'wss:'));
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'"
  ].join('; ');
}

// 后端页面由 DSH 自己下发，强制完整 CSP 有白屏风险；
// 这里只补不依赖脚本/样式加载的收敛指令，并与后端已有策略按键名合并。
const BACKEND_CSP_HARDENING = [
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
];

function buildBackendCsp(existingHeader) {
  const directives = new Map();
  const merge = (policy) => {
    for (const part of String(policy || '').split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const name = trimmed.split(/\s+/)[0].toLowerCase();
      if (!directives.has(name)) directives.set(name, trimmed);
    }
  };
  merge(existingHeader);
  merge(BACKEND_CSP_HARDENING.join('; '));
  return [...directives.values()].join('; ');
}

const BACKEND_CSP_MODES = new Set(['off', 'report', 'enforce']);

function normalizeCspMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return BACKEND_CSP_MODES.has(mode) ? mode : 'off';
}

function buildBackendStrictCsp({ backendOrigin } = {}) {
  const origin = normalizeBackendOrigin(backendOrigin);
  const scriptSrc = ["'self'"];
  const connectSrc = ["'self'"];
  if (origin) {
    connectSrc.push(origin);
    if (origin.startsWith('http://')) connectSrc.push(origin.replace(/^http:/, 'ws:'));
    if (origin.startsWith('https://')) connectSrc.push(origin.replace(/^https:/, 'wss:'));
    connectSrc.push('ws:', 'wss:');
  }
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'"
  ].join('; ');
}

function isAppUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== `${APP_SCHEME}:`) return false;
  if ((parsed.hostname || '').toLowerCase() !== APP_HOST) return false;
  if (parsed.port !== '') return false;
  return !parsed.username && !parsed.password;
}

function createFsAccess(fsImpl) {
  const promises = fsImpl && fsImpl.promises ? fsImpl.promises : {};

  function readFile(target) {
    if (typeof promises.readFile === 'function') return promises.readFile(target);
    if (typeof fsImpl.readFileSync === 'function') return Promise.resolve(fsImpl.readFileSync(target));
    if (typeof fsImpl.readFile === 'function') {
      return new Promise((resolve, reject) => {
        fsImpl.readFile(target, (err, data) => (err ? reject(err) : resolve(data)));
      });
    }
    return Promise.reject(new Error('fsImpl.readFile is unavailable'));
  }

  function realpath(target) {
    if (typeof promises.realpath === 'function') return promises.realpath(target);
    if (typeof fsImpl.realpathSync === 'function') return Promise.resolve(fsImpl.realpathSync(target));
    if (typeof fsImpl.realpath === 'function') {
      return new Promise((resolve, reject) => {
        fsImpl.realpath(target, (err, resolved) => (err ? reject(err) : resolve(resolved)));
      });
    }
    return null;
  }

  return { readFile, realpath };
}

function textResponse(status, reason) {
  return new Response(reason, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff'
    }
  });
}

function errorStatusFor(err) {
  const code = err && err.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return 404;
  if (code === 'EACCES' || code === 'EPERM') return 403;
  return 500;
}

function readContentType(headers) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get('content-type');
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type');
  if (!key) return null;
  const value = headers[key];
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function registerAppSchemePrivileges(protocol) {
  if (!protocol || typeof protocol.registerSchemesAsPrivileged !== 'function') {
    throw new TypeError('protocol.registerSchemesAsPrivileged is required');
  }
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { ...SCHEME_PRIVILEGES } }
  ]);
}

function createAppProtocolHandler({
  protocol,
  net,
  appRoot,
  backendOrigin,
  fsImpl = fs,
  registerPrivileges = true
} = {}) {
  if (!protocol || typeof protocol.handle !== 'function') {
    throw new TypeError('protocol.handle is required');
  }
  if (!net || typeof net.fetch !== 'function') {
    throw new TypeError('net.fetch is required');
  }
  if (typeof appRoot !== 'string' || appRoot.length === 0) {
    throw new TypeError('appRoot is required');
  }

  const origin = normalizeBackendOrigin(backendOrigin);
  const fsAccess = createFsAccess(fsImpl);

  async function handleStatic(request, method) {
    const resolved = resolveAppRequest(request.url, { appRoot });
    if (!resolved.ok) return textResponse(resolved.status, resolved.reason);
    if (method !== 'GET' && method !== 'HEAD') return textResponse(405, 'method-not-allowed');

    try {
      if (typeof fsAccess.realpath === 'function') {
        const realRoot = await fsAccess.realpath(appRoot);
        if (realRoot) {
          const realFile = await fsAccess.realpath(resolved.filePath);
          if (!realFile || !isPathInside(realRoot, realFile)) {
            return textResponse(403, 'symlink-escape');
          }
        }
      }

      const data = await fsAccess.readFile(resolved.filePath);
      const body = method === 'HEAD' ? null : data;
      const length = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': resolved.mime,
          'content-length': String(length),
          'x-content-type-options': 'nosniff'
        }
      });
    } catch (err) {
      return textResponse(errorStatusFor(err), 'static-read-failed');
    }
  }

  async function handleApi(request, parsed) {
    if (!origin) return textResponse(502, 'backend-not-configured');

    const targetUrl = origin + parsed.pathname + parsed.search;
    const method = request.method || 'GET';
    const init = { method, headers: request.headers };
    if (method !== 'GET' && method !== 'HEAD' && request.body) init.body = request.body;

    let upstream;
    try {
      upstream = await net.fetch(targetUrl, init);
    } catch {
      return textResponse(502, 'backend-proxy-failed');
    }

    const headers = new Headers();
    const contentType = readContentType(upstream.headers);
    if (contentType) headers.set('content-type', contentType);

    return new Response(method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  }

  async function handler(request) {
    if (!request || typeof request.url !== 'string') return textResponse(400, 'invalid-url');
    if (!isAppUrl(request.url)) return textResponse(403, 'forbidden-url');

    const parsed = new URL(request.url);
    const method = request.method || 'GET';

    if (parsed.pathname === '/api' || parsed.pathname.startsWith(API_PREFIX)) {
      return handleApi(request, parsed);
    }
    return handleStatic(request, method);
  }

  if (registerPrivileges) registerAppSchemePrivileges(protocol);
  protocol.handle(APP_SCHEME, handler);

  return handler;
}

module.exports = {
  APP_SCHEME,
  APP_HOST,
  API_PREFIX,
  SCHEME_PRIVILEGES,
  mimeFor,
  buildCsp,
  buildBackendCsp,
  buildBackendStrictCsp,
  normalizeCspMode,
  BACKEND_CSP_MODES,
  isAppUrl,
  resolveAppRequest,
  registerAppSchemePrivileges,
  createAppProtocolHandler
};
