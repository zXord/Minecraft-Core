const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const { ModpackRecoveryService, defaultDirectoryAuthority } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
const { ServerRuntimeWriterAuthority } = require('../../electron/services/modpack-lifecycle/server-runtime-writer-authority.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { createExistingSiblingPaths, swapExistingCandidate } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
const { OperationJournal, createDirectoryMarker } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
const { inspectServerDirectoryTree } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const { ModpackRecoveryFacade } = require('../../electron/services/modpack-lifecycle/modpack-recovery-facade.cjs');
const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { reconcileOperationStoreWithRecovery } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');

// Observe only original payload I/O; journal and candidate access stay real and
// outside the counters. The adapter is installed after fixture fingerprinting.
function sourceReadProbe() {
  const opens = [];
  const reads = [];
  const probe = { opens, reads, stage: 'before-work', denyOpen: false,
    fsApi(serverPath) {
      return { ...fs, promises: { ...fs.promises, async open(candidate, ...args) {
        const relative = path.relative(serverPath, candidate).replaceAll(path.sep, '/');
        if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return fs.promises.open(candidate, ...args);
        opens.push({ relative, stage: probe.stage });
        if (probe.denyOpen) throw Object.assign(new Error('controlled source read denial'), { code: 'EACCES' });
        const handle = await fs.promises.open(candidate, ...args);
        return { stat: handle.stat.bind(handle), close: handle.close.bind(handle),
          async read(...readArgs) {
            const result = await handle.read(...readArgs);
            reads.push({ relative, stage: probe.stage, bytes: result.bytesRead });
            return result;
          }
        };
      } } };
    }
  };
  return probe;
}

// Real directory inspection, journal, writer admission and coordinator; only external
// runtime launch/shutdown and the native durability transport are replaced.
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-stopped-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'servers', 'Alpha');
  fs.mkdirSync(path.join(serverPath, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(serverPath, 'config'));
  fs.writeFileSync(path.join(serverPath, 'logs', 'latest.log'), 'old log');
  fs.writeFileSync(path.join(serverPath, 'config', 'broken.toml'), 'malformed = [');
  const reparseInspector = { async isReparsePoint() { return false; } };
  const paths = createExistingSiblingPaths(serverPath, 'job-stopped');
  const original = await inspectServerDirectoryTree(serverPath, { fsApi: fs, reparseInspector });
  const fsApi = options.fsApi ? options.fsApi(serverPath) : fs;
  let candidate = null;
  if (options.candidate || options.between || options.published) {
    fs.mkdirSync(paths.candidatePath);
    fs.writeFileSync(path.join(paths.candidatePath, 'partial.txt'), 'candidate-only');
    candidate = await inspectServerDirectoryTree(paths.candidatePath, { reparseInspector });
  }
  let token = 0;
  const durableFs = createDurableFs({ fsApi: fs, allowedRoots: [root],
    tempNameFactory: () => `stopped-${++token}`,
    durableClient: {
      moveWriteThrough(a, b) { fs.renameSync(a, b); },
      async moveWriteThroughAsync(a, b) { fs.renameSync(a, b); },
      replaceFileWriteThrough(a, b) { fs.renameSync(a, b); },
      async replaceFileWriteThroughAsync(a, b) { fs.renameSync(a, b); },
      flushDirectory() {},
      async flushDirectoryAsync() {}
    }
  });
  let failHistory = false;
  let historyMoves = 0;
  let historyFaultPending = Boolean(options.historyFault);
  const registryDurableFs = {
    ...durableFs,
    async renameDurableAsync(a, b, request) {
      const history = b.includes(`${path.sep}history${path.sep}`);
      if (history) historyMoves++;
      if (options.onHistory && history) await options.onHistory(value);
      const fault = historyFaultPending && history && historyMoves === options.historyFault.move;
      if ((failHistory && history) || (fault && !options.historyFault.after)) {
        historyFaultPending = false;
        throw new Error('history transport failed before effect');
      }
      const result = await durableFs.renameDurableAsync(a, b, request);
      if (fault && options.historyFault.after) {
        historyFaultPending = false;
        throw new Error('history transport failed after effect');
      }
      return result;
    }
  };
  let registry = new RecoveryRegistry({ userDataPath: root, durableFs: registryDurableFs });
  await registry.initialize();
  await registry.create({ schemaVersion: 2, sequence: 0, jobId: 'job-stopped', operationKind: options.operationKind || 'repair',
    target: { kind: 'existing', stableServerId: 'alpha', path: serverPath },
    candidatePath: paths.candidatePath, rollbackPath: paths.rollbackPath, failedPath: paths.failedPath,
    journalPath: null, restorePoint: null, restoreCreation: null,
    priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: original.directoryIdentity, candidate: null, rollback: null, failed: null },
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', outcome: null });
  const outcome = { live: { fingerprint: original.fingerprint }, ...(options.legacyWriter ? {} : { runtimeWriterProtocol: 1 }),
    ...(options.terminal ? { recovery: { action: 'pre-swap-restored', operationId: 'job-stopped' } } : {}),
    ...(options.authorizedCandidate ? { candidateCleanup: {
      deletionAuthorized: true, slot: 'candidate', action: 'pre-swap-restored',
      directoryIdentity: candidate.directoryIdentity, fingerprint: candidate.fingerprint, ownershipMode: 'recorded-identity'
    } } : {}),
    ...(options.between ? {
      rollback: { fingerprint: original.fingerprint }, candidate: { fingerprint: candidate.fingerprint },
      swap: { step: 'live-moved' },
      recovery: { action: 'between-renames-restored', operationId: 'job-stopped' },
      candidateCleanup: { deletionAuthorized: true, slot: 'candidate', action: 'between-renames-restored',
        directoryIdentity: candidate.directoryIdentity, fingerprint: candidate.fingerprint, ownershipMode: 'operation-marker' },
      runtime: { source: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13',
        javaMajor: 17, os: 'win32', architecture: 'x64' }, target: { minecraftVersion: '1.20.1', loaderFamily: 'forge',
        loaderVersion: '47.4.13', javaMajor: 17, os: 'win32', architecture: 'x64' }, maxRam: 6,
        networkAccess: 'loopback', port: 25575 },
      runtimePolicy: { targetRunning: true, targetAutoRestart: false, targetInactive: false }
    } : {}), ...options.outcome };
  await registry.transition('job-stopped', { expectedPhase: 'queued', nextPhase: 'preflight',
    patch: { outcome: options.legacyWriter ? {} : { runtimeWriterProtocol: 1 } } });
  const snapshotPatch = {
      ...(options.between ? { swapStep: 'live-moved' } : {}), ...options.patch, outcome,
      directoryIdentities: { target: original.directoryIdentity, candidate: candidate?.directoryIdentity || null,
        rollback: options.terminal ? original.directoryIdentity : null, failed: null,
        ...(typeof options.identities === 'function' ? options.identities(original) : options.identities) }
    };
  if (options.corrupt) options.corrupt(snapshotPatch);
  let initial = await registry.transition('job-stopped', { expectedPhase: 'preflight',
    nextPhase: 'snapshotting', patch: snapshotPatch });
  if (options.terminal) initial = await registry.transition(initial.jobId, { expectedPhase: 'snapshotting', nextPhase: 'failed', patch: {} });
  if (options.between && !options.candidate) fs.rmSync(paths.candidatePath, { recursive: true });
  const selector = { instanceId: 'alpha', serverPath };
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 4,
    bumpContentRevision() { assert.fail('no revision may be created'); } });
  coordinator.installRecoveryBlocks([{ selector, operationId: initial.jobId }]);
  coordinator.completeStartupRecovery([{ selector, resolved: false }]);
  const calls = [];
  const runtimePolicy = {
    async suspend() { calls.push('suspend'); return { held: true }; },
    async ensureStopped() { calls.push('stop'); if (options.onStop) await options.onStop(value); return options.stopResult || { alreadyStopped: true }; },
    async restoreAutoRestart(request) {
      calls.push('auto'); assert.equal(request.enabled, initial.priorRuntime.autoRestart);
      if (options.onAuto) await options.onAuto(value);
      return options.autoResult || { restored: true };
    },
    async adoptValidatedHandoff() { assert.fail('source adoption forbidden'); }
  };
  const authority = defaultDirectoryAuthority();
  const createService = () => new ModpackRecoveryService({ coordinator, recoveryRegistry: registry, runtimePolicy,
    runtimeWriterAuthority: new ServerRuntimeWriterAuthority({ registry, coordinator, getBootSequence: () => 1 }),
    directoryAuthority: options.authority ? options.authority(authority, calls) : authority,
    restorePointService: options.restorePointService || null,
    contextFactory: async ({ record, mutationLease }) => ({ fsApi, reparseInspector, durableFs,
      jobId: record.jobId, mutationLease, targetPath: serverPath, operationKind: record.operationKind,
      recoveryRegistry: registry, stableInstanceId: 'alpha', runtimePolicy,
      ...(options.published ? { validateCandidate: false, runtime: {}, maxRam: 6,
        healthTimeoutMs: 30000, port: 25575, networkAccess: 'loopback' } : {}),
      async resolveRecoveryRuntimeConfig() {
        calls.push('config');
        if (options.runtimeConfig) return options.runtimeConfig;
        throw new Error('source config must not be resolved');
      },
      healthValidator: { async validateLive() { calls.push('health'); throw new Error('source launch forbidden'); } }
    }) });
  let service = createService();
  const value = { root, serverPath, paths, original, initial, selector, coordinator, registry, service, calls,
    authority, reparseInspector, candidate, durableFs, failHistory(enabled) { failHistory = enabled; },
    recover() { return service.recover(initial); },
    async restartRegistry() {
      registry = new RecoveryRegistry({ userDataPath: root, durableFs: registryDurableFs });
      await registry.initialize();
      service = createService();
      value.registry = registry;
      value.service = service;
    },
    withLease(work) { return coordinator.runRecoveryMutation(selector, { operationId: initial.jobId }, work); },
    async update(patch) {
      initial = await registry.transition(initial.jobId, { expectedPhase: initial.phase, nextPhase: initial.phase, patch });
      value.initial = initial; return initial;
    }
  };
  if (options.published) {
    // Real authenticated candidate and real two-rename publication. Only Java is
    // excluded; this is not a pre-swap record relabeled as published rollback.
    const operationRoot = path.join(paths.candidatePath, '.minecraft-core-state', 'operations', initial.jobId);
    fs.mkdirSync(operationRoot, { recursive: true });
    const marker = createDirectoryMarker({ jobId: initial.jobId, operationKind: initial.operationKind,
      stableInstanceId: 'alpha', createdAt: '2026-10-09T00:00:00.000Z' });
    await durableFs.writeJsonAtomicAsync(path.join(operationRoot, 'directory-marker.json'), marker,
      { expectedTargetSha256: null });
    const journal = new OperationJournal({ durableFs, fsApi: fs, clock: () => new Date() });
    const journalPath = path.join(operationRoot, 'journal.json');
    await journal.create(journalPath, { jobId: initial.jobId, operationKind: initial.operationKind,
      stableInstanceId: 'alpha', targetPath: serverPath, candidateIdentity: candidate.directoryIdentity,
      markerSha256: marker.checksum });
    candidate = await inspectServerDirectoryTree(paths.candidatePath, { reparseInspector,
      mutableRelativePaths: [`.minecraft-core-state/operations/${initial.jobId}/journal.json`] });
    await journal.transition(journalPath, { expectedPhase: 'staging', nextPhase: 'committing', patch: {
      swapStep: 'prepared', targetIdentity: original.directoryIdentity, sourceFingerprint: original.fingerprint,
      candidateFingerprint: candidate.fingerprint } });
    initial = await registry.transition(initial.jobId, { expectedPhase: initial.phase, nextPhase: 'committing', patch: {
      swapStep: 'prepared', journalPath, outcome: { ...initial.outcome,
        candidate: { fingerprint: candidate.fingerprint, markerSha256: marker.checksum, health: { ready: true } },
        runtime: { source: {}, target: {}, maxRam: 6, networkAccess: 'loopback', port: 25575 },
        runtimePolicy: { targetRunning: true, targetAutoRestart: false, targetInactive: false } } } });
    await value.withLease(lease => swapExistingCandidate({ fsApi: fs, durableFs, reparseInspector,
      jobId: initial.jobId, targetPath: serverPath, operationKind: initial.operationKind,
      stableInstanceId: 'alpha', recoveryRegistry: registry, mutationLease: lease,
      validateCandidate: false, runtime: {}, maxRam: 6, healthTimeoutMs: 30000, port: 25575 }));
    initial = await registry.load(initial.jobId);
    if (options.mutable !== false) {
      await journal.transition(path.join(serverPath, '.minecraft-core-state', 'operations', initial.jobId, 'journal.json'), {
        expectedPhase: 'starting', nextPhase: 'validating-live', patch: {} });
      initial = await registry.transition(initial.jobId, { expectedPhase: 'starting', nextPhase: 'validating-live',
        patch: { outcome: { ...initial.outcome, liveMutationAuthorized: true,
          liveValidation: { properties: { canonical: true } } } } });
      fs.writeFileSync(path.join(serverPath, 'post-boot.txt'), 'candidate legitimately mutated after boot');
    }
    value.initial = initial;
    value.candidate = candidate;
    value.journal = journal;
    value.failedJournalPath = path.join(paths.failedPath, '.minecraft-core-state', 'operations', initial.jobId, 'journal.json');
    if (options.terminalCorrupt) {
      const transition = registry.transition.bind(registry);
      registry.transition = async (jobId, request) => {
        if (request.nextPhase === 'rolled-back') {
          const terminal = { ...structuredClone(await registry.load(jobId)), ...structuredClone(request.patch) };
          options.terminalCorrupt(terminal);
          request = { ...request, patch: { ...request.patch, priorRuntime: terminal.priorRuntime,
            directoryIdentities: terminal.directoryIdentities, swapStep: terminal.swapStep,
            restoreCreation: terminal.restoreCreation, outcome: terminal.outcome } };
        }
        return transition(jobId, request);
      };
    }
  }
  return value;
}

