const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');

const RECONCILABLE_PHASES = new Set([
  'publishing', 'published', 'registering', 'starting', 'validating-live',
  'committed-healthy', 'cleanup', 'cleanup-pending'
]);
const RECOVERY_COMMITTED_PHASES = new Set(['committed-healthy', 'cleanup', 'cleanup-pending', 'completed']);
const NEW_PUBLICATION_PHASES = new Set(['publishing', 'published', 'registering']);
const NEW_SERVER_OPERATION_KINDS = new Set(['install-new', 'import-files-only-new']);
const ACTION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'Operation recovery reconciliation is invalid', { cause });
}

function isDurablyCommitted(job, recoveryRecord) {
  if (NEW_PUBLICATION_PHASES.has(job?.phase) &&
      (recoveryRecord?.target?.kind !== 'new' || !NEW_SERVER_OPERATION_KINDS.has(job?.operationKind))) return false;
  return Boolean(
    recoveryRecord && RECOVERY_COMMITTED_PHASES.has(recoveryRecord.phase) &&
    recoveryRecord.target?.stableServerId === job.serverId &&
    recoveryRecord.outcome?.revisionEvent?.published === true &&
    (!recoveryRecord.outcome?.releaseTracking || recoveryRecord.outcome.releaseTracking.status === 'applied')
  );
}

async function loadRecoveryRecord(recoveryRegistry, jobId) {
  const active = await recoveryRegistry.load(jobId);
  if (active) return { record: active, historical: false };
  return { record: await recoveryRegistry.loadHistory(jobId), historical: true };
}

async function transition(operationStore, jobId, expectedPhase, nextPhase, percent, message) {
  return operationStore.transition(jobId, {
    expectedPhase,
    nextPhase,
    patch: { progress: { percent, message, currentItem: null } }
  });
}

async function advanceToCleanupPending(operationStore, job) {
  let current = job;
  if (current.phase === 'publishing') {
    current = await transition(operationStore, current.jobId, 'publishing', 'published', 75,
      'Recovered the published server');
  }
  if (current.phase === 'published') {
    current = await transition(operationStore, current.jobId, 'published', 'registering', 80,
      'Recovered the registered server');
  }
  if (current.phase === 'registering') {
    current = await transition(operationStore, current.jobId, 'registering', 'committed-healthy', 95,
      'Recovered the durable committed server');
  } else if (current.phase === 'starting') {
    current = await transition(operationStore, current.jobId, 'starting', 'validating-live', 90,
      'Reconciling the committed server');
  }
  if (current.phase === 'validating-live') {
    current = await transition(operationStore, current.jobId, 'validating-live', 'committed-healthy', 95,
      'Recovered the durable committed server');
  }
  if (current.phase === 'committed-healthy') {
    current = await transition(operationStore, current.jobId, 'committed-healthy', 'cleanup-pending', 98,
      'Committed server recovered; cleanup can be retried');
  } else if (current.phase === 'cleanup') {
    current = await transition(operationStore, current.jobId, 'cleanup', 'cleanup-pending', 98,
      'Committed server recovered; cleanup can be retried');
  }
  return current;
}

function normalizeActions(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 16) throw invalid();
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype ||
        Object.getOwnPropertySymbols(item).length !== 0) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (JSON.stringify(Object.keys(descriptors).sort()) !== JSON.stringify(['actionId', 'opaqueRef']) ||
        Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
      throw invalid();
    }
    const actionId = descriptors.actionId.value;
    const opaqueRef = descriptors.opaqueRef.value;
    if (typeof actionId !== 'string' || !ACTION_IDENTIFIER.test(actionId) ||
        typeof opaqueRef !== 'string' || !ACTION_IDENTIFIER.test(opaqueRef) || seen.has(actionId)) throw invalid();
    seen.add(actionId);
    return { actionId, opaqueRef };
  });
}

async function completedOutcome(job, recoveryRecord, outcomeActionIssuer) {
  const outcome = {
    status: 'completed',
    message: 'The modpack operation completed successfully',
    operationKind: job.operationKind,
    actions: []
  };
  if (outcomeActionIssuer === null || outcomeActionIssuer === undefined) return outcome;
  try {
    outcome.actions = normalizeActions(await outcomeActionIssuer.issue(deepFreeze({
      jobId: job.jobId,
      operationKind: job.operationKind,
      instanceId: job.serverId,
      phase: 'completed',
      status: 'completed',
      errorCode: null,
      plan: null,
      restorePointId: recoveryRecord.restorePoint?.id || null,
      automaticRecovery: true
    })));
  } catch {
    outcome.actions = [];
    outcome.actionIssuanceFailed = true;
  }
  return outcome;
}

async function reconcileOperationStoreWithRecovery({
  operationStore, recoveryRegistry, jobs, outcomeActionIssuer = null
} = {}) {
  if (!operationStore || typeof operationStore.transition !== 'function' || !recoveryRegistry ||
      typeof recoveryRegistry.load !== 'function' || typeof recoveryRegistry.loadHistory !== 'function' ||
      !Array.isArray(jobs) || (outcomeActionIssuer !== null &&
        (!outcomeActionIssuer || typeof outcomeActionIssuer.issue !== 'function'))) throw invalid();
  const reconciled = [];
  for (const job of jobs) {
    if (!job || typeof job.jobId !== 'string' || typeof job.serverId !== 'string' ||
        typeof job.phase !== 'string' || !RECONCILABLE_PHASES.has(job.phase)) continue;
    const authority = await loadRecoveryRecord(recoveryRegistry, job.jobId);
    const recoveryRecord = authority.record;
    if (!isDurablyCommitted(job, recoveryRecord)) continue;
    let updated = await advanceToCleanupPending(operationStore, job);
    if (authority.historical && recoveryRecord.phase === 'completed' && updated.phase === 'cleanup-pending') {
      updated = await operationStore.transition(job.jobId, {
        expectedPhase: 'cleanup-pending',
        nextPhase: 'completed',
        patch: {
          progress: { percent: 100, message: 'Modpack operation completed', currentItem: null },
          outcome: await completedOutcome(job, recoveryRecord, outcomeActionIssuer)
        }
      });
    }
    if (updated.phase === 'cleanup-pending' || updated.phase === 'completed') reconciled.push(job.jobId);
  }
  return deepFreeze({ reconciled: reconciled.sort((left, right) => left.localeCompare(right, 'en-US')) });
}

module.exports = {
  isDurablyCommitted,
  reconcileOperationStoreWithRecovery
};
