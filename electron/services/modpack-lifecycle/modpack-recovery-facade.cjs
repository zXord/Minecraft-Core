const crypto = require('node:crypto');

const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { legacyMayHaveRuntimeWriters, normalizeRuntimeWriterAuthority } = require('./server-runtime-writer-authority.cjs');

const ID_PATTERN = /^recovery-[a-f0-9]{32}$/;
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLEANUP_PHASES = new Set(['committed-healthy', 'cleanup', 'cleanup-pending']);
const ROLLBACK_SWAP_STEPS = new Set(['live-moved', 'candidate-published', 'failed-canonical-moved', 'rollback-restored']);
const PENDING_NEW_SERVER_ACTION_ID = 'resolve-interrupted-setup';

function invalid() {
  return new ModpackError('INVALID_REQUEST', 'The recovery action is invalid');
}

function stale() {
  return new ModpackError('PLAN_STALE', 'The recovery action is no longer available');
}

function requireMethod(value, method) {
  if (!value || typeof value[method] !== 'function') throw invalid();
}

function recoveryIdFor(jobId) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId)) throw invalid();
  return `recovery-${crypto.createHash('sha256').update(`modpack-recovery\0${jobId}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function safeServerId(record, recoveryId) {
  const value = record?.target?.stableServerId;
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    ? value
    : `pending-${recoveryId.slice('recovery-'.length)}`;
}

function visibilityScopeFor(record, canExposePendingNewServer) {
  if (record?.target?.kind !== 'new' || record?.outcome?.registration?.complete === true) {
    return 'registered-server';
  }
  try {
    return canExposePendingNewServer(record) === true ? 'pending-new-server' : 'registered-server';
  } catch {
    return 'registered-server';
  }
}

function actionsFor(record, visibilityScope) {
  if (runtimeProofRequired(record)) {
    return [{ actionId: visibilityScope === 'pending-new-server' ? PENDING_NEW_SERVER_ACTION_ID : 'retry-recovery',
      label: 'Recheck runtime shutdown', recommended: true }];
  }
  if (record?.target?.kind === 'existing' && CLEANUP_PHASES.has(record.phase)) {
    return [{ actionId: 'retry-cleanup', label: 'Retry safe cleanup', recommended: true }];
  }
  const pendingNewServer = visibilityScope === 'pending-new-server';
  const actions = [{
    actionId: pendingNewServer ? PENDING_NEW_SERVER_ACTION_ID : 'retry-recovery',
    label: pendingNewServer
      ? 'Resolve interrupted setup'
      : 'Retry verified recovery',
    recommended: true
  }];
  if (record?.target?.kind === 'existing' && ROLLBACK_SWAP_STEPS.has(record.swapStep)) {
    actions.push({ actionId: 'rollback-server', label: 'Restore prior server', recommended: false });
  }
  return actions;
}

function assertRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.operationKind !== 'string' || typeof record.phase !== 'string' ||
      typeof record.swapStep !== 'string' || !record.target ||
      !['new', 'existing'].includes(record.target.kind)) throw invalid();
  recoveryIdFor(record.jobId);
  return record;
}

function titleFor(record) {
  const operation = record.operationKind.replaceAll('-', ' ');
  return `Recover ${operation} operation`;
}

function summaryFor(record) {
  if (runtimeProofRequired(record)) return 'Runtime shutdown has not been confirmed. Files are retained and server changes remain blocked until recovery can establish that runtime writers have stopped.';
  if (CLEANUP_PHASES.has(record.phase)) return 'The server is committed and verified cleanup can be retried.';
  if (record.target.kind === 'existing' && ROLLBACK_SWAP_STEPS.has(record.swapStep)) {
    return 'The interrupted server change can be verified again or restored to the prior server.';
  }
  return 'The interrupted operation can continue only after its durable evidence is verified again.';
}

function runtimeProofRequired(record) {
  if (record.outcome && Object.hasOwn(record.outcome, 'runtimeWriterAuthority')) {
    try { return normalizeRuntimeWriterAuthority(record.outcome.runtimeWriterAuthority, record).state !== 'settled'; }
    catch { return true; }
  }
  return record.outcome?.runtimeWriterProtocol !== 1 && legacyMayHaveRuntimeWriters(record);
}

