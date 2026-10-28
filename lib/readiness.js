'use strict';

function isBackendReadyStatus(statusCode) {
  return Number.isInteger(statusCode) && statusCode < 500;
}

module.exports = { isBackendReadyStatus };
