'use strict';

function pickWorkspaceMode(argv) {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--open-dir' && argv[i + 1]) {
      return { mode: 'open-dir', value: argv[i + 1] };
    }
    if ((arg === '--worktree-dir' || arg === '--worktree') && argv[i + 1]) {
      return { mode: 'worktree-dir', value: argv[i + 1] };
    }
  }
  return { mode: null, value: null };
}

module.exports = { pickWorkspaceMode };
