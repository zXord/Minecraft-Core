const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { prepareExactDeleteRequest } = require('../../electron/utils/windows-durable-fs-client.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const { RestorePointService } = require('../../electron/services/modpack-lifecycle/restore-point-service.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { ProductionMutationRuntime } = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
const { FailedRestorePointRetirement } = require('../../electron/services/modpack-lifecycle/failed-restorepoint-retirement.cjs');
const { createProductionModpackComposition } = require('../../electron/bootstrap/create-production-modpack-composition.cjs');
const { createModpackPaths } = require('../../electron/services/modpacks/paths.cjs');
const { SelectionRegistry } = require('../../electron/services/modpacks/local/selection-registry.cjs');
const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { recoveryIdFor } = require('../../electron/services/modpack-lifecycle/modpack-recovery-facade.cjs');
const { createOrderlyQuitBarrier } = require('../../electron/utils/orderly-quit-barrier.cjs');
const { createProductionServerSnapshot } = require('../../electron/services/modpacks/planning/production-server-snapshot.cjs');
const AT = '2026-10-11T00:00:00.000Z';
function durable(root) {
  return createDurableFs({ allowedRoots: [root], durableClient: { moveWriteThrough: fs.renameSync,
    replaceFileWriteThrough: fs.renameSync, flushDirectory() {}, async moveWriteThroughAsync(a,b) { fs.renameSync(a,b); },
    async replaceFileWriteThroughAsync(a,b) { fs.renameSync(a,b); }, async flushDirectoryAsync() {} } });
}

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
async function compose(e, overrides = {}) {
  const userDataPath = path.join(e.root, 'composition'); fs.mkdirSync(userDataPath);
  const paths = { userData: userDataPath, modpacks: createModpackPaths(userDataPath) };
  fs.mkdirSync(paths.modpacks.cache, { recursive: true });
  const noOp = {};
  for (const method of ['resolveInstance','suspendAutoRestart','quiesce','revalidate','createRestorePoint','buildCandidate',
    'validateCandidate','publishCandidate','registerPublishedInstance','commitCandidate','startFinal','validateLive',
    'persistOutcome','cleanup','rollback','abandonCandidate','restorePriorState']) noOp[method] = async () => null;
  const recoveryService = overrides.recoveryService || { async recover() {}, async rollback() {}, async retryCommittedCleanup() {} };
  const rawRecoveryServices = { registry: e.registry, recoveryService,
    restorePointService: { withExactRetirementPoint: (...args) => e.service.withExactRetirementPoint(...args) } };
  return createProductionModpackComposition({ app: {},
    artifactCache: { root: paths.modpacks.cache, retain() {}, release() {}, async prune() {}, async commitPart() {}, pathForSha256() {},
      async removeIfUnreferenced() {}, async retainForOutcome() {}, async materializeSet() {} },
    artifactDownloader: { async downloadSet() {}, async downloadPart() {} },
    clock: { now: () => Date.parse(AT) }, coordinator: e.coordinator,
    dialog: { async showOpenDialog() { return { canceled: true }; } }, durableFsFactory: () => durable(e.root),
    clientDurableFsFactory: () => durable(e.root), clientWorkerDurableConfig: { workerPath: path.join(e.root,'never-worker.exe'),
      workerManifestPath: path.join(e.root,'never-worker.json'), appOwnedRoot: userDataPath },
    fsPromises: fs.promises, fsSync: fs, getWindow: () => null,
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath: e.serverPath, priorRunning: false }; } },
    paths, providers: { modrinth: { async getVersion() {}, async resolveArtifactSetPlan() {} },
      github: { repository() {}, async getRelease() {}, async buildArtifactSetPlan() {}, async getRepositoryIdentity() {}, async listUploadedAssets() {} } }, randomUUID: crypto.randomUUID, randomBytes: crypto.randomBytes,
    rawRecoveryServices, recoveryServices: rawRecoveryServices, reparseInspector: { async isReparsePoint() { return false; } },
    runtimeRoots: { resourcesPath: e.root, runtimeRoot: e.root, isPackaged: false, arch: 'x64' },
    selectionRegistry: new SelectionRegistry({ randomId: () => 'x'.repeat(32) }), shell: { async openPath() {} },
    store: { get: key => key === 'instances' ? [{ id: 'server-one', type: 'server', path: e.serverPath }] : undefined },
    userDataPath, workerFactory() { return { async run() { assert.fail('no real archive worker'); } }; },
    archiveRuntime: { resourcesRoot: e.root, workerPath: path.join(e.root,'never-worker.exe'), workerManifestPath: path.join(e.root,'never-worker.json') },
    candidateHashService: { async hashFile() { assert.fail('no hash worker'); }, async dispose() { e.events.push('hash-dispose'); } },
    mutationRuntime: noOp
  });
}

