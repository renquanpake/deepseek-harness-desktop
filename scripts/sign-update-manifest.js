'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { signManifest } = require('../lib/update-manifest');
const { verifyUpdateManifest } = require('../lib/update-trust');

function parseArgs(argv) {
  const options = {
    tag: '',
    version: '',
    installer: '',
    repo: '',
    key: '',
    out: '',
    publicKey: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tag') options.tag = argv[++index] || '';
    else if (arg === '--version') options.version = argv[++index] || '';
    else if (arg === '--installer') options.installer = path.resolve(argv[++index] || '');
    else if (arg === '--repo') options.repo = argv[++index] || '';
    else if (arg === '--key') options.key = path.resolve(argv[++index] || '');
    else if (arg === '--out') options.out = path.resolve(argv[++index] || '');
    else if (arg === '--public-key') options.publicKey = path.resolve(argv[++index] || '');
  }
  if (!options.out) options.out = path.join(path.dirname(options.installer || '.'), 'latest.json');
  return options;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function buildInstallerUrl(repo, tag, installerPath) {
  const name = path.basename(installerPath);
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function buildManifest({ version, tag, repo, installerPath, sha256, now = new Date() }) {
  return {
    version,
    tag,
    installerUrl: buildInstallerUrl(repo, tag, installerPath),
    sha256,
    createdAt: now.toISOString()
  };
}

function buildSignedDocument(manifest, privateKeyPem) {
  return {
    manifest,
    signature: signManifest(manifest, privateKeyPem)
  };
}

function run(argv = process.argv.slice(2), fsImpl = fs) {
  const options = parseArgs(argv);
  const missing = ['tag', 'version', 'installer', 'repo', 'key'].filter((name) => !options[name]);
  if (missing.length) {
    console.error(`[sign-manifest] 缺少参数: ${missing.join(', ')}`);
    return 2;
  }
  if (!fsImpl.existsSync(options.installer)) {
    console.error(`[sign-manifest] 安装包不存在: ${options.installer}`);
    return 2;
  }
  const privateKeyPem = fsImpl.readFileSync(options.key, 'utf8');
  const sha256 = sha256File(options.installer);
  const manifest = buildManifest({
    version: options.version,
    tag: options.tag,
    repo: options.repo,
    installerPath: options.installer,
    sha256
  });
  const document = buildSignedDocument(manifest, privateKeyPem);

  if (options.publicKey && fsImpl.existsSync(options.publicKey)) {
    const verdict = verifyUpdateManifest(document, fsImpl.readFileSync(options.publicKey, 'utf8'));
    if (!verdict.ok) {
      console.error(`[sign-manifest] 自检失败: ${verdict.reason}`);
      return 1;
    }
  } else if (options.publicKey) {
    console.warn(`[sign-manifest] 未找到公钥 ${options.publicKey}，跳过签名自检`);
  }

  fsImpl.mkdirSync(path.dirname(options.out), { recursive: true });
  fsImpl.writeFileSync(options.out, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`[sign-manifest] 已写入 ${options.out}`);
  console.log(`[sign-manifest] sha256=${sha256}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = { parseArgs, sha256File, buildInstallerUrl, buildManifest, buildSignedDocument, run };
