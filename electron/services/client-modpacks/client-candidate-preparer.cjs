const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { normalizeRuntimeTuple } = require('../modpacks/contracts.cjs');
const { getRequiredJavaVersion } = require('../minecraft-launcher/utils.cjs');
const { buildMrpackClientPlan, listOptionalClientFileChoices, resolveOptionalClientFileChoiceIds } = require('../modpacks/mrpack/mrpack-file-plan.cjs');
const { parseMrpackManifest, MRPACK_MANIFEST_MAX_BYTES } = require('../modpacks/mrpack/mrpack-parser.cjs');
const { canonicalWindowsPath, normalizeMrpackPath } = require('../modpacks/mrpack/mrpack-schema.cjs');
const { copyRegularFile } = require('../modpacks/planning/production-candidate-preparer.cjs');
const { PersistentCandidateHashService, fileIdentityFromStat, sameFileIdentity } = require('../modpacks/planning/candidate-hash-service.cjs');
const { clientPathPolicy } = require('./client-content-policy.cjs');
const { MULTIMC_MANIFEST_MAX_BYTES, selectClientArchiveFormat, parseMultiMCManifest, buildMultiMCClientPlan } = require('./multimc-client-plan.cjs');

const failure = (code = 'INVALID_REQUEST', cause) => new ModpackError(code,
  code === 'CANCELLED' ? 'The client pack preparation was cancelled'
    : code === 'PLAN_STALE' ? 'The client pack inspection changed' : 'The client pack preparation could not be completed', { cause });
function checkCancellation(signal) {
  if (signal?.aborted) throw failure('CANCELLED');
}
function reporter(callback) {
  if (callback !== undefined && typeof callback !== 'function') throw failure();
  let previous = '';
  return event => {
    const key = JSON.stringify(event);
    if (previous === key) return;
    previous = key;
    try { Promise.resolve(callback?.(deepFreeze(event))).catch(() => {}); } catch { /* observers cannot affect preparation */ }
  };
}
function relativeFile(root, relative) {
  const normalized = normalizeMrpackPath(relative, { rejectState: false });
  const absolute = path.resolve(root, ...normalized.split('/'));
  const fromRoot = path.relative(root, absolute);
  if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) throw failure('UNSAFE_ARCHIVE_ENTRY');
  return absolute;
}
async function safeStat(root, relative, reparseInspector, signal) {
  checkCancellation(signal);
  const normalized = normalizeMrpackPath(relative, { rejectState: false });
  let current = root;
  const parts = normalized.split('/');
  for (const component of ['', ...parts]) {
    if (component) current = path.join(current, component);
    const stat = await fs.lstat(current, { bigint: true });
    const leaf = current === relativeFile(root, normalized);
    if (stat.isSymbolicLink() || await reparseInspector.isReparsePoint(current, signal ? { signal } : undefined) !== false ||
      (leaf ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) throw failure('UNSAFE_ARCHIVE_ENTRY');
    if (leaf) return stat;
  }
}
async function readMetadata(root, indexPath, format, reparseInspector, signal, expectedIdentity) {
  const before = await safeStat(root, indexPath, reparseInspector, signal);
  const identity = fileIdentityFromStat(before);
  if (expectedIdentity && !sameFileIdentity(expectedIdentity, identity)) throw failure('PLAN_STALE');
  const maximum = format === 'multimc' ? MULTIMC_MANIFEST_MAX_BYTES : MRPACK_MANIFEST_MAX_BYTES;
  if (before.size > BigInt(maximum)) throw failure('MANIFEST_INVALID');
  const handle = await fs.open(relativeFile(root, indexPath), 'r');
  try {
    if (!sameFileIdentity(fileIdentityFromStat(before), fileIdentityFromStat(await handle.stat({ bigint: true })))) throw failure('PLAN_STALE');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      checkCancellation(signal);
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum || BigInt(length) !== before.size) throw failure('MANIFEST_INVALID');
    const after = await safeStat(root, indexPath, reparseInspector, signal);
    if (!sameFileIdentity(fileIdentityFromStat(before), fileIdentityFromStat(after))) throw failure('PLAN_STALE');
    const bytes = buffer.subarray(0, length);
    return { manifest: format === 'multimc' ? parseMultiMCManifest(bytes) : parseMrpackManifest(bytes),
      digest: crypto.createHash('sha256').update(bytes).digest('hex'), identity };
  } finally { await handle.close(); }
}

