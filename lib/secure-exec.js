'use strict';

const childProcess = require('child_process');

const PROCESS_SCAN_TIMEOUT_MS = 4000;
const PROCESS_SCAN_MAX_BUFFER = 2 * 1024 * 1024;

function assertArgs(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('args must be an array');
  }
  return args;
}

function assertPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`Invalid PID: ${pid}`);
  }
  return pid;
}

function runGit(args, opts = {}) {
  return childProcess.execFileSync('git', assertArgs(args), {
    windowsHide: true,
    ...opts
  });
}

function runReg(args, opts = {}) {
  return childProcess.execFileSync('reg', assertArgs(args), {
    windowsHide: true,
    ...opts
  });
}

function runTasklist(args, opts = {}) {
  return childProcess.execFileSync('tasklist', assertArgs(args), {
    windowsHide: true,
    ...opts
  });
}

function runTaskkill(pid, opts = {}) {
  const targetPid = assertPid(pid);
  return childProcess.execFileSync('taskkill', ['/PID', String(targetPid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
    ...opts
  });
}

function readWindowsProcessCommandLine(pid, opts = {}) {
  const targetPid = assertPid(pid);
  const attempts = [
    {
      command: 'wmic',
      args: ['process', 'where', `ProcessId=${targetPid}`, 'get', 'CommandLine', '/FORMAT:LIST']
    },
    {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter 'ProcessId=${targetPid}' | Select-Object -ExpandProperty CommandLine`
      ]
    }
  ];
  for (const attempt of attempts) {
    try {
      const output = childProcess.execFileSync(attempt.command, attempt.args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: PROCESS_SCAN_TIMEOUT_MS,
        maxBuffer: PROCESS_SCAN_MAX_BUFFER,
        ...opts
      });
      if (output && String(output).trim()) return String(output);
    } catch {
      // wmic 在新版系统上可能已移除，继续尝试下一方式
    }
  }
  return '';
}

module.exports = {
  runGit,
  runReg,
  runTaskkill,
  runTasklist,
  readWindowsProcessCommandLine
};
