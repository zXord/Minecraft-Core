const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ModpackError, deepFreeze } = require('../errors.cjs');

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/; const SHA256 = /^[a-f0-9]{64}$/; const TTL_MS = 30 * 60 * 1000;
function invalid(field) { throw new ModpackError('INVALID_REQUEST', 'Workspace request is invalid', { details: { field } }); }
function stale() { throw new ModpackError('PLAN_STALE', 'Workspace reference is stale'); }
function assertNoPathFields(value, field = 'value') { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) return value.forEach((entry, index) => assertNoPathFields(entry, `${field}.${index}`)); for (const [key, child] of Object.entries(value)) { if (/(?:^path|path$|directory$)/i.test(key)) invalid(`${field}.${key}`); assertNoPathFields(child, `${field}.${key}`); } }
function clone(value) { try { return structuredClone(value); } catch { invalid('value'); } }
function stripPaths(value) { if (!value || typeof value !== 'object') return value; if (Array.isArray(value)) return value.map(stripPaths); return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:^path|path$|directory$)/i.test(key)).map(([key, child]) => [key, stripPaths(child)])); }
function samePath(left, right) { const a = path.resolve(left); const b = path.resolve(right); return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b; }
function cacheDigests(verifiedSet) { const parts = verifiedSet?.artifactSet?.parts; if (!Array.isArray(parts)) return []; const digests = new Set(); for (const part of parts) { const digest = part?.calculatedDigests?.sha256; if (!SHA256.test(digest || '')) invalid('verifiedSet'); digests.add(digest); } return [...digests]; }
function sourceBinding(artifactSetId, verifiedSet) {
  const sourceSetDigest = verifiedSet?.artifactSet?.setDigest;
  if (!SHA256.test(sourceSetDigest || '')) invalid('verifiedSet.artifactSet.setDigest');
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(verifiedSet), 'utf8').digest('hex');
  return Object.freeze({ sourceArtifactSetId: artifactSetId, sourceSetDigest, sourceFingerprint });
}