async function revalidateEvidence(preparer, inspectionId, prior, signal) {
  checkCancellation(signal);
  const loaded = preparer.archiveExtractor.materializer.loadInspection(inspectionId);
  const selection = selectClientArchiveFormat(loaded.result.entries);
  if (selection.format !== prior.format || selection.metadataPath !== prior.indexPath ||
      loaded.result.artifactSet.fingerprint !== prior.fingerprint) throw failure('PLAN_STALE');
  const root = preparer.workspaceRegistry.resolveOwnedWorkspace({ ownerId: inspectionId, id: prior.value.outputId, kind: 'output' }).path;
  try {
    const current = await readMetadata(root, prior.indexPath, prior.format, preparer.reparseInspector, signal, prior.metadataIdentity);
    if (current.digest !== prior.digest) throw failure('PLAN_STALE');
    for (const [relative, identity] of prior.identities) {
      const stat = await safeStat(root, relative, preparer.reparseInspector, signal);
      if (!sameFileIdentity(identity, fileIdentityFromStat(stat))) throw failure('PLAN_STALE');
    }
  } catch (cause) {
    if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR') throw failure('PLAN_STALE', cause);
    throw cause;
  }
}

class ClientCandidatePreparer {
  constructor({ workspaceRegistry, archiveExtractor, artifactDownloader, artifactCache,
    candidateHashService = null, reparseInspector, randomUUID } = {}) {
    if (!workspaceRegistry || typeof workspaceRegistry.createStagingOutput !== 'function' ||
      typeof workspaceRegistry.resolveOwnedWorkspace !== 'function' || typeof workspaceRegistry.releaseOwner !== 'function' ||
      !archiveExtractor || typeof archiveExtractor.extractArchive !== 'function' ||
      typeof archiveExtractor.materializer?.loadInspection !== 'function' ||
      typeof artifactDownloader?.downloadPart !== 'function' || typeof artifactCache?.pathForSha256 !== 'function' ||
      typeof reparseInspector?.isReparsePoint !== 'function' || typeof randomUUID !== 'function' ||
      (candidateHashService !== null && (typeof candidateHashService?.hashFile !== 'function' || typeof candidateHashService?.dispose !== 'function'))) throw failure();
    Object.assign(this, { workspaceRegistry, archiveExtractor, artifactDownloader, artifactCache, reparseInspector, randomUUID });
    this.candidateHashService = candidateHashService || new PersistentCandidateHashService();
    this.ownsHashService = candidateHashService === null;
    this.inspections = new Map();
    this.owners = new Set();
    this.allocatedOwners = new Set();
    this.busy = new Set();
  }

