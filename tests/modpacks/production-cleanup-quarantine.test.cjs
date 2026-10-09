const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const { ModpackRecoveryService } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
const { ProductionMutationRuntime } = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
const { ServerRuntimeWriterAuthority } = require('../../electron/services/modpack-lifecycle/server-runtime-writer-authority.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationContext } = require('../../electron/services/server-mutation-context.cjs');
const { createExistingSiblingPaths, createSiblingPaths } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
const { inspectServerDirectoryTree } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');

// Only OS/native durability and runtime boundaries are controlled. Registry,
// recovery, production mutation runtime and coordinator are real instances.
async function fixture(t, { kind = 'existing', committed = false, empty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-cleanup-quarantine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'servers', 'Alpha');
  fs.mkdirSync(path.dirname(serverPath), { recursive: true });
  if (kind === 'existing') {
    fs.mkdirSync(serverPath);
    fs.writeFileSync(path.join(serverPath, 'source.txt'), 'healthy canonical bytes');
  }
  const templatePath = path.join(root, 'template'); fs.mkdirSync(templatePath);
  const controls = { failHistory: false, historyAfter: false, recoveryFault: null, runtimeFault: false,
    cleanupFault: null, reservationFault: false, contextFault: false, calls: [], revision: 4 };
  const durableBase = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync,
    async moveWriteThroughAsync(a, b) { fs.renameSync(a, b); },
    async replaceFileWriteThroughAsync(a, b) { fs.renameSync(a, b); },
    flushDirectory() {}, async flushDirectoryAsync() {}
  } });
  const durableFs = { ...durableBase, async renameDurableAsync(a, b, request) {
    if (controls.failHistory && b.includes(`${path.sep}history${path.sep}`)) throw Error('injected history failure');
    const result = await durableBase.renameDurableAsync(a, b, request);
    if (controls.recordAfter && !a.endsWith('.target.json')) throw Error('injected record-first archive interruption');
    if (controls.historyAfter && a.endsWith('.target.json')) throw Error('injected post archive failure');
    return result;
  } };
  const registry = new RecoveryRegistry({ userDataPath: root, durableFs }); await registry.initialize();
  const selector = { instanceId: 'alpha', serverPath };
  const coordinator = new ServerMutationCoordinator({ context: createServerMutationContext(),
    readContentRevision: () => controls.revision, bumpContentRevision() { assert.fail('revision masking forbidden'); } });
  coordinator.completeStartupRecovery([]);
  const writerAuthority = new ServerRuntimeWriterAuthority({ registry, coordinator, getBootSequence: () => 1 });
  const runtimePolicy = {
    async suspend() { controls.calls.push('suspend'); return { held: true }; },
    async ensureStopped() { controls.calls.push('stop'); return { alreadyStopped: true }; },
    async restoreAutoRestart() { controls.calls.push('policy'); return { restored: true }; },
    async adoptValidatedHandoff() { assert.fail('runtime launch forbidden'); }
  };
  const service = new ModpackRecoveryService({ coordinator, recoveryRegistry: registry, runtimePolicy,
    runtimeWriterAuthority: writerAuthority,
    contextFactory: async ({ record, mutationLease }) => ({ fsApi: fs, reparseInspector,
      durableFs, jobId: record.jobId, mutationLease, targetPath: serverPath,
      operationKind: record.operationKind, recoveryRegistry: registry, stableInstanceId: 'alpha', runtimePolicy,
      async resolveRecoveryRuntimeConfig() { assert.fail('runtime config forbidden'); },
      healthValidator: { async validateLive() { assert.fail('runtime boot forbidden'); } }
    }) });
  const reparseInspector = { async isReparsePoint() { return false; } };
  const paths = kind === 'existing' ? createExistingSiblingPaths(serverPath, 'job-alpha') : createSiblingPaths(serverPath, 'job-alpha');
  const original = kind === 'existing' ? await inspectServerDirectoryTree(serverPath, { reparseInspector }) : null;
  const manifest = { schemaVersion: 1, installationId: 'install-alpha', entries: [] };
  const executionRecord = { serverKind: kind, serverPath, incomingManifest: manifest,
    execution: { templateOutputId: 'template-output', repairPayloadManifest: manifest },
    selectedRestorePoint: null, adoption: null, reservation: null,
    reviewedServerDisk: { candidateBytes: '0', restorePointBytes: '0', rollbackBytes: '0', journalBytes: '0' } };
  const plan = { type: 'modpack-preflight-plan', fingerprint: 'a'.repeat(64),
    operation: { kind: kind === 'existing' ? 'repair' : 'install', serverKind: kind, instanceId: 'alpha', expectedContentRevision: 4 },
    source: {}, artifact: { setDigest: 'b'.repeat(64) }, runtime: {}, preconditions: { paths: [] },
    ownership: { actions: [] }, selections: { conflictChoices: {}, maxRam: 2, serverPort: 25565, networkAccess: 'loopback' },
    restorePoints: [], disk: { candidateBytes: '0', restorePointBytes: '0', rollbackBytes: '0', journalBytes: '0', downloadBytes: '0', expandedBytes: '0' } };
  const resolved = { ...selector, priorRunning: false };
  const tracking = { schemaVersion: 1, action: 'remove', status: 'applied', serverId: 'alpha', trackingId: 'tracking-alpha' };
  const record = { schemaVersion: 2, sequence: 0, jobId: 'job-alpha', operationKind: plan.operation.kind,
    target: { kind, stableServerId: 'alpha', path: serverPath }, candidatePath: paths.candidatePath,
    rollbackPath: paths.rollbackPath || null, failedPath: paths.failedPath, journalPath: null,
    restorePoint: null, restoreCreation: null, priorRuntime: { running: false, autoRestart: false },
    phase: 'queued', swapStep: 'none', directoryIdentities: { target: original?.directoryIdentity || null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', outcome: null };
  if (!empty) {
    await registry.create(record);
    await registry.transition('job-alpha', { expectedPhase: 'queued', nextPhase: 'preflight', patch: { outcome: { runtimeWriterProtocol: 1 } } });
    await registry.transition('job-alpha', { expectedPhase: 'preflight', nextPhase: committed ? 'committed-healthy' : 'snapshotting', patch: {
      swapStep: committed ? 'candidate-published' : 'none', outcome: { runtimeWriterProtocol: 1,
        ...(original ? { live: { fingerprint: original.fingerprint } } : {}),
        ...(committed ? { releaseTracking: tracking, ...(kind === 'new' ? {
          publication: { state: 'published' }, registration: { complete: true, instanceId: 'alpha' }
        } : {}) } : {}) }
    } });
  }
  const runtime = new ProductionMutationRuntime({ coordinator, destinationReservations: {
    resolve() { return null; }, consume() { controls.calls.push('consume'); if (controls.reservationFault) throw Error('reservation fault'); },
    release() { controls.calls.push('release'); if (controls.reservationFault) throw Error('reservation fault'); return true; }
  }, durableFsFactory: () => durableFs, fsApi: fs, instanceResolver: { async resolveInstance() { return resolved; } },
    planningAdapter: { getExecutionRecord() { return executionRecord; } },
    snapshotServer: async () => ({ pathPreconditions: [], liveSnapshot: { entries: [], worldDirectories: ['world'] }, candidateBytes: '0', restorePointBytes: '0', rollbackBytes: '0', journalBytes: '0' }),
    availableBytes: async () => '1000000000000', planValidator() {},
    recoveryServices: { registry, recoveryService: service, runtimePolicy, runtimeWriterAuthority: {
      async assertRecoveryAllowed(...args) { controls.calls.push('writer'); if (controls.runtimeFault) throw Error('writer fault'); return writerAuthority.assertRecoveryAllowed(...args); }
    }, healthValidator: {}, releaseTrackingReconciler: { async reconcile() { controls.calls.push('tracking'); } } },
    releaseTrackingStore: { list() { return []; }, remove() {}, upsert() {} }, reparseInspector,
    stateRepository: { read() { return { state: { modpackManaged: true }, manifest }; }, appendHistoryAsync() {}, writeCandidateAsync() {} },
    store: { get() {} }, userDataPath: root, workspaceRegistry: { resolveOwnedWorkspace() { return { path: templatePath }; } },
    consumeReservedTargetFn: async () => { controls.calls.push('dispose'); if (controls.cleanupFault) throw Error('dispose fault'); },
    cleanupCommittedTransactionFn: async () => {
      controls.calls.push('cleanup');
      if (controls.cleanupFault === 'throw') throw Error('cleanup fault');
      if (controls.cleanupFault === 'pending') return { phase: 'cleanup-pending', rollbackRemoved: false };
      const current = await registry.load('job-alpha');
      await registry.transition('job-alpha', { expectedPhase: current.phase, nextPhase: 'completed', patch: {
        swapStep: 'cleanup-complete', outcome: { ...current.outcome, cleanup: { deletionAuthorized: true, rollbackRemoved: true } }
      } });
      return { phase: 'completed', rollbackRemoved: true };
    }, durabilityHandoff: async () => {}, yieldControl: async () => {} });
  runtime.contexts.set('job-alpha', { jobId: 'job-alpha', plan, resolved, paths, durableFs, config: { maxRam: 2, port: 25565, networkAccess: 'loopback' },
    executionRecord, candidateState: {}, ...(committed ? { releaseTrackingIntent: tracking } : {}) });
  const actualRecover = service.recoverWithLease.bind(service);
  service.recoverWithLease = async (...args) => {
    if (controls.recoveryResult) return controls.recoveryResult;
    if (controls.recoveryFault === 'pending') return { jobId: 'job-alpha', resolved: false, action: 'cleanup-pending' };
    if (controls.recoveryFault === 'throw') throw Error('generic recovery fault');
    return actualRecover(...args);
  };
  const f = { root, serverPath, registry, runtime, service, coordinator, controls, plan, resolved, record, paths, durableFs,
    request: { jobId: 'job-alpha', operationKind: kind === 'existing' ? 'repair' : 'install-new', plan, resolved },
    withLease(work, jobId = 'job-alpha') { return coordinator.runMutation(selector, { operation: 'modpack-lifecycle', operationId: jobId, revisionMode: 'lifecycle' }, async lease => {
      const result = await work(lease); controls.revision++; return result;
    }); },
    invoke(method, lease) { return runtime[method]({ ...f.request, lease, error: new ModpackError('HEALTH_CHECK_FAILED', 'Original health failure') }); },
    async assertBlocked() {
      await assert.rejects(coordinator.acquireStart(selector, { operation: 'ordinary-start', operationId: 'later' }), { code: 'RECOVERY_REQUIRED' });
      await assert.rejects(coordinator.runMutation(selector, { operation: 'start-management-server', operationId: 'later', revisionMode: 'none' }, async () => assert.fail('management callback forbidden')), { code: 'RECOVERY_REQUIRED' });
    },
    async assertUsable() {
      const start = await coordinator.acquireStart(selector, { operation: 'ordinary-start', operationId: 'later' }); start.release();
      await coordinator.runMutation(selector, { operation: 'start-management-server', operationId: 'later', revisionMode: 'none' }, async () => {});
    }
  };
  return f;
}

// Removing proof-aware quarantine reproduces an active failed/pre-swap-restored
// record with both ordinary production access gates open after lease release.
for (const method of ['abandonCandidate', 'rollback']) {
  test(`${method}: generic settled-runtime archive failure blocks, failed retry stays blocked, verified recovery clears`, async t => {
    const f = await fixture(t); f.controls.failHistory = true;
    await assert.rejects(f.withLease(lease => f.invoke(method, lease)));
    assert.equal((await f.registry.load('job-alpha')).phase, 'failed');
    assert.equal((await f.registry.load('job-alpha')).outcome.recovery.action, 'pre-swap-restored');
    assert.equal(fs.readFileSync(path.join(f.serverPath, 'source.txt'), 'utf8'), 'healthy canonical bytes');
    await f.assertBlocked();
    await assert.rejects(f.service.recover(await f.registry.load('job-alpha')), { code: 'RECOVERY_REQUIRED' });
    await f.assertBlocked(); f.controls.failHistory = false;
    assert.equal((await f.service.recover(await f.registry.load('job-alpha'))).resolved, true);
    await f.assertUsable();
  });
  test(`${method}: nonresolved recovery does not release ordinary access`, async t => {
    const f = await fixture(t); f.controls.recoveryFault = 'pending';
    await assert.rejects(f.withLease(lease => f.invoke(method, lease)), { code: 'RECOVERY_REQUIRED' });
    await f.assertBlocked(); assert.ok(await f.registry.load('job-alpha'));
  });
  test(`${method}: verified source closure leaves ordinary access usable`, async t => {
    const f = await fixture(t);
    assert.equal((await f.withLease(lease => f.invoke(method, lease))).resolved, true);
    await f.assertUsable();
  });
}
for (const fault of ['throw', 'pending']) test(`cleanup: committed ${fault} preserves healthy canonical bytes and blocks both ordinary gates`, async t => {
  const f = await fixture(t, { committed: true }); f.controls.cleanupFault = fault;
  await assert.rejects(f.withLease(lease => f.invoke('cleanup', lease)));
  await f.assertBlocked(); assert.ok(await f.registry.load('job-alpha'));
  assert.equal(fs.readFileSync(path.join(f.serverPath, 'source.txt'), 'utf8'), 'healthy canonical bytes');
});
test('cleanup: verified cleanup archives and leaves ordinary access usable', async t => {
  const f = await fixture(t, { committed: true });
  assert.equal((await f.withLease(lease => f.invoke('cleanup', lease))).cleaned, true);
  assert.equal(await f.registry.load('job-alpha'), null); await f.assertUsable();
  assert.deepEqual(f.controls.calls, ['writer', 'tracking', 'cleanup']);
});

for (const method of ['cleanup', 'abandonCandidate', 'rollback']) {
  test(`${method}: post archive transport failure is reported without stranding a closed source`, async t => {
    const f = await fixture(t, { committed: method === 'cleanup' }); f.controls.historyAfter = true;
    await assert.rejects(f.withLease(lease => f.invoke(method, lease)));
    assert.equal(await f.registry.load('job-alpha'), null);
    assert.ok(fs.existsSync(path.join(f.registry.historyPath, 'job-alpha.target.json')));
    await f.assertUsable();
  });
  test(`${method}: context deletion failure after positive closure is ancillary`, async t => {
    const f = await fixture(t, { committed: method === 'cleanup' });
    f.runtime.contexts.delete = () => { throw Error('context deletion fault'); };
    await assert.rejects(f.withLease(lease => f.invoke(method, lease)), /context deletion fault/);
    assert.equal(await f.registry.load('job-alpha'), null); await f.assertUsable();
  });
  test(`${method}: forged cached-context lease cannot reach any cleanup side effect`, async t => {
    const f = await fixture(t, { committed: method === 'cleanup' });
    await assert.rejects(f.invoke(method, { kind: 'mutation', operationId: 'job-alpha', instanceId: 'alpha', serverPath: f.serverPath }));
    assert.deepEqual(f.controls.calls, []); await f.assertUsable();
  });
}

test('cleanup: a new published registered server finishes before reservation consumption', async t => {
  const f = await fixture(t, { kind: 'new', committed: true });
  assert.equal((await f.withLease(lease => f.invoke('cleanup', lease))).cleaned, true);
  assert.equal((await f.registry.loadHistory('job-alpha')).phase, 'completed');
  assert.equal(f.controls.calls.at(-1), 'consume'); await f.assertUsable();
});

for (const method of ['cleanup', 'abandonCandidate', 'rollback']) test(`${method}: new-server reservation failure after closure does not invent source quarantine`, async t => {
  const f = await fixture(t, { kind: 'new', committed: method === 'cleanup' }); f.controls.reservationFault = true;
  await assert.rejects(f.withLease(lease => f.invoke(method, lease)), /reservation fault/);
  assert.equal(await f.registry.load('job-alpha'), null); await f.assertUsable();
});

for (const method of ['cleanup', 'abandonCandidate', 'rollback']) test(`${method}: uncertain record-first finish completes its authenticated pair without source replay or quarantine`, async t => {
  const f = await fixture(t, { committed: method === 'cleanup' }); f.controls.recordAfter = true;
  await assert.rejects(f.withLease(lease => f.invoke(method, lease)));
  assert.equal(await f.registry.load('job-alpha'), null);
  assert.ok(fs.existsSync(path.join(f.registry.historyPath, 'job-alpha.target.json')));
  assert.equal(f.controls.calls.filter(call => call === 'cleanup').length, method === 'cleanup' ? 1 : 0);
  await f.assertUsable();
});

test('abandonCandidate: the first durable failure diagnostic survives generic archive failure and retry', async t => {
  const f = await fixture(t); f.controls.failHistory = true;
  const original = Object.assign(new Error('private diagnostic'), { durableFailureKind: 'sharing-violation', durableFailureStage: 'handle-rename' });
  await assert.rejects(f.withLease(lease => f.runtime.abandonCandidate({ ...f.request, lease, error: original })));
  const first = (await f.registry.load('job-alpha')).outcome.failure;
  assert.deepEqual(first, { stage: 'filesystem-operation', category: 'sharing-violation', boundary: 'handle-rename' });
  await f.assertBlocked();
  f.controls.failHistory = false;
  const result = await f.service.recover(await f.registry.load('job-alpha'));
  assert.deepEqual(result.failure, first);
  assert.deepEqual((await f.registry.loadHistory('job-alpha')).outcome.failure, first);
  await f.assertUsable();
});

for (const failure of ['probe-load', 'probe-scan', 'malformed-scan', 'malformed-pending-scan', 'unrecorded-disposal', 'retained-queued', 'retained-advanced', 'nonresolved']) {
  test(`pre-context revalidation: ${failure} preserves evidence and blocks original lease before release`, async t => {
    const f = await fixture(t, { kind: failure === 'unrecorded-disposal' ? 'new' : 'existing', empty: true });
    f.runtime.contexts.clear();
    const originalError = new ModpackError('PLAN_STALE', 'Original revalidation failure');
    if (failure.startsWith('retained') || failure === 'nonresolved') {
      const transition = f.registry.transition.bind(f.registry);
      f.registry.transition = async (jobId, request) => {
        if (request.nextPhase === 'preflight') {
          if (failure !== 'retained-queued') await transition(jobId, request);
          throw originalError;
        }
        return transition(jobId, request);
      };
      if (failure === 'nonresolved') f.controls.recoveryFault = 'pending';
      else f.controls.failHistory = true;
    } else {
      f.registry.create = async () => { throw originalError; };
      if (failure === 'probe-load') f.registry.load = async () => { throw Error('probe uncertainty'); };
      if (failure === 'probe-scan') f.registry.initialize = async () => { throw Error('scan uncertainty'); };
      if (failure === 'malformed-scan') f.registry.initialize = async () => ({ records: [], corrupt: [], blocks: [] });
      if (failure === 'malformed-pending-scan') f.registry.initialize = async () => ({ records: [], corrupt: [], blocks: [], globalBlock: false, pendingTerminalPublications: null });
      if (failure === 'unrecorded-disposal') f.controls.cleanupFault = 'throw';
    }
    await assert.rejects(f.withLease(lease => f.runtime.revalidate({ ...f.request, lease, choices: { startAfterInstall: false } })), { code: 'RECOVERY_REQUIRED' });
    assert.equal(f.runtime.contexts.size, 0, 'no lifecycle context may mask this handoff');
    await f.assertBlocked();
    if (failure.startsWith('retained') || failure === 'nonresolved') assert.ok(fs.existsSync(path.join(f.registry.activePath, 'job-alpha.json')));
  });
}

for (const mode of ['unrecorded-existing', 'unrecorded-new', 'queued', 'advanced', 'queued-reservation-fault', 'advanced-context-fault']) {
  test(`pre-context revalidation: verified ${mode} disposal preserves original diagnostic without source quarantine`, async t => {
    const f = await fixture(t, { kind: mode.includes('new') || mode.includes('reservation') ? 'new' : 'existing', empty: true });
    f.runtime.contexts.clear();
    const originalError = new ModpackError('PLAN_STALE', 'Original stale plan');
    if (mode.startsWith('unrecorded')) f.registry.create = async () => { throw originalError; };
    else {
      const transition = f.registry.transition.bind(f.registry);
      f.registry.transition = async (jobId, request) => {
        if (request.nextPhase === 'preflight') {
          if (mode.startsWith('advanced')) await transition(jobId, request);
          throw originalError;
        }
        return transition(jobId, request);
      };
    }
    if (mode.includes('reservation-fault')) f.controls.reservationFault = true;
    if (mode.includes('context-fault')) f.runtime.contexts.delete = () => { throw Error('ancillary context failure'); };
    await assert.rejects(f.withLease(lease => f.runtime.revalidate({ ...f.request, lease, choices: { startAfterInstall: false } })),
      error => mode.includes('fault') ? error.code === 'RECOVERY_REQUIRED' : error === originalError);
    assert.equal(f.runtime.contexts.size, 0); await f.assertUsable();
    if (!mode.startsWith('unrecorded')) assert.equal(await f.registry.load('job-alpha'), null);
  });
}

async function archiveForRetry(f, method = 'cleanup') {
  await f.withLease(lease => f.invoke(method, lease));
  f.controls.calls.length = 0;
  const forbidden = () => assert.fail('historical retry crossed source/runtime/tracking/reservation boundary');
  f.runtime.runtimeWriterAuthority.assertRecoveryAllowed = forbidden;
  f.runtime.releaseTrackingReconciler.reconcile = forbidden;
  f.runtime.cleanupCommittedTransactionFn = forbidden;
  f.runtime.recoveryService.recoverWithLease = forbidden;
  f.runtime.recoveryService.rollbackWithLease = forbidden;
  f.runtime.recoveryService.failNewWithLease = forbidden;
  f.runtime.destinationReservations.consume = forbidden;
  f.runtime.destinationReservations.release = forbidden;
}

for (const kind of ['existing', 'new']) for (const layout of ['complete', 'split']) {
  test(`cleanup historical ${kind} ${layout}: authenticates publication before every source side effect`, async t => {
    const f = await fixture(t, { kind, committed: true }); await archiveForRetry(f);
    const historyEnvelope = path.join(f.registry.historyPath, 'job-alpha.target.json');
    if (layout === 'split') fs.renameSync(historyEnvelope, path.join(f.registry.activePath, 'job-alpha.target.json'));
    f.controls.revision += 10;
    const before = fs.readFileSync(path.join(f.registry.historyPath, 'job-alpha.json'));
    const result = await f.withLease(lease => f.invoke('cleanup', lease));
    assert.equal(result.alreadyCleaned, true);
    assert.deepEqual(fs.readFileSync(path.join(f.registry.historyPath, 'job-alpha.json')), before);
    assert.ok(fs.existsSync(historyEnvelope)); assert.deepEqual(f.controls.calls, []); await f.assertUsable();
  });
}
for (const damage of ['missing', 'wrong-kind', 'malformed', 'missing-cleanup-proof', 'pending-tracking', 'wrong-tracking-server']) {
  test(`cleanup historical ${damage}: refuses without any source or tracking callback`, async t => {
    const f = await fixture(t, { committed: true }); await archiveForRetry(f);
    const history = path.join(f.registry.historyPath, 'job-alpha.json');
    const record = JSON.parse(fs.readFileSync(history));
    if (damage === 'missing') fs.unlinkSync(history);
    else if (damage === 'malformed') fs.writeFileSync(history, '{malformed');
    else {
      if (damage === 'wrong-kind') record.operationKind = 'upgrade';
      if (damage === 'missing-cleanup-proof') delete record.outcome.cleanup;
      if (damage === 'pending-tracking') record.outcome.releaseTracking.status = 'pending';
      if (damage === 'wrong-tracking-server') record.outcome.releaseTracking.serverId = 'beta';
      fs.writeFileSync(history, JSON.stringify(record));
    }
    await assert.rejects(f.withLease(lease => f.invoke('cleanup', lease)));
    assert.deepEqual(f.controls.calls, []); await f.assertBlocked();
  });
}
for (const method of ['abandonCandidate', 'rollback', 'cleanup']) {
  test(`${method}: authentic completed history rejects wrong rollback semantics without quarantining a closed source`, async t => {
    const f = await fixture(t, { committed: true }); await archiveForRetry(f);
    if (method === 'cleanup') assert.equal((await f.withLease(lease => f.invoke(method, lease))).cleaned, true);
    else await assert.rejects(f.withLease(lease => f.invoke(method, lease)), { code: 'RECOVERY_REQUIRED' });
    assert.deepEqual(f.controls.calls, []); await f.assertUsable();
  });
}
test('cleanup: valid failed history is not committed-cleanup success and does not replay or quarantine', async t => {
  const f = await fixture(t); await archiveForRetry(f, 'abandonCandidate');
  await assert.rejects(f.withLease(lease => f.invoke('cleanup', lease)), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(f.controls.calls, []); await f.assertUsable();
});

for (const failure of ['persistOutcome', 'restorePriorState', 'cleanup-transition', 'releaseClaim']) {
  test(`real lifecycle ${failure}: committed source settlement uses genuine proof-aware runtime handoff`, async t => {
    const f = await fixture(t, { committed: true });
    const operationStore = new OperationStore({ userDataPath: f.root, fsApi: fs, durableFs: f.durableFs });
    await operationStore.initialize();
    const runtime = Object.fromEntries(['suspendAutoRestart', 'quiesce', 'revalidate', 'createRestorePoint',
      'buildCandidate', 'validateCandidate', 'publishCandidate', 'registerPublishedInstance', 'commitCandidate',
      'startFinal', 'persistOutcome', 'restorePriorState'].map(name => [name, async () => {
        if (failure === name) throw new ModpackError('COMMIT_FAILED', `injected ${name} ancillary failure`);
        return {};
      }]));
    runtime.resolveInstance = async () => f.resolved;
    runtime.validateLive = async () => { f.controls.revision++; return { verified: true }; };
    runtime.cleanup = request => f.runtime.cleanup(request);
    runtime.quarantinePendingCleanup = request => f.runtime.quarantinePendingCleanup(request);
    runtime.rollback = runtime.abandonCandidate = async () => assert.fail('healthy committed source must not roll back');
    if (failure === 'cleanup-transition') {
      const transition = operationStore.transition.bind(operationStore); let failOnce = true;
      operationStore.transition = async (id, request) => {
        if (request.nextPhase === 'cleanup' && failOnce) { failOnce = false; throw Error('injected cleanup transition failure'); }
        return transition(id, request);
      };
    }
    const lifecycle = new ModpackLifecycleService({
      sourceResolver: { async resolveArtifactSetPlan() {} }, artifactDownloader: { async downloadSet() {} },
      archiveInspector: { async inspectArchive() {} }, inspectionLoader: { loadInspection() {} }, planningAdapter: { async createPlan() {} },
      planRegistry: { create() {}, get() {},
        claim() { return { jobId: 'job-alpha', planId: 'plan-alpha', fingerprint: f.plan.fingerprint, plan: f.plan }; },
        releaseClaim() { if (failure === 'releaseClaim') throw Error('injected claim release failure'); return true; } },
      operationStore, mutationRuntime: runtime, mutationCoordinator: f.coordinator
    });
    const queued = await lifecycle.startOperation({ planId: 'plan-alpha', planFingerprint: f.plan.fingerprint, choices: { acceptEula: true, startAfterInstall: false } });
    // Await settlement and lease release, not only the first visible job phase.
    for (let attempt = 0; lifecycle.activeOperations.has(queued.jobId) && attempt < 500; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    const job = await operationStore.get(queued.jobId);
    assert.notEqual(job.phase, 'completed');
    assert.equal(job.phase, 'cleanup-pending');
    if (failure === 'releaseClaim') {
      assert.equal(await f.registry.load('job-alpha'), null); await f.assertUsable();
    } else {
      assert.ok(await f.registry.load('job-alpha')); await f.assertBlocked();
    }
    assert.equal(fs.readFileSync(path.join(f.serverPath, 'source.txt'), 'utf8'), 'healthy canonical bytes');
});
}

test('pre-context revalidation: archived exact job completion rethrows original stale diagnostic without disposal', async t => {
  const f = await fixture(t, { committed: true }); await archiveForRetry(f);
  f.runtime.contexts.clear();
  f.plan.operation.expectedContentRevision = f.controls.revision;
  const original = new ModpackError('PLAN_STALE', 'Original stale plan');
  f.registry.create = async () => { throw original; };
  f.runtime.consumeReservedTargetFn = () => assert.fail('historical completion must not dispose source');
  await assert.rejects(f.withLease(lease => f.runtime.revalidate({ ...f.request, lease, choices: { startAfterInstall: false } })), error => error === original);
  await f.assertUsable();
});

for (const method of ['rollback', 'abandonCandidate']) test(`${method}: committed healthy active source is not sent to rollback/recovery`, async t => {
  const f = await fixture(t, { committed: true });
  f.service.rollbackWithLease = f.service.recoverWithLease = () => assert.fail('healthy committed source rollback forbidden');
  await assert.rejects(f.withLease(lease => f.invoke(method, lease)), error => error.code === 'RECOVERY_REQUIRED');
  await f.assertBlocked();
});

test('abandonCandidate: failed quarantine handoff preserves both original cleanup and handoff diagnostics', async t => {
  const f = await fixture(t); f.controls.recoveryFault = 'throw';
  f.coordinator.quarantineMutation = () => { throw Error('injected quarantine failure'); };
  await assert.rejects(f.withLease(lease => f.invoke('abandonCandidate', lease)), error => {
    assert.equal(error.code, 'RECOVERY_REQUIRED');
    assert.ok(error.cause instanceof AggregateError);
    assert.ok(error.cause.errors.some(item => item.message === 'generic recovery fault'));
    assert.ok(error.cause.errors.some(item => item.message === 'injected quarantine failure'));
    return true;
  });
  assert.ok(await f.registry.load('job-alpha'));
});

for (const [kind, phase, action, swapStep, wantAbandon] of [
  ['existing', 'failed', 'pre-swap-restored', 'none', true],
  ['existing', 'failed', 'between-renames-restored', 'live-moved', true],
  ['existing', 'rolled-back', 'rollback-restored', 'rollback-restored', false],
  ['new', 'failed', 'pre-publication-cleanup', 'none', true],
  ['new', 'failed', 'pre-publication-cleanup', 'candidate-published', true],
  ['new', 'failed', 'new-health-failed', 'failed-canonical-moved', true]
]) test(`authenticated ${kind} ${action}/${swapStep} historical recovery uses terminal semantics without replay`, async t => {
  const f = await fixture(t, { kind });
  const current = await f.registry.load('job-alpha');
  const targetIdentity = current.directoryIdentities.target;
  const failedIdentity = { volumeSerial: 'a1', fileId: 'b2' };
  const outcome = { ...current.outcome, recovery: { action, operationId: 'job-alpha' },
    ...(kind === 'new' && swapStep === 'candidate-published' ? { publication: { state: 'publishing' } } : {}) };
  await f.registry.transition('job-alpha', { expectedPhase: current.phase, nextPhase: phase, patch: { swapStep, outcome,
    directoryIdentities: { ...current.directoryIdentities, rollback: kind === 'existing' ? targetIdentity : null,
      failed: phase === 'rolled-back' || action === 'new-health-failed' ? failedIdentity : null } } });
  await f.registry.finish('job-alpha', { terminalPhase: phase, outcome });
  f.runtime.contexts.clear();
  const forbidden = () => assert.fail('historical terminal source replay forbidden');
  f.service.recoverWithLease = f.service.rollbackWithLease = f.service.failNewWithLease = forbidden;
  f.runtime.runtimeWriterAuthority.assertRecoveryAllowed = forbidden;
  f.runtime.destinationReservations.release = forbidden;
  assert.equal((await f.withLease(lease => f.invoke('rollback', lease))).resolved, true);
  if (wantAbandon) assert.equal((await f.withLease(lease => f.invoke('abandonCandidate', lease))).resolved, true);
  else await assert.rejects(f.withLease(lease => f.invoke('abandonCandidate', lease)), { code: 'RECOVERY_REQUIRED' });
  await f.assertUsable();
});

for (const method of ['cleanup', 'rollback', 'abandonCandidate']) for (const authority of ['expired', 'nonambient', 'wrong-job', 'wrong-target']) {
  test(`${method}: ${authority} genuine-lease misuse rejects before all cleanup callbacks`, async t => {
    const f = await fixture(t, { committed: method === 'cleanup' });
    if (authority === 'expired') {
      let expired; await f.withLease(async lease => { expired = lease; });
      await assert.rejects(f.invoke(method, expired));
    } else await f.withLease(async lease => {
      if (authority === 'nonambient') await f.coordinator.context.runWithLease({ kind: 'mutation', assertOwnedPath() {}, markDirty() {} },
        () => assert.rejects(f.invoke(method, lease)));
      if (authority === 'wrong-job') await assert.rejects(f.invoke(method, lease));
      if (authority === 'wrong-target') await assert.rejects(f.runtime[method]({ ...f.request, lease, resolved: { ...f.resolved, serverPath: path.join(f.root, 'Other') } }));
    }, authority === 'wrong-job' ? 'other-job' : 'job-alpha');
    assert.deepEqual(f.controls.calls, []); await f.assertUsable();
  });
}
test('pre-context revalidation: a forged field-shaped lease cannot publish recovery evidence', async t => {
  const f = await fixture(t, { empty: true }); f.runtime.contexts.clear();
  await assert.rejects(f.runtime.revalidate({ ...f.request, choices: { startAfterInstall: false }, lease: {
    kind: 'mutation', operationId: 'job-alpha', instanceId: 'alpha', serverPath: f.serverPath, baseRevision: 4
  } }));
  assert.equal(await f.registry.load('job-alpha'), null);
  assert.equal(f.runtime.contexts.size, 0); await f.assertUsable();
});

for (const evidence of ['corrupt-record', 'global-uncertainty', 'pending-publication']) {
  test(`pre-context revalidation: ${evidence} is retained, blocked, and never fabricated as ordinary recovery`, async t => {
    const f = await fixture(t, { empty: true }); f.runtime.contexts.clear();
    const activePath = path.join(f.registry.activePath, 'job-alpha.json');
    const original = new ModpackError('PLAN_STALE', 'Original stale plan');
    f.registry.create = async () => {
      if (evidence === 'corrupt-record') fs.writeFileSync(activePath, '{broken');
      throw original;
    };
    if (evidence !== 'corrupt-record') f.registry.initialize = async () => ({ records: [], corrupt: [], blocks: [],
      globalBlock: evidence === 'global-uncertainty', pendingTerminalPublications: evidence === 'pending-publication' ? [{ jobId: 'job-alpha' }] : [] });
    await assert.rejects(f.withLease(lease => f.runtime.revalidate({ ...f.request, lease, choices: { startAfterInstall: false } })), { code: 'RECOVERY_REQUIRED' });
    assert.equal(f.runtime.contexts.size, 0); await f.assertBlocked();
    if (evidence === 'corrupt-record') assert.equal(fs.readFileSync(activePath, 'utf8'), '{broken');
    else assert.equal(fs.existsSync(activePath), false);
  });
}

for (const method of ['cleanup', 'rollback', 'abandonCandidate']) test(`${method}: a bound active-record read fault blocks before ordinary access resumes`, async t => {
  const f = await fixture(t, { committed: method === 'cleanup' });
  const bytes = fs.readFileSync(path.join(f.registry.activePath, 'job-alpha.json'));
  f.registry.load = async () => { throw Error('active evidence read failed'); };
  await assert.rejects(f.withLease(lease => f.invoke(method, lease)), /active evidence read failed/);
  assert.deepEqual(fs.readFileSync(path.join(f.registry.activePath, 'job-alpha.json')), bytes);
  assert.deepEqual(f.controls.calls, []); await f.assertBlocked();
});

test('abandonCandidate: transition failure preserves first failure and installs ordinary access block', async t => {
  const f = await fixture(t);
  f.registry.transition = async () => { throw Error('diagnostic transition failed'); };
  await assert.rejects(f.withLease(lease => f.invoke('abandonCandidate', lease)), error =>
    error.message === 'diagnostic transition failed' || error.cause?.message === 'diagnostic transition failed');
  assert.equal((await f.registry.load('job-alpha')).phase, 'snapshotting'); await f.assertBlocked();
});

for (const result of [ { jobId: 'job-alpha', resolved: true, action: 'unknown' },
  { jobId: 'other-job', resolved: true, action: 'pre-swap-restored' },
  { jobId: 'job-alpha', resolved: true, action: 'already-finished' } ]) {
  test(`abandonCandidate: unvalidated resolved result ${result.action}/${result.jobId} cannot remove unresolved source protection`, async t => {
    const f = await fixture(t); f.controls.recoveryResult = result;
    await assert.rejects(f.withLease(lease => f.invoke('abandonCandidate', lease)), { code: 'RECOVERY_REQUIRED' });
    assert.ok(await f.registry.load('job-alpha')); await f.assertBlocked();
  });
}
test('historical revalidation-aborted with crossed candidate identity is not absence/closure proof', async t => {
  const f = await fixture(t); const current = await f.registry.load('job-alpha');
  const outcome = { recovery: { action: 'revalidation-aborted' } };
  await f.registry.transition('job-alpha', { expectedPhase: current.phase, nextPhase: 'failed', patch: {
    directoryIdentities: { ...current.directoryIdentities, candidate: { volumeSerial: 'a1', fileId: 'b2' } }, outcome
  } });
  await f.registry.finish('job-alpha', { terminalPhase: 'failed', outcome });
  f.runtime.contexts.clear();
  await assert.rejects(f.withLease(lease => f.invoke('abandonCandidate', lease)), { code: 'RECOVERY_REQUIRED' });
  await f.assertBlocked();
});

test('pre-context revalidation: uncertain authenticated metadata return never mistakes omitted complete history for unrecorded source', async t => {
  const f = await fixture(t, { kind: 'new', committed: true }); await archiveForRetry(f);
  f.runtime.contexts.clear(); f.plan.operation.expectedContentRevision = f.controls.revision;
  const original = new ModpackError('PLAN_STALE', 'Original stale plan');
  f.registry.create = async () => { throw original; };
  fs.renameSync(path.join(f.registry.historyPath, 'job-alpha.target.json'), path.join(f.registry.activePath, 'job-alpha.target.json'));
  f.controls.historyAfter = true; // Real transport throws only after the envelope lands.
  f.runtime.consumeReservedTargetFn = () => assert.fail('complete history is not unrecorded source absence');
  await assert.rejects(f.withLease(lease => f.runtime.revalidate({ ...f.request, lease, choices: { startAfterInstall: false } })), error => error === original);
  await f.assertUsable();
});

test('pre-context revalidation: persistent metadata rejection plus complete history refuses unrecorded disposal', async t => {
  const f = await fixture(t, { kind: 'new', committed: true }); await archiveForRetry(f);
  f.runtime.contexts.clear(); f.plan.operation.expectedContentRevision = f.controls.revision;
  const before = fs.readFileSync(path.join(f.registry.historyPath, 'job-alpha.json'));
  const original = new ModpackError('PLAN_STALE', 'Original stale plan');
  f.registry.create = async () => { throw original; };
  let metadataAttempts = 0;
  f.registry.retryTerminalPublication = async () => { metadataAttempts++; throw Error('persistent metadata uncertainty'); };
  let disposalCalls = 0;
  f.runtime.consumeReservedTargetFn = () => { disposalCalls++; assert.fail('history presence forbids unrecorded disposal'); };
  await assert.rejects(f.withLease(lease => f.runtime.revalidate({ ...f.request, lease, choices: { startAfterInstall: false } })), error => {
    assert.equal(error.code, 'RECOVERY_REQUIRED');
    assert.ok(error.cause instanceof AggregateError);
    assert.ok(error.cause.errors.includes(original));
    return true;
  });
  assert.equal(disposalCalls, 0);
  assert.equal(metadataAttempts, 2, 'metadata retry is bounded; source cleanup is never retried');
  assert.deepEqual(fs.readFileSync(path.join(f.registry.historyPath, 'job-alpha.json')), before);
  await f.assertBlocked();
});
