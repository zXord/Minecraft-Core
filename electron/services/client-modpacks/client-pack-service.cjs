const crypto = require('node:crypto');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { normalizeRuntimeTuple } = require('../modpacks/contracts.cjs');
const { captureServerDirectoryCopySource } = require('../modpack-lifecycle/server-directory-identity.cjs');
const { normalizeCompanionDescriptor } = require('./companion-contracts.cjs');
const { planOwnership } = require('./client-pack-state.cjs');
const fail = (code = 'INVALID_REQUEST', cause) => new ModpackError(code, 'The matching client pack operation could not be completed', { cause });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const RUNTIME_ROOTS = new Set(['versions', 'libraries', 'assets', 'java', 'natives']);
function nonRuntimeFiles(snapshot) {
  return snapshot.entries.filter(entry => entry.type === 'file' && !RUNTIME_ROOTS.has(entry.pathKey.split('/')[0]) && entry.pathKey !== '.minecraft-core-state/runtime.json')
    .map(({ pathKey, sha256, size }) => ({ pathKey, sha256, size }));
}
function request(value, keys, required = keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length ||
      Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, d]) => !keys.includes(key) || !d.enumerable || !Object.hasOwn(d, 'value')) ||
      required.some(key => !Object.hasOwn(value, key))) throw fail();
}
function cancelled(signal) { if (signal?.aborted) throw fail('CANCELLED'); }
function sameRuntime(a, b) { return equal(normalizeRuntimeTuple(a), normalizeRuntimeTuple(b)); }
function single(plan) {
  if (plan?.artifactSet?.kind !== 'single' || plan.artifactSet.parts?.length !== 1 || !/\.mrpack$/i.test(plan.artifactSet.parts[0].fileName)) throw fail('UNSUPPORTED_ARCHIVE');
  return plan.artifactSet.parts[0];
}
class ClientPackService {
  constructor({ resolveClient, managementClient, candidatePreparer, sourceResolver, artifactAcquisition, archiveInspector,
    processGuard, transaction, stateStore, runtimeInstaller, reparseInspector, clock = Date.now } = {}) {
    if (typeof resolveClient !== 'function') throw fail();
    for (const [object, methods] of [[managementClient, ['readRequirement']], [candidatePreparer, ['inspect', 'prepare', 'release', 'forgetInspection']],
      [sourceResolver, ['resolveArtifactSetPlan']], [artifactAcquisition, ['downloadSet']], [archiveInspector, ['inspectArchive']],
      [archiveInspector?.materializer?.workspaceRegistry, ['releaseOwner']], [processGuard, ['withMutation']],
      [transaction, ['stage', 'seal', 'publish', 'abandon', 'status', 'recover', 'cleanup', 'candidatePathFor']], [stateStore, ['read']],
      [runtimeInstaller, ['reserveOperation', 'releaseReservedOperation', 'prepare', 'verify', 'awaitQuiescence', 'forgetOperation']]]) for (const method of methods) if (typeof object?.[method] !== 'function') throw fail();
    Object.assign(this, { resolveClient, managementClient, candidatePreparer, sourceResolver, artifactAcquisition, archiveInspector, processGuard, transaction, stateStore, runtimeInstaller, reparseInspector, clock });
    this.plans = new Map(); this.operations = new Map(); this.closed = false;
  }
  async _target(clientId) {
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(clientId)) throw fail();
    const target = await this.resolveClient(clientId);
    if (!target || target.clientId !== clientId || typeof target.clientPath !== 'string') throw fail();
    return { clientId, clientPath: target.clientPath };
  }
  _run(clientId, options, work) {
    request(options, ['signal', 'onProgress', 'deadline'], []);
    if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || options.deadline <= 0)) return Promise.reject(fail());
    if (this.closed || [...this.operations.values()].some(op => op.clientId === clientId)) return Promise.reject(fail('OPERATION_IN_PROGRESS'));
    if (options.onProgress !== undefined && typeof options.onProgress !== 'function') return Promise.reject(fail());
    const controller = new AbortController(); const operationId = crypto.randomUUID();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    const progress = event => {
      const phase = event?.phase ?? event?.activity ?? (event?.setBytes !== undefined ? 'downloading-archive' : 'preparing');
      const safe = { clientId, operationId, phase: typeof phase === 'string' && /^[a-z-]{1,40}$/.test(phase) ? phase : 'preparing' };
      const values = { completedBytes: event?.completedBytes ?? event?.processedBytes ?? event?.setBytes ?? event?.bytes,
        totalBytes: event?.totalBytes, completedItems: event?.completedItems ?? event?.files, totalItems: event?.totalItems ?? event?.totalFiles };
      for (const [key, value] of Object.entries(values)) {
        if ((typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) && /^(0|[1-9][0-9]{0,29})$/.test(String(value))) safe[key] = String(value);
      }
      try { Promise.resolve(options.onProgress?.(deepFreeze(safe))).catch(() => {}); } catch { /* observer only */ }
    };
    const operation = { clientId, controller, operationId, promise: null };
    this.operations.set(operationId, operation);
    operation.promise = Promise.resolve().then(() => { progress({ phase: 'preparing' }); cancelled(controller.signal); return work({ signal: controller.signal, deadline: options.deadline, onProgress: progress, operationId }); })
      .finally(() => { this.operations.delete(operationId); options.signal?.removeEventListener('abort', abort); });
    return operation.promise;
  }
  async _requirement(clientId, options = {}) {
    const { descriptor, binding } = await this.managementClient.readRequirement(clientId, options);
    if (!binding || typeof binding.generation !== 'string' || !binding.generation) throw fail('CLIENT_PACK_UNAVAILABLE');
    return { descriptor: descriptor === null ? null : normalizeCompanionDescriptor(descriptor), binding };
  }
  async _resolved(descriptor, options) {
    const source = descriptor.source;
    let selection = source;
    if (source.provider === 'github') {
      const github = this.sourceResolver.providers?.github;
      if (typeof github?.getRepositoryIdentity !== 'function') throw fail('CLIENT_PACK_UNAVAILABLE');
      const repository = await github.getRepositoryIdentity(`https://github.com/${source.githubOwner}/${source.githubRepo}`);
      if (repository.repositoryId !== source.repositoryId) throw fail('PLAN_STALE');
      selection = { provider: 'github', repositoryId: source.repositoryId, releaseId: source.releaseId, assetIds: [source.assetId] };
    }
    const resolved = await this.sourceResolver.resolveArtifactSetPlan(selection, { signal: options.signal });
    const part = single(resolved.artifactSetPlan);
    if (source.provider === 'github' && part.providerAssetId !== source.assetId) throw fail('PLAN_STALE');
    const verified = await this.artifactAcquisition.downloadSet(resolved.artifactSetPlan, { signal: options.signal, onProgress: options.onProgress });
    if (single(verified).calculatedDigests?.sha256 !== descriptor.artifactSha256) throw fail('PLAN_STALE');
    cancelled(options.signal);
    return verified;
  }
  async _release(plan) {
    if (plan.prepared) { await this.candidatePreparer.release(plan.prepared.ownerId); plan.prepared = null; }
    if (plan.inspectionId) {
      await this.archiveInspector.materializer.workspaceRegistry.releaseOwner(plan.inspectionId);
      this.candidatePreparer.forgetInspection(plan.inspectionId); plan.inspectionId = null;
    }
    if (plan.planId) this.plans.delete(plan.planId);
  }
  async _prune() {
    for (const plan of this.plans.values()) if (!plan.active && this.clock() - plan.createdAt > 15 * 60 * 1000) await this._release(plan);
  }
  async preview(value, options = {}) {
    request(value, ['clientId', 'optionalFileIds'], ['clientId']);
    return this._run(value.clientId, options, async operation => {
      const target = await this._target(value.clientId); await this._prune();
      for (const previous of [...this.plans.values()]) {
        if (!previous.active && previous.target.clientId === target.clientId) await this._release(previous);
      }
      if (this.plans.size >= 4) throw fail('OPERATION_IN_PROGRESS');
      const status = await this.transaction.status(target);
      if (status && !['committed', 'abandoned'].includes(status.phase)) throw fail('RECOVERY_REQUIRED');
      const { descriptor, binding } = await this._requirement(value.clientId, { signal: operation.signal, deadline: operation.deadline });
      if (descriptor?.status !== 'ready') throw fail('CLIENT_PACK_UNAVAILABLE');
      // Recheck/reserve after the awaited requirement lookup. In-flight previews
      // count against retention, not just completed plans.
      if (this.plans.size >= 4) throw fail('OPERATION_IN_PROGRESS');
      const plan = { target, descriptor, binding, planId: crypto.randomUUID(), createdAt: this.clock(), active: true, inspectionId: null, prepared: null };
      this.plans.set(plan.planId, plan);
      try {
        const verified = await this._resolved(descriptor, operation);
        const archive = await this.archiveInspector.inspectArchive({ verifiedArtifactSet: verified, signal: operation.signal, onProgress: operation.onProgress });
        plan.inspectionId = archive.inspectionId;
        const inspected = await this.candidatePreparer.inspect({ inspectionId: plan.inspectionId, signal: operation.signal, onProgress: operation.onProgress });
        if (!sameRuntime(inspected.runtime, descriptor.runtime)) throw fail('RUNTIME_INCOMPLETE');
        const available = inspected.optionalFiles.map(file => file.id);
        const selected = value.optionalFileIds === undefined ? available : value.optionalFileIds;
        if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(id => !available.includes(id))) throw fail();
        plan.optionalFileIds = [...selected];
        plan.prepared = await this.candidatePreparer.prepare({ inspectionId: plan.inspectionId, optionalFileIds: selected, signal: operation.signal, onProgress: operation.onProgress });
        plan.baseline = await captureServerDirectoryCopySource(target.clientPath, { ...(this.reparseInspector ? { reparseInspector: this.reparseInspector } : {}), signal: operation.signal });
        plan.oldManifest = await this.stateStore.read(target.clientPath);
        const changes = planOwnership(plan.baseline, plan.oldManifest, plan.prepared.manifest.entries);
        cancelled(operation.signal);
        // Retention starts when the review is ready, not during downloads or scans.
        plan.createdAt = this.clock(); plan.active = false;
        return deepFreeze({ clientId: value.clientId, planId: plan.planId, descriptor, optionalFiles: inspected.optionalFiles,
          optionalFileIds: selected, downloadBytes: inspected.downloadBytes, ...changes });
      } catch (cause) { await this._release(plan); throw cause; }
    });
  }
  async install(value, options = {}) {
    request(value, ['clientId', 'planId', 'conflictChoices']);
    return this._run(value.clientId, options, async operation => {
      const target = await this._target(value.clientId); const plan = this.plans.get(value.planId);
      if (!plan || plan.active || plan.target.clientId !== value.clientId || plan.target.clientPath !== target.clientPath || this.clock() - plan.createdAt > 15 * 60 * 1000) throw fail('PLAN_STALE');
      plan.active = true;
      try {
        return await this.processGuard.withMutation(target, async () => {
          let context; let runtimeStarted = false; let publicationStarted = false; let reservationAttempted = false; let cleanupAttempted = false;
          try {
            if (!equal((await this._requirement(value.clientId, { signal: operation.signal, deadline: operation.deadline, expectedBinding: plan.binding })).descriptor, plan.descriptor)) throw fail('PLAN_STALE');
            await this._resolved(plan.descriptor, operation); cancelled(operation.signal);
            reservationAttempted = true;
            await this.runtimeInstaller.reserveOperation({ operationId: operation.operationId, clientPath: this.transaction.candidatePathFor(target, operation.operationId) });
            context = await this.transaction.stage({ target, baseline: plan.baseline, oldManifest: plan.oldManifest, prepared: plan.prepared,
              descriptor: plan.descriptor, optionalFileIds: plan.optionalFileIds, conflictChoices: value.conflictChoices, signal: operation.signal, operationId: operation.operationId, onProgress: operation.onProgress });
            const preservedSnapshot = await captureServerDirectoryCopySource(context.candidatePath, this.reparseInspector ? { reparseInspector: this.reparseInspector } : {});
            runtimeStarted = true;
            const preparedRuntime = await this.runtimeInstaller.prepare({ clientPath: context.candidatePath, runtime: plan.descriptor.runtime,
              signal: operation.signal, onProgress: operation.onProgress, operationId: operation.operationId });
            if (preparedRuntime?.quiescent !== true || !sameRuntime(preparedRuntime.runtime, plan.descriptor.runtime)) throw fail('RUNTIME_INCOMPLETE');
            cancelled(operation.signal);
            await this._runtime(context.candidatePath, plan.descriptor.runtime);
            const runtimeSnapshot = await captureServerDirectoryCopySource(context.candidatePath, this.reparseInspector ? { reparseInspector: this.reparseInspector } : {});
            if (!equal(nonRuntimeFiles(preservedSnapshot), nonRuntimeFiles(runtimeSnapshot))) throw fail('PLAN_STALE');
            if (!equal((await this._requirement(value.clientId, { signal: operation.signal, deadline: operation.deadline, expectedBinding: plan.binding })).descriptor, plan.descriptor)) throw fail('PLAN_STALE');
            cancelled(operation.signal);
            await this.transaction.seal(context);
            // Cancellation stops at the durable ready marker; publication must now settle or recover.
            publicationStarted = true; operation.onProgress({ phase: 'publishing' });
            await this.transaction.publish(context);
            const verified = await this._verify(target, plan.descriptor);
            cleanupAttempted = true;
            const cleanup = await this._cleanupSettled(target);
            return deepFreeze({ clientId: value.clientId, status: verified.verified ? 'ready' : 'modified', verified: verified.verified, cleanup });
          } catch (cause) {
            let releasedReservation = false;
            if (reservationAttempted && !runtimeStarted) {
              try { releasedReservation = await this.runtimeInstaller.releaseReservedOperation(operation.operationId) === true; } catch { /* Unknown reservation remains recovery evidence. */ }
              if (!releasedReservation) throw fail('RECOVERY_REQUIRED', cause);
            }
            if (context && !publicationStarted) {
              let quiescent = !runtimeStarted;
              if (runtimeStarted) { try { quiescent = await this.runtimeInstaller.awaitQuiescence(operation.operationId) === true; } catch { quiescent = false; } }
              await this.transaction.abandon(context, { quiescent });
              if (operation.signal.aborted) throw fail('CANCELLED', cause);
            } else if (!context) {
              const status = await this.transaction.status(target);
              if (status && !['committed', 'abandoned'].includes(status.phase)) throw fail('RECOVERY_REQUIRED', cause);
              // No intent for this reserved operation means stage never owned a
              // candidate; releaseReservedOperation proves no runtime was allowed.
              const noOperationIntent = releasedReservation && (!status || status.operationId !== operation.operationId);
              if (noOperationIntent) await this.runtimeInstaller.forgetOperation(operation.operationId);
              // stage() may not have written an intent, or may have durably
              // abandoned before returning. Normalize only a proven safe abort;
              // uncertain journal/identity failures must remain recovery errors.
              if (operation.signal.aborted && (noOperationIntent || (status?.phase === 'abandoned' && status.operationId === operation.operationId)) &&
                  (cause?.name === 'AbortError' || cause?.code === 'ABORT_ERR' || cause?.code === 'CANCELLED')) throw fail('CANCELLED', cause);
            }
            if (publicationStarted) throw fail('RECOVERY_REQUIRED', cause);
            throw cause;
          } finally {
            if (!cleanupAttempted) await this._cleanupSettled(target);
          }
        });
      } finally { plan.active = false; await this._release(plan); }
    });
  }
  async _runtime(clientPath, runtime) {
    const result = await this.runtimeInstaller.verify({ clientPath, runtime });
    if (result?.verified !== true || !sameRuntime(result.runtime, runtime) || typeof result.profileId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/.test(result.profileId)) throw fail('RUNTIME_INCOMPLETE');
    return result;
  }
  async _verify(target, descriptor) {
    const status = await this.transaction.status(target);
    if (status && !['committed', 'abandoned'].includes(status.phase)) throw fail('RECOVERY_REQUIRED');
    const manifest = await this.stateStore.read(target.clientPath);
    if (!manifest) return { verified: false, status: descriptor?.status === 'ready' ? 'install-required' : descriptor?.status === 'unpaired' ? 'unpaired' : 'unmanaged', manifest: null };
    if (!descriptor || !equal(descriptor, manifest.descriptor)) return { verified: false, status: 'update-required', manifest };
    const snapshot = await captureServerDirectoryCopySource(target.clientPath, this.reparseInspector ? { reparseInspector: this.reparseInspector } : {});
    const files = new Map(snapshot.entries.map(e => [e.pathKey, e]));
    const modified = manifest.entries.filter(e => (e.preserved === true && /\.jar$/i.test(e.path)) || (e.policy !== 'preserve-after-seed' &&
      (!files.has(e.pathKey) || files.get(e.pathKey).type !== 'file' || files.get(e.pathKey).sha256 !== e.sha256 || files.get(e.pathKey).size !== e.size) &&
      !(e.preserved && !/\.jar$/i.test(e.path) && files.get(e.pathKey)?.type === 'file')));
    if (modified.length) return { verified: false, status: 'modified', manifest };
    const runtime = await this._runtime(target.clientPath, manifest.descriptor.runtime);
    return { verified: true, status: 'ready', manifest, runtime };
  }
  async getState(value) {
    request(value, ['clientId']); const target = await this._target(value.clientId);
    let descriptor = null; let recoveryReason;
    try {
      const status = await this.transaction.status(target);
      if (status && !['committed', 'abandoned'].includes(status.phase)) {
        if (status.phase === 'preparing' && typeof this.runtimeInstaller.getRecoveryState === 'function') {
          try {
            const recovery = await this.runtimeInstaller.getRecoveryState(status.operationId);
            if (recovery?.status === 'restart-required' && recovery.quiescent === false) recoveryReason = 'restart-required';
          } catch { /* Unavailable ownership evidence must not invent recovery instructions. */ }
        }
        throw fail('RECOVERY_REQUIRED');
      }
      descriptor = (await this._requirement(value.clientId)).descriptor;
      const result = await this._verify(target, descriptor);
      return deepFreeze({ clientId: value.clientId, status: result.status, verified: result.verified, descriptor });
    } catch (cause) {
      if (!['RECOVERY_REQUIRED', 'RUNTIME_INCOMPLETE'].includes(cause.code)) throw cause;
      return deepFreeze({ clientId: value.clientId, status: cause.code === 'RECOVERY_REQUIRED' ? 'recovery-required' : 'runtime-incomplete', verified: false, descriptor,
        ...(recoveryReason ? { recoveryReason } : {}) });
    }
  }
  async verify(value) { return this.getState(value); }
  async getLaunchAuthority(value, options = {}) {
    request(value, ['clientId']); const target = await this._target(value.clientId);
    const result = await this._verify(target, (await this._requirement(value.clientId, options)).descriptor);
    cancelled(options.signal);
    if (!result.verified) throw fail(result.status === 'update-required' ? 'PLAN_STALE' : 'RUNTIME_INCOMPLETE');
    return deepFreeze({ ...target, runtime: result.manifest.descriptor.runtime, profileId: result.runtime.profileId,
      ...(result.runtime.javaPath ? { javaPath: result.runtime.javaPath } : {}), serverFingerprint: result.manifest.descriptor.serverFingerprint, artifactSha256: result.manifest.descriptor.artifactSha256 });
  }
  async recover(value) {
    request(value, ['clientId']); const target = await this._target(value.clientId);
    return this.processGuard.withMutation(target, async () => {
      const status = await this.transaction.status(target);
      let quiescent = false;
      if (status?.phase === 'preparing') {
        try { quiescent = await this.runtimeInstaller.awaitQuiescence(status.operationId) === true; } catch { /* Unknown writer remains blocked. */ }
      }
      const recovered = await this.transaction.recover(target, { quiescent });
      await this._cleanupSettled(target);
      return recovered;
    });
  }
  async _cleanupSettled(target) {
    try {
      const result = await this.transaction.cleanup(target, { isQuiescent: operationId => this.runtimeInstaller.awaitQuiescence(operationId) });
      const forgetPending = [];
      for (const operationId of result.completed) {
        try { await this.runtimeInstaller.forgetOperation(operationId); } catch { forgetPending.push(operationId); }
      }
      return deepFreeze({ status: result.retained.length || forgetPending.length ? 'retained' : result.pending.length || result.incomplete ? 'pending' : 'complete',
        completed: result.completed, retained: result.retained, pending: result.pending, incomplete: result.incomplete, forgetPending });
    } catch {
      // Leftover cleanup never changes the meaning of a healthy committed live
      // directory. Its evidence is retained and explicit cleanup can retry.
      return deepFreeze({ status: 'retained', completed: [], retained: [], pending: [], incomplete: true, forgetPending: [] });
    }
  }
  async cleanup(value) {
    request(value, ['clientId']); const target = await this._target(value.clientId);
    return this.processGuard.withMutation(target, () => this._cleanupSettled(target));
  }
  async cancel(value) {
    request(value, ['clientId', 'operationId']); await this._target(value.clientId);
    const operation = this.operations.get(value.operationId);
    if (!operation || operation.clientId !== value.clientId) throw fail();
    operation.controller.abort();
    let wasCancelled = false;
    try { await operation.promise; } catch (cause) { if (cause.code !== 'CANCELLED') throw cause; wasCancelled = true; }
    return { clientId: value.clientId, operationId: value.operationId, cancelled: wasCancelled };
  }
  async dispose() {
    this.closed = true;
    const operations = [...this.operations.values()]; for (const op of operations) op.controller.abort();
    await Promise.allSettled(operations.map(op => op.promise));
    for (const plan of this.plans.values()) await this._release(plan);
  }
}
module.exports = { ClientPackService };
