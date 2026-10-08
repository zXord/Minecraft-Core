const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ModpackError } = require('../errors.cjs');
const { computeArtifactSetDigest } = require('../contracts.cjs');
const { isSafeWindowsBasename, windowsBasenameCollisionKey } = require('../windows-basename.cjs');

const SHA256 = /^[a-f0-9]{64}$/; const SHA512 = /^[a-f0-9]{128}$/; const PART_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLICATION_PARTIAL = /^[a-f0-9]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$/;
const RETENTION_FILE = '.retained-artifacts.json';
const LEGACY_RETENTION_SCHEMA_VERSION = 1;
const RETENTION_SCHEMA_VERSION = 2;
const RETENTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CACHE_BYTES = 10 * 1024 * 1024 * 1024;
function invalid(field) { throw new ModpackError('INVALID_REQUEST', 'Artifact cache request is invalid', { details: { field } }); }
function validSize(size) { return typeof size === 'string' && /^(0|[1-9][0-9]*)$/.test(size); }
function inside(parent, child) { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); }
function ownerId(value) { if (typeof value !== 'string' || !PART_ID.test(value)) invalid('ownerId'); return value; }
function cacheNow(clock) { const value = clock(); const result = value instanceof Date ? value.getTime() : value; if (!Number.isSafeInteger(result) || result < 0) invalid('clock'); return result; }
function unavailable() { throw new ModpackError('PLAN_STALE', 'Artifact cache entry is unavailable'); }
function withCommitPhase(error, commitPhase) {
  if (error && typeof error === 'object' && error.commitPhase === undefined) {
    try { Object.defineProperty(error, 'commitPhase', { value: commitPhase, enumerable: true }); } catch { /* retain the primary error */ }
  }
  return error;
}
function cloneRetainedOutcomes(outcomes) {
  return new Map([...outcomes.entries()].map(([id, value]) => [id, {
    retainedAt: value.retainedAt,
    sha256s: new Set(value.sha256s)
  }]));
}
function conservativeRetainedUnion(current, candidate) {
  const result = cloneRetainedOutcomes(current);
  for (const [id, value] of candidate) {
    const existing = result.get(id);
    if (!existing) { result.set(id, { retainedAt: value.retainedAt, sha256s: new Set(value.sha256s) }); continue; }
    existing.retainedAt = Math.min(existing.retainedAt, value.retainedAt);
    for (const digest of value.sha256s) existing.sha256s.add(digest);
  }
  return result;
}

