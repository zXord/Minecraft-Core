'use strict';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function validIdentity(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.instanceId === 'string' && ID_PATTERN.test(value.instanceId) &&
    typeof value.operationId === 'string' && ID_PATTERN.test(value.operationId) &&
    Number.isSafeInteger(value.pid) && value.pid > 0;
}

function sameIdentity(left, right) {
  return validIdentity(left) && validIdentity(right) &&
    left.instanceId === right.instanceId && left.operationId === right.operationId && left.pid === right.pid;
}

// onDeadline (optional) asks the supervisor to only report a missed ACK
// deadline and keep the watcher alive, so a late ACK can still arm it.
function requestServerProcessSupervision({ eventBus, identity, onFailure, required, onDeadline }) {
  if (!eventBus || typeof eventBus.emit !== 'function' || !validIdentity(identity) ||
      typeof onFailure !== 'function' || typeof required !== 'boolean' ||
      (onDeadline !== undefined && typeof onDeadline !== 'function')) {
    throw new TypeError('Server process supervision request is invalid');
  }
  const exactIdentity = Object.freeze({
    instanceId: identity.instanceId,
    operationId: identity.operationId,
    pid: identity.pid
  });
  let acceptingAcknowledgement = true;
  let acknowledged = false;
  let ready = null;
  let failureDelivered = false;
  let deadlineDelivered = false;
  const acknowledge = evidence => {
    if (acceptingAcknowledgement && sameIdentity(exactIdentity, evidence) &&
        evidence.ready && typeof evidence.ready.then === 'function') {
      acknowledged = true;
      ready = Promise.resolve(evidence.ready);
    }
  };
  const onSupervisionFailure = (evidence, reason) => {
    if (failureDelivered || !sameIdentity(exactIdentity, evidence)) return;
    failureDelivered = true;
    onFailure(exactIdentity, reason);
  };
  const onSupervisionDeadline = (evidence, reason) => {
    if (deadlineDelivered || failureDelivered || !sameIdentity(exactIdentity, evidence)) return;
    deadlineDelivered = true;
    onDeadline(exactIdentity, reason);
  };

  let emissionError = null;
  try {
    eventBus.emit('server-process-owned', Object.freeze({
      ...exactIdentity,
      acknowledge,
      onSupervisionFailure,
      ...(onDeadline ? { onSupervisionDeadline } : {})
    }));
  } catch (error) {
    emissionError = error;
  } finally {
    acceptingAcknowledgement = false;
  }

  if (required && !acknowledged) {
    const error = new Error('Server process supervision was not acknowledged', { cause: emissionError || undefined });
    onSupervisionFailure(exactIdentity, error);
    throw error;
  }
  return Object.freeze({
    acknowledged,
    identity: exactIdentity,
    ready: ready || Promise.resolve(exactIdentity)
  });
}

module.exports = { requestServerProcessSupervision, sameIdentity, validIdentity };