  async inspect({ inspectionId, signal, onProgress } = {}) {
    const report = reporter(onProgress);
    checkCancellation(signal);
    // Load the main-owned inspection before allocating anything. Its owner is never ours to release.
    const loaded = this.archiveExtractor.materializer.loadInspection(inspectionId);
    if (this.busy.has(inspectionId)) throw failure('OPERATION_IN_PROGRESS');
    this.busy.add(inspectionId);
    try {
      const prior = this.inspections.get(inspectionId);
      if (prior) {
        report({ activity: 'revalidating-client-files' });
        await revalidateEvidence(this, inspectionId, prior, signal);
        return prior.value;
      }
      const entries = loaded.result?.entries;
      if (!['mrpack', 'zip'].includes(loaded.result?.archiveFamily) || !Array.isArray(entries)) throw failure('UNSUPPORTED_ARCHIVE');
      const { format, metadataPath: indexPath } = selectClientArchiveFormat(entries);
      const outputId = this.workspaceRegistry.createStagingOutput({ ownerId: inspectionId });
      report({ activity: 'extracting' });
      await this.archiveExtractor.extractArchive({ inspectionId, destinationId: outputId, signal,
        onProgress: progress => { if (progress?.phase === 'postwalk') report({ activity: 'verifying-archive' }); } });
      checkCancellation(signal);
      report({ activity: 'verifying-archive' });
      const root = this.workspaceRegistry.resolveOwnedWorkspace({ ownerId: inspectionId, id: outputId, kind: 'output' }).path;
      report({ activity: 'reading-client-metadata' });
      const { manifest, digest, identity: metadataIdentity } = await readMetadata(root, indexPath, format, this.reparseInspector, signal);
      const archiveEntries = entries.map(entry => ({ path: entry.entryName, type: entry.type, size: format === 'multimc' ? entry.size : Number(entry.size) }));
      const plan = format === 'multimc' ? buildMultiMCClientPlan({ manifest, archiveEntries }) : buildMrpackClientPlan({ manifest, archiveEntries });
      let runtime;
      try { runtime = format === 'multimc' ? plan.runtime : normalizeRuntimeTuple({ ...plan.runtime, javaMajor: getRequiredJavaVersion(plan.runtime.minecraftVersion), os: 'win32', architecture: 'x64' }); }
      catch (cause) { throw failure('RUNTIME_INCOMPLETE', cause); }
      const identities = new Map();
      if (format === 'multimc') {
        const marker = entries.find(entry => canonicalWindowsPath(entry.entryName) === 'instance.cfg');
        const stat = await safeStat(root, marker.entryName, this.reparseInspector, signal);
        if (stat.size.toString() !== marker.size) throw failure('PLAN_STALE');
        identities.set(marker.entryName, fileIdentityFromStat(stat));
      }
      const totalItems = plan.finalOverrides.length, stride = Math.max(1, Math.ceil(totalItems / 200));
      let completedItems = 0;
      const reportChecks = () => report({ activity: 'checking-bundled-files', completedItems, totalItems });
      reportChecks();
      for (const operation of plan.finalOverrides) {
        const stat = await safeStat(root, operation.archivePath, this.reparseInspector, signal);
        if (stat.size.toString() !== operation.size) throw failure('PLAN_STALE');
        identities.set(operation.archivePath, fileIdentityFromStat(stat));
        completedItems++;
        if (completedItems % stride === 0 || completedItems === totalItems) reportChecks();
      }
      const value = deepFreeze({ inspectionId, outputId, runtime,
        name: format === 'multimc' ? 'MultiMC client export' : manifest.name, version: format === 'multimc' ? runtime.minecraftVersion : manifest.versionId,
        ...(format === 'multimc' ? { contentFormat: 'multimc', runtimeConstraints: plan.runtimeConstraints } : {}),
        optionalFiles: format === 'multimc' ? [] : listOptionalClientFileChoices(manifest),
        downloadBytes: plan.downloads.reduce((total, item) => total + (item.selected ? BigInt(item.size) : 0n), 0n).toString(),
        manifest, archiveEntries });
      // Extraction must use upstream ownership. Its raw output is reclaimed by that inspection's lifecycle.
      this.inspections.set(inspectionId, { value, format, digest, indexPath, metadataIdentity, identities, fingerprint: loaded.result.artifactSet.fingerprint });
      return value;
    } finally { this.busy.delete(inspectionId); }
  }