test('stopped published rollback restores malformed original without source config or health boot', async t => {
  let proofs = 0;
  let renames = 0;
  const value = await fixture(t, { published: true, authority: base => ({ ...base,
    async verifyOriginal(request) { proofs++; return base.verifyOriginal(request); },
    async renameExact(request) { renames++; return base.renameExact(request); }
  }) });
  assert.deepEqual(value.initial.priorRuntime, { running: false, autoRestart: false });
  assert.deepEqual(value.initial.outcome.runtimePolicy, {
    targetRunning: true, targetAutoRestart: false, targetInactive: false
  });
  const result = await value.withLease(lease => value.service.rollbackWithLease(value.initial, lease));
  assert.deepEqual(result, { jobId: 'job-stopped', resolved: true, action: 'rollback-restored' });
  assert.ok(proofs >= 3, 'initial restoration must still use full original proof');
  assert.equal(renames, 2, 'failed candidate move and exact original restoration');
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'utf8'), 'malformed = [');
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'utf8'), 'old log');
  assert.equal(fs.readFileSync(path.join(value.paths.failedPath, 'post-boot.txt'), 'utf8'), 'candidate legitimately mutated after boot');
  assert.equal(value.calls.includes('config'), false);
  assert.equal(value.calls.includes('health'), false);
  assert.equal(value.calls.at(-1), 'auto');
  const history = await value.registry.loadHistory('job-stopped');
  assert.equal(history.phase, 'rolled-back');
  assert.equal(history.swapStep, 'rollback-restored');
  assert.equal(history.outcome.health, undefined);
  assert.equal(history.outcome.revisionEvent, undefined);
  assert.equal(await value.registry.load('job-stopped'), null);
  assert.deepEqual(fs.readdirSync(value.registry.historyPath).sort(), ['job-stopped.json', 'job-stopped.target.json']);
});

async function publishedTerminal(t, options = {}) {
  let preparing = true;
  const value = await fixture(t, { ...options, published: true,
    onStop: async c => { if (!preparing && options.onStop) await options.onStop(c); },
    onAuto: async c => { if (!preparing && options.onAuto) await options.onAuto(c); },
    onHistory: async c => { if (!preparing && options.onHistory) await options.onHistory(c); }
  });
  value.failHistory(true);
  await value.withLease(lease => assert.rejects(value.service.rollbackWithLease(value.initial, lease),
    { code: 'RECOVERY_REQUIRED' }));
  value.initial = await value.registry.load(value.initial.jobId);
  assert.equal(value.initial.phase, 'rolled-back');
  value.failHistory(false);
  value.calls.length = 0;
  preparing = false;
  return value;
}

// Removing either terminal route, or reintroducing historical hashing, breaks
// this test despite legitimate current drift and unreadable source payload.
for (const entry of ['recoverWithLease', 'rollbackWithLease']) for (const mutable of [false, true]) {
  test(`stopped published terminal ${entry} retains current drift without payload reads (${mutable ? 'mutable' : 'immutable'} failed)`, async t => {
    const probe = sourceReadProbe();
    let renames = 0;
    const value = await publishedTerminal(t, { mutable, fsApi: probe.fsApi,
      authority: base => ({ ...base, async renameExact(request) { renames++; return base.renameExact(request); } }) });
    const before = value.initial;
    const initialRenames = renames;
    fs.writeFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'legitimate drift = [');
    fs.writeFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'previous buggy recovery log');
    probe.opens.length = 0;
    probe.reads.length = 0;
    probe.denyOpen = true;
    await value.restartRegistry();
    const result = await value.withLease(lease => value.service[entry](value.initial, lease));
    assert.deepEqual(result, { jobId: 'job-stopped', resolved: true, action: 'rollback-restored' });
    assert.deepEqual(probe.opens, []);
    assert.deepEqual(probe.reads, []);
    assert.equal(renames, initialRenames);
    assert.deepEqual(value.calls, ['stop', 'auto']);
    assert.equal(fs.readFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'utf8'), 'previous buggy recovery log');
    assert.equal(fs.existsSync(value.paths.failedPath), true);
    const history = await value.registry.loadHistory('job-stopped');
    assert.equal(history.sequence, before.sequence);
    assert.deepEqual(history.outcome, before.outcome);
  });
}

for (const move of [1, 2]) for (const after of [false, true]) {
  test(`stopped published history move ${move} ${after ? 'after' : 'before'} effect keeps reservation and exact retry semantics`, async t => {
    let retry = false;
    let protectedMoves = 0;
    const probe = sourceReadProbe();
    const value = await fixture(t, { published: true, fsApi: probe.fsApi, historyFault: { move, after },
      onAuto: async c => {
        if (!retry) await assert.rejects(c.coordinator.acquireStart(c.selector, { operation: 'competing-policy',
          operationId: 'other', parentMutationLease: c.parentLease }), { code: 'OPERATION_IN_PROGRESS' });
      },
      onHistory: async c => {
        if (retry) return;
        protectedMoves++;
        await assert.rejects(c.coordinator.acquireStart(c.selector, { operation: 'competing-history',
          operationId: 'other', parentMutationLease: c.parentLease }), { code: 'OPERATION_IN_PROGRESS' });
        await assert.rejects(c.coordinator.acquireStart(c.selector, { operation: 'ordinary-history',
          operationId: 'ordinary', parentMutationLease: null }));
      } });
    await value.withLease(async lease => {
      value.parentLease = lease;
      await assert.rejects(value.service.rollbackWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
      const released = await value.coordinator.acquireStart(value.selector, { operation: 'prove-release',
        operationId: 'after-failure', parentMutationLease: lease });
      released.release();
    });
    assert.equal(protectedMoves, move);
    const activeSurvives = move === 1 && !after;
    assert.equal(Boolean(await value.registry.load('job-stopped')), activeSurvives);
    await assert.rejects(value.coordinator.acquireStart(value.selector, { operation: 'quarantined',
      operationId: 'later', parentMutationLease: null }), { code: 'RECOVERY_REQUIRED' });
    const calls = [...value.calls];
    retry = true;
    fs.writeFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'safe retry drift');
    probe.opens.length = 0;
    probe.denyOpen = true;
    await value.restartRegistry();
    const result = await value.recover();
    assert.equal(result.action, activeSurvives ? 'rollback-restored' : 'already-finished');
    assert.deepEqual(probe.opens, []);
    assert.deepEqual(value.calls, activeSurvives ? [...calls, 'suspend', 'stop', 'auto'] : calls);
    assert.equal(fs.existsSync(value.paths.failedPath), true);
    assert.deepEqual(fs.readdirSync(value.registry.historyPath).sort(), ['job-stopped.json', 'job-stopped.target.json']);
    const admitted = await value.coordinator.acquireStart(value.selector, { operation: 'resolved',
      operationId: 'later', parentMutationLease: null });
    admitted.release();
  });
}

