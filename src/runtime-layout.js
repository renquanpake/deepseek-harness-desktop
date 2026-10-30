'use strict';

const fs = require('fs');
const path = require('path');
const {
  resolveDshEntry,
  resolveDshCommand,
  readDshVersion
} = require('../lib/dsh-adapter');

function createRuntimeLayout({ localRuntimeDir, appDir = __dirname }) {
  function getBundledRuntimeDir() {
    const resources = process.resourcesPath;
    if (typeof resources === 'string' && resources) {
      const unpackedPath = path.join(resources, 'app.asar.unpacked', 'dsh-runtime');
      if (fs.existsSync(unpackedPath)) return unpackedPath;
      const extraResPath = path.join(resources, 'dsh-runtime');
      if (fs.existsSync(extraResPath)) return extraResPath;
    }
    return path.join(appDir, 'dsh-runtime');
  }

  function getLocalRuntimeDshCli() {
    return resolveDshEntry(localRuntimeDir) || path.join(localRuntimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs');
  }

  function isLocalRuntimeUsable() {
    return Boolean(resolveDshEntry(localRuntimeDir) || resolveDshCommand(localRuntimeDir));
  }

  function getLocalDshVersion() {
    return readDshVersion(localRuntimeDir);
  }

  function getBundledNodeExe() {
    const bundledNode = path.join(getBundledRuntimeDir(), 'node.exe');
    if (fs.existsSync(bundledNode)) return bundledNode;
    return process.execPath;
  }

  function getBundledPnpmCjs() {
    const runtimeDir = getBundledRuntimeDir();
    const candidates = [
      path.join(runtimeDir, 'pnpm.cjs'),
      path.join(runtimeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      path.join(runtimeDir, 'node_modules', 'pnpm', 'dist', 'pnpm.cjs')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  function getRuntimeBinDirs() {
    const dirs = [];
    const nodeExe = getBundledNodeExe();
    if (nodeExe && path.basename(nodeExe).toLowerCase() === 'node.exe') {
      dirs.push(path.dirname(nodeExe));
    }
    const pnpmCjs = getBundledPnpmCjs();
    if (pnpmCjs) dirs.push(path.dirname(pnpmCjs));
    return dirs;
  }

  function getCurrentDshVersion(runtimeDir) {
    const source = path.resolve(runtimeDir) === path.resolve(localRuntimeDir) ? 'hot-update' : 'factory';
    return { version: readDshVersion(runtimeDir) || 'unknown', source };
  }

  return {
    getBundledRuntimeDir,
    getLocalRuntimeDshCli,
    isLocalRuntimeUsable,
    getLocalDshVersion,
    getBundledNodeExe,
    getBundledPnpmCjs,
    getRuntimeBinDirs,
    getCurrentDshVersion
  };
}

module.exports = { createRuntimeLayout };
