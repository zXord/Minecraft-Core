const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const {
  createRecoveryTargetEnvelope,
  verifyRecoveryTargetEnvelope
} = require('../../electron/services/modpack-lifecycle/recovery-target-envelope.cjs');

function retirementCandidate(overrides = {}) {
  return { schemaVersion: 1, id: 'restore-0001', name: 'restore-point-0001.zip',
    metadataName: 'restore-point-0001.json', sha256: 'a'.repeat(64), size: 31, totalBytes: '22',
    scopeSha256: 'b'.repeat(64), sourceRevision: 7, sourceRuntime: null,
    operationId: 'job-0001', createdAt: '2026-08-01T00:00:00.000Z', ...overrides };
}

function retirementReceipt(proof, overrides = {}) {
  const directory = { fileType: 'directory', dev: '1', ino: '2', size: '0', birthtime: '3', mtime: '4', ctime: '5' };
  const file = { ...directory, fileType: 'file', size: '31', sha256: 'a'.repeat(64) };
  return { schemaVersion: 1, policyVersion: 1, sequence: 0, jobId: 'job-0001', operationKind: 'install',
    target: { kind: 'existing', stableServerId: 'server-0001', path: 'c:\\minecraft\\servers\\example' },
    candidate: retirementCandidate(), terminal: { recordSha256: proof.recordSha256, envelopeSha256: proof.envelopeSha256,
      targetPathHash: proof.envelope.targetPathHash, envelopeChecksum: proof.envelope.checksum },
    lineage: { parent: directory, target: { ...directory, ino: '6' }, backups: { ...directory, ino: '7' } },
    files: { archive: file, sidecar: { ...file, ino: '8', sha256: 'c'.repeat(64) } }, pinOwner: 'job-0001',
    settlement: { caller: 'live-precommit-final-policy', action: 'pre-swap-restored', swapStep: 'none', commitStarted: false, policyRestored: true },
    progress: 'authorized', durability: { archive: 'not-started', sidecar: 'not-started' }, diagnostic: null,
    lastAttemptAt: null, createdAt: '2026-08-01T00:00:10.000Z', updatedAt: '2026-08-01T00:00:10.000Z', ...overrides };
}

async function publishRetirementCandidate(registry, { terminalPhase = 'failed', clear = false } = {}) {
  await registry.initialize();
  await registry.create(record());
  await registry.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'snapshotting', patch: {
    outcome: { failedPointRetirementCandidate: retirementCandidate() }
  } });
  if (clear) await registry.transition('job-0001', { expectedPhase: 'snapshotting', nextPhase: 'staging', patch: { restorePoint: null } });
  await registry.finish('job-0001', { terminalPhase, outcome: { recovery: { action: 'pre-swap-restored' } } });
}

test('retirement DTOs reject unsafe, forged and nonmonotonic authority', () => {
  const { normalizeRetirementCandidate, normalizeRetirementReceipt, assertRetirementReceiptTransition } =
    require('../../electron/services/modpack-lifecycle/failed-restorepoint-retirement-evidence.cjs');
  const proof = { recordSha256: 'd'.repeat(64), envelopeSha256: 'e'.repeat(64), envelope: { targetPathHash: 'f'.repeat(64), checksum: '0'.repeat(64) } };
  const valid = retirementReceipt(proof);
  assert.deepEqual(normalizeRetirementReceipt(valid), valid);
  assert.equal(normalizeRetirementCandidate(retirementCandidate({ totalBytes: '1'.repeat(30) })).totalBytes, '1'.repeat(30));
  let getterCalls = 0;
  const accessor = retirementCandidate();
  Object.defineProperty(accessor, 'name', { enumerable: true, get() { getterCalls++; return 'restore-point-safe.zip'; } });
  assert.throws(() => normalizeRetirementCandidate(accessor));
  assert.equal(getterCalls, 0);
  assert.throws(() => normalizeRetirementCandidate(Object.assign(Object.create(null), retirementCandidate())));
  for (const candidate of [{ ...retirementCandidate(), extra: true }, retirementCandidate({ name: '../bad.zip' }),
    retirementCandidate({ schemaVersion: 2 }), retirementCandidate({ size: 0 }), retirementCandidate({ totalBytes: '01' })]) {
    assert.throws(() => normalizeRetirementCandidate(candidate));
  }
  for (const bad of [{ ...valid, extra: true }, { ...valid, schemaVersion: 2 }, { ...valid, pinOwner: 'other' },
    { ...valid, candidate: retirementCandidate({ operationId: 'other' }) },
    { ...valid, target: { ...valid.target, kind: 'new' } }, { ...valid, diagnostic: { reason: 'io-failure', at: 'x'.repeat(66000) } },
    { ...valid, progress: 'deleted' }, { ...valid, lastAttemptAt: '2026-08-02T00:00:00.000Z' }]) assert.throws(() => normalizeRetirementReceipt(bad));
  const next = { ...valid, sequence: 1, lastAttemptAt: '2026-08-01T00:00:11.000Z', updatedAt: '2026-08-01T00:00:11.000Z' };
  assert.doesNotThrow(() => assertRetirementReceiptTransition(valid, next));
  for (const bad of [{ ...next, sequence: 0 }, { ...next, candidate: retirementCandidate({ id: 'replacement' }) },
    { ...next, files: { ...next.files, archive: { ...next.files.archive, ino: '99' } } },
    { ...next, terminal: { ...next.terminal, recordSha256: '1'.repeat(64) } }]) assert.throws(() => assertRetirementReceiptTransition(valid, bad));
  assert.throws(() => assertRetirementReceiptTransition(next, { ...next, sequence: 2, lastAttemptAt: null }));
  assert.throws(() => assertRetirementReceiptTransition(next, { ...next, sequence: 2, lastAttemptAt: valid.createdAt }));
  const drifted = { ...next, lineage: { ...next.lineage, target: { ...next.lineage.target, size: '19', mtime: '20', ctime: '21' } },
    files: { ...next.files, archive: { ...next.files.archive, ctime: '22' } } };
  assert.doesNotThrow(() => assertRetirementReceiptTransition(valid, drifted));
  const deleting = { ...next, sequence: 2, progress: 'deleting', durability: { archive: 'intent', sidecar: 'not-started' } };
  assert.throws(() => assertRetirementReceiptTransition(deleting, { ...next, sequence: 3 }));
  assert.throws(() => assertRetirementReceiptTransition(valid, { ...next, progress: 'archive-deleted', durability: { archive: 'durable', sidecar: 'not-started' } }));
});

test('published terminal proof is read-only and rejects active, split and duplicate publication', async t => {
  for (const mode of ['active', 'record-split', 'envelope-split', 'duplicate-record', 'duplicate-envelope', 'published']) {
    const { registry, userDataPath, calls } = fixture(t);
    await publishRetirementCandidate(registry);
    const root = path.join(userDataPath, 'modpack-lifecycle');
    if (mode === 'active' || mode === 'envelope-split') fs.renameSync(path.join(root, 'history', 'job-0001.json'), path.join(root, 'active', 'job-0001.json'));
    if (mode === 'active' || mode === 'record-split') fs.renameSync(path.join(root, 'history', 'job-0001.target.json'), path.join(root, 'active', 'job-0001.target.json'));
    if (mode === 'duplicate-record') fs.copyFileSync(path.join(root, 'history', 'job-0001.json'), path.join(root, 'active', 'job-0001.json'));
    if (mode === 'duplicate-envelope') fs.copyFileSync(path.join(root, 'history', 'job-0001.target.json'), path.join(root, 'active', 'job-0001.target.json'));
    const before = calls.length;
    const binding = { expectedTarget: record().target, expectedOperationKind: 'install' };
    if (mode === 'published') {
      const evidence = await registry.loadPublishedTerminalEvidence('job-0001', binding);
      assert.equal(evidence.record.phase, 'failed');
      assert.equal(evidence.recordSha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'history', 'job-0001.json'))).digest('hex'));
      await assert.rejects(registry.loadPublishedTerminalEvidence('job-0001', { ...binding, expectedOperationKind: 'repair' }));
    } else await assert.rejects(registry.loadPublishedTerminalEvidence('job-0001', binding));
    assert.equal(calls.length, before);
  }
});