for (const mutable of [false, true]) test(`stopped published authentic lagging journal is synchronized (${mutable ? 'mutable' : 'immutable'})`, async t => {
  const value = await publishedTerminal(t, { mutable });
  await value.journal.transition(value.failedJournalPath, { expectedPhase: 'rolled-back', nextPhase: 'rolling-back', patch: {} });
  assert.equal((await value.recover()).resolved, true);
  assert.equal(value.journal.load(value.failedJournalPath).phase, 'rolled-back');
  assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
});

const publishedContradictions = [
  ['action', r => { r.outcome.recovery.action = 'pre-swap-restored'; }],
  ['job', r => { r.outcome.recovery.operationId = 'other-job'; }],
  ['restored step', r => { r.swapStep = 'candidate-published'; }],
  ['publication lineage', r => { r.outcome.swap.step = 'live-moved'; }],
  ['original identity', r => { r.directoryIdentities.target = r.directoryIdentities.candidate; }],
  ['rollback identity missing', r => { r.directoryIdentities.rollback = null; }],
  ['candidate identity missing', r => { r.directoryIdentities.candidate = null; }],
  ['failed identity', r => { r.directoryIdentities.failed = r.directoryIdentities.target; }],
  ['source fingerprint missing', r => { delete r.outcome.live.fingerprint; }],
  ['restoration fingerprint', r => { r.outcome.rollback.fingerprint = 'b'.repeat(64); }],
  ['candidate fingerprint', r => { r.outcome.candidate.fingerprint = 'b'.repeat(64); }],
  ['marker digest', r => { r.outcome.candidate.markerSha256 = 'b'.repeat(64); }],
  ['committed health', r => { r.outcome.health = { ready: true }; }],
  ['revision', r => { r.outcome.revisionEvent = { published: false }; }],
  ['handoff', r => { r.outcome.runtimePolicy.handoffEventId = 'handoff'; }],
  ['running-restored', r => { r.outcome.runtimePolicy.runningRestored = true; }]
];
for (const [name, corrupt] of publishedContradictions) test(`stopped published contradictory ${name} fails closed without source boot`, async t => {
  const value = await publishedTerminal(t, { terminalCorrupt: corrupt });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('config'), false);
  assert.equal(value.calls.includes('health'), false);
  assert.equal(value.calls.includes('auto'), false);
  assert.equal(fs.existsSync(value.paths.failedPath), true);
  assert.equal(await value.registry.loadHistory('job-stopped'), null);
});

for (const mutable of [false, true]) for (const [name, patch] of [
  ['unrelated phase', { phase: 'validating-live' }],
  ['wrong step', { swapStep: 'candidate-published' }],
  ['wrong source digest', { sourceFingerprint: 'b'.repeat(64) }],
  ['wrong rollback digest', { rollbackFingerprint: 'b'.repeat(64) }],
  ['revision id', { revisionEventId: 'revision' }],
  ['revision publication', { revisionEventId: 'revision', revisionEventPublished: true }]
]) test(`stopped published ${mutable ? 'mutable' : 'immutable'} failed journal rejects ${name}`, async t => {
  const value = await publishedTerminal(t, { mutable });
  const { phase = 'rolled-back', ...changes } = patch;
  await value.journal.transition(value.failedJournalPath, { expectedPhase: 'rolled-back', nextPhase: phase, patch: changes });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
  assert.equal(value.calls.includes('config'), false);
  assert.equal(await value.registry.loadHistory('job-stopped'), null);
});

for (const missing of ['journal.json', 'directory-marker.json']) test(`stopped published missing failed ${missing} cannot authorize finish`, async t => {
  const value = await publishedTerminal(t);
  fs.unlinkSync(path.join(path.dirname(value.failedJournalPath), missing));
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
  assert.equal(value.calls.includes('config'), false);
});

for (const name of ['journal.json', 'directory-marker.json']) test(`stopped published failed authority hardlink ${name} blocks retention`, async t => {
  const value = await publishedTerminal(t);
  fs.linkSync(path.join(path.dirname(value.failedJournalPath), name), path.join(value.root, `linked-${name}`));
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
  assert.equal(value.calls.includes('config'), false);
  assert.equal(await value.registry.loadHistory('job-stopped'), null);
});

for (const slot of ['original', 'journal.json', 'directory-marker.json', 'failed-root']) {
  test(`stopped published genuine symlink or junction in ${slot} blocks retention`, async t => {
    const value = await publishedTerminal(t);
    const target = slot === 'original' ? path.join(value.serverPath, 'config', 'broken.toml')
      : slot === 'failed-root' ? value.paths.failedPath : path.join(path.dirname(value.failedJournalPath), slot);
    const moved = path.join(value.root, `symlink-target-${slot}`);
    fs.renameSync(target, moved);
    try { fs.symlinkSync(moved, target, slot === 'failed-root' ? 'junction' : 'file'); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      t.skip(`Platform refused genuine symlink creation: ${error.code}`);
      return;
    }
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(value.calls.includes('auto'), false);
    assert.equal(value.calls.includes('config'), false);
    assert.equal(await value.registry.loadHistory('job-stopped'), null);
  });
}

for (const topology of ['missing-source', 'candidate-present', 'rollback-present', 'failed-missing',
  'source-replaced', 'failed-replaced', 'source-hardlink']) {
  test(`stopped published current ${topology} refuses retention`, async t => {
    const value = await publishedTerminal(t);
    if (topology === 'missing-source') fs.renameSync(value.serverPath, path.join(value.root, 'saved-source'));
    if (topology === 'candidate-present') fs.mkdirSync(value.paths.candidatePath);
    if (topology === 'rollback-present') fs.mkdirSync(value.paths.rollbackPath);
    if (topology === 'failed-missing') fs.renameSync(value.paths.failedPath, path.join(value.root, 'saved-failed'));
    if (topology === 'source-replaced' || topology === 'failed-replaced') {
      const target = topology === 'source-replaced' ? value.serverPath : value.paths.failedPath;
      fs.renameSync(target, path.join(value.root, 'saved-tree'));
      fs.mkdirSync(target);
    }
    if (topology === 'source-hardlink') fs.linkSync(path.join(value.serverPath, 'config', 'broken.toml'),
      path.join(value.root, 'linked-source.toml'));
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(value.calls.includes('auto'), false);
    assert.equal(value.calls.includes('config'), false);
    assert.equal(await value.registry.loadHistory('job-stopped'), null);
  });
}

for (const replacement of ['parent', 'source', 'failed', 'authority-hardlink']) {
  test(`stopped published ${replacement} replacement during policy keeps quarantine`, async t => {
    const value = await publishedTerminal(t, { onAuto: async c => {
      if (replacement === 'parent') {
        const parent = path.dirname(c.serverPath);
        const saved = path.join(c.root, 'saved-parent');
        fs.renameSync(parent, saved);
        fs.mkdirSync(parent);
        // The same source/failed roots in a different parent still must fail.
        for (const name of fs.readdirSync(saved)) fs.renameSync(path.join(saved, name), path.join(parent, name));
      } else if (replacement === 'authority-hardlink') {
        fs.linkSync(c.failedJournalPath, path.join(c.root, 'linked-journal.json'));
      } else {
        const target = replacement === 'source' ? c.serverPath : c.paths.failedPath;
        fs.renameSync(target, path.join(c.root, 'saved-tree'));
        fs.mkdirSync(target);
      }
    } });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(await value.registry.loadHistory('job-stopped'), null);
    assert.equal((await value.registry.load('job-stopped')).phase, 'rolled-back');
    await assert.rejects(value.coordinator.acquireStart(value.selector,
      { operation: 'quarantined', operationId: 'other', parentMutationLease: null }), { code: 'RECOVERY_REQUIRED' });
  });
}

for (const boundary of ['stop', 'policy']) test(`stopped published ${boundary} failure retains terminal authority and releases reservation`, async t => {
  let fail = true;
  const value = await publishedTerminal(t, { [boundary === 'stop' ? 'onStop' : 'onAuto']: async () => {
    if (fail) throw new Error(`controlled ${boundary} failure`);
  } });
  await value.withLease(async lease => {
    await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
    const start = await value.coordinator.acquireStart(value.selector, { operation: 'prove-release',
      operationId: 'other', parentMutationLease: lease });
    start.release();
  });
  assert.equal((await value.registry.load('job-stopped')).phase, 'rolled-back');
  assert.equal(fs.existsSync(value.paths.failedPath), true);
  fail = false;
  assert.equal((await value.recover()).action, 'rollback-restored');
});

