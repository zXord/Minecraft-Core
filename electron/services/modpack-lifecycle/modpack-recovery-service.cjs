const fs = require('node:fs');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { isNetworkAccess } = require('../../utils/server-network-properties.cjs');
const {
  isUnprovenHealthProcessError,
  stopValidatedHandoff
} = require('../server-health-validator.cjs');
const { consumeReservedTarget } = require('./reserved-target-authority.cjs');
const {
  failureDiagnosticFromError,
  normalizeFailureDiagnostic,
  normalizePublicationFailureDiagnostic,
  publicationFailureDiagnosticFromError
} = require('./publication-failure-diagnostic.cjs');
const transaction = require('./server-directory-transaction.cjs');
const {
  assertServerDirectoryIdentity,
  identifyServerDirectory,
  inspectServerDirectoryStructure,
  inspectServerDirectoryTree
} = require('./server-directory-identity.cjs');

const PRE_PUBLICATION_PHASES = new Set([
  'queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user',
  'preflight', 'snapshotting', 'staging', 'validating-candidate'
]);
const COMMITTED_PHASES = new Set(['committed-healthy', 'cleanup', 'cleanup-pending']);
const CLEANUP_YIELD_BATCH = 64;
const CLEANUP_YIELD_INTERVAL_MS = 16;

function defaultCleanupYield() {
  return new Promise(resolve => setImmediate(resolve));
}

async function yieldCleanupBatch(context, progress, directoryPath, directoryIdentity) {
  progress.entries += 1;
  const now = Date.now();
  if (progress.entries % CLEANUP_YIELD_BATCH !== 0 &&
      now - progress.lastYieldAt < CLEANUP_YIELD_INTERVAL_MS) return;
  await (context.yieldControl || defaultCleanupYield)();
  progress.lastYieldAt = Date.now();
  if (context.signal?.aborted) throw recoveryRequired();
  await assertServerDirectoryIdentity(directoryPath, directoryIdentity, {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector
  });
}

async function flushCleanupDirectory(context, directoryPath) {
  if (typeof context.durableFs.flushDirectoryAsync === 'function') {
    await context.durableFs.flushDirectoryAsync(directoryPath);
  } else {
    context.durableFs.flushDirectory(directoryPath);
    await (context.yieldControl || defaultCleanupYield)();
  }
}

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The modpack recovery request is invalid', { cause });
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'The modpack operation requires reviewed recovery', { cause });
}

function isHealthFailure(error) {
  return error instanceof ModpackError && error.code === 'HEALTH_CHECK_FAILED';
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.volumeSerial === right.volumeSerial && left.fileId === right.fileId);
}

function sameNullableIdentity(left, right) {
  return (left === null && right === null) || sameIdentity(left, right);
}

function pathKey(value) {
  if (typeof value !== 'string' || (!path.isAbsolute(value) && !path.win32.isAbsolute(value))) throw invalid();
  return path.win32.normalize(value.replaceAll('/', '\\')).normalize('NFC').toLocaleLowerCase('en-US');
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function requireMethod(value, method) {
  if (!value || typeof value[method] !== 'function') throw invalid();
  return value;
}

function outcomeWith(record, patch) {
  return { ...(record.outcome || {}), ...patch };
}

function recoveryOutcome(record, action, detail = {}) {
  return outcomeWith(record, {
    recovery: {
      action,
      operationId: record.jobId,
      ...detail
    }
  });
}

function assertRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.jobId !== 'string' ||
      !value.target || !['new', 'existing'].includes(value.target.kind) || typeof value.target.path !== 'string' ||
      typeof value.target.stableServerId !== 'string' || !value.target.stableServerId ||
      typeof value.phase !== 'string' || typeof value.swapStep !== 'string' || !value.directoryIdentities ||
      !value.priorRuntime || typeof value.priorRuntime.running !== 'boolean' ||
      typeof value.priorRuntime.autoRestart !== 'boolean') throw invalid();
  return value;
}

function normalizePaths(record) {
  const expected = record.target.kind === 'existing'
    ? transaction.createExistingSiblingPaths(record.target.path, record.jobId)
    : transaction.createSiblingPaths(record.target.path, record.jobId);
  if (!samePath(expected.targetPath, record.target.path)) throw recoveryRequired();
  for (const key of ['candidatePath', 'failedPath']) {
    if (record[key] !== null && !samePath(record[key], expected[key])) throw recoveryRequired();
  }
  if (record.target.kind === 'existing') {
    if (record.rollbackPath === null || !samePath(record.rollbackPath, expected.rollbackPath)) throw recoveryRequired();
  } else if (record.rollbackPath !== null) {
    throw recoveryRequired();
  }
  return expected;
}

function lstatIfPresent(fsApi, candidate) {
  try {
    return fsApi.lstatSync(candidate, { bigint: true, throwIfNoEntry: false }) || null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw recoveryRequired(error);
  }
}

async function removeDirectoryByIdentity({ context, directoryPath, directoryIdentity }) {
  const fsApi = context.fsApi;
  const progress = { entries: 0, lastYieldAt: Date.now() };
  await assertServerDirectoryIdentity(directoryPath, directoryIdentity, {
    fsApi,
    reparseInspector: context.reparseInspector
  });
  async function removeContents(directory, currentIdentity) {
    const names = fsApi.readdirSync(directory).sort((left, right) => left.localeCompare(right, 'en-US'));
    for (const name of names) {
      const candidate = path.join(directory, name);
      const before = lstatIfPresent(fsApi, candidate);
      if (!before || before.isSymbolicLink() || await context.reparseInspector.isReparsePoint(candidate) !== false) {
        throw recoveryRequired();
      }
      if (before.isDirectory()) {
        const identity = await identifyServerDirectory(candidate, {
          fsApi,
          reparseInspector: context.reparseInspector
        });
        await removeContents(candidate, identity);
        await assertServerDirectoryIdentity(candidate, identity, {
          fsApi,
          reparseInspector: context.reparseInspector
        });
        fsApi.rmdirSync(candidate);
        await yieldCleanupBatch(context, progress, directory, currentIdentity);
      } else if (before.isFile() && BigInt(before.nlink) === 1n) {
        const after = lstatIfPresent(fsApi, candidate);
        if (!after || after.dev !== before.dev || after.ino !== before.ino ||
            after.birthtimeNs !== before.birthtimeNs || BigInt(after.nlink) !== 1n) throw recoveryRequired();
        fsApi.unlinkSync(candidate);
        await yieldCleanupBatch(context, progress, directory, currentIdentity);
      } else {
        throw recoveryRequired();
      }
    }
  }
  await removeContents(directoryPath, directoryIdentity);
  await assertServerDirectoryIdentity(directoryPath, directoryIdentity, {
    fsApi,
    reparseInspector: context.reparseInspector
  });
  fsApi.rmdirSync(directoryPath);
  await flushCleanupDirectory(context, path.dirname(directoryPath));
  return { removed: true };
}

function defaultDirectoryAuthority() {
  return Object.freeze({
    exists(directoryPath, context = null) {
      const fsApi = context?.fsApi || fs;
      return Boolean(lstatIfPresent(fsApi, directoryPath));
    },

    async verifyOperationOwned({ context, directoryPath, directoryIdentity, fingerprint }) {
      if (!directoryIdentity) throw recoveryRequired();
      return transaction.verifyOperationOwnedDirectory(context, directoryPath, directoryIdentity, fingerprint || null);
    },

    async verifyOriginal({ context, directoryPath, directoryIdentity, fingerprint }) {
      if (!directoryIdentity || typeof fingerprint !== 'string') throw recoveryRequired();
      const identity = await assertServerDirectoryIdentity(directoryPath, directoryIdentity, {
        fsApi: context.fsApi,
        reparseInspector: context.reparseInspector,
        signal: context.signal
      });
      const inspection = await inspectServerDirectoryTree(directoryPath, {
        fsApi: context.fsApi,
        reparseInspector: context.reparseInspector,
        signal: context.signal
      });
      if (!sameIdentity(inspection.directoryIdentity, directoryIdentity) || inspection.fingerprint !== fingerprint) {
        throw recoveryRequired();
      }
      return { identity, inspection, fingerprint: inspection.fingerprint };
    },

    async renameExact({ context, fromPath, toPath, directoryIdentity }) {
      if (!directoryIdentity || lstatIfPresent(context.fsApi, toPath)) throw recoveryRequired();
      await assertServerDirectoryIdentity(fromPath, directoryIdentity, {
        fsApi: context.fsApi,
        reparseInspector: context.reparseInspector
      });
      try {
        context.durableFs.renameDurable(fromPath, toPath);
      } catch (error) {
        const source = lstatIfPresent(context.fsApi, fromPath);
        const destination = lstatIfPresent(context.fsApi, toPath);
        if (source || !destination) throw recoveryRequired(error);
      }
      if (lstatIfPresent(context.fsApi, fromPath)) throw recoveryRequired();
      await assertServerDirectoryIdentity(toPath, directoryIdentity, {
        fsApi: context.fsApi,
        reparseInspector: context.reparseInspector
      });
      return { directoryIdentity };
    },

    async removeOperationOwned({
      context,
      directoryPath,
      directoryIdentity,
      fingerprint,
      ownershipMode = 'operation-marker'
    }) {
      if (ownershipMode === 'operation-marker') {
        await this.verifyOperationOwned({ context, directoryPath, directoryIdentity, fingerprint });
      } else if (ownershipMode === 'recorded-identity') {
        await this.verifyOriginal({ context, directoryPath, directoryIdentity, fingerprint });
      } else {
        throw recoveryRequired();
      }
      return removeDirectoryByIdentity({ context, directoryPath, directoryIdentity });
    },

    async removeAuthorizedIdentity({ context, directoryPath, directoryIdentity }) {
      if (!directoryIdentity) throw recoveryRequired();
      return removeDirectoryByIdentity({ context, directoryPath, directoryIdentity });
    },

    async inspectFresh({ context, directoryPath }) {
      const inspection = await inspectServerDirectoryTree(directoryPath, {
        fsApi: context.fsApi,
        reparseInspector: context.reparseInspector
      });
      return {
        directoryIdentity: inspection.directoryIdentity,
        fingerprint: inspection.fingerprint,
        entryCount: inspection.entryCount,
        totalBytes: inspection.totalBytes
      };
    }
  });
}