  async prepare({ inspectionId, optionalFileIds, signal, onProgress } = {}) {
    const report = reporter(onProgress);
    let ownerId = null;
    let locked = false;
    try {
      const inspected = await this.inspect({ inspectionId, signal, onProgress });
      if (this.busy.has(inspectionId)) throw failure('OPERATION_IN_PROGRESS');
      this.busy.add(inspectionId);
      locked = true;
      const prior = this.inspections.get(inspectionId);
      if (prior.format === 'multimc' && (!Array.isArray(optionalFileIds) || optionalFileIds.length !== 0)) throw failure();
      const plan = prior.format === 'multimc' ? buildMultiMCClientPlan({ manifest: inspected.manifest, archiveEntries: inspected.archiveEntries }) :
        buildMrpackClientPlan({ manifest: inspected.manifest,
          selectedOptionalFiles: resolveOptionalClientFileChoiceIds(inspected.manifest, optionalFileIds), archiveEntries: inspected.archiveEntries });
      const proposedOwner = `client-candidate-${this.randomUUID()}`;
      if (this.allocatedOwners.has(proposedOwner) || !/^client-candidate-[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/u.test(proposedOwner)) throw failure();
      ownerId = proposedOwner;
      this.allocatedOwners.add(ownerId);
      this.owners.add(ownerId);
      const outputId = this.workspaceRegistry.createStagingOutput({ ownerId });
      const root = this.workspaceRegistry.resolveOwnedWorkspace({ ownerId, id: outputId, kind: 'output' }).path;
      const raw = this.workspaceRegistry.resolveOwnedWorkspace({ ownerId: inspectionId, id: inspected.outputId, kind: 'output' }).path;
      const selected = plan.downloads.filter(item => item.selected);
      const downloadBytes = selected.reduce((sum, item) => sum + BigInt(item.size), 0n);
      const assemblyBytes = downloadBytes + plan.finalOverrides.reduce((sum, item) => sum + BigInt(item.size), 0n);
      const totalItems = selected.length + plan.finalOverrides.length;
      const entries = new Map();
      let processedBytes = 0n;
      let completedItems = 0;
      let downloaded = 0n;
      const assembly = () => report({ activity: 'assembling-files', completedItems, totalItems,
        processedBytes: Number(processedBytes), totalBytes: Number(assemblyBytes) });
      const record = (relative, measured) => {
        const pathKey = canonicalWindowsPath(relative);
        const previous = entries.get(pathKey);
        entries.set(pathKey, { path: previous?.path || relative, pathKey, sha256: measured.sha256, size: measured.size, policy: clientPathPolicy(relative) });
        completedItems += 1;
        processedBytes += BigInt(measured.size);
        assembly();
      };
      const downloadProgress = (index, bytes) => report({ activity: 'downloading-pack-files', completedItems: index,
        totalItems: selected.length, processedBytes: Number(bytes), totalBytes: Number(downloadBytes) });
      if (selected.length) downloadProgress(0, 0n);
      assembly();
      for (const [index, download] of selected.entries()) {
        checkCancellation(signal);
        const verified = await this.artifactDownloader.downloadPart(download, { signal, onProgress: progress => {
          let bytes;
          try { bytes = BigInt(String(progress?.partBytes ?? progress?.setBytes ?? '0')); } catch { return; }
          if (bytes >= 0n && bytes <= BigInt(download.size)) downloadProgress(index, downloaded + bytes);
        } });
        checkCancellation(signal);
        downloaded += BigInt(download.size);
        downloadProgress(index + 1, downloaded);
        const measured = await copyRegularFile(this.artifactCache.pathForSha256(verified.sha256), relativeFile(root, download.targetPath), {
          candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal });
        if (measured.sha256 !== verified.sha256 || measured.size !== download.size) throw failure('HASH_MISMATCH');
        record(download.targetPath, measured);
      }
      for (const directory of plan.finalDirectories) await fs.mkdir(relativeFile(root, directory.targetPath), { recursive: true });
      for (const operation of plan.finalOverrides) {
        const stat = await safeStat(raw, operation.archivePath, this.reparseInspector, signal);
        const identity = this.inspections.get(inspectionId).identities.get(operation.archivePath);
        if (!sameFileIdentity(identity, fileIdentityFromStat(stat))) throw failure('PLAN_STALE');
        const target = entries.get(canonicalWindowsPath(operation.targetPath))?.path || operation.targetPath;
        const measured = await copyRegularFile(relativeFile(raw, operation.archivePath), relativeFile(root, target), {
          candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal, replace: true,
          beforeCopy: ({ stat: copyStat }) => { if (!sameFileIdentity(identity, fileIdentityFromStat(copyStat))) throw failure('PLAN_STALE'); } });
        record(target, measured);
      }
      checkCancellation(signal);
      if (completedItems !== totalItems || processedBytes !== assemblyBytes) throw failure('PLAN_STALE');
      report({ activity: 'revalidating-client-files' });
      await revalidateEvidence(this, inspectionId, prior, signal);
      const ordered = [...entries.values()].sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
      return deepFreeze({ ownerId, outputId, path: root, runtime: inspected.runtime, manifest: { entries: ordered },
        ...(prior.format === 'multimc' ? { contentFormat: 'multimc', runtimeConstraints: inspected.runtimeConstraints } : {}),
        optionalFileIds: [...optionalFileIds], totalBytes: ordered.reduce((sum, item) => sum + BigInt(item.size), 0n).toString() });
    } catch (error) {
      // All extractor/download/copy operations are awaited before any candidate cleanup starts.
      if (ownerId && this.owners.has(ownerId)) await this.release(ownerId);
      if (signal?.aborted || error?.code === 'ABORT_ERR') throw failure('CANCELLED', error);
      if (error instanceof ModpackError) throw error;
      throw failure(error?.code === 'ENOSPC' ? 'INSUFFICIENT_DISK' : 'COMMIT_FAILED', error);
    } finally { if (locked) this.busy.delete(inspectionId); }
  }

  async release(ownerId) {
    if (!this.owners.has(ownerId)) throw failure();
    await this.workspaceRegistry.releaseOwner(ownerId);
    this.owners.delete(ownerId);
  }

  forgetInspection(inspectionId) {
    if (typeof inspectionId !== 'string' || !inspectionId.length) throw failure();
    if (this.busy.has(inspectionId)) throw failure('OPERATION_IN_PROGRESS');
    // The upstream inspection lifecycle owns all extracted raw files.
    return this.inspections.delete(inspectionId);
  }

  async dispose() {
    if (this.ownsHashService) { await this.candidateHashService.dispose(); this.ownsHashService = false; }
  }
}

module.exports = { ClientCandidatePreparer };