test('stopped published source safety and policy boundaries hold genuine nested start reservation', async t => {
  const value = await publishedTerminal(t, { onAuto: async c => {
    c.stage = 'after-policy';
    await assert.rejects(c.coordinator.acquireStart(c.selector, { operation: 'competing-policy', operationId: 'other',
      parentMutationLease: c.parentLease }), { code: 'OPERATION_IN_PROGRESS' });
  } });
  const observed = [];
  value.stage = 'before-policy';
  value.reparseInspector.isReparsePoint = async candidate => {
    if (path.relative(value.serverPath, candidate).replaceAll(path.sep, '/') === 'config/broken.toml') {
      observed.push(value.stage);
      await assert.rejects(value.coordinator.acquireStart(value.selector, { operation: 'competing-source', operationId: 'other',
        parentMutationLease: value.parentLease }), { code: 'OPERATION_IN_PROGRESS' });
    }
    return false;
  };
  await value.withLease(async lease => {
    value.parentLease = lease;
    assert.equal((await value.service.recoverWithLease(value.initial, lease)).resolved, true);
  });
  assert.deepEqual(observed, ['before-policy', 'after-policy', 'after-policy']);
});

test('stopped published source safety is rechecked after the last awaited failed-authority proof', async t => {
  const value = await publishedTerminal(t);
  let markerChecks = 0;
  value.reparseInspector.isReparsePoint = async candidate => {
    if (path.relative(value.paths.failedPath, candidate).replaceAll(path.sep, '/') ===
        '.minecraft-core-state/operations/job-stopped/directory-marker.json' && ++markerChecks === 5) {
      fs.linkSync(path.join(value.serverPath, 'config', 'broken.toml'), path.join(value.root, 'last-boundary-hardlink'));
    }
    return false;
  };
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(markerChecks, 6);
  assert.equal(await value.registry.loadHistory('job-stopped'), null);
  assert.equal((await value.registry.load('job-stopped')).phase, 'rolled-back');
});

test('stopped published unsettled candidate worker refuses before context and source work', async t => {
  const value = await publishedTerminal(t);
  const marker = { schemaVersion: 1, jobId: value.initial.jobId, candidatePath: value.paths.candidatePath,
    candidateIdentity: value.candidate.directoryIdentity, bootSequence: 1, state: 'unproven' };
  const active = await value.registry.updateRuntimeWriterAuthority(value.initial.jobId, {
    expectedSequence: value.initial.sequence, authority: marker, failureCode: null });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(value.calls, []);
  assert.equal(fs.existsSync(value.paths.failedPath), true);
  await value.registry.updateRuntimeWriterAuthority(value.initial.jobId, { expectedSequence: active.sequence,
    authority: { ...marker, state: 'settled' }, failureCode: null });
  assert.equal((await value.recover()).action, 'rollback-restored');
});

for (const priorRuntime of [{ running: true, autoRestart: false }, { running: false, autoRestart: true }]) {
  test(`published prior ${JSON.stringify(priorRuntime)} preserves ordinary source health requirement`, async t => {
    const value = await publishedTerminal(t, { patch: { priorRuntime }, runtimeConfig: {
      runtime: {}, maxRam: 6, networkAccess: 'loopback', port: 25575 } });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(value.calls.includes('config'), true);
    assert.equal(value.calls.includes('health'), true);
    assert.equal(await value.registry.loadHistory('job-stopped'), null);
  });
}

test('stopped published immutable failed payload drift still requires full candidate proof', async t => {
  const value = await publishedTerminal(t, { mutable: false });
  fs.writeFileSync(path.join(value.paths.failedPath, 'partial.txt'), 'unauthorized candidate drift');
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
  assert.equal(value.calls.includes('config'), false);
});

test('stopped published intermediate rollback-restored still requires original payload proof', async t => {
  const value = await fixture(t, { published: true });
  const transition = value.registry.transition.bind(value.registry);
  value.registry.transition = async (jobId, request) => {
    if (request.nextPhase === 'rolled-back') throw new Error('terminal transition refused before effect');
    return transition(jobId, request);
  };
  await value.withLease(lease => assert.rejects(value.service.rollbackWithLease(value.initial, lease),
    { code: 'RECOVERY_REQUIRED' }));
  const intermediate = await value.registry.load('job-stopped');
  assert.equal(intermediate.phase, 'rolling-back');
  assert.equal(intermediate.swapStep, 'rollback-restored');
  value.registry.transition = transition;
  fs.writeFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'not terminal retain authority');
  value.calls.length = 0;
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
  assert.equal(value.calls.includes('config'), false);
  assert.equal((await value.registry.load('job-stopped')).phase, 'rolling-back');
});

test('stopped published unresolved restore creation never acquires retention authority', async t => {
  const value = await publishedTerminal(t, { patch: { restoreCreation: restoreCreation() } });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
  assert.equal(value.calls.includes('config'), false);
  assert.deepEqual((await value.registry.load('job-stopped')).restoreCreation, restoreCreation());
});

for (const [name, changed] of [['job', { jobId: 'other-job' }], ['instance', { stableInstanceId: 'other' }],
  ['operation', { operationKind: 'upgrade' }]]) test(`stopped published actual failed marker with wrong ${name} is rejected`, async t => {
  const value = await publishedTerminal(t);
  const marker = createDirectoryMarker({ jobId: 'job-stopped', stableInstanceId: 'alpha', operationKind: 'repair',
    createdAt: '2026-10-09T00:00:00.000Z', ...changed });
  fs.writeFileSync(path.join(path.dirname(value.failedJournalPath), 'directory-marker.json'), JSON.stringify(marker));
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
  assert.equal(value.calls.includes('config'), false);
});

test('stopped published facade reconciles public rolled-back only after authenticated finish', async t => {
  const value = await publishedTerminal(t);
  const store = await recoveryStore(value);
  await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: value.registry,
    jobs: [await store.get('job-stopped')] });
  assert.equal((await store.get('job-stopped')).phase, 'recovery-required');
  const facade = new ModpackRecoveryFacade({ recoveryRegistry: value.registry, recoveryService: value.service,
    hasActiveJob: () => false,
    canExposePendingNewServer: () => false,
    onResolved: async () => {
      assert.ok(await value.registry.loadHistory('job-stopped'));
      await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: value.registry,
        jobs: [await store.get('job-stopped')] });
      return (await store.get('job-stopped')).phase === 'rolled-back';
    } });
  const listed = await facade.listRecovery();
  const result = await facade.recover({ recoveryId: listed.items[0].recoveryId, actionId: 'retry-recovery' });
  assert.equal(result.resolved, true);
  assert.equal(result.operationStateReconciled, true);
  assert.equal((await store.get('job-stopped')).outcome.status, 'rolled-back');
  assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
});

test('stopped original initial cleanup proves full source and finishes failed without config or boot', async t => {
  let originalProofs = 0;
  const probe = sourceReadProbe();
  const inspected = [];
  const value = await fixture(t, { candidate: true, fsApi: probe.fsApi,
    onAuto: async () => { probe.stage = 'after-policy'; },
    authority: base => ({ ...base, async verifyOriginal(request) {
      originalProofs++;
      assert.equal((await value.registry.load('job-stopped')).phase, 'snapshotting');
      assert.equal((await value.registry.load('job-stopped')).outcome.recovery, undefined);
      probe.stage = 'full-proof';
      const proof = await base.verifyOriginal(request);
      probe.stage = 'after-work';
      return proof;
    } }) });
  const before = await inspectServerDirectoryTree(value.serverPath, { reparseInspector: value.reparseInspector });
  value.reparseInspector.isReparsePoint = async candidate => {
    inspected.push({ relative: path.relative(value.serverPath, candidate).replaceAll(path.sep, '/'), stage: probe.stage });
    return false;
  };
  const result = await value.recover();
  assert.deepEqual(result, { jobId: 'job-stopped', resolved: true, action: 'pre-swap-restored' });
  const historical = await value.registry.loadHistory('job-stopped');
  assert.equal(historical.phase, 'failed');
  assert.deepEqual(historical.outcome.recovery, { action: 'pre-swap-restored', operationId: 'job-stopped' });
  assert.equal((await inspectServerDirectoryTree(value.serverPath, { reparseInspector: value.reparseInspector })).fingerprint, before.fingerprint);
  assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
  assert.equal(originalProofs, 1);
  assert.deepEqual(probe.opens, [
    { relative: 'config/broken.toml', stage: 'full-proof' },
    { relative: 'logs/latest.log', stage: 'full-proof' }
  ]);
  assert.equal(probe.reads.reduce((total, read) => total + read.bytes, 0), 20);
  for (const stage of ['before-work', 'after-work', 'after-policy']) {
    assert.ok(inspected.some(entry => entry.stage === stage && entry.relative === 'config/broken.toml'), stage);
    assert.ok(inspected.some(entry => entry.stage === stage && entry.relative === 'logs/latest.log'), stage);
  }
  assert.equal(fs.existsSync(value.paths.candidatePath), false);
  assert.equal(historical.outcome.candidateCleanup.deletionAuthorized, true);
  assert.equal(await value.registry.load('job-stopped'), null);
  assert.deepEqual(fs.readdirSync(value.registry.activePath), []);
  assert.deepEqual(fs.readdirSync(value.registry.historyPath).sort(), ['job-stopped.json', 'job-stopped.target.json']);
  const start = await value.coordinator.acquireStart(value.selector, { operation: 'later-start', operationId: 'later', parentMutationLease: null });
  start.release();
});

// Catches treating the coherent native failed/live-moved record as a mandatory
// health retry, or rewriting its outcome/sequence to fit the no-swap route.
test('stopped between-renames native terminal retains changed config and log without second restore or boot', async t => {
  let renames = 0;
  const value = await fixture(t, { terminal: true, between: true,
    authority: base => ({ ...base, async renameExact(request) { renames++; return base.renameExact(request); } }) });
  fs.writeFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'still broken = [changed');
  fs.writeFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'failed boot wrote this safe log');
  const result = await value.recover();
  assert.deepEqual(result, { jobId: 'job-stopped', resolved: true, action: 'between-renames-restored' });
  assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
  assert.equal(renames, 0);
  const historical = await value.registry.loadHistory('job-stopped');
  assert.equal(historical.sequence, value.initial.sequence);
  assert.deepEqual(historical.outcome, value.initial.outcome);
  assert.equal(historical.outcome.candidateCleanup.ownershipMode, 'operation-marker');
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'utf8'), 'still broken = [changed');
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'utf8'), 'failed boot wrote this safe log');
  assert.deepEqual(fs.readdirSync(value.registry.historyPath).sort(), ['job-stopped.json', 'job-stopped.target.json']);
  const start = await value.coordinator.acquireStart(value.selector,
    { operation: 'ordinary-start', operationId: 'later', parentMutationLease: null });
  start.release();
});

