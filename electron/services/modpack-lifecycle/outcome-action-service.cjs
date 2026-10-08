const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_OUTCOME_ACTIONS = Object.freeze([
  'retry', 'change-selection', 'open-details', 'open-retained-download-folder', 'remove-retained-download',
  'choose-another-asset', 'return-to-server', 'review-restore-point', 'restart-and-recover', 'review-recovery',
  'restore-from-restore-point'
]);
const ACTIONS = new Set(ALLOWED_OUTCOME_ACTIONS);
const NAVIGATION_TARGETS = new Map([
  ['change-selection', 'selection'],
  ['open-details', 'details'],
  ['choose-another-asset', 'asset-selection'],
  ['return-to-server', 'server'],
  ['review-restore-point', 'restore-point'],
  ['review-recovery', 'recovery']
]);
const EXECUTION_TARGETS = new Map([
  ['retry', 'retry'],
  ['restart-and-recover', 'recovery'],
  ['restore-from-restore-point', 'restore-point']
]);

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The outcome action request is invalid', { cause });
}

function recoveryRequired(cause) {
  return new ModpackError('RECOVERY_REQUIRED', 'The outcome action state could not be confirmed', { cause });
}

function strictObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.some(key => !allowedKeys.includes(key)) || requiredKeys.some(key => !Object.hasOwn(descriptors, key))) throw invalid();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return descriptors;
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid();
  return value;
}

function normalizeRequest(value) {
  const descriptors = strictObject(value, ['actionId', 'opaqueRef']);
  const actionId = descriptors.actionId.value;
  if (!ACTIONS.has(actionId)) throw invalid();
  return { actionId, opaqueRef: identifier(descriptors.opaqueRef.value) };
}

function normalizeReleaseTarget(value) {
  const descriptors = strictObject(value, ['serverId', 'provider', 'sourceId', 'releaseId', 'prerelease']);
  const provider = descriptors.provider.value;
  if (!['github', 'modrinth'].includes(provider) || typeof descriptors.prerelease.value !== 'boolean') throw invalid();
  return {
    serverId: identifier(descriptors.serverId.value),
    provider,
    sourceId: identifier(descriptors.sourceId.value),
    releaseId: identifier(descriptors.releaseId.value),
    prerelease: descriptors.prerelease.value
  };
}

function normalizeClaim(value, request) {
  const descriptors = strictObject(value, ['claimId', 'reference']);
  const claimId = identifier(descriptors.claimId.value);
  const referenceDescriptors = strictObject(
    descriptors.reference.value,
    ['actionId', 'targetKind', 'targetId', 'cacheSha256', 'releaseTarget'],
    ['actionId', 'targetKind', 'targetId']
  );
  if (referenceDescriptors.actionId.value !== request.actionId) throw invalid();
  const reference = {
    actionId: request.actionId,
    targetKind: identifier(referenceDescriptors.targetKind.value),
    targetId: identifier(referenceDescriptors.targetId.value)
  };
  if (referenceDescriptors.cacheSha256) {
    const cacheSha256 = referenceDescriptors.cacheSha256.value;
    if (typeof cacheSha256 !== 'string' || !SHA256.test(cacheSha256)) throw invalid();
    reference.cacheSha256 = cacheSha256;
  }
  if (referenceDescriptors.releaseTarget) {
    reference.releaseTarget = normalizeReleaseTarget(referenceDescriptors.releaseTarget.value);
  }
  return { claimId, reference };
}

function releasableClaimId(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'claimId');
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string' && IDENTIFIER.test(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function normalizeExecutionResult(value) {
  const descriptors = strictObject(value, ['status', 'referenceId']);
  const status = descriptors.status.value;
  if (!['started', 'completed'].includes(status)) throw recoveryRequired();
  return { status, referenceId: identifier(descriptors.referenceId.value) };
}

class OutcomeActionService {
  constructor({ referenceAuthority, artifactCache, controlledFolderOpener, actionExecutor } = {}) {
    if (!referenceAuthority || typeof referenceAuthority.claim !== 'function' ||
        typeof referenceAuthority.complete !== 'function' || typeof referenceAuthority.release !== 'function' ||
        !artifactCache || typeof artifactCache.removeIfUnreferenced !== 'function' ||
        !controlledFolderOpener || typeof controlledFolderOpener.openCacheParent !== 'function' ||
        !actionExecutor || typeof actionExecutor.execute !== 'function') throw invalid();
    this.referenceAuthority = referenceAuthority;
    this.artifactCache = artifactCache;
    this.controlledFolderOpener = controlledFolderOpener;
    this.actionExecutor = actionExecutor;
  }

