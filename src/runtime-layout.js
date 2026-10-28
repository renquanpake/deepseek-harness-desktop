'use strict';

const fs = require('fs');
const path = require('path');

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
    return path.join(localRuntimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs');
  }

  function isLocalRuntimeUsable() {
    return fs.existsSync(getLocalRuntimeDshCli());
  }

  function getLocalDshVersion() {
    const pkgPath = path.join(localRuntimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    try {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
    } catch {
      return null;
    }
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
    const pkgPath = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return { version: pkg.version || 'unknown', source };
    } catch {
      return { version: 'unknown', source };
    }
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