const betweenContradictions = [
  ['cleanup missing', r => { delete r.outcome.candidateCleanup; }],
  ['cleanup null', r => { r.outcome.candidateCleanup = null; }],
  ['cleanup action', r => { r.outcome.candidateCleanup.action = 'pre-swap-restored'; }],
  ['cleanup deletion flag', r => { r.outcome.candidateCleanup.deletionAuthorized = false; }],
  ['cleanup slot', r => { r.outcome.candidateCleanup.slot = 'rollback'; }],
  ['cleanup mode', r => { r.outcome.candidateCleanup.ownershipMode = 'unknown'; }],
  ['cleanup identity', r => { r.outcome.candidateCleanup.directoryIdentity = r.directoryIdentities.target; }],
  ['cleanup digest', r => { r.outcome.candidateCleanup.fingerprint = 'b'.repeat(64); }],
  ['cleanup malformed digest', r => { r.outcome.candidateCleanup.fingerprint = 'bad'; }],
  ['recovery job', r => { r.outcome.recovery.operationId = 'different-job'; }],
  ['recovery action', r => { r.outcome.recovery.action = 'pre-swap-restored'; }],
  ['candidate identity missing', r => { r.directoryIdentities.candidate = null; }],
  ['candidate digest missing', r => { delete r.outcome.candidate.fingerprint; }],
  ['candidate digest malformed', r => { r.outcome.candidate.fingerprint = 'bad'; }],
  ['identity crossing', r => { r.directoryIdentities.candidate = r.directoryIdentities.target; }],
  ['target identity missing', r => { r.directoryIdentities.target = null; }],
  ['rollback identity missing', r => { r.directoryIdentities.rollback = null; }],
  ['rollback identity crossed', r => { r.directoryIdentities.rollback = r.directoryIdentities.candidate; }],
  ['failed identity', r => { r.directoryIdentities.failed = r.directoryIdentities.candidate; }],
  ['live digest missing', r => { delete r.outcome.live.fingerprint; }],
  ['rollback digest missing', r => { delete r.outcome.rollback.fingerprint; }],
  ['live digest malformed', r => { r.outcome.live.fingerprint = 'BAD'; }],
  ['rollback digest mismatch', r => { r.outcome.rollback.fingerprint = 'b'.repeat(64); }],
  ['restore creation', r => { r.restoreCreation = restoreCreation(); }],
  ['swap missing', r => { delete r.outcome.swap; }],
  ['swap null', r => { r.outcome.swap = null; }],
  ['swap false', r => { r.outcome.swap = false; }],
  ['swap unknown step', r => { r.outcome.swap.step = 'unknown'; }],
  ['swap extra field', r => { r.outcome.swap.published = false; }],
  ...['publication', 'registration', 'liveValidation', 'revisionEvent'].flatMap(key =>
    [[`${key} empty`, r => { r.outcome[key] = {}; }], [`${key} false`, r => { r.outcome[key] = false; }]]),
  ['live mutation true', r => { r.outcome.liveMutationAuthorized = true; }],
  ['live mutation malformed', r => { r.outcome.liveMutationAuthorized = {}; }]
];
for (const candidate of [false, true]) for (const [name, corrupt] of betweenContradictions) {
  test(`stopped between-renames ${name}, candidate=${candidate} refuses before cleanup policy or boot`, async t => {
    const value = await fixture(t, { terminal: true, between: true, candidate, corrupt });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.deepEqual(value.calls, ['suspend']);
    assert.equal(await value.registry.loadHistory('job-stopped'), null);
    assert.equal(fs.existsSync(value.paths.candidatePath), candidate);
    assert.equal(fs.readFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'utf8'), 'malformed = [');
  });
}

async function recoveryStore(value) {
  const store = new OperationStore({ userDataPath: value.root, durableFs: value.registry.durableFs });
  await store.initialize();
  await store.create({ jobId: 'job-stopped', operationKind: 'repair', serverId: 'alpha' });
  await store.transition('job-stopped', { expectedPhase: 'queued', nextPhase: 'preflight', patch: {} });
  await store.transition('job-stopped', { expectedPhase: 'preflight', nextPhase: 'recovery-required', patch: {
    outcome: { status: 'recovery-required', message: 'Reviewed recovery required', errorCode: 'RECOVERY_REQUIRED' }
  } });
  return store;
}

test('stopped between-renames facade reconciles real OperationStore only after authenticated history', async t => {
  const value = await fixture(t, { terminal: true, between: true });
  const store = await recoveryStore(value);
  await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: value.registry,
    jobs: [await store.get('job-stopped')] });
  assert.equal((await store.get('job-stopped')).phase, 'recovery-required');
  const facade = new ModpackRecoveryFacade({ recoveryRegistry: value.registry, recoveryService: value.service,
    hasActiveJob: () => false,
    canExposePendingNewServer: () => false,
    onResolved: async () => {
      assert.ok(await value.registry.loadHistory('job-stopped'));
      await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: value.registry,
        jobs: [await store.get('job-stopped')] });
      return (await store.get('job-stopped')).phase === 'rolled-back';
    } });
  const listed = await facade.listRecovery();
  const result = await facade.recover({ recoveryId: listed.items[0].recoveryId, actionId: 'retry-recovery' });
  assert.equal(result.resolved, true);
  assert.equal(result.operationStateReconciled, true);
  assert.equal((await store.get('job-stopped')).phase, 'rolled-back');
  assert.equal((await store.get('job-stopped')).outcome.status, 'rolled-back');
  assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
});

for (const move of [1, 2]) for (const after of [false, true]) {
  test(`stopped between-renames history move ${move} ${after ? 'after' : 'before'} effect retries after registry restart`, async t => {
    let retry = false;
    let protectedMoves = 0;
    const value = await fixture(t, { terminal: true, between: true, historyFault: { move, after },
      onHistory: async c => {
        if (!retry) {
          protectedMoves++;
          await assert.rejects(c.coordinator.acquireStart(c.selector, { operation: 'competing-health', operationId: 'other',
            parentMutationLease: c.parentLease }), { code: 'OPERATION_IN_PROGRESS' });
        }
      } });
    const store = await recoveryStore(value);
    const before = value.initial;
    await value.withLease(async lease => {
      value.parentLease = lease;
      await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
    });
    assert.equal(protectedMoves, move);
    assert.equal((await store.get('job-stopped')).phase, 'recovery-required');
    await assert.rejects(value.coordinator.acquireStart(value.selector,
      { operation: 'ordinary-start', operationId: 'blocked', parentMutationLease: null }), { code: 'RECOVERY_REQUIRED' });
    const activeSurvives = move === 1 && !after;
    assert.equal(Boolean(await value.registry.load('job-stopped')), activeSurvives);
    const callsBeforeRetry = [...value.calls];
    retry = true;
    await value.restartRegistry();
    fs.writeFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'safe bytes after failed publication');
    const result = await value.recover();
    assert.equal(result.resolved, true);
    assert.equal(result.action, activeSurvives ? 'between-renames-restored' : 'already-finished');
    assert.deepEqual(value.calls, activeSurvives ? [...callsBeforeRetry, 'suspend', 'stop', 'auto'] : callsBeforeRetry);
    const historical = await value.registry.loadHistory('job-stopped');
    assert.deepEqual(historical.outcome, before.outcome);
    assert.equal(historical.sequence, before.sequence);
    assert.deepEqual(fs.readdirSync(value.registry.historyPath).sort(), ['job-stopped.json', 'job-stopped.target.json']);
    assert.equal(fs.readFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'utf8'), 'safe bytes after failed publication');
    await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: value.registry,
      jobs: [await store.get('job-stopped')] });
    assert.equal((await store.get('job-stopped')).phase, 'rolled-back');
  });
}

test('stopped between-renames terminal partial candidate deletion retries exact durable authority', async t => {
  let fail = true;
  let removals = 0;
  const value = await fixture(t, { terminal: true, between: true, candidate: true,
    authority: base => ({ ...base, async removeAuthorizedIdentity(request) {
      removals++;
      if (fail) {
        fs.unlinkSync(path.join(request.directoryPath, 'partial.txt'));
        throw new Error('partial candidate deletion');
      }
      return base.removeAuthorizedIdentity(request);
    } }) });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual((await value.registry.load('job-stopped')).outcome, value.initial.outcome);
  assert.equal(fs.existsSync(value.paths.candidatePath), true);
  assert.equal(fs.existsSync(path.join(value.paths.candidatePath, 'partial.txt')), false);
  assert.equal(value.calls.includes('auto'), false);
  fail = false;
  await value.restartRegistry();
  assert.equal((await value.recover()).resolved, true);
  assert.equal(removals, 2);
  assert.equal(fs.existsSync(value.paths.candidatePath), false);
  assert.deepEqual((await value.registry.loadHistory('job-stopped')).outcome, value.initial.outcome);
  assert.equal((await value.registry.loadHistory('job-stopped')).sequence, value.initial.sequence);
  assert.equal(value.calls.includes('config'), false);
});

