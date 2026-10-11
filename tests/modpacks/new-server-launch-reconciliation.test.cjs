const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { PlanRegistry } = require('../../electron/services/modpack-lifecycle/plan-registry.cjs');
const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { computePreflightPlanFingerprint } = require('../../electron/services/modpacks/planning/plan-fingerprint.cjs');
const { ServerDestinationReservationService } = require('../../electron/services/modpacks/planning/server-destination-reservation-service.cjs');
const { ModpackError, deepFreeze } = require('../../electron/services/modpacks/errors.cjs');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modpack-launch-task2-'));
  let id = 0;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
  let now = Date.parse('2026-10-11T00:00:00.000Z');
  let current = true;
  const lease = { assertHeld() { if (!current) throw new Error('lost explicit test lease'); } };
  const owner = { epoch: Symbol('fixture-owner'), assertCurrent(epoch, { allowClosing = false } = {}) {
    if (epoch !== this.epoch || (!allowClosing && service?.admissionClosing)) throw new ModpackError('PLAN_STALE', 'stale owner');
    lease.assertHeld();
  } };
  const workspace = { transferOwnership() {}, async releaseOwner() { return true; } };
  const plans = new PlanRegistry({ workspaceRegistry: workspace, randomUUID, clock: () => now, allowNewServerLaunchBindings: true });
  const targetPath = 'C:\\LaunchFixture\\Pack';
  const reservations = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; } },
    reparseInspector: { async isReparsePoint() { assert.fail('inert capture must not inspect target'); } },
    captureReservation: async () => ({ kind: 'absent' }), randomUUID, clock: () => now, ttlMs: 1000
  });
  let temporary = 0;
  const durableFs = createDurableFs({ allowedRoots: [root], tempNameFactory: () => `launch-${++temporary}`,
    durableClient: { moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync,
      async moveWriteThroughAsync(from, to) { await fs.promises.rename(from, to); },
      async replaceFileWriteThroughAsync(from, to) { await fs.promises.rename(from, to); }, flushDirectory() {}, async flushDirectoryAsync() {} } });
  const store = new OperationStore({ userDataPath: root, durableFs, randomUUID, clock: () => new Date(now),
    allowNewServerLaunchBindings: true, launchOwner: owner });
  await store.initialize();
  const runtimeGate = deferred();
  let executions = 0;
  const runtime = {};
  for (const method of ['resolveInstance', 'suspendAutoRestart', 'quiesce', 'revalidate', 'createRestorePoint', 'buildCandidate',
    'validateCandidate', 'publishCandidate', 'registerPublishedInstance', 'commitCandidate', 'startFinal', 'validateLive',
    'persistOutcome', 'cleanup', 'rollback', 'abandonCandidate', 'restorePriorState']) runtime[method] = async () => null;
  runtime.resolveInstance = async () => { executions++; await runtimeGate.promise; throw new ModpackError('COMMIT_FAILED', 'inert runtime stop'); };
  let service = new ModpackLifecycleService({ sourceResolver: { resolveArtifactSetPlan() {} }, artifactDownloader: { downloadSet() {} },
    archiveInspector: { inspectArchive() {} }, inspectionLoader: { loadInspection() {} }, planningAdapter: { createPlan() {} },
    planRegistry: plans, operationStore: store, workspaceRegistry: workspace, mutationCoordinator: { runMutation() {} }, mutationRuntime: runtime,
    destinationReservations: reservations, launchOwner: owner, allowNewServerLaunchBindings: true, clock: () => now });
  function reviewedPlan(instanceId) {
    const base = { operation: { kind: 'install', serverKind: 'new', instanceId, expectedContentRevision: 0, downgrade: false },
      requirements: {}, restorePoints: [] };
    return deepFreeze({ ...base, fingerprint: computePreflightPlanFingerprint(base) });
  }
  async function plan(instanceId) {
    const value = reviewedPlan(instanceId);
    const created = plans.create({ plan: value, sanitizedView: {}, fingerprint: value.fingerprint, planningSessionId: randomUUID() });
    plans.bindNewServerReservation(created.planId, instanceId);
    return { planId: created.planId, planFingerprint: created.fingerprint, choices: { acceptEula: true } };
  }
  t.after(async () => { runtimeGate.resolve(); await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, plans, reservations, store, durableFs, owner, plan, reviewedPlan, workspace, root, runtimeGate,
    get executions() { return executions; }, advance(ms) { now += ms; }, loseOwner() { current = false; } };
}

