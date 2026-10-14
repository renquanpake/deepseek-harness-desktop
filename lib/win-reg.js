'use strict';

function runRegCommands(commands, exec, warn) {
  let ok = 0;
  let failed = 0;
  for (const cmd of commands) {
    try {
      exec(cmd);
      ok += 1;
    } catch (err) {
      failed += 1;
      warn(cmd, err);
    }
  }
  return { ok, failed, total: commands.length };
}

module.exports = { runRegCommands };