for (const boundary of ['stop', 'work']) for (const replacement of ['parent', 'root']) {
  test(`stopped between-renames ${replacement} replacement at awaited ${boundary} boundary stays quarantined`, async t => {
    let changed = false;
    const replace = async c => {
      await new Promise(resolve => setImmediate(resolve));
      changed = true;
      if (replacement === 'parent') {
        const parent = path.dirname(c.serverPath);
        fs.renameSync(parent, path.join(c.root, 'saved-parent'));
        fs.mkdirSync(parent);
        fs.renameSync(path.join(c.root, 'saved-parent', 'Alpha'), c.serverPath);
      } else {
        fs.renameSync(c.serverPath, path.join(c.root, 'saved-original'));
        fs.mkdirSync(c.serverPath);
        fs.writeFileSync(path.join(c.serverPath, 'unrelated.txt'), 'replacement must survive');
      }
    };
    const value = await fixture(t, { terminal: true, between: true,
      ...(boundary === 'stop' ? { onStop: replace } : {
        authority: base => ({ ...base, async inspectFresh(request) {
          const result = await base.inspectFresh(request);
          if (!changed && request.directoryPath.toLowerCase() === value.serverPath.toLowerCase()) await replace(value);
          return result;
        } })
      }) });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(changed, true);
    assert.equal(value.calls.includes('auto'), false);
    assert.equal(value.calls.includes('config'), false);
    assert.equal(await value.registry.loadHistory('job-stopped'), null);
    assert.deepEqual((await value.registry.load('job-stopped')).outcome, value.initial.outcome);
    if (replacement === 'root') assert.equal(fs.readFileSync(path.join(value.serverPath, 'unrelated.txt'), 'utf8'), 'replacement must survive');
  });
}

test('stopped between-renames replaced candidate is not durable deletion authority', async t => {
  const value = await fixture(t, { terminal: true, between: true, candidate: true });
  fs.renameSync(value.paths.candidatePath, path.join(value.root, 'saved-candidate'));
  fs.mkdirSync(value.paths.candidatePath);
  fs.writeFileSync(path.join(value.paths.candidatePath, 'unrelated.txt'), 'replacement candidate survives');
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(value.paths.candidatePath, 'unrelated.txt'), 'utf8'), 'replacement candidate survives');
  assert.equal(fs.readFileSync(path.join(value.root, 'saved-candidate', 'partial.txt'), 'utf8'), 'candidate-only');
  assert.equal(value.calls.includes('auto'), false);
});

test('stopped between-renames explicit live-mutation false remains eligible', async t => {
  const value = await fixture(t, { terminal: true, between: true, outcome: { liveMutationAuthorized: false } });
  assert.equal((await value.recover()).resolved, true);
  assert.equal(value.calls.includes('config'), false);
  assert.equal((await value.registry.loadHistory('job-stopped')).outcome.liveMutationAuthorized, false);
});

for (const relative of ['logs/latest.log', 'config/broken.toml']) {
  test(`stopped native-shaped terminal retry retains safe current ${relative} bytes and exact outcome`, async t => {
    const probe = sourceReadProbe();
    const value = await fixture(t, { terminal: true, fsApi: probe.fsApi });
    const before = value.initial;
    fs.writeFileSync(path.join(value.serverPath, relative), 'current user bytes');
    assert.notEqual((await inspectServerDirectoryTree(value.serverPath, { reparseInspector: value.reparseInspector })).fingerprint, value.original.fingerprint);
    const result = await value.recover();
    assert.equal(result.resolved, true);
    assert.equal(fs.readFileSync(path.join(value.serverPath, relative), 'utf8'), 'current user bytes');
    const historical = await value.registry.loadHistory(before.jobId);
    assert.equal(historical.schemaVersion, 2);
    assert.equal(historical.phase, 'failed');
    assert.deepEqual(historical.outcome, before.outcome);
    assert.equal(historical.sequence, before.sequence);
    assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
    assert.deepEqual(probe.opens.map(open => open.relative), ['config/broken.toml', 'logs/latest.log']);
    assert.equal(probe.reads.reduce((total, read) => total + read.bytes, 0), relative === 'logs/latest.log' ? 31 : 25);
  });
}

test('stopped retain structural checkpoints do not require payload read access after the full proof', async t => {
  const probe = sourceReadProbe();
  const value = await fixture(t, { candidate: true, fsApi: probe.fsApi,
    authority: base => ({ ...base, async verifyOriginal(request) {
      assert.equal((await value.registry.load('job-stopped')).phase, 'snapshotting');
      const proof = await base.verifyOriginal(request);
      probe.denyOpen = true;
      return proof;
    } }) });
  assert.equal((await value.recover()).resolved, true);
  assert.equal(probe.denyOpen, true);
  assert.equal(probe.opens.length, 2);
  assert.equal(probe.reads.reduce((total, read) => total + read.bytes, 0), 20);
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'utf8'), 'malformed = [');
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'utf8'), 'old log');
  assert.equal(fs.existsSync(value.paths.candidatePath), false);
  const historical = await value.registry.loadHistory(value.initial.jobId);
  assert.equal(historical.phase, 'failed');
  assert.deepEqual(historical.outcome.recovery, { action: 'pre-swap-restored', operationId: 'job-stopped' });
});

test('stopped initial full proof still rejects payload read-open failure before settlement', async t => {
  const probe = sourceReadProbe();
  let fullProofs = 0;
  const value = await fixture(t, { fsApi: probe.fsApi,
    authority: base => ({ ...base, async verifyOriginal(request) {
      fullProofs++;
      probe.denyOpen = true;
      return base.verifyOriginal(request);
    } }) });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fullProofs, 1);
  assert.equal(probe.opens.length, 1);
  assert.deepEqual(probe.reads, []);
  const active = await value.registry.load(value.initial.jobId);
  assert.equal(active.phase, 'snapshotting');
  assert.equal(active.outcome.recovery, undefined);
  assert.equal(await value.registry.loadHistory(value.initial.jobId), null);
  assert.equal(value.calls.includes('auto'), false);
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'utf8'), 'malformed = [');
});

test('stopped retain reservation holds through policy and finish and releases on durable failure for exact retry', async t => {
  const value = await fixture(t, { terminal: true, onAuto: async c => {
    await assert.rejects(c.coordinator.acquireStart(c.selector, { operation: 'conflicting-health', operationId: 'other',
      parentMutationLease: c.parentLease }), { code: 'OPERATION_IN_PROGRESS' });
  } });
  value.failHistory(true);
  const outcome = structuredClone(value.initial.outcome);
  await value.withLease(async lease => {
    value.parentLease = lease;
    await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
    const released = await value.coordinator.acquireStart(value.selector, { operation: 'prove-release', operationId: 'other', parentMutationLease: lease });
    released.release();
  });
  assert.deepEqual((await value.registry.load('job-stopped')).outcome, outcome);
  await assert.rejects(value.coordinator.acquireStart(value.selector, { operation: 'ordinary-start', operationId: 'other', parentMutationLease: null }), { code: 'RECOVERY_REQUIRED' });
  value.failHistory(false);
  await value.withLease(async lease => {
    value.parentLease = lease;
    assert.equal((await value.service.recoverWithLease(value.initial, lease)).resolved, true);
  });
  assert.deepEqual((await value.registry.loadHistory('job-stopped')).outcome, outcome);
});

for (const between of [false, true]) for (const slot of ['source', 'candidate']) {
  test(`stopped ${between ? 'between-renames ' : ''}retain WithLease and top-level recovery reject retained ${slot} health start authority`, async t => {
    const value = await fixture(t, { terminal: true, between });
    let retained;
    await value.withLease(async lease => {
      retained = await value.coordinator.acquireStart({ instanceId: 'alpha',
        serverPath: slot === 'candidate' ? value.paths.candidatePath : value.serverPath }, {
        operation: 'health-validation', operationId: 'retained-health', parentMutationLease: lease });
      await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
      assert.equal((await value.registry.load(value.initial.jobId)).phase, 'failed');
      assert.equal(value.calls.includes('auto'), false);
    });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    retained.release();
    assert.equal((await value.recover()).resolved, true);
  });
}

for (const between of [false, true]) test(`stopped ${between ? 'between-renames ' : ''}retain rejects forged, expired and nonambient mutation parents with actual coordinator`, async t => {
  const value = await fixture(t, { terminal: true, between });
  let expired;
  await value.withLease(async lease => { expired = lease; });
  const fake = { kind: 'mutation', operationId: 'job-stopped', instanceId: 'alpha', serverPath: value.serverPath, markDirty() {} };
  for (const lease of [fake, expired]) {
    await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
  }
  let continueWork;
  let admitted;
  const active = new Promise(resolve => { admitted = resolve; });
  const finished = value.withLease(async lease => {
    admitted(lease);
    await new Promise(resolve => { continueWork = resolve; });
  });
  const nonambient = await active;
  try {
    await assert.rejects(value.service.recoverWithLease(value.initial, nonambient), { code: 'RECOVERY_REQUIRED' });
  } finally { continueWork(); await finished; }
  assert.equal((await value.recover()).resolved, true);
});

test('stopped initial recovery rejects changed original bytes before durable restored action', async t => {
  const value = await fixture(t);
  fs.writeFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'new bytes');
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  const active = await value.registry.load(value.initial.jobId);
  assert.equal(active.phase, 'snapshotting');
  assert.equal(active.outcome.recovery, undefined);
  assert.equal(value.calls.includes('auto'), false);
});

const contradictions = [
  ['wrong operation', { recovery: { action: 'pre-swap-restored', operationId: 'other-job' } }],
  ['missing operation', { recovery: { action: 'pre-swap-restored' } }],
  ['no source evidence', { live: null }],
  ['conflicting fingerprints', { rollback: { fingerprint: 'f'.repeat(64) } }],
  ['malformed historical fingerprint', { rollback: { fingerprint: 0 } }],
  ['publication', { publication: { state: 'published' } }],
  ['registration', { registration: { complete: false } }],
  ['live authorization', { liveMutationAuthorized: true }],
  ['malformed live authorization', { liveMutationAuthorized: 'false' }],
  ['live validation', { liveValidation: {} }],
  ['revision event', { revisionEvent: { published: false } }],
  ['crossed outcome swap', { swap: { step: 'live-moved' } }],
  ['malformed outcome swap', { swap: 'none' }]
];
for (const [name, outcome] of contradictions) {
  test(`stopped terminal retain rejects ${name} without launching`, async t => {
    const value = await fixture(t, { terminal: true, outcome });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(await value.registry.loadHistory(value.initial.jobId), null);
    assert.equal(value.calls.includes('config'), false);
    assert.equal(value.calls.includes('auto'), false);
  });
}

