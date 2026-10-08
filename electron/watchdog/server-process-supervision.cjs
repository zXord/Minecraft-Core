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

function requestServerProcessSupervision({ eventBus, identity, onFailure, required }) {
  if (!eventBus || typeof eventBus.emit !== 'function' || !validIdentity(identity) ||
      typeof onFailure !== 'function' || typeof required !== 'boolean') {
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
  const acknowledge = evidence => {
    if (acceptingAcknowledgement && sameIdentity(exactIdentity, evidence) &&
        evidence.ready && typeof evidence.ready.then === 'function') {
      acknowledged = true;
      ready = Promise.resolve(evidence.ready);
    }
  };
  const onSupervisionFailure = evidence => {
    if (failureDelivered || !sameIdentity(exactIdentity, evidence)) return;
    failureDelivered = true;
    onFailure(exactIdentity);
  };

  let emissionError = null;
  try {
    eventBus.emit('server-process-owned', Object.freeze({
      ...exactIdentity,
      acknowledge,
      onSupervisionFailure
    }));
  } catch (error) {
    emissionError = error;
  } finally {
    acceptingAcknowledgement = false;
  }

  if (required && !acknowledged) {
    onSupervisionFailure(exactIdentity);
    throw new Error('Server process supervision was not acknowledged', { cause: emissionError || undefined });
  }
  return Object.freeze({
    acknowledged,
    identity: exactIdentity,
    ready: ready || Promise.resolve(exactIdentity)
  });
}

module.exports = { requestServerProcessSupervision, sameIdentity, validIdentity };