test('immutable candidate survives outcome replacement and remains non-authorizing without a point', async t => {
  const { registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());
  await assert.rejects(registry.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'snapshotting', patch: {
    outcome: { failedPointRetirementCandidate: retirementCandidate({ operationId: 'other' }) }
  } }));
  await registry.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'snapshotting', patch: {
    outcome: { failedPointRetirementCandidate: retirementCandidate() }
  } });
  await assert.rejects(registry.transition('job-0001', { expectedPhase: 'snapshotting', nextPhase: 'staging', patch: {
    outcome: { failedPointRetirementCandidate: retirementCandidate({ name: 'restore-point-other.zip', metadataName: 'restore-point-other.json' }) }
  } }));
  await registry.finish('job-0001', { terminalPhase: 'failed', outcome: { recovery: { action: 'pre-swap-restored' } } });
  assert.equal((await registry.loadHistory('job-0001')).outcome.failedPointRetirementCandidate.name, 'restore-point-0001.zip');
  const scan = await registry.initialize();
  assert.equal(scan.pendingRestorePointRetirements[0].state, 'deferred-proof');
  assert.deepEqual(registry.listRestorePointRetirementItems({ selector: null }), scan.pendingRestorePointRetirements);
  assert.equal(registry.listRestorePointRetirementItems({ selector: { instanceId: 'another', serverPath: record().target.path } }).length, 0);
  for (const settings of [{ terminalPhase: 'completed' }, { clear: true }]) {
    const other = fixture(t);
    await publishRetirementCandidate(other.registry, settings);
    assert.equal((await other.registry.initialize()).pendingRestorePointRetirements.length, 0);
    assert.equal((await other.registry.loadHistory('job-0001')).outcome.failedPointRetirementCandidate.id, 'restore-0001');
  }
});

test('receipt create and CAS authenticate immutable terminal bytes and preserve them', async t => {
  const { registry, userDataPath } = fixture(t);
  await publishRetirementCandidate(registry);
  const binding = { expectedTarget: record().target, expectedOperationKind: 'install' };
  const proof = await registry.loadPublishedTerminalEvidence('job-0001', binding);
  const history = path.join(userDataPath, 'modpack-lifecycle', 'history');
  const bytes = ['job-0001.json', 'job-0001.target.json'].map(name => fs.readFileSync(path.join(history, name)));
  assert.equal(await registry.loadRestorePointRetirement('job-0001'), null);
  const receipt = retirementReceipt(proof);
  for (const bad of [{ ...receipt, jobId: 'wrong' }, { ...receipt, target: { ...receipt.target, stableServerId: 'wrong' } },
    { ...receipt, terminal: { ...receipt.terminal, recordSha256: '1'.repeat(64) } }]) {
    await assert.rejects(registry.writeRestorePointRetirement('job-0001', { expectedSha256: null, value: bad }));
    assert.equal(await registry.loadRestorePointRetirement('job-0001'), null);
  }
  const created = await registry.writeRestorePointRetirement('job-0001', { expectedSha256: null, value: receipt });
  assert.equal(created.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(userDataPath, 'modpack-lifecycle', 'retirements', 'job-0001.json'))).digest('hex'));
  const next = { ...receipt, sequence: 1, lastAttemptAt: '2026-08-01T00:00:11.000Z', updatedAt: '2026-08-01T00:00:11.000Z' };
  const results = await Promise.allSettled([1, 2].map(() => registry.writeRestorePointRetirement('job-0001', { expectedSha256: created.sha256, value: next })));
  assert.deepEqual(results.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  await assert.rejects(registry.writeRestorePointRetirement('job-0001', { expectedSha256: null, value: receipt }));
  assert.equal(registry.listRestorePointRetirementItems({ selector: null })[0].state, 'authorized-retry');
  assert.equal(registry.listRestorePointRetirementItems({ selector: null })[0].lastAttemptAt, '2026-08-01T00:00:11.000Z');
  for (let i = 0; i < bytes.length; i++) assert.deepEqual(fs.readFileSync(path.join(history, ['job-0001.json', 'job-0001.target.json'][i])), bytes[i]);
});

test('strict new byte readers reject duplicate keys and oversize receipts without recovery admission block', async t => {
  const { registry, userDataPath } = fixture(t);
  await publishRetirementCandidate(registry);
  const binding = { expectedTarget: record().target, expectedOperationKind: 'install' };
  const proof = await registry.loadPublishedTerminalEvidence('job-0001', binding);
  const receiptPath = path.join(userDataPath, 'modpack-lifecycle', 'retirements', 'job-0001.json');
  for (const bytes of [JSON.stringify(retirementReceipt(proof)).replace('"sequence":0', '"sequence":0,"sequence":0'), ' '.repeat(65537)]) {
    fs.writeFileSync(receiptPath, bytes);
    await assert.rejects(registry.loadRestorePointRetirement('job-0001'));
    const scan = await registry.initialize();
    assert.equal(scan.globalBlock, false);
    assert.equal(scan.blocks.length, 0);
    assert.equal(scan.pendingRestorePointRetirements[0].state, 'deferred-proof');
  }
  const recordPath = path.join(userDataPath, 'modpack-lifecycle', 'history', 'job-0001.json');
  fs.writeFileSync(recordPath, fs.readFileSync(recordPath, 'utf8').replace('"sequence": 2', '"sequence": 2,"sequence": 2'));
  await assert.rejects(registry.loadPublishedTerminalEvidence('job-0001', binding));
});

test('target-scoped active and historical references compare IDs rather than equal digests', async t => {
  for (const published of [false, true]) for (const point of [
    { id: 'different', sha256: 'a'.repeat(64), want: false }, { id: 'restore-0001', sha256: 'a'.repeat(64), want: true },
    { id: 'restore-0001', sha256: 'b'.repeat(64), error: true }
  ]) {
    const { registry } = fixture(t);
    await registry.initialize();
    await registry.create(record({ jobId: 'other', restorePoint: { id: point.id, sha256: point.sha256 } }));
    if (published) await registry.finish('other', { terminalPhase: 'completed', outcome: null });
    await registry.initialize();
    const query = { target: record().target, candidate: retirementCandidate(), excludingJobId: 'job-0001' };
    if (point.error) await assert.rejects(registry.hasOtherActiveRestorePointReference(query));
    else assert.equal(await registry.hasOtherActiveRestorePointReference(query), point.want);
  }
});

test('duplicate-ID conflicting records and partial reference evidence never prove absence', async t => {
  for (const malformed of [false, true]) {
    const { registry, userDataPath } = fixture(t);
    await registry.initialize();
    await registry.create(record({ jobId: 'one', restorePoint: { id: 'unrelated-point', sha256: 'c'.repeat(64) } }));
    await registry.create(record({ jobId: 'two', restorePoint: { id: 'unrelated-point', sha256: 'd'.repeat(64) } }));
    if (malformed) {
      const file = path.join(userDataPath, 'modpack-lifecycle', 'active', 'two.json');
      const value = JSON.parse(fs.readFileSync(file));
      delete value.restorePoint.sha256;
      fs.writeFileSync(file, JSON.stringify(value));
    }
    await registry.initialize();
    await assert.rejects(registry.hasOtherActiveRestorePointReference({ target: record().target, candidate: retirementCandidate(), excludingJobId: 'job-0001' }));
  }
});