test('production composition startup retirement waits for readiness without blocking initialize and closes without waiting for readiness', async t => {
  const e = await fixture(t); const composition = await compose(e);
  await composition.initialize();
  assert.equal(typeof composition.armStartupRetirement, 'function');
  const ready = deferred();
  assert.equal(composition.armStartupRetirement(ready.promise), true);
  assert.equal(composition.armStartupRetirement(Promise.resolve(true)), false);
  await composition.dispose();
  ready.resolve(true); await tick();
  assert.equal(composition.armStartupRetirement(Promise.resolve(true)), false);
  assert.equal(e.events.includes('archive'), false);
});

test('production composition drains held native retirement before plan and shared-resource disposal', async t => {
  let failing = true; const held = deferred(); const entered = deferred();
  const e = await fixture(t, { async effect() {
    if (failing) throw new Error('synthetic delete unavailable');
    entered.resolve(); await held.promise;
  } });
  const prepared = await e.prepare();
  await e.live(prepared, async request => {
    await e.runtime.abandonCandidate(request); await e.runtime.restorePriorState(request);
    assert.equal((await e.runtime.retireFailedRestorePoint(request)).status, 'deferred');
  });
  const next = await e.prepare('z-next-obligation');
  await e.live(next, async request => {
    await e.runtime.abandonCandidate(request); await e.runtime.restorePriorState(request);
    assert.equal((await e.runtime.retireFailedRestorePoint(request)).status, 'deferred');
  });
  const policiesBeforeMaintenance = e.events.filter(event => event === 'policy').length;
  failing = false;
  const composition = await compose(e); await composition.initialize();
  assert.equal(typeof composition.armStartupRetirement, 'function');
  const originalDispose = composition.planRegistry.dispose.bind(composition.planRegistry);
  composition.planRegistry.dispose = async () => { e.events.push('plan-dispose'); return originalDispose(); };
  assert.equal(composition.armStartupRetirement(Promise.resolve(true)), true);
  await entered.promise;
  let disposed = false;
  let quitCalls = 0;
  const barrier = createOrderlyQuitBarrier({ dispose: () => composition.dispose(), quit() { quitCalls++; } });
  assert.equal(barrier.handleBeforeQuit({ preventDefault() {} }), true);
  const disposal = composition.dispose().then(() => { disposed = true; });
  await tick();
  assert.equal(disposed, false);
  assert.equal(quitCalls, 0);
  assert.equal(e.events.includes('plan-dispose'), false);
  assert.equal(e.events.includes('hash-dispose'), false);
  assert.equal(composition.armStartupRetirement(Promise.resolve(true)), false);
  held.resolve(); await disposal;
  await tick(); assert.equal(quitCalls, 1);
  assert.equal(fs.existsSync(prepared.point.archivePath), false);
  assert.equal(fs.existsSync(next.point.archivePath), true, 'closing prevents the next selected item');
  assert.equal(e.events.filter(event => event === 'policy').length, policiesBeforeMaintenance);
  assert.equal(e.events.includes('plan-dispose'), true);
  const notices = await composition.notificationStore.list();
  assert.equal(notices[0].type, 'retention-warning');
});

