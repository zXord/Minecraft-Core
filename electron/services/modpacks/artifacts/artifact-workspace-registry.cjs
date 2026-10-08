const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { acquireProcessBoundLocalEndpointLease } = require('../../../utils/process-bound-local-endpoint-lease.cjs');
const { isAppIssuedVerifiedArtifactSet } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/; const SHA256 = /^[a-f0-9]{64}$/; const TTL_MS = 30 * 60 * 1000;
const UUID_V4_SOURCE = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const UUID_V4 = new RegExp(`^${UUID_V4_SOURCE}$`, 'i');
const WORKSPACE_NAME = new RegExp(`^(?:input|output)-${UUID_V4_SOURCE}$`, 'i');
const INTERNAL_WORKSPACE_NAME = /^(?:input|output)-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MATERIALIZATION_PARTIAL_NAME = new RegExp(`^\\.input-${UUID_V4_SOURCE}\\.${UUID_V4_SOURCE}\\.partial$`, 'i');
const QUARANTINE_NAME = new RegExp(`^\\.reclaim-(${UUID_V4_SOURCE})\\.(.+)$`, 'i');
async function defaultRemoveTree({ path: candidate, expectedIdentity }) {
  const before = await fsp.lstat(candidate);
  if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(statIdentity(before), expectedIdentity)) recoveryRequired();
  await fsp.rm(candidate, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}
function invalid(field) { throw new ModpackError('INVALID_REQUEST', 'Workspace request is invalid', { details: { field } }); }
function stale() { throw new ModpackError('PLAN_STALE', 'Workspace reference is stale'); }
function recoveryRequired(cause) { throw new ModpackError('RECOVERY_REQUIRED', 'Artifact workspace recovery requires review', { cause }); }
function assertNoPathFields(value, field = 'value') { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) return value.forEach((entry, index) => assertNoPathFields(entry, `${field}.${index}`)); for (const [key, child] of Object.entries(value)) { if (/(?:^path|path$|directory$)/i.test(key)) invalid(`${field}.${key}`); assertNoPathFields(child, `${field}.${key}`); } }
function clone(value) { try { return structuredClone(value); } catch { invalid('value'); } }
function storedValue(kind, value) { return kind === 'artifact-set' && isAppIssuedVerifiedArtifactSet(value) ? value : clone(value); }
function projectedValue(record) { return record.kind === 'artifact-set' && isAppIssuedVerifiedArtifactSet(record.value) ? record.value : stripPaths(clone(record.value)); }
function stripPaths(value) { if (!value || typeof value !== 'object') return value; if (Array.isArray(value)) return value.map(stripPaths); return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:^path|path$|directory$)/i.test(key)).map(([key, child]) => [key, stripPaths(child)])); }
function samePath(left, right) { const a = path.resolve(left); const b = path.resolve(right); return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b; }
function cacheDigests(verifiedSet) { const parts = verifiedSet?.artifactSet?.parts; if (!Array.isArray(parts)) return []; const digests = new Set(); for (const part of parts) { const digest = part?.calculatedDigests?.sha256; if (!SHA256.test(digest || '')) invalid('verifiedSet'); digests.add(digest); } return [...digests]; }
function sourceBinding(artifactSetId, verifiedSet) {
  const sourceSetDigest = verifiedSet?.artifactSet?.setDigest;
  if (!SHA256.test(sourceSetDigest || '')) invalid('verifiedSet.artifactSet.setDigest');
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(verifiedSet), 'utf8').digest('hex');
  return Object.freeze({ sourceArtifactSetId: artifactSetId, sourceSetDigest, sourceFingerprint });
}

function workspaceEntry(name) {
  if (WORKSPACE_NAME.test(name) || MATERIALIZATION_PARTIAL_NAME.test(name)) return Object.freeze({ name, quarantine: false });
  const match = QUARANTINE_NAME.exec(name);
  if (match && (INTERNAL_WORKSPACE_NAME.test(match[2]) || MATERIALIZATION_PARTIAL_NAME.test(match[2]))) return Object.freeze({ name, quarantine: true });
  return null;
}

function statIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function lstatOrNull(candidate) {
  try { return fs.lstatSync(candidate); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    recoveryRequired(error);
  }
}

function assertPinnedRoot(root, expectedIdentity) {
  let stat;
  try { stat = fs.lstatSync(root); } catch (error) { recoveryRequired(error); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(statIdentity(stat), expectedIdentity)) recoveryRequired();
  assertExactRealPath(root);
  return statIdentity(stat);
}