test('same physical candidate locator with a different ID and global unknown binding defer reference proof', async t => {
  const { registry, userDataPath } = fixture(t);
  await registry.initialize();
  await registry.create(record({ jobId: 'other', restorePoint: { id: 'other-point', sha256: 'a'.repeat(64) } }));
  await registry.transition('other', { expectedPhase: 'queued', nextPhase: 'snapshotting', patch: { outcome: {
    failedPointRetirementCandidate: retirementCandidate({ id: 'other-point', operationId: 'other' })
  } } });
  const query = { target: record().target, candidate: retirementCandidate(), excludingJobId: 'job-0001' };
  await assert.rejects(registry.hasOtherActiveRestorePointReference(query));
  const latest = await registry.load('other');
  const file = path.join(userDataPath, 'modpack-lifecycle', 'active', 'other.json');
  // Case variants identify the same Windows leaf.
  latest.outcome.failedPointRetirementCandidate.name = 'restore-point-CASE.zip';
  latest.outcome.failedPointRetirementCandidate.metadataName = 'restore-point-CASE.json';
  fs.writeFileSync(file, JSON.stringify(latest));
  await registry.initialize();
  await assert.rejects(registry.hasOtherActiveRestorePointReference({ ...query,
    candidate: retirementCandidate({ name: 'restore-point-case.zip', metadataName: 'restore-point-case.json' }) }));
  fs.writeFileSync(path.join(userDataPath, 'modpack-lifecycle', 'active', 'unknown.json'), '{}');
  await registry.initialize();
  await assert.rejects(registry.hasOtherActiveRestorePointReference(query));
});

test('receipt intent stages survive restart and deleted receipts remain notice-only', async t => {
  const { registry, userDataPath, durableFs } = fixture(t);
  await publishRetirementCandidate(registry);
  const proof = await registry.loadPublishedTerminalEvidence('job-0001', { expectedTarget: record().target, expectedOperationKind: 'install' });
  let loaded = await registry.writeRestorePointRetirement('job-0001', { expectedSha256: null, value: retirementReceipt(proof) });
  for (const [progress, archive, sidecar] of [['deleting', 'intent', 'not-started'], ['archive-deleted', 'durable', 'not-started'],
    ['archive-deleted', 'durable', 'intent'], ['deleted', 'durable', 'durable']]) {
    loaded = await registry.writeRestorePointRetirement('job-0001', { expectedSha256: loaded.sha256, value: {
      ...loaded.value, sequence: loaded.value.sequence + 1, progress, durability: { archive, sidecar }
    } });
  }
  const restarted = new RecoveryRegistry({ userDataPath, fsApi: fs, durableFs });
  const scan = await restarted.initialize();
  assert.equal(scan.pendingRestorePointRetirements.length, 0);
  assert.equal(restarted.listRestorePointRetirementItems({ selector: null })[0].state, 'reclaimed');
  assert.equal((await restarted.loadRestorePointRetirement('job-0001')).value.progress, 'deleted');
});

test('retirement directory disappearance or substitution defers without blocking source metadata', async t => {
  for (const replacement of [false, true]) {
    const { registry, userDataPath } = fixture(t);
    await publishRetirementCandidate(registry);
    const proof = await registry.loadPublishedTerminalEvidence('job-0001', { expectedTarget: record().target, expectedOperationKind: 'install' });
    await registry.writeRestorePointRetirement('job-0001', { expectedSha256: null, value: retirementReceipt(proof) });
    const directory = path.join(userDataPath, 'modpack-lifecycle', 'retirements');
    fs.renameSync(directory, `${directory}-held`);
    if (replacement) fs.mkdirSync(directory);
    await assert.rejects(registry.loadRestorePointRetirement('job-0001'));
    await assert.rejects(registry.writeRestorePointRetirement('job-0001', { expectedSha256: null, value: retirementReceipt(proof) }));
    assert.equal(registry.listRestorePointRetirementItems({ selector: null })[0].state, 'deferred-proof');
    const scan = await registry.initialize();
    assert.equal(scan.globalBlock, false);
    assert.equal(scan.blocks.length, 0);
    assert.equal(scan.pendingRestorePointRetirements[0].state, 'deferred-proof');
    await registry.create(record({ jobId: 'new-operation' }));
    await registry.transition('new-operation', { expectedPhase: 'queued', nextPhase: 'preflight', patch: {} });
    await registry.finish('new-operation', { terminalPhase: 'failed', outcome: null });
    assert.equal((await registry.loadHistory('new-operation')).phase, 'failed');
    if (replacement) assert.deepEqual(fs.readdirSync(directory), []);
    else assert.equal(fs.existsSync(directory), false);
  }
});

test('failed live metadata publication cannot prove reference absence before reinitialization', async t => {
  const { registry } = fixture(t, { uncertainWriteNumber: 2 });
  await registry.initialize();
  await assert.rejects(registry.create(record({ jobId: 'uncertain-owner' })));
  await assert.rejects(registry.hasOtherActiveRestorePointReference({ target: record().target, candidate: retirementCandidate(), excludingJobId: 'job-0001' }));
});

test('duplicate-key target binding cannot disappear behind an unrelated permissive history target', async t => {
  const { registry, userDataPath } = fixture(t);
  await registry.initialize();
  await registry.create(record({ jobId: 'ambiguous', target: { kind: 'existing', stableServerId: 'other-server', path: 'C:\\Other\\server' },
    candidatePath: null, rollbackPath: null, failedPath: null }));
  await registry.finish('ambiguous', { terminalPhase: 'completed', outcome: null });
  const file = path.join(userDataPath, 'modpack-lifecycle', 'history', 'ambiguous.json');
  const bytes = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, bytes.replace('"target": {', `"target": ${JSON.stringify(record().target)}, "target": {`));
  await assert.rejects(registry.hasOtherActiveRestorePointReference({ target: record().target, candidate: retirementCandidate(), excludingJobId: 'job-0001' }));
  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false); // General legacy read behavior is deliberately unchanged.
  await assert.rejects(registry.hasOtherActiveRestorePointReference({ target: record().target, candidate: retirementCandidate(), excludingJobId: 'job-0001' }));
});

test('uncertain retirement directory creation durability stays notice-only without source block', async t => {
  const { registry } = fixture(t, { failFlushNumber: 4 });
  await publishRetirementCandidate(registry);
  const proof = await registry.loadPublishedTerminalEvidence('job-0001', { expectedTarget: record().target, expectedOperationKind: 'install' });
  await assert.rejects(registry.loadRestorePointRetirement('job-0001'));
  await assert.rejects(registry.writeRestorePointRetirement('job-0001', { expectedSha256: null, value: retirementReceipt(proof) }));
  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false);
  assert.equal(scan.blocks.length, 0);
  assert.equal(scan.pendingRestorePointRetirements[0].state, 'deferred-proof');
});

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    sequence: 0,
    jobId: 'job-0001',
    operationKind: 'install',
    target: {
      kind: 'existing',
      stableServerId: 'server-0001',
      path: 'C:\\Minecraft\\Servers\\Example'
    },
    candidatePath: 'C:\\Minecraft\\Servers\\.Example.candidate-job-0001',
    rollbackPath: 'C:\\Minecraft\\Servers\\.Example.rollback-job-0001',
    failedPath: 'C:\\Minecraft\\Servers\\.Example.failed-job-0001',
    restorePoint: {
      id: 'restore-0001',
      sha256: 'a'.repeat(64)
    },
    journalPath: 'C:\\Minecraft\\Servers\\Example\\.minecraft-core-state\\operations\\job-0001\\journal.json',
    priorRuntime: {
      running: false,
      autoRestart: true
    },
    phase: 'queued',
    swapStep: 'none',
    directoryIdentities: {
      target: null,
      candidate: null,
      rollback: null,
      failed: null
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    outcome: null,
    ...overrides
  };
}

