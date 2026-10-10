const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModpackError } = require('../modpacks/errors.cjs');
const { WindowsReparseInspector } = require('../modpacks/local/windows-reparse-inspector.cjs');
const { normalizeServerDirectoryPath, captureServerDirectoryCopySource, copyServerDirectoryContents,
  identifyServerDirectory, assertServerDirectoryIdentity, inspectServerDirectoryTree, inspectAndFlushServerDirectoryTree } = require('../modpack-lifecycle/server-directory-identity.cjs');
const { copyRegularFile } = require('../modpacks/planning/production-candidate-preparer.cjs');
const { PersistentCandidateHashService } = require('../modpacks/planning/candidate-hash-service.cjs');
const { planOwnership, normalizeClientPackManifest, normalizeEntries } = require('./client-pack-state.cjs');
const { isSafeWindowsBasename } = require('../modpacks/windows-basename.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validUuid = value => typeof value === 'string' && UUID.test(value);
const validSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code = 'RECOVERY_REQUIRED', cause) => new ModpackError(code, 'Client pack publication could not be completed safely', { cause });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameTree = (a, b) => a && b && equal(a.directoryIdentity, b.directoryIdentity) && a.fingerprint === b.fingerprint;
function preparedManifestEvidence(prepared, descriptor, optionalFileIds) {
  if (!prepared || Object.getPrototypeOf(prepared) !== Object.prototype) throw fail();
  const format = Object.getOwnPropertyDescriptor(prepared, 'contentFormat');
  const constraints = Object.getOwnPropertyDescriptor(prepared, 'runtimeConstraints');
  if (!format && !constraints) return { schemaVersion: 1 };
  const choices = Object.getOwnPropertyDescriptor(prepared, 'optionalFileIds');
  if (!format?.enumerable || !Object.hasOwn(format, 'value') || format.value !== 'multimc' ||
      !constraints?.enumerable || !Object.hasOwn(constraints, 'value') ||
      !choices?.enumerable || !Object.hasOwn(choices, 'value') || !Array.isArray(choices.value) || choices.value.length !== 0) throw fail();
  const manifest = normalizeClientPackManifest({ schemaVersion: 2, descriptor, optionalFileIds, entries: [],
    contentFormat: format.value, runtimeConstraints: constraints.value });
  return { schemaVersion: 2, contentFormat: manifest.contentFormat, runtimeConstraints: manifest.runtimeConstraints };
}
const MAX_CLEANUP_ENTRIES = 20000;
const MAX_CLEANUP_BATCH = 256;
const MAX_CLEANUP_BYTES = 8 * 1024 * 1024;
// 20,000 inventory objects with eight fields each, plus chunks and ownership
// metadata. Chunking alone does not reduce strict JSON's total-value count.
const MAX_CLEANUP_JSON_VALUES = 200_000;
const exactKeys = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const nativeIdentity = value => exactKeys(value, ['volumeSerial', 'fileId']) && typeof value.volumeSerial === 'string' && typeof value.fileId === 'string' && /^[a-f0-9]{1,32}$/.test(value.volumeSerial) && /^[a-f0-9]{1,64}$/.test(value.fileId);
const validTree = value => exactKeys(value, ['directoryIdentity', 'fingerprint']) && nativeIdentity(value.directoryIdentity) && validSha256(value.fingerprint);
const packed = entries => Array.from({ length: Math.ceil(entries.length / 1000) }, (_, index) => entries.slice(index * 1000, (index + 1) * 1000));
const deletionOrder = (a, b) => b.path.split('/').filter(Boolean).length - a.path.split('/').filter(Boolean).length || (a.type === b.type ? a.path.localeCompare(b.path, 'en-US') : a.type === 'file' ? -1 : 1);
const statMatches = (stat, entry) => stat.dev.toString() === entry.dev && stat.ino.toString() === entry.ino && stat.birthtimeNs.toString() === entry.birthtime &&
  !stat.isSymbolicLink() && (entry.type === 'directory' ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n && stat.size.toString() === entry.size);