function preparePreflight(f, instanceId, beforePlan = async () => {}) {
  const inspectionId = 'inspection-launch';
  f.service.inspections.set(inspectionId, { source: {} });
  f.service.inspectionLoader.loadInspection = () => ({ inspectionId });
  f.workspace.beginPreparationAttempt = () => ({ async retire() {}, finish() {} });
  f.service.planningAdapter.createPlan = async () => {
    await beforePlan();
    return { plan: f.reviewedPlan(instanceId), sanitizedView: {} };
  };
  return { inspectionId, instanceId, operationKind: 'install-new', selections: {} };
}

test('launch successful preflight privately binds and stale delivery synchronously advances fence generation', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const created = await f.service.createPlan(preparePreflight(f, reserved.instanceId));
  assert.deepEqual(Object.keys(created).sort(), ['expiresAt', 'planFingerprint', 'planId', 'planView']);
  const record = await f.plans.get({ planId: created.planId, fingerprint: created.planFingerprint });
  assert.equal(record.reservationInstanceId, reserved.instanceId);
  const before = f.service.getLaunchAdmissionState(f.owner.epoch).generation;
  const disposing = f.service.disposeUndeliverablePlan(created);
  await disposing;
  assert.ok(f.service.getLaunchAdmissionState(f.owner.epoch).generation > before);
  await assert.rejects(f.service.startOperation({ planId: created.planId, planFingerprint: created.planFingerprint, choices: {} }), { code: 'PLAN_STALE' });
});

test('launch preflight captures epoch before awaited planning and never binds a replacement owner', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const entered = deferred(); const gate = deferred();
  const request = preparePreflight(f, reserved.instanceId, async () => { entered.resolve(); await gate.promise; });
  const creating = f.service.createPlan(request);
  await entered.promise;
  f.owner.epoch = Symbol('replacement-owner');
  gate.resolve();
  await assert.rejects(creating, { code: 'PLAN_STALE' });
  assert.equal(f.plans.plans.size, 0);
  assert.equal(f.executions, 0);
});

test('launch direct plan fence advances discovery generation before cleanup settles', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  const before = f.service.getLaunchAdmissionState(f.owner.epoch).generation;
  const gate = deferred();
  f.workspace.releaseOwner = () => gate.promise;
  const invalidating = f.plans.invalidate(request.planId);
  try {
    assert.ok(f.service.getLaunchAdmissionState(f.owner.epoch).generation > before);
    assert.ok(f.service.admissionGeneration > before);
    await assert.rejects(f.plans.get({ planId: request.planId, fingerprint: request.planFingerprint }), { code: 'PLAN_STALE' });
  } finally { gate.resolve(); await invalidating; }
});

test('launch failed binding cleans the sealed plan without reusing its preparation capability', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = preparePreflight(f, reserved.instanceId);
  let sealed = false;
  f.workspace.beginPreparationAttempt = () => ({ async retire() { if (sealed) throw new Error('sealed capability reused'); }, finish() {} });
  f.workspace.transferOwnership = ({ preparationAttempt }) => { if (preparationAttempt) sealed = true; };
  const gate = f.reservations.withDestinationGate.bind(f.reservations);
  f.reservations.withDestinationGate = (target, work) => gate(target, () => { f.owner.epoch = Symbol('replaced'); return work(); });
  await assert.rejects(f.service.createPlan(request), { code: 'PLAN_STALE' });
  assert.equal(f.plans.plans.size, 0);
});

test('launch held handoff schedules once and refuses generic release past TTL', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  assert.match(request.planId, /^plan-launch-v1-[a-f0-9-]{36}$/);
  const queued = await f.service.startOperation(request);
  await assert.rejects(f.service.startOperation(request), { code: 'PLAN_STALE' });
  assert.equal(f.executions, 1);
  assert.equal(await f.service.releaseServerDestination(reserved.instanceId), false);
  f.advance(2000);
  assert.equal(f.reservations.resolve(reserved.instanceId).instanceId, reserved.instanceId);
  assert.equal(await f.reservations.sweepExpired(), 0);
  assert.equal((await f.store.getNewServerLaunch(queued.jobId, f.owner.epoch)).binding.destinationDisposition, 'held');
});