for (const closing of [false, true]) test(`actual facade onResolved ${closing ? 'after shutdown starts skips retirement' : 'after source ownership release retries exact target'}`, async t => {
  let fail = true;
  const e = await fixture(t, { effect() { if (fail) throw new Error('held obligation'); } });
  const old = await e.prepare('prior-failed');
  await e.live(old, async request => { await e.runtime.abandonCandidate(request); await e.runtime.restorePriorState(request);
    assert.equal((await e.runtime.retireFailedRestorePoint(request)).status, 'deferred'); });
  fail = false;
  const active = await e.prepare('source-recovery'); const entered = deferred(); const resume = deferred();
  const composition = await compose(e, { recoveryService: { async recover(record) {
    entered.resolve(); await resume.promise;
    await e.registry.finish(record.jobId, { terminalPhase: 'failed', outcome: { recovery: { action: 'pre-swap-restored', operationId: record.jobId } } });
    e.events.push('source-released'); return { resolved: true, action: 'pre-swap-restored' };
  }, async rollback() {}, async retryCommittedCleanup() {} } });
  await composition.initialize();
  const originalRelease = composition.planRegistry.releaseClaim.bind(composition.planRegistry);
  composition.planRegistry.releaseClaim = async jobId => { e.events.push('claim-reconciled'); return originalRelease(jobId); };
  const recovery = composition.recoveryService.recover({ recoveryId: recoveryIdFor(active.jobId), actionId: 'retry-recovery' });
  await entered.promise;
  const priorArchiveEffects = e.events.filter(x => x === 'archive').length;
  const disposal = closing ? composition.dispose() : null;
  resume.resolve(); const result = await recovery;
  assert.equal(result.resolved, true); assert.equal(result.operationStateReconciled, true);
  if (closing) {
    await disposal; await tick();
    assert.equal(e.events.filter(x => x === 'archive').length, priorArchiveEffects);
    assert.equal(fs.existsSync(old.point.archivePath), true);
  } else {
    // Receipt publication after deletion supplies an event-driven completion boundary.
    for (let turn = 0; turn < 2000 && fs.existsSync(old.point.metadataPath); turn++) await tick();
    await composition.dispose();
    assert.equal(fs.existsSync(old.point.archivePath), false);
    const released = e.events.indexOf('source-released'); const claim = e.events.indexOf('claim-reconciled');
    const deleted = e.events.lastIndexOf('archive'); assert.ok(released < claim && claim < deleted);
  }
  assert.equal(fs.existsSync(active.point.archivePath), true, 'unreceipted source recovery cannot mint cleanup proof');
});
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-retirement-production-'));
  assert.equal(path.dirname(root), os.tmpdir());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server'); fs.mkdirSync(serverPath);
  fs.writeFileSync(path.join(serverPath, 'inert-world.txt'), 'inert generated server bytes');
  const userDataPath = path.join(root, 'user-data'); fs.mkdirSync(userDataPath);
  const events = []; let revision = 7;
  const registry = new RecoveryRegistry({ userDataPath, durableFs: durable(userDataPath), clock: () => new Date(AT) });
  await registry.initialize();
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => revision, bumpContentRevision: () => ++revision });
  coordinator.completeStartupRecovery([]);
  const selector = { instanceId: 'server-one', serverPath };
  const resolved = { ...selector, priorRunning: false };
  const service = new RestorePointService({ durableFs: durable(root), clock: () => new Date(AT),
    extractVerifiedArchiveFn: async () => assert.fail('no extraction'), retirementDurableFsFor(parent) {
      assert.equal(parent.toLowerCase(), root.toLowerCase());
      return { async deleteFileExactAsync(file, request) {
        prepareExactDeleteRequest(file, request, [parent]);
        assert.equal(path.dirname(path.dirname(file)).toLowerCase(), serverPath.toLowerCase());
        events.push(file.endsWith('.zip') ? 'archive' : 'sidecar');
        await options.effect?.(file);
        if (request.mode === 'delete') fs.unlinkSync(file);
        return { deleted: true, durable: true };
      } };
    } });
  let helper;
  const stateRepository = { read() { return null; }, async writeCandidateAsync() {}, async appendHistoryAsync() {},
    listHistory() { return { items: [], nextCursor: null }; } };
  const runtime = new ProductionMutationRuntime({ coordinator, userDataPath, clock: () => new Date(AT),
    destinationReservations: { resolve() {}, consume() {}, release() {} }, durableFsFactory: () => durable(root),
    instanceResolver: { async resolveInstance() { return resolved; } },
    planningAdapter: { getExecutionRecord() {}, snapshotServer() {} },
    releaseTrackingStore: { list() {}, remove() {}, upsert() {} }, reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository, store: { get() { return []; } }, workspaceRegistry: { resolveOwnedWorkspace() {} },
    healthValidator: {}, yieldControl: async () => {},
    recoveryServices: { registry, runtimeWriterAuthority: { async assertRecoveryAllowed() {} },
      runtimePolicy: { suspend() { return { held: true }; }, ensureStopped() {}, adoptValidatedHandoff() {},
        async restoreAutoRestart(request) { events.push('policy'); return options.policy ? options.policy(request) : { restored: true }; } },
      recoveryService: { async recoverWithLease(record, lease) {
        coordinator.assertMutationLease(lease, selector, record.jobId); events.push('abandon');
        if (options.abandonError) throw options.abandonError;
        await registry.finish(record.jobId, { terminalPhase: 'failed', outcome: { ...options.terminalOutcome, recovery: {
          action: 'pre-swap-restored', operationId: record.jobId } } });
        return { resolved: true, jobId: record.jobId, action: 'pre-swap-restored' };
      }, rollbackWithLease() {}, failNewWithLease() {} } },
    failedRestorePointRetirementFactory(verifyLiveProof) {
      helper = new FailedRestorePointRetirement({ registry, coordinator, stateRepository,
        planRegistry: { hasRestorePointReference: () => options.owner === true }, restorePointServiceFor: () => service,
        verifyLiveProof, assertTargetAvailable: async () => {}, clock: () => new Date(AT) });
      return helper;
    }, publishRetirementWarning: async request => { events.push(`warning:${request.result.status}`); if (options.warningError) throw options.warningError; }
  });
  async function prepare(jobId = 'job-failed') {
    const point = await service.createVerifiedRestorePoint({ serverPath, operationId: jobId, sourceRevision: 7, sourceRuntime: null });
    const candidate = { schemaVersion: 1, ...Object.fromEntries(['id','name','sha256','size','totalBytes','scopeSha256',
      'sourceRevision','sourceRuntime','operationId','createdAt'].map(key => [key, point[key]])), metadataName: path.basename(point.metadataPath) };
    const original = { volumeSerial: '1', fileId: '2' };
    await registry.create({ schemaVersion: 2, sequence: 0, jobId, operationKind: 'repair',
      target: { kind: 'existing', stableServerId: selector.instanceId, path: serverPath }, candidatePath: null,
      rollbackPath: null, failedPath: null, restorePoint: { id: point.id, sha256: point.sha256 }, restoreCreation: null,
      journalPath: null, priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
      directoryIdentities: { target: original, rollback: original, candidate: null, failed: null }, createdAt: AT, updatedAt: AT, outcome: null });
    await registry.transition(jobId, { expectedPhase: 'queued', nextPhase: 'preflight', patch: { outcome: { runtimeWriterProtocol: 1 } } });
    await registry.transition(jobId, { expectedPhase: 'preflight', nextPhase: 'snapshotting', patch: { outcome: { failedPointRetirementCandidate: candidate } } });
    const plan = { type: 'modpack-preflight-plan', schemaVersion: 1, fingerprint: 'a'.repeat(64),
      operation: { kind: 'repair', serverKind: 'existing', instanceId: selector.instanceId, expectedContentRevision: revision },
      requirements: { verifiedRestorePointRequired: true }, ownership: { preserved: [], orphaned: [] }, restorePoints: [] };
    runtime.contexts.set(jobId, { plan, resolved });
    const restartToken = await runtime.suspendAutoRestart({ jobId, plan, resolved });
    return { jobId, point, plan, resolved, restartToken };
  }
  async function live(prepared, work) { return coordinator.runMutation(selector,
    { operation: 'repair', operationId: prepared.jobId, revisionMode: 'auto' }, lease => work({ ...prepared, lease })); }
  return { root, serverPath, registry, runtime, coordinator, service, events, prepare, live,
    get revision() { return revision; }, get helper() { return helper; } };
}

