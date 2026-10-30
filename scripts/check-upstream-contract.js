'use strict';

const path = require('node:path');

const { runContractCheck } = require('../lib/upstream-contract');
const { checkRuntime } = require('./check-runtime-compat');

function parseArgs(argv) {
  const options = { runtimeDir: path.join(process.cwd(), 'dsh-runtime'), timeoutMs: 90_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime-dir') options.runtimeDir = path.resolve(argv[++index] || '');
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index]) || 90_000;
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const compat = checkRuntime({ runtimeDir: options.runtimeDir });
  if (!compat.ok) {
    for (const problem of compat.problems) console.error(`[contract] ${problem}`);
    return 1;
  }
  try {
    const result = await runContractCheck({
      runtimeDir: options.runtimeDir,
      timeoutMs: options.timeoutMs
    });
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`[contract] ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { parseArgs, main };
