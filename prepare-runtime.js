const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, fs.existsSync(path.join(__dirname, 'package.json')) ? '.' : '..');
const RUNTIME_DIR = path.join(ROOT_DIR, 'dsh-runtime');
const PRESET_PROFILE_DIR = path.join(RUNTIME_DIR, 'default-profile');
const DSH_VERSION = process.env.DSH_VERSION || 'latest';
const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com';
const PYTHON_MANIFEST_PATH = path.join(ROOT_DIR, 'build', 'runtime-manifest.json');

const PREINSTALL_PLUGINS = [
  'dsh-our-free-model',
  'dshmarket',
  'dsh-codex-ui',
  'dsh-better-sidebar',
  'dsh-pathlink',
  'dsh-paste-input',
  'dsh-keyboard-history',
  'dsh-checkpoint-rewind',
  'dsh-file-claim'
];

const PLUGIN_MARKET_CANDIDATES = [
  'dshmarket',
  '@deepseek-ai/plugin-market',
  'dsh-market'
];

function runCmd(cmd, cwd = RUNTIME_DIR, allowFail = false) {
  console.log(`[prepare-runtime] Executing: ${cmd}`);
  try {
    execSync(cmd, {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        ADBLOCK: '1',
        DISABLE_OPENCOLLECTIVE: '1'
      }
    });
    return true;
  } catch (err) {
    console.warn(`[prepare-runtime] Warning: Command failed -> ${cmd}\nReason: ${err.message}`);
    if (!allowFail) throw err;
    return false;
  }
}


function installBundledPnpm() {
  console.log('[prepare-runtime] Bundling pnpm into dsh-runtime/node_modules/pnpm');
  const pnpmPkg = path.join(RUNTIME_DIR, 'node_modules', 'pnpm');
  const pnpmBinSrc = path.join(pnpmPkg, 'bin', 'pnpm.cjs');
  if (!fs.existsSync(pnpmBinSrc)) {
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      runCmd(
        `npm install pnpm@latest --no-audit --no-fund --loglevel=error --registry=${NPM_MIRROR_REGISTRY}`,
        RUNTIME_DIR,
        true
      );
    } catch (err) {
      console.warn(`[prepare-runtime] Warning: failed to bundle pnpm (${err.message})`);
    }
  }
  if (!fs.existsSync(pnpmBinSrc)) {
    console.warn('[prepare-runtime] Warning: pnpm.cjs not found after install, skipping dual-path copy');
    return;
  }
  const pnpmBinDest = path.join(RUNTIME_DIR, 'pnpm.cjs');
  fs.copyFileSync(pnpmBinSrc, pnpmBinDest);
  const compatDir = path.join(RUNTIME_DIR, 'node_modules', 'pnpm', 'bin');
  fs.mkdirSync(compatDir, { recursive: true });
  fs.copyFileSync(pnpmBinSrc, path.join(compatDir, 'pnpm.cjs'));
}

function preparePythonRuntime() {
  if (process.env.DSH_SKIP_PYTHON === '1') {
    console.log('[prepare-runtime] Skipping python runtime preparation (DSH_SKIP_PYTHON=1)');
    return;
  }
  console.log('=== [6/6] Preparing optional Python runtime ===');
  const ok = runCmd(
    `node scripts/prepare-python-runtime.js --runtime-dir "${RUNTIME_DIR}" --manifest "${PYTHON_MANIFEST_PATH}"`,
    ROOT_DIR,
    true
  );
  if (!ok) {
    console.warn('[prepare-runtime] Python runtime unavailable, packaging continues without it. See docs/runtime.md.');
  }
}