for (const deletionFailure of [false, true]) test(deletionFailure
  ? 'ordinary retention failure preserves lifecycle source outcome and next safe Repair admission'
  : 'three actual lifecycle to runtime to helper staging failures reclaim each exact pair before claim release and admit fresh Repair', async t => {
  let current;
  const e = await fixture(t, { effect() { if (deletionFailure && current?.jobId === 'lifecycle-failed-0') throw new Error('synthetic disk failure'); } });
  const operationStore = new OperationStore({ userDataPath: path.join(e.root, 'user-data'), durableFs: durable(e.root) });
  await operationStore.initialize();
  const snapshots = [];
  const snapshot = createProductionServerSnapshot({ fsApi: fs, fsPromises: fs.promises, reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: { read() { return null; }, listHistory() { return { items: [], nextCursor: null }; } } });
  e.runtime.revalidate = async () => { snapshots.push(await snapshot({ currentState: { state: { runtime: {}, modpackManaged: true } },
    serverKind: 'existing', serverPath: e.serverPath, operationKind: 'repair' })); };
  e.runtime.createRestorePoint = async () => current.point;
  e.runtime.buildCandidate = async () => { throw new ModpackError(current.cancelled ? 'CANCELLED' : 'COMMIT_FAILED', 'synthetic staging failure'); };
  const service = new ModpackLifecycleService({ sourceResolver: { async resolveArtifactSetPlan() {} },
    artifactDownloader: { async downloadSet() {} }, archiveInspector: { async inspectArchive() {} },
    inspectionLoader: { loadInspection() {} }, planningAdapter: { async createPlan() {} },
    planRegistry: { create() {}, get() {}, async claim({ planId, fingerprint }) {
      return { jobId: current.jobId, planId, fingerprint, plan: current.plan };
    }, async releaseClaim() {
      e.events.push('claim-release');
      const retained = deletionFailure && current.jobId === 'lifecycle-failed-0';
      assert.equal(fs.existsSync(current.point.archivePath), retained);
      assert.equal(fs.existsSync(current.point.metadataPath), retained); return true;
    } }, operationStore, mutationCoordinator: e.coordinator, mutationRuntime: e.runtime });
  for (let attempt = 0; attempt < 3; attempt++) {
    current = await e.prepare(`lifecycle-failed-${attempt}`); current.cancelled = attempt === 1;
    const started = await service.startOperation({ planId: `plan-${attempt}`, planFingerprint: current.plan.fingerprint, choices: { acceptEula: true } });
    await service.activeOperations.get(started.jobId)?.settled;
    const job = await operationStore.get(started.jobId);
    assert.equal(job.phase, current.cancelled ? 'cancelled' : 'failed', JSON.stringify(job.outcome));
    assert.equal(job.outcome.cleanupPending, false);
    assert.equal(job.outcome.errorCode, current.cancelled ? 'CANCELLED' : 'COMMIT_FAILED');
    assert.equal((job.outcome.actions || []).some(action => action.actionId === 'review-restore-point'), false);
    assert.equal(fs.existsSync(current.point.archivePath), deletionFailure && attempt === 0);
    const historical = await e.registry.loadHistory(started.jobId); assert.equal(historical.phase, 'failed');
    fs.appendFileSync(path.join(e.serverPath, 'inert-world.txt'), `\nfresh-${attempt}`);
  }
  assert.equal(snapshots.length, 3);
  const sourceHashes = snapshots.map(value => value.liveSnapshot.entries.find(entry => entry.path === 'inert-world.txt').sha256);
  assert.equal(new Set(sourceHashes).size, 3, 'each following attempt captures fresh source bytes');
  assert.equal(e.events.filter(value => value === 'archive').length, 3);
  assert.equal(e.events.filter(value => value === 'sidecar').length, deletionFailure ? 2 : 3);
  if (!deletionFailure) assert.deepEqual(e.events, Array.from({ length: 3 }, () => ['abandon', 'policy', 'archive', 'sidecar', 'warning:reclaimed', 'claim-release']).flat());
});