function fixture(t, {
  failWriteNumber = null,
  failRenameNumber = null,
  failFlushNumber = null,
  uncertainWriteNumber = null,
  uncertainRenameNumber = null,
  replaceBeforeRenameNumber = null,
  replaceBeforeRename = null,
  beforeAsyncRename = null,
  requireAsyncRename = false,
  requireAsyncWrite = false,
  yieldControl = undefined
} = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-recovery-registry-'));
  const calls = [];
  let token = 0;
  const nativeClient = {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async moveWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) {
      await new Promise(resolve => setImmediate(resolve));
      fs.renameSync(source, destination);
    },
    flushDirectory() {},
    async flushDirectoryAsync() {}
  };
  const base = createDurableFs({
    fsApi: fs,
    durableClient: nativeClient,
    allowedRoots: [userDataPath],
    tempNameFactory: () => `recovery-${++token}`
  });
  let writes = 0;
  let renames = 0;
  let flushes = 0;
  const durableFs = {
    ...base,
    flushDirectory(directoryPath) {
      calls.push({ kind: 'flush-directory', directoryPath });
      flushes += 1;
      if (flushes === failFlushNumber) throw Object.assign(new Error('injected directory flush failure'), { code: 'COMMIT_FAILED' });
      return base.flushDirectory(directoryPath);
    },
    writeJsonAtomic(filePath, value, options) {
      if (requireAsyncWrite) throw new Error('synchronous durable JSON write must not run');
      calls.push({ kind: 'write', filePath, value });
      writes += 1;
      if (writes === failWriteNumber) throw Object.assign(new Error('injected durable write failure'), { code: 'COMMIT_FAILED' });
      const result = base.writeJsonAtomic(filePath, value, options);
      if (writes === uncertainWriteNumber) {
        throw Object.assign(new Error('injected uncertain durable write failure'), {
          code: 'COMMIT_FAILED',
          commitPhase: 'post-publication-uncertain'
        });
      }
      return result;
    },
    renameDurable(sourcePath, destinationPath, options) {
      if (requireAsyncRename) throw new Error('synchronous durable rename must not run');
      calls.push({ kind: 'rename', sourcePath, destinationPath });
      renames += 1;
      if (renames === failRenameNumber) throw Object.assign(new Error('injected durable rename failure'), { code: 'COMMIT_FAILED' });
      if (renames === replaceBeforeRenameNumber) replaceBeforeRename({ sourcePath, destinationPath });
      const result = base.renameDurable(sourcePath, destinationPath, options);
      if (renames === uncertainRenameNumber) {
        throw Object.assign(new Error('injected uncertain durable rename failure'), {
          code: 'COMMIT_FAILED',
          commitPhase: 'post-publication-uncertain'
        });
      }
      return result;
    },
    async writeJsonAtomicAsync(filePath, value, options) {
      calls.push({ kind: 'write', filePath, value });
      writes += 1;
      if (writes === failWriteNumber) throw Object.assign(new Error('injected durable write failure'), { code: 'COMMIT_FAILED' });
      const result = await base.writeJsonAtomicAsync(filePath, value, options);
      if (writes === uncertainWriteNumber) {
        throw Object.assign(new Error('injected uncertain durable write failure'), {
          code: 'COMMIT_FAILED',
          commitPhase: 'post-publication-uncertain'
        });
      }
      return result;
    },
    async renameDurableAsync(sourcePath, destinationPath, options) {
      calls.push({ kind: 'rename', sourcePath, destinationPath });
      renames += 1;
      if (renames === failRenameNumber) throw Object.assign(new Error('injected durable rename failure'), { code: 'COMMIT_FAILED' });
      if (renames === replaceBeforeRenameNumber) replaceBeforeRename({ sourcePath, destinationPath });
      if (beforeAsyncRename) await beforeAsyncRename({ renameNumber: renames, sourcePath, destinationPath });
      const result = await base.renameDurableAsync(sourcePath, destinationPath, options);
      if (renames === uncertainRenameNumber) {
        throw Object.assign(new Error('injected uncertain durable rename failure'), {
          code: 'COMMIT_FAILED',
          commitPhase: 'post-publication-uncertain'
        });
      }
      return result;
    }
  };
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const registry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs,
    clock: () => new Date(now += 1000),
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    ...(yieldControl ? { yieldControl } : {})
  });
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return { userDataPath, calls, durableFs, registry };
}

test('target envelopes are closed checksummed records without the full path', () => {
  const envelope = createRecoveryTargetEnvelope(record());
  assert.equal(verifyRecoveryTargetEnvelope(envelope).jobId, 'job-0001');
  assert.equal(envelope.targetPathHash, crypto.createHash('sha256')
    .update('c:\\minecraft\\servers\\example', 'utf8').digest('hex'));
  assert.equal(envelope.targetLabel, 'Example');
  assert.equal(JSON.stringify(envelope).includes('Minecraft\\\\Servers'), false);
  assert.throws(() => verifyRecoveryTargetEnvelope({ ...envelope, targetLabel: 'changed' }));
  assert.throws(() => verifyRecoveryTargetEnvelope({ ...envelope, extra: true }));
  assert.throws(() => createRecoveryTargetEnvelope(record({
    target: { kind: 'existing', stableServerId: 'server-0001', path: 'C:\\Minecraft\\..\\Escape' }
  })));
  let getterCalls = 0;
  const unsafe = record();
  Object.defineProperty(unsafe.target, 'path', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'C:\\Unsafe';
    }
  });
  assert.throws(() => createRecoveryTargetEnvelope(unsafe));
  assert.equal(getterCalls, 0);
});

test('initialize durably creates only the registry directories', async (t) => {
  const { userDataPath, calls, registry } = fixture(t);
  await registry.initialize();
  const registryRoot = path.join(userDataPath, 'modpack-lifecycle');

  assert.deepEqual(calls.filter(call => call.kind === 'flush-directory').map(call => call.directoryPath), [
    userDataPath,
    registryRoot,
    registryRoot,
    registryRoot
  ]);
  assert.equal(fs.lstatSync(path.join(registryRoot, 'active')).isDirectory(), true);
  assert.equal(fs.lstatSync(path.join(registryRoot, 'history')).isDirectory(), true);
  assert.equal(fs.lstatSync(path.join(registryRoot, 'retirements')).isDirectory(), true);
});

test('initialize retries directory flush failure without accepting replacement directories', async (t) => {
  const { userDataPath, durableFs, registry } = fixture(t, { failFlushNumber: 2 });
  await assert.rejects(registry.initialize(), error => error.code === 'COMMIT_FAILED');
  await registry.initialize();

  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const displaced = `${active}.displaced`;
  const replacement = `${active}.replacement`;
  fs.mkdirSync(replacement);
  fs.renameSync(active, displaced);
  fs.renameSync(replacement, active);
  await assert.rejects(registry.listActive(), error => ['RECOVERY_REQUIRED', 'COMMIT_FAILED'].includes(error.code));

  const fresh = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs,
    clock: () => new Date('2026-08-01T00:01:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  const scan = await fresh.initialize();
  assert.deepEqual(scan.records, []);
});

test('create publishes the target envelope before the full active record', async (t) => {
  const { calls, registry } = fixture(t);
  await registry.initialize();
  const created = await registry.create(record());

  assert.equal(created.sequence, 0);
  assert.deepEqual(calls.filter(call => call.kind === 'write').slice(0, 2).map(call => path.basename(call.filePath)), [
    'job-0001.target.json',
    'job-0001.json'
  ]);
  assert.equal((await registry.load('job-0001')).target.stableServerId, 'server-0001');
  await assert.rejects(registry.create(record()), error => error.code === 'TARGET_EXISTS');
});

test('all recovery registry JSON publications use the asynchronous durable path', async t => {
  const { calls, registry } = fixture(t, { requireAsyncWrite: true });
  const creation = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-creation',
    operationId: 'job-0001',
    name: 'restore-point-async-publication.zip',
    partName: 'restore-point-async-publication.zip.part',
    createdAt: '2026-08-01T00:00:00.000Z',
    sourceRevision: 0,
    scopeSha256: 'b'.repeat(64),
    backupDirectory: { existed: true, identity: { dev: '11', ino: '22', birthtimeNs: '33' } },
    partIdentity: null,
    archiveSha256: null,
    archiveSize: null,
    metadataSha256: null,
    metadataIdentity: null,
    state: 'prepared'
  };
  await registry.initialize();
  await registry.create({ ...record(), schemaVersion: 2, restoreCreation: creation });
  await registry.transition('job-0001', {
    expectedPhase: 'queued', nextPhase: 'snapshotting', patch: {}
  });
  await registry.clearRestoreCreationAfterCleanup('job-0001', {
    expectedPhase: 'snapshotting', expectedCreation: creation
  });
  await registry.transition('job-0001', {
    expectedPhase: 'snapshotting', nextPhase: 'resolving', patch: {}
  });
  const finished = await registry.finish('job-0001', {
    terminalPhase: 'failed', outcome: { code: 'EXPECTED_TEST_FAILURE' }
  });

  assert.equal(finished.phase, 'failed');
  assert.deepEqual(calls.filter(call => call.kind === 'write').map(call => path.basename(call.filePath)), [
    'job-0001.target.json',
    'job-0001.json',
    'job-0001.json',
    'job-0001.json',
    'job-0001.json',
    'job-0001.json'
  ]);
});

