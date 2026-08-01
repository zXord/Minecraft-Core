const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ModpackError } = require('../errors.cjs');
const { computeArtifactSetDigest } = require('../contracts.cjs');

const SHA256 = /^[a-f0-9]{64}$/; const SHA512 = /^[a-f0-9]{128}$/; const PART_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEVICES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);
function invalid(field) { throw new ModpackError('INVALID_REQUEST', 'Artifact cache request is invalid', { details: { field } }); }
function validSize(size) { return typeof size === 'string' && /^(0|[1-9][0-9]*)$/.test(size); }
function safeBasename(name) {
  if (typeof name !== 'string' || name !== path.basename(name) || name === '.' || name === '..' || name !== name.trim() || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) return false;
  return !DEVICES.has(name.split('.', 1)[0].replace(/[ .]+$/g, '').toUpperCase());
}
function inside(parent, child) { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); }

class ArtifactCache {
  constructor({ root, workspaceRoot, fsApi = fs, clock = () => Date.now() } = {}) {
    if (typeof root !== 'string' || !root || typeof workspaceRoot !== 'string' || !workspaceRoot) invalid('root');
    this.root = path.resolve(root); this.workspaceRoot = path.resolve(workspaceRoot); this.fs = fsApi; this.clock = clock; this.references = new Map();
  }
  pathForSha256(digest) { if (typeof digest !== 'string' || !SHA256.test(digest)) invalid('sha256'); return path.join(this.root, 'sha256', digest.slice(0, 2), digest); }
  retain(sha256) { this.pathForSha256(sha256); this.references.set(sha256, (this.references.get(sha256) || 0) + 1); }
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
  async verifyEntry({ sha256, size }) {
    const entry = this.pathForSha256(sha256); if (!validSize(size)) invalid('size');
    try { if (!await this.hashFile(entry, { sha256, size, root: this.root, field: 'cache' })) throw new Error('cache mismatch'); return true; }
    catch (error) { if (error?.code === 'ENOENT' || error instanceof ModpackError) return false; await this.fs.rm(entry, { force: true }).catch(() => {}); return false; }
  }
  async commitPart({ partialPath, sha256, measuredSize }) {
    if (typeof partialPath !== 'string' || !partialPath || !validSize(measuredSize)) invalid('partialPath');
    const source = path.resolve(partialPath); if (!inside(this.root, source)) invalid('partialPath'); await this.assertSafePath(source, this.root, 'partialPath', { requireFile: true }); const entry = this.pathForSha256(sha256);
    await this.ensureControlledDirectory(path.dirname(entry), this.root, 'cache');
    if (await this.verifyEntry({ sha256, size: measuredSize })) { await this.fs.rm(source, { force: true }); return entry; }
    const temporary = `${entry}.${randomUUID()}.partial`;
    try {
      if (!await this.copyAndVerify(source, temporary, { sha256, size: measuredSize, sourceRoot: this.root, targetRoot: this.root, sourceField: 'partialPath', targetField: 'cache' })) throw new ModpackError('HASH_MISMATCH', 'Artifact cache bytes did not match the measured digest');
      try { await this.fs.rename(temporary, entry); }
      catch (error) { if (!error || (error.code !== 'EEXIST' && error.code !== 'EPERM') || !await this.verifyEntry({ sha256, size: measuredSize })) throw error; await this.fs.rm(temporary, { force: true }); }
      if (!await this.verifyEntry({ sha256, size: measuredSize })) throw new ModpackError('HASH_MISMATCH', 'Artifact cache commit could not be verified');
      await this.fs.rm(source, { force: true }); return entry;
    } catch (error) { await this.fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
  validateVerifiedSet(verifiedSet) {
    if (!verifiedSet || verifiedSet.type !== 'verified-artifact-set' || !verifiedSet.artifactSet || typeof verifiedSet.artifactSet !== 'object') invalid('verifiedSet');
    const set = verifiedSet.artifactSet;
    if (!Array.isArray(set.parts) || !set.parts.length || typeof set.primaryPartId !== 'string' || !SHA256.test(set.setDigest || '') || !['single', 'multipart'].includes(set.kind) || !['single', 'part-number', 'rar-rxx', 'numbered-volume'].includes(set.groupingScheme) || typeof set.providerImmutable !== 'boolean' || !['unavailable', 'unverified', 'verified'].includes(set.attestationStatus) || (set.kind === 'single' && (set.parts.length !== 1 || set.groupingScheme !== 'single')) || (set.kind === 'multipart' && (set.parts.length < 2 || set.groupingScheme === 'single'))) invalid('verifiedSet');
    const ids = new Set(); const aliases = new Set(); const parts = set.parts.map((part) => {
      if (!part || typeof part !== 'object' || !PART_ID.test(part.partId || '') || !safeBasename(part.fileName) || !validSize(part.size) || part.size !== part.measuredSize || !validSize(part.measuredSize) || !part.calculatedDigests || !SHA256.test(part.calculatedDigests.sha256 || '') || !SHA512.test(part.calculatedDigests.sha512 || '')) invalid('verifiedSet');
      if (ids.has(part.partId)) invalid('verifiedSet'); ids.add(part.partId); const alias = part.fileName.normalize('NFC').toLocaleLowerCase('en-US'); if (aliases.has(alias)) invalid('verifiedSet'); aliases.add(alias); return part;
    });
    if (!ids.has(set.primaryPartId) || computeArtifactSetDigest(parts) !== set.setDigest) invalid('verifiedSet'); return { parts, primary: parts.find((part) => part.partId === set.primaryPartId) };
  }
  async assertFreshDirectDestination(destination) {
    if (typeof destination !== 'string' || !destination) invalid('destination'); const resolved = path.resolve(destination); if (!inside(this.workspaceRoot, resolved) || path.dirname(resolved) !== this.workspaceRoot || !safeBasename(path.basename(resolved))) invalid('destination');
    await this.controlledRoot(this.workspaceRoot, 'destination');
    for (const candidate of [resolved]) { try { await this.fs.lstat(candidate); invalid('destination'); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
    return resolved;
  }
  async materializeSet(verifiedSet, destination) {
    const { parts, primary } = this.validateVerifiedSet(verifiedSet); const published = await this.assertFreshDirectDestination(destination);
    for (const part of parts) if (!await this.verifyEntry({ sha256: part.calculatedDigests.sha256, size: part.measuredSize })) throw new ModpackError('HASH_MISMATCH', 'Verified artifact cache entry is unavailable');
    const staging = path.join(this.workspaceRoot, `.${path.basename(published)}.${randomUUID()}.partial`); await this.assertSafePath(staging, this.workspaceRoot, 'destination'); await this.fs.mkdir(staging, { recursive: false });
    try {
      for (const part of parts) { const target = path.join(staging, part.fileName); if (!await this.copyAndVerify(this.pathForSha256(part.calculatedDigests.sha256), target, { ...part.calculatedDigests, size: part.measuredSize, sourceRoot: this.root, targetRoot: this.workspaceRoot })) throw new ModpackError('HASH_MISMATCH', 'Artifact cache bytes changed during materialization'); }
      await this.fs.rename(staging, published);
    } catch (error) { await this.fs.rm(staging, { recursive: true, force: true }).catch(() => {}); throw error; }
    return path.join(published, primary.fileName);
  }
  async removeIfUnreferenced(sha256) {
    const entry = this.pathForSha256(sha256); if ((this.references.get(sha256) || 0) > 0) return false;
    await this.assertSafePath(entry, this.root, 'cache');
    try {
      const info = await this.fs.lstat(entry);
      if (!info.isFile() || info.isSymbolicLink()) invalid('cache');
      await this.fs.unlink(entry); return true;
    } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  }
}
module.exports = { ArtifactCache };