test('production runtime mints one-use same-lease final-policy proof after successful abandonment', async t => {
  const e = await fixture(t); const prepared = await e.prepare();
  assert.equal(typeof e.runtime.retireFailedRestorePoint, 'function');
  await e.live(prepared, async request => {
    await e.runtime.abandonCandidate(request);
    assert.equal(e.runtime.contexts.has(request.jobId), false);
    const beforePolicy = await e.runtime.retireFailedRestorePoint(request);
    assert.equal(beforePolicy.reason, 'missing-final-policy-proof');
    await e.runtime.restorePriorState(request);
    const result = await e.runtime.retireFailedRestorePoint(request);
    assert.equal(result.status, 'reclaimed', JSON.stringify(result));
    assert.equal(result.archiveBytesReclaimed, String(prepared.point.size));
    const twice = await e.runtime.retireFailedRestorePoint(request);
    assert.equal(twice.reason, 'missing-final-policy-proof');
  });
  assert.equal(fs.existsSync(prepared.point.archivePath), false);
  assert.equal(fs.existsSync(prepared.point.metadataPath), false);
  assert.deepEqual(e.events, ['abandon', 'policy', 'archive', 'sidecar', 'warning:reclaimed']);
});

for (const [name, options] of [['policy false', { policy: () => ({ restored: false }) }],
  ['policy throws', { policy: () => { throw new Error('policy failure'); } }], ['independent owner', { owner: true }]]) {
  test(`production retirement preserves pair on ${name}`, async t => {
    const e = await fixture(t, options); const prepared = await e.prepare();
    assert.equal(typeof e.runtime.retireFailedRestorePoint, 'function');
    await e.live(prepared, async request => {
      await e.runtime.abandonCandidate(request);
      try { await e.runtime.restorePriorState(request); } catch { /* expected failure cannot mint authority */ }
      assert.equal((await e.runtime.retireFailedRestorePoint(request)).status, 'deferred');
    });
    assert.equal(fs.existsSync(prepared.point.archivePath), true);
    assert.equal(fs.existsSync(prepared.point.metadataPath), true);
  });
}