function assertExactRealPath(candidate) {
  let real;
  try { real = fs.realpathSync.native(candidate); } catch (error) { recoveryRequired(error); }
  if (!samePath(real, candidate)) recoveryRequired();
}

async function assertPlainEntry(candidate, reparseInspector, { root = false } = {}) {
  let before;
  try { before = fs.lstatSync(candidate); } catch (error) { recoveryRequired(error); }
  if (before.isSymbolicLink() || (root ? !before.isDirectory() : !(before.isDirectory() || before.isFile()))) recoveryRequired();
  let reparse;
  try { reparse = await reparseInspector.isReparsePoint(candidate); } catch (error) { recoveryRequired(error); }
  if (reparse !== false) recoveryRequired();
  assertExactRealPath(candidate);
  let after;
  try { after = fs.lstatSync(candidate); } catch (error) { recoveryRequired(error); }
  if (!sameIdentity(statIdentity(before), statIdentity(after)) || before.isDirectory() !== after.isDirectory() ||
      before.isFile() !== after.isFile() || after.isSymbolicLink() || (after.isFile() && Number(after.nlink) !== 1)) recoveryRequired();
  return Object.freeze({ identity: statIdentity(after), directory: after.isDirectory() });
}

async function assertSafeTree(directory, reparseInspector) {
  const root = await assertPlainEntry(directory, reparseInspector, { root: true });
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let names;
    try { names = fs.readdirSync(current).sort(); } catch (error) { recoveryRequired(error); }
    for (const name of names) {
      if (path.basename(name) !== name || name === '.' || name === '..') recoveryRequired();
      const candidate = path.join(current, name);
      const inspected = await assertPlainEntry(candidate, reparseInspector);
      if (inspected.directory) pending.push(candidate);
    }
  }
  const finalRoot = await assertPlainEntry(directory, reparseInspector, { root: true });
  if (!sameIdentity(root.identity, finalRoot.identity)) recoveryRequired();
  return root.identity;
}

async function assertWorkspaceRoot(root, reparseInspector) {
  let stat;
  try { stat = fs.lstatSync(root); } catch (error) { recoveryRequired(error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) recoveryRequired();
  return assertPlainEntry(root, reparseInspector, { root: true });
}

function leaseIdFor(root) {
  const canonical = process.platform === 'win32' ? path.resolve(root).toLocaleLowerCase('en-US') : path.resolve(root);
  return crypto.createHash('sha256').update(`minecraft-core-artifact-workspace-root-v1\0${canonical}`, 'utf8').digest('hex');
}

async function reclaimOrphanedWorkspaces({ root, reparseInspector, reclaimIdFactory, removeTree, assertLease }) {
  assertLease();
  const rootEvidence = await assertWorkspaceRoot(root, reparseInspector);
  assertLease();
  let names;
  try { names = fs.readdirSync(root).sort(); } catch (error) { recoveryRequired(error); }
  const entries = [];
  for (const name of names) {
    const classification = workspaceEntry(name);
    if (!classification) recoveryRequired();
    const candidate = path.join(root, name);
    const identity = await assertSafeTree(candidate, reparseInspector);
    assertLease();
    entries.push({ ...classification, path: candidate, identity });
  }
  const rootAfterScan = await assertWorkspaceRoot(root, reparseInspector);
  assertLease();
  if (!sameIdentity(rootEvidence.identity, rootAfterScan.identity)) recoveryRequired();

  const quarantines = [];
  for (const entry of entries) {
    if (entry.quarantine) {
      quarantines.push({ path: entry.path, identity: entry.identity });
      continue;
    }
    let quarantine;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = reclaimIdFactory();
      if (typeof id !== 'string' || !UUID_V4.test(id)) recoveryRequired();
      quarantine = path.join(root, `.reclaim-${id}.${entry.name}`);
      if (lstatOrNull(quarantine) === null) break;
      quarantine = null;
    }
    if (!quarantine) recoveryRequired();
    try { fs.renameSync(entry.path, quarantine); } catch (error) { recoveryRequired(error); }
    let moved;
    try { moved = fs.lstatSync(quarantine); } catch (error) { recoveryRequired(error); }
    if (!sameIdentity(entry.identity, statIdentity(moved)) || lstatOrNull(entry.path) !== null) recoveryRequired();
    quarantines.push({ path: quarantine, identity: entry.identity });
  }

  for (const quarantine of quarantines) {
    await assertSafeTree(quarantine.path, reparseInspector);
    assertLease();
    let removalError = null;
    try {
      await removeTree({
        path: quarantine.path,
        expectedIdentity: quarantine.identity,
        rootPath: root,
        rootIdentity: rootEvidence.identity
      });
    } catch (error) { removalError = error; }
    assertLease();
    assertPinnedRoot(root, rootEvidence.identity);
    if (lstatOrNull(quarantine.path) !== null) recoveryRequired(removalError);
  }
  const finalRoot = await assertWorkspaceRoot(root, reparseInspector);
  if (!sameIdentity(rootEvidence.identity, finalRoot.identity)) recoveryRequired();
  let remaining;
  try { remaining = fs.readdirSync(root); } catch (error) { recoveryRequired(error); }
  if (remaining.length) recoveryRequired();
  return rootEvidence.identity;
}

