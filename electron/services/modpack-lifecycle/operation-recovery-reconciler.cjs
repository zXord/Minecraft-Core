const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { normalizeFailureDiagnostic } = require('./publication-failure-diagnostic.cjs');

const RECONCILABLE_PHASES = new Set([
  'publishing', 'published', 'registering', 'starting', 'validating-live',
  'committed-healthy', 'cleanup', 'cleanup-pending', 'recovery-required'
]);
const PRE_COMMIT_RECOVERY_PHASES = new Set([
  'queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user',
  'preflight', 'snapshotting', 'staging', 'validating-candidate', 'cancelling'
]);
const INTERRUPTED_COMMIT_PHASES = new Set([
  'committing', 'publishing', 'published', 'registering', 'starting', 'validating-live', 'rolling-back'
]);
const RECOVERY_COMMITTED_PHASES = new Set(['committed-healthy', 'cleanup', 'cleanup-pending', 'completed']);
const NEW_PUBLICATION_PHASES = new Set(['publishing', 'published', 'registering']);
const NEW_SERVER_OPERATION_KINDS = new Set(['install-new', 'import-files-only-new']);
const FAILED_RECOVERY_ACTIONS = new Set([
  'pre-publication-cleanup', 'new-health-failed', 'pre-swap-restored', 'between-renames-restored'
]);
const ACTION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'Operation recovery reconciliation is invalid', { cause });
}

function recoveryOperationKind(operationKind) {
  if (operationKind === 'install-new' || operationKind === 'install-existing') return 'install';
  if (operationKind === 'update') return 'upgrade';
  if (operationKind === 'rollback-restore-point') return 'rollback';
  if (operationKind === 'import-files-only-new') return 'import';
  if (operationKind === 'uninstall-managed') return 'uninstall';
  return operationKind;
}

function expectedTargetKind(job) {
  return NEW_SERVER_OPERATION_KINDS.has(job?.operationKind) ? 'new' : 'existing';
}

function hasExactRecoveryBinding(job, recoveryRecord) {
  return Boolean(
    recoveryRecord && recoveryRecord.jobId === job?.jobId &&
    recoveryRecord.operationKind === recoveryOperationKind(job?.operationKind) &&
    recoveryRecord.target?.kind === expectedTargetKind(job) &&
    recoveryRecord.target?.stableServerId === job?.serverId
  );
}

function isDurablyCommitted(job, recoveryRecord) {
  if (NEW_PUBLICATION_PHASES.has(job?.phase) &&
      (recoveryRecord?.target?.kind !== 'new' || !NEW_SERVER_OPERATION_KINDS.has(job?.operationKind))) return false;
  return Boolean(
    hasExactRecoveryBinding(job, recoveryRecord) && RECOVERY_COMMITTED_PHASES.has(recoveryRecord.phase) &&
    recoveryRecord.outcome?.revisionEvent?.published === true &&
    (!recoveryRecord.outcome?.releaseTracking || recoveryRecord.outcome.releaseTracking.status === 'applied')
  );
}