class ArtifactWorkspaceRegistry {
  constructor({ root, artifactCache = null, clock = () => Date.now(), idFactory = () => crypto.randomUUID(), ttlMs = TTL_MS } = {}) {
    if (typeof root !== 'string' || !root || typeof clock !== 'function' || typeof idFactory !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1) invalid('constructor');
    this.root = path.resolve(root); this.artifactCache = artifactCache; this.clock = clock; this.idFactory = idFactory; this.ttlMs = ttlMs;
    this.records = new Map(); this.allocatedIds = new Set(); this.busyOwners = new Set(); this.consumedOwners = new Set(); fs.mkdirSync(this.root, { recursive: true });
  }
  createPlanningSession() { const id = this.newId('planning'); this.allocatedIds.add(id); return id; }
  newId(kind) { for (let attempt = 0; attempt < 10; attempt += 1) { const value = this.idFactory(); if (typeof value !== 'string' || !OWNER.test(value)) invalid('idFactory'); const id = `${kind}-${value}`; if (!this.records.has(id) && !this.allocatedIds.has(id)) return id; } throw new Error('Unable to allocate workspace ID'); }
  assertOwner(ownerId) { if (typeof ownerId !== 'string' || !OWNER.test(ownerId)) invalid('ownerId'); }
  assertAvailable(ownerId) { this.assertOwner(ownerId); if (this.busyOwners.has(ownerId)) stale(); }
  addRecord({ ownerId, kind, value, workspacePath, cacheDigests: digests = [] }) { this.assertAvailable(ownerId); const id = this.newId(kind); this.allocatedIds.add(id); this.records.set(id, { id, ownerId, kind, value: clone(value), ...(workspacePath ? { path: workspacePath } : {}), cacheDigests: [...digests], lastUsedAt: this.clock(), pinned: false, pending: false }); return id; }
  registerVerifiedSet({ ownerId, verifiedSet } = {}) {
    this.assertAvailable(ownerId); if (!verifiedSet || verifiedSet.type !== 'verified-artifact-set') invalid('verifiedSet'); assertNoPathFields(verifiedSet, 'verifiedSet'); const digests = cacheDigests(verifiedSet);
    const retained = [];
    try { for (const digest of digests) { this.artifactCache?.retain?.(digest); retained.push(digest); } return this.addRecord({ ownerId, kind: 'artifact-set', value: verifiedSet, cacheDigests: digests }); }
    catch (error) { for (const digest of retained) this.artifactCache?.release?.(digest); throw error; }
  }
  _resolve({ ownerId, id, kind } = {}, { allowPending = false } = {}) {
    this.assertOwner(ownerId); if (typeof id !== 'string' || typeof kind !== 'string') invalid('id'); const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId || record.kind !== kind || (record.pending && !allowPending) || (!record.pinned && this.clock() - record.lastUsedAt >= this.ttlMs)) stale(); record.lastUsedAt = this.clock(); return record;
  }
  project(record) { const projected = { id: record.id, kind: record.kind, value: stripPaths(clone(record.value)) }; if (record.kind === 'inspection') projected.result = stripPaths(clone(record.value.result)); return deepFreeze(projected); }
  resolveOwnedId(request) { return this.project(this._resolve(request)); }
  resolveOwnedWorkspace(request) {
    if (!request || !['input', 'output'].includes(request.kind)) invalid('kind');
    const record = this._resolve(request);
    if (typeof record.path !== 'string') stale();
    const candidate = path.resolve(record.path);
    const relative = path.relative(this.root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || candidate !== path.join(this.root, record.id)) stale();
    let rootReal; let candidateReal; let stat;
    try {
      rootReal = fs.realpathSync.native(this.root);
      candidateReal = fs.realpathSync.native(candidate);
      stat = fs.lstatSync(candidate);
    } catch { stale(); }
    const realRelative = path.relative(rootReal, candidateReal);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !realRelative || realRelative.startsWith('..') ||
        path.isAbsolute(realRelative) || !samePath(candidateReal, candidate)) stale();
    return deepFreeze({ id: record.id, kind: record.kind, path: candidate });
  }
  async materializeInput({ ownerId, artifactSetId } = {}) {
    this.assertAvailable(ownerId); const artifact = this._resolve({ ownerId, id: artifactSetId, kind: 'artifact-set' }); if (!this.artifactCache || typeof this.artifactCache.materializeSet !== 'function') invalid('artifactCache');
    const binding = sourceBinding(artifactSetId, artifact.value);
    const id = this.newId('input'); this.allocatedIds.add(id); const workspacePath = path.join(this.root, id); const record = { id, ownerId, kind: 'input', value: binding, path: workspacePath, cacheDigests: [], lastUsedAt: this.clock(), pinned: false, pending: true };
    this.records.set(id, record); this.busyOwners.add(ownerId);
    try { const primaryPath = await this.artifactCache.materializeSet(artifact.value, workspacePath); record.value = { primaryPath, ...binding }; record.pending = false; record.lastUsedAt = this.clock(); return id; }
    catch (error) { this.records.delete(id); fs.rmSync(workspacePath, { recursive: true, force: true }); throw error; }
    finally { this.busyOwners.delete(ownerId); }
  }
  createStagingOutput({ ownerId } = {}) { this.assertAvailable(ownerId); const id = this.newId('output'); this.allocatedIds.add(id); const workspacePath = path.join(this.root, id); fs.mkdirSync(workspacePath, { recursive: false }); this.records.set(id, { id, ownerId, kind: 'output', value: {}, path: workspacePath, cacheDigests: [], lastUsedAt: this.clock(), pinned: false, pending: false }); return id; }
  createInspection({ ownerId, artifactSetId, result } = {}) { this._resolve({ ownerId, id: artifactSetId, kind: 'artifact-set' }); assertNoPathFields(result, 'result'); return this.addRecord({ ownerId, kind: 'inspection', value: { artifactSetId, result } }); }
  transferOwnership({ fromOwnerId, toOwnerId } = {}) {
    this.assertAvailable(fromOwnerId); this.assertAvailable(toOwnerId); if (fromOwnerId === toOwnerId || this.consumedOwners.has(fromOwnerId)) stale(); const records = [...this.records.values()].filter((record) => record.ownerId === fromOwnerId); const now = this.clock();
    if (!records.length || records.some((record) => record.pending || (!record.pinned && now - record.lastUsedAt >= this.ttlMs))) stale();
    for (const record of records) { record.ownerId = toOwnerId; record.lastUsedAt = now; record.pinned = true; } this.consumedOwners.add(fromOwnerId); return records.length;
  }
  removeRecord(id, record) { if (record.path) fs.rmSync(record.path, { recursive: true, force: true }); for (const digest of record.cacheDigests) this.artifactCache?.release?.(digest); this.records.delete(id); }
  releaseOwner(ownerId) { this.assertAvailable(ownerId); let released = 0; for (const [id, record] of this.records) if (record.ownerId === ownerId) { this.removeRecord(id, record); released += 1; } return released; }
  sweepExpired(now = this.clock()) { if (!Number.isFinite(now)) invalid('now'); let removed = 0; for (const [id, record] of this.records) { if (record.pinned || record.pending || this.busyOwners.has(record.ownerId) || now - record.lastUsedAt < this.ttlMs) continue; this.removeRecord(id, record); removed += 1; } return removed; }
}
module.exports = { ArtifactWorkspaceRegistry, TTL_MS };