class ArtifactWorkspaceRegistry {
  constructor({ root, artifactCache = null, clock = () => Date.now(), idFactory = () => crypto.randomUUID(), ttlMs = TTL_MS,
    rootLease = null, rootIdentity = null, reparseInspector = null, reclaimIdFactory = () => crypto.randomUUID(),
    removeTree = defaultRemoveTree, renameWorkspace = (source, destination) => fsp.rename(source, destination) } = {}) {
    if (typeof root !== 'string' || !root || typeof clock !== 'function' || typeof idFactory !== 'function' ||
        typeof reclaimIdFactory !== 'function' || typeof removeTree !== 'function' || typeof renameWorkspace !== 'function' ||
        (reparseInspector !== null && typeof reparseInspector?.isReparsePoint !== 'function') ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1) invalid('constructor');
    this.root = path.resolve(root); this.artifactCache = artifactCache; this.clock = clock; this.idFactory = idFactory; this.ttlMs = ttlMs;
    this.records = new Map(); this.allocatedIds = new Set(); this.busyOwners = new Set(); this.consumedOwners = new Set();
    this.ownerReleases = new Map(); this.rootLease = rootLease; this.reparseInspector = reparseInspector;
    this.reclaimIdFactory = reclaimIdFactory; this.removeTree = removeTree; this.renameWorkspace = renameWorkspace;
    this.disposed = false; fs.mkdirSync(this.root, { recursive: true });
    const capturedRootIdentity = statIdentity(fs.lstatSync(this.root));
    this.rootIdentity = rootIdentity || capturedRootIdentity;
    assertPinnedRoot(this.root, this.rootIdentity);
  }
  static async open({ root, artifactCache = null, clock = () => Date.now(), idFactory = () => crypto.randomUUID(), ttlMs = TTL_MS,
    reparseInspector, acquireRootLease = acquireProcessBoundLocalEndpointLease, reclaimIdFactory = () => crypto.randomUUID(),
    removeTree = defaultRemoveTree } = {}) {
    if (typeof root !== 'string' || !root || !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
        typeof acquireRootLease !== 'function' || typeof reclaimIdFactory !== 'function' || typeof removeTree !== 'function' ||
        typeof clock !== 'function' || typeof idFactory !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1) invalid('constructor');
    const resolvedRoot = path.resolve(root);
    try { fs.mkdirSync(resolvedRoot, { recursive: true }); } catch (error) { recoveryRequired(error); }
    let rootLease;
    try {
      rootLease = await acquireRootLease({ namespace: 'minecraft-core-workspaces', leaseId: leaseIdFor(resolvedRoot) });
      rootLease.assertHeld();
      const rootIdentity = await reclaimOrphanedWorkspaces({
        root: resolvedRoot,
        reparseInspector,
        reclaimIdFactory,
        removeTree,
        assertLease: () => rootLease.assertHeld()
      });
      rootLease.assertHeld();
      return new ArtifactWorkspaceRegistry({
        root: resolvedRoot,
        artifactCache,
        clock,
        idFactory,
        ttlMs,
        rootLease,
        rootIdentity,
        reparseInspector,
        reclaimIdFactory,
        removeTree
      });
    } catch (error) {
      if (rootLease) await rootLease.close().catch(() => {});
      if (error?.code === 'RECOVERY_REQUIRED' || error?.code === 'INVALID_REQUEST') throw error;
      recoveryRequired(error);
    }
  }
  assertLease() {
    if (this.disposed) recoveryRequired();
    this.rootLease?.assertHeld();
    assertPinnedRoot(this.root, this.rootIdentity);
  }
  createPlanningSession() { this.assertLease(); const id = this.newId('planning'); this.allocatedIds.add(id); return id; }
  newId(kind) { for (let attempt = 0; attempt < 10; attempt += 1) { const value = this.idFactory(); if (typeof value !== 'string' || !OWNER.test(value)) invalid('idFactory'); const id = `${kind}-${value}`; if (!this.records.has(id) && !this.allocatedIds.has(id)) return id; } throw new Error('Unable to allocate workspace ID'); }
  assertOwner(ownerId) { if (typeof ownerId !== 'string' || !OWNER.test(ownerId)) invalid('ownerId'); }
  assertAvailable(ownerId) {
    this.assertLease(); this.assertOwner(ownerId);
    if (this.busyOwners.has(ownerId) || this.ownerReleases.has(ownerId)) stale();
  }
  addRecord({ ownerId, kind, value, workspacePath, cacheDigests: digests = [] }) { this.assertAvailable(ownerId); const id = this.newId(kind); this.allocatedIds.add(id); this.records.set(id, { id, ownerId, kind, value: storedValue(kind, value), ...(workspacePath ? { path: workspacePath } : {}), cacheReleaseIndex: 0, cacheDigests: [...digests], lastUsedAt: this.clock(), pinned: false, pending: false }); return id; }
  registerVerifiedSet({ ownerId, verifiedSet } = {}) {
    this.assertAvailable(ownerId); if (!verifiedSet || verifiedSet.type !== 'verified-artifact-set') invalid('verifiedSet'); assertNoPathFields(verifiedSet, 'verifiedSet'); const digests = cacheDigests(verifiedSet);
    const retained = [];
    try { for (const digest of digests) { this.artifactCache?.retain?.(digest); retained.push(digest); } return this.addRecord({ ownerId, kind: 'artifact-set', value: verifiedSet, cacheDigests: digests }); }
    catch (error) { for (const digest of retained) this.artifactCache?.release?.(digest); throw error; }
  }
  _resolve({ ownerId, id, kind } = {}, { allowPending = false } = {}) {
    this.assertLease(); this.assertOwner(ownerId);
    if (this.busyOwners.has(ownerId) || this.ownerReleases.has(ownerId)) stale();
    if (typeof id !== 'string' || typeof kind !== 'string') invalid('id'); const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId || record.kind !== kind || (record.pending && !allowPending) || (!record.pinned && this.clock() - record.lastUsedAt >= this.ttlMs)) stale(); record.lastUsedAt = this.clock(); return record;
  }
  project(record) { const projected = { id: record.id, kind: record.kind, value: projectedValue(record) }; if (record.kind === 'inspection') projected.result = stripPaths(clone(record.value.result)); return deepFreeze(projected); }
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
    const id = this.newId('input'); this.allocatedIds.add(id); const workspacePath = path.join(this.root, id); const record = { id, ownerId, kind: 'input', value: binding, path: workspacePath, identity: null, cleanupPath: null, cleanupState: 'owned', cacheReleaseIndex: 0, cacheDigests: [], lastUsedAt: this.clock(), pinned: false, pending: true };
    this.records.set(id, record); this.busyOwners.add(ownerId);
    try {
      const primaryPath = await this.artifactCache.materializeSet(artifact.value, workspacePath);
      this.assertLease();
      record.identity = await this.#assertExactDirectory(workspacePath, null);
      record.value = { primaryPath, ...binding }; record.pending = false; record.lastUsedAt = this.clock(); return id;
    } catch (error) {
      record.pending = false;
      this.busyOwners.delete(ownerId);
      try { await this.releaseOwner(ownerId); } catch { /* preserve the materialization failure */ }
      throw error;
    }
    finally { this.busyOwners.delete(ownerId); }
  }
  createStagingOutput({ ownerId } = {}) {
    this.assertAvailable(ownerId);
    const id = this.newId('output'); this.allocatedIds.add(id); const workspacePath = path.join(this.root, id);
    fs.mkdirSync(workspacePath, { recursive: false });
    const identity = statIdentity(fs.lstatSync(workspacePath));
    this.records.set(id, { id, ownerId, kind: 'output', value: {}, path: workspacePath, identity, cleanupPath: null,
      cleanupState: 'owned', cacheReleaseIndex: 0, cacheDigests: [], lastUsedAt: this.clock(), pinned: false, pending: false });
    return id;
  }
  createInspection({ ownerId, artifactSetId, result } = {}) { this._resolve({ ownerId, id: artifactSetId, kind: 'artifact-set' }); assertNoPathFields(result, 'result'); return this.addRecord({ ownerId, kind: 'inspection', value: { artifactSetId, result } }); }
  transferOwnership({ fromOwnerId, toOwnerId } = {}) {
    this.assertAvailable(fromOwnerId); this.assertAvailable(toOwnerId); if (fromOwnerId === toOwnerId || this.consumedOwners.has(fromOwnerId)) stale(); const records = [...this.records.values()].filter((record) => record.ownerId === fromOwnerId); const now = this.clock();
    if (!records.length || records.some((record) => record.pending || (!record.pinned && now - record.lastUsedAt >= this.ttlMs))) stale();
    for (const record of records) { record.ownerId = toOwnerId; record.lastUsedAt = now; record.pinned = true; } this.consumedOwners.add(fromOwnerId); return records.length;
  }
  async #assertExactDirectory(candidate, expectedIdentity) {
    this.assertLease();
    let before = lstatOrNull(candidate);
    if (before === null) return null;
    const beforeIdentity = statIdentity(before);
    if (!before.isDirectory() || before.isSymbolicLink() || (expectedIdentity && !sameIdentity(beforeIdentity, expectedIdentity))) recoveryRequired();
    if (this.reparseInspector) {
      let reparse;
      try { reparse = await this.reparseInspector.isReparsePoint(candidate); } catch (error) { recoveryRequired(error); }
      this.assertLease();
      if (reparse !== false) recoveryRequired();
      before = lstatOrNull(candidate);
      if (before === null || !before.isDirectory() || before.isSymbolicLink() ||
          !sameIdentity(beforeIdentity, statIdentity(before))) recoveryRequired();
    }
    assertExactRealPath(candidate);
    return beforeIdentity;
  }

  #allocateQuarantine(record) {
    if (!INTERNAL_WORKSPACE_NAME.test(record.id)) recoveryRequired();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let reclaimId;
      try { reclaimId = this.reclaimIdFactory(); } catch (error) { recoveryRequired(error); }
      if (typeof reclaimId !== 'string' || !UUID_V4.test(reclaimId)) recoveryRequired();
      const candidate = path.join(this.root, `.reclaim-${reclaimId}.${record.id}`);
      if (lstatOrNull(candidate) === null) return candidate;
    }
    recoveryRequired();
  }

  async #quarantineRecord(record) {
    if (!record.path || record.cleanupState === 'absent') return;
    const source = path.join(this.root, record.id);
    if (!samePath(record.path, source) || path.dirname(source) !== this.root) recoveryRequired();
    record.cleanupPath ||= this.#allocateQuarantine(record);
    const quarantine = record.cleanupPath;
    if (path.dirname(quarantine) !== this.root || !workspaceEntry(path.basename(quarantine))?.quarantine) recoveryRequired();

    const sourceStat = lstatOrNull(source);
    const quarantineStat = lstatOrNull(quarantine);
    if (sourceStat && quarantineStat) recoveryRequired();
    if (quarantineStat) {
      if (!record.identity || !sameIdentity(statIdentity(quarantineStat), record.identity)) recoveryRequired();
      await this.#assertExactDirectory(quarantine, record.identity);
      if (lstatOrNull(source) !== null) recoveryRequired();
      record.cleanupState = 'quarantined';
      return;
    }
    if (!sourceStat) {
      record.cleanupState = 'absent';
      return;
    }
    const identity = await this.#assertExactDirectory(source, record.identity);
    record.identity ||= identity;
    let renameError = null;
    try { await this.renameWorkspace(source, quarantine); }
    catch (error) { renameError = error; }
    this.assertLease();
    const sourceAfter = lstatOrNull(source);
    const quarantineAfter = lstatOrNull(quarantine);
    if (!sourceAfter && quarantineAfter && sameIdentity(statIdentity(quarantineAfter), record.identity)) {
      await this.#assertExactDirectory(quarantine, record.identity);
      record.cleanupState = 'quarantined';
      return;
    }
    if (sourceAfter && !quarantineAfter && sameIdentity(statIdentity(sourceAfter), record.identity) && renameError) throw renameError;
    recoveryRequired(renameError);
  }

  async #deleteQuarantinedRecord(record) {
    await this.#quarantineRecord(record);
    if (!record.path || record.cleanupState === 'absent') return;
    const source = path.join(this.root, record.id);
    const quarantine = record.cleanupPath;
    const identity = await this.#assertExactDirectory(quarantine, record.identity);
    if (!identity || lstatOrNull(source) !== null) recoveryRequired();
    let removalError = null;
    try {
      await this.removeTree({
        path: quarantine,
        expectedIdentity: record.identity,
        rootPath: this.root,
        rootIdentity: this.rootIdentity
      });
    } catch (error) { removalError = error; }
    this.assertLease();
    const sourceAfter = lstatOrNull(source);
    const quarantineAfter = lstatOrNull(quarantine);
    if (!sourceAfter && !quarantineAfter) {
      record.cleanupState = 'absent';
      return;
    }
    if (!sourceAfter && quarantineAfter && sameIdentity(statIdentity(quarantineAfter), record.identity) && removalError) throw removalError;
    recoveryRequired(removalError);
  }

  async #executeOwnerRelease(state) {
    this.assertLease();
    const records = state.recordIds.map((id) => {
      const record = this.records.get(id);
      if (!record || record.ownerId !== state.ownerId) recoveryRequired();
      return record;
    });
    for (const record of records) if (record.path) await this.#quarantineRecord(record);
    for (const record of records) if (record.path) await this.#deleteQuarantinedRecord(record);
    this.assertLease();
    for (const record of records) {
      while (record.cacheReleaseIndex < record.cacheDigests.length) {
        this.artifactCache?.release?.(record.cacheDigests[record.cacheReleaseIndex]);
        record.cacheReleaseIndex += 1;
      }
    }
    for (const record of records) this.records.delete(record.id);
    return state.total;
  }

  #runOwnerRelease(state) {
    if (state.inFlight) return state.inFlight;
    const execution = this.#executeOwnerRelease(state);
    state.inFlight = execution.then(
      (released) => {
        if (this.ownerReleases.get(state.ownerId) === state) this.ownerReleases.delete(state.ownerId);
        return released;
      },
      (error) => {
        state.inFlight = null;
        state.lastError = error;
        throw error;
      }
    );
    return state.inFlight;
  }

  #startOwnerRelease(ownerId, recordIds, full) {
    const state = { ownerId, recordIds: Object.freeze([...recordIds]), total: recordIds.length, full, inFlight: null, lastError: null };
    this.ownerReleases.set(ownerId, state);
    return this.#runOwnerRelease(state);
  }

  releaseOwner(ownerId) {
    this.assertLease();
    this.assertOwner(ownerId);
    const existing = this.ownerReleases.get(ownerId);
    if (existing) {
      const resumed = this.#runOwnerRelease(existing);
      if (existing.full) return resumed;
      return resumed.then((released) => this.releaseOwner(ownerId).then((remaining) => released + remaining));
    }
    if (this.busyOwners.has(ownerId)) stale();
    const recordIds = [...this.records.values()].filter(record => record.ownerId === ownerId).map(record => record.id);
    return this.#startOwnerRelease(ownerId, recordIds, true);
  }

  async sweepExpired(now = this.clock()) {
    this.assertLease();
    if (!Number.isFinite(now)) invalid('now');
    const byOwner = new Map();
    for (const record of this.records.values()) {
      if (record.pinned || record.pending || this.busyOwners.has(record.ownerId) || this.ownerReleases.has(record.ownerId) ||
          now - record.lastUsedAt < this.ttlMs) continue;
      if (!byOwner.has(record.ownerId)) byOwner.set(record.ownerId, []);
      byOwner.get(record.ownerId).push(record.id);
    }
    let removed = 0;
    for (const [ownerId, recordIds] of byOwner) removed += await this.#startOwnerRelease(ownerId, recordIds, false);
    return removed;
  }
  async dispose() {
    if (this.disposed || !this.rootLease) return false;
    if (this.records.size || this.busyOwners.size || this.ownerReleases.size) return false;
    const lease = this.rootLease;
    await lease.close();
    this.rootLease = null;
    this.disposed = true;
    return true;
  }
}
module.exports = { ArtifactWorkspaceRegistry, TTL_MS };