for (const variant of ['missing-token', 'new-token', 'divergent-uninstall', 'abandonment-throws', 'worker-unproven']) {
  test(`runtime provenance refuses ${variant}`, async t => {
    const unproven = Object.assign(new Error('unproven worker'), { runtimeWritersUnproven: true });
    const e = await fixture(t, { abandonError: variant === 'abandonment-throws' ? new Error('abandon failed') : variant === 'worker-unproven' ? unproven : null });
    const p = await e.prepare();
    if (variant === 'missing-token') e.runtime.restartTokens.delete(p.jobId);
    if (variant === 'new-token') e.runtime.restartTokens.set(p.jobId, { newServer: true });
    if (variant === 'divergent-uninstall') { p.plan.operation.kind = 'uninstall'; p.plan.ownership.confirmation = { possibleNonRunnable: true }; }
    await e.live(p, async request => {
      try { await e.runtime.abandonCandidate(request); } catch { /* denied settlement */ }
      try { await e.runtime.restorePriorState(request); } catch { /* denied policy */ }
      assert.equal((await e.runtime.retireFailedRestorePoint(request)).reason, 'missing-final-policy-proof');
    });
    assert.equal(fs.existsSync(p.point.archivePath), true); assert.equal(fs.existsSync(p.point.metadataPath), true);
  });
}

test('unreceipted final-policy crash gap restarts as deferred-proof and stale/forged leases cannot authorize', async t => {
  const e = await fixture(t); const p = await e.prepare(); let oldLease;
  await e.live(p, async request => { oldLease = request.lease; await e.runtime.abandonCandidate(request); await e.runtime.restorePriorState(request);
    await assert.rejects(e.runtime.retireFailedRestorePoint({ ...request, lease: {} }));
    await assert.rejects(e.runtime.retireFailedRestorePoint({ ...request, jobId: 'wrong-job' }));
    await assert.rejects(e.runtime.retireFailedRestorePoint({ ...request, resolved: { ...p.resolved, serverPath: path.join(e.root, 'wrong') } }));
  });
  await assert.rejects(e.runtime.retireFailedRestorePoint({ ...p, lease: oldLease }));
  const composition = await compose(e); await composition.initialize();
  composition.armStartupRetirement(Promise.resolve(true)); await tick(); await tick();
  await composition.dispose();
  assert.equal(await e.registry.loadRestorePointRetirement(p.jobId), null);
  assert.equal(fs.existsSync(p.point.archivePath), true);
  const notices = await composition.notificationStore.list();
  assert.equal(notices[0]?.title, 'Backup retained for safety');
});

test('cached policy result for a different target cannot satisfy the live required-policy boundary', async t => {
  const e = await fixture(t); const p = await e.prepare();
  await e.runtime.restorePriorState({ ...p, resolved: { ...p.resolved, serverPath: path.join(e.root, 'other-target') } });
  // This is a legacy cached restoration, not the required current target setting.
  e.runtime.restartTokens.set(p.jobId, p.restartToken);
  await e.live(p, async request => {
    await e.runtime.abandonCandidate(request); await e.runtime.restorePriorState(request);
    assert.equal((await e.runtime.retireFailedRestorePoint(request)).status, 'reclaimed');
  });
  assert.equal(e.events.filter(event => event === 'policy').length, 2, 'required bound policy must actually run again');
});