  async performSafeAction(requestValue) {
    const request = normalizeRequest(requestValue);
    let claim = null;
    let issuedClaimId = null;
    let effectStarted = false;
    try {
      const issuedClaim = await this.referenceAuthority.claim(request);
      issuedClaimId = releasableClaimId(issuedClaim);
      claim = normalizeClaim(issuedClaim, request);
      let result;
      if (request.actionId === 'open-retained-download-folder') {
        if (claim.reference.targetKind !== 'retained-download' || !claim.reference.cacheSha256 || claim.reference.releaseTarget) throw invalid();
        effectStarted = true;
        await this.controlledFolderOpener.openCacheParent();
        result = {
          type: 'outcome-action-result',
          actionId: request.actionId,
          status: 'opened',
          destination: { kind: 'controlled-cache-parent' }
        };
      } else if (request.actionId === 'remove-retained-download') {
        if (claim.reference.targetKind !== 'retained-download' || !claim.reference.cacheSha256 || claim.reference.releaseTarget) throw invalid();
        let removed;
        if (typeof this.artifactCache.removeRetainedIfUnreferenced === 'function') {
          const retention = await this.artifactCache.removeRetainedIfUnreferenced({
            ownerId: claim.reference.targetId,
            sha256: claim.reference.cacheSha256
          });
          if (!retention || typeof retention !== 'object' || typeof retention.removed !== 'boolean' ||
              !['removed', 'retained', 'expired'].includes(retention.status)) throw recoveryRequired();
          if (retention.status === 'expired') throw invalid();
          removed = retention.removed;
        } else {
          removed = await this.artifactCache.removeIfUnreferenced(claim.reference.cacheSha256);
        }
        if (typeof removed !== 'boolean') throw recoveryRequired();
        effectStarted = true;
        result = {
          type: 'outcome-action-result',
          actionId: request.actionId,
          status: removed ? 'removed' : 'retained',
          removed
        };
      } else if (NAVIGATION_TARGETS.has(request.actionId)) {
        const targetKind = NAVIGATION_TARGETS.get(request.actionId);
        if (claim.reference.targetKind !== targetKind || claim.reference.cacheSha256 !== undefined) throw invalid();
        if (claim.reference.releaseTarget && !['details', 'asset-selection'].includes(targetKind)) throw invalid();
        result = {
          type: 'outcome-action-result',
          actionId: request.actionId,
          status: 'ready',
          destination: {
            kind: targetKind,
            targetId: claim.reference.targetId,
            ...(claim.reference.releaseTarget ? { releaseTarget: claim.reference.releaseTarget } : {})
          }
        };
      } else if (EXECUTION_TARGETS.has(request.actionId)) {
        const targetKind = EXECUTION_TARGETS.get(request.actionId);
        if (claim.reference.targetKind !== targetKind || claim.reference.cacheSha256 !== undefined || claim.reference.releaseTarget) throw invalid();
        effectStarted = true;
        const execution = normalizeExecutionResult(await this.actionExecutor.execute({
          actionId: request.actionId,
          targetKind,
          targetId: claim.reference.targetId
        }));
        result = {
          type: 'outcome-action-result',
          actionId: request.actionId,
          status: execution.status,
          operationRef: execution.referenceId
        };
      } else {
        throw invalid();
      }
      if (await this.referenceAuthority.complete(claim.claimId) !== true) throw recoveryRequired();
      return deepFreeze(result);
    } catch (error) {
      const claimId = claim?.claimId || issuedClaimId;
      if (claimId && !effectStarted) {
        try {
          if (await this.referenceAuthority.release(claimId) !== true) throw recoveryRequired();
        } catch (releaseError) {
          throw recoveryRequired(releaseError);
        }
      }
      throw error;
    }
  }
}

module.exports = { ALLOWED_OUTCOME_ACTIONS, OutcomeActionService };