function main() {
  console.log('=== [1/6] Initializing dsh-runtime directory ===');
  if (fs.existsSync(RUNTIME_DIR)) {
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(PRESET_PROFILE_DIR, { recursive: true });

  const runtimePkg = {
    name: 'dsh-bundled-runtime',
    version: '0.2.0',
    private: true,
    description: 'Pre-bundled DeepSeek Harness Runtime with Codex Workbench Preset'
  };
  fs.writeFileSync(path.join(RUNTIME_DIR, 'package.json'), JSON.stringify(runtimePkg, null, 2));

  console.log(`=== [2/6] Bundling standalone pnpm ===`);
  installBundledPnpm();

  console.log(`=== [3/6] Installing @deepseek-ai/dsh@${DSH_VERSION} via npmmirror ===`);
  runCmd(
    `npm install @deepseek-ai/dsh@${DSH_VERSION} --no-audit --no-fund --loglevel=error --registry=${NPM_MIRROR_REGISTRY}`,
    RUNTIME_DIR,
    false
  );

  console.log('=== [4/6] Pre-installing Open-Source Workbench Plugins into Preset Profile ===');
  const dshBin = path.join(
    RUNTIME_DIR,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  );

  const binDir = path.join(RUNTIME_DIR, 'node_modules', '.bin');
  const pnpmBinDir = path.join(RUNTIME_DIR, 'node_modules', 'pnpm', 'bin');
  const extraPath = [binDir, pnpmBinDir, RUNTIME_DIR].join(path.delimiter);
  const pluginEnv = {
    ...process.env,
    PATH: `${extraPath}${path.delimiter}${process.env.PATH || ''}`,
    DSH_HOME: PRESET_PROFILE_DIR,
    NPM_CONFIG_REGISTRY: NPM_MIRROR_REGISTRY,
    COREPACK_NPM_REGISTRY: NPM_MIRROR_REGISTRY,
    NPM_CONFIG_NODE_LINKER: 'hoisted',
    NPM_CONFIG_PACKAGE_IMPORT_METHOD: 'copy',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false'
  };

  const installedPlugins = [];

  const tryInstallPlugin = (name) => {
    console.log(`[prepare-runtime] Pre-installing plugin: ${name}`);
    execSync(`"${dshBin}" plugin --profile web add ${name} --package-import-method=copy --node-linker=hoisted`, {
      cwd: RUNTIME_DIR,
      stdio: 'inherit',
      env: pluginEnv
    });
    installedPlugins.push(name);
  };

  let marketPluginResolved = null;
  for (const candidate of PLUGIN_MARKET_CANDIDATES) {
    try {
      tryInstallPlugin(candidate);
      marketPluginResolved = candidate;
      console.log(`[prepare-runtime] Plugin market resolved via candidate: ${candidate}`);
      break;
    } catch (e) {
      console.warn(`[prepare-runtime] Plugin market candidate ${candidate} unavailable (404/missing), trying next: ${e.message}`);
    }
  }
  if (!marketPluginResolved) {
    console.warn('[prepare-runtime] All plugin market candidates unavailable, skipping market plugin');
  }

  for (const plugin of PREINSTALL_PLUGINS) {
    try {
      tryInstallPlugin(plugin);
    } catch (e) {
      console.warn(`[prepare-runtime] Skipped optional plugin ${plugin}: ${e.message}`);
    }
  }

  console.log('=== [5/6] Recording preset dependencies and writing manifest ===');

  const presetDependencies = {};
  for (const plugin of installedPlugins) {
    presetDependencies[plugin] = '*';
  }
  try {
    const runtimePkgPath = path.join(RUNTIME_DIR, 'package.json');
    const currentPkg = JSON.parse(fs.readFileSync(runtimePkgPath, 'utf8'));
    currentPkg.dependencies = { ...(currentPkg.dependencies || {}), ...presetDependencies };
    fs.writeFileSync(runtimePkgPath, JSON.stringify(currentPkg, null, 2));
    console.log(`[prepare-runtime] Recorded ${Object.keys(presetDependencies).length} preset plugin dependencies in dsh-runtime/package.json`);
  } catch (err) {
    console.warn(`[prepare-runtime] Warning: failed to record preset plugin dependencies (${err.message})`);
  }

  const builtAt = new Date().toISOString();
  const allRequested = [...PREINSTALL_PLUGINS, ...PLUGIN_MARKET_CANDIDATES];
  const manifestData = {
    dshVersion: DSH_VERSION,
    plugins: installedPlugins,
    skipped: allRequested.filter((name) => !installedPlugins.includes(name)),
    pluginMarketCandidates: PLUGIN_MARKET_CANDIDATES,
    builtAt
  };
  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'preset-manifest.json'),
    JSON.stringify(manifestData, null, 2)
  );
  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'preinstalled-plugins.json'),
    JSON.stringify(manifestData, null, 2)
  );

  try {
    const { applyDirectoryPickerPatch } = require('./scripts/patch-dsh-runtime');
    applyDirectoryPickerPatch(RUNTIME_DIR);
  } catch (err) {
    console.warn('[prepare-runtime] Failed to apply directory picker patch:', err.message);
  }

  preparePythonRuntime();

  console.log('Runtime preparation completed successfully.');
}

main();
