const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { groupMultipartCandidates: defaultGrouping } = require('../artifacts/multipart-names.cjs');
const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { isSafeWindowsBasename, windowsBasenameCollisionKey } = require('../windows-basename.cjs');
const { WindowsReparseInspector } = require('./windows-reparse-inspector.cjs');

const SELECTION_TTL_MS = 30 * 60 * 1000;
const PARTIAL_ATTEMPTS = 16;
const COPY_CHUNK_BYTES = 64 * 1024;
const SAFE_PARTIAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ARTIFACT_SET_BYTES = BigInt(ARCHIVE_LIMITS.maxArtifactSetBytes);

function invalidRequest(field = 'request') {
  return new ModpackError('INVALID_REQUEST', 'Local archive request is invalid', { details: { field } });
}

function invalidSelection() {
  return new ModpackError('INVALID_REQUEST', 'Local archive selection is invalid', { details: { field: 'selection' } });
}

function unsupportedArchive() {
  return new ModpackError('UNSUPPORTED_ARCHIVE', 'The selected archive type is unsupported');
}

function staleSelection() {
  return new ModpackError('PLAN_STALE', 'The local archive selection has changed');
}

function hashMismatch() {
  return new ModpackError('HASH_MISMATCH', 'Local archive bytes changed during ingestion');
}

function cancelled() {
  return new ModpackError('CANCELLED', 'Local archive ingestion was cancelled');
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelled();
}

function limitExceeded(actual) {
  return new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Local archive bytes exceeded the configured limit', {
    details: { limit: 'maxArtifactSetBytes', actual: actual.toString() }
  });
}

