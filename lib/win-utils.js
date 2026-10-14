'use strict';

function toWslPath(winPath) {
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (match) {
    return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  }
  return normalized;
}

module.exports = { toWslPath };