test('launch drain spans deferred create handoff and the scheduled execution owner', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  const entered = deferred(); const writeGate = deferred();
  const write = f.durableFs.writeJsonAtomicAsync;
  f.store.durableFs = { ...f.durableFs, async writeJsonAtomicAsync(...args) { entered.resolve(); await writeGate.promise; return write(...args); } };
  const starting = f.service.startOperation(request);
  await entered.promise;
  let disposed = false;
  const disposing = f.service.dispose().then(() => { disposed = true; });
  await assert.rejects(f.service.startOperation(request), { code: 'PLAN_STALE' });
  assert.equal(disposed, false);
  writeGate.resolve();
  const queued = await starting;
  assert.equal(f.executions, 1);
  assert.equal(disposed, false);
  assert.equal(f.reservations.isDestinationHeld(reserved.instanceId), true);
  f.runtimeGate.resolve();
  await disposing;
  assert.equal(disposed, true);
  assert.equal((await f.store.getNewServerLaunch(queued.jobId, f.owner.epoch)).binding.destinationDisposition, 'held');
});

test('launch release-first fences siblings before cleanup and late starts create no job', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const first = await f.plan(reserved.instanceId);
  const second = await f.plan(reserved.instanceId);
  assert.equal(await f.service.releaseServerDestination(reserved.instanceId), true);
  await assert.rejects(f.service.startOperation(first), { code: 'PLAN_STALE' });
  await assert.rejects(f.service.startOperation(second), { code: 'PLAN_STALE' });
  assert.equal((await f.store.listNewServerLaunchBindings(f.owner.epoch)).length, 0);
  const next = await f.reservations.reserveWithNativeDialog({});
  assert.notEqual(next.instanceId, reserved.instanceId);
  assert.equal(await f.service.releaseServerDestination(reserved.instanceId), false);
  assert.notEqual(f.reservations.resolve(next.instanceId), null);
});

test('launch ambiguous own expected-absent publication adopts exactly once while release and siblings are fenced', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  const sibling = await f.plan(reserved.instanceId);
  const entered = deferred(); const gate = deferred();
  const write = f.durableFs.writeJsonAtomicAsync;
  f.store.durableFs = { ...f.durableFs, async writeJsonAtomicAsync(...args) { entered.resolve(); await gate.promise; await write(...args); throw new Error('published but response lost'); } };
  const starting = f.service.startOperation(request);
  await entered.promise;
  const competing = f.service.startOperation(sibling);
  const duplicate = f.service.startOperation(request);
  const releasing = f.service.releaseServerDestination(reserved.instanceId);
  try {
    await assert.rejects(duplicate, { code: 'PLAN_STALE' });
    assert.equal(await releasing, false);
    f.advance(2000);
    assert.notEqual(f.reservations.resolve(reserved.instanceId), null);
    assert.equal(f.executions, 0);
  } finally { f.store.durableFs = f.durableFs; gate.resolve(); }
  const job = await starting;
  await assert.rejects(competing, { code: 'PLAN_STALE' });
  assert.equal(f.executions, 1);
  assert.equal((await f.store.findNewServerLaunch({ planId: request.planId, planFingerprint: request.planFingerprint }, f.owner.epoch)).job.jobId, job.jobId);
  assert.equal(f.service.pendingNewServerAdmissions.size, 0);
});

for (const fault of ['absent', 'unreadable', 'changed-initial']) test(`launch ambiguous ${fault} publication never guesses execution or release`, async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  const create = f.store.create.bind(f.store);
  f.store.create = async (...args) => {
    if (fault !== 'absent') {
      const job = await create(...args);
      if (fault === 'unreadable') fs.writeFileSync(path.join(f.store.operationsPath, `${job.jobId}.json`), 'corrupt');
      else await f.store.appendEvent(job.jobId, { channel: 'log', message: 'not the initial record' });
    }
    throw new ModpackError('COMMIT_FAILED', 'lost create result');
  };
  await assert.rejects(f.service.startOperation(request), { code: fault === 'absent' ? 'COMMIT_FAILED' : 'RECOVERY_REQUIRED' });
  assert.equal(f.executions, 0);
  assert.equal(f.service.pendingNewServerAdmissions.size, fault === 'absent' ? 0 : 1);
  assert.equal(await f.service.releaseServerDestination(reserved.instanceId), fault === 'absent');
  assert.equal(f.plans.claimedJobIds.size, fault === 'absent' ? 0 : 1);
});

test('launch retained association collision without attempt witness retains claim and fence', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  await f.store.create({ jobId: 'op2-00000000000040008000000000000099', operationKind: 'install-new', serverId: reserved.instanceId,
    planFingerprint: request.planFingerprint, launchBinding: { planId: request.planId, planFingerprint: request.planFingerprint,
      instanceId: reserved.instanceId, targetPath: 'c:\\launchfixture\\pack', capturedReservation: { kind: 'absent' }, displayName: 'Pack', destinationDisposition: 'held' } }, f.owner.epoch);
  await assert.rejects(f.service.startOperation(request));
  assert.equal(f.service.pendingNewServerAdmissions.size, 1);
  assert.equal(f.plans.claimedJobIds.size, 1);
  assert.equal(f.executions, 0);
  assert.equal(await f.service.releaseServerDestination(reserved.instanceId), false);
});