function multipartMissing(partId) {
  return new ModpackError('MULTIPART_VOLUME_MISSING', 'The local multipart archive is incomplete', {
    details: typeof partId === 'string' ? { partId } : undefined
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function decimalBytes(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function supportedName(value) {
  return /\.(?:mrpack|zip|rar|r\d{2}|\d{3,})$/i.test(value);
}

function canonicalName(value) {
  return windowsBasenameCollisionKey(value);
}

function canonicalPath(value) {
  return path.resolve(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function statValue(stat, key) {
  const value = stat?.[key];
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Number.isInteger(value) ? String(value) : String(Math.trunc(value));
  return null;
}

function isReparseLike(stat) {
  return Boolean(stat?.isSymbolicLink?.());
}

function captureIdentity(stat) {
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile() || isReparseLike(stat)) throw invalidSelection();
  const size = statValue(stat, 'size');
  if (!decimalBytes(size)) throw invalidSelection();
  return deepFreeze({
    size,
    mode: statValue(stat, 'mode'),
    device: statValue(stat, 'dev'),
    inode: statValue(stat, 'ino'),
    birthtimeNs: statValue(stat, 'birthtimeNs') ?? statValue(stat, 'birthtimeMs'),
    ctimeNs: statValue(stat, 'ctimeNs') ?? statValue(stat, 'ctimeMs'),
    mtimeNs: statValue(stat, 'mtimeNs') ?? statValue(stat, 'mtimeMs')
  });
}

function sameIdentity(left, right) {
  return Boolean(left) && Boolean(right) && Object.keys(left).every(key => left[key] === right[key]) && Object.keys(right).every(key => left[key] === right[key]);
}

function stableIdentityKey(identity) {
  if (!identity || identity.inode === null || identity.inode === '0' || identity.device === null) return null;
  return `${identity.device}:${identity.inode}`;
}

function updatedAtFromStat(stat) {
  const raw = stat?.mtimeMs;
  const milliseconds = typeof raw === 'bigint' ? Number(raw) : raw;
  if (!Number.isFinite(milliseconds)) throw invalidSelection();
  const value = new Date(milliseconds);
  if (Number.isNaN(value.getTime())) throw invalidSelection();
  return value.toISOString();
}

function readOptions(options) {
  if (options === undefined) return {};
  if (!isPlainObject(options) || Object.keys(options).some(key => !['signal', 'onProgress'].includes(key))) throw invalidRequest('options');
  const { signal, onProgress } = options;
  if (onProgress !== undefined && typeof onProgress !== 'function') throw invalidRequest('options.onProgress');
  if (signal !== undefined && (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw invalidRequest('options.signal');
  return { signal, onProgress };
}

function selectionRequest(request) {
  if (!exactKeys(request, ['allowMultipart']) || typeof request.allowMultipart !== 'boolean') throw invalidRequest('request');
  return request.allowMultipart;
}

function publicGrouping(group) {
  return deepFreeze({
    kind: group.kind,
    groupingScheme: group.groupingScheme,
    primaryPartId: group.primaryPartId,
    parts: group.parts.map(part => ({ partId: part.partId, displayName: part.fileName, size: part.size })),
    tailCompleteness: group.tailCompleteness
  });
}

class LocalArtifactSource {
  constructor({
    dialog,
    registry,
    clock = () => Date.now(),
    fsApi = fs,
    cache,
    partialRoot,
    groupMultipartCandidates = defaultGrouping,
    partialIdSource = randomUUID,
    maxSetBytes = MAX_ARTIFACT_SET_BYTES,
    reparseInspector = new WindowsReparseInspector()
  } = {}) {
    if (!dialog || typeof dialog.showOpenDialog !== 'function' || !registry || typeof registry.create !== 'function' || typeof registry.claim !== 'function' ||
      typeof registry.invalidate !== 'function' || typeof clock !== 'function' || !fsApi || typeof fsApi.lstat !== 'function' || typeof fsApi.open !== 'function' ||
      !cache || typeof cache.commitPart !== 'function' || typeof cache.root !== 'string' || typeof partialRoot !== 'string' || !partialRoot ||
      typeof groupMultipartCandidates !== 'function' || typeof partialIdSource !== 'function' || !reparseInspector ||
      typeof reparseInspector.isReparsePoint !== 'function') throw new TypeError('Local artifact source dependencies are invalid');
    const parsedLimit = typeof maxSetBytes === 'bigint' ? maxSetBytes : decimalBytes(maxSetBytes) ? BigInt(maxSetBytes) : -1n;
    if (parsedLimit < 0n || parsedLimit > MAX_ARTIFACT_SET_BYTES) throw new TypeError('Local artifact byte limit is invalid');
    this.dialog = dialog;
    this.registry = registry;
    this.clock = clock;
    this.fs = fsApi;
    this.cache = cache;
    this.partialRoot = path.resolve(partialRoot);
    this.groupMultipartCandidates = groupMultipartCandidates;
    this.partialIdSource = partialIdSource;
    this.maxSetBytes = parsedLimit;
    this.reparseInspector = reparseInspector;
    if (!isInside(path.resolve(cache.root), this.partialRoot)) throw new TypeError('Local artifact partial root must be inside the cache root');
  }

  now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - SELECTION_TTL_MS) throw new TypeError('Local artifact source clock is invalid');
    return value;
  }

  groupingFor(records) {
    let groups;
    try {
      groups = this.groupMultipartCandidates(records.map(record => ({
        assetId: record.partId,
        fileName: record.displayName,
        size: record.size
      })));
    } catch (error) {
      if (error instanceof ModpackError) throw error;
      throw invalidSelection();
    }
    if (!Array.isArray(groups) || groups.length !== 1 || groups[0].parts.length !== records.length) throw invalidSelection();
    const [group] = groups;
    if (group.disabled) {
      if (group.disabledReason === 'missing-volume') throw multipartMissing(group.primaryPartId);
      throw invalidSelection();
    }
    if (group.kind === 'multipart' && group.parts.length < 2) throw multipartMissing(group.primaryPartId);
    return group;
  }

  async assertPathIsNotReparse(selectedPath, { signal, selection = false } = {}) {
    let reparse;
    try {
      reparse = await this.reparseInspector.isReparsePoint(selectedPath, signal ? { signal } : undefined);
    } catch (error) {
      if (error?.code === 'ABORT_ERR') throw error;
      throw selection ? invalidSelection() : staleSelection();
    }
    throwIfCancelled(signal);
    if (typeof reparse !== 'boolean' || reparse) throw selection ? invalidSelection() : staleSelection();
  }

  async statSelectedFile(selectedPath) {
    let stat;
    try {
      stat = await this.fs.lstat(selectedPath, { bigint: true });
    } catch {
      throw invalidSelection();
    }
    await this.assertPathIsNotReparse(selectedPath, { selection: true });
    return stat;
  }

  async selectWithNativeDialog(request) {
    const allowMultipart = selectionRequest(request);
    let result;
    try {
      result = await this.dialog.showOpenDialog({
        title: 'Import local modpack archive',
        properties: allowMultipart ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [
          { name: 'Modpack archives', extensions: ['mrpack', 'zip', 'rar'] },
          { name: 'Multipart archive volumes', extensions: ['r00', 'r01', 'r02', '001', '002', '003'] },
          { name: 'All supported multipart volumes', extensions: ['*'] }
        ]
      });
    } catch (cause) {
      throw new ModpackError('INVALID_REQUEST', 'The native archive picker failed', { cause, details: { field: 'selection' } });
    }
    if (!result || typeof result !== 'object' || typeof result.canceled !== 'boolean' || !Array.isArray(result.filePaths)) throw invalidSelection();
    if (result.canceled) return deepFreeze({ cancelled: true });
    const selectedCount = result.filePaths.length;
    if (selectedCount > ARCHIVE_LIMITS.maxArchiveEntries) throw invalidSelection();
    if (selectedCount === 0 || (!allowMultipart && selectedCount !== 1) ||
      result.filePaths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) throw invalidSelection();

    const logicalPaths = new Set();
    const names = new Set();
    const identities = new Set();
    const records = [];
    let total = 0n;
    for (let index = 0; index < selectedCount; index += 1) {
      const selectedPath = result.filePaths[index];
      const pathKey = canonicalPath(selectedPath);
      if (logicalPaths.has(pathKey)) throw invalidSelection();
      logicalPaths.add(pathKey);
      const displayName = path.basename(selectedPath);
      if (!isSafeWindowsBasename(displayName)) throw invalidSelection();
      if (!supportedName(displayName)) {
        if (selectedCount > 1) throw invalidSelection();
        throw unsupportedArchive();
      }
      const nameKey = canonicalName(displayName);
      if (names.has(nameKey)) throw invalidSelection();
      names.add(nameKey);
      const stat = await this.statSelectedFile(selectedPath);
      const identity = captureIdentity(stat);
      const identityKey = stableIdentityKey(identity);
      if (identityKey && identities.has(identityKey)) throw invalidSelection();
      if (identityKey) identities.add(identityKey);
      total += BigInt(identity.size);
      if (total > this.maxSetBytes) throw limitExceeded(total);
      records.push({ selectedPath, displayName, size: identity.size, updatedAt: updatedAtFromStat(stat), identity });
    }

    records.sort((left, right) => canonicalName(left.displayName).localeCompare(canonicalName(right.displayName), 'en-US'));
    records.forEach((record, index) => { record.partId = `local-${String(index + 1).padStart(4, '0')}`; });
    const group = this.groupingFor(records);
    const expiresAt = this.now() + SELECTION_TTL_MS;
    const registration = this.registry.create({
      selectedPaths: records.map(record => ({
        path: record.selectedPath,
        displayName: record.displayName,
        size: record.size,
        updatedAt: record.updatedAt,
        partId: record.partId,
        identity: record.identity
      })),
      displayNames: records.map(record => record.displayName),
      expiresAt
    });
    return deepFreeze({
      cancelled: false,
      selectionId: registration.selectionId,
      expiresAt: new Date(expiresAt).toISOString(),
      files: records.map(record => ({ displayName: record.displayName, size: record.size })),
      provisionalGrouping: publicGrouping(group)
    });
  }

  validatePrivateRecords(value) {
    if (!Array.isArray(value) || value.length === 0) throw staleSelection();
    return value.map(record => {
      if (!isPlainObject(record) || typeof record.path !== 'string' || !path.isAbsolute(record.path) || !isSafeWindowsBasename(record.displayName) ||
        !supportedName(record.displayName) || !decimalBytes(record.size) || typeof record.updatedAt !== 'string' ||
        typeof record.partId !== 'string' || !/^local-[0-9]{4,}$/.test(record.partId) || !isPlainObject(record.identity) || record.identity.size !== record.size) throw staleSelection();
      return record;
    });
  }

  async preparePartialRoot() {
    if (this.partialRoot === path.resolve(this.cache.root)) await this.cache.controlledRoot(this.partialRoot, 'partialPath');
    else await this.cache.ensureControlledDirectory(this.partialRoot, this.cache.root, 'partialPath');
  }

  async openUniquePartial() {
    await this.preparePartialRoot();
    for (let attempt = 0; attempt < PARTIAL_ATTEMPTS; attempt += 1) {
      const id = this.partialIdSource();
      if (typeof id !== 'string' || !SAFE_PARTIAL_ID.test(id)) throw new TypeError('Local artifact partial identifier is invalid');
      const partialPath = path.join(this.partialRoot, `local-${id}.partial`);
      try {
        return { partialPath, handle: await this.fs.open(partialPath, 'wx') };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    throw new ModpackError('OPERATION_IN_PROGRESS', 'Local archive staging is busy');
  }

  async currentIdentity(selectedPath, signal) {
    let identity;
    try {
      identity = captureIdentity(await this.fs.lstat(selectedPath, { bigint: true }));
    } catch (error) {
      if (error instanceof ModpackError && error.code === 'INVALID_REQUEST') throw staleSelection();
      throw staleSelection();
    }
    throwIfCancelled(signal);
    await this.assertPathIsNotReparse(selectedPath, { signal });
    return identity;
  }

  async handleIdentity(handle) {
    try {
      return captureIdentity(await handle.stat({ bigint: true }));
    } catch {
      throw staleSelection();
    }
  }

  assertIdentity(expected, actual) {
    if (!sameIdentity(expected, actual)) throw staleSelection();
  }

  async streamPart(record, { signal, onProgress, budget }) {
    let sourceHandle;
    let targetHandle;
    let partialPath;
    let abortListener;
    const expectedSize = BigInt(record.size);
    let partMeasured = 0n;
    const hashes = { sha256: crypto.createHash('sha256'), sha512: crypto.createHash('sha512') };
    try {
      const initialPathIdentity = await this.currentIdentity(record.path, signal);
      throwIfCancelled(signal);
      this.assertIdentity(record.identity, initialPathIdentity);
      try {
        sourceHandle = await this.fs.open(record.path, 'r');
      } catch {
        throw staleSelection();
      }
      throwIfCancelled(signal);
      const initialHandleIdentity = await this.handleIdentity(sourceHandle);
      throwIfCancelled(signal);
      this.assertIdentity(record.identity, initialHandleIdentity);
      await this.assertPathIsNotReparse(record.path, { signal });
      ({ partialPath, handle: targetHandle } = await this.openUniquePartial());
      throwIfCancelled(signal);
      abortListener = () => {};
      signal?.addEventListener('abort', abortListener, { once: true });
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        if (signal?.aborted) throw cancelled();
        const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length, null);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) throw hashMismatch();
        if (bytesRead === 0) break;
        const nextPart = partMeasured + BigInt(bytesRead);
        const nextSet = budget.used + BigInt(bytesRead);
        if (nextSet > budget.max) throw limitExceeded(nextSet);
        if (nextPart > expectedSize) throw hashMismatch();
        const data = chunk.subarray(0, bytesRead);
        hashes.sha256.update(data);
        hashes.sha512.update(data);
        let written = 0;
        while (written < data.length) {
          if (signal?.aborted) throw cancelled();
          const result = await targetHandle.write(data, written, data.length - written, null);
          if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw hashMismatch();
          written += result.bytesWritten;
        }
        partMeasured = nextPart;
        budget.used = nextSet;
        if (onProgress) {
          const event = deepFreeze({ partId: record.partId, measuredBytes: budget.used.toString(), totalBytes: budget.total.toString() });
          try {
            await onProgress(event);
          } catch (cause) {
            throw new ModpackError('INVALID_REQUEST', 'Local archive progress callback failed', { cause, details: { field: 'options.onProgress' } });
          }
        }
        if (signal?.aborted) throw cancelled();
      }
      if (partMeasured !== expectedSize) throw hashMismatch();
      await targetHandle.sync();
      throwIfCancelled(signal);
      const targetStat = await targetHandle.stat({ bigint: true });
      throwIfCancelled(signal);
      if (!targetStat.isFile() || isReparseLike(targetStat) || BigInt(targetStat.size) !== partMeasured) throw hashMismatch();
      const precommitHandleIdentity = await this.handleIdentity(sourceHandle);
      throwIfCancelled(signal);
      this.assertIdentity(record.identity, precommitHandleIdentity);
      await this.assertPathIsNotReparse(record.path, { signal });
      const precommitPathIdentity = await this.currentIdentity(record.path, signal);
      throwIfCancelled(signal);
      this.assertIdentity(record.identity, precommitPathIdentity);
      const calculated = { sha256: hashes.sha256.digest('hex'), sha512: hashes.sha512.digest('hex') };
      await targetHandle.close();
      targetHandle = null;
      throwIfCancelled(signal);
      await this.cache.commitPart({ partialPath, sha256: calculated.sha256, measuredSize: partMeasured.toString() });
      partialPath = null;
      throwIfCancelled(signal);
      const finalHandleIdentity = await this.handleIdentity(sourceHandle);
      throwIfCancelled(signal);
      this.assertIdentity(record.identity, finalHandleIdentity);
      await this.assertPathIsNotReparse(record.path, { signal });
      const finalPathIdentity = await this.currentIdentity(record.path, signal);
      throwIfCancelled(signal);
      this.assertIdentity(record.identity, finalPathIdentity);
      throwIfCancelled(signal);
      return deepFreeze({ partId: record.partId, measuredSize: partMeasured.toString(), ...calculated });
    } finally {
      if (abortListener) {
        try { signal?.removeEventListener('abort', abortListener); } catch { /* cleanup continues below */ }
      }
      if (targetHandle) await targetHandle.close().catch(() => {});
      if (sourceHandle) await sourceHandle.close().catch(() => {});
      if (partialPath) await this.fs.rm(partialPath, { force: true }).catch(() => {});
    }
  }

  async ingestSelection(selectionId, options = {}) {
    const { signal, onProgress } = readOptions(options);
    const claimed = this.registry.claim(selectionId);
    try {
      if (signal?.aborted) throw cancelled();
      const records = this.validatePrivateRecords(claimed.selectedPaths);
      const group = this.groupingFor(records);
      const byId = new Map(records.map(record => [record.partId, record]));
      const parts = group.parts.map(part => {
        const record = byId.get(part.partId);
        if (!record) throw staleSelection();
        return { partId: record.partId, fileName: record.displayName, size: record.size, updatedAt: record.updatedAt };
      });
      const plan = createArtifactSetPlan({
        provider: 'local',
        artifactSet: {
          kind: group.kind,
          groupingScheme: group.groupingScheme,
          primaryPartId: group.primaryPartId,
          parts,
          providerImmutable: false,
          attestationStatus: 'unavailable'
        }
      });
      const total = parts.reduce((sum, part) => sum + BigInt(part.size), 0n);
      if (total > this.maxSetBytes) throw limitExceeded(total);
      const budget = { used: 0n, total, max: this.maxSetBytes };
      const verified = [];
      for (const part of plan.artifactSet.parts) {
        const verifiedPart = await this.streamPart(byId.get(part.partId), { signal, onProgress, budget });
        throwIfCancelled(signal);
        verified.push(verifiedPart);
      }
      throwIfCancelled(signal);
      return finalizeVerifiedArtifactSet(plan, verified);
    } catch (error) {
      if (error instanceof ModpackError) throw error;
      if (signal?.aborted || error?.code === 'ABORT_ERR') throw cancelled();
      throw new ModpackError('INVALID_REQUEST', 'Local archive ingestion failed', { cause: error });
    } finally {
      this.registry.invalidate(selectionId);
    }
  }
}

module.exports = { LocalArtifactSource };