class ModpackRecoveryService {
  constructor({
    coordinator,
    recoveryRegistry,
    contextFactory,
    directoryAuthority = null,
    consumeReservedTargetFn = consumeReservedTarget,
    runtimePolicy,
    runtimeWriterAuthority = null,
    restorePointResolver = null,
    restorePointService = null,
    transactionApi = transaction
  } = {}) {
    requireMethod(coordinator, 'runRecoveryMutation');
    requireMethod(recoveryRegistry, 'load');
    requireMethod(recoveryRegistry, 'transition');
    requireMethod(recoveryRegistry, 'clearRestoreCreationAfterCleanup');
    requireMethod(recoveryRegistry, 'finish');
    if (typeof contextFactory !== 'function') throw invalid();
    requireMethod(runtimePolicy, 'suspend');
    requireMethod(runtimePolicy, 'ensureStopped');
    requireMethod(runtimePolicy, 'adoptValidatedHandoff');
    requireMethod(runtimePolicy, 'restoreAutoRestart');
    for (const method of [
      'publishNewCandidate', 'registerPublishedInstance', 'markCommittedHealthy', 'cleanupCommittedTransaction',
      'prepareNewLiveValidation', 'completeNewLiveValidation', 'verifyCommittedCanonicalDirectory',
      'verifyCommittedNewPublication', 'verifyMutableNewOperationOwnedDirectory',
      'verifyMutableOperationOwnedDirectory'
    ]) requireMethod(transactionApi, method);
    const authority = directoryAuthority || defaultDirectoryAuthority();
    for (const method of [
      'exists', 'verifyOperationOwned', 'verifyOriginal', 'renameExact', 'removeOperationOwned',
      'removeAuthorizedIdentity', 'inspectFresh'
    ]) requireMethod(authority, method);
    if (restorePointResolver !== null && typeof restorePointResolver !== 'function') throw invalid();
    if (typeof consumeReservedTargetFn !== 'function') throw invalid();
    if (restorePointService !== null) {
      requireMethod(restorePointService, 'cleanupInterruptedRestorePointCreation');
      requireMethod(restorePointService, 'verifyRestorePoint');
      requireMethod(restorePointService, 'restoreToFreshCandidate');
    }
    this.coordinator = coordinator;
    this.registry = recoveryRegistry;
    this.contextFactory = contextFactory;
    this.consumeReservedTarget = consumeReservedTargetFn;
    this.directoryAuthority = authority;
    this.runtimePolicy = runtimePolicy;
    this.runtimeWriterAuthority = runtimeWriterAuthority;
    this.restorePointResolver = restorePointResolver;
    this.restorePointService = restorePointService;
    this.transaction = transactionApi;
  }

  async recoverAll(scanResult) {
    if (!scanResult || typeof scanResult !== 'object' || !Array.isArray(scanResult.records) ||
        !Array.isArray(scanResult.corrupt)) throw invalid();
    if (scanResult.pendingTerminalPublications !== undefined && (!Array.isArray(scanResult.pendingTerminalPublications) ||
        scanResult.pendingTerminalPublications.some(record => !record || typeof record.jobId !== 'string'))) throw invalid();
    const corrupt = new Set(scanResult.corrupt.map(item => item?.jobId).filter(value => typeof value === 'string'));
    const recovered = [];
    const unresolved = [];
    for (const rawRecord of scanResult.records) {
      let current;
      try { current = assertRecord(rawRecord); } catch {
        continue;
      }
      if (corrupt.has(current.jobId)) {
        unresolved.push(current.jobId);
        continue;
      }
      try {
        const result = await this.recover(current);
        if (result.resolved) recovered.push(current.jobId);
        else unresolved.push(current.jobId);
      } catch {
        unresolved.push(current.jobId);
      }
    }
    for (const rawRecord of scanResult.pendingTerminalPublications || []) {
      try {
        const current = assertRecord(rawRecord);
        if (corrupt.has(current.jobId)) { unresolved.push(current.jobId); continue; }
        const result = await this.retryTerminalPublication(current);
        (result.resolved ? recovered : unresolved).push(current.jobId);
      } catch {
        if (typeof rawRecord?.jobId === 'string') unresolved.push(rawRecord.jobId);
      }
    }
    for (const jobId of corrupt) {
      if (!unresolved.includes(jobId)) unresolved.push(jobId);
    }
    return deepFreeze({
      recovered: [...new Set(recovered)].sort((left, right) => left.localeCompare(right, 'en-US')),
      unresolved: [...new Set(unresolved)].sort((left, right) => left.localeCompare(right, 'en-US'))
    });
  }

  recover(recordValue) {
    return this.#run(recordValue, (record, context, paths) =>
      record.target.kind === 'new'
        ? this.#recoverNew(record, context, paths)
        : this.#recoverExisting(record, context, paths));
  }

