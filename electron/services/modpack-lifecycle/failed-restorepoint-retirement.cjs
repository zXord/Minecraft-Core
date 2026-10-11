const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ModpackError } = require('../modpacks/errors.cjs');
const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { normalizeRuntimeTuple } = require('../modpacks/contracts.cjs');
const { isSafeWindowsBasename } = require('../modpacks/windows-basename.cjs');
const { JOB_ID_PATTERN, normalizeRecoveryTargetPath } = require('./recovery-target-envelope.cjs');
const { normalizeRetirementCandidate, normalizeRetirementReceipt } = require('./failed-restorepoint-retirement-evidence.cjs');

const LIMITS = Object.freeze({ startup: Object.freeze({ retry: 16, notice: 4 }),
  'recovery-completed': Object.freeze({ retry: 4, notice: 2 }) });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
// Local history uses the state repository's legacy identifier/kind grammar,
// not the registry operation enum (notably import-files-only).
const HISTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function invalid() { return new ModpackError('INVALID_REQUEST', 'The restorepoint retirement request is invalid'); }
function defer(reason, cause) { return Object.assign(new Error('The restorepoint remains retained', { cause }), { retirementReason: reason }); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(d => !d.enumerable || !Object.hasOwn(d, 'value'))) throw invalid();
  return value;
}
function selector(value) {
  exact(value, ['instanceId', 'serverPath']);
  if (typeof value.instanceId !== 'string' || !ID.test(value.instanceId)) throw invalid();
  return { instanceId: value.instanceId, serverPath: normalizeRecoveryTargetPath(value.serverPath) };
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid();
  return Date.parse(value);
}
function reason(error) {
  if (error?.retirementReason) return error.retirementReason;
  if (error?.runtimeWritersUnproven) return 'writer-unproven';
  if (error?.code === 'OPERATION_IN_PROGRESS') return 'target-busy';
  if (error?.code === 'SERVER_RUNNING') return 'target-running';
  if (error?.code === 'RECOVERY_REQUIRED') return 'recovery-pending';
  if (error?.code === 'PLAN_STALE' || error?.code === 'TARGET_EXISTS') return 'receipt-conflict';
  if (error?.code === 'INVALID_REQUEST') return 'invalid-evidence';
  return 'io-failure';
}
function result(jobId, status, why = null, receipt = null) {
  return Object.freeze({ status, jobId, reason: why, progress: receipt?.progress ?? null,
    archiveBytesReclaimed: receipt?.durability.archive === 'durable' ? String(receipt.candidate.size) : '0' });
}
function eligible(record) {
  const out = record.outcome || {}; const ids = record.directoryIdentities;
  return record.phase === 'failed' && record.target.kind === 'existing' && record.swapStep === 'none' &&
    record.restoreCreation === null && record.restorePoint !== null && out.failedPointRetirementCandidate &&
    out.recovery?.action === 'pre-swap-restored' && out.recovery.operationId === record.jobId &&
    ids?.target && ids.rollback && ids.target.volumeSerial === ids.rollback.volumeSerial && ids.target.fileId === ids.rollback.fileId &&
    ids.failed === null && out.commitStarted !== true && out.possibleNonRunnable !== true && out.liveMutationAuthorized !== true &&
    (out.runtimeWriterAuthority ? out.runtimeWriterAuthority.state === 'settled' : out.runtimeWriterProtocol === 1) &&
    !['publication', 'registration', 'liveValidation', 'revisionEvent'].some(key => out[key] != null);
}
function assertNoSiblingObligation(record) {
  for (const sibling of [record.candidatePath, record.rollbackPath, record.failedPath]) {
    if (sibling === null) continue;
    try { fs.lstatSync(sibling, { bigint: true }); throw defer('recovery-pending'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

class FailedRestorePointRetirement {
  #closing = false;
  #active = new Set();
  #noticeCursor = new Map();
  constructor({ registry, coordinator, planRegistry, stateRepository, restorePointServiceFor, verifyLiveProof,
    assertTargetAvailable, clock = () => new Date(), randomUUID = crypto.randomUUID } = {}) {
    if (!registry || ['loadPublishedTerminalEvidence', 'loadRestorePointRetirement', 'writeRestorePointRetirement',
      'listRestorePointRetirementItems', 'hasOtherActiveRestorePointReference'].some(key => typeof registry[key] !== 'function') ||
      typeof coordinator?.runMutation !== 'function' || typeof coordinator?.assertMutationLease !== 'function' ||
      typeof planRegistry?.hasRestorePointReference !== 'function' || typeof stateRepository?.listHistory !== 'function' ||
      [restorePointServiceFor, verifyLiveProof, assertTargetAvailable, clock, randomUUID].some(fn => typeof fn !== 'function')) throw invalid();
    Object.assign(this, { registry, coordinator, planRegistry, stateRepository, restorePointServiceFor, verifyLiveProof, assertTargetAvailable, clock, randomUUID });
  }

  #start(work) {
    if (this.#closing) return Promise.reject(invalid());
    const task = Promise.resolve().then(work); this.#active.add(task);
    task.then(() => this.#active.delete(task), () => this.#active.delete(task)); return task;
  }
  close() {
    this.#closing = true;
    return Promise.allSettled([...this.#active]).then(() => undefined);
  }
  retireLive(request) { return this.#start(() => this.#live(request)); }
  retryPass(request) { return this.#start(() => this.#pass(request)); }

  async #live(request) {
    exact(request, ['jobId', 'binding', 'selector', 'lease', 'finalPolicyProof']);
    const { jobId, lease, finalPolicyProof } = request;
    if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw invalid();
    const selected = selector(request.selector);
    this.coordinator.assertMutationLease(lease, selected, jobId);
    exact(request.binding, ['expectedTarget', 'expectedOperationKind']);
    exact(request.binding.expectedTarget, ['kind', 'stableServerId', 'path']);
    if (request.binding.expectedTarget.kind !== 'existing' || request.binding.expectedTarget.stableServerId !== selected.instanceId ||
        normalizeRecoveryTargetPath(request.binding.expectedTarget.path) !== selected.serverPath) throw invalid();
    let authorized = null; let attemptAt = null;
    try {
      if (await this.verifyLiveProof(finalPolicyProof, { jobId, selector: selected, lease }) !== true) return result(jobId, 'deferred', 'missing-final-policy-proof');
      const proof = await this.registry.loadPublishedTerminalEvidence(jobId, request.binding);
      if (!eligible(proof.record)) return result(jobId, 'not-eligible');
      const candidate = normalizeRetirementCandidate(proof.record.outcome.failedPointRetirementCandidate);
      if (candidate.operationId !== jobId || proof.record.restorePoint.id !== candidate.id || proof.record.restorePoint.sha256 !== candidate.sha256) throw defer('invalid-evidence');
      assertNoSiblingObligation(proof.record);
      authorized = await this.registry.loadRestorePointRetirement(jobId);
      if (authorized?.value.progress === 'deleted') return result(jobId, 'reclaimed', null, authorized.value);
      const service = await this.restorePointServiceFor(selected);
      return await service.withExactRetirementPoint(candidate, {
        authority: { lease, operationId: jobId, selector: selected, coordinator: this.coordinator }, receipt: authorized?.value ?? null,
        recheckReferences: () => this.#references(jobId, selected, proof)
      }, async session => {
        try {
          if (!authorized) {
            const capture = await session.captureAuthorization(); const now = this.#now(candidate.createdAt);
            const value = normalizeRetirementReceipt({ schemaVersion: 1, policyVersion: 1, sequence: 0, jobId,
              operationKind: proof.record.operationKind, target: proof.record.target, candidate,
              terminal: { recordSha256: proof.recordSha256, envelopeSha256: proof.envelopeSha256,
                targetPathHash: proof.envelope.targetPathHash, envelopeChecksum: proof.envelope.checksum }, ...capture,
              settlement: { caller: 'live-precommit-final-policy', action: 'pre-swap-restored', swapStep: 'none', commitStarted: false, policyRestored: true },
              progress: 'authorized', durability: { archive: 'not-started', sidecar: 'not-started' }, diagnostic: null,
              lastAttemptAt: null, createdAt: now, updatedAt: now });
            authorized = await this.registry.writeRestorePointRetirement(jobId, { expectedSha256: null, value });
          }
          attemptAt = this.#attemptAt(authorized.value, this.#inventory(null));
          authorized = await this.#update(authorized, { lastAttemptAt: attemptAt, diagnostic: null }, attemptAt);
          return await this.#consume(session, authorized, selected, lease, value => { authorized = value; });
        } catch (error) { authorized = await this.#diagnose(authorized, reason(error), attemptAt);
          return result(jobId, 'deferred', reason(error), authorized?.value); }
      });
    } catch (error) {
      authorized = await this.#diagnose(authorized, reason(error), attemptAt);
      return result(jobId, 'deferred', reason(error), authorized?.value);
    }
  }

  #now(minimum) {
    const date = this.clock(); if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw invalid();
    const time = Math.max(date.getTime(), timestamp(minimum));
    const value = new Date(time).toISOString(); timestamp(value); return value;
  }
  #inventory(selected) {
    const items = this.registry.listRestorePointRetirementItems({ selector: selected });
    if (!Array.isArray(items)) throw defer('invalid-evidence');
    const seen = new Set();
    for (const item of items) {
      exact(item, ['jobId', 'selector', 'state', 'createdAt', 'lastAttemptAt']);
      if (!JOB_ID_PATTERN.test(item.jobId) || seen.has(item.jobId) || !['authorized-retry', 'reclaimed', 'deferred-proof'].includes(item.state)) throw defer('invalid-evidence');
      seen.add(item.jobId); selector(item.selector); timestamp(item.createdAt);
      if (item.lastAttemptAt !== null) timestamp(item.lastAttemptAt);
    }
    return items;
  }
  #attemptAt(receipt, inventory) {
    const date = this.clock(); if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw invalid();
    const maximum = inventory.reduce((max, item) => item.lastAttemptAt === null ? max : Math.max(max, timestamp(item.lastAttemptAt)), -1);
    const value = new Date(Math.max(date.getTime(), timestamp(receipt.createdAt), maximum + 1)).toISOString();
    timestamp(value); return value;
  }
  async #update(loaded, patch, at) {
    const value = normalizeRetirementReceipt({ ...loaded.value, ...patch, sequence: loaded.value.sequence + 1,
      updatedAt: this.#now([loaded.value.updatedAt, at || loaded.value.createdAt].sort().at(-1)) });
    return this.registry.writeRestorePointRetirement(value.jobId, { expectedSha256: loaded.sha256, value });
  }
  async #diagnose(loaded, why, at) {
    if (!loaded) return null;
    try { return await this.#update(loaded, { diagnostic: { reason: why, at: at || this.#now(loaded.value.updatedAt) } }, at); }
    catch (error) {
      // A conflict consumes this selected slot. Reload once, never retry its effect.
      if (reason(error) === 'receipt-conflict') {
        try { return await this.registry.loadRestorePointRetirement(loaded.value.jobId) || loaded; } catch { /* retain prior obligation */ }
      }
      return loaded;
    }
  }

  async #references(jobId, selected, proof) {
    const record = proof.record; const candidate = normalizeRetirementCandidate(record.outcome.failedPointRetirementCandidate);
    const fresh = await this.registry.loadPublishedTerminalEvidence(jobId, { expectedTarget: record.target, expectedOperationKind: record.operationKind });
    if (fresh.recordSha256 !== proof.recordSha256 || fresh.envelopeSha256 !== proof.envelopeSha256 || !eligible(fresh.record)) throw defer('invalid-evidence');
    assertNoSiblingObligation(fresh.record);
    let owned = false;
    try {
      owned = await this.registry.hasOtherActiveRestorePointReference({ target: record.target, candidate, excludingJobId: jobId });
      if (typeof owned !== 'boolean') throw invalid();
      const planned = await this.planRegistry.hasRestorePointReference({ instanceId: selected.instanceId, candidate, excludingJobId: jobId });
      if (typeof planned !== 'boolean') throw invalid(); owned ||= planned;
    } catch (error) { throw defer('reference-proof-incomplete', error); }
    let cursor = null; const cursors = new Set(); const references = new Map();
    try {
      for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
        const page = strictJsonClone(await this.stateRepository.listHistory(selected.serverPath, { cursor, limit: 200 }),
          { maxDepth: 16, maxCollection: 4096, maxStringBytes: 64 * 1024 });
        exact(page, ['items', 'nextCursor']);
        if (!Array.isArray(page.items) || page.items.length > 200 || (page.nextCursor !== null &&
            (typeof page.nextCursor !== 'string' || !page.nextCursor.length || page.nextCursor.length > 4096))) throw invalid();
        for (const entry of page.items) {
          if (!entry || Object.getPrototypeOf(entry) !== Object.prototype) throw invalid();
          const required = ['schemaVersion', 'operationId', 'sequence', 'kind', 'outcome', 'timestamp', 'sourceRevision', 'targetRevision'];
          const allowed = [...required, 'restorePointId', 'restorePointSha256', 'restorePointTotalBytes', 'sourceRuntime', 'targetRuntime',
            'name', 'metadataName', 'archivePath', 'metadataPath'];
          if (required.some(key => !Object.hasOwn(entry, key)) || Object.keys(entry).some(key => !allowed.includes(key)) || entry.schemaVersion !== 1 ||
              typeof entry.operationId !== 'string' || !HISTORY_ID.test(entry.operationId) || !isSafeWindowsBasename(`${entry.operationId}.json`) ||
              !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 ||
              !['install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback', 'import-files-only', 'detach', 'uninstall'].includes(entry.kind) ||
              !['completed', 'rolled-back', 'failed', 'recovery-required'].includes(entry.outcome) ||
              !Number.isSafeInteger(entry.sourceRevision) || entry.sourceRevision < 0 || !Number.isSafeInteger(entry.targetRevision) || entry.targetRevision < 0) throw invalid();
          timestamp(entry.timestamp);
          for (const key of ['sourceRuntime', 'targetRuntime']) if (Object.hasOwn(entry, key)) normalizeRuntimeTuple(entry[key]);
          const id = entry.restorePointId; const sha256 = entry.restorePointSha256;
          if (Object.hasOwn(entry, 'restorePointTotalBytes') && (typeof entry.restorePointTotalBytes !== 'string' ||
              !/^(0|[1-9][0-9]*)$/.test(entry.restorePointTotalBytes) || entry.restorePointTotalBytes.length > 30 || id === undefined || sha256 === undefined)) throw invalid();
          if (id === undefined && sha256 === undefined) {
            if (['name', 'metadataName', 'archivePath', 'metadataPath'].some(key => Object.hasOwn(entry, key))) throw invalid();
            continue;
          }
          if (typeof id !== 'string' || !HISTORY_ID.test(id) || typeof sha256 !== 'string' || !HASH.test(sha256)) throw invalid();
          const sameId = id === candidate.id; let sameLocator = false; const locators = {};
          for (const [key, expected] of [['name', candidate.name], ['metadataName', candidate.metadataName],
            ['archivePath', path.join(record.target.path, 'backups', candidate.name)], ['metadataPath', path.join(record.target.path, 'backups', candidate.metadataName)]]) {
            if (!Object.hasOwn(entry, key)) continue;
            if (typeof entry[key] !== 'string' || (!key.endsWith('Path') && !isSafeWindowsBasename(entry[key]))) throw invalid();
            const actual = key.endsWith('Path') ? normalizeRecoveryTargetPath(entry[key]) : entry[key].toLocaleLowerCase('en-US');
            const wanted = key.endsWith('Path') ? normalizeRecoveryTargetPath(expected) : expected.toLocaleLowerCase('en-US');
            locators[key] = actual; if (actual === wanted) sameLocator = true; else if (sameId) throw invalid();
          }
          const prior = references.get(id);
          if (prior && (prior.sha256 !== sha256 || Object.keys(locators).some(key => Object.hasOwn(prior, key) && prior[key] !== locators[key]))) throw invalid();
          references.set(id, { ...prior, ...locators, sha256 });
          if ((sameId && sha256 !== candidate.sha256) || (sameLocator && !sameId)) throw invalid();
          // Local history is an independent reference surface, even when its
          // operation ID equals the creating job. Only the authenticated registry
          // creation marker above is exempt; history outcome never weakens ownership.
          if (sameId || sameLocator) owned = true;
        }
        if (page.nextCursor === null) { if (owned) throw defer('independent-owner'); return; }
        if (cursors.has(page.nextCursor)) throw invalid(); cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      throw invalid();
    } catch (error) { if (error.retirementReason === 'independent-owner') throw error; throw defer('reference-proof-incomplete', error); }
  }

  async #consume(session, loaded, selected, lease, publish) {
    const available = async () => this.assertTargetAvailable(selected, lease);
    const update = async patch => { loaded = await this.#update(loaded, patch, loaded.value.lastAttemptAt); publish(loaded); };
    if (loaded.value.progress === 'authorized') {
      await available();
      await session.captureAuthorization();
      await update({ progress: 'deleting', durability: { archive: 'intent', sidecar: 'not-started' } });
    }
    if (loaded.value.progress === 'deleting') {
      await available(); lease.markDirty();
      if (!await session.reconcileAbsent('archive', loaded.value)) {
        await available(); await session.deleteArchive(loaded.value);
      }
      await update({ progress: 'archive-deleted', durability: { archive: 'durable', sidecar: 'not-started' } });
    }
    if (loaded.value.progress === 'archive-deleted') {
      await available();
      if (loaded.value.durability.sidecar === 'not-started') {
        await session.captureAuthorization();
        await update({ durability: { archive: 'durable', sidecar: 'intent' } });
      }
      await available(); lease.markDirty();
      if (!await session.reconcileAbsent('sidecar', loaded.value)) {
        await available(); await session.deleteSidecar(loaded.value);
      }
      await update({ progress: 'deleted', durability: { archive: 'durable', sidecar: 'durable' }, diagnostic: null });
    }
    return result(loaded.value.jobId, 'reclaimed', null, loaded.value);
  }

  async #retry(item, inventory) {
    let loaded = null; let attemptAt = null;
    try {
      loaded = await this.registry.loadRestorePointRetirement(item.jobId);
      if (!loaded || loaded.value.progress === 'deleted') throw defer('invalid-evidence');
      const selected = selector(item.selector);
      if (loaded.value.jobId !== item.jobId || loaded.value.target.kind !== 'existing' ||
          loaded.value.target.stableServerId !== selected.instanceId ||
          normalizeRecoveryTargetPath(loaded.value.target.path) !== selected.serverPath) throw defer('invalid-evidence');
      attemptAt = this.#attemptAt(loaded.value, inventory);
      loaded = await this.#update(loaded, { lastAttemptAt: attemptAt, diagnostic: null }, attemptAt);
      const operationId = `retire-${this.randomUUID()}`;
      return await this.coordinator.runMutation(item.selector, { operation: 'failed-restorepoint-retirement', operationId, revisionMode: 'auto' }, async lease => {
        try {
          this.coordinator.assertMutationLease(lease, item.selector, operationId);
          const proof = await this.registry.loadPublishedTerminalEvidence(item.jobId, { expectedTarget: loaded.value.target, expectedOperationKind: loaded.value.operationKind });
          if (!eligible(proof.record)) throw defer('invalid-evidence');
          const service = await this.restorePointServiceFor(item.selector);
          return await service.withExactRetirementPoint(loaded.value.candidate, {
            authority: { lease, operationId, selector: item.selector, coordinator: this.coordinator }, receipt: loaded.value,
            recheckReferences: () => this.#references(item.jobId, item.selector, proof)
          }, async session => {
            try { return await this.#consume(session, loaded, item.selector, lease, next => { loaded = next; }); }
            catch (error) { loaded = await this.#diagnose(loaded, reason(error), attemptAt); return result(item.jobId, 'deferred', reason(error), loaded.value); }
          });
        } catch (error) { loaded = await this.#diagnose(loaded, reason(error), attemptAt); return result(item.jobId, 'deferred', reason(error), loaded.value); }
      });
    } catch (error) {
      loaded = await this.#diagnose(loaded, reason(error), attemptAt);
      return result(item.jobId, 'deferred', reason(error), loaded?.value);
    }
  }

  async #pass(request) {
    exact(request, ['trigger', 'selector']);
    if (typeof request.trigger !== 'string' ||
        (request.trigger !== 'startup' && request.trigger !== 'recovery-completed')) throw invalid();
    const limits = LIMITS[request.trigger];
    if (!limits || (request.trigger === 'startup' && request.selector !== null) || (request.trigger === 'recovery-completed' && request.selector === null)) throw invalid();
    const selected = request.selector === null ? null : selector(request.selector);
    let inventory = this.#inventory(selected);
    const compare = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId);
    const retries = inventory.filter(item => item.state === 'authorized-retry').sort((a, b) =>
      (a.lastAttemptAt === null ? (b.lastAttemptAt === null ? 0 : -1) : b.lastAttemptAt === null ? 1 : a.lastAttemptAt.localeCompare(b.lastAttemptAt)) || compare(a, b)).slice(0, limits.retry);
    const notices = inventory.filter(item => item.state !== 'authorized-retry').sort(compare);
    const key = selected ? `${selected.instanceId}|${selected.serverPath}` : 'startup'; const previous = this.#noticeCursor.get(key);
    const start = previous ? (notices.findIndex(item => item.jobId === previous) + 1) % Math.max(notices.length, 1) : 0;
    const chosenNotices = [...notices.slice(start), ...notices.slice(0, start)].slice(0, limits.notice);
    const results = []; let retryConsidered = 0; let noticeConsidered = 0;
    for (const item of retries) {
      if (this.#closing) break;
      results.push(await this.#retry(item, this.#inventory(null))); retryConsidered++;
      // A successful stamp changes the authenticated inventory order on disk.
      inventory = this.#inventory(selected);
    }
    for (const item of chosenNotices) {
      if (this.#closing) break;
      let loaded = null;
      try { if (item.state === 'reclaimed') loaded = await this.registry.loadRestorePointRetirement(item.jobId); } catch { /* notice only */ }
      results.push(loaded?.value.progress === 'deleted' ? result(item.jobId, 'reclaimed', null, loaded.value) : result(item.jobId, 'deferred', 'missing-final-policy-proof'));
      noticeConsidered++; this.#noticeCursor.set(key, item.jobId);
    }
    const considered = retryConsidered + noticeConsidered;
    const processed = new Set(results.map(item => item.jobId));
    return Object.freeze({ considered, retryConsidered, noticeConsidered, results: Object.freeze(results),
      remaining: inventory.filter(item => !processed.has(item.jobId)).length });
  }
}

module.exports = { FailedRestorePointRetirement };
