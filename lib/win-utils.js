'use strict';

function toWslPath(winPath) {
  if (typeof winPath !== 'string') return winPath;
  const trimmed = winPath.trim();
  if (!trimmed) return trimmed;

  const isAlreadyQuoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  const cleanPath = isAlreadyQuoted ? trimmed.slice(1, -1).trim() : trimmed;

  const normalized = cleanPath.replace(/\\/g, '/');
  const match = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  let wslPath = normalized;
  if (match) {
    wslPath = `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  }
  return wslPath.includes(' ') ? `"${wslPath}"` : wslPath;
}

module.exports = { toWslPath };