  rollback(recordValue, reason = 'startup-recovery') {
    return this.#run(recordValue, (record, context, paths) => {
      if (record.target.kind !== 'existing') throw recoveryRequired();
      return this.#rollbackExisting(record, context, paths, reason);
    });
  }

  recoverNewPublication(recordValue) {
    return this.#run(recordValue, (record, context, paths) => {
      if (record.target.kind !== 'new') throw invalid();
      return this.#recoverNewPublication(record, context, paths);
    });
  }

  recoverExistingSwap(recordValue) {
    return this.#run(recordValue, (record, context, paths) => {
      if (record.target.kind !== 'existing') throw invalid();
      return this.#recoverExisting(record, context, paths);
    });
  }

  retryCommittedCleanup(recordValue) {
    return this.#run(recordValue, (record, context, paths) => {
      if (record.target.kind !== 'existing' || !COMMITTED_PHASES.has(record.phase)) throw invalid();
      return this.#retryCommittedCleanup(record, context, paths);
    });
  }

  recoverWithLease(recordValue, mutationLease) {
    return this.#runWithLease(recordValue, mutationLease, (record, context, paths) =>
      record.target.kind === 'new'
        ? this.#recoverNew(record, context, paths)
        : this.#recoverExisting(record, context, paths));
  }

  rollbackWithLease(recordValue, mutationLease, reason = 'lifecycle-rollback') {
    return this.#runWithLease(recordValue, mutationLease, (record, context, paths) => {
      if (record.target.kind !== 'existing') throw invalid();
      return this.#rollbackExisting(record, context, paths, reason);
    });
  }

  failNewWithLease(recordValue, mutationLease, reason = recoveryRequired()) {
    return this.#runWithLease(recordValue, mutationLease, (record, context, paths) => {
      if (record.target.kind !== 'new') throw invalid();
      return this.#failNewCanonical(record, context, paths, reason);
    });
  }

  // A discovered bookkeeping item must not fall through to source work.
  retryTerminalPublication(recordValue) {
    return this.#run(recordValue, null, { metadataOnly: true });
  }

  async #completeTerminalPublication(initial, mutationLease) {
    requireMethod(this.coordinator, 'assertMutationLease');
    this.coordinator.assertMutationLease(mutationLease, {
      instanceId: initial.target.stableServerId, serverPath: initial.target.path
    }, initial.jobId);
    requireMethod(this.registry, 'retryTerminalPublication');
    const publication = await this.registry.retryTerminalPublication(initial.jobId, {
      expectedTarget: initial.target, expectedOperationKind: initial.operationKind
    });
    const record = assertRecord(publication.record);
    this.#assertBinding(initial, record);
    const failure = normalizeFailureDiagnostic(record.outcome?.failure);
    return deepFreeze({ jobId: initial.jobId, resolved: true, action: 'already-finished',
      historyPublication: publication.status, ...(failure ? { failure } : {}) });
  }

  #assertBinding(initial, durableRecord) {
    if (durableRecord.jobId !== initial.jobId || durableRecord.operationKind !== initial.operationKind ||
        durableRecord.target.kind !== initial.target.kind ||
        durableRecord.target.stableServerId !== initial.target.stableServerId ||
        !samePath(durableRecord.target.path, initial.target.path)) throw recoveryRequired();
  }

  async #run(recordValue, work, { metadataOnly = false } = {}) {
    const initial = assertRecord(recordValue);
    const paths = normalizePaths(initial);
    try {
      return await this.coordinator.runRecoveryMutation({
        instanceId: initial.target.stableServerId,
        serverPath: initial.target.path
      }, { operationId: initial.jobId }, async mutationLease => {
        if (metadataOnly) return this.#completeTerminalPublication(initial, mutationLease);
        let durableRecord = await this.registry.load(initial.jobId);
        if (!durableRecord) return this.#completeTerminalPublication(initial, mutationLease);
        assertRecord(durableRecord);
        normalizePaths(durableRecord);
        this.#assertBinding(initial, durableRecord);
        durableRecord = await this.#assertRuntimeWriters(durableRecord, mutationLease);
        const hold = await this.runtimePolicy.suspend({
          instanceId: initial.target.stableServerId,
          jobId: initial.jobId,
          operationId: initial.jobId,
          serverPath: initial.target.path
        });
        if (!hold || hold.held !== true) throw recoveryRequired();
        const context = await this.contextFactory({ record: durableRecord, mutationLease });
        if (!context || typeof context !== 'object') throw recoveryRequired();
        context.runtimePolicy = context.runtimePolicy || this.runtimePolicy;
        return work(durableRecord, context, paths);
      });
    } catch (error) {
      throw recoveryRequired(error);
    }
  }

  async #runWithLease(recordValue, mutationLease, work) {
    const initial = assertRecord(recordValue);
    const paths = normalizePaths(initial);
    try {
      if (!mutationLease || mutationLease.kind !== 'mutation' ||
          mutationLease.instanceId !== initial.target.stableServerId ||
          !samePath(mutationLease.serverPath, initial.target.path) ||
          typeof mutationLease.markDirty !== 'function') throw invalid();
      let durableRecord = await this.registry.load(initial.jobId);
      if (!durableRecord) return await this.#completeTerminalPublication(initial, mutationLease);
      assertRecord(durableRecord);
      normalizePaths(durableRecord);
      this.#assertBinding(initial, durableRecord);
      durableRecord = await this.#assertRuntimeWriters(durableRecord, mutationLease);
      const context = await this.contextFactory({ record: durableRecord, mutationLease });
      if (!context || typeof context !== 'object') throw recoveryRequired();
      context.runtimePolicy = context.runtimePolicy || this.runtimePolicy;
      return await work(durableRecord, context, paths);
    } catch (error) {
      throw recoveryRequired(error);
    }
  }

  #exists(directoryPath, context) {
    try { return Boolean(this.directoryAuthority.exists(directoryPath, context)); }
    catch (error) { throw recoveryRequired(error); }
  }

  #assertAbsent(directoryPath, context) {
    if (this.#exists(directoryPath, context)) throw recoveryRequired();
  }

  #verifyOwned(context, directoryPath, identity, fingerprint) {
    if (!identity || typeof fingerprint !== 'string') throw recoveryRequired();
    return this.directoryAuthority.verifyOperationOwned({
      context,
      directoryPath,
      directoryIdentity: identity,
      fingerprint
    }).catch(error => { throw recoveryRequired(error); });
  }

  async #assertRuntimeWriters(record, lease) {
    if (typeof this.runtimeWriterAuthority?.assertRecoveryAllowed !== 'function') throw recoveryRequired();
    return this.runtimeWriterAuthority.assertRecoveryAllowed(record, { lease });
  }

  async #verifyCandidateForCleanup(record, context, directoryPath) {
    const identity = record.directoryIdentities?.candidate || null;
    const fingerprint = record.outcome?.candidate?.fingerprint || null;
    if (identity && typeof fingerprint === 'string') {
      await this.#verifyOwned(context, directoryPath, identity, fingerprint);
      return { directoryIdentity: identity, fingerprint, ownershipMode: 'operation-marker' };
    }
    if (fingerprint !== null) throw recoveryRequired();
    let inspection;
    try {
      inspection = await this.directoryAuthority.inspectFresh({ context, directoryPath });
    } catch (error) {
      throw recoveryRequired(error);
    }
    if (!inspection || !inspection.directoryIdentity || typeof inspection.fingerprint !== 'string' ||
        !Number.isSafeInteger(inspection.entryCount) || inspection.entryCount < 0 ||
        typeof inspection.totalBytes !== 'string' || !/^\d+$/u.test(inspection.totalBytes)) {
      throw recoveryRequired();
    }
    if (identity) {
      if (!sameIdentity(inspection.directoryIdentity, identity)) throw recoveryRequired();
    } else if (inspection.entryCount !== 0 || inspection.totalBytes !== '0') {
      throw recoveryRequired();
    }
    return {
      directoryIdentity: identity || inspection.directoryIdentity,
      fingerprint: inspection.fingerprint,
      ownershipMode: 'recorded-identity'
    };
  }

  #candidateCleanupAuthorization(record, directoryPath, action) {
    const authorization = record.outcome?.candidateCleanup;
    if (authorization === undefined) return null;
    const expectedPath = normalizePaths(record).candidatePath;
    const recordedIdentity = record.directoryIdentities?.candidate || null;
    const recordedFingerprint = record.outcome?.candidate?.fingerprint || null;
    if (!authorization || authorization.deletionAuthorized !== true || authorization.slot !== 'candidate' ||
        authorization.action !== action || !samePath(directoryPath, expectedPath) ||
        !authorization.directoryIdentity || typeof authorization.fingerprint !== 'string' ||
        !['operation-marker', 'recorded-identity'].includes(authorization.ownershipMode) ||
        (recordedIdentity && !sameIdentity(authorization.directoryIdentity, recordedIdentity)) ||
        (recordedFingerprint && authorization.fingerprint !== recordedFingerprint)) throw recoveryRequired();
    return authorization;
  }

  async #authorizeCandidateCleanup(record, context, directoryPath, action) {
    let current = await this.registry.load(record.jobId) || record;
    let authorization = this.#candidateCleanupAuthorization(current, directoryPath, action);
    if (authorization) return { authorization, record: current };
    const evidence = await this.#verifyCandidateForCleanup(current, context, directoryPath);
    authorization = {
      deletionAuthorized: true,
      slot: 'candidate',
      action,
      directoryIdentity: evidence.directoryIdentity,
      fingerprint: evidence.fingerprint,
      ownershipMode: evidence.ownershipMode
    };
    current = await this.registry.transition(current.jobId, {
      expectedPhase: current.phase,
      nextPhase: current.phase,
      patch: { outcome: outcomeWith(current, { candidateCleanup: authorization }) }
    });
    return { authorization, record: current };
  }

  async #removeCandidateForCleanup(record, context, directoryPath, action) {
    let current = await this.registry.load(record.jobId) || record;
    const existingAuthorization = this.#candidateCleanupAuthorization(current, directoryPath, action);
    if (!this.#exists(directoryPath, context)) return current;
    const authorized = existingAuthorization
      ? { authorization: existingAuthorization, record: current }
      : await this.#authorizeCandidateCleanup(current, context, directoryPath, action);
    try {
      await this.directoryAuthority.removeAuthorizedIdentity({
        context,
        directoryPath,
        directoryIdentity: authorized.authorization.directoryIdentity
      });
    } catch (error) {
      throw recoveryRequired(error);
    }
    return authorized.record;
  }

  async #syncOwnedJournal(evidence, nextPhase, swapStep, patch = {}) {
    if (!evidence?.journal || typeof evidence.journal.transition !== 'function' ||
        !evidence.journalRecord || typeof evidence.locations?.journalPath !== 'string') return null;
    if (evidence.journalRecord.phase === nextPhase && evidence.journalRecord.swapStep === swapStep) {
      for (const key of ['targetIdentity', 'rollbackIdentity', 'failedIdentity']) {
        if (Object.hasOwn(patch, key) && !sameNullableIdentity(evidence.journalRecord[key], patch[key])) {
          throw recoveryRequired();
        }
      }
      return evidence.journalRecord;
    }
    try {
      return await evidence.journal.transition(evidence.locations.journalPath, {
        expectedPhase: evidence.journalRecord.phase,
        nextPhase,
        patch: { swapStep, ...patch }
      });
    } catch (error) {
      throw recoveryRequired(error);
    }
  }

  #verifyOriginal(context, directoryPath, identity, fingerprint) {
    if (!identity || typeof fingerprint !== 'string') throw recoveryRequired();
    return this.directoryAuthority.verifyOriginal({
      context,
      directoryPath,
      directoryIdentity: identity,
      fingerprint
    }).catch(error => { throw recoveryRequired(error); });
  }

  async #verifyIdentity(context, directoryPath, identity) {
    if (!identity) throw recoveryRequired();
    let inspection;
    try {
      inspection = await this.directoryAuthority.inspectFresh({ context, directoryPath });
    } catch (error) {
      throw recoveryRequired(error);
    }
    if (!inspection?.directoryIdentity || !sameIdentity(inspection.directoryIdentity, identity)) {
      throw recoveryRequired();
    }
    return inspection;
  }

  async #rename(context, fromPath, toPath, identity) {
    this.#assertAbsent(toPath, context);
    try {
      await this.directoryAuthority.renameExact({
        context,
        fromPath,
        toPath,
        directoryIdentity: identity
      });
    } catch (error) {
      throw recoveryRequired(error);
    }
  }

  async #finish(record, terminalPhase, action, detail = {}) {
    await this.registry.finish(record.jobId, {
      terminalPhase,
      outcome: record.phase === terminalPhase
        ? record.outcome
        : recoveryOutcome(record, action, detail)
    });
    const failure = normalizeFailureDiagnostic(record.outcome?.failure);
    return deepFreeze({
      jobId: record.jobId,
      resolved: true,
      action,
      ...(failure ? { failure } : {})
    });
  }

  async #persistPublicationFailure(record, reason) {
    const stored = normalizePublicationFailureDiagnostic(record.outcome?.failure);
    if (stored) return record;
    const failure = publicationFailureDiagnosticFromError(reason);
    return this.registry.transition(record.jobId, {
      expectedPhase: record.phase,
      nextPhase: record.phase,
      patch: { outcome: outcomeWith(record, { failure }) }
    });
  }

  async #reconcileReleaseTracking(record, context) {
    const intent = record.outcome?.releaseTracking;
    if (!intent) return record;
    if (!context.releaseTrackingReconciler || typeof context.releaseTrackingReconciler.reconcile !== 'function') {
      throw recoveryRequired();
    }
    try {
      await context.releaseTrackingReconciler.reconcile(record.jobId);
      const current = await this.registry.load(record.jobId);
      if (!current || current.outcome?.releaseTracking?.status !== 'applied') throw recoveryRequired();
      return current;
    } catch (error) {
      throw recoveryRequired(error);
    }
  }

  async #recoverNew(record, context, paths) {
    if (record.phase === 'failed') return this.#recoverTerminalNewFailure(record, context, paths);
    if (PRE_PUBLICATION_PHASES.has(record.phase) || (record.phase === 'committing' && record.swapStep === 'none')) {
      return this.#recoverNewBeforePublication(record, context, paths);
    }
    if (record.phase === 'publishing' && record.swapStep === 'new-prepared') {
      return this.#recoverNewPublication(record, context, paths);
    }
    if (['published', 'registering', 'starting', 'validating-live', 'committed-healthy'].includes(record.phase) &&
        record.swapStep === 'candidate-published') {
      return this.#completeNewPublication(record, context, paths);
    }
    if (record.phase === 'rolling-back' &&
        ['candidate-published', 'failed-canonical-moved'].includes(record.swapStep)) {
      return this.#failNewCanonical(record, context, paths, recoveryRequired());
    }
    if (record.phase === 'completed' && record.swapStep === 'candidate-published') {
      if (record.outcome?.liveMutationAuthorized === true) {
        await this.transaction.verifyMutableNewOperationOwnedDirectory(
          context,
          paths.targetPath,
          record.directoryIdentities.target
        );
      } else {
        await this.transaction.verifyCommittedNewPublication(context);
      }
      const targetRunning = record.outcome?.runtimePolicy?.targetRunning ?? record.priorRuntime.running;
      if (targetRunning) {
        await this.#restoreCanonicalPolicy(record, context, 'target');
      } else {
        await this.#stopRuntime(record, context);
        await this.#restoreAutoRestart(record, context, 'target');
      }
      return this.#finish(record, 'completed', 'new-publication-completed');
    }
    throw recoveryRequired();
  }

  async #recoverTerminalNewFailure(record, context, paths) {
    const action = record.outcome?.recovery?.action;
    if (action === 'pre-publication-cleanup') {
      this.#assertAbsent(paths.targetPath, context);
      this.#assertAbsent(paths.failedPath, context);
      let current = record;
      if (this.#exists(paths.candidatePath, context)) {
        if (!this.#candidateCleanupAuthorization(current, paths.candidatePath, action)) throw recoveryRequired();
        current = await this.#removeCandidateForCleanup(current, context, paths.candidatePath, action);
      }
      this.#assertAbsent(paths.candidatePath, context);
      return this.#finish(current, 'failed', action);
    }
    this.#assertAbsent(paths.candidatePath, context);
    if (action !== 'new-health-failed' || record.swapStep !== 'failed-canonical-moved') {
      throw recoveryRequired();
    }
    this.#assertAbsent(paths.targetPath, context);
    if (!this.#exists(paths.failedPath, context)) throw recoveryRequired();
    const fingerprint = record.outcome?.publication?.candidateFingerprint || record.outcome?.candidate?.fingerprint;
    const failedEvidence = record.outcome?.liveMutationAuthorized === true
      ? await this.transaction.verifyMutableNewOperationOwnedDirectory(
          context,
          paths.failedPath,
          record.directoryIdentities.failed
        )
      : await this.#verifyOwned(
          context,
          paths.failedPath,
          record.directoryIdentities.failed,
          fingerprint
        );
    await this.#syncOwnedJournal(failedEvidence, 'failed', 'failed-canonical-moved', {
      targetIdentity: null,
      failedIdentity: record.directoryIdentities.failed
    });
    if (record.outcome?.registration?.complete === true) {
      if (typeof context.unregisterPublishedInstance !== 'function') throw recoveryRequired();
      await context.unregisterPublishedInstance(record);
    }
    return this.#finish(record, 'failed', action);
  }

  async #recoverNewBeforePublication(record, context, paths) {
    if (this.#exists(paths.targetPath, context) && record.outcome?.reservation) {
      await this.consumeReservedTarget({
        targetPath: paths.targetPath,
        reservation: record.outcome.reservation,
        mutationLease: context.mutationLease,
        durableFs: context.durableFs,
        fsApi: context.fsApi,
        reparseInspector: context.reparseInspector,
        signal: context.signal
      }).catch(error => { throw recoveryRequired(error); });
    }
    this.#assertAbsent(paths.targetPath, context);
    this.#assertAbsent(paths.failedPath, context);
    let current = await this.registry.load(record.jobId) || record;
    if (this.#exists(paths.candidatePath, context)) {
      if (!current.outcome?.candidateCleanup) {
        await this.#verifyCandidateForCleanup(current, context, paths.candidatePath);
      }
      await this.#stopRuntime(current, context);
      if (this.#exists(paths.candidatePath, context)) {
        current = (await this.#authorizeCandidateCleanup(
          current,
          context,
          paths.candidatePath,
          'pre-publication-cleanup'
        )).record;
      }
    }
    if (current.phase !== 'failed') {
      current = await this.registry.transition(current.jobId, {
        expectedPhase: current.phase,
        nextPhase: 'failed',
        patch: { outcome: recoveryOutcome(current, 'pre-publication-cleanup') }
      });
    }
    if (this.#exists(paths.candidatePath, context)) {
      current = await this.#removeCandidateForCleanup(
        current,
        context,
        paths.candidatePath,
        'pre-publication-cleanup'
      );
    }
    return this.#finish(current, 'failed', 'pre-publication-cleanup');
  }

  async #recoverNewPublication(record, context, paths) {
    const targetPresent = this.#exists(paths.targetPath, context);
    const candidatePresent = this.#exists(paths.candidatePath, context);
    this.#assertAbsent(paths.failedPath, context);
    if (targetPresent === candidatePresent) throw recoveryRequired();
    const fingerprint = record.outcome?.publication?.candidateFingerprint || record.outcome?.candidate?.fingerprint;
    if (targetPresent) {
      await this.#verifyOwned(context, paths.targetPath, record.directoryIdentities.target || record.directoryIdentities.candidate, fingerprint);
    } else {
      await this.#verifyOwned(context, paths.candidatePath, record.directoryIdentities.candidate, fingerprint);
    }
    await this.transaction.publishNewCandidate(context);
    const published = await this.registry.load(record.jobId);
    if (!published || published.phase !== 'published' || published.swapStep !== 'candidate-published') throw recoveryRequired();
    return this.#completeNewPublication(published, context, paths);
  }

  async #completeNewPublication(record, context, paths) {
    this.#assertAbsent(paths.candidatePath, context);
    this.#assertAbsent(paths.failedPath, context);
    if (!this.#exists(paths.targetPath, context)) throw recoveryRequired();
    const fingerprint = record.outcome?.publication?.candidateFingerprint || record.outcome?.candidate?.fingerprint;
    const filesOnly = record.operationKind === 'import';
    if (record.phase === 'committed-healthy' && record.outcome?.liveMutationAuthorized !== true) {
      await this.transaction.verifyCommittedNewPublication(context);
    } else if (record.outcome?.liveMutationAuthorized === true) {
      await this.transaction.verifyMutableNewOperationOwnedDirectory(
        context,
        paths.targetPath,
        record.directoryIdentities.target
      );
    } else {
      await this.#verifyOwned(context, paths.targetPath, record.directoryIdentities.target, fingerprint);
    }

    if (record.outcome?.registration?.complete !== true) {
      await this.transaction.registerPublishedInstance(context);
    }
    let registered = await this.registry.load(record.jobId);
    if (!registered || registered.outcome?.registration?.complete !== true) throw recoveryRequired();

    let validation;
    try {
      if (registered.phase === 'committed-healthy') {
        validation = registered.outcome?.health;
        if (!validation || typeof validation !== 'object' || Array.isArray(validation)) throw recoveryRequired();
        const targetRunning = registered.outcome?.runtimePolicy?.targetRunning ?? registered.priorRuntime.running;
        if (targetRunning) {
          await this.#restoreCanonicalPolicy(registered, context, 'target', { restoreAutoRestart: false });
        } else {
          await this.#stopRuntime(registered, context);
        }
      } else if (filesOnly) {
        if (!['registering', 'validating-live'].includes(registered.phase)) throw recoveryRequired();
        validation = await this.#validateInactiveNewCanonical(registered, context);
      } else if (registered.outcome?.runtimePolicy?.targetRunning === false &&
          registered.outcome?.candidate?.health && registered.outcome?.liveMutationAuthorized !== true &&
          typeof this.transaction.verifyPublishedNewCandidate === 'function') {
        validation = await this.transaction.verifyPublishedNewCandidate(context);
        registered = await this.registry.load(record.jobId);
        if (!registered || !['registering', 'committed-healthy'].includes(registered.phase)) throw recoveryRequired();
      } else {
        const authorization = await this.transaction.prepareNewLiveValidation(context);
        registered = await this.registry.load(record.jobId);
        if (!registered || !['validating-live', 'committed-healthy'].includes(registered.phase)) throw recoveryRequired();
        validation = await this.#restoreCanonicalPolicy(registered, context, 'target', { restoreAutoRestart: false });
        try {
          await this.transaction.completeNewLiveValidation(context, authorization);
        } catch (error) {
          try {
            await this.#stopRuntime(registered, context);
          } catch (stopError) {
            throw recoveryRequired(new AggregateError(
              [error, stopError],
              'Canonical completion failed and the adopted server could not be stopped'
            ));
          }
          throw error;
        }
        registered = await this.registry.load(record.jobId);
        if (!registered || !['validating-live', 'committed-healthy'].includes(registered.phase)) throw recoveryRequired();
      }
    } catch (error) {
      if (isUnprovenHealthProcessError(error)) throw recoveryRequired(error);
      if (!isHealthFailure(error.cause || error) && !isHealthFailure(error)) throw error;
      if (registered.phase === 'committed-healthy') throw recoveryRequired(error);
      return this.#failNewCanonical(registered, context, paths, error);
    }
    registered = await this.#finalizeNewCommittedOutcome(registered, context, validation);
    await this.#restoreAutoRestart(registered, context);
    registered = await this.registry.load(record.jobId) || registered;
    return this.#finish(registered, 'completed', 'new-publication-completed');
  }

  async #validateInactiveNewCanonical(record, context) {
    if (record.outcome?.runtimePolicy?.targetRunning !== false ||
        record.outcome?.runtimePolicy?.targetAutoRestart !== false) throw recoveryRequired();
    await this.#stopRuntime(record, context);
    return deepFreeze({ skipped: true, reason: 'files-only' });
  }

  #readCanonicalNewState(record, context) {
    let loaded;
    try {
      loaded = requireMethod(context.stateRepository, 'read').read(record.target.path);
    } catch (error) {
      throw recoveryRequired(error);
    }
    const state = loaded?.state;
    if (!state || !Number.isSafeInteger(state.contentRevision) || state.contentRevision < 1 ||
        !state.source || typeof state.source !== 'object' || Array.isArray(state.source)) throw recoveryRequired();
    return state;
  }

  #newRevisionEvent(record, state) {
    return deepFreeze({
      eventId: `modpack-content-revision:${record.jobId}:${state.contentRevision}`,
      instanceId: record.target.stableServerId,
      operationKind: record.operationKind,
      targetRevision: state.contentRevision
    });
  }

  async #finalizeNewCommittedOutcome(record, context, validation) {
    if (!record || !['registering', 'validating-live', 'committed-healthy'].includes(record.phase) ||
        record.outcome?.registration?.complete !== true) throw recoveryRequired();
    const state = this.#readCanonicalNewState(record, context);
    const event = this.#newRevisionEvent(record, state);
    const reconciler = context.releaseTrackingReconciler;
    if (!reconciler || ['createIntent', 'persistIntent', 'reconcile'].some(method =>
      typeof reconciler[method] !== 'function')) throw recoveryRequired();
    let intent = record.outcome?.releaseTracking;
    if (intent === undefined) {
      try {
        intent = reconciler.createIntent({
          serverId: record.target.stableServerId,
          operationKind: record.operationKind,
          source: state.source
        });
      } catch (error) {
        throw recoveryRequired(error);
      }
    }

    let current = record;
    if (['registering', 'validating-live'].includes(current.phase)) {
      const expectedPhase = current.phase;
      const targetRunning = current.outcome?.runtimePolicy?.targetRunning ?? current.priorRuntime.running;
      current = await this.registry.transition(current.jobId, {
        expectedPhase,
        nextPhase: 'committed-healthy',
        patch: {
          outcome: outcomeWith(current, {
            health: validation?.evidence || validation || { ok: true },
            runtimePolicy: {
              ...(current.outcome?.runtimePolicy || {}),
              handoffEventId: record.operationKind !== 'import' && targetRunning
                ? `modpack-runtime-handoff:${current.jobId}`
                : null,
              runningRestored: record.operationKind !== 'import' && targetRunning
            },
            revisionEvent: { eventId: event.eventId, published: false },
            releaseTracking: intent
          })
        }
      });
    } else {
      const storedEvent = current.outcome?.revisionEvent;
      if (storedEvent !== undefined && storedEvent?.eventId !== event.eventId) throw recoveryRequired();
      if (storedEvent === undefined || current.outcome?.releaseTracking === undefined) {
        current = await this.registry.transition(current.jobId, {
          expectedPhase: 'committed-healthy',
          nextPhase: 'committed-healthy',
          patch: {
            outcome: outcomeWith(current, {
              ...(storedEvent === undefined
                ? { revisionEvent: { eventId: event.eventId, published: false } }
                : {}),
              ...(current.outcome?.releaseTracking === undefined ? { releaseTracking: intent } : {})
            })
          }
        });
      }
    }

    if (current.outcome?.releaseTracking?.status === 'pending') {
      try {
        await reconciler.persistIntent(current.jobId, current.outcome.releaseTracking);
      } catch (error) {
        throw recoveryRequired(error);
      }
    } else if (current.outcome?.releaseTracking?.status !== 'applied') {
      throw recoveryRequired();
    }
    current = await this.registry.load(current.jobId) || current;
    if (current.phase !== 'committed-healthy' || current.outcome?.revisionEvent?.eventId !== event.eventId) {
      throw recoveryRequired();
    }
    if (current.outcome.revisionEvent.published !== true) {
      try {
        await requireMethod(context.revisionPublisher, 'publishOnce').publishOnce(event);
      } catch (error) {
        throw recoveryRequired(error);
      }
      current = await this.registry.transition(current.jobId, {
        expectedPhase: 'committed-healthy',
        nextPhase: 'committed-healthy',
        patch: {
          outcome: outcomeWith(current, {
            revisionEvent: { eventId: event.eventId, published: true }
          })
        }
      });
    }
    return this.#reconcileReleaseTracking(current, context);
  }

  async #failNewCanonical(record, context, paths, reason) {
    if (isUnprovenHealthProcessError(reason)) throw recoveryRequired(reason);
    let current = await this.registry.load(record.jobId) || record;
    const targetInitiallyPresent = this.#exists(paths.targetPath, context);
    const candidateInitiallyPresent = this.#exists(paths.candidatePath, context);
    const failedInitiallyPresent = this.#exists(paths.failedPath, context);
    const normalPrePublication = PRE_PUBLICATION_PHASES.has(current.phase) ||
      (current.phase === 'committing' && current.swapStep === 'none') ||
      (current.phase === 'publishing' && current.swapStep === 'new-prepared');
    const legacyMisclassifiedPrePublication = current.phase === 'rolling-back' &&
      current.swapStep === 'candidate-published' && current.outcome?.recovery?.action === 'new-health-failed' &&
      current.outcome?.publication?.state === 'publishing';
    if (normalPrePublication || legacyMisclassifiedPrePublication) {
      current = await this.#persistPublicationFailure(current, reason);
    } else {
      const failure = failureDiagnosticFromError(reason);
      if (failure && !normalizeFailureDiagnostic(current.outcome?.failure)) {
        current = await this.registry.transition(current.jobId, {
          expectedPhase: current.phase,
          nextPhase: current.phase,
          patch: { outcome: outcomeWith(current, { failure }) }
        });
      }
    }
    if ((normalPrePublication || legacyMisclassifiedPrePublication) && !targetInitiallyPresent && !failedInitiallyPresent &&
        current.directoryIdentities?.target === null && current.outcome?.registration?.complete !== true &&
        current.outcome?.liveMutationAuthorized !== true) {
      if (candidateInitiallyPresent || normalPrePublication) {
        return this.#recoverNewBeforePublication(current, context, paths);
      }
    }
    if (current.outcome?.registration?.complete === true && typeof context.unregisterPublishedInstance !== 'function') {
      throw recoveryRequired(reason);
    }
    if (current.phase !== 'rolling-back') {
      current = await this.registry.transition(current.jobId, {
        expectedPhase: current.phase,
        nextPhase: 'rolling-back',
        patch: { swapStep: 'candidate-published', outcome: recoveryOutcome(current, 'new-health-failed') }
      });
    }
    const fingerprint = current.outcome?.publication?.candidateFingerprint || current.outcome?.candidate?.fingerprint;
    const verifyCandidateDirectory = (directoryPath, directoryIdentity) =>
      current.outcome?.liveMutationAuthorized === true
        ? this.transaction.verifyMutableNewOperationOwnedDirectory(context, directoryPath, directoryIdentity)
        : this.#verifyOwned(context, directoryPath, directoryIdentity, fingerprint);
    const targetPresent = this.#exists(paths.targetPath, context);
    const failedPresent = this.#exists(paths.failedPath, context);
    this.#assertAbsent(paths.candidatePath, context);
    if (targetPresent && failedPresent) throw recoveryRequired();
    if (current.swapStep === 'candidate-published') {
      await this.#stopRuntime(current, context);
      let failedEvidence;
      if (targetPresent) {
        const targetEvidence = await verifyCandidateDirectory(paths.targetPath, current.directoryIdentities.target);
        await this.#syncOwnedJournal(targetEvidence, 'rolling-back', 'candidate-published', {
          targetIdentity: current.directoryIdentities.target
        });
        this.#assertAbsent(paths.failedPath, context);
        await this.#rename(context, paths.targetPath, paths.failedPath, current.directoryIdentities.target);
      } else if (!failedPresent) {
        throw recoveryRequired();
      }
      failedEvidence = await verifyCandidateDirectory(paths.failedPath, current.directoryIdentities.target);
      await this.#syncOwnedJournal(failedEvidence, 'rolling-back', 'failed-canonical-moved', {
        targetIdentity: null,
        failedIdentity: current.directoryIdentities.target
      });
      current = await this.registry.transition(current.jobId, {
        expectedPhase: 'rolling-back',
        nextPhase: 'rolling-back',
        patch: {
          swapStep: 'failed-canonical-moved',
          directoryIdentities: {
            ...current.directoryIdentities,
            target: null,
            failed: current.directoryIdentities.target
          },
          outcome: recoveryOutcome(current, 'new-health-failed')
        }
      });
    }
    const failedEvidence = await verifyCandidateDirectory(paths.failedPath, current.directoryIdentities.failed);
    await this.#syncOwnedJournal(failedEvidence, 'failed', 'failed-canonical-moved', {
      targetIdentity: null,
      failedIdentity: current.directoryIdentities.failed
    });
    this.#assertAbsent(paths.targetPath, context);
    if (current.outcome?.registration?.complete === true) await context.unregisterPublishedInstance(current);
    return this.#finish(current, 'failed', 'new-health-failed');
  }

  async #recoverExisting(record, context, paths) {
    if (record.phase === 'completed' && record.swapStep === 'cleanup-complete') {
      this.#assertAbsent(paths.candidatePath, context);
      this.#assertAbsent(paths.rollbackPath, context);
      try {
        await this.transaction.verifyCommittedCanonicalDirectory(context);
      } catch (error) {
        throw recoveryRequired(error);
      }
      const cleanup = await this.transaction.cleanupCommittedTransaction(context);
      if (cleanup?.phase !== 'completed' || cleanup.rollbackRemoved !== true) throw recoveryRequired();
      await this.#restoreCanonicalPolicy(record, context, 'target');
      return this.#finish(record, 'completed', 'committed-cleanup-completed');
    }
    if (['failed', 'rolled-back'].includes(record.phase)) {
      return this.#recoverTerminalExisting(record, context, paths);
    }
    if (COMMITTED_PHASES.has(record.phase)) return this.#retryCommittedCleanup(record, context, paths);
    if (record.phase === 'rolling-back') return this.#rollbackExisting(record, context, paths, 'resume-rollback');
    if (['starting', 'validating-live'].includes(record.phase) && record.swapStep === 'candidate-published') {
      await this.#assertPublishedTopology(record, context, paths);
      try {
        await this.transaction.markCommittedHealthy(context);
      } catch (error) {
        if (isHealthFailure(error)) return this.#rollbackExisting(record, context, paths, 'live-health-failed');
        throw recoveryRequired(error);
      }
      const healthy = await this.registry.load(record.jobId);
      return this.#retryCommittedCleanup(healthy, context, paths);
    }
    if (record.phase === 'committing' && record.swapStep === 'live-moved') {
      const targetPresent = this.#exists(paths.targetPath, context);
      const candidatePresent = this.#exists(paths.candidatePath, context);
      if (!targetPresent && candidatePresent) return this.#restoreBeforePublication(record, context, paths);
      if (targetPresent && candidatePresent &&
          record.outcome?.candidateCleanup?.action === 'between-renames-restored') {
        return this.#restoreBeforePublication(record, context, paths);
      }
      if (targetPresent && !candidatePresent) return this.#rollbackExisting(record, context, paths, 'swap-interrupted');
      throw recoveryRequired();
    }
    if (PRE_PUBLICATION_PHASES.has(record.phase) ||
        (record.phase === 'committing' && ['none', 'prepared'].includes(record.swapStep))) {
      return this.#recoverExistingBeforeSwap(record, context, paths);
    }
    throw recoveryRequired();
  }

  #canRetainStoppedOriginal(record, context, paths, terminal) {
    if (record.priorRuntime.running !== false || record.priorRuntime.autoRestart !== false ||
        record.swapStep !== 'none' || (terminal && (record.phase !== 'failed' ||
          record.outcome?.recovery?.action !== 'pre-swap-restored'))) return false;
    const outcome = record.outcome || {};
    const original = terminal ? record.directoryIdentities.target
      : record.directoryIdentities.rollback || record.directoryIdentities.target;
    const fingerprint = outcome.rollback?.fingerprint || outcome.live?.fingerprint;
    // This is retain-only authority. Neither an action label nor an empty candidate
    // slot proves that publication never occurred.
    if (!original || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint) ||
        [outcome.live, outcome.rollback].some(evidence => evidence?.fingerprint !== undefined &&
          (typeof evidence.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(evidence.fingerprint))) ||
        (outcome.rollback?.fingerprint && outcome.live?.fingerprint &&
          outcome.rollback.fingerprint !== outcome.live.fingerprint) ||
        (record.directoryIdentities.target && !sameIdentity(original, record.directoryIdentities.target)) ||
        (record.directoryIdentities.rollback && !sameIdentity(original, record.directoryIdentities.rollback)) ||
        record.directoryIdentities.failed || sameIdentity(original, record.directoryIdentities.candidate) ||
        ['publication', 'registration', 'liveValidation', 'revisionEvent'].some(key => outcome[key] != null) ||
        (outcome.liveMutationAuthorized != null && outcome.liveMutationAuthorized !== false) ||
        (outcome.swap != null && (typeof outcome.swap !== 'object' || Array.isArray(outcome.swap) ||
          outcome.swap.step !== 'none' || Object.keys(outcome.swap).some(key => key !== 'step'))) ||
        (terminal && (outcome.recovery.operationId !== record.jobId ||
          !sameIdentity(original, record.directoryIdentities.rollback) || record.restoreCreation != null))) {
      throw recoveryRequired();
    }
    // Initial original restoration remains authorized by the existing full
    // fingerprint/exact-rename path. Retention requires canonical-only topology
    // after that work; it makes no historical never-renamed claim.
    const targetPresent = this.#exists(paths.targetPath, context);
    const rollbackPresent = this.#exists(paths.rollbackPath, context);
    return !this.#exists(paths.failedPath, context) && (terminal
      ? targetPresent && !rollbackPresent : targetPresent !== rollbackPresent);
  }

  #classifyStoppedBetweenRenames(record, context, paths, terminal) {
    if (record.target.kind !== 'existing' || record.priorRuntime.running !== false ||
        record.priorRuntime.autoRestart !== false || record.swapStep !== 'live-moved' ||
        record.phase !== (terminal ? 'failed' : 'committing')) return null;
    const outcome = record.outcome || {};
    const identities = record.directoryIdentities;
    const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
    // A stopped live-moved claim is not permission to fall back to health when
    // its restoration/publication evidence contradicts the never-published case.
    if (!identities.target || !identities.rollback || !identities.candidate ||
        !sameIdentity(identities.target, identities.rollback) ||
        sameIdentity(identities.target, identities.candidate) || identities.failed ||
        !digest(outcome.live?.fingerprint) || !digest(outcome.rollback?.fingerprint) ||
        outcome.live.fingerprint !== outcome.rollback.fingerprint || !digest(outcome.candidate?.fingerprint) ||
        !outcome.swap || typeof outcome.swap !== 'object' || Array.isArray(outcome.swap) ||
        outcome.swap.step !== 'live-moved' || Object.keys(outcome.swap).some(key => key !== 'step') ||
        ['publication', 'registration', 'liveValidation', 'revisionEvent'].some(key => outcome[key] != null) ||
        (outcome.liveMutationAuthorized != null && outcome.liveMutationAuthorized !== false) ||
        record.restoreCreation != null ||
        (terminal && (outcome.recovery?.action !== 'between-renames-restored' ||
          outcome.recovery.operationId !== record.jobId)) ||
        (!terminal && outcome.recovery != null && (outcome.recovery.action !== 'between-renames-restored' ||
          outcome.recovery.operationId !== record.jobId))) throw recoveryRequired();
    const cleanup = this.#candidateCleanupAuthorization(record, paths.candidatePath, 'between-renames-restored');
    // Validate durable deletion evidence even when its directory/journal is gone.
    // A remaining partial candidate uses this exact authority, not a fresh hash.
    if ((terminal && !cleanup) || (cleanup && !digest(cleanup.fingerprint))) throw recoveryRequired();
    const targetPresent = this.#exists(paths.targetPath, context);
    const rollbackPresent = this.#exists(paths.rollbackPath, context);
    if (this.#exists(paths.failedPath, context) || (terminal
      ? !targetPresent || rollbackPresent
      : targetPresent === rollbackPresent || !this.#exists(paths.candidatePath, context) ||
        (targetPresent && !cleanup))) throw recoveryRequired();
    return { kind: 'between-renames', action: 'between-renames-restored' };
  }

  async #retainStoppedOriginal(record, context, paths, classification, work) {
    const lease = context.mutationLease;
    if (!lease || lease.operationId !== record.jobId || lease.instanceId !== record.target.stableServerId ||
        !samePath(lease.serverPath, paths.targetPath)) throw recoveryRequired();
    const identityOptions = { fsApi: context.fsApi, reparseInspector: context.reparseInspector };
    const originalIdentity = record.directoryIdentities.rollback || record.directoryIdentities.target;
    const parentPath = path.dirname(paths.targetPath);
    // Pin the current parent too: keeping the same child identity after moving it
    // into a replacement parent must not silently release recovery.
    const parentIdentity = await identifyServerDirectory(parentPath, identityOptions);
    await this.#stopRuntime(record, context);
    const reservation = await requireMethod(this.coordinator, 'acquireStart').acquireStart({
      instanceId: record.target.stableServerId,
      serverPath: paths.targetPath
    }, { operation: 'modpack-recovery-retain-stopped', operationId: record.jobId, parentMutationLease: lease });
    try {
      requireMethod(reservation, 'release');
      const proveRetained = async (current, beforeRestoration = false) => {
        normalizePaths(current);
        await assertServerDirectoryIdentity(parentPath, parentIdentity, identityOptions);
        const rollbackOnly = beforeRestoration && !this.#exists(paths.targetPath, context);
        // Retain-only authority needs the same safe subtree and exact root, not
        // payload readability or a fresh content digest that would be discarded.
        let retained;
        try {
          retained = await inspectServerDirectoryStructure(
            rollbackOnly ? paths.rollbackPath : paths.targetPath, identityOptions);
        } catch (error) {
          throw recoveryRequired(error);
        }
        if (!sameIdentity(retained.directoryIdentity, originalIdentity)) throw recoveryRequired();
        await assertServerDirectoryIdentity(parentPath, parentIdentity, identityOptions);
        this.#assertAbsent(rollbackOnly ? paths.targetPath : paths.rollbackPath, context);
        this.#assertAbsent(paths.failedPath, context);
      };
      await proveRetained(record, true);
      const current = await work();
      const validTerminal = classification.kind === 'between-renames'
        ? this.#classifyStoppedBetweenRenames(current, context, paths, true)
        : classification.kind === 'pre-swap' && this.#canRetainStoppedOriginal(current, context, paths, true);
      if (current.restoreCreation != null || !validTerminal) {
        throw recoveryRequired();
      }
      await proveRetained(current);
      this.#assertAbsent(paths.candidatePath, context);
      await this.#restoreAutoRestart(current, context, 'source');
      await proveRetained(current);
      this.#assertAbsent(paths.candidatePath, context);
      // Existing publication boundary: fresh source/topology proof above, then
      // uninterrupted reservation through authenticated record/envelope moves.
      return await this.#finish(current, 'failed', classification.action);
    } finally {
      reservation.release();
    }
  }

  async #recoverTerminalExisting(record, context, paths, retainingStopped = false) {
    if (!retainingStopped) {
      const classification = this.#classifyStoppedBetweenRenames(record, context, paths, true) ||
        (this.#canRetainStoppedOriginal(record, context, paths, true)
          ? { kind: 'pre-swap', action: 'pre-swap-restored' } : null);
      if (classification) return this.#retainStoppedOriginal(record, context, paths, classification, () =>
        this.#recoverTerminalExisting(record, context, paths, true));
    }
    const action = record.outcome?.recovery?.action;
    this.#assertAbsent(paths.rollbackPath, context);
    if (!this.#exists(paths.targetPath, context)) throw recoveryRequired();

    if (record.phase === 'failed') {
      if (!['pre-swap-restored', 'between-renames-restored'].includes(action)) throw recoveryRequired();
      this.#assertAbsent(paths.failedPath, context);
      await this.#verifyIdentity(context, paths.targetPath, record.directoryIdentities.target);
      let current = record;
      if (this.#exists(paths.candidatePath, context)) {
        if (!this.#candidateCleanupAuthorization(current, paths.candidatePath, action)) throw recoveryRequired();
        current = await this.#removeCandidateForCleanup(current, context, paths.candidatePath, action);
      }
      this.#assertAbsent(paths.candidatePath, context);
      if (retainingStopped) return current;
      await this.#restoreCanonicalPolicy(current, context, 'source');
      return this.#finish(current, 'failed', action);
    }

    this.#assertAbsent(paths.candidatePath, context);

    if (record.swapStep !== 'rollback-restored' || action !== 'rollback-restored' ||
        !this.#exists(paths.failedPath, context)) throw recoveryRequired();
    await this.#verifyIdentity(context, paths.targetPath, record.directoryIdentities.target);
    const mutableCandidate = record.outcome?.liveMutationAuthorized === true ||
      record.outcome?.recovery?.reason === 'live-health-failed';
    const failedEvidence = mutableCandidate
      ? await this.transaction.verifyMutableOperationOwnedDirectory(
          context,
          paths.failedPath,
          record.directoryIdentities.failed
        )
      : await this.#verifyOwned(
          context,
          paths.failedPath,
          record.directoryIdentities.failed,
          record.outcome?.candidate?.fingerprint
        );
    await this.#syncOwnedJournal(failedEvidence, 'rolled-back', 'rollback-restored', {
      targetIdentity: record.directoryIdentities.target,
      rollbackIdentity: record.directoryIdentities.target,
      failedIdentity: record.directoryIdentities.failed
    });
    await this.#restoreCanonicalPolicy(record, context, 'source');
    return this.#finish(record, 'rolled-back', action);
  }

  async #recoverExistingBeforeSwap(record, context, paths, retainingStopped = false) {
    if (!retainingStopped && this.#canRetainStoppedOriginal(record, context, paths, false)) {
      return this.#retainStoppedOriginal(record, context, paths, { kind: 'pre-swap', action: 'pre-swap-restored' }, () =>
        this.#recoverExistingBeforeSwap(record, context, paths, true));
    }
    this.#assertAbsent(paths.failedPath, context);
    const targetPresent = this.#exists(paths.targetPath, context);
    const rollbackPresent = this.#exists(paths.rollbackPath, context);
    const candidatePresent = this.#exists(paths.candidatePath, context);
    if (targetPresent && rollbackPresent) throw recoveryRequired();
    if (!targetPresent && !rollbackPresent) throw recoveryRequired();
    if (['preflight', 'snapshotting'].includes(record.phase) && record.restoreCreation != null) {
      if (!this.restorePointService) throw recoveryRequired();
      let cleanup;
      try {
        cleanup = await this.restorePointService.cleanupInterruptedRestorePointCreation({
          serverPath: targetPresent ? paths.targetPath : paths.rollbackPath,
          operationId: record.jobId,
          creationIntent: record.restoreCreation
        });
      } catch (error) {
        throw recoveryRequired(error);
      }
      if (!cleanup || !Number.isSafeInteger(cleanup.cleaned) || cleanup.cleaned < 0 ||
          !Array.isArray(cleanup.diagnostics) || cleanup.diagnostics.length > 0) throw recoveryRequired();
      try {
        record = await this.registry.clearRestoreCreationAfterCleanup(record.jobId, {
          expectedPhase: record.phase,
          expectedCreation: record.restoreCreation
        });
      } catch (error) {
        throw recoveryRequired(error);
      }
    }
    if (retainingStopped && record.restoreCreation != null) throw recoveryRequired();
    const originalIdentity = record.directoryIdentities.rollback || record.directoryIdentities.target;
    const originalFingerprint = record.outcome?.rollback?.fingerprint || record.outcome?.live?.fingerprint;
    if (candidatePresent && !record.outcome?.candidateCleanup) {
      await this.#verifyCandidateForCleanup(record, context, paths.candidatePath);
    }
    if (targetPresent) {
      await this.#verifyOriginal(context, paths.targetPath, originalIdentity, originalFingerprint);
    } else {
      await this.#verifyOriginal(context, paths.rollbackPath, originalIdentity, originalFingerprint);
      await this.#stopRuntime(record, context);
      await this.#verifyOriginal(context, paths.rollbackPath, originalIdentity, originalFingerprint);
      this.#assertAbsent(paths.targetPath, context);
      await this.#rename(context, paths.rollbackPath, paths.targetPath, originalIdentity);
      await this.#verifyOriginal(context, paths.targetPath, originalIdentity, originalFingerprint);
    }
    let current = await this.registry.load(record.jobId) || record;
    if (candidatePresent && this.#exists(paths.candidatePath, context)) {
      current = (await this.#authorizeCandidateCleanup(
        current,
        context,
        paths.candidatePath,
        'pre-swap-restored'
      )).record;
    }
    current = await this.registry.transition(current.jobId, {
      expectedPhase: current.phase,
      nextPhase: 'failed',
      patch: {
        directoryIdentities: { ...current.directoryIdentities, target: originalIdentity, rollback: originalIdentity },
        outcome: recoveryOutcome(current, 'pre-swap-restored')
      }
    });
    if (this.#exists(paths.candidatePath, context)) {
      current = await this.#removeCandidateForCleanup(
        current,
        context,
        paths.candidatePath,
        'pre-swap-restored'
      );
    }
    if (retainingStopped) return current;
    await this.#restoreCanonicalPolicy(current, context, 'source');
    return this.#finish(current, 'failed', 'pre-swap-restored');
  }

  async #restoreBeforePublication(record, context, paths, retainingStopped = false) {
    if (!retainingStopped) {
      const classification = this.#classifyStoppedBetweenRenames(record, context, paths, false);
      if (classification) return this.#retainStoppedOriginal(record, context, paths, classification, () =>
        this.#restoreBeforePublication(record, context, paths, true));
    }
    this.#assertAbsent(paths.failedPath, context);
    const targetPresent = this.#exists(paths.targetPath, context);
    const rollbackPresent = this.#exists(paths.rollbackPath, context);
    if (targetPresent === rollbackPresent || !this.#exists(paths.candidatePath, context)) throw recoveryRequired();
    const originalIdentity = record.directoryIdentities.rollback || record.directoryIdentities.target;
    const originalFingerprint = record.outcome?.rollback?.fingerprint || record.outcome?.live?.fingerprint;
    if (rollbackPresent) await this.#verifyOriginal(context, paths.rollbackPath, originalIdentity, originalFingerprint);
    else await this.#verifyOriginal(context, paths.targetPath, originalIdentity, originalFingerprint);
    if (!record.outcome?.candidateCleanup) {
      await this.#verifyOwned(context, paths.candidatePath, record.directoryIdentities.candidate,
        record.outcome?.candidate?.fingerprint);
    }
    await this.#stopRuntime(record, context);
    if (rollbackPresent) await this.#rename(context, paths.rollbackPath, paths.targetPath, originalIdentity);
    await this.#verifyOriginal(context, paths.targetPath, originalIdentity, originalFingerprint);
    let current = await this.registry.load(record.jobId) || record;
    current = (await this.#authorizeCandidateCleanup(
      current,
      context,
      paths.candidatePath,
      'between-renames-restored'
    )).record;
    current = await this.registry.transition(current.jobId, {
      expectedPhase: current.phase,
      nextPhase: 'failed',
      patch: {
        directoryIdentities: { ...current.directoryIdentities, target: originalIdentity, rollback: originalIdentity },
        outcome: recoveryOutcome(current, 'between-renames-restored')
      }
    });
    current = await this.#removeCandidateForCleanup(
      current,
      context,
      paths.candidatePath,
      'between-renames-restored'
    );
    if (retainingStopped) return current;
    await this.#restoreCanonicalPolicy(current, context, 'source');
    return this.#finish(current, 'failed', 'between-renames-restored');
  }

  async #assertPublishedTopology(record, context, paths) {
    this.#assertAbsent(paths.candidatePath, context);
    this.#assertAbsent(paths.failedPath, context);
    if (!this.#exists(paths.targetPath, context) || !this.#exists(paths.rollbackPath, context)) throw recoveryRequired();
    if (record.phase === 'validating-live') {
      await this.transaction.verifyCommittedCanonicalDirectory(context);
    } else {
      await this.#verifyOwned(context, paths.targetPath, record.directoryIdentities.target,
        record.outcome?.candidate?.fingerprint);
    }
    await this.#verifyOriginal(context, paths.rollbackPath, record.directoryIdentities.rollback,
      record.outcome?.rollback?.fingerprint || record.outcome?.live?.fingerprint);
  }

  async #rollbackExisting(record, context, paths, reason) {
    let current = await this.registry.load(record.jobId) || record;
    if (COMMITTED_PHASES.has(current.phase) || current.phase === 'completed') throw recoveryRequired();
    this.#assertAbsent(paths.candidatePath, context);
    const candidateFingerprint = current.outcome?.candidate?.fingerprint;
    let mutableCanonical = current.phase === 'validating-live' ||
      current.outcome?.liveMutationAuthorized === true ||
      current.outcome?.recovery?.reason === 'live-health-failed';
    const verifyCandidateDirectory = (directoryPath, directoryIdentity) => mutableCanonical
      ? this.transaction.verifyMutableOperationOwnedDirectory(context, directoryPath, directoryIdentity)
      : this.#verifyOwned(context, directoryPath, directoryIdentity, candidateFingerprint);
    if (current.swapStep === 'live-moved') {
      if (!this.#exists(paths.targetPath, context) || !this.#exists(paths.rollbackPath, context) ||
          this.#exists(paths.failedPath, context)) throw recoveryRequired();
      await verifyCandidateDirectory(paths.targetPath, current.directoryIdentities.candidate);
      await this.#verifyOriginal(context, paths.rollbackPath,
        current.directoryIdentities.rollback || current.directoryIdentities.target,
        current.outcome?.rollback?.fingerprint || current.outcome?.live?.fingerprint);
      current = await this.registry.transition(current.jobId, {
        expectedPhase: current.phase,
        nextPhase: 'rolling-back',
        patch: {
          swapStep: 'candidate-published',
          directoryIdentities: {
            ...current.directoryIdentities,
            target: current.directoryIdentities.candidate,
            rollback: current.directoryIdentities.rollback || current.directoryIdentities.target
          },
          outcome: recoveryOutcome(current, 'swap-publication-reconciled', { reason })
        }
      });
    }
    if (current.swapStep === 'candidate-published') {
      const targetPresent = this.#exists(paths.targetPath, context);
      const failedPresent = this.#exists(paths.failedPath, context);
      if (targetPresent && failedPresent) throw recoveryRequired();
      if (!targetPresent && !failedPresent) throw recoveryRequired();
      let ownedEvidence;
      if (targetPresent) {
        ownedEvidence = await verifyCandidateDirectory(paths.targetPath, current.directoryIdentities.target);
      } else {
        ownedEvidence = await verifyCandidateDirectory(
          paths.failedPath,
          current.directoryIdentities.failed || current.directoryIdentities.target
        );
      }
      current = await this.#ensureRollbackSource(current, context, paths);
      if (current.phase !== 'rolling-back') {
        if (current.phase === 'validating-live' && ownedEvidence?.journalRecord?.phase === 'starting') {
          await this.#syncOwnedJournal(ownedEvidence, 'validating-live', 'candidate-published', {
            targetIdentity: current.directoryIdentities.target,
            rollbackIdentity: current.directoryIdentities.rollback,
            failedIdentity: null
          });
        }
        const recovery = recoveryOutcome(current, 'rollback-started', { reason });
        current = await this.registry.transition(current.jobId, {
          expectedPhase: current.phase,
          nextPhase: 'rolling-back',
          patch: {
            swapStep: 'candidate-published',
            outcome: mutableCanonical ? { ...recovery, liveMutationAuthorized: true } : recovery
          }
        });
        mutableCanonical ||= current.outcome?.liveMutationAuthorized === true;
      }
      await this.#stopRuntime(current, context);
      if (targetPresent) {
        ownedEvidence = await verifyCandidateDirectory(paths.targetPath, current.directoryIdentities.target);
        await this.#syncOwnedJournal(ownedEvidence, 'rolling-back', 'candidate-published', {
          targetIdentity: current.directoryIdentities.target,
          rollbackIdentity: current.directoryIdentities.rollback
        });
        await this.#verifyOriginal(context, paths.rollbackPath, current.directoryIdentities.rollback,
          current.outcome?.rollback?.fingerprint);
        this.#assertAbsent(paths.failedPath, context);
        await this.#rename(context, paths.targetPath, paths.failedPath, current.directoryIdentities.target);
      }
      ownedEvidence = await verifyCandidateDirectory(
        paths.failedPath,
        current.directoryIdentities.failed || current.directoryIdentities.target
      );
      await this.#syncOwnedJournal(ownedEvidence, 'rolling-back', 'failed-canonical-moved', {
        targetIdentity: null,
        rollbackIdentity: current.directoryIdentities.rollback,
        failedIdentity: current.directoryIdentities.failed || current.directoryIdentities.target
      });
      current = await this.registry.transition(current.jobId, {
        expectedPhase: 'rolling-back',
        nextPhase: 'rolling-back',
        patch: {
          swapStep: 'failed-canonical-moved',
          directoryIdentities: {
            ...current.directoryIdentities,
            target: null,
            failed: current.directoryIdentities.failed || current.directoryIdentities.target
          },
          outcome: recoveryOutcome(current, 'failed-canonical-moved', { reason })
        }
      });
    }
    if (current.swapStep === 'failed-canonical-moved') {
      const failedEvidence = await verifyCandidateDirectory(paths.failedPath, current.directoryIdentities.failed);
      const targetPresent = this.#exists(paths.targetPath, context);
      const rollbackPresent = this.#exists(paths.rollbackPath, context);
      if (targetPresent && rollbackPresent) throw recoveryRequired();
      await this.#stopRuntime(current, context);
      if (targetPresent) {
        await this.#verifyOriginal(context, paths.targetPath, current.directoryIdentities.rollback,
          current.outcome?.rollback?.fingerprint);
      } else {
        current = await this.#ensureRollbackSource(current, context, paths);
        await this.#verifyOriginal(context, paths.rollbackPath, current.directoryIdentities.rollback,
          current.outcome?.rollback?.fingerprint);
        await this.#rename(context, paths.rollbackPath, paths.targetPath, current.directoryIdentities.rollback);
        await this.#verifyOriginal(context, paths.targetPath, current.directoryIdentities.rollback,
          current.outcome?.rollback?.fingerprint);
      }
      await this.#syncOwnedJournal(failedEvidence, 'rolled-back', 'rollback-restored', {
        targetIdentity: current.directoryIdentities.rollback,
        rollbackIdentity: current.directoryIdentities.rollback,
        failedIdentity: current.directoryIdentities.failed
      });
      current = await this.registry.transition(current.jobId, {
        expectedPhase: 'rolling-back',
        nextPhase: 'rolling-back',
        patch: {
          swapStep: 'rollback-restored',
          directoryIdentities: {
            ...current.directoryIdentities,
            target: current.directoryIdentities.rollback
          },
          outcome: recoveryOutcome(current, 'rollback-restored', { reason })
        }
      });
    }
    if (current.swapStep !== 'rollback-restored') throw recoveryRequired();
    this.#assertAbsent(paths.rollbackPath, context);
    await this.#verifyOriginal(context, paths.targetPath, current.directoryIdentities.target,
      current.outcome?.rollback?.fingerprint || current.outcome?.live?.fingerprint);
    if (!this.#exists(paths.failedPath, context)) throw recoveryRequired();
    const failedEvidence = await verifyCandidateDirectory(paths.failedPath, current.directoryIdentities.failed);
    await this.#syncOwnedJournal(failedEvidence, 'rolled-back', 'rollback-restored', {
      targetIdentity: current.directoryIdentities.target,
      rollbackIdentity: current.directoryIdentities.target,
      failedIdentity: current.directoryIdentities.failed
    });
    if (current.phase === 'rolling-back') {
      current = await this.registry.transition(current.jobId, {
        expectedPhase: 'rolling-back',
        nextPhase: 'rolled-back',
        patch: { outcome: recoveryOutcome(current, 'rollback-restored', { reason }) }
      });
    }
    if (current.phase !== 'rolled-back') throw recoveryRequired();
    return this.#recoverTerminalExisting(current, context, paths);
  }

  async #ensureRollbackSource(record, context, paths) {
    if (this.#exists(paths.rollbackPath, context)) {
      await this.#verifyOriginal(context, paths.rollbackPath, record.directoryIdentities.rollback || record.directoryIdentities.target,
        record.outcome?.rollback?.fingerprint || record.outcome?.live?.fingerprint);
      return record;
    }
    if (!record.restorePoint || !this.restorePointService || !this.restorePointResolver) throw recoveryRequired();
    this.#assertAbsent(paths.rollbackPath, context);
    let reference;
    try {
      reference = await this.restorePointResolver(record, context);
      if (!reference || reference.id !== record.restorePoint.id || reference.sha256 !== record.restorePoint.sha256) {
        throw recoveryRequired();
      }
      await this.restorePointService.verifyRestorePoint(reference);
      await this.restorePointService.restoreToFreshCandidate(reference, paths.rollbackPath);
    } catch (error) {
      throw recoveryRequired(error);
    }
    let inspection;
    try {
      inspection = await this.directoryAuthority.inspectFresh({ context, directoryPath: paths.rollbackPath });
    } catch (error) {
      throw recoveryRequired(error);
    }
    if (!inspection?.directoryIdentity || typeof inspection.fingerprint !== 'string') throw recoveryRequired();
    return this.registry.transition(record.jobId, {
      expectedPhase: record.phase,
      nextPhase: record.phase,
      patch: {
        directoryIdentities: { ...record.directoryIdentities, rollback: inspection.directoryIdentity },
        outcome: outcomeWith(record, {
          rollback: { fingerprint: inspection.fingerprint },
          recovery: {
            action: 'restore-point-reconstructed',
            operationId: record.jobId,
            restorePointId: reference.id
          }
        })
      }
    });
  }

  async #retryCommittedCleanup(record, context, paths) {
    this.#assertAbsent(paths.candidatePath, context);
    this.#assertAbsent(paths.failedPath, context);
    if (!this.#exists(paths.targetPath, context)) throw recoveryRequired();
    try {
      await this.transaction.verifyCommittedCanonicalDirectory(context);
    } catch (error) {
      throw recoveryRequired(error);
    }
    const rollbackPresent = this.#exists(paths.rollbackPath, context);
    if (!rollbackPresent && !['cleanup', 'cleanup-pending'].includes(record.phase)) throw recoveryRequired();
    if (rollbackPresent && record.outcome?.cleanup?.deletionAuthorized !== true) {
      await this.#verifyOriginal(context, paths.rollbackPath, record.directoryIdentities.rollback,
        record.outcome?.rollback?.fingerprint || record.outcome?.live?.fingerprint);
    }
    if (record.phase === 'committed-healthy') {
      try {
        await this.transaction.markCommittedHealthy(context);
      } catch (error) {
        throw recoveryRequired(error);
      }
    }
    let current = await this.registry.load(record.jobId) || record;
    current = await this.#reconcileReleaseTracking(current, context);
    await this.#restoreCanonicalPolicy(current, context, 'target');
    const cleanup = await this.transaction.cleanupCommittedTransaction(context);
    current = await this.registry.load(record.jobId) || current;
    if (cleanup?.phase !== 'completed' || current.phase !== 'completed' || current.swapStep !== 'cleanup-complete') {
      return deepFreeze({ jobId: record.jobId, resolved: false, action: 'cleanup-pending' });
    }
    return this.#finish(current, 'completed', 'committed-cleanup-completed');
  }

  async #stopRuntime(record, context) {
    let result;
    try {
      result = await this.runtimePolicy.ensureStopped({
        instanceId: record.target.stableServerId,
        jobId: record.jobId,
        operationId: record.jobId,
        serverPath: record.target.path
      });
    } catch (error) {
      throw recoveryRequired(error);
    }
    if (!result || (result.stopped !== true && result.success !== true && result.alreadyStopped !== true)) {
      throw recoveryRequired();
    }
    return result;
  }

  async #runtimeConfig(record, context, authority) {
    if (typeof context.resolveRecoveryRuntimeConfig === 'function') {
      const resolved = await context.resolveRecoveryRuntimeConfig({ authority, record });
      if (resolved) {
        return {
          ...resolved,
          networkAccess: Object.hasOwn(resolved, 'networkAccess')
            ? resolved.networkAccess
            : (isNetworkAccess(context.networkAccess) ? context.networkAccess : 'pack-default')
        };
      }
    }
    const runtimeOutcome = record.outcome?.runtime;
    const selected = runtimeOutcome?.[authority];
    if (!selected) throw recoveryRequired();
    if (selected.runtime) {
      return {
        runtime: selected.runtime,
        maxRam: selected.maxRam,
        networkAccess: isNetworkAccess(selected.networkAccess)
          ? selected.networkAccess
          : (isNetworkAccess(runtimeOutcome.networkAccess) ? runtimeOutcome.networkAccess : 'pack-default'),
        port: selected.port
      };
    }
    return {
      runtime: selected,
      maxRam: runtimeOutcome.maxRam ?? context.maxRam,
      networkAccess: isNetworkAccess(runtimeOutcome.networkAccess)
        ? runtimeOutcome.networkAccess
        : (isNetworkAccess(context.networkAccess) ? context.networkAccess : 'pack-default'),
      port: runtimeOutcome.port ?? context.port
    };
  }

  async #restoreCanonicalPolicy(record, context, authority, { restoreAutoRestart = true } = {}) {
    await this.#stopRuntime(record, context);
    const inactiveTarget = authority === 'target' && record.outcome?.runtimePolicy?.targetInactive === true;
    if (inactiveTarget) {
      if (record.outcome?.runtimePolicy?.targetRunning !== false ||
          record.outcome?.runtimePolicy?.targetAutoRestart !== false) throw recoveryRequired();
      if (restoreAutoRestart) await this.#restoreAutoRestart(record, context, authority);
      return deepFreeze({ skipped: true, reason: 'inactive-target' });
    }
    const unknownUnmanagedSource = authority === 'source' &&
      Object.hasOwn(record.outcome?.runtime || {}, 'source') && record.outcome.runtime.source === null;
    let config = null;
    if (unknownUnmanagedSource) {
      try {
        config = await this.#runtimeConfig(record, context, authority);
      } catch (error) {
        if (record.priorRuntime.running !== false || record.priorRuntime.autoRestart !== false) {
          throw recoveryRequired(error);
        }
        if (restoreAutoRestart) await this.#restoreAutoRestart(record, context, authority);
        return deepFreeze({ skipped: true, reason: 'unmanaged-source-runtime-unknown' });
      }
    }
    config ||= await this.#runtimeConfig(record, context, authority);
    if (!config?.runtime || typeof config.maxRam !== 'number' || !Number.isSafeInteger(config.port) ||
        !isNetworkAccess(config.networkAccess)) throw recoveryRequired();
    const keepRunning = authority === 'target'
      ? record.outcome?.runtimePolicy?.targetRunning ?? record.priorRuntime.running
      : record.priorRuntime.running;
    let validation;
    try {
      validation = await requireMethod(context.healthValidator, 'validateLive').validateLive({
        captureBootDiagnostic: true,
        instanceId: record.target.stableServerId,
        jobId: record.jobId,
        keepRunning,
        maxRam: config.maxRam,
        mutationLease: context.mutationLease,
        networkAccess: config.networkAccess,
        port: config.port,
        runtime: config.runtime,
        serverPath: record.target.path,
        signal: undefined,
        timeoutMs: context.healthTimeoutMs
      });
    } catch (error) {
      if (isHealthFailure(error)) throw error;
      throw recoveryRequired(error);
    }
    if (keepRunning) {
      if (!validation?.handoff) throw recoveryRequired();
      let adopted;
      try {
        adopted = await this.runtimePolicy.adoptValidatedHandoff({
          eventId: `modpack-runtime-handoff:${record.jobId}`,
          handoff: validation.handoff,
          instanceId: record.target.stableServerId,
          jobId: record.jobId,
          maxRam: config.maxRam,
          port: config.port,
          runtime: config.runtime,
          serverPath: record.target.path
        });
      } catch (error) {
        try {
          await stopValidatedHandoff(validation.handoff);
        } catch (cleanupError) {
          throw recoveryRequired(new AggregateError(
            [error, cleanupError],
            'Validated server handoff cleanup failed during recovery'
          ));
        }
        throw recoveryRequired(error);
      }
      if (!adopted || adopted.adopted !== true) {
        try {
          await stopValidatedHandoff(validation.handoff);
        } catch (cleanupError) {
          throw recoveryRequired(cleanupError);
        }
        throw recoveryRequired();
      }
    }
    if (restoreAutoRestart) await this.#restoreAutoRestart(record, context, authority);
    return validation;
  }

  async #restoreAutoRestart(record, context, authority) {
    const enabled = authority === 'target'
      ? record.outcome?.runtimePolicy?.targetAutoRestart ?? record.priorRuntime.autoRestart
      : record.priorRuntime.autoRestart;
    let result;
    try {
      result = await this.runtimePolicy.restoreAutoRestart({
        enabled,
        instanceId: record.target.stableServerId,
        jobId: record.jobId,
        operationId: record.jobId,
        serverPath: record.target.path
      });
    } catch (error) {
      throw recoveryRequired(error);
    }
    if (!result || result.restored !== true) throw recoveryRequired();
    return result;
  }
}

module.exports = {
  ModpackRecoveryService,
  defaultDirectoryAuthority
};