function validateInventory(chunks) {
  if (!Array.isArray(chunks) || chunks.length > 20 || chunks.some(chunk => !Array.isArray(chunk) || chunk.length < 1 || chunk.length > 1000)) throw fail();
  const entries = chunks.flat(); const keys = new Map();
  if (!entries.length || entries.length > MAX_CLEANUP_ENTRIES) throw fail();
  for (const entry of entries) {
    if (!exactKeys(entry, ['path', 'pathKey', 'type', 'size', 'sha256', 'dev', 'ino', 'birthtime']) || typeof entry.path !== 'string' || entry.path.length > 4096 ||
        (entry.path !== '' && (entry.path.split('/').some(part => !isSafeWindowsBasename(part)) || entry.path.split('/').length > 64)) ||
        entry.pathKey !== entry.path.toLowerCase() || keys.has(entry.pathKey) || !['file', 'directory'].includes(entry.type) ||
        !['dev', 'ino', 'birthtime', 'size'].every(key => typeof entry[key] === 'string' && /^(0|[1-9][0-9]*)$/.test(entry[key])) ||
        (entry.type === 'file' ? !validSha256(entry.sha256) : entry.sha256 !== null || entry.size !== '0')) throw fail();
    keys.set(entry.pathKey, entry);
  }
  if (!keys.has('') || entries.find(entry => entry.path === '').type !== 'directory') throw fail();
  for (const entry of entries) {
    const parent = entry.path.split('/').slice(0, -1).join('/').toLowerCase();
    if (entry.path && keys.get(parent)?.type !== 'directory') throw fail();
  }
  return entries;
}
class ClientPackTransaction {
  constructor({ journalRoot, durableFs, stateStore, reparseInspector = process.platform === 'win32' ? new WindowsReparseInspector() : { async isReparsePoint() { return false; } },
    hashServiceFactory = () => new PersistentCandidateHashService() } = {}) {
    if (!journalRoot || !durableFs || !stateStore || typeof hashServiceFactory !== 'function') throw fail('INVALID_REQUEST');
    this.journalRoot = normalizeServerDirectoryPath(journalRoot);
    Object.assign(this, { durableFs, stateStore, reparseInspector, hashServiceFactory });
    this.contexts = new WeakMap();
  }
  _options() { return { reparseInspector: this.reparseInspector }; }
  candidatePathFor(target, operationId) { if (!validUuid(operationId)) throw fail('INVALID_REQUEST'); return this._paths(target, operationId).candidatePath; }
  async assertNoUnsettledAtPath(clientPath) {
    const normalized = normalizeServerDirectoryPath(clientPath);
    const separator = path.win32.isAbsolute(normalized) ? '\\' : path.sep;
    const canonical = normalized.replace(/[\\/]+$/, '');
    // Legacy writers hashed the normalized trailing separator when supplied.
    // Inspect both exact keys without rewriting or orphaning either authority.
    const journalPaths = new Set([canonical, canonical + separator].map(value => this._paths({ clientId: 'path-guard', clientPath: value }).journalPath));
    try {
      for (const journalPath of journalPaths) {
        const bytes = await this.durableFs.readFileBoundedAsync(journalPath, { maxBytes: 1024 * 1024, allowMissing: true });
        if (bytes === null) continue;
        const record = JSON.parse(bytes.toString('utf8'));
        const owner = { clientId: record?.clientId, clientPath: record?.clientPath };
        this._validateRetainedRecord(owner, record);
        // Registry IDs and live native identity may legitimately change after an
        // explicitly emptied/recreated root. The persisted path authority may not.
        if (this._paths(owner).journalPath !== journalPath || !['committed', 'abandoned'].includes(record.phase)) throw fail();
      }
    } catch (cause) { throw fail('RECOVERY_REQUIRED', cause); }
  }
  _paths(target, operationId) {
    if (!target || typeof target.clientId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(target.clientId)) throw fail('INVALID_REQUEST');
    const clientPath = normalizeServerDirectoryPath(target.clientPath);
    const key = hash(process.platform === 'win32' ? clientPath.toLowerCase() : clientPath);
    const result = { clientPath, journalPath: path.join(this.journalRoot, `${key}.json`) };
    if (operationId !== undefined) {
      if (!validUuid(operationId)) throw fail();
      result.candidatePath = path.join(path.dirname(clientPath), `.minecraft-core-client-${operationId}-candidate`);
      result.previousPath = path.join(path.dirname(clientPath), `.minecraft-core-client-${operationId}-previous`);
    }
    return result;
  }
  async _read(target) {
    const { journalPath } = this._paths(target);
    const bytes = await this.durableFs.readFileBoundedAsync(journalPath, { maxBytes: 1024 * 1024, allowMissing: true });
    if (bytes === null) return { record: null, sha256: null };
    try {
      const record = JSON.parse(bytes.toString('utf8'));
      this._validateRetainedRecord(target, record);
      return { record, sha256: hash(bytes) };
    } catch (cause) { throw fail('RECOVERY_REQUIRED', cause); }
  }
  _retainedPaths(target, operationId, role) {
    const paths = this._paths(target, operationId);
    if (!['previous', 'candidate'].includes(role)) throw fail();
    return { ...paths, retainedPath: role === 'previous' ? paths.previousPath : paths.candidatePath,
      proofPath: paths.journalPath.replace(/\.json$/, `.retained-proof-${operationId}-${role}.json`),
      cleanupPath: paths.journalPath.replace(/\.json$/, `.cleanup-${operationId}.json`) };
  }
  async _retainProof(context, role, snapshot) {
    const paths = this._retainedPaths(context.target, context.operationId, role);
    const sourcePath = role === 'previous' ? context.clientPath : context.candidatePath;
    await assertServerDirectoryIdentity(sourcePath, snapshot.directoryIdentity, this._options());
    const stat = await fs.lstat(sourcePath, { bigint: true });
    const root = { path: '', pathKey: '', type: 'directory', size: '0', sha256: null, dev: stat.dev.toString(), ino: stat.ino.toString(), birthtime: stat.birthtimeNs.toString() };
    const entries = [...snapshot.entries, root].sort(deletionOrder);
    const record = this.contexts.get(context)?.record;
    if (!record) throw fail();
    const owner = { schemaVersion: 1, operationId: context.operationId, clientId: context.target.clientId, clientPath: context.clientPath,
      role, parentIdentity: record.parentIdentity, tree: { directoryIdentity: snapshot.directoryIdentity, fingerprint: snapshot.fingerprint } };
    let proof;
    // This auxiliary limit is not a publication limit. A bounded refusal marker
    // keeps ownership provenance without ever authorizing later guessed deletion.
    if (entries.length > MAX_CLEANUP_ENTRIES) proof = { ...owner, retentionReason: 'inventory-entry-limit' };
    else {
      const chunks = packed(entries); validateInventory(chunks);
      proof = { ...owner, entries: chunks };
      if (Buffer.byteLength(`${JSON.stringify(proof, null, 2)}\n`) > MAX_CLEANUP_BYTES) proof = { ...owner, retentionReason: 'inventory-byte-limit' };
    }
    await this.durableFs.writeJsonAtomicAsync(paths.proofPath, proof, { expectedTargetSha256: null, maxJsonValues: MAX_CLEANUP_JSON_VALUES });
  }
  async _write(context, record) {
    const internal = this.contexts.get(context);
    if (!internal) throw fail('INVALID_REQUEST');
    await this.durableFs.writeJsonAtomicAsync(context.journalPath, record, { expectedTargetSha256: internal.sha256 });
    internal.sha256 = hash(`${JSON.stringify(record, null, 2)}\n`);
    internal.record = record;
  }
  async _archiveSettled(target, record) {
    if (!record || !['committed', 'abandoned'].includes(record.phase)) throw fail();
    const { journalPath } = this._paths(target, record.operationId);
    const historyPath = journalPath.replace(/\.json$/, `.history-${record.operationId}.json`);
    const existing = await this.durableFs.readFileBoundedAsync(historyPath, { maxBytes: 1024 * 1024, allowMissing: true });
    if (existing !== null) {
      try { if (!equal(JSON.parse(existing.toString('utf8')), record)) throw fail(); }
      catch (cause) { throw fail('RECOVERY_REQUIRED', cause); }
      return;
    }
    // Keep exact prior ownership durable before replacing the single active slot.
    // Cleanup may later consume this immutable per-operation record; an active
    // phase alone never permits forgetting retained candidate/previous trees.
    await this.durableFs.writeJsonAtomicAsync(historyPath, record, { expectedTargetSha256: null });
  }
  async status(target) {
    const { record } = await this._read(target);
    if (record && ['committed', 'abandoned'].includes(record.phase)) {
      await assertServerDirectoryIdentity(path.dirname(target.clientPath), record.parentIdentity, this._options());
      await assertServerDirectoryIdentity(target.clientPath, record.phase === 'committed' ? record.candidateIdentity : record.oldTree.directoryIdentity, this._options());
    }
    return record ? { phase: record.phase, operationId: record.operationId } : null;
  }
  async stage({ target, baseline, oldManifest, prepared, descriptor, optionalFileIds, conflictChoices = {}, signal, operationId = crypto.randomUUID(), onProgress }) {
    if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('INVALID_REQUEST');
    const report = event => {
      try { Promise.resolve(onProgress?.(Object.freeze(event))).catch(() => {}); } catch { /* Observation cannot alter transaction authority. */ }
    };
    signal?.throwIfAborted();
    const evidence = preparedManifestEvidence(prepared, descriptor, optionalFileIds);
    report({ phase: 'checking-client-files' });
    const live = await inspectServerDirectoryTree(target.clientPath, this._options());
    if (!sameTree(live, baseline)) throw fail('PLAN_STALE');
    const ownership = planOwnership(baseline, oldManifest, prepared.manifest.entries);
    if (!conflictChoices || Object.getPrototypeOf(conflictChoices) !== Object.prototype ||
        Object.keys(conflictChoices).some(key => !ownership.conflicts.some(c => c.path === key)) ||
        ownership.conflicts.some(c => !['preserve', 'replace'].includes(conflictChoices[c.path]) || (conflictChoices[c.path] === 'replace' && !c.replaceAllowed))) throw fail('INVALID_REQUEST');
    const prior = await this._read(target);
    if (prior.record && !['committed', 'abandoned'].includes(prior.record.phase)) throw fail();
    if (prior.record) await this._archiveSettled(target, prior.record);
    const context = Object.freeze({ ...this._paths(target, operationId), operationId, target: Object.freeze({ ...target }) });
    const parentIdentity = await identifyServerDirectory(path.dirname(context.clientPath), this._options());
    const oldTree = { directoryIdentity: live.directoryIdentity, fingerprint: live.fingerprint };
    this.contexts.set(context, { record: null, sha256: prior.sha256 });
    await this._write(context, { schemaVersion: 1, operationId, clientId: target.clientId, clientPath: context.clientPath,
      parentIdentity, oldTree, candidateIdentity: null, candidateTree: null, phase: 'preparing' });
    let copyWorkersQuiescent = true;
    try {
    await this._retainProof(context, 'previous', baseline);
    await fs.mkdir(context.candidatePath);
    const candidateIdentity = await identifyServerDirectory(context.candidatePath, this._options());
    if (candidateIdentity.volumeSerial !== parentIdentity.volumeSerial) throw fail();
    await this._write(context, { ...this.contexts.get(context).record, candidateIdentity });
    await copyServerDirectoryContents(context.clientPath, context.candidatePath, { ...this._options(), durableFs: this.durableFs, expectedSourceSnapshot: baseline, signal,
      ...(onProgress ? { onCopyProgress: ({ activity, ...measured }) => report({
        phase: activity === 'copying-live-files' ? 'copying-client-files' :
          activity === 'flushing-candidate-directories' ? 'flushing-client-files' : 'checking-client-copy',
        ...measured
      }) } : {}) });
    const selected = normalizeEntries(prepared.manifest.entries);
    report({ phase: 'checking-prepared-pack' });
    const staged = await captureServerDirectoryCopySource(prepared.path, { ...this._options(), signal });
    const stagedFiles = new Map(staged.entries.map(e => [e.pathKey, e]));
    for (const entry of selected) {
      const actual = stagedFiles.get(entry.pathKey);
      if (!actual || actual.type !== 'file' || actual.sha256 !== entry.sha256 || actual.size !== entry.size) throw fail('PLAN_STALE');
    }
    const liveFiles = new Map(baseline.entries.map(e => [e.pathKey, e]));
    const remove = [...ownership.removals, ...ownership.conflicts.filter(c => c.action === 'remove' && conflictChoices[c.path] === 'replace').map(c => c.path)];
    for (const relative of remove) await fs.unlink(path.join(context.candidatePath, ...liveFiles.get(relative.toLowerCase()).path.split('/')));
    const entries = [];
    const isPreserved = entry => ownership.preserved.includes(entry.path) || conflictChoices[entry.path] === 'preserve';
    const copyEntries = selected.filter(entry => !isPreserved(entry));
    const totalItems = copyEntries.length, stride = Math.max(1, Math.ceil(totalItems / 200));
    const totalBytes = copyEntries.reduce((sum, entry) => sum + BigInt(entry.size), 0n).toString();
    let completedItems = 0, completedBytes = 0n;
    const reportCopy = () => report({ phase: 'copying-pack-files', completedItems, totalItems, completedBytes: completedBytes.toString(), totalBytes });
    reportCopy();
    let candidateHashService = null;
    try {
      for (const entry of selected) {
        signal?.throwIfAborted();
        const existing = liveFiles.get(entry.pathKey);
        const preserved = isPreserved(entry);
        if (!preserved) {
          if (candidateHashService === null) {
            const service = this.hashServiceFactory();
            if (!service || typeof service.hashFile !== 'function' || typeof service.dispose !== 'function') throw fail('INVALID_REQUEST');
            candidateHashService = service; copyWorkersQuiescent = false;
          }
          const destination = path.join(context.candidatePath, ...(existing?.path || entry.path).split('/'));
          const measured = await copyRegularFile(path.join(prepared.path, ...entry.path.split('/')), destination,
            { ...this._options(), signal, replace: !!existing, candidateHashService });
          if (measured.sha256 !== entry.sha256 || measured.size !== entry.size) throw fail('PLAN_STALE');
          completedItems++; completedBytes += BigInt(measured.size);
          if (completedItems % stride === 0 || completedItems === totalItems) reportCopy();
        }
        entries.push({ ...entry, ...(preserved && existing?.sha256 !== entry.sha256 ? { preserved: true } : {}) });
      }
    } finally {
      // The operation owns this lazy service; disposal must finish before either
      // manifest publication or the outer catch can assert writer quiescence.
      if (candidateHashService !== null) {
        report({ phase: 'finishing-pack-copy' });
        await candidateHashService.dispose();
        copyWorkersQuiescent = true;
      }
    }
    // Retained removed owned files remain tracked as divergent, never silently re-owned.
    for (const conflict of ownership.conflicts.filter(c => c.action === 'remove' && conflictChoices[c.path] === 'preserve')) {
      entries.push({ ...oldManifest.entries.find(e => e.pathKey === conflict.path.toLowerCase()), preserved: true });
    }
    const manifest = normalizeClientPackManifest({ ...evidence, descriptor, optionalFileIds, entries });
    report({ phase: 'writing-client-manifest' });
    await this.stateStore.write(context.candidatePath, manifest);
    return context;
    } catch (cause) {
      if (!copyWorkersQuiescent) throw fail('RECOVERY_REQUIRED', cause);
      // Assembly uses awaited filesystem writes; its hash helpers only read and
      // dispose before returning. No runtime writer has started at this boundary.
      // Never delete partial evidence here; settle only the unchanged live tree.
      await this.abandon(context, { quiescent: true });
      throw cause;
    }
  }
  async seal(context) {
    const internal = this.contexts.get(context);
    if (!internal || internal.record.phase !== 'preparing') throw fail();
    await assertServerDirectoryIdentity(context.candidatePath, internal.record.candidateIdentity, this._options());
    const candidateTree = await inspectAndFlushServerDirectoryTree(context.candidatePath, { ...this._options(), durableFs: this.durableFs });
    await this._write(context, { ...internal.record, phase: 'ready', candidateTree: { directoryIdentity: candidateTree.directoryIdentity, fingerprint: candidateTree.fingerprint } });
  }
  async _tree(directoryPath) {
    try { await fs.lstat(directoryPath); } catch (cause) { if (cause.code === 'ENOENT') return null; throw fail(undefined, cause); }
    return inspectServerDirectoryTree(directoryPath, this._options());
  }
  async publish(context) {
    const internal = this.contexts.get(context);
    if (!internal || !['ready', 'committed'].includes(internal.record.phase)) throw fail();
    const record = internal.record;
    await assertServerDirectoryIdentity(path.dirname(context.clientPath), record.parentIdentity, this._options());
    let [live, candidate, previous] = await Promise.all([this._tree(context.clientPath), this._tree(context.candidatePath), this._tree(context.previousPath)]);
    if (sameTree(live, record.oldTree) && sameTree(candidate, record.candidateTree) && previous === null && record.phase === 'ready') {
      await this.durableFs.renameDurableAsync(context.clientPath, context.previousPath);
      live = null; previous = record.oldTree;
    }
    if (live === null && sameTree(previous, record.oldTree) && sameTree(candidate, record.candidateTree) && record.phase === 'ready') {
      await this.durableFs.renameDurableAsync(context.candidatePath, context.clientPath);
      live = await this._tree(context.clientPath); candidate = null;
    }
    if (!sameTree(live, record.candidateTree) || candidate !== null || !sameTree(previous, record.oldTree)) throw fail();
    // Existing ownership manifest moved atomically with candidate contents. The
    // completion marker is written only after the entire new live tree is proven.
    await this.durableFs.flushDirectoryAsync(path.dirname(context.clientPath));
    await this._write(context, { ...record, phase: 'committed' });
    return { phase: 'committed', operationId: record.operationId };
  }
  async recover(target, { quiescent = false } = {}) {
    const { record, sha256 } = await this._read(target);
    if (!record) return null;
    if (record.phase === 'committed' || record.phase === 'abandoned') return this.status(target);
    if (record.phase === 'preparing' && quiescent !== true) throw fail();
    const context = Object.freeze({ ...this._paths(target, record.operationId), operationId: record.operationId, target });
    this.contexts.set(context, { record, sha256 });
    if (record.phase === 'preparing') {
      if (record.candidateIdentity === null) throw fail();
      await assertServerDirectoryIdentity(path.dirname(context.clientPath), record.parentIdentity, this._options());
      await assertServerDirectoryIdentity(context.candidatePath, record.candidateIdentity, this._options());
      if (await this._tree(context.previousPath) !== null) throw fail();
      return this.abandon(context, { quiescent: true });
    }
    return this.publish(context);
  }
  async abandon(context, { quiescent } = {}) {
    const internal = this.contexts.get(context);
    if (!internal || quiescent !== true || internal.record.phase !== 'preparing' ||
        !sameTree(await this._tree(context.clientPath), internal.record.oldTree)) throw fail();
    let candidateTree = null;
    if (internal.record.candidateIdentity !== null) {
      await assertServerDirectoryIdentity(context.candidatePath, internal.record.candidateIdentity, this._options());
      const inspected = await captureServerDirectoryCopySource(context.candidatePath, this._options());
      candidateTree = { directoryIdentity: inspected.directoryIdentity, fingerprint: inspected.fingerprint };
      const proofPath = this._retainedPaths(context.target, context.operationId, 'candidate').proofPath;
      const existingProof = await this.durableFs.readFileBoundedAsync(proofPath, { maxBytes: MAX_CLEANUP_BYTES, allowMissing: true });
      if (existingProof === null) await this._retainProof(context, 'candidate', inspected);
      else {
        const proof = JSON.parse(existingProof.toString('utf8'));
        if (!sameTree(proof.tree, candidateTree)) throw fail();
        // A retry cannot replace already-recorded native ownership with fresh IDs.
        await this._validateProof(context.target, { ...internal.record, candidateTree }, 'candidate', existingProof);
      }
    }
    await this._write(context, { ...internal.record, phase: 'abandoned', candidateTree });
    return { phase: 'abandoned', operationId: context.operationId };
  }
  _validateRetainedRecord(target, record) {
    const paths = this._paths(target, record?.operationId);
    if (!exactKeys(record, ['schemaVersion', 'operationId', 'clientId', 'clientPath', 'parentIdentity', 'oldTree', 'candidateIdentity', 'candidateTree', 'phase']) ||
        record.schemaVersion !== 1 || record.clientId !== target.clientId || record.clientPath !== paths.clientPath || !nativeIdentity(record.parentIdentity) || !validTree(record.oldTree) ||
        !['preparing', 'ready', 'committed', 'abandoned'].includes(record.phase) || (record.candidateIdentity !== null && !nativeIdentity(record.candidateIdentity)) ||
        (record.candidateTree !== null && (!validTree(record.candidateTree) || !equal(record.candidateIdentity, record.candidateTree.directoryIdentity))) ||
        (['ready', 'committed'].includes(record.phase) && record.candidateTree === null)) throw fail();
    return record;
  }
  async _validateProof(target, record, role, bytes) {
    const proof = JSON.parse(bytes.toString('utf8'));
    const tree = role === 'previous' ? record.oldTree : record.candidateTree;
    const retained = Object.hasOwn(proof, 'retentionReason');
    if (!exactKeys(proof, ['schemaVersion', 'operationId', 'clientId', 'clientPath', 'role', 'parentIdentity', 'tree', retained ? 'retentionReason' : 'entries']) ||
        proof.schemaVersion !== 1 || proof.operationId !== record.operationId || proof.clientId !== target.clientId || proof.clientPath !== record.clientPath || proof.role !== role ||
        !equal(proof.parentIdentity, record.parentIdentity) || !validTree(proof.tree) || !sameTree(proof.tree, tree)) throw fail();
    if (retained) {
      if (!['inventory-entry-limit', 'inventory-byte-limit'].includes(proof.retentionReason)) throw fail();
      return { proof, retained: true, sha256: hash(bytes) };
    }
    const entries = validateInventory(proof.entries);
    if (!equal(entries, [...entries].sort(deletionOrder))) throw fail();
    const root = entries.find(entry => entry.path === '');
    if (BigInt(root.dev).toString(16) !== tree.directoryIdentity.volumeSerial || BigInt(root.ino).toString(16) !== tree.directoryIdentity.fileId) throw fail();
    return { proof, entries, sha256: hash(bytes) };
  }
  async _cleanupRecords(target) {
    const active = await this._read(target); const records = new Map();
    if (active.record) records.set(active.record.operationId, this._validateRetainedRecord(target, active.record));
    const base = path.basename(this._paths(target).journalPath, '.json');
    const directory = await fs.opendir(this.journalRoot); let scanned = 0; let unsettled = records.size; let incomplete = false;
    for await (const entry of directory) {
      if (++scanned > 10000) { incomplete = true; break; }
      if (!entry.name.startsWith(`${base}.history-`) || !entry.name.endsWith('.json')) continue;
      const operationId = entry.name.slice(base.length + 9, -5);
      if (!validUuid(operationId)) continue;
      try {
        const bytes = await this.durableFs.readFileBoundedAsync(path.join(this.journalRoot, entry.name), { maxBytes: 1024 * 1024 });
        const record = this._validateRetainedRecord(target, JSON.parse(bytes.toString('utf8')));
        if (record.operationId !== operationId || (records.has(operationId) && !equal(records.get(operationId), record))) throw fail();
        if (!records.has(operationId)) {
          let completed = false;
          if (['committed', 'abandoned'].includes(record.phase)) {
            try { completed = await this._cleanupOne(target, record, {}, { operations: 0, remaining: 0 }) === 'completed'; } catch { /* Unproven terminal marker counts as unsettled. */ }
          }
          if (!completed && unsettled >= 256) { incomplete = true; break; }
          if (!completed) unsettled++;
        }
        records.set(operationId, record);
      } catch {
        if (!records.has(operationId) && unsettled++ >= 256) { incomplete = true; break; }
        records.set(operationId, null);
      }
    }
    return { records, incomplete };
  }
  _cleanupIntent(value, record, role, sourceRecordSha256) {
    const noCandidate = record.phase === 'abandoned' && record.candidateIdentity === null && record.candidateTree === null;
    if (!exactKeys(value, ['schemaVersion', 'operationId', 'clientId', 'clientPath', 'role', 'sourceRecordSha256', 'proofSha256', 'rootIdentity', 'parentIdentity', 'entryCount', 'cursor', 'pending', 'phase']) ||
        ![1, 2].includes(value.schemaVersion) || value.operationId !== record.operationId || value.clientId !== record.clientId || value.clientPath !== record.clientPath || value.role !== role ||
        value.sourceRecordSha256 !== sourceRecordSha256 || (noCandidate ? value.proofSha256 !== null : !validSha256(value.proofSha256)) ||
        !equal(value.parentIdentity, record.parentIdentity) || !equal(value.rootIdentity, noCandidate ? null : (role === 'previous' ? record.oldTree : record.candidateTree)?.directoryIdentity) ||
        !Number.isSafeInteger(value.entryCount) || (noCandidate ? value.entryCount !== 0 || value.phase !== 'complete' : value.entryCount < 1 || value.entryCount > MAX_CLEANUP_ENTRIES) ||
        !Number.isSafeInteger(value.cursor) || value.cursor < 0 || value.cursor > value.entryCount ||
        (value.pending !== null && (value.schemaVersion === 1 ? value.pending !== value.cursor || value.cursor >= value.entryCount :
          !exactKeys(value.pending, ['endExclusive']) || !Number.isSafeInteger(value.pending.endExclusive) ||
          value.pending.endExclusive <= value.cursor || value.pending.endExclusive > value.entryCount || value.pending.endExclusive - value.cursor > MAX_CLEANUP_BATCH)) ||
        !['cleaning', 'complete'].includes(value.phase) || (value.phase === 'complete' && (value.cursor !== value.entryCount || value.pending !== null))) throw fail();
    return value;
  }
  _cleanupRangeEnd(state) {
    return state.intent.pending === null ? state.intent.cursor : state.intent.schemaVersion === 1 ? state.intent.pending + 1 : state.intent.pending.endExclusive;
  }
  _cleanupMayBeAbsent(state, entry) {
    const index = state.indexByPath.get(entry.pathKey);
    return index >= state.intent.cursor && index < this._cleanupRangeEnd(state);
  }
  async _writeCleanup(state, next) {
    await this.durableFs.writeJsonAtomicAsync(state.paths.cleanupPath, next, { expectedTargetSha256: state.sha256 });
    state.sha256 = hash(`${JSON.stringify(next, null, 2)}\n`); state.intent = next;
  }
  async _compactProofs(target, record, sourceRecordSha256) {
    for (const role of ['previous', 'candidate']) {
      const { proofPath } = this._retainedPaths(target, record.operationId, role);
      const bytes = await this.durableFs.readFileBoundedAsync(proofPath, { maxBytes: MAX_CLEANUP_BYTES, allowMissing: true });
      if (bytes === null) continue;
      const value = JSON.parse(bytes.toString('utf8'));
      if (exactKeys(value, ['schemaVersion', 'operationId', 'role', 'consumedBy', 'proofSha256'])) {
        if (value.schemaVersion !== 1 || value.operationId !== record.operationId || value.role !== role || value.consumedBy !== sourceRecordSha256 || !validSha256(value.proofSha256)) throw fail();
        continue;
      }
      const inventory = await this._validateProof(target, record, role, bytes);
      await this.durableFs.writeJsonAtomicAsync(proofPath, { schemaVersion: 1, operationId: record.operationId, role,
        consumedBy: sourceRecordSha256, proofSha256: inventory.sha256 }, { expectedTargetSha256: inventory.sha256 });
    }
  }
  async _retainedExists(paths) {
    try { await fs.lstat(paths.retainedPath); return true; } catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
  }
  _cleanupSnapshotOptions(state) {
    const remaining = new Map(state.entries.slice(state.intent.cursor).map(entry => [entry.pathKey, entry]));
    const expectedAt = absolute => {
      const relative = path.relative(state.paths.retainedPath, absolute).split(path.sep).join('/');
      if (relative.startsWith('../') || path.isAbsolute(relative)) throw fail();
      const entry = remaining.get(relative.toLowerCase());
      if (!entry || entry.path !== relative) throw fail();
      return entry;
    };
    return { ...this._options(), fsPromises: { ...fs,
      async lstat(absolute, options) {
        const expected = expectedAt(absolute); const stat = await fs.lstat(absolute, { bigint: true });
        if (!statMatches(stat, expected)) throw fail();
        return options?.bigint ? stat : fs.lstat(absolute, options);
      },
      async readdir(absolute) {
        expectedAt(absolute); const names = []; const directory = await fs.opendir(absolute);
        for await (const entry of directory) {
          if (names.length >= remaining.size) throw fail();
          expectedAt(path.join(absolute, entry.name)); names.push(entry.name);
        }
        return names;
      }
    } };
  }
  async _assertCleanupRemainder(state) {
    let stat;
    try { stat = await fs.lstat(state.paths.retainedPath, { bigint: true }); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (!stat) {
      const pendingRoot = state.intent.pending !== null && this._cleanupRangeEnd(state) === state.entries.length;
      const deletedRoot = state.intent.pending === null && state.intent.cursor === state.entries.length;
      if (!pendingRoot && !deletedRoot) throw fail();
      await assertServerDirectoryIdentity(path.dirname(state.paths.clientPath), state.intent.parentIdentity, this._options());
      return;
    }
    await assertServerDirectoryIdentity(state.paths.retainedPath, state.intent.rootIdentity, this._options());
    const snapshot = await captureServerDirectoryCopySource(state.paths.retainedPath, this._cleanupSnapshotOptions(state));
    const root = state.byPath.get('');
    if (!statMatches(stat, root)) throw fail();
    const actual = new Map([...snapshot.entries, root].map(entry => [entry.pathKey, entry]));
    const remaining = state.entries.slice(state.intent.cursor);
    for (let index = 0; index < remaining.length; index++) {
      const expected = remaining[index]; const current = actual.get(expected.pathKey);
      if (!current && this._cleanupMayBeAbsent(state, expected)) continue;
      if (!current || !equal(current, expected)) throw fail();
      actual.delete(expected.pathKey);
    }
    if (actual.size) throw fail();
    return snapshot;
  }
  async _cleanupAncestry(state, entry, allowMissing = false) {
    await assertServerDirectoryIdentity(path.dirname(state.paths.clientPath), state.intent.parentIdentity, this._options());
    const ancestors = [];
    if (entry.path !== '') {
      const names = entry.path.split('/');
      for (let length = 0; length < names.length; length++) {
        const relative = names.slice(0, length).join('/');
        const expected = state.byPath.get(relative.toLowerCase());
        if (!expected || expected.type !== 'directory') throw fail();
        const absolute = relative ? path.join(state.paths.retainedPath, ...relative.split('/')) : state.paths.retainedPath;
        let stat;
        try { stat = await fs.lstat(absolute, { bigint: true }); } catch (cause) {
          if (cause.code !== 'ENOENT' || !allowMissing || !this._cleanupMayBeAbsent(state, expected)) throw cause;
          // Existing ancestors have been checked root-to-leaf. Never traverse a
          // missing directory: its descendants can only be interrupted absences.
          return null;
        }
        if (!statMatches(stat, expected) || await this.reparseInspector.isReparsePoint(absolute) !== false) throw fail();
        ancestors.push({ absolute, expected });
      }
    }
    return ancestors;
  }
  async _deleteCleanupEntry(state, entry, budget) {
    const absolute = entry.path ? path.join(state.paths.retainedPath, ...entry.path.split('/')) : state.paths.retainedPath;
    const ancestors = await this._cleanupAncestry(state, entry, true);
    if (ancestors === null) { if (!this._cleanupMayBeAbsent(state, entry)) throw fail(); return 'absent'; }
    let before;
    try { before = await fs.lstat(absolute, { bigint: true }); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (!before) { if (!this._cleanupMayBeAbsent(state, entry)) throw fail(); return 'absent'; }
    if (!statMatches(before, entry) || await this.reparseInspector.isReparsePoint(absolute) !== false) throw fail();
    if (budget.remaining <= 0) return 'budget';
    if (entry.type === 'file') {
      const handle = await fs.open(absolute, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0));
      try {
        if (!statMatches(await handle.stat({ bigint: true }), entry)) throw fail();
        const digest = crypto.createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
        if (digest.digest('hex') !== entry.sha256 || !statMatches(await handle.stat({ bigint: true }), entry)) throw fail();
      } finally { await handle.close(); }
    } else if ((await fs.readdir(absolute)).length) throw fail();
    // There is no async boundary between these last native identity checks and
    // the single unlink/rmdir. This is app-lease-bound, not hostile OS race proof.
    const parent = nativeFs.lstatSync(path.dirname(state.paths.clientPath), { bigint: true });
    if (parent.isSymbolicLink() || !parent.isDirectory() || parent.dev.toString(16) !== state.intent.parentIdentity.volumeSerial || parent.ino.toString(16) !== state.intent.parentIdentity.fileId) throw fail();
    for (const ancestor of ancestors) if (!statMatches(nativeFs.lstatSync(ancestor.absolute, { bigint: true }), ancestor.expected)) throw fail();
    const final = nativeFs.lstatSync(absolute, { bigint: true });
    if (!statMatches(final, entry) || (entry.type === 'file' && (final.mtimeNs !== before.mtimeNs || final.size !== before.size))) throw fail();
    if (entry.type === 'file') nativeFs.unlinkSync(absolute); else nativeFs.rmdirSync(absolute);
    budget.remaining--;
    return 'deleted';
  }
  _cleanupBoundaries(state, endExclusive) {
    const boundaries = new Map();
    for (let index = state.intent.cursor; index < endExclusive; index++) {
      let relative = state.entries[index].path;
      for (;;) {
        relative = relative === '' ? null : relative.split('/').slice(0, -1).join('/');
        if (relative === null) { boundaries.set(null, null); break; }
        const entry = state.byPath.get(relative.toLowerCase());
        if (!entry || entry.type !== 'directory') throw fail();
        if (!this._cleanupMayBeAbsent(state, entry)) { boundaries.set(entry.pathKey, entry); break; }
      }
    }
    // Distinct nested surviving parents must both be flushed: a directory flush
    // is not recursive. Range membership, not this run's deletions, selects them.
    return [...boundaries.values()];
  }
  async _assertCleanupBoundaries(state, boundaries) {
    await assertServerDirectoryIdentity(path.dirname(state.paths.clientPath), state.intent.parentIdentity, this._options());
    for (const entry of boundaries) {
      if (entry === null) continue;
      await this._cleanupAncestry(state, entry);
      const absolute = entry.path ? path.join(state.paths.retainedPath, ...entry.path.split('/')) : state.paths.retainedPath;
      if (!statMatches(await fs.lstat(absolute, { bigint: true }), entry) || await this.reparseInspector.isReparsePoint(absolute) !== false) throw fail();
    }
  }
  async _cleanupOne(target, record, options, budget) {
    const role = record.phase === 'committed' ? 'previous' : 'candidate';
    const paths = this._retainedPaths(target, record.operationId, role);
    const sourceRecordSha256 = hash(JSON.stringify(record));
    await assertServerDirectoryIdentity(path.dirname(paths.clientPath), record.parentIdentity, this._options());
    const bytes = await this.durableFs.readFileBoundedAsync(paths.cleanupPath, { maxBytes: 65536, allowMissing: true });
    const state = { paths, intent: bytes === null ? null : this._cleanupIntent(JSON.parse(bytes.toString('utf8')), record, role, sourceRecordSha256), sha256: bytes === null ? null : hash(bytes) };
    if (state.intent?.phase === 'complete') {
      if (await this._retainedExists(paths)) throw fail();
      await this._compactProofs(target, record, sourceRecordSha256);
      return 'completed';
    }
    if (budget.operations <= 0 || budget.remaining <= 0) return 'pending';
    if (await options.isQuiescent(record.operationId) !== true) return 'retained';
    if (record.phase === 'abandoned' && record.candidateIdentity === null && record.candidateTree === null) {
      if (await this._retainedExists(paths)) return 'retained';
      await assertServerDirectoryIdentity(path.dirname(paths.clientPath), record.parentIdentity, this._options());
      await this.durableFs.flushDirectoryAsync(path.dirname(paths.retainedPath));
      await this._writeCleanup(state, { schemaVersion: 2, operationId: record.operationId, clientId: target.clientId, clientPath: paths.clientPath, role,
        sourceRecordSha256, proofSha256: null, rootIdentity: null, parentIdentity: record.parentIdentity,
        entryCount: 0, cursor: 0, pending: null, phase: 'complete' });
      budget.operations--;
      await this._compactProofs(target, record, sourceRecordSha256);
      return 'completed';
    }
    const proofBytes = await this.durableFs.readFileBoundedAsync(paths.proofPath, { maxBytes: MAX_CLEANUP_BYTES, allowMissing: true });
    if (proofBytes === null) return 'retained'; // v1 without native proof is never upgraded by guessing ownership.
    const inventory = await this._validateProof(target, record, role, proofBytes);
    if (inventory.retained) return 'retained';
    state.entries = inventory.entries; state.byPath = new Map(state.entries.map(entry => [entry.pathKey, entry]));
    state.indexByPath = new Map(state.entries.map((entry, index) => [entry.pathKey, index]));
    if (state.intent && (state.intent.proofSha256 !== inventory.sha256 || state.intent.entryCount !== state.entries.length)) throw fail();
    if (!state.intent) {
      const exists = await this._retainedExists(paths);
      state.intent = { schemaVersion: 2, operationId: record.operationId, clientId: target.clientId, clientPath: paths.clientPath, role,
        sourceRecordSha256, proofSha256: inventory.sha256, rootIdentity: inventory.proof.tree.directoryIdentity, parentIdentity: record.parentIdentity,
        entryCount: state.entries.length, cursor: exists ? 0 : state.entries.length, pending: null, phase: exists ? 'cleaning' : 'complete' };
      if (exists) { if (!sameTree(await this._assertCleanupRemainder(state), inventory.proof.tree)) throw fail(); }
      else await this.durableFs.flushDirectoryAsync(path.dirname(paths.retainedPath));
      budget.operations--;
      await this._writeCleanup(state, state.intent);
    } else {
      await this._assertCleanupRemainder(state);
      budget.operations--;
    }
    while (state.intent.cursor < state.entries.length) {
      if (state.intent.pending === null) {
        if (budget.remaining <= 0) return 'pending';
        const endExclusive = Math.min(state.entries.length, state.intent.cursor + MAX_CLEANUP_BATCH, state.intent.cursor + budget.remaining);
        await this._writeCleanup(state, { ...state.intent, schemaVersion: 2, pending: { endExclusive } });
      }
      const endExclusive = this._cleanupRangeEnd(state);
      const boundaries = this._cleanupBoundaries(state, endExclusive);
      for (let index = state.intent.cursor; index < endExclusive; index++) {
        if (await this._deleteCleanupEntry(state, state.entries[index], budget) === 'budget') return 'pending';
        await new Promise(resolve => setImmediate(resolve));
      }
      await this._assertCleanupBoundaries(state, boundaries);
      await this.durableFs.flushDirectoriesAsync(boundaries.map(entry => entry === null ? path.dirname(paths.retainedPath) :
        entry.path ? path.join(paths.retainedPath, ...entry.path.split('/')) : paths.retainedPath));
      await this._assertCleanupBoundaries(state, boundaries);
      await this._writeCleanup(state, { ...state.intent, schemaVersion: 2, cursor: endExclusive, pending: null });
    }
    if (state.intent.cursor !== state.entries.length) return 'pending';
    if (await this._retainedExists(paths)) throw fail();
    await this.durableFs.flushDirectoryAsync(path.dirname(paths.retainedPath));
    if (state.intent.phase !== 'complete') await this._writeCleanup(state, { ...state.intent, schemaVersion: 2, phase: 'complete' });
    // Keep compact terminal ownership evidence; the full native inventory is no
    // longer needed after durable completion and is not reused for any deletion.
    await this._compactProofs(target, record, sourceRecordSha256);
    return 'completed';
  }
  async cleanup(target, { isQuiescent, maxDeletes = MAX_CLEANUP_ENTRIES, maxOperations = 8 } = {}) {
    if (typeof isQuiescent !== 'function' || !Number.isSafeInteger(maxDeletes) || maxDeletes < 1 || maxDeletes > MAX_CLEANUP_ENTRIES ||
        !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 256) throw fail('INVALID_REQUEST');
    const result = { completed: [], retained: [], pending: [], incomplete: false }; const budget = { remaining: maxDeletes, operations: maxOperations };
    const status = await this.status(target);
    if (status && !['committed', 'abandoned'].includes(status.phase)) { result.retained.push(status.operationId); return result; }
    const { records, incomplete } = await this._cleanupRecords(target); result.incomplete = incomplete;
    for (const [operationId, record] of records) {
      if (!record || !['committed', 'abandoned'].includes(record.phase)) { result.retained.push(operationId); continue; }
      try { result[await this._cleanupOne(target, record, { isQuiescent }, budget)].push(operationId); }
      catch { result.retained.push(operationId); }
    }
    return result;
  }
}
module.exports = { ClientPackTransaction };