test('transition compares phase, increments sequence, and preserves immutable identity', async (t) => {
  const { registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());

  const next = await registry.transition('job-0001', {
    expectedPhase: 'queued',
    nextPhase: 'resolving',
    patch: { swapStep: 'prepared' }
  });
  assert.equal(next.sequence, 1);
  assert.equal(next.phase, 'resolving');
  assert.equal(next.swapStep, 'prepared');
  await assert.rejects(
    registry.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'failed', patch: {} }),
    error => error.code === 'PLAN_STALE'
  );
  await assert.rejects(
    registry.transition('job-0001', {
      expectedPhase: 'resolving',
      nextPhase: 'failed',
      patch: { target: { kind: 'existing', stableServerId: 'other', path: 'C:\\Other' } }
    }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('finish yields after publishing the terminal record and before moving recovery evidence', async t => {
  let yielded = 0;
  let activeRecordPath;
  let activeEnvelopePath;
  let historyRecordPath;
  const value = fixture(t, {
    async yieldControl() {
      yielded += 1;
      const terminal = JSON.parse(fs.readFileSync(activeRecordPath, 'utf8'));
      assert.equal(terminal.phase, 'completed');
      assert.equal(fs.existsSync(activeEnvelopePath), true);
      assert.equal(fs.existsSync(historyRecordPath), false);
      await new Promise(resolve => setImmediate(resolve));
    }
  });
  activeRecordPath = path.join(value.userDataPath, 'modpack-lifecycle', 'active', 'job-0001.json');
  activeEnvelopePath = path.join(value.userDataPath, 'modpack-lifecycle', 'active', 'job-0001.target.json');
  historyRecordPath = path.join(value.userDataPath, 'modpack-lifecycle', 'history', 'job-0001.json');
  await value.registry.initialize();
  await value.registry.create(record());

  await value.registry.finish('job-0001', {
    terminalPhase: 'completed', outcome: { code: 'OK' }
  });

  assert.equal(yielded, 1);
  assert.equal(fs.existsSync(historyRecordPath), true);
});

test('finish uses asynchronous durable history moves', async t => {
  const { calls, registry } = fixture(t, { requireAsyncRename: true });
  await registry.initialize();
  await registry.create(record());

  const finished = await registry.finish('job-0001', {
    terminalPhase: 'completed', outcome: { code: 'OK' }
  });

  assert.equal(finished.phase, 'completed');
  assert.equal(calls.filter(call => call.kind === 'rename').length, 2);
});

test('registry readers wait until both asynchronous history moves are published', async t => {
  let releaseSecondMove;
  let announceSecondMove;
  const secondMoveEntered = new Promise(resolve => { announceSecondMove = resolve; });
  const secondMoveRelease = new Promise(resolve => { releaseSecondMove = resolve; });
  const value = fixture(t, {
    async beforeAsyncRename({ renameNumber }) {
      if (renameNumber !== 2) return;
      announceSecondMove();
      await secondMoveRelease;
    }
  });
  await value.registry.initialize();
  await value.registry.create(record());
  const finish = value.registry.finish('job-0001', {
    terminalPhase: 'completed', outcome: { code: 'OK' }
  });
  await secondMoveEntered;

  const active = path.join(value.userDataPath, 'modpack-lifecycle', 'active');
  const history = path.join(value.userDataPath, 'modpack-lifecycle', 'history');
  assert.equal(fs.existsSync(path.join(history, 'job-0001.json')), true);
  assert.equal(fs.existsSync(path.join(active, 'job-0001.target.json')), true);
  const fresh = new RecoveryRegistry({
    userDataPath: value.userDataPath,
    fsApi: fs,
    durableFs: value.durableFs,
    clock: () => new Date('2026-08-01T00:01:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  const externalScan = await fresh.initialize();
  assert.equal(externalScan.globalBlock, false);
  assert.equal(externalScan.records.length, 0);
  assert.equal(externalScan.blocks.length, 1);
  assert.equal(externalScan.blocks[0].stableServerId, 'server-0001');
  assert.equal((await fresh.loadHistory('job-0001')).phase, 'completed');
  let readerSettled = false;
  const reader = value.registry.initialize().finally(() => { readerSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(readerSettled, false);

  releaseSecondMove();
  const [finished, scan] = await Promise.all([finish, reader]);
  assert.equal(finished.phase, 'completed');
  assert.equal(scan.records.length, 0);
  assert.equal(scan.blocks.length, 0);
  assert.equal(fs.existsSync(path.join(history, 'job-0001.target.json')), true);
});

test('concurrent finish calls serialize without overwriting terminal evidence', async t => {
  const { registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());

  const request = { terminalPhase: 'completed', outcome: { code: 'OK' } };
  const [first, second] = await Promise.all([
    registry.finish('job-0001', request),
    registry.finish('job-0001', request)
  ]);
  assert.deepEqual(second, first);
  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'failed', outcome: { code: 'DIFFERENT' } }),
    error => error.code === 'RECOVERY_REQUIRED'
  );
  assert.deepEqual(await registry.loadHistory('job-0001'), first);
});

test('closed publication and candidate-boot failure diagnostics survive restart while malformed descriptors are dropped', async (t) => {
  const value = fixture(t);
  await value.registry.initialize();
  await value.registry.create(record());
  await value.registry.transition('job-0001', {
    expectedPhase: 'queued',
    nextPhase: 'resolving',
    patch: { outcome: { failure: { stage: 'durable-move', category: 'io-failure' } } }
  });
  await value.registry.create(record({ jobId: 'job-candidate-boot' }));
  await value.registry.transition('job-candidate-boot', {
    expectedPhase: 'queued',
    nextPhase: 'resolving',
    patch: {
      outcome: {
        failure: {
          stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
        }
      }
    }
  });

  const restarted = new RecoveryRegistry({
    userDataPath: value.userDataPath,
    fsApi: fs,
    durableFs: value.durableFs,
    clock: () => new Date('2026-08-01T00:01:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000002'
  });
  await restarted.initialize();
  assert.deepEqual((await restarted.load('job-0001')).outcome.failure, {
    stage: 'durable-move', category: 'io-failure'
  });
  assert.deepEqual((await restarted.load('job-candidate-boot')).outcome.failure, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });

  const malformedValue = fixture(t);
  await malformedValue.registry.initialize();
  await malformedValue.registry.create(record({ jobId: 'job-malformed' }));
  const created = await malformedValue.registry.transition('job-malformed', {
    expectedPhase: 'queued',
    nextPhase: 'resolving',
    patch: { outcome: {
      failure: {
        stage: 'durable-move',
        category: 'C:\\private\\candidate',
        cause: 'sensitive errno and stack'
      }
    } }
  });
  assert.equal(Object.hasOwn(created.outcome, 'failure'), false);
  assert.doesNotMatch(JSON.stringify(created.outcome), /private|candidate|sensitive|errno|stack/i);

  await malformedValue.registry.create(record({ jobId: 'job-unshaped-failure' }));
  const unshaped = await malformedValue.registry.transition('job-unshaped-failure', {
    expectedPhase: 'queued',
    nextPhase: 'resolving',
    patch: { outcome: {
      failure: { message: 'C:\\private\\candidate raw process output', stack: 'secret stack' }
    } }
  });
  assert.equal(Object.hasOwn(unshaped.outcome, 'failure'), false);
  assert.doesNotMatch(JSON.stringify(unshaped.outcome), /private|candidate|process|secret|stack/i);
});

test('schema two durably anchors an exact restore creation while legacy records migrate closed', async (t) => {
  const creation = {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-creation',
    operationId: 'job-0001',
    name: 'restore-point-2026-08-01T00-00-00.000Z-00000000-0000-4000-8000-000000000017.zip',
    partName: 'restore-point-2026-08-01T00-00-00.000Z-00000000-0000-4000-8000-000000000017.zip.part',
    createdAt: '2026-08-01T00:00:00.000Z',
    sourceRevision: 7,
    scopeSha256: 'b'.repeat(64),
    backupDirectory: { existed: true, identity: { dev: '11', ino: '22', birthtimeNs: '33' } },
    partIdentity: null,
    archiveSha256: null,
    archiveSize: null,
    metadataSha256: null,
    metadataIdentity: null,
    state: 'prepared'
  };
  const { registry } = fixture(t);
  await registry.initialize();
  const created = await registry.create({
    ...record(),
    schemaVersion: 2,
    restoreCreation: creation
  });
  assert.equal(created.schemaVersion, 2);
  assert.deepEqual(created.restoreCreation, creation);
  const writing = await registry.transition('job-0001', {
    expectedPhase: 'queued',
    nextPhase: 'snapshotting',
    patch: {
      restoreCreation: {
        ...creation,
        partIdentity: { dev: '11', ino: '44', birthtimeNs: '55' },
        state: 'writing'
      }
    }
  });
  assert.equal(writing.restoreCreation.state, 'writing');
  const verified = await registry.transition('job-0001', {
    expectedPhase: 'snapshotting',
    nextPhase: 'snapshotting',
    patch: {
      restoreCreation: {
        ...writing.restoreCreation,
        archiveSha256: 'c'.repeat(64),
        archiveSize: 1234,
        metadataSha256: 'd'.repeat(64),
        state: 'verified'
      },
      restorePoint: { id: 'restore-0001', sha256: 'c'.repeat(64) }
    }
  });
  assert.equal(verified.restoreCreation.state, 'verified');
  const metadataWriting = await registry.transition('job-0001', {
    expectedPhase: 'snapshotting', nextPhase: 'snapshotting', patch: {
      restoreCreation: {
        ...verified.restoreCreation,
        metadataIdentity: { dev: '11', ino: '66', birthtimeNs: '77' },
        state: 'metadata-writing'
      }
    }
  });
  const metadataStaged = await registry.transition('job-0001', {
    expectedPhase: 'snapshotting', nextPhase: 'snapshotting', patch: {
      restoreCreation: { ...metadataWriting.restoreCreation, state: 'metadata-staged' }
    }
  });
  const archivePublished = await registry.transition('job-0001', {
    expectedPhase: 'snapshotting', nextPhase: 'snapshotting', patch: {
      restoreCreation: { ...metadataStaged.restoreCreation, state: 'archive-published' }
    }
  });
  const published = await registry.transition('job-0001', {
    expectedPhase: 'snapshotting', nextPhase: 'snapshotting', patch: {
      restoreCreation: { ...archivePublished.restoreCreation, state: 'published' }
    }
  });
  assert.equal(published.restoreCreation.state, 'published');
  const staged = await registry.transition('job-0001', {
    expectedPhase: 'snapshotting',
    nextPhase: 'staging',
    patch: { restoreCreation: null }
  });
  assert.equal(staged.restoreCreation, null);

  const legacyFixture = fixture(t);
  await legacyFixture.registry.initialize();
  const legacyRecord = record({ jobId: 'job-legacy' });
  await legacyFixture.registry.create(legacyRecord);
  const legacyPath = path.join(legacyFixture.userDataPath, 'modpack-lifecycle', 'active', 'job-legacy.json');
  fs.writeFileSync(legacyPath, `${JSON.stringify(legacyRecord, null, 2)}\n`);
  const restarted = new RecoveryRegistry({
    userDataPath: legacyFixture.userDataPath,
    fsApi: fs,
    durableFs: legacyFixture.durableFs,
    clock: () => new Date('2026-08-01T00:00:10.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000019'
  });
  await restarted.initialize();
  const migrated = await restarted.load('job-legacy');
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.restoreCreation, null);
  await restarted.transition('job-legacy', { expectedPhase: 'queued', nextPhase: 'resolving', patch: {} });
  const migratedBytes = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  assert.equal(migratedBytes.schemaVersion, 2);
  assert.equal(migratedBytes.restoreCreation, null);

  for (const unsafe of [
    { ...creation, name: '..\\escape.zip', partName: '..\\escape.zip.part' },
    { ...creation, partName: `${creation.partName}.other` },
    { ...creation, operationId: 'other-job' },
    { ...creation, state: 'writing', partIdentity: null },
    {
      ...creation,
      backupDirectory: { existed: false, identity: null },
      state: 'writing',
      partIdentity: { dev: '11', ino: '44', birthtimeNs: '55' }
    },
    { ...creation, extra: true }
  ]) {
    const invalidFixture = fixture(t);
    await invalidFixture.registry.initialize();
    await assert.rejects(
      invalidFixture.registry.create({
        ...record(),
        schemaVersion: 2,
        restoreCreation: unsafe
      }),
      error => error.code === 'INVALID_REQUEST'
    );
  }

  const monotonicFixture = fixture(t);
  await monotonicFixture.registry.initialize();
  await monotonicFixture.registry.create({ ...record(), schemaVersion: 2, restoreCreation: creation });
  await assert.rejects(
    monotonicFixture.registry.transition('job-0001', {
      expectedPhase: 'queued', nextPhase: 'snapshotting', patch: {
        restoreCreation: { ...creation, name: creation.name.replace('000017', '000018'), partName: creation.partName.replace('000017', '000018') }
      }
    }),
    error => error.code === 'INVALID_REQUEST'
  );
  const anchored = await monotonicFixture.registry.transition('job-0001', {
    expectedPhase: 'queued', nextPhase: 'snapshotting', patch: {
      restoreCreation: {
        ...creation,
        partIdentity: { dev: '11', ino: '44', birthtimeNs: '55' },
        state: 'writing'
      },
      outcome: { failedPointRetirementCandidate: retirementCandidate() }
    }
  });
  await assert.rejects(
    monotonicFixture.registry.transition('job-0001', {
      expectedPhase: anchored.phase, nextPhase: anchored.phase, patch: { restoreCreation: creation }
    }),
    error => error.code === 'INVALID_REQUEST'
  );
  await assert.rejects(
    monotonicFixture.registry.transition('job-0001', {
      expectedPhase: anchored.phase, nextPhase: anchored.phase, patch: { restoreCreation: null }
    }),
    error => error.code === 'INVALID_REQUEST'
  );
  await assert.rejects(
    monotonicFixture.registry.clearRestoreCreationAfterCleanup('job-0001', {
      expectedPhase: anchored.phase,
      expectedCreation: { ...anchored.restoreCreation, partIdentity: { dev: '11', ino: '99', birthtimeNs: '55' } }
    }),
    error => ['INVALID_REQUEST', 'PLAN_STALE'].includes(error.code)
  );
  const cleared = await monotonicFixture.registry.clearRestoreCreationAfterCleanup('job-0001', {
    expectedPhase: anchored.phase,
    expectedCreation: anchored.restoreCreation
  });
  assert.equal(cleared.phase, 'snapshotting');
  assert.equal(cleared.restoreCreation, null);
  assert.equal(cleared.restorePoint, null);
  assert.equal(cleared.outcome.failedPointRetirementCandidate.id, 'restore-0001');
  await monotonicFixture.registry.finish('job-0001', { terminalPhase: 'failed', outcome: { recovery: { action: 'pre-swap-restored' } } });
  assert.equal((await monotonicFixture.registry.initialize()).pendingRestorePointRetirements.length, 0);
  const proof = await monotonicFixture.registry.loadPublishedTerminalEvidence('job-0001', { expectedTarget: record().target, expectedOperationKind: 'install' });
  await assert.rejects(monotonicFixture.registry.writeRestorePointRetirement('job-0001', { expectedSha256: null, value: retirementReceipt(proof) }));
});

test('a corrupt record with a valid envelope creates an exact target block and is retained', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());
  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const recordPath = path.join(active, 'job-0001.json');
  fs.writeFileSync(recordPath, '{bad');

  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.corrupt.length, 1);
  assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  assert.equal(fs.readFileSync(recordPath, 'utf8'), '{bad');
});

test('an unidentifiable corrupt record blocks every start', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  const activeRecordPath = path.join(userDataPath, 'modpack-lifecycle', 'active', 'job-bad.json');
  fs.writeFileSync(activeRecordPath, '{bad');

  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, true);
  assert.equal(fs.readFileSync(activeRecordPath, 'utf8'), '{bad');
});

