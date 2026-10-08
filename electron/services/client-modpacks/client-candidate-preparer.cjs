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

const failure = (code = 'INVALID_REQUEST', cause) => new ModpackError(code,
  code === 'PLAN_STALE' ? 'The client pack inspection changed' : 'The client pack preparation could not be completed', { cause });
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
async function readIndex(root, indexPath, reparseInspector, signal) {
  const before = await safeStat(root, indexPath, reparseInspector, signal);
  if (before.size > BigInt(MRPACK_MANIFEST_MAX_BYTES)) throw failure('MANIFEST_INVALID');
  const handle = await fs.open(relativeFile(root, indexPath), 'r');
  try {
    if (!sameFileIdentity(fileIdentityFromStat(before), fileIdentityFromStat(await handle.stat({ bigint: true })))) throw failure('PLAN_STALE');
    const buffer = Buffer.alloc(MRPACK_MANIFEST_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      checkCancellation(signal);
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MRPACK_MANIFEST_MAX_BYTES || BigInt(length) !== before.size) throw failure('MANIFEST_INVALID');
    const after = await safeStat(root, indexPath, reparseInspector, signal);
    if (!sameFileIdentity(fileIdentityFromStat(before), fileIdentityFromStat(after))) throw failure('PLAN_STALE');
    const bytes = buffer.subarray(0, length);
    return { manifest: parseMrpackManifest(bytes), digest: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
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
        const root = this.workspaceRegistry.resolveOwnedWorkspace({ ownerId: inspectionId, id: prior.value.outputId, kind: 'output' }).path;
        const current = await readIndex(root, prior.indexPath, this.reparseInspector, signal);
        if (current.digest !== prior.digest || loaded.result.artifactSet.fingerprint !== prior.fingerprint) throw failure('PLAN_STALE');
        return prior.value;
      }
      const entries = loaded.result?.entries;
      if (!['mrpack', 'zip'].includes(loaded.result?.archiveFamily) || !Array.isArray(entries)) throw failure('UNSUPPORTED_ARCHIVE');
      const indexes = entries.filter(entry => typeof entry.entryName === 'string' &&
        entry.entryName.replaceAll('\\', '/').split('/').at(-1).toLowerCase() === 'modrinth.index.json');
      if (indexes.length !== 1 || indexes[0].type !== 'file' || indexes[0].entryName.includes('/') || indexes[0].entryName.includes('\\')) throw failure('PACK_ROOT_AMBIGUOUS');
      const indexPath = indexes[0].entryName;
      const outputId = this.workspaceRegistry.createStagingOutput({ ownerId: inspectionId });
      report({ activity: 'extracting' });
      await this.archiveExtractor.extractArchive({ inspectionId, destinationId: outputId, signal,
        onProgress: progress => { if (progress?.phase === 'postwalk') report({ activity: 'verifying-archive' }); } });
      checkCancellation(signal);
      report({ activity: 'verifying-archive' });
      const root = this.workspaceRegistry.resolveOwnedWorkspace({ ownerId: inspectionId, id: outputId, kind: 'output' }).path;
      const { manifest, digest } = await readIndex(root, indexPath, this.reparseInspector, signal);
      const archiveEntries = entries.map(entry => ({ path: entry.entryName, type: entry.type, size: Number(entry.size) }));
      const plan = buildMrpackClientPlan({ manifest, archiveEntries });
      let runtime;
      try { runtime = normalizeRuntimeTuple({ ...plan.runtime, javaMajor: getRequiredJavaVersion(plan.runtime.minecraftVersion), os: 'win32', architecture: 'x64' }); }
      catch (cause) { throw failure('RUNTIME_INCOMPLETE', cause); }
      const identities = new Map();
      for (const operation of plan.finalOverrides) {
        const stat = await safeStat(root, operation.archivePath, this.reparseInspector, signal);
        if (stat.size.toString() !== operation.size) throw failure('PLAN_STALE');
        identities.set(operation.archivePath, fileIdentityFromStat(stat));
      }
      const value = deepFreeze({ inspectionId, outputId, runtime, name: manifest.name, version: manifest.versionId,
        optionalFiles: listOptionalClientFileChoices(manifest),
        downloadBytes: plan.downloads.reduce((total, item) => total + (item.selected ? BigInt(item.size) : 0n), 0n).toString(),
        manifest, archiveEntries });
      // Extraction must use upstream ownership. Its raw output is reclaimed by that inspection's lifecycle.
      this.inspections.set(inspectionId, { value, digest, indexPath, identities, fingerprint: loaded.result.artifactSet.fingerprint });
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
      const plan = buildMrpackClientPlan({ manifest: inspected.manifest,
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
      const ordered = [...entries.values()].sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
      return deepFreeze({ ownerId, outputId, path: root, runtime: inspected.runtime, manifest: { entries: ordered },
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
