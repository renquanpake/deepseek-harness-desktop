'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { semverCompare } = require('./updater');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const DEFAULT_ENTRY = path.join('bin', 'dsh.mjs');

// 实测通过的 DSH 内核范围，上限开区间。超出范围时热更新会被拒绝，
// 需要先升级外壳并重新验证，避免上游破坏性变更直接把界面打白。
const SUPPORTED_DSH_RANGE = Object.freeze({ min: '0.1.0-0', max: '0.3.0' });

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(value) {
  return typeof value === 'string' ? value.replace(ANSI_PATTERN, '') : '';
}

function packageRoot(runtimeDir) {
  return path.join(runtimeDir, 'node_modules', ...PACKAGE_NAME.split('/'));
}

function readDshManifest(runtimeDir, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(path.join(packageRoot(runtimeDir), 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readDshVersion(runtimeDir, fsImpl = fs) {
  const manifest = readDshManifest(runtimeDir, fsImpl);
  return manifest && typeof manifest.version === 'string' ? manifest.version : null;
}

function entryCandidates(manifest) {
  const candidates = [];
  const bin = manifest && manifest.bin;
  if (typeof bin === 'string') candidates.push(bin);
  if (bin && typeof bin === 'object' && typeof bin.dsh === 'string') candidates.push(bin.dsh);
  candidates.push(DEFAULT_ENTRY);
  candidates.push(path.join('bin', 'dsh.js'));
  candidates.push(path.join('lib', 'bin.js'));
  return [...new Set(candidates)];
}

function resolveDshEntry(runtimeDir, fsImpl = fs) {
  const manifest = readDshManifest(runtimeDir, fsImpl);
  const root = packageRoot(runtimeDir);
  for (const candidate of entryCandidates(manifest)) {
    const resolved = path.resolve(root, candidate);
    try {
      if (fsImpl.existsSync(resolved) && fsImpl.statSync(resolved).isFile()) return resolved;
    } catch {
      /* 候选路径不可用，继续尝试下一个 */
    }
  }
  return null;
}

function resolveDshCommand(runtimeDir, platform = process.platform, fsImpl = fs) {
  const command = path.join(
    runtimeDir,
    'node_modules',
    '.bin',
    platform === 'win32' ? 'dsh.cmd' : 'dsh'
  );
  try {
    return fsImpl.existsSync(command) ? command : null;
  } catch {
    return null;
  }
}

function buildLaunchArgs({ port, safeMode = false, capabilities = null } = {}) {
  const args = ['web'];
  const supportsNoOpen = !capabilities || capabilities.supportsNoOpen !== false;
  const supportsPort = !capabilities || capabilities.supportsPort !== false;
  if (supportsNoOpen) args.push('--no-open');
  if (supportsPort && Number.isInteger(port) && port > 0) {
    args.push('--port', String(port));
  }
  if (safeMode) args.push('--safe-mode');
  return args;
}

function parseWebHelp(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  const isWebHelp = /--no-open|--port|Serve the DeepSeek Harness/i.test(text);
  if (!isWebHelp) return null;
  return {
    supportsNoOpen: /--no-open/.test(text),
    supportsPort: /--port/.test(text)
  };
}

function probeWebCapabilities({
  entry,
  spawnSyncFn = spawnSync,
  timeoutMs = 5000
} = {}) {
  if (!entry) return null;
  try {
    const result = spawnSyncFn(process.execPath, [entry, 'web', '--help'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    return parseWebHelp(text);
  } catch {
    return null;
  }
}

function adoptCapturedPort(rawUrl, currentPort) {
  const port = portFromUrl(rawUrl);
  if (!Number.isInteger(port)) return null;
  return port === currentPort ? null : port;
}

function portFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function normalizeCandidate(raw) {
  return raw
    .replace(/^[("'`<[]+/, '')
    .replace(/[)"'`>\],.;]+$/, '');
}

function parseAuthenticatedUrl(text, { port } = {}) {
  const cleaned = stripAnsi(text);
  if (!cleaned) return null;
  const expectedPort = Number.isInteger(port) ? String(port) : null;
  const pattern = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/[^\s"'<>]*token=[^\s"'<>)]+/gi;
  let match = pattern.exec(cleaned);
  while (match) {
    const candidate = normalizeCandidate(match[0]);
    const candidatePort = match[1];
    if (!expectedPort || candidatePort === expectedPort) {
      try {
        const parsed = new URL(candidate);
        if (parsed.searchParams.get('token')) return parsed.href;
      } catch {
        /* 忽略无法解析的候选 */
      }
    }
    match = pattern.exec(cleaned);
  }
  return null;
}

function isVersionSupported(version, range = SUPPORTED_DSH_RANGE) {
  if (typeof version !== 'string' || version.length === 0) return false;
  if (semverCompare(version, range.min) < 0) return false;
  if (semverCompare(version, range.max) >= 0) return false;
  return true;
}

function describeSupportRange(range = SUPPORTED_DSH_RANGE) {
  return `>=${range.min} <${range.max}`;
}

module.exports = {
  PACKAGE_NAME,
  SUPPORTED_DSH_RANGE,
  packageRoot,
  readDshManifest,
  readDshVersion,
  resolveDshEntry,
  resolveDshCommand,
  buildLaunchArgs,
  parseWebHelp,
  probeWebCapabilities,
  portFromUrl,
  adoptCapturedPort,
  parseAuthenticatedUrl,
  isVersionSupported,
  describeSupportRange
};
