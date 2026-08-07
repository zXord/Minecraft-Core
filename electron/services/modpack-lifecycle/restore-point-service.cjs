const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createVerifiedZip, enumerateArchiveScope, verifyZipScopeStreaming } = require('../../utils/backup-util.cjs');
const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { withBackupMutationLock } = require('../backup-mutation-lock.cjs');
const { ModpackError } = require('../modpacks/errors.cjs');

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
  if (cause instanceof ModpackError && ['BACKUP_FAILED', 'TARGET_EXISTS'].includes(cause.code)) return cause;
  return new ModpackError('BACKUP_FAILED', 'The lifecycle restore point operation failed', { cause });
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
        typeof durableFs.readFileBounded !== 'function' || typeof durableFs.writeJsonAtomic !== 'function' ||
        typeof durableFs.renameDurable !== 'function' || typeof durableFs.flushDirectory !== 'function' ||
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

  async createVerifiedRestorePoint(request) {
    let normalized;
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
      normalized = { serverPath, operationId, sourceRevision: request.sourceRevision, sourceRuntime };
    } catch (error) {
      throw backupFailure(error);
    }
    return withBackupMutationLock(normalized.serverPath, () => this.#createVerifiedRestorePointLocked(normalized));
  }

  async #createVerifiedRestorePointLocked(request) {
    let paths = null;
    let finalPublished = false;
    let intendedMetadata = null;
    try {
      const { serverPath, operationId, sourceRuntime } = request;
      const backupDir = this.#ensureBackupDirectory(serverPath);
      await this.#recoverPendingRestorePointsLocked(serverPath);
      const items = this.#serverItems(serverPath);
      const expectedScope = enumerateArchiveScope(items, { fsApi: this.fs });
      const createdAt = this.#now();
      const token = assertId(this.randomUUID());
      const timestamp = createdAt.replaceAll(':', '-');
      const name = `restore-point-${timestamp}-${token}.zip`;
      if (!RESTORE_NAME_PATTERN.test(name)) throw backupFailure();
      const archivePath = path.join(backupDir, name);
      const partPath = `${archivePath}.part`;
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
        faultInjector: this.faultInjector
      });
      const postArchiveScope = enumerateArchiveScope(this.#serverItems(serverPath), { fsApi: this.fs });
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
      this.durableFs.writeJsonAtomic(pendingPath, metadata, { expectedTargetSha256: null });
      await this.faultInjector('before-final-rename');
      this.durableFs.renameDurable(partPath, archivePath, { expectedSourceSha256: verified.sha256 });
      finalPublished = true;
      await this.faultInjector('after-final-rename');
      await this.faultInjector('before-pin-persistence');
      this.durableFs.renameDurable(pendingPath, metadataPath, { expectedSourceSha256: metadataDigest(metadata) });
      const reference = this.#reference(serverPath, metadata);
      await this.#verifyRestorePointLocked(reference);
      return reference;
    } catch (error) {
      if (paths && finalPublished && intendedMetadata && this.#exists(paths.metadataPath) && !this.#exists(paths.pendingPath)) {
        try {
          const loaded = this.#readMetadata(paths.metadataPath);
          if (loaded.sha256 !== metadataDigest(intendedMetadata) ||
              JSON.stringify(loaded.metadata) !== JSON.stringify(intendedMetadata)) throw backupFailure();
          await this.#verifyArchive(paths.archivePath, loaded.metadata);
          const reference = this.#reference(request.serverPath, loaded.metadata);
          await this.#verifyRestorePointLocked(reference);
          return reference;
        } catch { /* retain the publication uncertainty as a diagnostic failure */ }
      }
      if (paths && !finalPublished && !this.#exists(paths.archivePath)) {
        for (const candidate of [paths.partPath, paths.pendingPath]) this.#removeOwnedFile(candidate);
      }
      throw backupFailure(error);
    }
  }

  async recoverPendingRestorePoints(serverPathValue) {
    const serverPath = this.#assertServer(serverPathValue);
    return withBackupMutationLock(serverPath, () => this.#recoverPendingRestorePointsLocked(serverPath, { discoverFinal: true }));
  }

  async #recoverPendingRestorePointsLocked(serverPath, { discoverFinal = false } = {}) {
    const backupDir = this.#ensureBackupDirectory(serverPath);
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
        this.durableFs.renameDurable(pendingPath, metadataPath, { expectedSourceSha256: pending.sha256 });
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

  async verifyRestorePoint(reference) {
    const normalized = this.#normalizeReference(reference);
    return withBackupMutationLock(normalized.serverPath, () => this.#verifyRestorePointLocked(normalized));
  }

  async resolveRestorePoint(request) {
    let normalized;
    try {
      assertPlainDataObject(request, new Set(['serverPath', 'id', 'sha256']));
      if (Object.keys(request).length !== 3) throw backupFailure();
      normalized = {
        serverPath: this.#assertServer(request.serverPath),
        id: assertId(request.id),
        sha256: assertHash(request.sha256)
      };
    } catch (error) {
      throw backupFailure(error);
    }
    return withBackupMutationLock(normalized.serverPath, async () => {
      await this.#recoverPendingRestorePointsLocked(normalized.serverPath);
      const backupDir = this.#ensureBackupDirectory(normalized.serverPath);
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
      await this.#verifyRestorePointLocked(matches[0]);
      return matches[0];
    });
  }

  async #verifyRestorePointLocked(normalized) {
    await this.#recoverPendingRestorePointsLocked(normalized.serverPath);
    const loaded = this.#readMetadata(normalized.metadataPath);
    this.#assertReferenceMatches(normalized, loaded.metadata);
    const evidence = await this.#verifyArchive(normalized.archivePath, loaded.metadata);
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

  async restoreToFreshCandidate(reference, destinationValue) {
    const normalized = this.#normalizeReference(reference);
    if (typeof destinationValue !== 'string' || !path.isAbsolute(destinationValue) || hasRawTraversal(destinationValue)) {
      throw backupFailure();
    }
    const destination = path.resolve(destinationValue);
    const expectedParent = path.dirname(normalized.serverPath);
    if (!sameLocalPath(path.dirname(destination), expectedParent) ||
        sameLocalPath(destination, normalized.serverPath)) throw backupFailure();
    return withBackupMutationLock(normalized.serverPath, () =>
      this.#restoreToFreshCandidateLocked(normalized, destination, expectedParent));
  }

  async restoreToOwnedCandidate(reference, destinationValue, candidateRootValue) {
    const normalized = this.#normalizeReference(reference);
    if (typeof destinationValue !== 'string' || !path.isAbsolute(destinationValue) || hasRawTraversal(destinationValue) ||
        typeof candidateRootValue !== 'string' || !path.isAbsolute(candidateRootValue) || hasRawTraversal(candidateRootValue)) {
      throw backupFailure();
    }
    const candidateRoot = path.resolve(candidateRootValue);
    const destination = path.resolve(destinationValue);
    const serverParent = path.dirname(normalized.serverPath);
    const candidateName = path.basename(candidateRoot);
    const prefix = `.${path.basename(normalized.serverPath)}.minecraft-core.`;
    const operationId = candidateName.startsWith(prefix) && candidateName.endsWith('.candidate')
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
      this.#restoreToFreshCandidateLocked(normalized, destination, operationWorkspace));
  }

  async #restoreToFreshCandidateLocked(normalized, destination, expectedParent) {
    await this.#recoverPendingRestorePointsLocked(normalized.serverPath);
    const initialMetadata = this.#readMetadata(normalized.metadataPath);
    this.#assertReferenceMatches(normalized, initialMetadata.metadata);
    const initialArchive = await this.#verifyArchive(normalized.archivePath, initialMetadata.metadata);
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
      const currentArchive = await this.#verifyArchive(normalized.archivePath, currentMetadata.metadata);
      if (currentArchive.sha256 !== initialArchive.sha256 || currentArchive.size !== initialArchive.size) throw backupFailure();
      await this.extractVerifiedArchive(Object.freeze({
        archivePath: normalized.archivePath,
        stagingPath,
        expectedArchiveSha256: currentArchive.sha256,
        expectedArchiveSize: currentArchive.size,
        expectedArchiveIdentity: currentArchive.identity,
        expectedScope: Object.freeze(strictJsonClone(currentMetadata.metadata.scope)),
        operationId: currentMetadata.metadata.operationId
      }));
      const created = this.fs.lstatSync(stagingPath, { bigint: true });
      if (!created.isDirectory() || created.isSymbolicLink() ||
          !sameLocalPath(this.fs.realpathSync.native(stagingPath), stagingPath)) throw backupFailure();
      stagingIdentity = { dev: created.dev, ino: created.ino, birthtimeNs: created.birthtimeNs };
      const reconstructed = enumerateArchiveScope(this.#serverItems(stagingPath, { excludeBackups: false }), { fsApi: this.fs });
      if (JSON.stringify(reconstructed) !== JSON.stringify(currentMetadata.metadata.scope)) throw backupFailure();
      const directories = [stagingPath, ...currentMetadata.metadata.scope.entries
        .filter(entry => entry.type === 'directory')
        .map(entry => path.resolve(stagingPath, ...entry.path.slice(0, -1).split('/')))]
        .sort((left, right) => right.length - left.length);
      for (const directory of directories) this.durableFs.flushDirectory(directory);
      this.durableFs.flushDirectory(expectedParent);
      const finalMetadata = this.#readMetadata(normalized.metadataPath);
      if (finalMetadata.sha256 !== initialMetadata.sha256) throw backupFailure();
      const finalArchive = await this.#verifyArchive(normalized.archivePath, finalMetadata.metadata);
      if (finalArchive.sha256 !== initialArchive.sha256 || finalArchive.size !== initialArchive.size) throw backupFailure();
      try {
        this.durableFs.renameDurable(stagingPath, destination);
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
      this.durableFs.flushDirectory(expectedParent);
      const publishedScope = enumerateArchiveScope(this.#serverItems(destination, { excludeBackups: false }), { fsApi: this.fs });
      if (JSON.stringify(publishedScope) !== JSON.stringify(currentMetadata.metadata.scope)) throw backupFailure();
      return Object.freeze({ ok: true, destination, scopeSha256: publishedScope.scopeSha256 });
    } catch (error) {
      if (stagingIdentity && this.#sameDirectoryIdentity(stagingPath, stagingIdentity)) {
        try {
          this.fs.rmSync(stagingPath, { recursive: true, force: true });
          this.durableFs.flushDirectory(expectedParent);
        } catch { /* retain original failure */ }
      }
      if (destinationIdentity && this.#sameDirectoryIdentity(destination, destinationIdentity)) {
        try {
          this.fs.rmSync(destination, { recursive: true, force: true });
          this.durableFs.flushDirectory(expectedParent);
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
      this.durableFs.writeJsonAtomic(normalized.metadataPath, next, { expectedTargetSha256: loaded.sha256 });
    }
    return Object.freeze({ pinned: next.pins.length > 0, pins: Object.freeze([...next.pins]) });
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

  #ensureBackupDirectory(serverPath) {
    const backupDir = path.join(serverPath, 'backups');
    try {
      if (!this.#exists(backupDir)) {
        this.fs.mkdirSync(backupDir, { recursive: false, mode: 0o700 });
        this.durableFs.flushDirectory(serverPath);
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

  async #verifyArchive(archivePath, metadata) {
    try {
      const stat = this.fs.lstatSync(archivePath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== metadata.size ||
          !sameLocalPath(this.fs.realpathSync.native(archivePath), archivePath)) throw backupFailure();
      const evidence = await this.zipStreamVerifier(archivePath, metadata.scope);
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

  #removeOwnedFile(candidate) {
    try {
      const stat = this.fs.lstatSync(candidate, { bigint: true });
      if (stat.isFile() && !stat.isSymbolicLink()) this.fs.unlinkSync(candidate);
    } catch { /* best-effort cleanup before visible publication */ }
  }
}

module.exports = {
  METADATA_KIND,
  METADATA_SCHEMA_VERSION,
  RestorePointService,
  normalizeMetadata
};
