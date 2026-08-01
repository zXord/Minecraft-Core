const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ModpackError } = require('../errors.cjs');

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TTL_MS = 30 * 60 * 1000;

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Workspace request is invalid', { details: { field } });
}

function stale() {
  throw new ModpackError('PLAN_STALE', 'Workspace reference is stale');
}

function assertNoPathFields(value, field = 'value') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPathFields(entry, `${field}.${index}`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|_)(?:path|directory|cachepath|archivepath|inputpath|outputpath)$/i.test(key) || /(?:^path|Path$)/.test(key)) invalid(`${field}.${key}`);
    assertNoPathFields(child, `${field}.${key}`);
  }
}

function clone(value) {
  try { return structuredClone(value); } catch { invalid('value'); }
}

class ArtifactWorkspaceRegistry {
  constructor({ root, artifactCache = null, clock = () => Date.now(), idFactory = () => crypto.randomUUID(), ttlMs = TTL_MS } = {}) {
    if (typeof root !== 'string' || !root || typeof clock !== 'function' || typeof idFactory !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1) invalid('constructor');
    this.root = path.resolve(root);
    this.artifactCache = artifactCache;
    this.clock = clock;
    this.idFactory = idFactory;
    this.ttlMs = ttlMs;
    this.records = new Map();
    this.allocatedIds = new Set();
    fs.mkdirSync(this.root, { recursive: true });
  }

  createPlanningSession() {
    const id = this.newId('planning');
    this.allocatedIds.add(id);
    return id;
  }

  newId(kind) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const value = this.idFactory();
      if (typeof value !== 'string' || !OWNER.test(value)) invalid('idFactory');
      const id = `${kind}-${value}`;
      if (!this.records.has(id) && !this.allocatedIds.has(id)) return id;
    }
    throw new Error('Unable to allocate workspace ID');
  }

  assertOwner(ownerId) {
    if (typeof ownerId !== 'string' || !OWNER.test(ownerId)) invalid('ownerId');
  }

  addRecord({ ownerId, kind, value, workspacePath }) {
    this.assertOwner(ownerId);
    const id = this.newId(kind);
    this.allocatedIds.add(id);
    this.records.set(id, { id, ownerId, kind, value: clone(value), ...(workspacePath ? { path: workspacePath } : {}), lastUsedAt: this.clock() });
    return id;
  }

  registerVerifiedSet({ ownerId, verifiedSet } = {}) {
    this.assertOwner(ownerId);
    if (!verifiedSet || verifiedSet.type !== 'verified-artifact-set') invalid('verifiedSet');
    assertNoPathFields(verifiedSet, 'verifiedSet');
    return this.addRecord({ ownerId, kind: 'artifact-set', value: verifiedSet });
  }

  async materializeInput({ ownerId, artifactSetId } = {}) {
    const artifact = this.resolveOwnedId({ ownerId, id: artifactSetId, kind: 'artifact-set' });
    if (!this.artifactCache || typeof this.artifactCache.materializeSet !== 'function') invalid('artifactCache');
    const id = this.newId('input');
    this.allocatedIds.add(id);
    const workspacePath = path.join(this.root, id);
    const primaryPath = await this.artifactCache.materializeSet(artifact.value, workspacePath);
    this.records.set(id, { id, ownerId, kind: 'input', value: { primaryPath }, path: workspacePath, lastUsedAt: this.clock() });
    return id;
  }

  createStagingOutput({ ownerId } = {}) {
    this.assertOwner(ownerId);
    const id = this.newId('output');
    this.allocatedIds.add(id);
    const workspacePath = path.join(this.root, id);
    fs.mkdirSync(workspacePath, { recursive: false });
    this.records.set(id, { id, ownerId, kind: 'output', value: {}, path: workspacePath, lastUsedAt: this.clock() });
    return id;
  }

  createInspection({ ownerId, artifactSetId, result } = {}) {
    this.resolveOwnedId({ ownerId, id: artifactSetId, kind: 'artifact-set' });
    assertNoPathFields(result, 'result');
    const id = this.addRecord({ ownerId, kind: 'inspection', value: { artifactSetId, result } });
    this.records.get(id).result = clone(result);
    return id;
  }

  resolveOwnedId({ ownerId, id, kind } = {}) {
    this.assertOwner(ownerId);
    if (typeof id !== 'string' || typeof kind !== 'string') invalid('id');
    const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId || record.kind !== kind || this.clock() - record.lastUsedAt >= this.ttlMs) stale();
    record.lastUsedAt = this.clock();
    return record;
  }

  transferOwnership({ fromOwnerId, toOwnerId } = {}) {
    this.assertOwner(fromOwnerId); this.assertOwner(toOwnerId);
    const records = [...this.records.values()].filter((record) => record.ownerId === fromOwnerId);
    const now = this.clock();
    if (records.some((record) => now - record.lastUsedAt >= this.ttlMs)) stale();
    for (const record of records) { record.ownerId = toOwnerId; record.lastUsedAt = now; }
    return records.length;
  }

  releaseOwner(ownerId) {
    this.assertOwner(ownerId);
    let released = 0;
    for (const [id, record] of this.records) {
      if (record.ownerId !== ownerId) continue;
      if (record.path) fs.rmSync(record.path, { recursive: true, force: true });
      this.records.delete(id);
      released += 1;
    }
    return released;
  }

  sweepExpired(now = this.clock()) {
    if (!Number.isFinite(now)) invalid('now');
    let removed = 0;
    for (const [id, record] of this.records) {
      if (now - record.lastUsedAt < this.ttlMs) continue;
      if (record.path) fs.rmSync(record.path, { recursive: true, force: true });
      this.records.delete(id);
      removed += 1;
    }
    return removed;
  }
}

module.exports = { ArtifactWorkspaceRegistry, TTL_MS };
