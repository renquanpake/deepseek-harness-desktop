const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, fs.existsSync(path.join(__dirname, 'package.json')) ? '.' : '..');
const RUNTIME_DIR = path.join(ROOT_DIR, 'dsh-runtime');
const PRESET_PROFILE_DIR = path.join(RUNTIME_DIR, 'default-profile');
const DSH_VERSION = process.env.DSH_VERSION || 'latest';
const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com';

const PREINSTALL_PLUGINS = [
  'dsh-codex-ui',
  'dsh-better-sidebar',
  'dshmarket',
  'dsh-pathlink',
  'dsh-paste-input',
  'dsh-keyboard-history',
  'dsh-checkpoint-rewind',
  'dsh-file-claim'
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

function copyBundledNode() {
  console.log('[prepare-runtime] Bundling standalone console Node runtime to dsh-runtime/node.exe');
  const source = process.execPath;
  const target = path.join(RUNTIME_DIR, 'node.exe');
  if (source === target) {
    return;
  }
  try {
    fs.copyFileSync(source, target);
  } catch (err) {
    console.warn(`[prepare-runtime] Warning: failed to bundle node.exe (${err.message}); falling back to ELECTRON_RUN_AS_NODE`);
  }
}

function installBundledPnpm() {
  console.log('[prepare-runtime] Bundling pnpm into dsh-runtime/node_modules/pnpm');
  const pnpmPkg = path.join(RUNTIME_DIR, 'node_modules', 'pnpm');
  if (fs.existsSync(path.join(pnpmPkg, 'bin', 'pnpm.cjs'))) return;
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

function main() {
  console.log('=== [1/5] Initializing dsh-runtime directory ===');
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

  copyBundledNode();

  console.log(`=== [2/5] Bundling standalone node.exe and pnpm ===`);
  installBundledPnpm();

  console.log(`=== [3/5] Installing @deepseek-ai/dsh@${DSH_VERSION} via npmmirror ===`);
  runCmd(
    `npm install @deepseek-ai/dsh@${DSH_VERSION} --no-audit --no-fund --loglevel=error --registry=${NPM_MIRROR_REGISTRY}`,
    RUNTIME_DIR,
    false
  );

  console.log('=== [4/5] Pre-installing Open-Source Workbench Plugins into Preset Profile ===');
  const dshBin = path.join(
    RUNTIME_DIR,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  );

  for (const plugin of PREINSTALL_PLUGINS) {
    try {
      console.log(`[prepare-runtime] Pre-installing plugin: ${plugin}`);
      execSync(`"${dshBin}" plugin --profile web add ${plugin}`, {
        cwd: RUNTIME_DIR,
        stdio: 'inherit',
        env: {
          ...process.env,
          DSH_HOME: PRESET_PROFILE_DIR
        }
      });
    } catch (e) {
      console.warn(`[prepare-runtime] Skipped optional plugin ${plugin}: ${e.message}`);
    }
  }

  console.log('=== [5/5] Writing preset manifest and finalizing ===');

  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'preset-manifest.json'),
    JSON.stringify({ dshVersion: DSH_VERSION, plugins: PREINSTALL_PLUGINS, builtAt: new Date().toISOString() }, null, 2)
  );

  console.log('Runtime preparation completed successfully.');
}

main();