test('a valid full record identifies its target when the envelope is corrupt', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());
  fs.writeFileSync(path.join(userDataPath, 'modpack-lifecycle', 'active', 'job-0001.target.json'), '{}');

  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false);
  assert.equal(scan.records.length, 1);
  assert.equal(scan.blocks[0].targetPathHash.length, 64);
});

test('record identity is bound to its filename and a conflicting valid envelope blocks both targets', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const recordForOtherJob = record({
    jobId: 'job-other',
    target: { kind: 'existing', stableServerId: 'record-server', path: 'C:\\Minecraft\\Servers\\RecordTarget' },
    candidatePath: null,
    rollbackPath: null,
    failedPath: null,
    journalPath: null
  });
  const envelopeForFilename = createRecoveryTargetEnvelope(record({
    target: { kind: 'existing', stableServerId: 'envelope-server', path: 'C:\\Minecraft\\Servers\\EnvelopeTarget' },
    candidatePath: null,
    rollbackPath: null,
    failedPath: null,
    journalPath: null
  }));
  fs.writeFileSync(path.join(active, 'job-0001.json'), `${JSON.stringify(recordForOtherJob)}\n`);
  fs.writeFileSync(path.join(active, 'job-0001.target.json'), `${JSON.stringify(envelopeForFilename)}\n`);

  const scan = await registry.initialize();
  assert.deepEqual(scan.records, []);
  assert.equal(scan.globalBlock, false);
  assert.deepEqual(new Set(scan.blocks.map(block => block.stableServerId)), new Set(['record-server', 'envelope-server']));
  assert.deepEqual(scan.corrupt, [{ jobId: 'job-0001', recordValid: false, envelopeValid: true, mismatched: true }]);
  await assert.rejects(registry.load('job-0001'), error => error.code === 'RECOVERY_REQUIRED');
});