test('launch admission seventeen rejects before claim and stalled slots never expire', async t => {
  const f = await fixture(t);
  const gate = deferred();
  f.plans.get = async () => { await gate.promise; throw new ModpackError('PLAN_STALE', 'fixture lookup ended'); };
  let claims = 0;
  f.plans.claim = async () => { claims++; assert.fail('must not claim'); };
  const pending = Array.from({ length: 16 }, (_, index) => f.service.startOperation({
    planId: `plan-launch-v1-10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, planFingerprint: 'a'.repeat(64), choices: {} }).catch(error => error));
  try {
    await assert.rejects(f.service.startOperation({ planId: 'plan-launch-v1-10000000-0000-4000-8000-999999999999',
      planFingerprint: 'a'.repeat(64), choices: {} }), { code: 'OPERATION_IN_PROGRESS' });
    f.advance(30001);
    const state = f.service.getLaunchAdmissionState(f.owner.epoch);
    assert.equal(state.pending.length, 16);
    assert.equal(state.pending.every(entry => entry.reason === 'admission-unresolved'), true);
    assert.equal(claims, 0);
  } finally { gate.resolve(); await Promise.all(pending); }
  assert.equal(f.service.pendingNewServerAdmissions.size, 0);
});

test('launch expiry fences plans and late dialog cannot bypass a job hold', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  f.advance(1000);
  assert.throws(() => f.reservations.resolve(reserved.instanceId), { code: 'PLAN_STALE' });
  assert.equal(await f.reservations.sweepExpired(), 1);
  await assert.rejects(f.service.startOperation(request), { code: 'PLAN_STALE' });
  const next = await f.reservations.reserveWithNativeDialog({});
  const nextRequest = await f.plan(next.instanceId);
  const dialog = deferred();
  f.reservations.dialog.showOpenDialog = () => dialog.promise;
  const late = f.reservations.reserveWithNativeDialog({});
  const job = await f.service.startOperation(nextRequest);
  dialog.resolve({ canceled: false, filePaths: ['C:\\LaunchFixture\\Pack'] });
  await assert.rejects(late, { code: 'TARGET_EXISTS' });
  assert.equal(f.reservations.removeConfirmedJobHold({ jobId: job.jobId, instanceId: reserved.instanceId, disposition: 'released' }), false);
  assert.equal(await f.service.releaseServerDestination(next.instanceId), false);
});

test('launch failed no-job cleanup retains claim admission and destination fence', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  f.store.create = async () => { throw new ModpackError('COMMIT_FAILED', 'no file'); };
  f.plans.workspaceRegistry.releaseOwner = async () => { throw new Error('cleanup uncertain'); };
  await assert.rejects(f.service.startOperation(request), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.service.pendingNewServerAdmissions.size, 1);
  assert.equal(f.plans.claimedJobIds.size, 1);
  assert.equal(await f.service.releaseServerDestination(reserved.instanceId), false);
  assert.equal(f.executions, 0);
});

test('launch owner epoch changed after lookup cannot create or schedule', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  const get = f.plans.get.bind(f.plans);
  f.plans.get = async value => { const result = await get(value); f.owner.epoch = Symbol('replacement-owner'); return result; };
  await assert.rejects(f.service.startOperation(request), { code: 'PLAN_STALE' });
  assert.equal((await f.store.listNewServerLaunchBindings(f.owner.epoch)).length, 0);
  assert.equal(f.executions, 0);
  assert.equal(f.service.pendingNewServerAdmissions.size, 0);
});

test('launch restoration refuses a different live incarnation at the same path', async t => {
  const f = await fixture(t);
  const reserved = await f.reservations.reserveWithNativeDialog({});
  assert.throws(() => f.reservations.restoreJobHold({ jobId: 'job-old', binding: {
    planId: 'plan-launch-v1-00000000-0000-4000-8000-000000000099', planFingerprint: 'a'.repeat(64),
    instanceId: 'server-old', targetPath: 'c:\\launchfixture\\pack', capturedReservation: { kind: 'absent' },
    displayName: 'Pack', destinationDisposition: 'held' } }), { code: 'PLAN_STALE' });
  assert.equal(f.reservations.isDestinationHeld(reserved.instanceId), false);
});