function recoveredTerminalPhase(job, recoveryRecord, historical) {
  if (!historical || !hasExactRecoveryBinding(job, recoveryRecord)) return null;
  const action = recoveryRecord.outcome?.recovery?.action;
  const operationId = recoveryRecord.outcome?.recovery?.operationId;
  if (operationId !== job.jobId) return null;
  if (recoveryRecord.phase === 'failed' && FAILED_RECOVERY_ACTIONS.has(action)) {
    if (job.phase === 'recovery-required') {
      return recoveryRecord.target.kind === 'new' ? 'failed' : 'rolled-back';
    }
    if (PRE_COMMIT_RECOVERY_PHASES.has(job.phase)) return 'failed';
    if (INTERRUPTED_COMMIT_PHASES.has(job.phase)) return 'rolled-back';
    return null;
  }
  if (recoveryRecord.phase === 'rolled-back' && action === 'rollback-restored' &&
      (INTERRUPTED_COMMIT_PHASES.has(job.phase) || job.phase === 'recovery-required')) return 'rolled-back';
  return null;
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

async function recoveredTerminalOutcome(job, recoveryRecord, terminalPhase, outcomeActionIssuer) {
  const failed = terminalPhase === 'failed';
  const recoveryAction = recoveryRecord.outcome?.recovery?.action;
  const failedMessage = recoveryRecord.target?.kind === 'new'
    ? recoveryAction === 'pre-publication-cleanup'
      ? 'The new server was not published'
      : 'The failed new server was quarantined safely'
    : 'The interrupted operation was recovered before publication';
  const failure = failed
    ? normalizeFailureDiagnostic(recoveryRecord.outcome?.failure)
    : null;
  const errorCode = failed
    ? failure?.stage === 'candidate-boot' ? 'HEALTH_CHECK_FAILED' : 'COMMIT_FAILED'
    : null;
  const outcome = {
    status: terminalPhase,
    message: failed
      ? failedMessage
      : 'The interrupted operation was rolled back safely',
    ...(failed ? { errorCode } : {}),
    ...(failure ? { failure } : {}),
    operationKind: job.operationKind,
    actions: []
  };
  if (outcomeActionIssuer === null || outcomeActionIssuer === undefined) return outcome;
  try {
    outcome.actions = normalizeActions(await outcomeActionIssuer.issue(deepFreeze({
      jobId: job.jobId,
      operationKind: job.operationKind,
      instanceId: job.serverId,
      phase: terminalPhase,
      status: terminalPhase,
      errorCode,
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

async function advanceToRecoveredTerminal(operationStore, job, recoveryRecord, terminalPhase, outcomeActionIssuer) {
  let current = job;
  if (current.phase === 'recovery-required') {
    if (typeof operationStore.reconcileRecovery !== 'function') throw invalid();
    return operationStore.reconcileRecovery(current.jobId, {
      nextPhase: terminalPhase,
      patch: {
        progress: {
          percent: 100,
          message: terminalPhase === 'failed'
            ? 'Interrupted operation recovered safely'
            : 'Original server restored',
          currentItem: null
        },
        outcome: await recoveredTerminalOutcome(job, recoveryRecord, terminalPhase, outcomeActionIssuer)
      }
    });
  }
  if (terminalPhase === 'failed') {
    return operationStore.transition(current.jobId, {
      expectedPhase: current.phase,
      nextPhase: 'failed',
      patch: {
        progress: { percent: 100, message: 'Interrupted operation recovered safely', currentItem: null },
        outcome: await recoveredTerminalOutcome(job, recoveryRecord, 'failed', outcomeActionIssuer)
      }
    });
  }
  if (current.phase !== 'rolling-back') {
    current = await transition(operationStore, current.jobId, current.phase, 'rolling-back', 98,
      'Recovered the original server after interruption');
  }
  return operationStore.transition(current.jobId, {
    expectedPhase: 'rolling-back',
    nextPhase: 'rolled-back',
    patch: {
      progress: { percent: 100, message: 'Original server restored', currentItem: null },
      outcome: await recoveredTerminalOutcome(job, recoveryRecord, 'rolled-back', outcomeActionIssuer)
    }
  });
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
        typeof job.phase !== 'string' || (!RECONCILABLE_PHASES.has(job.phase) &&
          !PRE_COMMIT_RECOVERY_PHASES.has(job.phase) && !INTERRUPTED_COMMIT_PHASES.has(job.phase))) continue;
    const authority = await loadRecoveryRecord(recoveryRegistry, job.jobId);
    const recoveryRecord = authority.record;
    const terminalPhase = recoveredTerminalPhase(job, recoveryRecord, authority.historical);
    if (terminalPhase !== null) {
      const updated = await advanceToRecoveredTerminal(
        operationStore, job, recoveryRecord, terminalPhase, outcomeActionIssuer
      );
      if (updated.phase === terminalPhase) reconciled.push(job.jobId);
      continue;
    }
    if (job.phase === 'recovery-required' && authority.historical && recoveryRecord?.phase === 'completed' &&
        isDurablyCommitted(job, recoveryRecord)) {
      if (typeof operationStore.reconcileRecovery !== 'function') throw invalid();
      const updated = await operationStore.reconcileRecovery(job.jobId, {
        nextPhase: 'completed',
        patch: {
          progress: { percent: 100, message: 'Modpack operation completed', currentItem: null },
          outcome: await completedOutcome(job, recoveryRecord, outcomeActionIssuer)
        }
      });
      if (updated.phase === 'completed') reconciled.push(job.jobId);
      continue;
    }
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
