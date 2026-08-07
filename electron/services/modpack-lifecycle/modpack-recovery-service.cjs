const fs = require('node:fs');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { consumeReservedTarget } = require('./reserved-target-authority.cjs');
const transaction = require('./server-directory-transaction.cjs');
const {
  assertServerDirectoryIdentity,
  identifyServerDirectory,
  inspectServerDirectoryTree
} = require('./server-directory-identity.cjs');

const PRE_PUBLICATION_PHASES = new Set([
  'queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user',
  'preflight', 'snapshotting', 'staging', 'validating-candidate'
]);
const COMMITTED_PHASES = new Set(['committed-healthy', 'cleanup', 'cleanup-pending']);

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

    async removeOperationOwned({ context, directoryPath, directoryIdentity, fingerprint }) {
      await this.verifyOperationOwned({ context, directoryPath, directoryIdentity, fingerprint });
      const fsApi = context.fsApi;
      async function removeContents(directory) {
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
            await removeContents(candidate);
            await assertServerDirectoryIdentity(candidate, identity, {
              fsApi,
              reparseInspector: context.reparseInspector
            });
            fsApi.rmdirSync(candidate);
          } else if (before.isFile() && BigInt(before.nlink) === 1n) {
            const after = lstatIfPresent(fsApi, candidate);
            if (!after || after.dev !== before.dev || after.ino !== before.ino ||
                after.birthtimeNs !== before.birthtimeNs || BigInt(after.nlink) !== 1n) throw recoveryRequired();
            fsApi.unlinkSync(candidate);
          } else {
            throw recoveryRequired();
          }
          context.durableFs.flushDirectory(directory);
        }
      }
      await removeContents(directoryPath);
      await assertServerDirectoryIdentity(directoryPath, directoryIdentity, {
        fsApi,
        reparseInspector: context.reparseInspector
      });
      fsApi.rmdirSync(directoryPath);
      context.durableFs.flushDirectory(path.dirname(directoryPath));
      return { removed: true };
    },

    async inspectFresh({ context, directoryPath }) {
      const inspection = await inspectServerDirectoryTree(directoryPath, {
        fsApi: context.fsApi,
        reparseInspector: context.reparseInspector
      });
      return {
        directoryIdentity: inspection.directoryIdentity,
        fingerprint: inspection.fingerprint
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
    restorePointResolver = null,
    restorePointService = null,
    transactionApi = transaction
  } = {}) {
    requireMethod(coordinator, 'runRecoveryMutation');
    requireMethod(recoveryRegistry, 'load');
    requireMethod(recoveryRegistry, 'transition');
    requireMethod(recoveryRegistry, 'finish');
    if (typeof contextFactory !== 'function') throw invalid();
    requireMethod(runtimePolicy, 'suspend');
    requireMethod(runtimePolicy, 'ensureStopped');
    requireMethod(runtimePolicy, 'adoptValidatedHandoff');
    requireMethod(runtimePolicy, 'restoreAutoRestart');
    for (const method of [
      'publishNewCandidate', 'registerPublishedInstance', 'markCommittedHealthy', 'cleanupCommittedTransaction'
    ]) requireMethod(transactionApi, method);
    const authority = directoryAuthority || defaultDirectoryAuthority();
    for (const method of [
      'exists', 'verifyOperationOwned', 'verifyOriginal', 'renameExact', 'removeOperationOwned', 'inspectFresh'
    ]) requireMethod(authority, method);
    if (restorePointResolver !== null && typeof restorePointResolver !== 'function') throw invalid();
    if (typeof consumeReservedTargetFn !== 'function') throw invalid();
    if (restorePointService !== null) {
      requireMethod(restorePointService, 'verifyRestorePoint');
      requireMethod(restorePointService, 'restoreToFreshCandidate');
    }
    this.coordinator = coordinator;
    this.registry = recoveryRegistry;
    this.contextFactory = contextFactory;
    this.consumeReservedTarget = consumeReservedTargetFn;
    this.directoryAuthority = authority;
    this.runtimePolicy = runtimePolicy;
    this.restorePointResolver = restorePointResolver;
    this.restorePointService = restorePointService;
    this.transaction = transactionApi;
  }

  async recoverAll(scanResult) {
    if (!scanResult || typeof scanResult !== 'object' || !Array.isArray(scanResult.records) ||
        !Array.isArray(scanResult.corrupt)) throw invalid();
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

  async #run(recordValue, work) {
    const initial = assertRecord(recordValue);
    const paths = normalizePaths(initial);
    let hold;
    try {
      hold = await this.runtimePolicy.suspend({
        instanceId: initial.target.stableServerId,
        jobId: initial.jobId,
        operationId: initial.jobId,
        serverPath: initial.target.path
      });
      if (!hold || hold.held !== true) throw recoveryRequired();
      return await this.coordinator.runRecoveryMutation({
        instanceId: initial.target.stableServerId,
        serverPath: initial.target.path
      }, { operationId: initial.jobId }, async mutationLease => {
        const durableRecord = await this.registry.load(initial.jobId);
        if (!durableRecord) return deepFreeze({ jobId: initial.jobId, resolved: true, action: 'already-finished' });
        assertRecord(durableRecord);
        normalizePaths(durableRecord);
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
      const durableRecord = await this.registry.load(initial.jobId);
      if (!durableRecord) return deepFreeze({ jobId: initial.jobId, resolved: true, action: 'already-finished' });
      assertRecord(durableRecord);
      normalizePaths(durableRecord);
      if (durableRecord.target.stableServerId !== initial.target.stableServerId ||
          !samePath(durableRecord.target.path, initial.target.path)) throw recoveryRequired();
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

  async #syncOwnedJournal(evidence, nextPhase, swapStep, patch = {}) {
    if (!evidence?.journal || typeof evidence.journal.transition !== 'function' ||
        !evidence.journalRecord || typeof evidence.locations?.journalPath !== 'string') return null;
    if (evidence.journalRecord.phase === nextPhase && evidence.journalRecord.swapStep === swapStep) {
      return evidence.journalRecord;
    }
    try {
      return evidence.journal.transition(evidence.locations.journalPath, {
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

  async #removeOwned(context, directoryPath, identity, fingerprint) {
    try {
      await this.directoryAuthority.removeOperationOwned({
        context,
        directoryPath,
        directoryIdentity: identity,
        fingerprint
      });
    } catch (error) {
      throw recoveryRequired(error);
    }
  }

  async #finish(record, terminalPhase, action, detail = {}) {
    await this.registry.finish(record.jobId, {
      terminalPhase,
      outcome: recoveryOutcome(record, action, detail)
    });
    return deepFreeze({ jobId: record.jobId, resolved: true, action });
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
      await this.#verifyOwned(context, paths.targetPath, record.directoryIdentities.target,
        record.outcome?.publication?.candidateFingerprint || record.outcome?.candidate?.fingerprint);
      await this.#restoreCanonicalPolicy(record, context, 'target');
      return this.#finish(record, 'completed', 'new-publication-completed');
    }
    throw recoveryRequired();
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
    const candidatePresent = this.#exists(paths.candidatePath, context);
    if (candidatePresent) {
      const fingerprint = record.outcome?.candidate?.fingerprint;
      await this.#verifyOwned(context, paths.candidatePath, record.directoryIdentities.candidate, fingerprint);
      await this.#stopRuntime(record, context);
      await this.#verifyOwned(context, paths.candidatePath, record.directoryIdentities.candidate, fingerprint);
      await this.#removeOwned(context, paths.candidatePath, record.directoryIdentities.candidate, fingerprint);
    }
    return this.#finish(record, 'failed', 'pre-publication-cleanup');
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
    await this.#verifyOwned(context, paths.targetPath, record.directoryIdentities.target, fingerprint);
    let validation;
    try {
      validation = record.operationKind === 'import'
        ? await this.#validateInactiveNewCanonical(record, context)
        : await this.#restoreCanonicalPolicy(record, context, 'target', { restoreAutoRestart: false });
    } catch (error) {
      if (!isHealthFailure(error.cause || error) && !isHealthFailure(error)) throw error;
      if (record.phase === 'committed-healthy') throw recoveryRequired(error);
      return this.#failNewCanonical(record, context, paths, error);
    }
    if (record.outcome?.registration?.complete !== true) await this.transaction.registerPublishedInstance(context);
    let registered = await this.registry.load(record.jobId);
    if (!registered || registered.phase !== 'registering' || registered.outcome?.registration?.complete !== true) {
      if (!registered || registered.phase !== 'committed-healthy' || registered.outcome?.registration?.complete !== true) {
        throw recoveryRequired();
      }
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
    if (!record || !['registering', 'committed-healthy'].includes(record.phase) ||
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
    if (current.phase === 'registering') {
      const targetRunning = current.outcome?.runtimePolicy?.targetRunning ?? current.priorRuntime.running;
      current = await this.registry.transition(current.jobId, {
        expectedPhase: 'registering',
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
    let current = await this.registry.load(record.jobId) || record;
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
    const targetPresent = this.#exists(paths.targetPath, context);
    const failedPresent = this.#exists(paths.failedPath, context);
    this.#assertAbsent(paths.candidatePath, context);
    if (targetPresent && failedPresent) throw recoveryRequired();
    if (current.swapStep === 'candidate-published') {
      await this.#stopRuntime(current, context);
      let failedEvidence;
      if (targetPresent) {
        const targetEvidence = await this.#verifyOwned(context, paths.targetPath, current.directoryIdentities.target, fingerprint);
        await this.#syncOwnedJournal(targetEvidence, 'rolling-back', 'candidate-published', {
          targetIdentity: current.directoryIdentities.target
        });
        this.#assertAbsent(paths.failedPath, context);
        await this.#rename(context, paths.targetPath, paths.failedPath, current.directoryIdentities.target);
      } else if (!failedPresent) {
        throw recoveryRequired();
      }
      failedEvidence = await this.#verifyOwned(context, paths.failedPath, current.directoryIdentities.target, fingerprint);
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
    const failedEvidence = await this.#verifyOwned(context, paths.failedPath, current.directoryIdentities.failed, fingerprint);
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
      await this.#verifyOwned(context, paths.targetPath, record.directoryIdentities.target,
        record.outcome?.candidate?.fingerprint);
      await this.#restoreCanonicalPolicy(record, context, 'target');
      return this.#finish(record, 'completed', 'committed-cleanup-completed');
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
      if (targetPresent && !candidatePresent) return this.#rollbackExisting(record, context, paths, 'swap-interrupted');
      throw recoveryRequired();
    }
    if (PRE_PUBLICATION_PHASES.has(record.phase) ||
        (record.phase === 'committing' && ['none', 'prepared'].includes(record.swapStep))) {
      return this.#recoverExistingBeforeSwap(record, context, paths);
    }
    throw recoveryRequired();
  }

  async #recoverExistingBeforeSwap(record, context, paths) {
    this.#assertAbsent(paths.failedPath, context);
    const targetPresent = this.#exists(paths.targetPath, context);
    const rollbackPresent = this.#exists(paths.rollbackPath, context);
    const candidatePresent = this.#exists(paths.candidatePath, context);
    if (targetPresent && rollbackPresent) throw recoveryRequired();
    if (!targetPresent && !rollbackPresent) throw recoveryRequired();
    const originalIdentity = record.directoryIdentities.rollback || record.directoryIdentities.target;
    const originalFingerprint = record.outcome?.rollback?.fingerprint || record.outcome?.live?.fingerprint;
    if (candidatePresent) {
      await this.#verifyOwned(context, paths.candidatePath, record.directoryIdentities.candidate,
        record.outcome?.candidate?.fingerprint);
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
    if (candidatePresent) {
      await this.#verifyOwned(context, paths.candidatePath, record.directoryIdentities.candidate,
        record.outcome?.candidate?.fingerprint);
      await this.#removeOwned(context, paths.candidatePath, record.directoryIdentities.candidate,
        record.outcome?.candidate?.fingerprint);
    }
    const canonical = {
      ...record,
      directoryIdentities: { ...record.directoryIdentities, target: originalIdentity, rollback: originalIdentity }
    };
    await this.#restoreCanonicalPolicy(canonical, context, 'source');
    return this.#finish(canonical, 'failed', 'pre-swap-restored');
  }

  async #restoreBeforePublication(record, context, paths) {
    this.#assertAbsent(paths.targetPath, context);
    this.#assertAbsent(paths.failedPath, context);
    if (!this.#exists(paths.rollbackPath, context) || !this.#exists(paths.candidatePath, context)) throw recoveryRequired();
    const originalIdentity = record.directoryIdentities.rollback || record.directoryIdentities.target;
    const originalFingerprint = record.outcome?.rollback?.fingerprint || record.outcome?.live?.fingerprint;
    await this.#verifyOriginal(context, paths.rollbackPath, originalIdentity, originalFingerprint);
    await this.#verifyOwned(context, paths.candidatePath, record.directoryIdentities.candidate,
      record.outcome?.candidate?.fingerprint);
    await this.#stopRuntime(record, context);
    await this.#rename(context, paths.rollbackPath, paths.targetPath, originalIdentity);
    await this.#verifyOriginal(context, paths.targetPath, originalIdentity, originalFingerprint);
    await this.#removeOwned(context, paths.candidatePath, record.directoryIdentities.candidate,
      record.outcome?.candidate?.fingerprint);
    const canonical = {
      ...record,
      directoryIdentities: { ...record.directoryIdentities, target: originalIdentity, rollback: originalIdentity }
    };
    await this.#restoreCanonicalPolicy(canonical, context, 'source');
    return this.#finish(canonical, 'failed', 'between-renames-restored');
  }

  async #assertPublishedTopology(record, context, paths) {
    this.#assertAbsent(paths.candidatePath, context);
    this.#assertAbsent(paths.failedPath, context);
    if (!this.#exists(paths.targetPath, context) || !this.#exists(paths.rollbackPath, context)) throw recoveryRequired();
    await this.#verifyOwned(context, paths.targetPath, record.directoryIdentities.target,
      record.outcome?.candidate?.fingerprint);
    await this.#verifyOriginal(context, paths.rollbackPath, record.directoryIdentities.rollback,
      record.outcome?.rollback?.fingerprint || record.outcome?.live?.fingerprint);
  }

  async #rollbackExisting(record, context, paths, reason) {
    let current = await this.registry.load(record.jobId) || record;
    if (COMMITTED_PHASES.has(current.phase) || current.phase === 'completed') throw recoveryRequired();
    this.#assertAbsent(paths.candidatePath, context);
    const candidateFingerprint = current.outcome?.candidate?.fingerprint;
    if (current.swapStep === 'live-moved') {
      if (!this.#exists(paths.targetPath, context) || !this.#exists(paths.rollbackPath, context) ||
          this.#exists(paths.failedPath, context)) throw recoveryRequired();
      await this.#verifyOwned(context, paths.targetPath, current.directoryIdentities.candidate, candidateFingerprint);
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
        ownedEvidence = await this.#verifyOwned(context, paths.targetPath, current.directoryIdentities.target, candidateFingerprint);
      } else {
        ownedEvidence = await this.#verifyOwned(context, paths.failedPath,
          current.directoryIdentities.failed || current.directoryIdentities.target, candidateFingerprint);
      }
      current = await this.#ensureRollbackSource(current, context, paths);
      if (current.phase !== 'rolling-back') {
        current = await this.registry.transition(current.jobId, {
          expectedPhase: current.phase,
          nextPhase: 'rolling-back',
          patch: { swapStep: 'candidate-published', outcome: recoveryOutcome(current, 'rollback-started', { reason }) }
        });
      }
      await this.#stopRuntime(current, context);
      if (targetPresent) {
        ownedEvidence = await this.#verifyOwned(context, paths.targetPath, current.directoryIdentities.target, candidateFingerprint);
        await this.#syncOwnedJournal(ownedEvidence, 'rolling-back', 'candidate-published', {
          targetIdentity: current.directoryIdentities.target,
          rollbackIdentity: current.directoryIdentities.rollback
        });
        await this.#verifyOriginal(context, paths.rollbackPath, current.directoryIdentities.rollback,
          current.outcome?.rollback?.fingerprint);
        this.#assertAbsent(paths.failedPath, context);
        await this.#rename(context, paths.targetPath, paths.failedPath, current.directoryIdentities.target);
      }
      ownedEvidence = await this.#verifyOwned(context, paths.failedPath,
        current.directoryIdentities.failed || current.directoryIdentities.target, candidateFingerprint);
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
      const failedEvidence = await this.#verifyOwned(context, paths.failedPath, current.directoryIdentities.failed, candidateFingerprint);
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
    const failedEvidence = await this.#verifyOwned(context, paths.failedPath, current.directoryIdentities.failed, candidateFingerprint);
    await this.#syncOwnedJournal(failedEvidence, 'rolled-back', 'rollback-restored', {
      targetIdentity: current.directoryIdentities.target,
      rollbackIdentity: current.directoryIdentities.target,
      failedIdentity: current.directoryIdentities.failed
    });
    await this.#restoreCanonicalPolicy(current, context, 'source');
    return this.#finish(current, 'rolled-back', 'rollback-restored', { reason });
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
    await this.#verifyOwned(context, paths.targetPath, record.directoryIdentities.target,
      record.outcome?.candidate?.fingerprint);
    const rollbackPresent = this.#exists(paths.rollbackPath, context);
    if (!rollbackPresent && record.phase !== 'cleanup') throw recoveryRequired();
    if (rollbackPresent) {
      await this.#verifyOriginal(context, paths.rollbackPath, record.directoryIdentities.rollback,
        record.outcome?.rollback?.fingerprint || record.outcome?.live?.fingerprint);
    }
    try {
      await this.transaction.markCommittedHealthy(context);
    } catch (error) {
      throw recoveryRequired(error);
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
      if (resolved) return resolved;
    }
    const runtimeOutcome = record.outcome?.runtime;
    const selected = runtimeOutcome?.[authority];
    if (!selected) throw recoveryRequired();
    if (selected.runtime) {
      return {
        runtime: selected.runtime,
        maxRam: selected.maxRam,
        port: selected.port
      };
    }
    return {
      runtime: selected,
      maxRam: runtimeOutcome.maxRam ?? context.maxRam,
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
    const config = await this.#runtimeConfig(record, context, authority);
    if (!config?.runtime || typeof config.maxRam !== 'number' || !Number.isSafeInteger(config.port)) throw recoveryRequired();
    const keepRunning = authority === 'target'
      ? record.outcome?.runtimePolicy?.targetRunning ?? record.priorRuntime.running
      : record.priorRuntime.running;
    let validation;
    try {
      validation = await requireMethod(context.healthValidator, 'validateLive').validateLive({
        instanceId: record.target.stableServerId,
        jobId: record.jobId,
        keepRunning,
        maxRam: config.maxRam,
        mutationLease: context.mutationLease,
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
        throw recoveryRequired(error);
      }
      if (!adopted || adopted.adopted !== true) throw recoveryRequired();
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
