const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  createVerifiedZip,
  enumerateArchiveScopeCooperatively,
  verifyZipScopeStreaming
} = require('../../utils/backup-util.cjs');
const { MAX_FLUSH_DIRECTORIES, strictJsonClone } = require('../../utils/durable-fs.cjs');
const { withBackupMutationLock } = require('../backup-mutation-lock.cjs');
const { ModpackError } = require('../modpacks/errors.cjs');
const {
  RESTORE_CREATION_KIND,
  RESTORE_CREATION_SCHEMA_VERSION,
  identityFromStat,
  normalizeRestoreCreation,
  sameIdentity
} = require('./restore-creation-intent.cjs');

const METADATA_SCHEMA_VERSION = 1;
const METADATA_KIND = 'minecraft-core-lifecycle-restore-point';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESTORE_NAME_PATTERN = /^restore-point-[A-Za-z0-9._-]{1,180}\.zip$/;
const METADATA_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'id', 'name', 'sha256', 'size', 'scopeSha256', 'scope', 'sourceRevision',
  'sourceRuntime', 'operationId', 'createdAt', 'pins'
]);
const REFERENCE_KEYS = new Set([
  'id', 'name', 'sha256', 'size', 'totalBytes', 'scopeSha256', 'sourceRevision', 'sourceRuntime', 'operationId', 'createdAt',
  'serverPath', 'archivePath', 'metadataPath', 'pinId'
]);

function backupFailure(cause) {
  if (cause instanceof ModpackError && ['BACKUP_FAILED', 'TARGET_EXISTS', 'CANCELLED'].includes(cause.code)) return cause;
  return new ModpackError('BACKUP_FAILED', 'The lifecycle restore point operation failed', { cause });
}

function cancelled() {
  return new ModpackError('CANCELLED', 'The modpack operation was cancelled');
}

function normalizeSignal(signal) {
  if (signal === null || signal === undefined) return null;
  if (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    throw backupFailure();
  }
  return signal;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelled();
}

function createBoundedProgressReporter(onProgress) {
  if (onProgress === null || onProgress === undefined) return () => {};
  if (typeof onProgress !== 'function') throw backupFailure();
  let lastPublishedAt = 0;
  return (value, { force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastPublishedAt < 250) return;
    lastPublishedAt = now;
    try {
      Promise.resolve(onProgress(Object.freeze(strictJsonClone(value, {
        maxDepth: 8, maxCollection: 128, maxStringBytes: 4096
      })))).catch(() => {});
    } catch { /* progress observers never decide restore-point correctness */ }
  };
}

function targetExists() {
  return new ModpackError('TARGET_EXISTS', 'The restore destination already exists');
}

function assertPlainDataObject(value, allowedKeys = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw backupFailure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || (allowedKeys && !allowedKeys.has(key))) throw backupFailure();
  }
  return descriptors;
}

function assertId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw backupFailure();
  return value;
}

function assertHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw backupFailure();
  return value;
}

function assertTotalBytes(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw backupFailure();
  try {
    if (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw backupFailure();
  } catch (error) {
    throw backupFailure(error);
  }
  return value;
}

function sameLocalPath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function hasRawTraversal(value) {
  return value.split(/[\\/]/u).some(segment => segment === '.' || segment === '..');
}

function strictTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) throw backupFailure();
  return value;
}

function publicScopeDigest(scope) {
  return crypto.createHash('sha256').update(JSON.stringify(scope.entries), 'utf8').digest('hex');
}

function normalizeScope(scope) {
  const clone = strictJsonClone(scope, { maxDepth: 8, maxCollection: 200_000, maxStringBytes: 4096 });
  assertPlainDataObject(clone, new Set(['schemaVersion', 'entries', 'totalBytes', 'fileCount', 'scopeSha256']));
  if (clone.schemaVersion !== 1 || !Array.isArray(clone.entries) ||
      !Number.isSafeInteger(clone.totalBytes) || clone.totalBytes < 0 ||
      !Number.isSafeInteger(clone.fileCount) || clone.fileCount < 0) throw backupFailure();
  const names = new Set();
  let totalBytes = 0;
  let fileCount = 0;
  for (const entry of clone.entries) {
    assertPlainDataObject(entry, new Set(['path', 'type', 'size', 'sha256']));
    if (typeof entry.path !== 'string' || !['file', 'directory'].includes(entry.type) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || names.has(entry.path) ||
        entry.path.includes('\0') || entry.path.startsWith('/') || entry.path.includes('\\') ||
        entry.path.split('/').filter(Boolean).some(segment => segment === '.' || segment === '..')) throw backupFailure();
    if (entry.type === 'directory') {
      if (!entry.path.endsWith('/') || entry.size !== 0 || entry.sha256 !== null) throw backupFailure();
    } else {
      if (entry.path.endsWith('/') || typeof entry.sha256 !== 'string' || !HASH_PATTERN.test(entry.sha256)) throw backupFailure();
      totalBytes += entry.size;
      fileCount += 1;
    }
    names.add(entry.path);
  }
  if (totalBytes !== clone.totalBytes || fileCount !== clone.fileCount ||
      assertHash(clone.scopeSha256) !== publicScopeDigest(clone)) throw backupFailure();
  return clone;
}

function normalizeMetadata(value) {
  const clone = strictJsonClone(value, { maxDepth: 16, maxCollection: 250_000, maxStringBytes: 64 * 1024 });
  assertPlainDataObject(clone, new Set(METADATA_KEYS));
  if (Object.keys(clone).length !== METADATA_KEYS.length || clone.schemaVersion !== METADATA_SCHEMA_VERSION ||
      clone.kind !== METADATA_KIND || typeof clone.name !== 'string' || !RESTORE_NAME_PATTERN.test(clone.name) ||
      !Number.isSafeInteger(clone.size) || clone.size < 1 ||
      !Number.isSafeInteger(clone.sourceRevision) || clone.sourceRevision < 0 || !Array.isArray(clone.pins)) throw backupFailure();
  const scope = normalizeScope(clone.scope);
  if (assertHash(clone.scopeSha256) !== scope.scopeSha256) throw backupFailure();
  const pins = clone.pins.map(assertId);
  if (new Set(pins).size !== pins.length) throw backupFailure();
  const sourceRuntime = clone.sourceRuntime === null
    ? null
    : strictJsonClone(clone.sourceRuntime, { maxDepth: 16, maxCollection: 4096, maxStringBytes: 64 * 1024 });
  if (sourceRuntime !== null) assertPlainDataObject(sourceRuntime);
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    kind: METADATA_KIND,
    id: assertId(clone.id),
    name: clone.name,
    sha256: assertHash(clone.sha256),
    size: clone.size,
    scopeSha256: clone.scopeSha256,
    scope,
    sourceRevision: clone.sourceRevision,
    sourceRuntime,
    operationId: assertId(clone.operationId),
    createdAt: strictTimestamp(clone.createdAt),
    pins
  };
}