test('two valid but conflicting record and envelope identities are both retained as target blocks', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());
  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const conflictingEnvelope = createRecoveryTargetEnvelope(record({
    target: { kind: 'existing', stableServerId: 'other-server', path: 'C:\\Minecraft\\Servers\\OtherTarget' },
    candidatePath: null,
    rollbackPath: null,
    failedPath: null,
    journalPath: null
  }));
  fs.writeFileSync(path.join(active, 'job-0001.target.json'), `${JSON.stringify(conflictingEnvelope)}\n`);

  const scan = await registry.initialize();
  assert.equal(scan.records.length, 1);
  assert.equal(scan.globalBlock, false);
  assert.deepEqual(new Set(scan.blocks.map(block => block.stableServerId)), new Set(['server-0001', 'other-server']));
  assert.deepEqual(scan.corrupt, [{ jobId: 'job-0001', recordValid: true, envelopeValid: true, mismatched: true }]);
});

test('an envelope retained after record publication failure remains discoverable', async (t) => {
  const { registry } = fixture(t, { failWriteNumber: 2 });
  await registry.initialize();
  await assert.rejects(registry.create(record()), error => error.code === 'COMMIT_FAILED');

  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.blocks[0].stableServerId, 'server-0001');
});

test('uncertain create publications remain discoverable and blocking', async (t) => {
  await t.test('uncertain envelope publication retains an exact target block', async (st) => {
    const { registry } = fixture(st, { uncertainWriteNumber: 1 });
    await registry.initialize();
    await assert.rejects(registry.create(record()), error => error.code === 'COMMIT_FAILED');
    const scan = await registry.initialize();
    assert.equal(scan.records.length, 0);
    assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  });

  await t.test('uncertain record publication retains the full record and envelope', async (st) => {
    const { registry } = fixture(st, { uncertainWriteNumber: 2 });
    await registry.initialize();
    await assert.rejects(registry.create(record()), error => error.code === 'COMMIT_FAILED');
    const scan = await registry.initialize();
    assert.equal(scan.records[0].jobId, 'job-0001');
    assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  });
});

test('durable failures before create, transition, terminal write, and first history move remain safe', async (t) => {
  await t.test('first envelope publication failure creates no active operation', async (st) => {
    const { registry } = fixture(st, { failWriteNumber: 1 });
    await registry.initialize();
    await assert.rejects(registry.create(record()), error => error.code === 'COMMIT_FAILED');
    const scan = await registry.initialize();
    assert.equal(scan.globalBlock, false);
    assert.deepEqual(scan.records, []);
    assert.deepEqual(scan.blocks, []);
  });

  await t.test('transition write failure preserves the prior active record', async (st) => {
    const { registry } = fixture(st, { failWriteNumber: 3 });
    await registry.initialize();
    await registry.create(record());
    await assert.rejects(
      registry.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'resolving', patch: {} }),
      error => error.code === 'COMMIT_FAILED'
    );
    assert.equal((await registry.load('job-0001')).phase, 'queued');
  });

  await t.test('terminal write failure preserves the nonterminal active record', async (st) => {
    const { registry } = fixture(st, { failWriteNumber: 3 });
    await registry.initialize();
    await registry.create(record());
    await assert.rejects(
      registry.finish('job-0001', { terminalPhase: 'failed', outcome: { code: 'FAILED' } }),
      error => error.code === 'COMMIT_FAILED'
    );
    assert.equal((await registry.load('job-0001')).phase, 'queued');
  });

  await t.test('first history move failure retains a terminal active record and envelope', async (st) => {
    const { registry } = fixture(st, { failRenameNumber: 1 });
    await registry.initialize();
    await registry.create(record());
    await assert.rejects(
      registry.finish('job-0001', { terminalPhase: 'failed', outcome: { code: 'FAILED' } }),
      error => error.code === 'COMMIT_FAILED'
    );
    const scan = await registry.initialize();
    assert.equal(scan.records[0].phase, 'failed');
    assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  });
});

