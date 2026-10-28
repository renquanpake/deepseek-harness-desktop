'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJsonSafe } = require('../lib/preset-hydrator');

function createPresetPlugins({ getBundledRuntimeDir, localRuntimeDir, registryUrl }) {
  function readFactoryPresetPluginNames() {
    const runtimeDir = getBundledRuntimeDir();
    const manifest = readJsonSafe(path.join(runtimeDir, 'preset-manifest.json'));
    const preinstalled = readJsonSafe(path.join(runtimeDir, 'preinstalled-plugins.json'));
    const factoryPkg = readJsonSafe(path.join(runtimeDir, 'package.json'));
    const names = [
      ...(Array.isArray(manifest.plugins) ? manifest.plugins : []),
      ...(Array.isArray(preinstalled.plugins) ? preinstalled.plugins : []),
      ...Object.keys((factoryPkg && factoryPkg.dependencies) || {})
    ];
    const deduped = [...new Set(names.filter((name) => typeof name === 'string' && name.trim() && !name.startsWith('@deepseek-ai/dsh')))];
    return deduped;
  }

  function readLocalRuntimePkg() {
    return readJsonSafe(path.join(localRuntimeDir, 'package.json')) || {};
  }

  function writeLocalRuntimePkg(pkg) {
    try {
      fs.mkdirSync(localRuntimeDir, { recursive: true });
      fs.writeFileSync(path.join(localRuntimeDir, 'package.json'), JSON.stringify(pkg, null, 2));
      return true;
    } catch (err) {
      console.warn(`[updater] 写入 local-runtime/package.json 失败: ${err.message}`);
      return false;
    }
  }

  function isPresetPluginInstalled(pluginName) {
    return fs.existsSync(path.join(localRuntimeDir, 'node_modules', pluginName));
  }

  function mergeLocalRuntimePresetDependencies(presetPlugins) {
    const pkg = readLocalRuntimePkg();
    const deps = { ...(pkg.dependencies || {}) };
    const added = [];
    for (const pluginName of presetPlugins) {
      if (!(pluginName in deps)) {
        deps[pluginName] = '*';
        added.push(pluginName);
      }
    }
    if (!added.length) return [];
    pkg.dependencies = deps;
    return writeLocalRuntimePkg(pkg) ? added : [];
  }

  function pruneLocalRuntimeDependencies(names) {
    if (!names.length) return;
    const pkg = readLocalRuntimePkg();
    const deps = { ...(pkg.dependencies || {}) };
    for (const name of names) {
      delete deps[name];
    }
    pkg.dependencies = deps;
    writeLocalRuntimePkg(pkg);
  }

  function runPnpmAdd(nodeExe, pnpmCjs, packages) {
    return new Promise((resolve) => {
      const url = registryUrl();
      const args = [
        pnpmCjs,
        'add',
        ...packages,
        `--registry=${url}`,
        '--package-import-method=copy',
        '--node-linker=hoisted'
      ];
      const pnpmProc = spawn(nodeExe, args, {
        cwd: localRuntimeDir,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NPM_CONFIG_REGISTRY: url,
          NPM_CONFIG_PACKAGE_IMPORT_METHOD: 'copy',
          NPM_CONFIG_NODE_LINKER: 'hoisted',
          NPM_CONFIG_AUDIT: 'false',
          NPM_CONFIG_FUND: 'false'
        },
        stdio: 'pipe',
        windowsHide: true
      });
      let stderr = '';
      let settled = false;
      const settle = (ok) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      pnpmProc.stdout.on('data', (chunk) => console.log(`[updater] ${String(chunk)}`));
      pnpmProc.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        console.warn(`[updater] ${String(chunk)}`);
      });
      pnpmProc.on('error', (err) => {
        console.warn(`[updater] pnpm 启动失败: ${err.message}`);
        settle(false);
      });
      pnpmProc.on('exit', (code) => {
        if (code === 0) {
          settle(true);
        } else {
          console.warn(`[updater] pnpm 安装失败 (exit ${code}): ${stderr.slice(0, 500)}`);
          settle(false);
        }
      });
    });
  }

  return {
    readFactoryPresetPluginNames,
    readLocalRuntimePkg,
    writeLocalRuntimePkg,
    isPresetPluginInstalled,
    mergeLocalRuntimePresetDependencies,
    pruneLocalRuntimeDependencies,
    runPnpmAdd
  };
}

module.exports = { createPresetPlugins };