function metadataBytes(metadata) {
  return Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

function metadataDigest(metadata) {
  return crypto.createHash('sha256').update(metadataBytes(metadata)).digest('hex');
}

async function flushDirectoryBatch(durableFs, directoryPaths, signal = null) {
  throwIfCancelled(signal);
  const seen = new Set();
  const unique = [];
  for (const directoryPath of directoryPaths) {
    const resolved = path.resolve(directoryPath);
    const key = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(resolved);
  }
  if (typeof durableFs.flushDirectoriesAsync === 'function') {
    for (let offset = 0; offset < unique.length; offset += MAX_FLUSH_DIRECTORIES) {
      throwIfCancelled(signal);
      await durableFs.flushDirectoriesAsync(unique.slice(offset, offset + MAX_FLUSH_DIRECTORIES));
      throwIfCancelled(signal);
    }
    return;
  }
  if (typeof durableFs.flushDirectoryAsync !== 'function') throw backupFailure();
  for (const directoryPath of unique) {
    throwIfCancelled(signal);
    await durableFs.flushDirectoryAsync(directoryPath);
    throwIfCancelled(signal);
  }
}

class RestorePointService {
  constructor({
    fsApi = fs,
    durableFs,
    clock = () => new Date(),
    randomUUID = crypto.randomUUID,
    createVerifiedZipFn = createVerifiedZip,
    extractVerifiedArchiveFn,
    zipStreamVerifier = verifyZipScopeStreaming,
    faultInjector = () => {}
  } = {}) {
    if (!fsApi || typeof fsApi !== 'object' || !durableFs ||
        typeof durableFs.readFileBounded !== 'function' || typeof durableFs.writeJsonAtomicAsync !== 'function' ||
        typeof durableFs.renameDurableAsync !== 'function' || typeof durableFs.flushDirectoryAsync !== 'function' ||
        typeof durableFs.sha256File !== 'function' || typeof clock !== 'function' || typeof randomUUID !== 'function' ||
        typeof createVerifiedZipFn !== 'function' || typeof extractVerifiedArchiveFn !== 'function' ||
        typeof zipStreamVerifier !== 'function' || typeof faultInjector !== 'function') {
      throw backupFailure();
    }
    this.fs = fsApi;
    this.durableFs = durableFs;
    this.clock = clock;
    this.randomUUID = randomUUID;
    this.createVerifiedZip = createVerifiedZipFn;
    this.extractVerifiedArchive = extractVerifiedArchiveFn;
    this.zipStreamVerifier = zipStreamVerifier;
    this.faultInjector = faultInjector;
  }

  async prepareVerifiedRestorePointCreation(request, options = null) {
    const normalized = this.#normalizeCreationRequest(request);
    const operation = this.#normalizeOperationOptions(options, { creation: false });
    throwIfCancelled(operation.signal);
    return withBackupMutationLock(normalized.serverPath, () =>
      this.#prepareVerifiedRestorePointCreationLocked(normalized, operation));
  }

  async createVerifiedRestorePoint(request, options = null) {
    const normalized = this.#normalizeCreationRequest(request);
    let creationIntent = null;
    let onCreationState = null;
    let signal = null;
    let onProgress = null;
    try {
      if (options !== null) {
        assertPlainDataObject(options, new Set(['creationIntent', 'onCreationState', 'signal', 'onProgress']));
        if (!Object.hasOwn(options, 'creationIntent') || !Object.hasOwn(options, 'onCreationState') ||
            typeof options.onCreationState !== 'function' ||
            (options.onProgress !== undefined && typeof options.onProgress !== 'function')) throw backupFailure();
        creationIntent = normalizeRestoreCreation(options.creationIntent, normalized.operationId);
        if (creationIntent === null || creationIntent.state !== 'prepared' ||
            creationIntent.sourceRevision !== normalized.sourceRevision) throw backupFailure();
        onCreationState = options.onCreationState;
        signal = normalizeSignal(options.signal);
        onProgress = options.onProgress || null;
      }
    } catch (error) {
      throw backupFailure(error);
    }
    throwIfCancelled(signal);
    const operation = { signal, reportProgress: createBoundedProgressReporter(onProgress) };
    return withBackupMutationLock(normalized.serverPath, async () => {
      const intent = creationIntent || await this.#prepareVerifiedRestorePointCreationLocked(normalized, operation);
      return this.#createVerifiedRestorePointLocked(normalized, intent, onCreationState, operation);
    });
  }

  async #prepareVerifiedRestorePointCreationLocked(request, operation = { signal: null, reportProgress() {} }) {
    try {
      const { serverPath, operationId } = request;
      throwIfCancelled(operation.signal);
      const items = this.#serverItems(serverPath);
      operation.reportProgress({ phase: 'scope', processedBytes: 0, totalBytes: null }, { force: true });
      const expectedScope = await enumerateArchiveScopeCooperatively(items, {
        fsApi: this.fs,
        signal: operation.signal
      });
      throwIfCancelled(operation.signal);
      const createdAt = this.#now();
      const token = assertId(this.randomUUID());
      const timestamp = createdAt.replaceAll(':', '-');
      const name = `restore-point-${timestamp}-${token}.zip`;
      if (!RESTORE_NAME_PATTERN.test(name)) throw backupFailure();
      const backupDir = path.join(serverPath, 'backups');
      let backupDirectory;
      if (this.#exists(backupDir)) {
        const stat = this.#assertBackupDirectory(backupDir);
        backupDirectory = { existed: true, identity: identityFromStat(stat) };
        for (const candidate of this.#restoreCreationPaths(backupDir, name)) {
          if (this.#exists(candidate)) throw targetExists();
        }
      } else {
        backupDirectory = { existed: false, identity: null };
      }
      return Object.freeze(normalizeRestoreCreation({
        schemaVersion: RESTORE_CREATION_SCHEMA_VERSION,
        kind: RESTORE_CREATION_KIND,
        operationId,
        name,
        partName: `${name}.part`,
        createdAt,
        sourceRevision: request.sourceRevision,
        scopeSha256: expectedScope.scopeSha256,
        backupDirectory,
        partIdentity: null,
        archiveSha256: null,
        archiveSize: null,
        metadataSha256: null,
        metadataIdentity: null,
        state: 'prepared'
      }, operationId));
    } catch (error) {
      throw backupFailure(error);
    }
  }

  async #createVerifiedRestorePointLocked(request, creationIntent, onCreationState, operation) {
    let paths = null;
    let finalPublished = false;
    let intendedMetadata = null;
    let currentIntent = creationIntent;
    try {
      const { serverPath, operationId, sourceRuntime } = request;
      throwIfCancelled(operation.signal);
      let backupDir = path.join(serverPath, 'backups');
      if (currentIntent.backupDirectory.existed) {
        const backupStat = this.#assertBackupDirectory(backupDir);
        if (!sameIdentity(identityFromStat(backupStat), currentIntent.backupDirectory.identity)) throw backupFailure();
      } else if (currentIntent.backupDirectory.identity === null) {
        if (this.#exists(backupDir)) throw backupFailure();
        this.fs.mkdirSync(backupDir, { recursive: false, mode: 0o700 });
        await this.durableFs.flushDirectoryAsync(serverPath);
        const backupStat = this.#assertBackupDirectory(backupDir);
        const next = normalizeRestoreCreation({
          ...currentIntent,
          backupDirectory: { existed: false, identity: identityFromStat(backupStat) }
        }, operationId);
        if (onCreationState) await onCreationState(next);
        currentIntent = next;
      } else {
        const backupStat = this.#assertBackupDirectory(backupDir);
        if (!sameIdentity(identityFromStat(backupStat), currentIntent.backupDirectory.identity)) throw backupFailure();
      }
      const items = this.#serverItems(serverPath);
      const expectedScope = await enumerateArchiveScopeCooperatively(items, {
        fsApi: this.fs,
        signal: operation.signal
      });
      if (expectedScope.scopeSha256 !== currentIntent.scopeSha256) throw backupFailure();
      const createdAt = currentIntent.createdAt;
      const name = currentIntent.name;
      const namePrefix = `restore-point-${createdAt.replaceAll(':', '-')}-`;
      if (!name.startsWith(namePrefix)) throw backupFailure();
      const token = name.slice(namePrefix.length, -4);
      assertId(token);
      const archivePath = path.join(backupDir, name);
      const partPath = path.join(backupDir, currentIntent.partName);
      const metadataPath = archivePath.replace(/\.zip$/, '.json');
      const pendingPath = archivePath.replace(/\.zip$/, '.pending.json');
      paths = { archivePath, metadataPath, partPath, pendingPath };
      for (const candidate of Object.values(paths)) {
        if (this.#exists(candidate)) throw targetExists();
      }
      const verified = await this.createVerifiedZip({
        items,
        partPath,
        expectedScope,
        fsApi: this.fs,
        signal: operation.signal,
        onProgress: progress => operation.reportProgress(progress),
        onPartCreated: async partIdentity => {
          const next = normalizeRestoreCreation({ ...currentIntent, partIdentity, state: 'writing' }, operationId);
          if (onCreationState) await onCreationState(next);
          currentIntent = next;
        },
        faultInjector: this.faultInjector
      });
      throwIfCancelled(operation.signal);
      const postArchiveScope = await enumerateArchiveScopeCooperatively(this.#serverItems(serverPath), {
        fsApi: this.fs,
        signal: operation.signal
      });
      if (JSON.stringify(postArchiveScope) !== JSON.stringify(expectedScope)) throw backupFailure();
      const metadata = normalizeMetadata({
        schemaVersion: METADATA_SCHEMA_VERSION,
        kind: METADATA_KIND,
        id: `restore-${token}`,
        name,
        sha256: verified.sha256,
        size: verified.size,
        scopeSha256: verified.scopeSha256,
        scope: verified.scope,
        sourceRevision: request.sourceRevision,
        sourceRuntime,
        operationId,
        createdAt,
        pins: [operationId]
      });
      intendedMetadata = metadata;
      const verifiedIntent = normalizeRestoreCreation({
        ...currentIntent,
        archiveSha256: verified.sha256,
        archiveSize: verified.size,
        metadataSha256: metadataDigest(metadata),
        state: 'verified'
      }, operationId);
      if (onCreationState) await onCreationState(verifiedIntent);
      currentIntent = verifiedIntent;
      await this.#writeIdentityGatedFile(pendingPath, metadataBytes(metadata), async metadataIdentity => {
        const next = normalizeRestoreCreation({
          ...currentIntent,
          metadataIdentity,
          state: 'metadata-writing'
        }, operationId);
        if (onCreationState) await onCreationState(next);
        currentIntent = next;
      }, operation.signal);
      const metadataStaged = normalizeRestoreCreation({ ...currentIntent, state: 'metadata-staged' }, operationId);
      if (onCreationState) await onCreationState(metadataStaged);
      currentIntent = metadataStaged;
      await this.faultInjector('before-final-rename');
      throwIfCancelled(operation.signal);
      await this.durableFs.renameDurableAsync(partPath, archivePath, { expectedSourceSha256: verified.sha256 });
      finalPublished = true;
      const archivePublished = normalizeRestoreCreation({ ...currentIntent, state: 'archive-published' }, operationId);
      if (onCreationState) await onCreationState(archivePublished);
      currentIntent = archivePublished;
      await this.faultInjector('after-final-rename');
      await this.faultInjector('before-pin-persistence');
      await this.durableFs.renameDurableAsync(pendingPath, metadataPath, { expectedSourceSha256: metadataDigest(metadata) });
      const published = normalizeRestoreCreation({ ...currentIntent, state: 'published' }, operationId);
      if (onCreationState) await onCreationState(published);
      currentIntent = published;
      const reference = this.#reference(serverPath, metadata);
      await this.#verifyRestorePointLocked(reference, { recoverPending: false, operation });
      return reference;
    } catch (error) {
      if (paths && finalPublished && intendedMetadata && this.#exists(paths.metadataPath) && !this.#exists(paths.pendingPath)) {
        try {
          const loaded = this.#readMetadata(paths.metadataPath);
          if (loaded.sha256 !== metadataDigest(intendedMetadata) ||
              JSON.stringify(loaded.metadata) !== JSON.stringify(intendedMetadata)) throw backupFailure();
          await this.#verifyArchive(paths.archivePath, loaded.metadata);
          const reference = this.#reference(request.serverPath, loaded.metadata);
          await this.#verifyRestorePointLocked(reference, { recoverPending: false });
          return reference;
        } catch { /* retain the publication uncertainty as a diagnostic failure */ }
      }
      if (paths && !finalPublished && !this.#exists(paths.archivePath)) {
        const removedPart = this.#removeOwnedFile(paths.partPath, currentIntent.partIdentity);
        const removedMetadata = this.#removeOwnedFile(paths.pendingPath, currentIntent.metadataIdentity);
        if (removedPart || removedMetadata) {
          try { await this.durableFs.flushDirectoryAsync(path.dirname(paths.partPath)); }
          catch { /* retain the primary creation failure */ }
        }
      }
      throw backupFailure(error);
    }
  }

  async cleanupInterruptedRestorePointCreation(request) {
    let normalized;
    try {
      assertPlainDataObject(request, new Set(['serverPath', 'operationId', 'creationIntent']));
      if (Object.keys(request).length !== 3) throw backupFailure();
      const serverPath = this.#assertServer(request.serverPath);
      const operationId = assertId(request.operationId);
      const creationIntent = normalizeRestoreCreation(request.creationIntent, operationId);
      normalized = { serverPath, operationId, creationIntent };
    } catch (error) {
      throw backupFailure(error);
    }
    if (normalized.creationIntent === null) return { cleaned: 0, diagnostics: [] };
    return withBackupMutationLock(normalized.serverPath, () => this.#cleanupInterruptedRestorePointCreationLocked(normalized));
  }

  async #cleanupInterruptedRestorePointCreationLocked({ serverPath, creationIntent }) {
    const backupDir = path.join(serverPath, 'backups');
    const diagnostics = [];
    const removals = [];
    const expectedDirectoryIdentity = creationIntent.backupDirectory.identity;
    if (!this.#exists(backupDir)) return { cleaned: 0, diagnostics: [] };

    let backupStat;
    try {
      backupStat = this.#assertBackupDirectory(backupDir);
      if (expectedDirectoryIdentity !== null &&
          !sameIdentity(identityFromStat(backupStat), expectedDirectoryIdentity)) throw backupFailure();
    } catch {
      return { cleaned: 0, diagnostics: [{ name: 'backups', reason: 'identity-mismatch' }] };
    }

    const archivePath = path.join(backupDir, creationIntent.name);
    const partPath = path.join(backupDir, creationIntent.partName);
    const metadataPath = archivePath.replace(/\.zip$/u, '.json');
    const pendingPath = archivePath.replace(/\.zip$/u, '.pending.json');
    const fileStat = candidate => {
      if (!this.#exists(candidate)) return null;
      const stat = this.fs.lstatSync(candidate, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw backupFailure();
      return stat;
    };
    const validateStableFile = (candidate, expectedIdentity, expectedSha256 = null) => {
      const stat = fileStat(candidate);
      if (!stat || !sameIdentity(identityFromStat(stat), expectedIdentity)) throw backupFailure();
      if (expectedSha256 !== null && this.durableFs.sha256File(candidate) !== expectedSha256) throw backupFailure();
      return stat;
    };
    const schedule = (candidate, kind, expectedIdentity = null, expectedSha256 = null) => {
      removals.push({ candidate, kind, expectedIdentity, expectedSha256 });
    };

    try {
      const partStat = fileStat(partPath);
      const archiveStat = fileStat(archivePath);
      if (partStat && archiveStat) throw backupFailure();
      if (creationIntent.state === 'prepared') {
        if (archiveStat || (partStat && partStat.size !== 0n)) throw backupFailure();
        if (partStat) schedule(partPath, 'empty-part');
      } else {
        const ownedPath = partStat ? partPath : (archiveStat ? archivePath : null);
        if (ownedPath) {
          validateStableFile(ownedPath, creationIntent.partIdentity,
            creationIntent.state === 'writing' ? null : creationIntent.archiveSha256);
          schedule(ownedPath, 'archive', creationIntent.partIdentity,
            creationIntent.state === 'writing' ? null : creationIntent.archiveSha256);
        }
      }

      const pendingStat = fileStat(pendingPath);
      const metadataStat = fileStat(metadataPath);
      if (pendingStat && metadataStat) throw backupFailure();
      const metadataClaimed = [
        'metadata-writing', 'metadata-staged', 'archive-published', 'published'
      ].includes(creationIntent.state);
      if (!metadataClaimed) {
        if (creationIntent.state === 'verified' && pendingStat && !metadataStat && pendingStat.size === 0n) {
          schedule(pendingPath, 'empty-metadata');
        } else if (pendingStat || metadataStat) {
          throw backupFailure();
        }
      } else {
        const ownedMetadata = pendingStat ? pendingPath : (metadataStat ? metadataPath : null);
        if (ownedMetadata) {
          const requireCompleteHash = creationIntent.state !== 'metadata-writing';
          validateStableFile(ownedMetadata, creationIntent.metadataIdentity,
            requireCompleteHash ? creationIntent.metadataSha256 : null);
          schedule(ownedMetadata, 'metadata', creationIntent.metadataIdentity,
            requireCompleteHash ? creationIntent.metadataSha256 : null);
        }
      }
    } catch {
      diagnostics.push({ name: creationIntent.name, reason: 'owned-artifact-mismatch' });
    }
    if (diagnostics.length > 0) return { cleaned: 0, diagnostics };

    const metadataRemoval = value => ['metadata', 'empty-metadata'].includes(value.kind);
    removals.sort((left, right) => (metadataRemoval(left) ? -1 : 1) - (metadataRemoval(right) ? -1 : 1));
    let cleaned = 0;
    try {
      for (const removal of removals) {
        if (['empty-part', 'empty-metadata'].includes(removal.kind)) {
          const stat = fileStat(removal.candidate);
          if (!stat || stat.size !== 0n) throw backupFailure();
        } else if (removal.kind === 'metadata') {
          validateStableFile(removal.candidate, removal.expectedIdentity, removal.expectedSha256);
        } else {
          validateStableFile(removal.candidate, removal.expectedIdentity, removal.expectedSha256);
        }
        this.fs.rmSync(removal.candidate, { force: false });
        await this.durableFs.flushDirectoryAsync(backupDir);
        cleaned += 1;
      }
      const pinnedAfter = this.#assertBackupDirectory(backupDir);
      if (expectedDirectoryIdentity !== null &&
          !sameIdentity(identityFromStat(pinnedAfter), expectedDirectoryIdentity)) throw backupFailure();
      if (!creationIntent.backupDirectory.existed && this.fs.readdirSync(backupDir).length === 0) {
        if ((expectedDirectoryIdentity === null && creationIntent.state !== 'prepared') ||
            (expectedDirectoryIdentity !== null && !sameIdentity(identityFromStat(pinnedAfter), expectedDirectoryIdentity))) {
          throw backupFailure();
        }
        this.fs.rmdirSync(backupDir);
        await this.durableFs.flushDirectoryAsync(serverPath);
      }
      return { cleaned, diagnostics: [] };
    } catch {
      return { cleaned, diagnostics: [{ name: creationIntent.name, reason: 'cleanup-failed' }] };
    }
  }

  async recoverPendingRestorePoints(serverPathValue) {
    const serverPath = this.#assertServer(serverPathValue);
    return withBackupMutationLock(serverPath, () => this.#recoverPendingRestorePointsLocked(serverPath, { discoverFinal: true }));
  }

  async #recoverPendingRestorePointsLocked(serverPath, { discoverFinal = false } = {}) {
    const backupDir = await this.#ensureBackupDirectory(serverPath);
    const recovered = [];
    const diagnostics = [];
    for (const name of this.fs.readdirSync(backupDir).filter(candidate => candidate.endsWith('.pending.json')).sort()) {
      const pendingPath = path.join(backupDir, name);
      let pending = null;
      try {
        pending = this.#readMetadata(pendingPath);
        const archivePath = path.join(backupDir, pending.metadata.name);
        const metadataPath = archivePath.replace(/\.zip$/, '.json');
        if (name !== pending.metadata.name.replace(/\.zip$/, '.pending.json') || !this.#exists(archivePath) || this.#exists(metadataPath)) {
          throw backupFailure();
        }
        await this.#verifyArchive(archivePath, pending.metadata);
        await this.durableFs.renameDurableAsync(pendingPath, metadataPath, { expectedSourceSha256: pending.sha256 });
        recovered.push(Object.freeze({ id: pending.metadata.id, name: pending.metadata.name }));
      } catch {
        let reconciled = false;
        if (pending && !this.#exists(pendingPath)) {
          try {
            const archivePath = path.join(backupDir, pending.metadata.name);
            const metadataPath = archivePath.replace(/\.zip$/, '.json');
            const final = this.#readMetadata(metadataPath);
            if (final.sha256 !== pending.sha256 || JSON.stringify(final.metadata) !== JSON.stringify(pending.metadata)) throw backupFailure();
            await this.#verifyArchive(archivePath, final.metadata);
            recovered.push(Object.freeze({ id: final.metadata.id, name: final.metadata.name }));
            reconciled = true;
          } catch { /* retain a single diagnostic below */ }
        }
        if (!reconciled) diagnostics.push(Object.freeze({ name }));
      }
    }
    const discovered = [];
    if (discoverFinal) {
      const recoveredNames = new Set(recovered.map(item => item.name));
      for (const name of this.fs.readdirSync(backupDir)
        .filter(candidate => RESTORE_NAME_PATTERN.test(candidate.replace(/\.json$/, '.zip')) && candidate.endsWith('.json') && !candidate.endsWith('.pending.json'))
        .sort()) {
        try {
          const metadataPath = path.join(backupDir, name);
          const loaded = this.#readMetadata(metadataPath);
          const archivePath = path.join(backupDir, loaded.metadata.name);
          if (name !== loaded.metadata.name.replace(/\.zip$/, '.json') || !this.#exists(archivePath)) throw backupFailure();
          if (!recoveredNames.has(loaded.metadata.name)) {
            await this.#verifyArchive(archivePath, loaded.metadata);
            discovered.push(Object.freeze({ id: loaded.metadata.id, name: loaded.metadata.name, operationId: loaded.metadata.operationId }));
          }
        } catch {
          diagnostics.push(Object.freeze({ name }));
        }
      }
    }
    return Object.freeze({
      recovered: Object.freeze(recovered),
      discovered: Object.freeze(discovered),
      diagnostics: Object.freeze(diagnostics)
    });
  }

  async verifyRestorePoint(reference, options = null) {
    const normalized = this.#normalizeReference(reference);
    const operation = this.#normalizeOperationOptions(options, { creation: false });
    throwIfCancelled(operation.signal);
    return withBackupMutationLock(normalized.serverPath, () =>
      this.#verifyRestorePointLocked(normalized, { operation }));
  }

  async resolveRestorePoint(request, options = null) {
    let normalized;
    let operation;
    try {
      assertPlainDataObject(request, new Set(['serverPath', 'id', 'sha256']));
      if (Object.keys(request).length !== 3) throw backupFailure();
      normalized = {
        serverPath: this.#assertServer(request.serverPath),
        id: assertId(request.id),
        sha256: assertHash(request.sha256)
      };
      operation = this.#normalizeOperationOptions(options, { creation: false });
    } catch (error) {
      throw backupFailure(error);
    }
    return withBackupMutationLock(normalized.serverPath, async () => {
      await this.#recoverPendingRestorePointsLocked(normalized.serverPath);
      const backupDir = await this.#ensureBackupDirectory(normalized.serverPath);
      const matches = [];
      for (const name of this.fs.readdirSync(backupDir)
        .filter(candidate => candidate.endsWith('.json') && !candidate.endsWith('.pending.json'))
        .sort((left, right) => left.localeCompare(right, 'en-US'))) {
        try {
          const metadataPath = path.join(backupDir, name);
          const loaded = this.#readMetadata(metadataPath);
          if (name !== loaded.metadata.name.replace(/\.zip$/u, '.json') ||
              loaded.metadata.id !== normalized.id || loaded.metadata.sha256 !== normalized.sha256) continue;
          matches.push(this.#reference(normalized.serverPath, loaded.metadata));
        } catch {
          // Unrelated invalid metadata is not authority for the requested exact restore point.
        }
      }
      if (matches.length !== 1) throw backupFailure();
      await this.#verifyRestorePointLocked(matches[0], { recoverPending: false, operation });
      return matches[0];
    });
  }

  async listAvailableRestorePoints(request) {
    let normalized;
    try {
      assertPlainDataObject(request, new Set(['serverPath', 'history']));
      if (Object.keys(request).length !== 2 || !Array.isArray(request.history) || request.history.length > 200) {
        throw backupFailure();
      }
      const history = strictJsonClone(request.history, {
        maxDepth: 16,
        maxCollection: 20_000,
        maxStringBytes: 64 * 1024
      });
      normalized = { serverPath: this.#assertServer(request.serverPath), history };
    } catch (error) {
      throw backupFailure(error);
    }
    return withBackupMutationLock(normalized.serverPath, () => {
      const backupDir = path.join(normalized.serverPath, 'backups');
      if (!this.#exists(backupDir)) return Object.freeze([]);
      this.#assertBackupDirectory(backupDir);
      const published = [];
      for (const name of this.fs.readdirSync(backupDir)
        .filter(candidate => candidate.endsWith('.json') && !candidate.endsWith('.pending.json'))
        .sort((left, right) => left.localeCompare(right, 'en-US'))) {
        try {
          const metadataPath = path.join(backupDir, name);
          const metadataStat = this.fs.lstatSync(metadataPath, { bigint: true });
          if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || BigInt(metadataStat.nlink) !== 1n ||
              !sameLocalPath(this.fs.realpathSync.native(metadataPath), metadataPath)) continue;
          const loaded = this.#readMetadata(metadataPath).metadata;
          if (name !== loaded.name.replace(/\.zip$/u, '.json')) continue;
          const archivePath = path.join(backupDir, loaded.name);
          const archiveStat = this.fs.lstatSync(archivePath, { bigint: true });
          if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || BigInt(archiveStat.nlink) !== 1n ||
              archiveStat.size !== BigInt(loaded.size) ||
              !sameLocalPath(this.fs.realpathSync.native(archivePath), archivePath)) continue;
          published.push(loaded);
        } catch {
          // Corrupt or unrelated backup metadata cannot authorize a rollback option.
        }
      }

      const options = [];
      const seen = new Set();
      for (const entry of normalized.history) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
            entry.outcome !== 'completed' || typeof entry.restorePointId !== 'string' ||
            typeof entry.restorePointSha256 !== 'string' || !entry.sourceRuntime) continue;
        const matches = published.filter(metadata => metadata.id === entry.restorePointId &&
          metadata.sha256 === entry.restorePointSha256 && metadata.operationId === entry.operationId &&
          metadata.sourceRevision === entry.sourceRevision &&
          JSON.stringify(metadata.sourceRuntime) === JSON.stringify(entry.sourceRuntime) &&
          (entry.restorePointTotalBytes === undefined ||
            String(metadata.scope.totalBytes) === entry.restorePointTotalBytes));
        if (matches.length !== 1 || seen.has(entry.restorePointId)) continue;
        seen.add(entry.restorePointId);
        const metadata = matches[0];
        options.push(Object.freeze({
          restorePointId: metadata.id,
          operationKind: assertId(entry.kind),
          createdAt: metadata.createdAt,
          sourceRevision: metadata.sourceRevision,
          runtime: Object.freeze(strictJsonClone(metadata.sourceRuntime)),
          totalBytes: String(metadata.scope.totalBytes)
        }));
      }
      return Object.freeze(options);
    });
  }

  async #verifyRestorePointLocked(normalized, {
    recoverPending = true,
    operation = { signal: null, reportProgress() {} }
  } = {}) {
    throwIfCancelled(operation.signal);
    if (recoverPending) await this.#recoverPendingRestorePointsLocked(normalized.serverPath);
    const loaded = this.#readMetadata(normalized.metadataPath);
    this.#assertReferenceMatches(normalized, loaded.metadata);
    const evidence = await this.#verifyArchive(normalized.archivePath, loaded.metadata, operation);
    return Object.freeze({
      ok: true,
      id: loaded.metadata.id,
      sha256: evidence.sha256,
      size: evidence.size,
      totalBytes: String(loaded.metadata.scope.totalBytes),
      scopeSha256: loaded.metadata.scopeSha256
    });
  }

  async pinRestorePoint(reference) {
    const normalized = this.#normalizeReference(reference);
    return withBackupMutationLock(normalized.serverPath, () => this.#updatePinsLocked(normalized, true));
  }

  async unpinRestorePoint(reference) {
    const normalized = this.#normalizeReference(reference);
    return withBackupMutationLock(normalized.serverPath, () => this.#updatePinsLocked(normalized, false));
  }

  isRestorePointPinned(reference) {
    try {
      const normalized = this.#normalizeReference(reference);
      const candidate = this.#exists(normalized.metadataPath)
        ? normalized.metadataPath
        : normalized.archivePath.replace(/\.zip$/, '.pending.json');
      if (!this.#exists(candidate)) return false;
      return this.#readMetadata(candidate).metadata.pins.length > 0;
    } catch {
      return true;
    }
  }

  async restoreToFreshCandidate(reference, destinationValue, options = null) {
    const normalized = this.#normalizeReference(reference);
    const operation = this.#normalizeOperationOptions(options, { creation: false });
    throwIfCancelled(operation.signal);
    if (typeof destinationValue !== 'string' || !path.isAbsolute(destinationValue) || hasRawTraversal(destinationValue)) {
      throw backupFailure();
    }
    const destination = path.resolve(destinationValue);
    const expectedParent = path.dirname(normalized.serverPath);
    if (!sameLocalPath(path.dirname(destination), expectedParent) ||
        sameLocalPath(destination, normalized.serverPath)) throw backupFailure();
    return withBackupMutationLock(normalized.serverPath, () =>
      this.#restoreToFreshCandidateLocked(normalized, destination, expectedParent, operation));
  }

  async restoreToOwnedCandidate(reference, destinationValue, candidateRootValue, options = null) {
    const normalized = this.#normalizeReference(reference);
    const operation = this.#normalizeOperationOptions(options, { creation: false });
    throwIfCancelled(operation.signal);
    if (typeof destinationValue !== 'string' || !path.isAbsolute(destinationValue) || hasRawTraversal(destinationValue) ||
        typeof candidateRootValue !== 'string' || !path.isAbsolute(candidateRootValue) || hasRawTraversal(candidateRootValue)) {
      throw backupFailure();
    }
    const candidateRoot = path.resolve(candidateRootValue);
    const destination = path.resolve(destinationValue);
    const serverParent = path.dirname(normalized.serverPath);
    const candidateName = path.basename(candidateRoot);
    const prefix = `.${path.basename(normalized.serverPath)}.minecraft-core.`;
    const compactMatch = /^\.(op2-[0-9a-f]{32})\.c$/u.exec(candidateName);
    const operationId = compactMatch
      ? compactMatch[1]
      : candidateName.startsWith(prefix) && candidateName.endsWith('.candidate')
        ? candidateName.slice(prefix.length, -'.candidate'.length)
        : '';
    const operationWorkspace = path.join(candidateRoot, '.minecraft-core-state', 'operations', operationId);
    if (!sameLocalPath(path.dirname(candidateRoot), serverParent) || sameLocalPath(candidateRoot, normalized.serverPath) ||
        !ID_PATTERN.test(operationId) || !sameLocalPath(path.dirname(destination), operationWorkspace) ||
        sameLocalPath(destination, operationWorkspace)) throw backupFailure();
    let candidateStat;
    let workspaceStat;
    try {
      candidateStat = this.fs.lstatSync(candidateRoot, { bigint: true });
      workspaceStat = this.fs.lstatSync(operationWorkspace, { bigint: true });
    } catch (error) {
      throw backupFailure(error);
    }
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink() ||
        !sameLocalPath(this.fs.realpathSync.native(candidateRoot), candidateRoot) ||
        !workspaceStat.isDirectory() || workspaceStat.isSymbolicLink() ||
        !sameLocalPath(this.fs.realpathSync.native(operationWorkspace), operationWorkspace)) throw backupFailure();
    return withBackupMutationLock(normalized.serverPath, () =>
      this.#restoreToFreshCandidateLocked(normalized, destination, operationWorkspace, operation));
  }

  async #restoreToFreshCandidateLocked(normalized, destination, expectedParent, operation) {
    let lastProgressPhase = null;
    const reportProgress = (phase, value = {}, { force = false } = {}) => {
      const phaseChanged = phase !== lastProgressPhase;
      const bytesComplete = Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0 &&
        value.processedBytes === value.totalBytes;
      const itemsComplete = !Number.isSafeInteger(value.totalItems) || value.totalItems === 0 ||
        value.processedItems === value.totalItems;
      lastProgressPhase = phase;
      operation.reportProgress({
        phase,
        processedBytes: Number.isSafeInteger(value.processedBytes) ? value.processedBytes : 0,
        totalBytes: Number.isSafeInteger(value.totalBytes) ? value.totalBytes : 0,
        processedItems: Number.isSafeInteger(value.processedItems) ? value.processedItems : 0,
        totalItems: Number.isSafeInteger(value.totalItems) ? value.totalItems : 0
      }, { force: force || phaseChanged || (bytesComplete && itemsComplete) });
    };
    const verificationOperation = prefix => ({
      signal: operation.signal,
      reportProgress(value) {
        const suffix = value.phase === 'archive-hash' ? 'archive-hash' : 'entry-verification';
        reportProgress(`${prefix}-${suffix}`, value);
      }
    });
    throwIfCancelled(operation.signal);
    await this.#recoverPendingRestorePointsLocked(normalized.serverPath);
    const initialMetadata = this.#readMetadata(normalized.metadataPath);
    this.#assertReferenceMatches(normalized, initialMetadata.metadata);
    reportProgress('source-verification', {
      totalBytes: initialMetadata.metadata.scope.totalBytes,
      totalItems: initialMetadata.metadata.scope.fileCount
    }, { force: true });
    const initialArchive = await this.#verifyArchive(
      normalized.archivePath,
      initialMetadata.metadata,
      verificationOperation('source')
    );
    throwIfCancelled(operation.signal);
    if (this.#exists(destination)) throw targetExists();
    const parentStat = this.fs.lstatSync(expectedParent, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
        !sameLocalPath(this.fs.realpathSync.native(expectedParent), expectedParent)) throw backupFailure();
    const stagingToken = assertId(this.randomUUID());
    const stagingPath = path.join(expectedParent, `restore-staging-${stagingToken}`);
    if (this.#exists(stagingPath)) throw targetExists();
    let stagingIdentity = null;
    let destinationIdentity = null;
    try {
      const currentMetadata = this.#readMetadata(normalized.metadataPath);
      if (currentMetadata.sha256 !== initialMetadata.sha256) throw backupFailure();
      this.#assertReferenceMatches(normalized, currentMetadata.metadata);
      const currentArchive = await this.#verifyArchive(
        normalized.archivePath,
        currentMetadata.metadata,
        verificationOperation('source')
      );
      if (currentArchive.sha256 !== initialArchive.sha256 || currentArchive.size !== initialArchive.size) throw backupFailure();
      await this.extractVerifiedArchive(Object.freeze({
        archivePath: normalized.archivePath,
        stagingPath,
        expectedArchiveSha256: currentArchive.sha256,
        expectedArchiveSize: currentArchive.size,
        expectedArchiveIdentity: currentArchive.identity,
        expectedScope: Object.freeze(strictJsonClone(currentMetadata.metadata.scope)),
        operationId: currentMetadata.metadata.operationId,
        signal: operation.signal,
        onProgress: value => {
          if (value.phase !== 'complete') reportProgress(value.phase, value);
        }
      }));
      throwIfCancelled(operation.signal);
      const created = this.fs.lstatSync(stagingPath, { bigint: true });
      if (!created.isDirectory() || created.isSymbolicLink() ||
          !sameLocalPath(this.fs.realpathSync.native(stagingPath), stagingPath)) throw backupFailure();
      stagingIdentity = { dev: created.dev, ino: created.ino, birthtimeNs: created.birthtimeNs };
      const reconstructed = await enumerateArchiveScopeCooperatively(
        this.#serverItems(stagingPath, { excludeBackups: false }),
        { fsApi: this.fs, signal: operation.signal }
      );
      if (JSON.stringify(reconstructed) !== JSON.stringify(currentMetadata.metadata.scope)) throw backupFailure();
      const directories = [stagingPath, ...currentMetadata.metadata.scope.entries
        .filter(entry => entry.type === 'directory')
        .map(entry => path.resolve(stagingPath, ...entry.path.slice(0, -1).split('/')))]
        .sort((left, right) => right.length - left.length);
      await flushDirectoryBatch(this.durableFs, [...directories, expectedParent], operation.signal);
      const finalMetadata = this.#readMetadata(normalized.metadataPath);
      if (finalMetadata.sha256 !== initialMetadata.sha256) throw backupFailure();
      reportProgress('output-verification', {
        totalBytes: currentMetadata.metadata.scope.totalBytes,
        totalItems: currentMetadata.metadata.scope.fileCount
      }, { force: true });
      const finalArchive = await this.#verifyArchive(
        normalized.archivePath,
        finalMetadata.metadata,
        verificationOperation('final')
      );
      if (finalArchive.sha256 !== initialArchive.sha256 || finalArchive.size !== initialArchive.size) throw backupFailure();
      try {
        reportProgress('publication', {
          processedBytes: currentMetadata.metadata.scope.totalBytes,
          totalBytes: currentMetadata.metadata.scope.totalBytes,
          processedItems: currentMetadata.metadata.scope.fileCount,
          totalItems: currentMetadata.metadata.scope.fileCount
        }, { force: true });
        await this.durableFs.renameDurableAsync(stagingPath, destination);
      } catch (renameError) {
        if (!this.#exists(destination) || this.#exists(stagingPath) ||
            !this.#sameDirectoryIdentity(destination, stagingIdentity)) throw renameError;
      }
      const published = this.fs.lstatSync(destination, { bigint: true });
      if (!published.isDirectory() || published.isSymbolicLink() ||
          !sameLocalPath(this.fs.realpathSync.native(destination), destination) ||
          published.dev !== stagingIdentity.dev || published.ino !== stagingIdentity.ino ||
          published.birthtimeNs !== stagingIdentity.birthtimeNs) throw backupFailure();
      destinationIdentity = { dev: published.dev, ino: published.ino, birthtimeNs: published.birthtimeNs };
      await this.durableFs.flushDirectoryAsync(expectedParent);
      const publishedScope = await enumerateArchiveScopeCooperatively(
        this.#serverItems(destination, { excludeBackups: false }),
        { fsApi: this.fs, signal: operation.signal }
      );
      if (JSON.stringify(publishedScope) !== JSON.stringify(currentMetadata.metadata.scope)) throw backupFailure();
      reportProgress('complete', {
        processedBytes: publishedScope.totalBytes,
        totalBytes: publishedScope.totalBytes,
        processedItems: publishedScope.fileCount,
        totalItems: publishedScope.fileCount
      }, { force: true });
      return Object.freeze({ ok: true, destination, scopeSha256: publishedScope.scopeSha256 });
    } catch (error) {
      if (stagingIdentity && this.#sameDirectoryIdentity(stagingPath, stagingIdentity)) {
        try {
          this.fs.rmSync(stagingPath, { recursive: true, force: true });
          await this.durableFs.flushDirectoryAsync(expectedParent);
        } catch { /* retain original failure */ }
      }
      if (destinationIdentity && this.#sameDirectoryIdentity(destination, destinationIdentity)) {
        try {
          this.fs.rmSync(destination, { recursive: true, force: true });
          await this.durableFs.flushDirectoryAsync(expectedParent);
        } catch { /* retain original failure */ }
      }
      throw backupFailure(error);
    }
  }

  async #updatePinsLocked(normalized, shouldPin) {
    await this.#recoverPendingRestorePointsLocked(normalized.serverPath);
    const loaded = this.#readMetadata(normalized.metadataPath);
    this.#assertReferenceMatches(normalized, loaded.metadata);
    await this.#verifyArchive(normalized.archivePath, loaded.metadata);
    const pinId = assertId(normalized.pinId || normalized.operationId);
    const pins = new Set(loaded.metadata.pins);
    if (shouldPin) pins.add(pinId);
    else pins.delete(pinId);
    const next = normalizeMetadata({ ...loaded.metadata, pins: [...pins].sort() });
    if (JSON.stringify(next) !== JSON.stringify(loaded.metadata)) {
      await this.faultInjector('before-pin-cas-write');
      await this.durableFs.writeJsonAtomicAsync(normalized.metadataPath, next, { expectedTargetSha256: loaded.sha256 });
    }
    return Object.freeze({ pinned: next.pins.length > 0, pins: Object.freeze([...next.pins]) });
  }

  #normalizeCreationRequest(request) {
    try {
      assertPlainDataObject(request, new Set(['serverPath', 'operationId', 'sourceRevision', 'sourceRuntime']));
      if (Object.keys(request).length !== 4) throw backupFailure();
      const serverPath = this.#assertServer(request.serverPath);
      const operationId = assertId(request.operationId);
      if (!Number.isSafeInteger(request.sourceRevision) || request.sourceRevision < 0) throw backupFailure();
      const sourceRuntime = request.sourceRuntime === null
        ? null
        : strictJsonClone(request.sourceRuntime, { maxDepth: 16, maxCollection: 4096, maxStringBytes: 64 * 1024 });
      if (sourceRuntime !== null) assertPlainDataObject(sourceRuntime);
      return { serverPath, operationId, sourceRevision: request.sourceRevision, sourceRuntime };
    } catch (error) {
      throw backupFailure(error);
    }
  }

  #normalizeOperationOptions(options, { creation }) {
    try {
      if (options === null || options === undefined) {
        return { signal: null, reportProgress: createBoundedProgressReporter(null) };
      }
      assertPlainDataObject(options, new Set(['signal', 'onProgress']));
      if (creation === true) throw backupFailure();
      return {
        signal: normalizeSignal(options.signal),
        reportProgress: createBoundedProgressReporter(options.onProgress || null)
      };
    } catch (error) {
      throw backupFailure(error);
    }
  }

  async #writeIdentityGatedFile(filePath, bytes, onCreated, signal = null) {
    let handle = null;
    try {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || typeof onCreated !== 'function') throw backupFailure();
      signal = normalizeSignal(signal);
      throwIfCancelled(signal);
      const asyncFsApi = this.fs.promises || fs.promises;
      if (!asyncFsApi || typeof asyncFsApi.open !== 'function') throw backupFailure();
      handle = await asyncFsApi.open(filePath, 'wx', 0o600);
      if (!handle || typeof handle.stat !== 'function' || typeof handle.write !== 'function' ||
          typeof handle.sync !== 'function' || typeof handle.close !== 'function') throw backupFailure();
      const created = await handle.stat({ bigint: true });
      if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1n || created.size !== 0n) throw backupFailure();
      const identity = identityFromStat(created);
      await onCreated(identity);
      throwIfCancelled(signal);
      const pinned = await handle.stat({ bigint: true });
      const linked = this.fs.lstatSync(filePath, { bigint: true });
      if (!pinned.isFile() || pinned.isSymbolicLink() || pinned.nlink !== 1n || pinned.size !== 0n ||
          !linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1n || linked.size !== 0n ||
          !sameIdentity(identityFromStat(pinned), identity) || !sameIdentity(identityFromStat(linked), identity)) throw backupFailure();
      let offset = 0;
      while (offset < bytes.length) {
        throwIfCancelled(signal);
        const result = await handle.write(bytes, offset, bytes.length - offset, offset);
        const written = result?.bytesWritten;
        if (!Number.isSafeInteger(written) || written < 1) throw backupFailure();
        offset += written;
      }
      await handle.sync();
      const completed = await handle.stat({ bigint: true });
      if (!sameIdentity(identityFromStat(completed), identity) || completed.size !== BigInt(bytes.length)) throw backupFailure();
      await handle.close();
      handle = null;
      await this.durableFs.flushDirectoryAsync(path.dirname(filePath));
      if (this.durableFs.sha256File(filePath) !== crypto.createHash('sha256').update(bytes).digest('hex')) throw backupFailure();
      return identity;
    } catch (error) {
      if (handle !== null) {
        try { await handle.close(); } catch { /* preserve primary failure */ }
      }
      throw backupFailure(error);
    }
  }

  #assertServer(value) {
    try {
      if (typeof value !== 'string' || !path.isAbsolute(value) || hasRawTraversal(value)) throw backupFailure();
      const serverPath = path.resolve(value);
      if (serverPath === path.parse(serverPath).root) throw backupFailure();
      const stat = this.fs.lstatSync(serverPath, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameLocalPath(this.fs.realpathSync.native(serverPath), serverPath)) throw backupFailure();
      return serverPath;
    } catch (error) {
      throw backupFailure(error);
    }
  }

  async #ensureBackupDirectory(serverPath) {
    const backupDir = path.join(serverPath, 'backups');
    try {
      if (!this.#exists(backupDir)) {
        this.fs.mkdirSync(backupDir, { recursive: false, mode: 0o700 });
        await this.durableFs.flushDirectoryAsync(serverPath);
      }
      const stat = this.fs.lstatSync(backupDir, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameLocalPath(this.fs.realpathSync.native(backupDir), backupDir)) throw backupFailure();
      return backupDir;
    } catch (error) {
      throw backupFailure(error);
    }
  }

  #serverItems(serverPath, { excludeBackups = true } = {}) {
    const backupDirectory = path.join(serverPath, 'backups');
    return this.fs.readdirSync(serverPath, { withFileTypes: true })
      .filter(entry => !excludeBackups || !sameLocalPath(path.join(serverPath, entry.name), backupDirectory))
      .sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
      .map(entry => path.join(serverPath, entry.name));
  }

  #now() {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw backupFailure();
    return value.toISOString();
  }

  #exists(candidate) {
    try {
      this.fs.lstatSync(candidate, { bigint: true });
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  #readMetadata(metadataPath) {
    try {
      const bytes = this.durableFs.readFileBounded(metadataPath, { allowMissing: false, maxBytes: 8 * 1024 * 1024 });
      const metadata = normalizeMetadata(JSON.parse(bytes.toString('utf8')));
      return { metadata, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      throw backupFailure(error);
    }
  }

  #assertBackupDirectory(backupDir) {
    const stat = this.fs.lstatSync(backupDir, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameLocalPath(this.fs.realpathSync.native(backupDir), backupDir)) {
      throw backupFailure();
    }
    return stat;
  }

  #restoreCreationPaths(backupDir, name) {
    const archivePath = path.join(backupDir, name);
    return [
      archivePath,
      `${archivePath}.part`,
      archivePath.replace(/\.zip$/u, '.json'),
      archivePath.replace(/\.zip$/u, '.pending.json')
    ];
  }

  #reference(serverPath, metadata) {
    const backupDir = path.join(serverPath, 'backups');
    return Object.freeze({
      id: metadata.id,
      name: metadata.name,
      sha256: metadata.sha256,
      size: metadata.size,
      totalBytes: String(metadata.scope.totalBytes),
      scopeSha256: metadata.scopeSha256,
      sourceRevision: metadata.sourceRevision,
      sourceRuntime: metadata.sourceRuntime === null
        ? null
        : Object.freeze(strictJsonClone(metadata.sourceRuntime)),
      operationId: metadata.operationId,
      createdAt: metadata.createdAt,
      serverPath,
      archivePath: path.join(backupDir, metadata.name),
      metadataPath: path.join(backupDir, metadata.name.replace(/\.zip$/, '.json'))
    });
  }

  #normalizeReference(reference) {
    assertPlainDataObject(reference, REFERENCE_KEYS);
    const serverPath = this.#assertServer(reference.serverPath);
    if (typeof reference.name !== 'string' || !RESTORE_NAME_PATTERN.test(reference.name)) throw backupFailure();
    const backupDir = path.join(serverPath, 'backups');
    const archivePath = path.join(backupDir, reference.name);
    const metadataPath = archivePath.replace(/\.zip$/, '.json');
    if (typeof reference.archivePath !== 'string' || typeof reference.metadataPath !== 'string' ||
        !sameLocalPath(reference.archivePath, archivePath) || !sameLocalPath(reference.metadataPath, metadataPath)) throw backupFailure();
    return {
      id: assertId(reference.id),
      name: reference.name,
      sha256: assertHash(reference.sha256),
      size: reference.size,
      totalBytes: assertTotalBytes(reference.totalBytes),
      scopeSha256: assertHash(reference.scopeSha256),
      sourceRevision: reference.sourceRevision,
      sourceRuntime: reference.sourceRuntime === null ? null : strictJsonClone(reference.sourceRuntime),
      operationId: assertId(reference.operationId),
      createdAt: strictTimestamp(reference.createdAt),
      serverPath,
      archivePath,
      metadataPath,
      pinId: reference.pinId === undefined || reference.pinId === null ? null : assertId(reference.pinId)
    };
  }

  #assertReferenceMatches(reference, metadata) {
    const expected = this.#reference(reference.serverPath, metadata);
    for (const key of ['id', 'name', 'sha256', 'size', 'totalBytes', 'scopeSha256', 'sourceRevision', 'operationId', 'createdAt']) {
      if (reference[key] !== expected[key]) throw backupFailure();
    }
    if (JSON.stringify(reference.sourceRuntime) !== JSON.stringify(expected.sourceRuntime)) throw backupFailure();
  }

  async #verifyArchive(archivePath, metadata, operation = { signal: null, reportProgress() {} }) {
    try {
      throwIfCancelled(operation.signal);
      const stat = this.fs.lstatSync(archivePath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== metadata.size ||
          !sameLocalPath(this.fs.realpathSync.native(archivePath), archivePath)) throw backupFailure();
      const evidence = await this.zipStreamVerifier(archivePath, metadata.scope, {
        signal: operation.signal,
        onProgress: progress => operation.reportProgress(progress)
      });
      if (evidence.archiveSha256 !== metadata.sha256 || evidence.archiveSize !== metadata.size) throw backupFailure();
      return {
        sha256: evidence.archiveSha256,
        size: evidence.archiveSize,
        identity: evidence.archiveIdentity
      };
    } catch (error) {
      throw backupFailure(error);
    }
  }

  #sameDirectoryIdentity(candidate, expected) {
    try {
      const stat = this.fs.lstatSync(candidate, { bigint: true });
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino &&
        stat.birthtimeNs === expected.birthtimeNs;
    } catch {
      return false;
    }
  }

  #removeOwnedFile(candidate, expectedIdentity) {
    if (expectedIdentity === null || expectedIdentity === undefined) return false;
    try {
      const stat = this.fs.lstatSync(candidate, { bigint: true });
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
          sameIdentity(identityFromStat(stat), expectedIdentity)) {
        this.fs.unlinkSync(candidate);
        return true;
      }
    } catch { /* best-effort cleanup before visible publication */ }
    return false;
  }

}

module.exports = {
  METADATA_KIND,
  METADATA_SCHEMA_VERSION,
  RestorePointService,
  normalizeMetadata
};