test('offline targets remain active and history never appears in listActive', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record({
    target: { kind: 'existing', stableServerId: 'offline-server', path: 'C:\\Definitely-Missing\\Server' },
    candidatePath: null,
    rollbackPath: null,
    failedPath: null,
    journalPath: null
  }));
  assert.equal((await registry.listActive()).length, 1);

  const finished = await registry.finish('job-0001', {
    terminalPhase: 'failed',
    outcome: { code: 'RECOVERY_REQUIRED', message: 'Manual recovery required' }
  });
  assert.equal(finished.phase, 'failed');
  assert.equal(finished.sequence, 1);
  assert.equal((await registry.listActive()).length, 0);
  assert.deepEqual(await registry.loadHistory('job-0001'), finished);
  assert.equal(await registry.loadHistory('job-missing'), null);
  assert.equal(fs.existsSync(path.join(userDataPath, 'modpack-lifecycle', 'history', 'job-0001.json')), true);
  assert.equal(fs.existsSync(path.join(userDataPath, 'modpack-lifecycle', 'history', 'job-0001.target.json')), true);
});

test('finish is recoverable and retry-safe after failure between history moves', async (t) => {
  const { userDataPath, registry } = fixture(t, { failRenameNumber: 2 });
  await registry.initialize();
  await registry.create(record());

  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
    error => error.code === 'COMMIT_FAILED'
  );
  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const history = path.join(userDataPath, 'modpack-lifecycle', 'history');
  assert.equal(fs.existsSync(path.join(history, 'job-0001.json')), true);
  assert.equal(fs.existsSync(path.join(active, 'job-0001.target.json')), true);
  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false);
  assert.equal(scan.blocks[0].stableServerId, 'server-0001');

  const retry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs: fixtureDurableFs(userDataPath),
    clock: () => new Date('2026-08-01T00:01:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  await retry.initialize();
  await retry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } });
  assert.equal(fs.existsSync(path.join(history, 'job-0001.target.json')), true);
  assert.equal((await retry.listActive()).length, 0);
});

test('an uncertain first history move remains exactly blocked and retryable', async (t) => {
  const { userDataPath, registry } = fixture(t, { uncertainRenameNumber: 1 });
  await registry.initialize();
  await registry.create(record());
  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
    error => error.code === 'COMMIT_FAILED'
  );
  const scan = await registry.initialize();
  assert.equal(scan.records.length, 0);
  assert.equal(scan.blocks[0].stableServerId, 'server-0001');

  const retry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs: fixtureDurableFs(userDataPath),
    clock: () => new Date('2026-08-01T00:01:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  await retry.initialize();
  await retry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } });
  assert.equal((await retry.listActive()).length, 0);
});

test('an uncertain second history move retries idempotently without changing terminal evidence', async t => {
  const { userDataPath, registry } = fixture(t, { uncertainRenameNumber: 2 });
  await registry.initialize();
  await registry.create(record());
  const request = { terminalPhase: 'completed', outcome: { code: 'OK' } };
  await assert.rejects(registry.finish('job-0001', request), error => error.code === 'COMMIT_FAILED');

  const retry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs: fixtureDurableFs(userDataPath),
    clock: () => new Date('2026-08-01T00:01:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  await retry.initialize();
  const finished = await retry.finish('job-0001', request);
  assert.equal(finished.phase, 'completed');
  assert.equal(finished.sequence, 1);
  assert.deepEqual(finished.outcome, { code: 'OK' });
  assert.deepEqual(await retry.loadHistory('job-0001'), finished);
});

test('finish binds both history moves to the bytes that were validated', async (t) => {
  await t.test('record substitution before the first move is rejected and remains active', async (st) => {
    const environment = fixture(st, {
      replaceBeforeRenameNumber: 1,
      replaceBeforeRename({ sourcePath }) {
        const substituted = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        substituted.outcome = { code: 'SUBSTITUTED' };
        fs.writeFileSync(sourcePath, `${JSON.stringify(substituted, null, 2)}\n`);
      }
    });
    await environment.registry.initialize();
    await environment.registry.create(record());
    await assert.rejects(
      environment.registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
      error => ['PLAN_STALE', 'COMMIT_FAILED'].includes(error.code)
    );
    const scan = await environment.registry.initialize();
    assert.equal(scan.records[0].outcome.code, 'SUBSTITUTED');
    assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  });

  await t.test('envelope substitution before the second move retains both target blocks', async (st) => {
    const environment = fixture(st, {
      replaceBeforeRenameNumber: 2,
      replaceBeforeRename({ sourcePath }) {
        const conflicting = createRecoveryTargetEnvelope(record({
          target: { kind: 'existing', stableServerId: 'substituted-server', path: 'C:\\Minecraft\\Servers\\Substituted' },
          candidatePath: null,
          rollbackPath: null,
          failedPath: null,
          journalPath: null
        }));
        fs.writeFileSync(sourcePath, `${JSON.stringify(conflicting, null, 2)}\n`);
      }
    });
    await environment.registry.initialize();
    await environment.registry.create(record());
    await assert.rejects(
      environment.registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
      error => ['PLAN_STALE', 'COMMIT_FAILED'].includes(error.code)
    );
    const scan = await environment.registry.initialize();
    assert.equal(scan.records.length, 0);
    assert.deepEqual(new Set(scan.blocks.map(block => block.stableServerId)),
      new Set(['server-0001', 'substituted-server']));
  });
});

test('finish refuses corrupt target evidence and cannot rewrite a terminal outcome', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());
  const envelopePath = path.join(userDataPath, 'modpack-lifecycle', 'active', 'job-0001.target.json');
  fs.writeFileSync(envelopePath, '{}');
  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
    error => error.code === 'RECOVERY_REQUIRED'
  );

  fs.rmSync(envelopePath);
  const normalizedEnvelope = createRecoveryTargetEnvelope(await registry.load('job-0001'));
  fs.writeFileSync(envelopePath, `${JSON.stringify(normalizedEnvelope, null, 2)}\n`);
  await registry.transition('job-0001', {
    expectedPhase: 'queued',
    nextPhase: 'failed',
    patch: { outcome: { code: 'FIRST' } }
  });
  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'SECOND' } }),
    error => error.code === 'PLAN_STALE'
  );
});

test('invalid schemas and terminal transitions fail without publication', async (t) => {
  const { registry } = fixture(t);
  await registry.initialize();
  await assert.rejects(registry.create({ ...record(), schemaVersion: 2 }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(registry.create({ ...record(), schemaVersion: 3 }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(registry.create({ ...record(), jobId: '../escape' }), error => error.code === 'INVALID_REQUEST');
  await registry.create(record());
  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'committing', outcome: {} }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('job IDs are type checked without executing coercion hooks', async (t) => {
  const { registry } = fixture(t);
  await registry.initialize();
  let coercionCalls = 0;
  const hostileJobId = {
    toString() {
      coercionCalls += 1;
      return 'job-0001';
    }
  };
  await assert.rejects(registry.create(record({ jobId: hostileJobId })), error => error.code === 'INVALID_REQUEST');
  assert.equal(coercionCalls, 0);
});

test('schema accessors are rejected without executing them', async (t) => {
  const { registry } = fixture(t);
  await registry.initialize();
  let reads = 0;
  const unsafe = record();
  Object.defineProperty(unsafe, 'schemaVersion', {
    enumerable: true,
    get() { reads += 1; return 1; }
  });
  await assert.rejects(registry.create(unsafe), error => error.code === 'INVALID_REQUEST');
  assert.equal(reads, 0);
});

function fixtureDurableFs(root) {
  let token = 0;
  return createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      async moveWriteThroughAsync(source, destination) {
        await new Promise(resolve => setImmediate(resolve));
        fs.renameSync(source, destination);
      },
      replaceFileWriteThrough: fs.renameSync,
      async replaceFileWriteThroughAsync(source, destination) {
        await new Promise(resolve => setImmediate(resolve));
        fs.renameSync(source, destination);
      },
      flushDirectory() {},
      async flushDirectoryAsync() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => `retry-${++token}`
  });
}
