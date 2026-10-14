'use strict';

const MAX_CRASH_RESTARTS = 5;

function decideRestart(state) {
  const max = state.max === undefined ? MAX_CRASH_RESTARTS : state.max;
  if (state.isQuitting) return { action: 'ignore', delayMs: 0, failures: state.failures };
  if (state.killedByUs) return { action: 'ignore', delayMs: 0, failures: 0 };
  if (state.code === 0) return { action: 'ignore', delayMs: 0, failures: state.failures };
  if (state.failures >= max) {
    return { action: 'give-up', delayMs: 0, failures: state.failures };
  }
  const delayMs = Math.min(1500 * 2 ** state.failures, 15000);
  return { action: 'restart', delayMs, failures: state.failures + 1 };
}

module.exports = { decideRestart, MAX_CRASH_RESTARTS };