for (const mismatch of ['rollback', 'candidate', 'failed']) {
  test(`stopped terminal retain rejects conflicting ${mismatch} identity`, async t => {
    // Real schema normalizes shape but deliberately does not enforce these
    // semantic identity relationships; construct it before the terminal phase.
    const initial = await fixture(t, { terminal: true, identities: original => ({ [mismatch]: mismatch === 'candidate'
      ? original.directoryIdentity : { volumeSerial: 'aa', fileId: 'bb' } }) });
    await assert.rejects(initial.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(initial.calls.includes('config'), false);
  });
}

for (const between of [false, true]) for (const topology of ['missing', 'replacement', 'rollback', 'failed', 'symlink', 'hardlink']) {
  test(`stopped ${between ? 'between-renames ' : ''}terminal retain rejects ${topology} canonical topology`, async t => {
    const value = await fixture(t, { terminal: true, between });
    if (topology === 'missing' || topology === 'replacement') {
      fs.renameSync(value.serverPath, path.join(value.root, 'retained-original'));
      if (topology === 'replacement') fs.mkdirSync(value.serverPath);
    } else if (topology === 'rollback' || topology === 'failed') {
      fs.mkdirSync(value.paths[`${topology}Path`]);
    } else if (topology === 'symlink') {
      fs.renameSync(value.serverPath, path.join(value.root, 'retained-original'));
      fs.symlinkSync(path.join(value.root, 'retained-original'), value.serverPath, 'junction');
    } else {
      fs.linkSync(path.join(value.serverPath, 'config', 'broken.toml'), path.join(value.serverPath, 'config', 'linked.toml'));
    }
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(await value.registry.loadHistory(value.initial.jobId), null);
    assert.equal(value.calls.includes('auto'), false);
  });
}

for (const between of [false, true]) for (const change of ['target', 'parent', 'rollback', 'failed', 'candidate']) {
  test(`stopped ${between ? 'between-renames ' : ''}retain rechecks ${change} after awaited policy restoration`, async t => {
    const value = await fixture(t, { terminal: true, between, onAuto: async c => {
      await new Promise(resolve => setImmediate(resolve));
      if (change === 'target') {
        fs.renameSync(c.serverPath, path.join(c.root, 'saved-target')); fs.mkdirSync(c.serverPath);
      } else if (change === 'parent') {
        const parent = path.dirname(c.serverPath);
        fs.renameSync(parent, path.join(c.root, 'saved-parent'));
        fs.mkdirSync(parent);
        fs.renameSync(path.join(c.root, 'saved-parent', 'Alpha'), c.serverPath);
      } else fs.mkdirSync(c.paths[`${change}Path`]);
    } });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.ok(await value.registry.load(value.initial.jobId));
    assert.equal(await value.registry.loadHistory(value.initial.jobId), null);
  });
}

for (const between of [false, true]) for (const change of ['hardlink', 'reparse', 'membership', 'replacement', 'metadata']) {
  test(`stopped ${between ? 'between-renames ' : ''}retain rejects after-policy descendant ${change} and keeps active recovery`, async t => {
    let afterPolicy = false;
    let mutated = false;
    let policyConfigReads = 0;
    const value = await fixture(t, { terminal: true, between,
      fsApi: serverPath => ({ ...fs, promises: { ...fs.promises,
        async readdir(candidate, ...args) {
          const names = await fs.promises.readdir(candidate, ...args);
          if (afterPolicy && candidate.toLowerCase() === path.join(serverPath, 'config').toLowerCase()) {
            policyConfigReads++;
            if (!mutated && change === 'membership') {
              mutated = true;
              fs.writeFileSync(path.join(candidate, 'appeared.toml'), 'external new member');
            } else if (!mutated && change === 'metadata' && policyConfigReads === 2) {
              mutated = true;
              fs.utimesSync(path.join(candidate, 'broken.toml'), new Date('2000-01-01'), new Date('2000-01-01'));
            }
          }
          return names;
        },
        async lstat(candidate, ...args) {
          const stat = await fs.promises.lstat(candidate, ...args);
          if (afterPolicy && !mutated && change === 'replacement' &&
              candidate.toLowerCase() === path.join(serverPath, 'config', 'broken.toml').toLowerCase()) {
            mutated = true;
            fs.renameSync(candidate, path.join(value.root, 'saved-broken.toml'));
            fs.writeFileSync(candidate, 'malformed = [');
          }
          return stat;
        }
      } }),
      onAuto: async c => {
        await new Promise(resolve => setImmediate(resolve));
        afterPolicy = true;
        if (change === 'hardlink') {
          mutated = true;
          fs.linkSync(path.join(c.serverPath, 'config', 'broken.toml'), path.join(c.serverPath, 'config', 'linked.toml'));
        } else if (change === 'reparse') {
          mutated = true;
          c.reparseInspector.isReparsePoint = async candidate => candidate.toLowerCase() === path.join(c.serverPath, 'config').toLowerCase();
        }
      }
    });
    await value.withLease(async lease => {
      await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
      const start = await value.coordinator.acquireStart(value.selector, { operation: 'prove-release',
        operationId: 'release', parentMutationLease: lease });
      start.release();
    });
    assert.equal(mutated, true);
    assert.equal(value.calls.includes('auto'), true);
    assert.equal(value.calls.includes('config'), false);
    assert.equal(value.calls.includes('health'), false);
    assert.deepEqual((await value.registry.load(value.initial.jobId)).outcome, value.initial.outcome);
    assert.equal(await value.registry.loadHistory(value.initial.jobId), null);
    assert.equal(fs.readFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'utf8'), 'malformed = [');
    assert.equal(fs.readFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'utf8'), 'old log');
  });
}

for (const between of [false, true]) for (const [name, policy] of [['stop', { stopResult: { stopped: false } }], ['auto-restart', { autoResult: { restored: false } }]]) {
  test(`stopped ${between ? 'between-renames ' : ''}retain ${name} proof failure retains recovery and releases reservation`, async t => {
    const value = await fixture(t, { terminal: true, between, ...policy });
    await value.withLease(async lease => {
      await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
      const start = await value.coordinator.acquireStart(value.selector, { operation: 'prove-release', operationId: 'release', parentMutationLease: lease });
      start.release();
    });
    assert.ok(await value.registry.load(value.initial.jobId));
  });
}

test('stopped initial candidate cleanup preserves independent exact deletion proof and resumes partial deletion', async t => {
  let fail = true;
  const value = await fixture(t, { candidate: true, authority: base => ({ ...base,
    async removeAuthorizedIdentity(request) {
      if (fail) {
        fs.unlinkSync(path.join(request.directoryPath, 'partial.txt'));
        throw new Error('partial deletion failed');
      }
      return base.removeAuthorizedIdentity(request);
    }
  }) });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  const active = await value.registry.load(value.initial.jobId);
  assert.equal(active.phase, 'failed');
  assert.equal(active.outcome.candidateCleanup.deletionAuthorized, true);
  assert.equal(fs.existsSync(value.paths.candidatePath), true);
  fail = false;
  assert.equal((await value.recover()).resolved, true);
  assert.equal(fs.existsSync(value.paths.candidatePath), false);
  assert.equal((await value.registry.loadHistory(value.initial.jobId)).phase, 'failed');
});

test('stopped terminal candidate without prior deletion authority remains untouched', async t => {
  const value = await fixture(t, { terminal: true, candidate: true });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(value.paths.candidatePath, 'partial.txt'), 'utf8'), 'candidate-only');
  assert.equal(value.calls.includes('auto'), false);
});

test('stopped terminal candidate with exact existing deletion authority is independently removed', async t => {
  const value = await fixture(t, { terminal: true, candidate: true, authorizedCandidate: true });
  assert.equal((await value.recover()).resolved, true);
  assert.equal(fs.existsSync(value.paths.candidatePath), false);
  assert.deepEqual((await value.registry.loadHistory(value.initial.jobId)).outcome, value.initial.outcome);
});

for (const operationKind of ['upgrade', 'downgrade', 'switch', 'import']) {
  test(`stopped never-published ${operationKind} uses the same retain-only rule`, async t => {
    const value = await fixture(t, { operationKind });
    assert.equal((await value.recover()).resolved, true);
    assert.equal((await value.registry.loadHistory(value.initial.jobId)).phase, 'failed');
    assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
  });
}

for (const between of [false, true]) for (const policy of [{ running: true, autoRestart: false }, { running: false, autoRestart: true }]) {
  test(`${between ? 'between-renames ' : ''}prior running=${policy.running} autoRestart=${policy.autoRestart} still requires normal source health`, async t => {
    const value = await fixture(t, { terminal: true, between, patch: { priorRuntime: policy }, runtimeConfig: {
      runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0', javaMajor: 17 },
      maxRam: 4, port: 25565, networkAccess: 'pack-default'
    } });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.deepEqual(value.calls, ['suspend', 'stop', 'config', 'health']);
  });
}

for (const swapStep of ['prepared', 'live-moved', 'candidate-published', 'rollback-restored']) {
  test(`terminal ${swapStep} cannot use stopped retain exception`, async t => {
    const value = await fixture(t, { terminal: true, patch: { swapStep } });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(value.calls.includes('config'), swapStep !== 'live-moved');
    assert.equal(value.calls.includes('auto'), false);
  });
}

test('between-renames terminal action keeps ordinary source validation', async t => {
  const value = await fixture(t, { terminal: true, outcome: { recovery: {
    action: 'between-renames-restored', operationId: 'job-stopped'
  } } });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('config'), true);
});

