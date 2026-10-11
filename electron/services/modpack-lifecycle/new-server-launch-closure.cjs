const { normalizeRecoveryTargetPath, createRecoveryTargetEnvelope } = require('./recovery-target-envelope.cjs');
const { normalizeReleaseTrackingIntent } = require('../modpacks/notifications/release-tracking-reconciler.cjs');

// Pure interpretation only. Callers must authenticate publication and binding
// under their existing owner/recovery authority before supplying evidence.
function classifyRecoveryTerminalClosure(record, { releaseTrackingIntent = null } = {}) {
  try {
    if (!record || !['new', 'existing'].includes(record.target?.kind)) return null;
    const outcome = record.outcome || {};
    if (record.phase === 'completed') {
      if (releaseTrackingIntent || outcome.releaseTracking) {
        const applied = normalizeReleaseTrackingIntent(outcome.releaseTracking);
        if (applied.status !== 'applied' || applied.serverId !== record.target.stableServerId) return null;
        if (releaseTrackingIntent && JSON.stringify({ ...applied, status: 'pending' }) !==
            JSON.stringify({ ...normalizeReleaseTrackingIntent(releaseTrackingIntent), status: 'pending' })) return null;
      }
      return (record.target.kind === 'existing'
        ? record.swapStep === 'cleanup-complete' && outcome.cleanup?.rollbackRemoved === true && outcome.cleanup?.deletionAuthorized === true
        : record.swapStep === 'candidate-published' && outcome.publication?.state === 'published' &&
          outcome.registration?.complete === true && outcome.registration.instanceId === record.target.stableServerId)
        ? 'completed' : null;
    }
    const identities = record.directoryIdentities;
    if (!identities || !['target', 'candidate', 'rollback', 'failed'].every(key => Object.hasOwn(identities, key))) return null;
    if (Object.values(identities).some(identity => identity !== null &&
        (!identity || typeof identity.volumeSerial !== 'string' || !/^[A-Fa-f0-9]{1,32}$/.test(identity.volumeSerial) ||
          typeof identity.fileId !== 'string' || !/^[A-Fa-f0-9]{1,64}$/.test(identity.fileId)))) return null;
    const action = outcome.recovery?.action;
    if (record.phase === 'failed' && action === 'revalidation-aborted' && record.swapStep === 'none' &&
        record.restoreCreation === null && record.restorePoint === null && identities.candidate === null &&
        identities.rollback === null && identities.failed === null &&
        (record.target.kind === 'existing' || identities.target === null) &&
        outcome.publication == null && outcome.registration == null && outcome.liveMutationAuthorized !== true &&
        (outcome.recovery.operationId === undefined || outcome.recovery.operationId === record.jobId)) return 'abandoned';
    if (outcome.recovery?.operationId !== record.jobId) return null;
    const sameOriginal = identities.target && identities.rollback &&
      identities.target.volumeSerial === identities.rollback.volumeSerial && identities.target.fileId === identities.rollback.fileId;
    if (record.target.kind === 'existing') {
      if (record.phase === 'failed' && sameOriginal && identities.failed === null &&
          ((action === 'pre-swap-restored' && ['none', 'prepared'].includes(record.swapStep)) ||
           (action === 'between-renames-restored' && record.swapStep === 'live-moved'))) return 'abandoned';
      if (record.phase === 'rolled-back' && action === 'rollback-restored' && record.swapStep === 'rollback-restored' &&
          sameOriginal && identities.failed) return 'rolled-back';
    } else if (record.phase === 'failed') {
      const legacyPrePublication = record.swapStep === 'candidate-published' && outcome.publication?.state === 'publishing' &&
        !outcome.registration && outcome.liveMutationAuthorized !== true;
      if (action === 'pre-publication-cleanup' && identities.target === null && identities.failed === null &&
          (['none', 'new-prepared'].includes(record.swapStep) || legacyPrePublication)) return 'abandoned';
      if (action === 'new-health-failed' && record.swapStep === 'failed-canonical-moved' && identities.target === null &&
          identities.failed) return 'abandoned';
    }
  } catch { /* malformed/partial evidence is never closure */ }
  return null;
}

function newServerRegistrationState(instances, target) {
  try {
    if (!Array.isArray(instances) || typeof target?.stableServerId !== 'string') return 'conflict';
    const targetPath = normalizeRecoveryTargetPath(target.path);
    const idMatches = []; const pathMatches = [];
    for (const instance of instances) {
      if (!instance || typeof instance !== 'object' || Array.isArray(instance)) continue;
      if (instance.id === target.stableServerId) idMatches.push(instance);
      try { if (normalizeRecoveryTargetPath(instance.path) === targetPath) pathMatches.push(instance); } catch {}
    }
    if (!idMatches.length && !pathMatches.length) return 'absent';
    if (idMatches.length === 1 && pathMatches.length === 1 && idMatches[0] === pathMatches[0] &&
        idMatches[0].type === 'server') return 'registered';
  } catch {}
  return 'conflict';
}