function publicRecord(record, canExposePendingNewServer) {
  assertRecord(record);
  const recoveryId = recoveryIdFor(record.jobId);
  const serverId = safeServerId(record, recoveryId);
  const visibilityScope = visibilityScopeFor(record, canExposePendingNewServer);
  return {
    recoveryId,
    serverId,
    instanceId: serverId,
    visibilityScope,
    operationKind: record.operationKind,
    phase: record.phase,
    automaticPossible: !runtimeProofRequired(record),
    title: titleFor(record),
    summary: summaryFor(record),
    actions: actionsFor(record, visibilityScope)
  };
}

function assertRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.getPrototypeOf(request) !== Object.prototype || Object.getOwnPropertySymbols(request).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(request);
  if (Object.keys(descriptors).length !== 2 || !Object.hasOwn(descriptors, 'recoveryId') ||
      !Object.hasOwn(descriptors, 'actionId') || Object.values(descriptors).some(descriptor =>
        !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) throw invalid();
  if (typeof request.recoveryId !== 'string' || !ID_PATTERN.test(request.recoveryId) ||
      typeof request.actionId !== 'string' || !ACTION_ID_PATTERN.test(request.actionId)) throw invalid();
  return request;
}

class ModpackRecoveryFacade {
  constructor({ recoveryRegistry, recoveryService, canExposePendingNewServer, onResolved = null } = {}) {
    requireMethod(recoveryRegistry, 'listActive');
    for (const method of ['recover', 'rollback', 'retryCommittedCleanup']) requireMethod(recoveryService, method);
    if (typeof canExposePendingNewServer !== 'function') throw invalid();
    if (onResolved !== null && typeof onResolved !== 'function') throw invalid();
    this.registry = recoveryRegistry;
    this.recoveryService = recoveryService;
    this.canExposePendingNewServer = canExposePendingNewServer;
    this.onResolved = onResolved;
  }

  async listRecovery() {
    const records = await this.registry.listActive();
    if (!Array.isArray(records)) throw invalid();
    const items = records.map(record => publicRecord(record, this.canExposePendingNewServer))
      .sort((left, right) => left.recoveryId.localeCompare(right.recoveryId, 'en-US'));
    if (new Set(items.map(item => item.recoveryId)).size !== items.length) throw invalid();
    return deepFreeze({ items });
  }

  async recover(requestValue) {
    const request = assertRequest(requestValue);
    const records = await this.registry.listActive();
    if (!Array.isArray(records)) throw invalid();
    const matching = records.filter(record => recoveryIdFor(assertRecord(record).jobId) === request.recoveryId);
    if (matching.length !== 1) throw stale();
    const record = matching[0];
    const visibilityScope = visibilityScopeFor(record, this.canExposePendingNewServer);
    const allowed = actionsFor(record, visibilityScope);
    if (!allowed.some(action => action.actionId === request.actionId)) throw invalid();

    let result;
    if (request.actionId === 'retry-cleanup') {
      result = await this.recoveryService.retryCommittedCleanup(record);
    } else if (request.actionId === 'rollback-server') {
      result = await this.recoveryService.rollback(record, 'user-reviewed-recovery');
    } else if (request.actionId === 'retry-recovery' || request.actionId === PENDING_NEW_SERVER_ACTION_ID) {
      result = await this.recoveryService.recover(record);
    } else {
      throw invalid();
    }
    const resolved = result?.resolved === true;
    let operationStateReconciled = null;
    if (resolved && this.onResolved) {
      try { operationStateReconciled = await this.onResolved(record.jobId, record, result) !== false; }
      catch { operationStateReconciled = false; }
    }
    return deepFreeze({
      recoveryId: request.recoveryId,
      serverId: safeServerId(record, request.recoveryId),
      actionId: request.actionId,
      resolved,
      status: resolved ? 'resolved' : 'pending',
      ...(operationStateReconciled === null ? {} : { operationStateReconciled })
    });
  }
}

module.exports = { ModpackRecoveryFacade, recoveryIdFor };
