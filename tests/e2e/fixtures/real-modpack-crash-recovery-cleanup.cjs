const path = require('node:path');

function canonicalPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function samePath(left, right) {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  return canonicalLeft !== null && canonicalLeft === canonicalRight;
}

function statusBelongsToInstance(status, instance, lifecycle) {
  if (!status || typeof status !== 'object') return false;
  return status.instanceId === instance.instanceId || samePath(status.targetPath, lifecycle.serverPath);
}

function exactOwnedStatusFromInventory(statuses, instance, lifecycle) {
  if (!Array.isArray(statuses)) {
    throw new TypeError('The complete server-status response is not an array');
  }
  const owned = statuses.filter(status => statusBelongsToInstance(status, instance, lifecycle));
  if (owned.length !== 1) {
    throw new Error('The complete server-status response did not contain exactly one owned server');
  }
  const status = owned[0];
  if (status.instanceId !== instance.instanceId || !samePath(status.targetPath, lifecycle.serverPath)) {
    throw new Error('The owned server status did not match both the exact instance and path');
  }
  if (typeof status.isRunning !== 'boolean') {
    throw new TypeError('The exact owned server status did not expose a boolean running state');
  }
  return status;
}

function cleanupFailure(message, cause = null) {
  return cause instanceof Error
    ? new Error(message, { cause })
    : new Error(message);
}

async function finalizeCrashRecoveryRun({
  page,
  electronApp,
  instance,
  lifecycle,
  scenarioAssertionsPassed,
  stopServer,
  listServerStatuses,
  closeElectron,
  preserveEvidence
}) {
  const failures = [];
  let serverStopConfirmed = false;
  let noOwnedJavaConfirmed = false;
  let electronCloseConfirmed = false;

  if (page && instance && lifecycle && typeof listServerStatuses === 'function') {
    try {
      let ownedStatus = exactOwnedStatusFromInventory(await listServerStatuses(page), instance, lifecycle);
      let stopError = null;
      if (ownedStatus.isRunning) {
        if (typeof stopServer !== 'function') {
          throw new TypeError('The exact running server could not be stopped');
        }
        try {
          await stopServer(page, lifecycle, instance.instanceId);
        } catch (error) {
          stopError = error;
        }
        try {
          ownedStatus = exactOwnedStatusFromInventory(await listServerStatuses(page), instance, lifecycle);
        } catch (error) {
          throw cleanupFailure('The exact owned server could not be re-audited after stop', stopError || error);
        }
      }
      if (ownedStatus.isRunning === false) {
        serverStopConfirmed = true;
        noOwnedJavaConfirmed = true;
      } else {
        throw cleanupFailure('The exact owned server remained running after the final stop', stopError);
      }
    } catch (error) {
      failures.push(cleanupFailure('The final exact server stop and owned-Java absence were not confirmed', error));
    }
  } else {
    failures.push(cleanupFailure('The complete owned server status could not be checked'));
  }

  if (electronApp && typeof closeElectron === 'function') {
    try {
      await closeElectron(electronApp);
      electronCloseConfirmed = true;
    } catch (error) {
      failures.push(cleanupFailure('The production Electron process did not close', error));
    }
  } else {
    failures.push(cleanupFailure('The production Electron process close could not be confirmed'));
  }

  const safeToDelete = scenarioAssertionsPassed === true &&
    serverStopConfirmed &&
    noOwnedJavaConfirmed &&
    electronCloseConfirmed;

  if (!safeToDelete && typeof preserveEvidence === 'function') {
    try {
      await preserveEvidence();
    } catch (error) {
      failures.push(cleanupFailure('Crash-recovery evidence collection failed; the scratch root was preserved', error));
    }
  }

  try {
    await lifecycle.dispose({ preserveRoot: !safeToDelete });
  } catch (error) {
    failures.push(cleanupFailure('The guarded crash-recovery lifecycle could not be disposed', error));
  }

  const result = {
    safeToDelete,
    serverStopConfirmed,
    noOwnedJavaConfirmed,
    electronCloseConfirmed
  };

  if (scenarioAssertionsPassed === true && (!safeToDelete || failures.length > 0)) {
    throw new Error('Real crash-recovery cleanup could not be confirmed safely', {
      cause: new AggregateError(failures, 'Crash-recovery cleanup failures')
    });
  }

  return result;
}

module.exports = {
  finalizeCrashRecoveryRun
};