function hasExactLaunchRecoveryBinding(job, binding, record) {
  try {
    return record?.jobId === job?.jobId && record.target?.kind === 'new' &&
      record.target.stableServerId === job.serverId && binding.instanceId === job.serverId &&
      record.operationKind === ({ 'install-new': 'install', 'import-files-only-new': 'import' })[job.operationKind] &&
      normalizeRecoveryTargetPath(record.target.path) === binding.targetPath;
  } catch { return false; }
}

function classifyLaunchDestination({ job, binding, recoveryEvidence = {}, registrationState, queuedProof } = {}) {
  const result = (disposition, settlementStatus, reason, recoveryAvailable = false) => ({ disposition, settlementStatus,
    ...(reason ? { reason } : {}), recoveryAvailable });
  const support = reason => result(null, 'support-required', reason);
  if (!job || !binding || job.serverId !== binding.instanceId ||
      !['install-new', 'import-files-only-new'].includes(job.operationKind) ||
      !['held', 'released', 'consumed'].includes(binding.destinationDisposition)) return support('invalid-durable-evidence');
  if (recoveryEvidence.corrupt) return support('invalid-durable-evidence');
  if (recoveryEvidence.conflict || registrationState === 'conflict') return support('conflicting-evidence');
  const record = recoveryEvidence.record;
  if (record && !hasExactLaunchRecoveryBinding(job, binding, record)) return support('conflicting-evidence');
  let wanted = null;
  if (record && recoveryEvidence.terminalPublished === true) {
    const closure = classifyRecoveryTerminalClosure(record, { releaseTrackingIntent: recoveryEvidence.releaseTrackingIntent });
    if (closure === 'completed' && registrationState === 'registered') wanted = 'consumed';
    else if (closure === 'abandoned' && registrationState === 'absent') wanted = 'released';
    else return support('conflicting-evidence');
  }
  if (recoveryEvidence.destinationRecovery === true && registrationState === 'absent') wanted = 'released';
  if (queuedProof && job.phase === 'queued' && !job.cancellationRequested &&
      ['startupOnly', 'initialMember', 'orphanInitialized', 'noCurrentOwner', 'supportedProtocol', 'cleanEvidence', 'revisionCurrent']
        .every(key => queuedProof[key] === true) && registrationState === 'absent' && !record) wanted = 'released';
  if (wanted && !['held', wanted].includes(binding.destinationDisposition)) return support('conflicting-evidence');
  if (recoveryEvidence.owned === true) return result(binding.destinationDisposition === 'held' ? null : binding.destinationDisposition, 'active');
  if (wanted) return result(wanted, binding.destinationDisposition === wanted ? 'settled' : 'repair-pending',
    binding.destinationDisposition === wanted ? null : 'settlement-repair-required');
  if (recoveryEvidence.pendingTerminalPublication || (record && !recoveryEvidence.terminalPublished && !recoveryEvidence.active)) {
    return recoveryEvidence.recoveryAvailable === true
      ? result(null, 'recovery-required', 'pending-terminal-publication', true) : support('pending-terminal-publication');
  }
  if (recoveryEvidence.active) return recoveryEvidence.recoveryAvailable === true
    ? result(null, 'recovery-required', 'conflicting-evidence', true) : support('conflicting-evidence');
  if (binding.destinationDisposition !== 'held') return result(binding.destinationDisposition, 'settled');
  return support('missing-recovery-evidence');
}

function coversLaunch(item, launch) {
  if (item?.jobId === launch.job.jobId || item?.stableServerId === launch.job.serverId ||
      item?.target?.stableServerId === launch.job.serverId) return true;
  try {
    const envelope = createRecoveryTargetEnvelope({ jobId: launch.job.jobId,
      target: { kind: 'new', stableServerId: launch.job.serverId, path: launch.binding.targetPath } });
    if (item?.targetPathHash === envelope.targetPathHash) return true;
    return Boolean(item?.target && createRecoveryTargetEnvelope(item).targetPathHash === envelope.targetPathHash);
  } catch { return false; }
}

function isDestinationRecoveryClosure(job, evidence, registrationState) {
  return Boolean(job?.phase === 'failed' && job.terminalAt !== null && job.terminalAt !== undefined &&
    ['install-new', 'import-files-only-new'].includes(job.operationKind) &&
    job.outcome?.failureReason === 'destination-recovery' && job.outcome.errorCode === 'RECOVERY_REQUIRED' &&
    !evidence.record && !evidence.corrupt && evidence.olderRestriction === true && registrationState === 'absent');
}

module.exports = { classifyRecoveryTerminalClosure, classifyLaunchDestination, newServerRegistrationState, hasExactLaunchRecoveryBinding,
  coversLaunch, isDestinationRecoveryClosure };
