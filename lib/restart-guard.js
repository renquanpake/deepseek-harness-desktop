'use strict';

function createSingleFlight(fn) {
  let pending = null;
  return function singleFlight(...args) {
    if (pending) return pending;
    let promise;
    try {
      promise = Promise.resolve(fn.apply(this, args));
    } catch (err) {
      promise = Promise.reject(err);
    }
    pending = promise;
    promise.then(
      () => {
        if (pending === promise) pending = null;
      },
      () => {
        if (pending === promise) pending = null;
      }
    );
    return promise;
  };
}

module.exports = { createSingleFlight };
