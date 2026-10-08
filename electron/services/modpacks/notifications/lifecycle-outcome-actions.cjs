const crypto = require('node:crypto');

const { ModpackError, deepFreeze } = require('../errors.cjs');
const { recoveryIdFor } = require('../../modpack-lifecycle/modpack-recovery-facade.cjs');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TERMINAL_PHASES = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);
const EXECUTION_ACTIONS = new Set(['retry', 'restart-and-recover', 'restore-from-restore-point']);
const ACTION_CODES = new Map([
  ['retry', 'rt'],
  ['change-selection', 'cs'],
  ['open-details', 'od'],
  ['return-to-server', 'rs'],
  ['review-restore-point', 'rp'],
  ['restart-and-recover', 'rr'],
  ['review-recovery', 'rv'],
  ['restore-from-restore-point', 'rf'],
  ['open-retained-download-folder', 'of'],
  ['remove-retained-download', 'rm'],
  ['choose-another-asset', 'ca']
]);
const CODE_ACTIONS = new Map([...ACTION_CODES].map(([action, code]) => [code, action]));

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The lifecycle outcome action is invalid', { cause });
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid();
  return value;
}

function jobIdentifier(value) {
  if (typeof value !== 'string' || !JOB_ID.test(value)) throw invalid();
  return value;
}

function strictObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.some(key => !allowedKeys.includes(key)) || requiredKeys.some(key => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function issuedReference(actionId, jobId, detail = null) {
  const code = ACTION_CODES.get(actionId);
  if (!code) throw invalid();
  const opaqueRef = detail === null
    ? `oa:${code}:${jobIdentifier(jobId)}`
    : `oa:${code}:${jobIdentifier(jobId)}:${identifier(detail)}`;
  identifier(opaqueRef);
  return deepFreeze({ actionId, opaqueRef });
}

function parseReference(actionId, opaqueRef) {
  const match = /^oa:([a-z]{2}):([A-Za-z0-9][A-Za-z0-9._-]{0,95})(?::([A-Za-z0-9][A-Za-z0-9._:-]{0,191}))?$/.exec(opaqueRef);
  if (!match || CODE_ACTIONS.get(match[1]) !== actionId) throw invalid();
  const detail = match[3] || null;
  const requiresDetail = ['review-restore-point', 'restore-from-restore-point',
    'open-retained-download-folder', 'remove-retained-download'].includes(actionId);
  if (requiresDetail !== (detail !== null)) throw invalid();
  if (['open-retained-download-folder', 'remove-retained-download'].includes(actionId) && !SHA256.test(detail)) throw invalid();
  return { jobId: match[2], detail };
}

function hasExactIssuedAction(job, actionId, opaqueRef) {
  const actions = job?.outcome?.actions;
  return Array.isArray(actions) && actions.filter(action => action?.actionId === actionId && action.opaqueRef === opaqueRef).length === 1;
}

class LifecycleOutcomeActionIssuer {
  async issue(value) {
    const request = strictObject(value, [
      'jobId', 'operationKind', 'instanceId', 'phase', 'status', 'errorCode', 'plan', 'restorePointId', 'automaticRecovery'
    ]);
    const jobId = jobIdentifier(request.jobId);
    identifier(request.operationKind);
    identifier(request.instanceId);
    if (!TERMINAL_PHASES.has(request.phase) || request.status !== request.phase ||
        (request.errorCode !== null && (typeof request.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(request.errorCode))) ||
        (request.restorePointId !== null && (typeof request.restorePointId !== 'string' || !IDENTIFIER.test(request.restorePointId))) ||
        typeof request.automaticRecovery !== 'boolean') throw invalid();

    const actions = [];
    const add = (actionId, restorePointId = null) => actions.push(issuedReference(actionId, jobId, restorePointId));
    if (request.phase === 'completed') {
      add('open-details');
    } else if (request.phase === 'failed' || request.phase === 'cancelled') {
      const retained = request.plan?.artifact;
      const parts = retained?.parts;
      const verifiedRetained = SHA256.test(retained?.setDigest || '') && Array.isArray(parts) && parts.length > 0 &&
        parts.every(part => part && SHA256.test(part.sha256 || ''));
      if (verifiedRetained) {
        add('open-retained-download-folder', retained.setDigest);
        if (parts.length === 1) add('remove-retained-download', parts[0].sha256);
        add('choose-another-asset');
      } else {
        if (request.operationKind === 'verify') add('retry');
        else add('change-selection');
        add('open-details');
      }
    } else if (request.phase === 'rolled-back') {
      add('return-to-server');
      if (request.restorePointId !== null) add('review-restore-point', request.restorePointId);
    } else if (request.automaticRecovery) {
      add('restart-and-recover');
      add('open-details');
    } else {
      add('review-recovery');
      if (request.restorePointId !== null) add('review-restore-point', request.restorePointId);
      add('open-details');
    }
    return deepFreeze(actions);
  }
}

class LifecycleOutcomeReferenceAuthority {
  constructor({ operationStore, randomUUID = crypto.randomUUID } = {}) {
    if (!operationStore || typeof operationStore.get !== 'function' || typeof randomUUID !== 'function') throw invalid();
    this.operationStore = operationStore;
    this.randomUUID = randomUUID;
    this.claims = new Map();
    this.activeReferences = new Map();
    this.consumedReferences = new Set();
  }

  async claim(value) {
    const request = strictObject(value, ['actionId', 'opaqueRef']);
    const actionId = identifier(request.actionId);
    const opaqueRef = identifier(request.opaqueRef);
    const parsed = parseReference(actionId, opaqueRef);
    if (this.activeReferences.has(opaqueRef) || this.consumedReferences.has(opaqueRef)) throw invalid();
    const job = await this.operationStore.get(parsed.jobId);
    if (!job || job.jobId !== parsed.jobId || !TERMINAL_PHASES.has(job.phase) || job.outcome?.status !== job.phase ||
        !hasExactIssuedAction(job, actionId, opaqueRef)) throw invalid();

    let targetKind;
    let targetId;
    if (actionId === 'retry') {
      if (job.operationKind !== 'verify') throw invalid();
      targetKind = 'retry';
      targetId = job.jobId;
    } else if (actionId === 'change-selection') {
      targetKind = 'selection';
      targetId = job.serverId;
    } else if (actionId === 'open-details') {
      targetKind = 'details';
      targetId = job.jobId;
    } else if (actionId === 'return-to-server') {
      targetKind = 'server';
      targetId = job.serverId;
    } else if (actionId === 'review-restore-point' || actionId === 'restore-from-restore-point') {
      targetKind = 'restore-point';
      targetId = parsed.detail;
    } else if (actionId === 'review-recovery' || actionId === 'restart-and-recover') {
      targetKind = 'recovery';
      targetId = recoveryIdFor(job.jobId);
    } else if (actionId === 'open-retained-download-folder' || actionId === 'remove-retained-download') {
      targetKind = 'retained-download';
      targetId = job.jobId;
    } else if (actionId === 'choose-another-asset') {
      targetKind = 'asset-selection';
      targetId = job.serverId;
    } else {
      throw invalid();
    }
    identifier(targetId);
    const claimId = identifier(`claim:${String(this.randomUUID())}`);
    if (this.claims.has(claimId)) throw invalid();
    const reference = { actionId, targetKind, targetId };
    if (actionId === 'open-retained-download-folder' || actionId === 'remove-retained-download') {
      reference.cacheSha256 = parsed.detail;
    }
    const claim = deepFreeze({ claimId, reference });
    this.claims.set(claimId, { actionId, opaqueRef });
    this.activeReferences.set(opaqueRef, claimId);
    return claim;
  }

  async complete(claimIdValue) {
    const claimId = identifier(claimIdValue);
    const claim = this.claims.get(claimId);
    if (!claim || this.activeReferences.get(claim.opaqueRef) !== claimId) return false;
    this.claims.delete(claimId);
    this.activeReferences.delete(claim.opaqueRef);
    if (EXECUTION_ACTIONS.has(claim.actionId)) this.consumedReferences.add(claim.opaqueRef);
    return true;
  }

  async release(claimIdValue) {
    const claimId = identifier(claimIdValue);
    const claim = this.claims.get(claimId);
    if (!claim || this.activeReferences.get(claim.opaqueRef) !== claimId) return false;
    this.claims.delete(claimId);
    this.activeReferences.delete(claim.opaqueRef);
    return true;
  }
}

class LifecycleOutcomeActionExecutor {
  constructor({ operationStore, getLifecycleService, recoveryService } = {}) {
    if (!operationStore || typeof operationStore.get !== 'function' || typeof getLifecycleService !== 'function' ||
        !recoveryService || typeof recoveryService.listRecovery !== 'function' || typeof recoveryService.recover !== 'function') throw invalid();
    this.operationStore = operationStore;
    this.getLifecycleService = getLifecycleService;
    this.recoveryService = recoveryService;
  }

  async execute(value) {
    const request = strictObject(value, ['actionId', 'targetKind', 'targetId']);
    identifier(request.targetId);
    if (request.actionId === 'retry' && request.targetKind === 'retry') {
      const prior = await this.operationStore.get(request.targetId);
      if (!prior || prior.jobId !== request.targetId || prior.operationKind !== 'verify' || !TERMINAL_PHASES.has(prior.phase)) throw invalid();
      const lifecycle = this.getLifecycleService();
      if (!lifecycle || typeof lifecycle.verify !== 'function') throw invalid();
      const queued = await lifecycle.verify(prior.serverId);
      return deepFreeze({ status: 'started', referenceId: identifier(queued?.jobId) });
    }
    if (request.actionId === 'restart-and-recover' && request.targetKind === 'recovery') {
      const page = await this.recoveryService.listRecovery();
      const matches = Array.isArray(page?.items) ? page.items.filter(item => item?.recoveryId === request.targetId) : [];
      if (matches.length !== 1 || matches[0].automaticPossible !== true) throw invalid();
      const recommended = matches[0].actions?.filter(action => action?.recommended === true);
      if (!Array.isArray(recommended) || recommended.length !== 1) throw invalid();
      const result = await this.recoveryService.recover({ recoveryId: request.targetId, actionId: recommended[0].actionId });
      return deepFreeze({ status: result?.resolved === true ? 'completed' : 'started', referenceId: request.targetId });
    }
    throw invalid();
  }
}

class CompositeOutcomeReferenceAuthority {
  constructor({ lifecycleAuthority, releaseAuthority } = {}) {
    for (const authority of [lifecycleAuthority, releaseAuthority]) {
      if (!authority || typeof authority.claim !== 'function' || typeof authority.complete !== 'function' ||
          typeof authority.release !== 'function') throw invalid();
    }
    this.lifecycleAuthority = lifecycleAuthority;
    this.releaseAuthority = releaseAuthority;
  }

  async claim(value) {
    const request = strictObject(value, ['actionId', 'opaqueRef']);
    const kind = typeof request.opaqueRef === 'string' && request.opaqueRef.startsWith('oa:') ? 'l' :
      typeof request.opaqueRef === 'string' && request.opaqueRef.startsWith('release-') ? 'r' : null;
    if (kind === null) throw invalid();
    const authority = kind === 'l' ? this.lifecycleAuthority : this.releaseAuthority;
    const claim = await authority.claim(request);
    return deepFreeze({ ...claim, claimId: identifier(`${kind}:${claim.claimId}`) });
  }

  async complete(claimIdValue) {
    const { kind, inner } = this.#parseClaimId(claimIdValue);
    return (kind === 'l' ? this.lifecycleAuthority : this.releaseAuthority).complete(inner);
  }

  async release(claimIdValue) {
    const { kind, inner } = this.#parseClaimId(claimIdValue);
    return (kind === 'l' ? this.lifecycleAuthority : this.releaseAuthority).release(inner);
  }

  #parseClaimId(value) {
    const claimId = identifier(value);
    const match = /^([lr]):(.+)$/.exec(claimId);
    if (!match) throw invalid();
    return { kind: match[1], inner: identifier(match[2]) };
  }
}

class CompositeOutcomeActionExecutor {
  constructor({ lifecycleExecutor, releaseExecutor } = {}) {
    if (!lifecycleExecutor || typeof lifecycleExecutor.execute !== 'function' ||
        !releaseExecutor || typeof releaseExecutor.execute !== 'function') throw invalid();
    this.lifecycleExecutor = lifecycleExecutor;
    this.releaseExecutor = releaseExecutor;
  }

  async execute(value) {
    const request = strictObject(value, ['actionId', 'targetKind', 'targetId']);
    if (request.actionId === 'restart-and-recover' ||
        (request.actionId === 'retry' && typeof request.targetId === 'string' &&
          (request.targetId.startsWith('job-') || /^op2-[0-9a-f]{32}$/u.test(request.targetId)))) {
      return this.lifecycleExecutor.execute(request);
    }
    return this.releaseExecutor.execute(request);
  }
}

module.exports = {
  CompositeOutcomeActionExecutor,
  CompositeOutcomeReferenceAuthority,
  LifecycleOutcomeActionExecutor,
  LifecycleOutcomeActionIssuer,
  LifecycleOutcomeReferenceAuthority
};