class ArtifactCache {
  constructor({ root, workspaceRoot, fsApi = fs, fsSyncApi = fsSync, clock = () => Date.now(), durableFsFactory = null, durabilityRoot = null } = {}) {
    if (typeof root !== 'string' || !root || typeof workspaceRoot !== 'string' || !workspaceRoot) invalid('root');
    if (durableFsFactory !== null && typeof durableFsFactory !== 'function') invalid('durableFsFactory');
    this.root = path.resolve(root); this.workspaceRoot = path.resolve(workspaceRoot);
    this.durabilityRoot = path.resolve(durabilityRoot || this.root);
    if (this.root !== this.durabilityRoot && !inside(this.durabilityRoot, this.root)) invalid('durabilityRoot');
    if (!fsSyncApi || typeof fsSyncApi.lstatSync !== 'function') invalid('fsSyncApi');
    this.fs = fsApi; this.fsSync = fsSyncApi; this.clock = clock; this.references = new Map(); this.deletingEntries = new Set();
    this.durableFsFactory = durableFsFactory; this.durableFs = null;
    this.retainedOutcomes = null; this.retentionLoad = null; this.retentionMutation = Promise.resolve();
  }
  pathForSha256(digest) { if (typeof digest !== 'string' || !SHA256.test(digest)) invalid('sha256'); return path.join(this.root, 'sha256', digest.slice(0, 2), digest); }
  retain(sha256) {
    const entry = this.pathForSha256(sha256);
    if (this.deletingEntries.has(sha256)) unavailable();
    try {
      const info = this.fsSync.lstatSync(entry);
      if (!info.isFile() || info.isSymbolicLink()) unavailable();
    } catch (error) {
      if (error instanceof ModpackError) throw error;
      unavailable();
    }
    this.references.set(sha256, (this.references.get(sha256) || 0) + 1);
    return true;
  }
  release(sha256) { this.pathForSha256(sha256); const next = (this.references.get(sha256) || 0) - 1; if (next < 0) throw new Error('Artifact cache reference underflow'); if (next === 0) this.references.delete(sha256); else this.references.set(sha256, next); }
  async controlledRoot(root, field) {
    await this.fs.mkdir(root, { recursive: true });
    const info = await this.fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid(field);
    return this.fs.realpath(root);
  }
  async assertSafePath(filePath, root, field, { requireFile = false } = {}) {
    const logicalRoot = path.resolve(root); const candidate = path.resolve(filePath);
    if (!inside(logicalRoot, candidate)) invalid(field);
    const rootReal = await this.controlledRoot(logicalRoot, field);
    const segments = path.relative(logicalRoot, candidate).split(path.sep);
    let current = logicalRoot; let lastExisting = logicalRoot;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const info = await this.fs.lstat(current);
        if (info.isSymbolicLink()) invalid(field);
        lastExisting = current;
        if (current === candidate && requireFile && !info.isFile()) invalid(field);
      } catch (error) {
        if (error?.code === 'ENOENT') { if (requireFile) invalid(field); break; }
        throw error;
      }
    }
    const existing = requireFile ? candidate : lastExisting;
    const existingReal = await this.fs.realpath(existing);
    if (existingReal !== rootReal && !inside(rootReal, existingReal)) invalid(field);
    return candidate;
  }
  async ensureControlledDirectory(directory, root, field) {
    await this.assertSafePath(directory, root, field);
    await this.fs.mkdir(directory, { recursive: true });
    const rootReal = await this.controlledRoot(root, field); const info = await this.fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await this.fs.realpath(directory)) !== rootReal && !inside(rootReal, await this.fs.realpath(directory))) invalid(field);
  }
  async hashFile(filePath, { sha256, sha512, size, root, field = 'cache' } = {}) {
    if (root) await this.assertSafePath(filePath, root, field, { requireFile: true });
    const stat = await this.fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || BigInt(stat.size) !== BigInt(size)) return false;
    const handle = await this.fs.open(filePath, 'r'); const hash256 = crypto.createHash('sha256'); const hash512 = sha512 ? crypto.createHash('sha512') : null; const chunk = Buffer.allocUnsafe(64 * 1024); let total = 0n;
    try {
      for (;;) { const { bytesRead } = await handle.read(chunk, 0, chunk.length, null); if (!bytesRead) break; const data = chunk.subarray(0, bytesRead); hash256.update(data); hash512?.update(data); total += BigInt(bytesRead); }
    } finally { await handle.close(); }
    return total === BigInt(size) && hash256.digest('hex') === sha256 && (!sha512 || hash512.digest('hex') === sha512);
  }
  async copyAndVerify(source, target, { sha256, sha512, size, sourceRoot, targetRoot, sourceField = 'cache', targetField = 'cache' }) {
    if (sourceRoot) await this.assertSafePath(source, sourceRoot, sourceField, { requireFile: true });
    if (targetRoot) await this.assertSafePath(target, targetRoot, targetField);
    const sourceHandle = await this.fs.open(source, 'r'); const targetHandle = await this.fs.open(target, 'wx'); const hash256 = crypto.createHash('sha256'); const hash512 = sha512 ? crypto.createHash('sha512') : null; const chunk = Buffer.allocUnsafe(64 * 1024); let total = 0n;
    try {
      for (;;) {
        const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length, null); if (!bytesRead) break;
        const data = chunk.subarray(0, bytesRead); hash256.update(data); hash512?.update(data); total += BigInt(bytesRead);
        let written = 0;
        while (written < data.length) {
          const { bytesWritten } = await targetHandle.write(data, written, data.length - written, null);
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error('Artifact write made no progress');
          written += bytesWritten;
        }
      }
      await targetHandle.sync();
    } finally { await sourceHandle.close(); await targetHandle.close(); }
    if (total !== BigInt(size) || hash256.digest('hex') !== sha256 || (sha512 && hash512.digest('hex') !== sha512)) return false;
    return this.hashFile(target, { sha256, sha512, size, root: targetRoot, field: targetField });
  }
  durabilityAuthority() {
    if (this.durableFs || !this.durableFsFactory) return this.durableFs;
    const durableFs = this.durableFsFactory();
    if (!durableFs || typeof durableFs !== 'object' ||
        (typeof durableFs.flushDirectoriesAsync !== 'function' && typeof durableFs.flushDirectoryAsync !== 'function')) {
      invalid('durableFsFactory');
    }
    this.durableFs = durableFs;
    return durableFs;
  }
  async syncFile(filePath, field) {
    await this.assertSafePath(filePath, this.root, field, { requireFile: true });
    const handle = await this.fs.open(filePath, 'r+');
    let failure = null;
    try {
      if (!handle || typeof handle.sync !== 'function' || typeof handle.close !== 'function') invalid(field);
      await handle.sync();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try { await handle?.close?.(); }
      catch (closeError) { if (!failure) throw closeError; }
    }
  }
  async flushDirectories(directories) {
    const unique = [...new Set(directories.map(directory => path.resolve(directory)))];
    const durableFs = this.durabilityAuthority();
    if (!durableFs) return;
    if (typeof durableFs.flushDirectoriesAsync === 'function') {
      await durableFs.flushDirectoriesAsync(unique);
      return;
    }
    for (const directory of unique) await durableFs.flushDirectoryAsync(directory);
  }
  containingDirectories(filePath) {
    const directories = [];
    let current = path.dirname(path.resolve(filePath));
    if (current !== this.durabilityRoot && !inside(this.durabilityRoot, current)) invalid('durabilityRoot');
    for (;;) {
      directories.push(current);
      if (current === this.durabilityRoot) return directories;
      const parent = path.dirname(current);
      if (parent === current) invalid('durabilityRoot');
      current = parent;
    }
  }
  async syncPublishedFile(filePath, directories, field) {
    await this.syncFile(filePath, field);
    await this.flushDirectories(directories);
  }
  async publishArtifactTemporary(temporary, entry, sha256) {
    const durableFs = this.durabilityAuthority();
    if (typeof durableFs?.renameDurableAsync === 'function') {
      return durableFs.renameDurableAsync(temporary, entry, { expectedSourceSha256: sha256 });
    }
    return this.fs.rename(temporary, entry);
  }
  async verifyEntry({ sha256, size }) {
    const entry = this.pathForSha256(sha256); if (!validSize(size)) invalid('size');
    try { if (!await this.hashFile(entry, { sha256, size, root: this.root, field: 'cache' })) throw new Error('cache mismatch'); return true; }
    catch (error) { if (error?.code === 'ENOENT' || error instanceof ModpackError) return false; await this.fs.rm(entry, { force: true }).catch(() => {}); return false; }
  }
  async commitPart({ partialPath, sha256, measuredSize }) {
    if (typeof partialPath !== 'string' || !partialPath || !validSize(measuredSize)) invalid('partialPath');
    const source = path.resolve(partialPath); if (!inside(this.root, source)) invalid('partialPath'); await this.assertSafePath(source, this.root, 'partialPath', { requireFile: true }); const entry = this.pathForSha256(sha256);
    await this.ensureControlledDirectory(path.dirname(entry), this.root, 'cache');
    const containingDirectories = this.containingDirectories(entry);
    if (await this.verifyEntry({ sha256, size: measuredSize })) {
      await this.syncPublishedFile(entry, containingDirectories, 'cache');
      await this.fs.rm(source, { force: true }); return entry;
    }
    const temporary = `${entry}.${randomUUID()}.partial`;
    try {
      if (!await this.copyAndVerify(source, temporary, { sha256, size: measuredSize, sourceRoot: this.root, targetRoot: this.root, sourceField: 'partialPath', targetField: 'cache' })) throw new ModpackError('HASH_MISMATCH', 'Artifact cache bytes did not match the measured digest');
      try { await this.publishArtifactTemporary(temporary, entry, sha256); }
      catch (error) { if (!error || !['EEXIST', 'EPERM', 'TARGET_EXISTS'].includes(error.code) || !await this.verifyEntry({ sha256, size: measuredSize })) throw error; await this.fs.rm(temporary, { force: true }); }
      if (!await this.verifyEntry({ sha256, size: measuredSize })) throw new ModpackError('HASH_MISMATCH', 'Artifact cache commit could not be verified');
      await this.syncPublishedFile(entry, containingDirectories, 'cache');
      await this.fs.rm(source, { force: true }); return entry;
    } catch (error) { await this.fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
  validateVerifiedSet(verifiedSet) {
    if (!verifiedSet || verifiedSet.type !== 'verified-artifact-set' || !verifiedSet.artifactSet || typeof verifiedSet.artifactSet !== 'object') invalid('verifiedSet');
    const set = verifiedSet.artifactSet;
    if (!Array.isArray(set.parts) || !set.parts.length || typeof set.primaryPartId !== 'string' || !SHA256.test(set.setDigest || '') || !['single', 'multipart'].includes(set.kind) || !['single', 'part-number', 'rar-rxx', 'numbered-volume'].includes(set.groupingScheme) || typeof set.providerImmutable !== 'boolean' || !['unavailable', 'unverified', 'verified'].includes(set.attestationStatus) || (set.kind === 'single' && (set.parts.length !== 1 || set.groupingScheme !== 'single')) || (set.kind === 'multipart' && (set.parts.length < 2 || set.groupingScheme === 'single'))) invalid('verifiedSet');
    const ids = new Set(); const aliases = new Set(); const parts = set.parts.map((part) => {
      if (!part || typeof part !== 'object' || !PART_ID.test(part.partId || '') || !isSafeWindowsBasename(part.fileName) || !validSize(part.size) || part.size !== part.measuredSize || !validSize(part.measuredSize) || !part.calculatedDigests || !SHA256.test(part.calculatedDigests.sha256 || '') || !SHA512.test(part.calculatedDigests.sha512 || '')) invalid('verifiedSet');
      if (ids.has(part.partId)) invalid('verifiedSet'); ids.add(part.partId); const alias = windowsBasenameCollisionKey(part.fileName); if (aliases.has(alias)) invalid('verifiedSet'); aliases.add(alias); return part;
    });
    if (!ids.has(set.primaryPartId) || computeArtifactSetDigest(parts) !== set.setDigest) invalid('verifiedSet'); return { parts, primary: parts.find((part) => part.partId === set.primaryPartId) };
  }
  async assertFreshDirectDestination(destination) {
    if (typeof destination !== 'string' || !destination) invalid('destination'); const resolved = path.resolve(destination); if (!inside(this.workspaceRoot, resolved) || path.dirname(resolved) !== this.workspaceRoot || !isSafeWindowsBasename(path.basename(resolved))) invalid('destination');
    await this.controlledRoot(this.workspaceRoot, 'destination');
    for (const candidate of [resolved]) { try { await this.fs.lstat(candidate); invalid('destination'); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
    return resolved;
  }
  async materializeSet(verifiedSet, destination) {
    const { parts, primary } = this.validateVerifiedSet(verifiedSet); const published = await this.assertFreshDirectDestination(destination);
    const staging = path.join(this.workspaceRoot, `.${path.basename(published)}.${randomUUID()}.partial`); await this.assertSafePath(staging, this.workspaceRoot, 'destination'); await this.fs.mkdir(staging, { recursive: false });
    try {
      for (const part of parts) { const target = path.join(staging, part.fileName); if (!await this.copyAndVerify(this.pathForSha256(part.calculatedDigests.sha256), target, { ...part.calculatedDigests, size: part.measuredSize, sourceRoot: this.root, targetRoot: this.workspaceRoot })) throw new ModpackError('HASH_MISMATCH', 'Artifact cache bytes changed during materialization'); }
      await this.fs.rename(staging, published);
    } catch (error) { await this.fs.rm(staging, { recursive: true, force: true }).catch(() => {}); throw error; }
    return path.join(published, primary.fileName);
  }
  retentionPath() { return path.join(this.root, RETENTION_FILE); }
  async loadRetainedOutcomes() {
    if (this.retainedOutcomes) return this.retainedOutcomes;
    if (!this.retentionLoad) this.retentionLoad = (async () => {
      const target = this.retentionPath();
      await this.assertSafePath(target, this.root, 'retention');
      try {
        const info = await this.fs.lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) invalid('retention');
        const parsed = JSON.parse(await this.fs.readFile(target, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            ![LEGACY_RETENTION_SCHEMA_VERSION, RETENTION_SCHEMA_VERSION].includes(parsed.schemaVersion) ||
            !Array.isArray(parsed.entries)) invalid('retention');
        const legacyRetainedAt = Math.trunc(Number(info.mtimeMs));
        if (!Number.isSafeInteger(legacyRetainedAt) || legacyRetainedAt < 0) invalid('retention');
        const result = new Map();
        for (const entry of parsed.entries) {
          const expectedKeys = parsed.schemaVersion === LEGACY_RETENTION_SCHEMA_VERSION ? 2 : 3;
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== expectedKeys) invalid('retention');
          const id = ownerId(entry.ownerId);
          if (!Array.isArray(entry.sha256s) || !entry.sha256s.length || result.has(id)) invalid('retention');
          const digests = new Set(entry.sha256s);
          if (digests.size !== entry.sha256s.length || [...digests].some(digest => !SHA256.test(digest))) invalid('retention');
          const retainedAt = parsed.schemaVersion === LEGACY_RETENTION_SCHEMA_VERSION ? legacyRetainedAt : entry.retainedAt;
          if (!Number.isSafeInteger(retainedAt) || retainedAt < 0) invalid('retention');
          result.set(id, { retainedAt, sha256s: digests });
        }
        this.retainedOutcomes = result;
      } catch (error) {
        if (error?.code === 'ENOENT') this.retainedOutcomes = new Map();
        else throw error;
      }
      return this.retainedOutcomes;
    })();
    return this.retentionLoad;
  }
  async persistRetainedOutcomes(outcomes) {
    const entries = [...outcomes.entries()].map(([ownerId, value]) => ({
      ownerId,
      retainedAt: value.retainedAt,
      sha256s: [...value.sha256s].sort()
    }));
    const serialized = JSON.stringify({ schemaVersion: RETENTION_SCHEMA_VERSION, entries });
    const target = this.retentionPath();
    await this.assertSafePath(target, this.root, 'retention');
    const durableFs = this.durabilityAuthority();
    if (typeof durableFs?.writeFileAtomicAsync === 'function') {
      await durableFs.writeFileAtomicAsync(target, serialized, { mode: 0o600, fsyncParent: true });
      try { await this.syncPublishedFile(target, this.containingDirectories(target), 'retention'); }
      catch (error) { throw withCommitPhase(error, 'post-publication'); }
      return;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    await this.assertSafePath(temporary, this.root, 'retention');
    let phase = 'pre-publication';
    try {
      await this.fs.writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await this.syncFile(temporary, 'retention');
      phase = 'post-publication-uncertain';
      await this.fs.rename(temporary, target);
      phase = 'post-publication';
      await this.syncPublishedFile(target, this.containingDirectories(target), 'retention');
    } catch (error) {
      await this.fs.rm(temporary, { force: true }).catch(() => {});
      throw withCommitPhase(error, phase);
    }
  }
  async publishRetainedMutation(current, candidate) {
    try {
      await this.persistRetainedOutcomes(candidate);
      this.retainedOutcomes = candidate;
    } catch (error) {
      if (error?.commitPhase !== 'pre-publication') {
        this.retainedOutcomes = conservativeRetainedUnion(current, candidate);
      }
      throw error;
    }
  }
  async mutateRetainedOutcomes(mutation) {
    return this.withRetainedOutcomes(async outcomes => {
      const candidate = cloneRetainedOutcomes(outcomes);
      const result = await mutation(candidate);
      await this.publishRetainedMutation(outcomes, candidate);
      return result;
    });
  }
  async withRetainedOutcomes(operation) {
    const execute = async () => {
      const outcomes = await this.loadRetainedOutcomes();
      return operation(outcomes);
    };
    const pending = this.retentionMutation.then(execute, execute);
    this.retentionMutation = pending.then(() => undefined, () => undefined);
    return pending;
  }
  async retainForOutcome({ ownerId: retainedOwnerId, sha256s } = {}) {
    const id = ownerId(retainedOwnerId);
    if (!Array.isArray(sha256s) || !sha256s.length || sha256s.some(digest => typeof digest !== 'string' || !SHA256.test(digest))) invalid('sha256s');
    const digests = new Set(sha256s); if (digests.size !== sha256s.length) invalid('sha256s');
    const retainedAt = cacheNow(this.clock);
    return this.mutateRetainedOutcomes(async outcomes => {
      for (const digest of digests) if (!await this.entryExists(digest)) unavailable();
      const current = outcomes.get(id) || { retainedAt, sha256s: new Set() };
      for (const digest of digests) current.sha256s.add(digest);
      outcomes.set(id, current);
      return true;
    });
  }
  async expireRetainedOutcomes(now) {
    return this.withRetainedOutcomes(async outcomes => {
      const candidate = cloneRetainedOutcomes(outcomes);
      let changed = false;
      for (const [id, value] of candidate) {
        if (now >= value.retainedAt && now - value.retainedAt >= RETENTION_AGE_MS) {
          candidate.delete(id);
          changed = true;
        }
      }
      if (!changed) return false;
      await this.publishRetainedMutation(outcomes, candidate);
      return true;
    });
  }
  async retainedDigests() {
    const outcomes = await this.loadRetainedOutcomes();
    return new Set([...outcomes.values()].flatMap(value => [...value.sha256s]));
  }
  async hasRetainedOutcome({ ownerId: retainedOwnerId, sha256 } = {}) {
    const outcomes = await this.loadRetainedOutcomes();
    this.pathForSha256(sha256);
    return outcomes.get(ownerId(retainedOwnerId))?.sha256s.has(sha256) === true;
  }
  async removeRetainedIfUnreferenced({ ownerId: retainedOwnerId, sha256 } = {}) {
    const id = ownerId(retainedOwnerId); this.pathForSha256(sha256);
    const exists = await this.mutateRetainedOutcomes(outcomes => {
      const current = outcomes.get(id);
      if (!current?.sha256s.has(sha256)) return false;
      current.sha256s.delete(sha256);
      if (!current.sha256s.size) outcomes.delete(id);
      return true;
    });
    if (!exists) return { status: 'expired', removed: false };
    if (!await this.entryExists(sha256)) return { status: 'expired', removed: false };
    const removed = await this.removeIfUnreferenced(sha256);
    if (!removed && !await this.entryExists(sha256)) return { status: 'expired', removed: false };
    return { status: removed ? 'removed' : 'retained', removed };
  }
  async hasRetainedDigest(sha256) { return (await this.retainedDigests()).has(sha256); }
  async entryExists(sha256) {
    const entry = this.pathForSha256(sha256);
    await this.assertSafePath(entry, this.root, 'cache');
    try { const info = await this.fs.lstat(entry); return info.isFile() && !info.isSymbolicLink(); }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  }
  async listEntries() {
    const shaRoot = path.join(this.root, 'sha256');
    await this.assertSafePath(shaRoot, this.root, 'cache');
    let prefixes;
    try { prefixes = await this.fs.readdir(shaRoot, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const entries = [];
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || prefix.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const prefixPath = path.join(shaRoot, prefix.name);
      const files = await this.fs.readdir(prefixPath, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink() || !SHA256.test(file.name) || !file.name.startsWith(prefix.name)) continue;
        const entry = path.join(prefixPath, file.name);
        await this.assertSafePath(entry, this.root, 'cache');
        const info = await this.fs.lstat(entry);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        entries.push({ sha256: file.name, path: entry, size: info.size, mtimeMs: info.mtimeMs, identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` });
      }
    }
    return entries;
  }
  async listStalePartials(now) {
    const partialRoot = path.join(this.root, 'partial');
    await this.assertSafePath(partialRoot, this.root, 'partial');
    let files;
    try { files = await this.fs.readdir(partialRoot, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const entries = [];
    for (const file of files) {
      if (!file.isFile() || file.isSymbolicLink() || !/^(?:download|local)-[A-Za-z0-9_-]{1,128}\.partial$/.test(file.name)) continue;
      const entry = path.join(partialRoot, file.name);
      await this.assertSafePath(entry, this.root, 'partial');
      const info = await this.fs.lstat(entry);
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > now - RETENTION_AGE_MS) continue;
      entries.push({ path: entry, size: info.size, identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` });
    }
    return entries;
  }
  async listStalePublicationPartials(now) {
    const shaRoot = path.join(this.root, 'sha256');
    await this.assertSafePath(shaRoot, this.root, 'cache');
    let prefixes;
    try { prefixes = await this.fs.readdir(shaRoot, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const entries = [];
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || prefix.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const prefixPath = path.join(shaRoot, prefix.name);
      await this.assertSafePath(prefixPath, this.root, 'cache');
      const files = await this.fs.readdir(prefixPath, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink() || !file.name.startsWith(prefix.name) || !PUBLICATION_PARTIAL.test(file.name)) continue;
        const entry = path.join(prefixPath, file.name);
        await this.assertSafePath(entry, this.root, 'cache');
        const info = await this.fs.lstat(entry);
        if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > now - RETENTION_AGE_MS) continue;
        entries.push({ path: entry, size: info.size, identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` });
      }
    }
    return entries;
  }
  async deleteListedEntry(entry) {
    await this.assertSafePath(entry.path, this.root, 'cache');
    try {
      const info = await this.fs.lstat(entry.path);
      if (!info.isFile() || info.isSymbolicLink() || `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` !== entry.identity) return false;
      await this.fs.unlink(entry.path);
      return true;
    } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  }
  async deleteListedArtifactIfUnprotected(entry) {
    await this.assertSafePath(entry.path, this.root, 'cache');
    try {
      const prepared = await this.fs.lstat(entry.path);
      if (!prepared.isFile() || prepared.isSymbolicLink() || `${prepared.dev}:${prepared.ino}:${prepared.size}:${prepared.mtimeMs}` !== entry.identity) return false;
      return this.withRetainedOutcomes(async outcomes => {
        const current = await this.fs.lstat(entry.path);
        if (!current.isFile() || current.isSymbolicLink() || `${current.dev}:${current.ino}:${current.size}:${current.mtimeMs}` !== entry.identity) return false;
        const retained = [...outcomes.values()].some(value => value.sha256s.has(entry.sha256));
        if (retained || (this.references.get(entry.sha256) || 0) > 0) return false;
        this.deletingEntries.add(entry.sha256);
        try {
          await this.fs.unlink(entry.path);
          return true;
        } finally {
          this.deletingEntries.delete(entry.sha256);
        }
      });
    } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  }
  async prune({ maxBytes = DEFAULT_MAX_CACHE_BYTES, now = cacheNow(this.clock) } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(now) || now < 0) invalid('prune');
    await this.expireRetainedOutcomes(now);
    const retained = await this.retainedDigests();
    const entries = await this.listEntries(); let total = entries.reduce((sum, entry) => sum + entry.size, 0); let removed = 0; let reclaimedBytes = 0;
    const eligible = entries.filter(entry => !retained.has(entry.sha256) && (this.references.get(entry.sha256) || 0) === 0)
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.sha256.localeCompare(right.sha256));
    for (const entry of eligible) {
      if (entry.mtimeMs > now - RETENTION_AGE_MS && total <= maxBytes) continue;
      if (await this.deleteListedArtifactIfUnprotected(entry)) { total -= entry.size; removed += 1; reclaimedBytes += entry.size; }
    }
    for (const partial of await this.listStalePartials(now)) {
      if (await this.deleteListedEntry(partial)) { removed += 1; reclaimedBytes += partial.size; }
    }
    for (const partial of await this.listStalePublicationPartials(now)) {
      if (await this.deleteListedEntry(partial)) { removed += 1; reclaimedBytes += partial.size; }
    }
    return { removed, reclaimedBytes };
  }
  async removeIfUnreferenced(sha256) {
    const entry = this.pathForSha256(sha256);
    await this.assertSafePath(entry, this.root, 'cache');
    try {
      const info = await this.fs.lstat(entry);
      if (!info.isFile() || info.isSymbolicLink()) invalid('cache');
      return this.deleteListedArtifactIfUnprotected({
        sha256,
        path: entry,
        identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
      });
    } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  }
}
module.exports = { ArtifactCache };
