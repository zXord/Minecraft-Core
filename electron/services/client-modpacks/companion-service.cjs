const crypto = require('node:crypto');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { normalizeRuntimeTuple } = require('../modpacks/contracts.cjs');
const { proveEntriesAbsent } = require('../modpacks/instance-ownership.cjs');
const { CURRENT_STATE, STATE_DIRECTORY } = require('../modpacks/state/modpack-state-repository.cjs');
const { serverPackFingerprint, normalizeCompanionDescriptor } = require('./companion-contracts.cjs');
const { isClientArchiveName, singleClientArchive } = require('./client-archive-source.cjs');
const MAX_INSPECTIONS = 4;
const TTL_MS = 15 * 60 * 1000;
const MODPACK_STATE_ENTRY = `${STATE_DIRECTORY}/${CURRENT_STATE}`;
const fail = (code = 'INVALID_REQUEST', cause) => new ModpackError(code, code === 'CLIENT_PACK_UNAVAILABLE' ? 'The matching client pack is unavailable' : 'The matching client pack request could not be completed', { cause });
function request(value, keys, required = keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length ||
      Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) ||
      required.some(key => !Object.hasOwn(value, key))) throw fail();
  return value;
}
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) throw fail(); return value; }
function fingerprint(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw fail(); return value; }
function cancelled(signal) { if (signal.aborted) throw fail('CANCELLED'); }
function sameRuntime(left, right) {
  const a = normalizeRuntimeTuple(left); const b = normalizeRuntimeTuple(right);
  return ['minecraftVersion', 'loaderFamily', 'loaderVersion'].every(key => a[key] === b[key]);
}
class CompanionService {
  constructor({ store, readServerState, resolveServer, coordinator, providers, sourceResolver, artifactAcquisition,
    archiveInspector, clientCandidatePreparer, clock = Date.now } = {}) {
    for (const [object, method] of [[store, 'get'], [store, 'put'], [coordinator, 'runMutation'], [providers?.github, 'getRepositoryIdentity'],
      [providers?.github, 'listUploadedAssets'], [sourceResolver, 'resolveArtifactSetPlan'], [artifactAcquisition, 'downloadSet'],
      [archiveInspector, 'inspectArchive'], [archiveInspector?.materializer?.workspaceRegistry, 'releaseOwner'],
      [clientCandidatePreparer, 'inspect'], [clientCandidatePreparer, 'forgetInspection']]) if (typeof object?.[method] !== 'function') throw fail();
    if (typeof readServerState !== 'function' || typeof resolveServer !== 'function' || typeof clock !== 'function') throw fail();
    Object.assign(this, { store, readServerState, resolveServer, coordinator, providers, sourceResolver, artifactAcquisition, archiveInspector, clientCandidatePreparer, clock });
    this.retained = new Map(); this.operations = new Map(); this.lifecycle = Promise.resolve(); this.closed = false;
  }
  getStatus(value) {
    return this.#run(undefined, async signal => {
      request(value, ['serverId']); identifier(value.serverId);
      // A server whose modpack state is proven absent answers before the lifecycle
      // lock, so another server's inspection cleanup can never delay or fail its
      // {clientModpack:null}. Present or unprovable state keeps the strict read.
      const selector = await this.resolveServer(value.serverId);
      if (!selector) throw fail('CLIENT_PACK_UNAVAILABLE');
      if (proveEntriesAbsent(selector.serverPath, [MODPACK_STATE_ENTRY])) return null;
      await this.#prune(); cancelled(signal);
      const installed = await this.#installed(value.serverId, undefined, { signal });
      if (!installed) return null;
      const record = await this.store.get(value.serverId, installed.fingerprint);
      if (!record) return normalizeCompanionDescriptor({ schemaVersion: 1, status: 'unpaired', serverFingerprint: installed.fingerprint,
        serverVersion: installed.state.source.version, source: null, runtime: null, artifactSha256: null });
      const descriptor = normalizeCompanionDescriptor(record.descriptor);
      if (!sameRuntime(installed.state.runtime, descriptor.runtime) || !this.#sameRelease(installed.state.source, descriptor.source)) throw fail('CLIENT_PACK_UNAVAILABLE');
      return normalizeCompanionDescriptor({ ...descriptor, serverVersion: installed.state.source.version });
    });
  }
  listAssets(value) {
    return this.#run(undefined, async signal => {
      request(value, ['serverId']); identifier(value.serverId);
      await this.#prune(); cancelled(signal);
      const installed = await this.#installed(value.serverId, undefined, { signal });
      if (!installed) throw fail('CLIENT_PACK_UNAVAILABLE');
      const source = installed.state.source;
      let assets;
      if (source.provider === 'github') assets = await this.#githubAssets(source, signal);
      else if (source.provider === 'modrinth') {
        const resolved = await this.sourceResolver.resolveArtifactSetPlan({ provider: 'modrinth', projectId: source.projectId, versionId: source.versionId }, { signal });
        const part = singleClientArchive(resolved.artifactSetPlan, source.provider);
        assets = [{ assetId: source.versionId, fileName: part.fileName, size: part.size }];
      } else assets = [];
      cancelled(signal);
      return deepFreeze({ serverFingerprint: installed.fingerprint, serverVersion: source.version, assets });
    });
  }
  inspect(value, options = {}) {
    return this.#run(options.signal, async signal => {
      request(value, ['serverId', 'expectedServerFingerprint', 'assetId'], ['serverId', 'expectedServerFingerprint']);
      request(options, ['signal', 'onProgress'], []);
      identifier(value.serverId); fingerprint(value.expectedServerFingerprint);
      if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw fail();
      const slot = await this.#reserve();
      try {
        cancelled(signal);
        const installed = await this.#installed(value.serverId, value.expectedServerFingerprint, { signal });
        const source = installed.state.source;
        let resolved; let companionSource;
        if (source.provider === 'github') {
          if (typeof value.assetId !== 'string' || !/^[1-9][0-9]*$/.test(value.assetId)) throw fail();
          const assets = await this.#githubAssets(source, signal);
          if (!assets.some(asset => asset.assetId === value.assetId)) throw fail();
          resolved = await this.sourceResolver.resolveArtifactSetPlan({ provider: 'github', repositoryId: source.repositoryId, releaseId: source.releaseId, assetIds: [value.assetId] }, { signal });
          companionSource = { provider: 'github', repositoryId: source.repositoryId, githubOwner: source.githubOwner, githubRepo: source.githubRepo, releaseId: source.releaseId, assetId: value.assetId };
          if (singleClientArchive(resolved.artifactSetPlan, source.provider).providerAssetId !== value.assetId) throw fail('PLAN_STALE');
        } else if (source.provider === 'modrinth') {
          if (value.assetId !== undefined && value.assetId !== source.versionId) throw fail();
          companionSource = { provider: 'modrinth', projectId: source.projectId, versionId: source.versionId };
          resolved = await this.sourceResolver.resolveArtifactSetPlan(companionSource, { signal });
          singleClientArchive(resolved.artifactSetPlan, source.provider);
        } else throw fail('CLIENT_PACK_UNAVAILABLE');
        cancelled(signal);
        const verified = await this.artifactAcquisition.downloadSet(resolved.artifactSetPlan, { signal, onProgress: options.onProgress });
        const part = singleClientArchive(verified, source.provider);
        if (source.provider === 'github' && part.providerAssetId !== value.assetId) throw fail('PLAN_STALE');
        const archive = await this.archiveInspector.inspectArchive({ verifiedArtifactSet: verified, signal, onProgress: options.onProgress });
        // Only this newly created upstream capability enters our ownership set.
        slot.inspectionId = archive.inspectionId;
        if (typeof slot.inspectionId !== 'string' || !slot.inspectionId.length) throw fail('CLIENT_PACK_UNAVAILABLE');
        cancelled(signal);
        const inspected = await this.clientCandidatePreparer.inspect({ inspectionId: slot.inspectionId, signal, onProgress: options.onProgress });
        if (source.provider === 'modrinth' && inspected.contentFormat === 'multimc') throw fail('UNSUPPORTED_ARCHIVE');
        if (!sameRuntime(installed.state.runtime, inspected.runtime)) throw fail('RUNTIME_INCOMPLETE');
        const descriptor = normalizeCompanionDescriptor({ schemaVersion: 1, status: 'ready', serverFingerprint: installed.fingerprint,
          serverVersion: source.version, source: companionSource, runtime: inspected.runtime, artifactSha256: part.calculatedDigests.sha256 });
        await this.#installed(value.serverId, installed.fingerprint, { signal });
        cancelled(signal);
        Object.assign(slot, { serverId: value.serverId, descriptor, active: false, createdAt: this.clock() });
        return deepFreeze({ inspectionId: slot.inspectionId, ...descriptor, name: inspected.name, version: inspected.version,
          optionalFiles: inspected.optionalFiles, downloadBytes: inspected.downloadBytes });
      } catch (cause) {
        await this.#release(slot);
        if (signal.aborted) throw fail('CANCELLED', cause);
        throw cause;
      }
    });
  }
  accept(value) {
    return this.#run(undefined, async signal => {
      request(value, ['serverId', 'expectedServerFingerprint', 'inspectionId']); identifier(value.serverId); fingerprint(value.expectedServerFingerprint); identifier(value.inspectionId);
      const slot = [...this.retained.values()].find(item => item.inspectionId === value.inspectionId);
      if (!slot) throw fail();
      if (slot.active) throw fail('OPERATION_IN_PROGRESS');
      if (slot.serverId !== value.serverId || slot.descriptor.serverFingerprint !== value.expectedServerFingerprint) throw fail('PLAN_STALE');
      if (this.clock() - slot.createdAt >= TTL_MS) { await this.#release(slot); throw fail('PLAN_STALE'); }
      slot.active = true;
      try {
        await this.#prune(); cancelled(signal);
        const selector = await this.resolveServer(value.serverId);
        if (!selector) throw fail('CLIENT_PACK_UNAVAILABLE');
        const result = await this.coordinator.runMutation(selector, { operation: 'pair-client-pack', operationId: `pair-client-${crypto.randomUUID()}`, revisionMode: 'none', signal }, async () => {
          const registered = await this.resolveServer(value.serverId);
          if (!registered || registered.instanceId !== selector.instanceId || registered.serverPath !== selector.serverPath) throw fail('PLAN_STALE');
          const installed = await this.#installed(value.serverId, value.expectedServerFingerprint, { force: true, signal });
          if (!sameRuntime(installed.state.runtime, slot.descriptor.runtime)) throw fail('PLAN_STALE');
          cancelled(signal);
          const expectedSequence = this.store.sequence;
          await this.store.put({ serverId: value.serverId, descriptor: slot.descriptor }, { expectedSequence });
          return slot.descriptor;
        });
        await this.#release(slot);
        return result;
      } finally { slot.active = false; }
    });
  }
  dispose() {
    this.closed = true;
    for (const controller of this.operations.values()) controller.abort();
    if (!this.disposal) this.disposal = (async () => {
      await Promise.allSettled([...this.operations.keys()]);
      await this.#locked(async () => { for (const slot of this.retained.values()) await this.#release(slot); });
    })().finally(() => { this.disposal = null; });
    return this.disposal;
  }
  #run(externalSignal, work) {
    if (this.closed) return Promise.reject(fail('CLIENT_PACK_UNAVAILABLE'));
    if (externalSignal !== undefined && (typeof externalSignal?.addEventListener !== 'function' || typeof externalSignal?.removeEventListener !== 'function' || typeof externalSignal.aborted !== 'boolean')) return Promise.reject(fail());
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted) abort(); else externalSignal?.addEventListener('abort', abort, { once: true });
    const pending = Promise.resolve().then(() => { cancelled(controller.signal); return work(controller.signal); });
    this.operations.set(pending, controller);
    pending.finally(() => { this.operations.delete(pending); externalSignal?.removeEventListener('abort', abort); }).catch(() => {});
    return pending;
  }
  async #installed(serverId, expected, options) {
    if (!await this.resolveServer(serverId)) throw fail('CLIENT_PACK_UNAVAILABLE');
    const state = await this.readServerState(serverId, options);
    if (!state || state.modpackManaged !== true) { if (expected) throw fail('PLAN_STALE'); return null; }
    const actual = serverPackFingerprint(state);
    if (expected && expected !== actual) throw fail('PLAN_STALE');
    return { state, fingerprint: actual };
  }
  async #githubAssets(source, signal) {
    const identity = await this.providers.github.getRepositoryIdentity(`https://github.com/${source.githubOwner}/${source.githubRepo}`);
    cancelled(signal);
    if (identity.repositoryId !== source.repositoryId || identity.visibility !== 'public') throw fail('PLAN_STALE');
    const listing = await this.providers.github.listUploadedAssets({ repositoryId: source.repositoryId, releaseId: source.releaseId });
    cancelled(signal);
    if (listing.repositoryId !== source.repositoryId || listing.releaseId !== source.releaseId || !Array.isArray(listing.assets)) throw fail('PLAN_STALE');
    return listing.assets.filter(asset => isClientArchiveName(asset.fileName, 'github') && (asset.state === undefined || asset.state === 'uploaded'))
      .map(asset => ({ assetId: asset.assetId, fileName: asset.fileName, size: asset.size }));
  }
  #sameRelease(installed, companion) {
    return installed.provider === companion.provider && (installed.provider === 'github'
      ? ['repositoryId', 'releaseId', 'githubOwner', 'githubRepo'].every(key => installed[key] === companion[key])
      : installed.provider === 'modrinth' && installed.projectId === companion.projectId && installed.versionId === companion.versionId);
  }
  #locked(work) {
    const pending = this.lifecycle.then(work);
    this.lifecycle = pending.catch(() => {});
    return pending;
  }
  #prune() {
    return this.#locked(async () => {
      for (const slot of this.retained.values()) if (!slot.active && this.clock() - slot.createdAt >= TTL_MS) await this.#release(slot);
    });
  }
  #reserve() {
    return this.#locked(async () => {
      if (this.closed) throw fail('CANCELLED');
      for (const slot of this.retained.values()) if (!slot.active && this.clock() - slot.createdAt >= TTL_MS) await this.#release(slot);
      if (this.retained.size >= MAX_INSPECTIONS) {
        const oldest = [...this.retained.values()].find(slot => !slot.active);
        if (!oldest) throw fail('OPERATION_IN_PROGRESS');
        oldest.active = true;
        try { await this.#release(oldest); } finally { oldest.active = false; }
      }
      const slot = { key: crypto.randomUUID(), inspectionId: null, active: true, createdAt: this.clock() };
      this.retained.set(slot.key, slot);
      return slot;
    });
  }
  async #release(slot) {
    if (!this.retained.has(slot.key)) return;
    slot.active = true;
    try {
      if (slot.inspectionId) {
        await this.archiveInspector.materializer.workspaceRegistry.releaseOwner(slot.inspectionId);
        this.clientCandidatePreparer.forgetInspection(slot.inspectionId);
      }
      this.retained.delete(slot.key);
    } finally { slot.active = false; }
  }
}
module.exports = { CompanionService };
