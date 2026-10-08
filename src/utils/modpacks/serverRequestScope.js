const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

function validServerId(value) {
  return value === '' || (typeof value === 'string' && SERVER_ID.test(value));
}

export function createServerRequestScope(initialServerId = '') {
  if (!validServerId(initialServerId)) throw new TypeError('Server request scope is invalid');
  let serverId = initialServerId;
  let epoch = 0;

  return Object.freeze({
    get serverId() { return serverId; },
    get epoch() { return epoch; },
    activate(nextServerId) {
      if (!validServerId(nextServerId)) throw new TypeError('Server request scope is invalid');
      const changed = nextServerId !== serverId;
      if (changed) {
        serverId = nextServerId;
        epoch += 1;
      }
      return Object.freeze({ changed, serverId, epoch });
    },
    begin() {
      return Object.freeze({ serverId, epoch });
    },
    isCurrent(token, visibleServerId = serverId) {
      return Boolean(token && token.serverId === serverId && token.epoch === epoch && visibleServerId === serverId);
    }
  });
}

export function createRetryableReservationRelease(releaseReservation) {
  if (typeof releaseReservation !== 'function') throw new TypeError('Reservation release is invalid');
  let active = null;

  return function release(instanceId) {
    if (typeof instanceId !== 'string' || !SERVER_ID.test(instanceId)) {
      return Promise.reject(new TypeError('Reservation release is invalid'));
    }
    if (active) {
      if (active.instanceId !== instanceId) {
        return Promise.reject(new TypeError('Another reservation release is already active'));
      }
      return active.promise;
    }

    const record = { instanceId, promise: null };
    record.promise = Promise.resolve()
      .then(() => releaseReservation(instanceId))
      .finally(() => {
        if (active === record) active = null;
      });
    active = record;
    return record.promise;
  };
}

export function isNewServerDestinationRecoveryOutcome(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return false;
    const errorCode = Object.getOwnPropertyDescriptor(value, 'errorCode');
    const failureReason = Object.getOwnPropertyDescriptor(value, 'failureReason');
    return Boolean(
      errorCode && Object.hasOwn(errorCode, 'value') &&
      failureReason && Object.hasOwn(failureReason, 'value') &&
      errorCode.value === 'RECOVERY_REQUIRED' &&
      failureReason.value === 'destination-recovery'
    );
  } catch {
    return false;
  }
}

function ownDataValue(value, key) {
  if (!value || typeof value !== 'object' || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

export function filterPendingNewServerRecoveryRecords(value) {
  try {
    const records = Array.isArray(value) ? value : ownDataValue(value, 'items');
    if (!Array.isArray(records)) return [];
    return records.filter(record =>
      record && typeof record === 'object' && !Array.isArray(record) &&
      Object.getPrototypeOf(record) === Object.prototype &&
      ownDataValue(record, 'visibilityScope') === 'pending-new-server'
    );
  } catch {
    return [];
  }
}
