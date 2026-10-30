'use strict';

const { execFileSync } = require('node:child_process');

const READ_SCRIPT = "[Environment]::GetEnvironmentVariable('Path','User')";
const WRITE_SCRIPT = '[Environment]::SetEnvironmentVariable("Path", $env:DSH_USER_PATH_VALUE, "User")';

function createWinUserPath({ execFileSyncImpl = execFileSync, powershell = 'powershell.exe', env = process.env } = {}) {
  function readUserPath() {
    const output = execFileSyncImpl(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', READ_SCRIPT],
      { encoding: 'utf8' }
    );
    return String(output || '').trim();
  }

  function writeUserPath(value) {
    execFileSyncImpl(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', WRITE_SCRIPT],
      {
        encoding: 'utf8',
        env: { ...env, DSH_USER_PATH_VALUE: value }
      }
    );
  }

  return { readUserPath, writeUserPath };
}

module.exports = { createWinUserPath, READ_SCRIPT, WRITE_SCRIPT };
