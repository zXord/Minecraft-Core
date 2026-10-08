'use strict';

// In-process authority only: an error flag or renderer-provided promise cannot
// authorize deletion of files still owned by a runtime worker.
const quiescenceByError = new WeakMap();

function retainRuntimeWorkerQuiescence(error, closed) {
  error.preserveWorkspace = true;
  quiescenceByError.set(error, Promise.resolve(closed).then(value => value === true, () => false));
  return error;
}

async function waitForRuntimeWorkerQuiescence(error) {
  if (error?.preserveWorkspace !== true) return;
  const closed = quiescenceByError.get(error);
  if (!closed || await closed !== true) {
    const failure = new Error('Runtime worker shutdown could not be proven; candidate cleanup is still pending.', { cause: error });
    failure.code = 'RECOVERY_REQUIRED';
    failure.preserveWorkspace = true;
    throw failure;
  }
}

module.exports = { retainRuntimeWorkerQuiescence, waitForRuntimeWorkerQuiescence };