for (const between of [false, true]) test(`${between ? 'between-renames ' : ''}unsettled same-boot writer blocks stopped retain before source context and remains quarantined`, async t => {
  const value = await fixture(t, { terminal: true, between, candidate: true, authorizedCandidate: true });
  const marker = { schemaVersion: 1, jobId: value.initial.jobId, candidatePath: value.paths.candidatePath,
    candidateIdentity: value.candidate.directoryIdentity, bootSequence: 1, state: 'unproven' };
  const active = await value.registry.updateRuntimeWriterAuthority(value.initial.jobId, {
    expectedSequence: value.initial.sequence, authority: marker, failureCode: null
  });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(value.calls, []);
  assert.equal(fs.existsSync(value.paths.candidatePath), true);
  await assert.rejects(value.coordinator.acquireStart(value.selector, { operation: 'ordinary-start', operationId: 'other', parentMutationLease: null }), { code: 'RECOVERY_REQUIRED' });
  await value.registry.updateRuntimeWriterAuthority(value.initial.jobId, { expectedSequence: active.sequence,
    authority: { ...marker, state: 'settled' }, failureCode: null });
  assert.equal((await value.recover()).resolved, true);
});

function restoreCreation() {
  return { schemaVersion: 1, kind: 'minecraft-core-lifecycle-restore-creation', operationId: 'job-stopped',
    name: 'restore-point-stopped.zip', partName: 'restore-point-stopped.zip.part',
    createdAt: '2026-10-09T00:00:00.000Z', sourceRevision: 4, scopeSha256: 'b'.repeat(64),
    backupDirectory: { existed: false, identity: null }, partIdentity: null,
    archiveSha256: null, archiveSize: null, metadataSha256: null, metadataIdentity: null, state: 'prepared' };
}

for (const cleanup of ['success', 'diagnostics', 'error']) {
  test(`initial stopped retain interrupted restore cleanup ${cleanup} gates full proof and failed transition`, async t => {
    let cleanups = 0;
    const restorePointService = {
      async cleanupInterruptedRestorePointCreation(request) {
        cleanups++;
        assert.equal(request.operationId, 'job-stopped');
        assert.deepEqual(request.creationIntent, restoreCreation());
        if (cleanup === 'error') throw new Error('restore cleanup transport failed');
        return { cleaned: 0, diagnostics: cleanup === 'diagnostics' ? [{ code: 'BACKUP_UNCERTAIN' }] : [] };
      },
      async verifyRestorePoint() { assert.fail('retention is not restore validation'); },
      async restoreToFreshCandidate() { assert.fail('retention must not reconstruct source'); }
    };
    const value = await fixture(t, { patch: { restoreCreation: restoreCreation() }, restorePointService,
      authority: (base, calls) => ({ ...base, async verifyOriginal(request) {
        assert.equal(cleanups, 1, 'full proof must follow restore cleanup');
        assert.equal((await value.registry.load(value.initial.jobId)).restoreCreation, null);
        calls.push('full-proof');
        return base.verifyOriginal(request);
      } }) });
    if (cleanup === 'success') {
      assert.equal((await value.recover()).resolved, true);
      const historical = await value.registry.loadHistory(value.initial.jobId);
      assert.equal(historical.restoreCreation, null);
      assert.deepEqual(value.calls, ['suspend', 'stop', 'full-proof', 'auto']);
    } else {
      await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
      const active = await value.registry.load(value.initial.jobId);
      assert.equal(active.phase, 'snapshotting');
      assert.deepEqual(active.restoreCreation, restoreCreation());
      assert.equal(active.outcome.recovery, undefined);
    }
  });
}

test('terminal stopped retain never drops unresolved restore creation', async t => {
  const value = await fixture(t, { terminal: true, patch: { restoreCreation: restoreCreation() } });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(value.calls, ['suspend']);
  assert.deepEqual((await value.registry.load(value.initial.jobId)).restoreCreation, restoreCreation());
});

test('stopped retain detects parent replacement during ensureStopped before source proof', async t => {
  const value = await fixture(t, { terminal: true, onStop: async c => {
    const parent = path.dirname(c.serverPath);
    fs.renameSync(parent, path.join(c.root, 'saved-parent'));
    fs.mkdirSync(parent);
    fs.renameSync(path.join(c.root, 'saved-parent', 'Alpha'), c.serverPath);
  } });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
});

test('pre-swap none restores an authenticated original rollback sibling then retains stopped without boot', async t => {
  const value = await fixture(t);
  fs.renameSync(value.serverPath, value.paths.rollbackPath);
  assert.equal((await value.recover()).resolved, true);
  assert.equal(fs.existsSync(value.paths.rollbackPath), false);
  const inspection = await inspectServerDirectoryTree(value.serverPath, { reparseInspector: value.reparseInspector });
  assert.deepEqual(inspection.directoryIdentity, value.original.directoryIdentity);
  assert.equal(inspection.fingerprint, value.original.fingerprint);
  assert.equal(value.calls.includes('config'), false);
  assert.equal(value.calls.includes('health'), false);
  assert.equal((await value.registry.loadHistory(value.initial.jobId)).phase, 'failed');
});

test('restored original finish failure retries exact terminal outcome with changed bytes and no second rename', async t => {
  let renames = 0;
  const value = await fixture(t, { authority: base => ({ ...base, async renameExact(request) {
    renames++;
    return base.renameExact(request);
  } }) });
  fs.renameSync(value.serverPath, value.paths.rollbackPath);
  value.failHistory(true);
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  const restored = await value.registry.load(value.initial.jobId);
  assert.equal(restored.phase, 'failed');
  assert.deepEqual(restored.outcome.recovery, { action: 'pre-swap-restored', operationId: value.initial.jobId });
  assert.equal(renames, 1);
  fs.writeFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'current log after restored failed finish');
  value.failHistory(false);
  assert.equal((await value.recover()).resolved, true);
  assert.equal(renames, 1);
  assert.equal(value.calls.includes('config'), false);
  assert.deepEqual((await value.registry.loadHistory(value.initial.jobId)).outcome, restored.outcome);
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'utf8'), 'current log after restored failed finish');
});

test('pre-swap none rollback original fingerprint mismatch never authorizes restoration rename', async t => {
  let renames = 0;
  const value = await fixture(t, { authority: base => ({ ...base, async renameExact(request) {
    renames++; return base.renameExact(request);
  } }) });
  fs.renameSync(value.serverPath, value.paths.rollbackPath);
  fs.writeFileSync(path.join(value.paths.rollbackPath, 'config', 'broken.toml'), 'changed before restoration');
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(renames, 0);
  assert.equal(fs.existsSync(value.serverPath), false);
  assert.equal((await value.registry.load(value.initial.jobId)).phase, 'snapshotting');
});

test('pre-swap none restores exact recorded rollback identity when original target slot is null', async t => {
  const value = await fixture(t, { identities: original => ({ target: null, rollback: original.directoryIdentity }) });
  fs.renameSync(value.serverPath, value.paths.rollbackPath);
  assert.equal((await value.recover()).resolved, true);
  assert.deepEqual((await value.registry.loadHistory(value.initial.jobId)).directoryIdentities.target, value.original.directoryIdentity);
  assert.equal(value.calls.includes('config'), false);
});

test('stopped reservation stays active through both authenticated registry history moves', async t => {
  let historyMoves = 0;
  const value = await fixture(t, { terminal: true, onHistory: async c => {
    historyMoves++;
    await assert.rejects(c.coordinator.acquireStart(c.selector, { operation: 'competing-start', operationId: 'other',
      parentMutationLease: c.parentLease }), { code: 'OPERATION_IN_PROGRESS' });
  } });
  await value.withLease(async lease => {
    value.parentLease = lease;
    assert.equal((await value.service.recoverWithLease(value.initial, lease)).resolved, true);
  });
  assert.equal(historyMoves, 2);
});

for (const between of [false, true]) test(`${between ? 'between-renames ' : ''}unknown legacy terminal candidate worker is first durably refused without candidate cleanup`, async t => {
  const value = await fixture(t, { terminal: true, between, candidate: true, authorizedCandidate: true, legacyWriter: true });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(value.calls, []);
  assert.equal(fs.readFileSync(path.join(value.paths.candidatePath, 'partial.txt'), 'utf8'), 'candidate-only');
  assert.equal((await value.registry.load(value.initial.jobId)).outcome.runtimeWriterAuthority.state, 'unproven');
});

test('stopped terminal reparse observation blocks the complete safe-tree proof', async t => {
  const value = await fixture(t, { terminal: true });
  value.reparseInspector.isReparsePoint = async candidate =>
    candidate.toLowerCase() === path.join(value.serverPath, 'config').toLowerCase();
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
});

for (const between of [false, true]) test(`${between ? 'between-renames ' : ''}terminal candidate directory alias to canonical original is not deletion authority`, async t => {
  const value = await fixture(t, { terminal: true, between, candidate: true, authorizedCandidate: true });
  fs.unlinkSync(path.join(value.paths.candidatePath, 'partial.txt'));
  fs.rmdirSync(value.paths.candidatePath);
  fs.symlinkSync(value.serverPath, value.paths.candidatePath, 'junction');
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'utf8'), 'malformed = [');
  assert.equal(value.calls.includes('auto'), false);
});

test('missing prior policy and missing terminal action cannot acquire retain authority', async t => {
  const value = await fixture(t, { terminal: true, outcome: { recovery: null } });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(value.calls, ['suspend']);
  await assert.rejects(value.service.recover({ ...value.initial, priorRuntime: { running: false } }), { code: 'INVALID_REQUEST' });
  assert.ok(await value.registry.load(value.initial.jobId));
});

for (const failure of ['rename', 'stop']) {
  test(`pre-swap rollback-original ${failure} failure retains exact original without no-boot completion`, async t => {
    const value = await fixture(t, { ...(failure === 'stop' ? { stopResult: { stopped: false } } : {
      authority: base => ({ ...base, async renameExact() { throw new Error('rename transport failed'); } })
    }) });
    fs.renameSync(value.serverPath, value.paths.rollbackPath);
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(fs.existsSync(value.serverPath), false);
    assert.equal((await inspectServerDirectoryTree(value.paths.rollbackPath, { reparseInspector: value.reparseInspector })).fingerprint,
      value.original.fingerprint);
    assert.equal((await value.registry.load(value.initial.jobId)).phase, 'snapshotting');
    assert.equal(value.calls.includes('auto'), false);
  });
}