test('warning I/O failure does not undo successful live reclamation or receipt publication', async t => {
  const e = await fixture(t, { warningError: new Error('synthetic notification disk failure') }); const p = await e.prepare();
  await e.live(p, async request => { await e.runtime.abandonCandidate(request); await e.runtime.restorePriorState(request);
    assert.equal((await e.runtime.retireFailedRestorePoint(request)).status, 'reclaimed'); });
  assert.equal((await e.registry.loadRestorePointRetirement(p.jobId)).value.progress, 'deleted');
  assert.equal(fs.existsSync(p.point.archivePath), false);
});

for (const variant of ['prepared', 'commit-started', 'canonical-publication']) test(`actual runtime/helper preserve excluded ${variant} disposition`, async t => {
  const e = await fixture(t, { terminalOutcome: variant === 'commit-started' ? { commitStarted: true }
    : variant === 'canonical-publication' ? { publication: { state: 'published' } } : {} });
  const p = await e.prepare();
  if (variant === 'prepared') await e.registry.transition(p.jobId, { expectedPhase: 'snapshotting', nextPhase: 'snapshotting', patch: { swapStep: 'prepared' } });
  await e.live(p, async request => {
    await e.runtime.abandonCandidate(request); await e.runtime.restorePriorState(request);
    const result = await e.runtime.retireFailedRestorePoint(request); assert.notEqual(result.status, 'reclaimed');
  });
  assert.equal(await e.registry.loadRestorePointRetirement(p.jobId), null);
  assert.equal(fs.existsSync(p.point.archivePath), true);
});

test('maintenance retirement advances auto revision and actual runtime rejects the already-reviewed source plan', async t => {
  let failing = true; const e = await fixture(t, { effect() { if (failing) throw new Error('defer once'); } });
  const p = await e.prepare();
  await e.live(p, async request => { await e.runtime.abandonCandidate(request); await e.runtime.restorePriorState(request);
    assert.equal((await e.runtime.retireFailedRestorePoint(request)).status, 'deferred'); });
  const reviewedRevision = e.revision;
  const reviewed = { ...p.plan, operation: { ...p.plan.operation, expectedContentRevision: reviewedRevision },
    artifact: { setDigest: 'c'.repeat(64) }, preconditions: {} };
  failing = false;
  const composition = await compose(e); await composition.initialize();
  const noticed = deferred(); const upsert = composition.notificationStore.upsertRetirementNotice.bind(composition.notificationStore);
  composition.notificationStore.upsertRetirementNotice = async request => { const result = await upsert(request); noticed.resolve(); return result; };
  composition.armStartupRetirement(Promise.resolve(true)); await noticed.promise;
  await composition.dispose();
  assert.equal(e.revision, reviewedRevision + 1);
  const templatePath = path.join(e.root, 'empty-template'); fs.mkdirSync(templatePath);
  const manifest = { schemaVersion: 1, installationId: 'empty-template', entries: [] };
  e.runtime.planningAdapter.getExecutionRecord = () => ({ serverKind: 'existing', serverPath: e.serverPath,
    execution: { templateOutputId: 'empty-template', repairPayloadManifest: manifest }, incomingManifest: manifest });
  e.runtime.workspaceRegistry.resolveOwnedWorkspace = () => ({ path: templatePath });
  e.runtime.snapshotServer = async () => ({ pathPreconditions: [] });
  e.runtime.availableBytes = async () => '999999999999';
  e.runtime.planValidator = () => {};
  await assert.rejects(e.coordinator.runMutation({ instanceId: p.resolved.instanceId, serverPath: p.resolved.serverPath },
    { operation: 'repair', operationId: 'reviewed-stale', revisionMode: 'auto' },
    lease => e.runtime.revalidate({ jobId: 'reviewed-stale', plan: reviewed, resolved: p.resolved, choices: {}, lease })),
    error => error.code === 'PLAN_STALE' && error.details?.field === 'contentRevision');
  assert.equal(e.runtime.contexts.has('reviewed-stale'), false);
});
