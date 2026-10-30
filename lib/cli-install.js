'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LAUNCHER_NAME = 'dsh.cmd';

function buildLauncherContent({ nodeExe, dshEntry }) {
  if (!nodeExe || !dshEntry) throw new TypeError('nodeExe and dshEntry are required');
  return [
    '@echo off',
    'setlocal',
    `"${nodeExe}" "${dshEntry}" %*`,
    ''
  ].join('\r\n');
}

function splitPath(value) {
  return String(value || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function samePathEntry(left, right) {
  return left.replace(/[\\/]+$/, '').toLowerCase() === right.replace(/[\\/]+$/, '').toLowerCase();
}

function computePathUpdate(currentPath, binDir) {
  const entries = splitPath(currentPath);
  if (entries.some((entry) => samePathEntry(entry, binDir))) {
    return { changed: false, value: entries.join(';') };
  }
  entries.push(binDir);
  return { changed: true, value: entries.join(';') };
}

function removePathEntry(currentPath, binDir) {
  const entries = splitPath(currentPath);
  const remaining = entries.filter((entry) => !samePathEntry(entry, binDir));
  return {
    changed: remaining.length !== entries.length,
    value: remaining.join(';')
  };
}

function createCliInstaller({
  binDir,
  getNodeExe,
  getDshEntry,
  readUserPath,
  writeUserPath,
  fsImpl = fs,
  platform = process.platform,
  log = console
}) {
  const launcherPath = path.join(binDir, LAUNCHER_NAME);

  function isSupported() {
    return platform === 'win32';
  }

  function resolvePaths() {
    const nodeExe = typeof getNodeExe === 'function' ? getNodeExe() : getNodeExe;
    const dshEntry = typeof getDshEntry === 'function' ? getDshEntry() : getDshEntry;
    return { nodeExe, dshEntry };
  }

  function status() {
    const { nodeExe, dshEntry } = resolvePaths();
    let inPath = false;
    let pathValue = '';
    try {
      pathValue = readUserPath();
      inPath = splitPath(pathValue).some((entry) => samePathEntry(entry, binDir));
    } catch (err) {
      log.warn(`[cli-install] 读取用户 PATH 失败: ${err.message}`);
    }
    return {
      supported: isSupported(),
      installed: Boolean(fsImpl.existsSync(launcherPath) && inPath),
      launcherExists: Boolean(fsImpl.existsSync(launcherPath)),
      inPath,
      launcherPath,
      binDir,
      nodeExe,
      dshEntry,
      runtimePresent: Boolean(nodeExe && dshEntry && fsImpl.existsSync(dshEntry))
    };
  }

  function writeLauncher() {
    const { nodeExe, dshEntry } = resolvePaths();
    if (!nodeExe || !dshEntry) return { ok: false, reason: 'missing-runtime' };
    if (!fsImpl.existsSync(dshEntry)) return { ok: false, reason: 'missing-runtime', dshEntry };
    fsImpl.mkdirSync(binDir, { recursive: true });
    fsImpl.writeFileSync(launcherPath, buildLauncherContent({ nodeExe, dshEntry }), 'utf8');
    return { ok: true };
  }

  function install() {
    if (!isSupported()) return { ok: false, reason: 'unsupported-platform' };
    const written = writeLauncher();
    if (!written.ok) return written;
    const current = readUserPath();
    const update = computePathUpdate(current, binDir);
    if (update.changed) writeUserPath(update.value);
    return {
      ok: true,
      pathChanged: update.changed,
      launcherPath,
      binDir
    };
  }

  function repair() {
    return install();
  }

  function remove() {
    if (!isSupported()) return { ok: false, reason: 'unsupported-platform' };
    let launcherRemoved = false;
    if (fsImpl.existsSync(launcherPath)) {
      fsImpl.unlinkSync(launcherPath);
      launcherRemoved = true;
    }
    const update = removePathEntry(readUserPath(), binDir);
    if (update.changed) writeUserPath(update.value);
    return { ok: true, launcherRemoved, pathChanged: update.changed };
  }

  return { install, repair, remove, status, isSupported, getLauncherPath: () => launcherPath };
}

module.exports = {
  LAUNCHER_NAME,
  buildLauncherContent,
  computePathUpdate,
  removePathEntry,
  createCliInstaller
};
