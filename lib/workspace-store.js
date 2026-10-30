'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_ENTRIES = 12;
const STORE_VERSION = 1;

function samePath(left, right, platform) {
  const normalize = (value) => {
    const trimmed = String(value).replace(/[\\/]+$/, '');
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(left) === normalize(right);
}

function sanitizeEntry(entry, platform, pathImpl) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.path !== 'string' || entry.path.length === 0) return null;
  if (!pathImpl.isAbsolute(entry.path)) return null;
  const timestamp = typeof entry.lastOpenedAt === 'string' ? entry.lastOpenedAt : null;
  const name = typeof entry.name === 'string' && entry.name.length > 0
    ? entry.name
    : pathImpl.basename(entry.path);
  return {
    path: pathImpl.resolve(entry.path),
    name,
    lastOpenedAt: timestamp || new Date(0).toISOString(),
    platform
  };
}

function createWorkspaceStore({
  filePath,
  fsImpl = fs,
  pathImpl = path,
  platform = process.platform,
  now = Date.now,
  maxEntries = DEFAULT_MAX_ENTRIES,
  log = console
}) {
  if (!filePath) throw new TypeError('filePath is required');

  function emptyState() {
    return { version: STORE_VERSION, workspaces: [] };
  }

  function readState() {
    let raw;
    try {
      raw = fsImpl.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return emptyState();
      log.warn(`[workspace-store] 读取最近工作区失败: ${err.message}`);
      return emptyState();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn('[workspace-store] 最近工作区文件不是合法 JSON，已忽略');
      return emptyState();
    }
    if (!parsed || !Array.isArray(parsed.workspaces)) return emptyState();
    const workspaces = [];
    const seen = new Set();
    for (const entry of parsed.workspaces) {
      const sanitized = sanitizeEntry(entry, platform, pathImpl);
      if (!sanitized) continue;
      const key = platform === 'win32' ? sanitized.path.toLowerCase() : sanitized.path;
      if (seen.has(key)) continue;
      seen.add(key);
      workspaces.push(sanitized);
    }
    workspaces.sort((left, right) => String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt)));
    return { version: STORE_VERSION, workspaces: workspaces.slice(0, maxEntries) };
  }

  function writeState(state) {
    try {
      fsImpl.mkdirSync(pathImpl.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp`;
      const payload = {
        version: STORE_VERSION,
        workspaces: state.workspaces.map((entry) => ({
          path: entry.path,
          name: entry.name,
          lastOpenedAt: entry.lastOpenedAt
        }))
      };
      fsImpl.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fsImpl.renameSync(tempPath, filePath);
      return true;
    } catch (err) {
      log.warn(`[workspace-store] 写入最近工作区失败: ${err.message}`);
      return false;
    }
  }

  function toList(state) {
    return state.workspaces.map((entry) => ({
      path: entry.path,
      name: entry.name,
      lastOpenedAt: entry.lastOpenedAt
    }));
  }

  function list() {
    return toList(readState());
  }

  function touch(dir) {
    if (typeof dir !== 'string' || dir.length === 0) return list();
    const resolved = pathImpl.resolve(dir);
    const state = readState();
    const timestamp = new Date(now()).toISOString();
    const existing = state.workspaces.find((entry) => samePath(entry.path, resolved, platform));
    if (existing) {
      existing.lastOpenedAt = timestamp;
      existing.name = pathImpl.basename(resolved);
    } else {
      state.workspaces.unshift({
        path: resolved,
        name: pathImpl.basename(resolved),
        lastOpenedAt: timestamp,
        platform
      });
    }
    state.workspaces.sort((left, right) => String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt)));
    state.workspaces = state.workspaces.slice(0, maxEntries);
    writeState(state);
    return toList(state);
  }

  function remove(dir) {
    const resolved = pathImpl.resolve(dir);
    const state = readState();
    const remaining = state.workspaces.filter((entry) => !samePath(entry.path, resolved, platform));
    if (remaining.length === state.workspaces.length) return toList(state);
    writeState({ ...state, workspaces: remaining });
    return toList({ ...state, workspaces: remaining });
  }

  function clear() {
    writeState(emptyState());
    return [];
  }

  return { list, touch, remove, clear, getFilePath: () => filePath };
}

module.exports = { createWorkspaceStore, DEFAULT_MAX_ENTRIES, STORE_VERSION };
