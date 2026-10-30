'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const options = {
    privateKey: path.join(process.cwd(), 'update-signing-key.pem'),
    publicKey: path.join(process.cwd(), 'build', 'update-public-key.pem'),
    force: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--private') options.privateKey = path.resolve(argv[++index]);
    else if (arg === '--public') options.publicKey = path.resolve(argv[++index]);
    else if (arg === '--force') options.force = true;
  }
  return options;
}

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

function run(argv = process.argv.slice(2), fsImpl = fs) {
  const options = parseArgs(argv);
  if (fsImpl.existsSync(options.privateKey) && !options.force) {
    console.error(`[keygen] 私钥已存在，拒绝覆盖: ${options.privateKey}（使用 --force 可覆盖）`);
    return 1;
  }
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  fsImpl.mkdirSync(path.dirname(options.privateKey), { recursive: true });
  fsImpl.mkdirSync(path.dirname(options.publicKey), { recursive: true });
  fsImpl.writeFileSync(options.privateKey, privateKeyPem, { mode: 0o600 });
  fsImpl.writeFileSync(options.publicKey, publicKeyPem);
  console.log(`[keygen] 私钥: ${options.privateKey}（不要提交到仓库）`);
  console.log(`[keygen] 公钥: ${options.publicKey}（随安装包发布）`);
  return 0;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = { parseArgs, generateKeypair, run };
