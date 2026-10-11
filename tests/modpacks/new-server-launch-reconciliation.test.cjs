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

function closureRecord(overrides = {}) {
  return { jobId: 'launch-job', operationKind: 'install', phase: 'failed', swapStep: 'none',
    target: { kind: 'new', stableServerId: 'launch-server', path: 'C:\\LaunchFixture\\Pack' },
    restoreCreation: null, restorePoint: null,
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    outcome: { recovery: { action: 'revalidation-aborted' } }, ...overrides };
}

test('launch matrix authentic closure predicates reject incomplete revalidation and accept exact topology', () => {
  const { classifyRecoveryTerminalClosure: classify } = require('../../electron/services/modpack-lifecycle/new-server-launch-closure.cjs');
  assert.equal(classify(closureRecord()), 'abandoned');
  for (const changed of [ { restoreCreation: {} }, { restorePoint: {} }, { swapStep: 'new-prepared' },
    { directoryIdentities: {} }, { outcome: { recovery: { action: 'revalidation-aborted', operationId: 'other' } } },
    { outcome: { recovery: { action: 'revalidation-aborted' }, liveMutationAuthorized: true } },
    { outcome: { recovery: { action: 'revalidation-aborted' }, registration: {} } } ]) {
    assert.equal(classify(closureRecord(changed)), null);
  }
  for (const record of [null, {}, { phase: 'failed' }]) assert.equal(classify(record), null);
  assert.equal(classify(closureRecord({ swapStep: 'new-prepared', outcome: {
    recovery: { action: 'pre-publication-cleanup', operationId: 'launch-job' } } })), 'abandoned');
  assert.equal(classify(closureRecord({ phase: 'completed', swapStep: 'candidate-published', outcome: {
    publication: { state: 'published' }, registration: { complete: true, instanceId: 'launch-server' } } })), 'completed');
});

test('launch matrix destination projection separates safe closure from confirmed disposition and actual actions', () => {
  const { classifyLaunchDestination: classify } = require('../../electron/services/modpack-lifecycle/new-server-launch-closure.cjs');
  const job = { jobId: 'launch-job', operationKind: 'install-new', serverId: 'launch-server', phase: 'failed' };
  const binding = { instanceId: 'launch-server', targetPath: 'c:\\launchfixture\\pack', destinationDisposition: 'held' };
  const closed = { record: closureRecord(), terminalPublished: true };
  const cases = [
    [{ recoveryEvidence: closed, registrationState: 'absent' }, 'released', 'repair-pending', 'settlement-repair-required', false],
    [{ recoveryEvidence: closed, registrationState: 'registered' }, null, 'support-required', 'conflicting-evidence', false],
    [{ recoveryEvidence: { record: closureRecord(), terminalPublished: false } }, null, 'support-required', 'pending-terminal-publication', false],
    [{ recoveryEvidence: { pendingTerminalPublication: true, recoveryAvailable: true } }, null, 'recovery-required', 'pending-terminal-publication', true],
    [{ recoveryEvidence: { active: true, recoveryAvailable: true } }, null, 'recovery-required', 'conflicting-evidence', true],
    [{ recoveryEvidence: { corrupt: true } }, null, 'support-required', 'invalid-durable-evidence', false],
    [{}, null, 'support-required', 'missing-recovery-evidence', false],
    [{ recoveryEvidence: { owned: true } }, null, 'active', undefined, false],
    [{ binding: { ...binding, destinationDisposition: 'released' } }, 'released', 'settled', undefined, false],
    [{ binding: { ...binding, destinationDisposition: 'released' }, recoveryEvidence: { owned: true } }, 'released', 'active', undefined, false],
    [{ binding: { ...binding, destinationDisposition: 'consumed' }, recoveryEvidence: { owned: true } }, 'consumed', 'active', undefined, false],
    [{ binding: { ...binding, destinationDisposition: 'consumed' }, recoveryEvidence: closed, registrationState: 'absent' }, null, 'support-required', 'conflicting-evidence', false]
  ];
  for (const [change, disposition, settlementStatus, reason, recoveryAvailable] of cases) {
    assert.deepEqual(classify({ job, binding, registrationState: 'absent', ...change }), {
      disposition, settlementStatus, ...(reason ? { reason } : {}), recoveryAvailable });
  }
});

test('launch matrix registration requires the same unique server object for ID and canonical path', () => {
  const { newServerRegistrationState: classify } = require('../../electron/services/modpack-lifecycle/new-server-launch-closure.cjs');
  const target = closureRecord().target;
  const server = { id: target.stableServerId, type: 'server', path: target.path.toLowerCase() };
  assert.equal(classify([server], target), 'registered');
  assert.equal(classify([], target), 'absent');
  for (const instances of [null, [server, { ...server }], [{ ...server, type: 'client' }],
    [{ ...server, path: 'C:\\Other' }, { ...server, id: 'other' }]]) assert.equal(classify(instances, target), 'conflict');
});

test('launch matrix closure topology and identity predicates reject partial identities', () => {
  const { classifyRecoveryTerminalClosure: classify } = require('../../electron/services/modpack-lifecycle/new-server-launch-closure.cjs');
  const identity = { volumeSerial: 'aa', fileId: 'bb' };
  const existing = closureRecord({ target: { kind: 'existing', stableServerId: 'launch-server', path: 'C:\\LaunchFixture\\Pack' },
    swapStep: 'live-moved', directoryIdentities: { target: identity, candidate: null, rollback: identity, failed: null },
    outcome: { recovery: { action: 'between-renames-restored', operationId: 'launch-job' } } });
  assert.equal(classify(existing), 'abandoned');
  assert.equal(classify({ ...existing, phase: 'rolled-back', swapStep: 'rollback-restored',
    directoryIdentities: { ...existing.directoryIdentities, failed: identity },
    outcome: { recovery: { action: 'rollback-restored', operationId: 'launch-job' } } }), 'rolled-back');
  for (const changed of [{ target: {}, rollback: {} }, { rollback: { ...identity, fileId: 'cc' } }, { failed: identity }]) {
    assert.equal(classify({ ...existing, directoryIdentities: { ...existing.directoryIdentities, ...changed } }), null);
  }
  const health = closureRecord({ swapStep: 'failed-canonical-moved',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: identity },
    outcome: { recovery: { action: 'new-health-failed', operationId: 'launch-job' } } });
  assert.equal(classify(health), 'abandoned');
  for (const failed of [null, {}, { fileId: 'bb' }]) assert.equal(classify({ ...health,
    directoryIdentities: { ...health.directoryIdentities, failed } }), null);
  assert.equal(classify({ ...health, swapStep: 'candidate-published' }), null);
  assert.equal(classify({ ...health, outcome: { recovery: { action: 'new-health-failed', operationId: 'other' } } }), null);
});

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
  const serviceDependencies = { sourceResolver: { resolveArtifactSetPlan() {} }, artifactDownloader: { downloadSet() {} },
    archiveInspector: { inspectArchive() {} }, inspectionLoader: { loadInspection() {} }, planningAdapter: { createPlan() {} },
    planRegistry: plans, operationStore: store, workspaceRegistry: workspace, mutationCoordinator: { runMutation() {} }, mutationRuntime: runtime,
    destinationReservations: reservations, launchOwner: owner, allowNewServerLaunchBindings: true, clock: () => now };
  let service = new ModpackLifecycleService(serviceDependencies);
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
    serviceDependencies, get executions() { return executions; }, advance(ms) { now += ms; }, loseOwner() { current = false; } };
}

async function seedLaunch(f) {
  const reserved = await f.reservations.reserveWithNativeDialog({});
  const request = await f.plan(reserved.instanceId);
  const privateReservation = f.reservations.resolve(reserved.instanceId);
  const job = await f.store.create({ jobId: 'launch-startup-job', operationKind: 'install-new', serverId: reserved.instanceId,
    planFingerprint: request.planFingerprint, launchBinding: { planId: request.planId, planFingerprint: request.planFingerprint,
      instanceId: reserved.instanceId, targetPath: privateReservation.targetPath, capturedReservation: privateReservation.reservation,
      displayName: privateReservation.displayName, destinationDisposition: 'held' } }, f.owner.epoch);
  return { job, launch: await f.store.getNewServerLaunch(job.jobId, f.owner.epoch) };
}

function cleanRecoveryRegistry() {
  return { async initialize() { return { records: [], corrupt: [], blocks: [], globalBlock: false, pendingTerminalPublications: [] }; },
    async load() { return null; }, async loadHistory() { return null; } };
}

test('launch read reconciles lost Start response to the same exact job without reexecution or release', async t => {
  const f = await fixture(t); const reserved = await f.reservations.reserveWithNativeDialog({}); const request = await f.plan(reserved.instanceId);
  const first = await f.service.reconcileNewServerLaunch({ planId: request.planId, planFingerprint: request.planFingerprint });
  assert.equal(first.status, 'not-observed');
  const started = await f.service.startOperation(request); // deliberately discard the response at the caller boundary
  const result = await f.service.reconcileNewServerLaunch({ planId: request.planId, planFingerprint: request.planFingerprint });
  assert.equal(result.status, 'started'); assert.equal(result.job.jobId, started.jobId);
  assert.equal(result.settlement.status, 'active'); assert.equal(result.settlement.destinationDisposition, 'held');
  assert.equal(f.executions, 1); assert.equal(f.reservations.isDestinationHeld(reserved.instanceId), true);
  assert.equal(JSON.stringify(result).includes('targetPath'), false);
  await assert.rejects(f.service.reconcileNewServerLaunch({ planId: request.planId, planFingerprint: 'b'.repeat(64) }), { code: 'INVALID_REQUEST' });
});

test('launch read pending fence covers pre-plan lookup and closes only after stable plan invalidation', async t => {
  const f = await fixture(t); const reserved = await f.reservations.reserveWithNativeDialog({}); const request = await f.plan(reserved.instanceId);
  const gate = deferred(); const original = f.plans.get.bind(f.plans); f.plans.get = async value => { await gate.promise; return original(value); };
  assert.equal(typeof f.service.reconcileNewServerLaunch, 'function');
  const start = f.service.startOperation(request); const credentials = { planId: request.planId, planFingerprint: request.planFingerprint };
  assert.equal((await f.service.reconcileNewServerLaunch(credentials)).status, 'pending');
  f.advance(30000); assert.equal((await f.service.reconcileNewServerLaunch(credentials)).reason, 'admission-unresolved');
  const listed = await f.service.listNewServerLaunches(); assert.equal(listed.items[0].status, 'pending');
  assert.equal(Object.hasOwn(listed.items[0], 'serverId'), false);
  await f.plans.invalidate(request.planId); gate.resolve(); await assert.rejects(start); // fenced, no publication
  assert.equal((await f.service.reconcileNewServerLaunch(credentials)).status, 'not-started');
  assert.equal((await f.service.listNewServerLaunches()).items.length, 0);
  assert.deepEqual(await f.service.reconcileNewServerLaunch({ planId: 'legacy-plan', planFingerprint: 'a'.repeat(64) }),
    { planId: 'legacy-plan', planFingerprint: 'a'.repeat(64), status: 'unavailable', reason: 'legacy-correlation-unavailable' });
});

test('launch read generations cannot certify negative absence across a new admission or publication', async t => {
  const f = await fixture(t); const reserved = await f.reservations.reserveWithNativeDialog({}); const request = await f.plan(reserved.instanceId);
  const original = f.store.findNewServerLaunch.bind(f.store);
  f.store.findNewServerLaunch = async (...args) => { const result = await original(...args); f.service.localAdmissionGeneration++; return result; };
  assert.equal((await f.service.reconcileNewServerLaunch({ planId: request.planId, planFingerprint: request.planFingerprint })).status, 'pending');
  f.store.findNewServerLaunch = async () => { throw new ModpackError('PLAN_STALE', 'publication changed'); };
  assert.equal((await f.service.reconcileNewServerLaunch({ planId: request.planId, planFingerprint: request.planFingerprint })).status, 'pending');
});

for (const closure of ['invalidate', 'release-claim']) test(`launch credential closure authenticates issued fingerprint after ${closure}`, async t => {
  const f = await fixture(t); const reserved = await f.reservations.reserveWithNativeDialog({}); const request = await f.plan(reserved.instanceId);
  const credentials = { planId: request.planId, planFingerprint: request.planFingerprint };
  if (closure === 'invalidate') await f.plans.invalidate(request.planId);
  else {
    const claimed = await f.plans.claim({ planId: request.planId, fingerprint: request.planFingerprint });
    assert.equal((await f.service.reconcileNewServerLaunch(credentials)).status, 'pending');
    await f.plans.releaseClaim(claimed.jobId);
  }
  assert.equal(f.plans.plans.has(request.planId), false); assert.equal(f.plans.claimedPlans.size, 0);
  const before = { generation: f.plans.fenceGeneration, allocations: f.plans.allocatedIds.size };
  f.plans.get = () => assert.fail('closure must not resolve/clean executable plans');
  f.workspace.releaseOwner = () => assert.fail('closure must not release ownership');
  assert.equal((await f.service.reconcileNewServerLaunch(credentials)).status, 'not-started');
  await assert.rejects(f.service.reconcileNewServerLaunch({ ...credentials, planFingerprint: 'b'.repeat(64) }), { code: 'INVALID_REQUEST' });
  assert.equal(f.plans.fenceGeneration, before.generation); assert.equal(f.plans.allocatedIds.size, before.allocations);
});

for (const scope of ['unknown', 'fresh-registry']) test(`launch credential closure refuses ${scope} reference without durable authority`, async t => {
  const f = await fixture(t); const reserved = await f.reservations.reserveWithNativeDialog({}); const request = await f.plan(reserved.instanceId);
  const credentials = { planId: request.planId, planFingerprint: request.planFingerprint };
  await f.plans.invalidate(request.planId);
  if (scope === 'unknown') {
    await assert.rejects(f.service.reconcileNewServerLaunch({ ...credentials,
      planId: 'plan-launch-v1-00000000-0000-4000-8000-999999999999' }), { code: 'INVALID_REQUEST' });
    return;
  }
  const restartedPlans = new PlanRegistry({ workspaceRegistry: f.workspace, allowNewServerLaunchBindings: true });
  const restartedService = new ModpackLifecycleService({ ...f.serviceDependencies, planRegistry: restartedPlans });
  t.after(() => restartedService.dispose());
  for (const planFingerprint of [credentials.planFingerprint, 'b'.repeat(64)]) {
    await assert.rejects(restartedService.reconcileNewServerLaunch({ ...credentials, planFingerprint }), { code: 'INVALID_REQUEST' });
  }
  assert.equal(f.executions, 0); assert.equal(f.plans.plans.size, 0); assert.equal(restartedPlans.plans.size, 0);
});

test('launch read owner loss after awaited catalogue lookup remains pending', async t => {
  const f = await fixture(t); const { launch } = await seedLaunch(f);
  const original = f.store.findNewServerLaunch.bind(f.store);
  f.store.findNewServerLaunch = async (...args) => { const result = await original(...args); f.loseOwner(); return result; };
  assert.equal((await f.service.reconcileNewServerLaunch({ planId: launch.binding.planId, planFingerprint: launch.binding.planFingerprint })).status, 'pending');
});

test('launch read cannot certify irreversible closure from unfenced expiry or retained claim and never runs cleanup', async t => {
  const f = await fixture(t); const reserved = await f.reservations.reserveWithNativeDialog({}); const request = await f.plan(reserved.instanceId);
  const credentials = { planId: request.planId, planFingerprint: request.planFingerprint };
  const record = f.plans.plans.get(request.planId);
  record.expiresAtMs = 0;
  f.workspace.releaseOwner = () => assert.fail('read cannot clean a plan');
  assert.equal((await f.service.reconcileNewServerLaunch(credentials)).status, 'pending');
  record.expiresAtMs = Number.MAX_SAFE_INTEGER;
  const claimed = await f.plans.claim({ planId: request.planId, fingerprint: request.planFingerprint });
  assert.equal((await f.service.reconcileNewServerLaunch(credentials)).status, 'pending');
  f.plans.claimedPlans.delete(claimed.jobId); f.plans.claimedJobIds.delete(claimed.jobId);
  assert.equal((await f.service.reconcileNewServerLaunch(credentials)).status, 'not-started');
});

test('launch read gets terminal hydration outside the gate and refuses changed immutable association', async t => {
  const f = await fixture(t); const { launch } = await seedLaunch(f);
  const original = f.service.getJob.bind(f.service); let hydrated = false;
  f.service.getJob = async id => f.reservations.withDestinationGate(launch.binding.targetPath, async () => { hydrated = true; return original(id); });
  const result = await f.service.reconcileNewServerLaunch({ planId: launch.binding.planId, planFingerprint: launch.binding.planFingerprint });
  assert.equal(hydrated, true); assert.equal(result.status, 'started');
  f.service.getJob = async () => ({ ...launch.job, jobId: 'wrong-job' });
  assert.notEqual((await f.service.reconcileNewServerLaunch({ planId: launch.binding.planId, planFingerprint: launch.binding.planFingerprint })).status, 'started');
});

test('launch read held terminal stays started and exposes actual held repair disposition without publication', async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f); const registry = await recordedAbandonment(f, launch);
  await f.store.transition(job.jobId, { expectedPhase: 'queued', nextPhase: 'failed', patch: { outcome: { status: 'failed', message: 'Failed' } } });
  registry.retryTerminalPublication = () => assert.fail('read cannot publish recovery');
  f.store.settleNewServerDestination = () => assert.fail('read cannot settle');
  const result = await f.service.reconcileNewServerLaunch({ planId: launch.binding.planId, planFingerprint: launch.binding.planFingerprint });
  assert.equal(result.status, 'started'); assert.equal(result.job.phase, 'failed');
  assert.deepEqual(result.settlement, { status: 'repair-pending', destinationDisposition: 'held', reason: 'settlement-repair-required', recoveryAvailable: false });
  assert.equal(f.reservations.isDestinationHeld(job.serverId), true);
});

async function catalogueFixture(t, count) {
  const f = await fixture(t); const { launch } = await seedLaunch(f);
  const entries = Array.from({ length: count }, (_, n) => ({ ...launch,
    job: { ...launch.job, jobId: `list-job-${n}`, serverId: `list-server-${n}` },
    binding: { ...launch.binding, planId: `plan-launch-v1-00000000-0000-4000-8000-${String(n + 100).padStart(12, '0')}`, instanceId: `list-server-${n}` } }));
  f.store.listNewServerLaunchBindings = async () => entries;
  f.store.findNewServerLaunch = async ({ planId }) => entries.find(entry => entry.binding.planId === planId) || null;
  f.store.getNewServerLaunch = async id => entries.find(entry => entry.job.jobId === id) || null;
  f.service.getJob = async id => entries.find(entry => entry.job.jobId === id)?.job;
  f.service.launchRecoveryRegistry = cleanRecoveryRegistry(); f.service.launchRegistrationState = () => 'absent';
  return { f, entries };
}

for (const disposition of ['released', 'consumed']) for (const mode of ['corrupt', 'conflict', 'executable-recovery']) {
  test(`launch read preserves known job and actual ${disposition} disposition for ${mode} evidence`, async t => {
    const { f, entries } = await catalogueFixture(t, 1); const launch = entries[0];
    launch.binding = { ...launch.binding, destinationDisposition: disposition };
    launch.job = { ...launch.job, phase: 'failed', terminalAt: launch.job.createdAt, outcome: { status: 'failed', message: 'Failed' } };
    if (mode === 'corrupt') f.service.launchRecoveryRegistry.initialize = async () => ({
      records: [], corrupt: [{ jobId: launch.job.jobId }], blocks: [], globalBlock: false, pendingTerminalPublications: [] });
    if (mode === 'conflict') f.service.launchRegistrationState = () => 'conflict';
    if (mode === 'executable-recovery') {
      const record = closureRecord({ jobId: launch.job.jobId, target: { kind: 'new', stableServerId: launch.job.serverId, path: launch.binding.targetPath } });
      f.service.launchRecoveryRegistry.load = async () => record;
      f.service.launchRecoveryRegistry.retryTerminalPublication = () => assert.fail('read cannot execute recovery');
      f.service.launchTerminalPublicationAvailable = true;
    }
    f.store.settleNewServerDestination = () => assert.fail('read cannot settle');
    const result = await f.service.reconcileNewServerLaunch({ planId: launch.binding.planId, planFingerprint: launch.binding.planFingerprint });
    const settlement = { status: 'support-required', destinationDisposition: disposition,
      reason: mode === 'corrupt' ? 'invalid-durable-evidence' : 'conflicting-evidence', recoveryAvailable: false };
    assert.equal(result.status, 'started'); assert.equal(result.job.jobId, launch.job.jobId);
    assert.deepEqual(result.settlement, settlement);
    assert.deepEqual((await f.service.listNewServerLaunches()).items[0].settlement, settlement);
  });
}

for (const authority of ['recovery', 'registration']) test(`launch read preserves exact readable job when ${authority} evidence fails`, async t => {
  const { f, entries } = await catalogueFixture(t, 1); const launch = entries[0];
  if (authority === 'recovery') f.service.launchRecoveryRegistry.initialize = async () => { throw new Error('private recovery failure'); };
  else f.service.launchRegistrationState = async () => { throw new Error('private registration failure'); };
  const result = await f.service.reconcileNewServerLaunch({ planId: launch.binding.planId, planFingerprint: launch.binding.planFingerprint });
  assert.equal(result.status, 'started'); assert.equal(result.job.jobId, launch.job.jobId);
  assert.deepEqual(result.settlement, { status: 'support-required', destinationDisposition: 'held',
    reason: authority === 'recovery' ? 'invalid-durable-evidence' : 'conflicting-evidence', recoveryAvailable: false });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('launch discovery snapshot is bounded immutable sorted deduplicated and freshly reconciled', async t => {
  const { f, entries } = await catalogueFixture(t, 55); const index = f.store.records;
  f.service.pendingNewServerAdmissions.set(entries[0].binding.planId, { ...entries[0].binding, createdAt: Date.parse(entries[0].job.createdAt), jobId: null, instanceId: null });
  const first = await f.service.listNewServerLaunches(); assert.equal(first.items.length, 50);
  assert.match(first.nextCursor, /^launch-cursor-v1-[a-f0-9-]{36}$/);
  assert.equal(first.items[0].planId, entries[0].binding.planId); assert.equal(first.items[0].status, 'started');
  entries.push({ ...entries[0], binding: { ...entries[0].binding, planId: 'plan-launch-v1-00000000-0000-4000-8000-999999999999' } });
  const second = await f.service.listNewServerLaunches({ cursor: first.nextCursor, limit: 100 });
  assert.equal(second.items.length, 5); assert.equal(second.nextCursor, null); assert.equal(f.store.records, index);
  assert.equal(Object.hasOwn(second.items[0], 'job'), false); assert.equal(Object.hasOwn(second.items[0], 'settlement'), true);
  const one = await f.service.listNewServerLaunches({ limit: 1 }); assert.equal(one.items.length, 1);
  const all = await f.service.listNewServerLaunches({ limit: 100 }); assert.equal(all.items.length, 56);
});

test('launch discovery cursor expiry capacity restart and catalogue limit are explicit safe errors', async t => {
  const { f, entries } = await catalogueFixture(t, 2); const pages = [];
  for (let n = 0; n < 4; n++) pages.push(await f.service.listNewServerLaunches({ limit: 1 }));
  await assert.rejects(f.service.listNewServerLaunches(), { code: 'LAUNCH_DISCOVERY_CAPACITY', retryable: true });
  await assert.rejects(f.service.listNewServerLaunches({ cursor: 'launch-cursor-v1-00000000-0000-4000-8000-999999999999' }), { code: 'LAUNCH_CURSOR_EXPIRED', retryable: true });
  f.advance(120000); await assert.rejects(f.service.listNewServerLaunches({ cursor: pages[0].nextCursor }), { code: 'LAUNCH_CURSOR_EXPIRED' });
  assert.equal((await f.service.listNewServerLaunches()).items.length, 2);
  assert.equal(f.service.launchSnapshots.size, 4, 'only the oldest expired snapshot is evicted to make a slot');
  entries.splice(0, entries.length, ...Array.from({ length: 2001 }, (_, n) => ({ ...entries[0], binding: { ...entries[0].binding, planId: `plan-${n}` } })));
  await assert.rejects(f.service.listNewServerLaunches(), { code: 'LAUNCH_LIST_LIMIT_EXCEEDED', retryable: false });
  f.service.closeAdmission(); assert.equal(f.service.launchSnapshots.size, 0);
  for (const request of [{ limit: 0 }, { limit: 101 }, { cursor: 'offset-1' }, { path: 'C:\\private' }]) {
    await assert.rejects(f.service.listNewServerLaunches(request), { code: 'INVALID_REQUEST' });
  }
});

test('launch discovery concurrent capture respects four snapshots', async t => {
  const { f } = await catalogueFixture(t, 3);
  for (let n = 0; n < 3; n++) await f.service.listNewServerLaunches({ limit: 1 });
  const settled = await Promise.allSettled([f.service.listNewServerLaunches({ limit: 1 }), f.service.listNewServerLaunches({ limit: 1 })]);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.find(item => item.status === 'rejected').reason.code, 'LAUNCH_DISCOVERY_CAPACITY');
  assert.equal(f.service.launchSnapshots.size, 4);
});

test('launch discovery repeated pages bound cursor memory', async t => {
  const { f } = await catalogueFixture(t, 3);
  const first = await f.service.listNewServerLaunches({ limit: 1 });
  const second = await f.service.listNewServerLaunches({ cursor: first.nextCursor, limit: 1 });
  const count = f.service.launchCursors.size;
  for (let n = 0; n < 5; n++) {
    const again = await f.service.listNewServerLaunches({ cursor: first.nextCursor, limit: 1 });
    assert.equal(again.nextCursor, second.nextCursor);
  }
  assert.equal(f.service.launchCursors.size, count);
});

test('launch discovery unstable scan is a retryable error and never installs a partial snapshot', async t => {
  const { f } = await catalogueFixture(t, 1);
  f.store.listNewServerLaunchBindings = async () => { throw new ModpackError('PLAN_STALE', 'publication changed'); };
  await assert.rejects(f.service.listNewServerLaunches(), { code: 'PLAN_STALE', retryable: true });
  assert.equal(f.service.launchSnapshots.size, 0);
});

async function recordedAbandonment(f, launch) {
  const { fixtureRegistry } = require('./runtime-authority-fixture.cjs');
  const registry = fixtureRegistry(f.root); await registry.ready;
  await registry.create({ schemaVersion: 2, sequence: 0, jobId: launch.job.jobId, operationKind: 'install',
    target: { kind: 'new', stableServerId: launch.job.serverId, path: launch.binding.targetPath },
    candidatePath: null, rollbackPath: null, failedPath: null, restorePoint: null, restoreCreation: null, journalPath: null,
    priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', outcome: null });
  await registry.finish(launch.job.jobId, { terminalPhase: 'failed', outcome: { recovery: { action: 'revalidation-aborted' } } });
  f.service.launchRecoveryRegistry = registry;
  f.service.launchRegistrationState = () => 'absent';
  f.service.rememberNewServerLaunch(launch);
  f.reservations.restoreJobHold({ jobId: launch.job.jobId, binding: launch.binding });
  return registry;
}

test('launch settlement authenticated historical abandonment repairs held metadata exactly once', async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f); await recordedAbandonment(f, launch);
  const first = await f.service.settleJobDestination({ jobId: job.jobId, disposition: 'released' });
  const second = await f.service.settleJobDestination({ jobId: job.jobId, disposition: 'released' });
  assert.equal(first.binding.destinationDisposition, 'released'); assert.equal(second.job.sequence, first.job.sequence);
  assert.equal(f.reservations.isDestinationHeld(job.serverId), false); assert.equal(f.executions, 0);
  await assert.rejects(f.service.settleJobDestination({ jobId: job.jobId, disposition: 'consumed' }), { code: 'RECOVERY_REQUIRED' });
});

for (const fault of ['before', 'after', 'always']) test(`launch disposition ${fault} publication fault only retries metadata`, async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f); const registry = await recordedAbandonment(f, launch);
  const write = f.durableFs.writeJsonAtomicAsync; let writes = 0;
  f.store.durableFs = { ...f.durableFs, async writeJsonAtomicAsync(...args) {
    writes++;
    if (fault === 'always' || (writes === 1 && fault === 'before')) throw new Error('before disposition publication');
    const result = await write(...args);
    if (writes === 1 && fault === 'after') throw new Error('after disposition publication');
    return result;
  } };
  if (fault === 'always') {
    await assert.rejects(f.service.settleJobDestination({ jobId: job.jobId, disposition: 'released' }));
    assert.equal(f.reservations.isDestinationHeld(job.serverId), true);
    assert.equal(f.service.launchSettlements.get(job.jobId).settlementStatus, 'repair-pending');
  } else {
    await f.service.settleJobDestination({ jobId: job.jobId, disposition: 'released' });
    assert.equal(f.reservations.isDestinationHeld(job.serverId), false);
    assert.equal((await f.store.get(job.jobId)).sequence, 1);
  }
  assert.equal(writes, fault === 'after' ? 1 : 2); assert.equal(registry.finishCalls, 1); assert.equal(f.executions, 0);
});

test('launch settlement owner change after recovery evidence keeps exact hold', async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f); const registry = await recordedAbandonment(f, launch);
  const load = registry.loadHistory.bind(registry);
  registry.loadHistory = async (...args) => { const value = await load(...args); f.owner.epoch = Symbol('changed'); return value; };
  await assert.rejects(f.service.settleJobDestination({ jobId: job.jobId, disposition: 'released' }), { code: 'PLAN_STALE' });
  assert.equal(f.reservations.isDestinationHeld(job.serverId), true);
});

test('launch settlement drain retains metadata CAS after source closure and admission close', async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f); await recordedAbandonment(f, launch);
  const entered = deferred(); const gate = deferred(); const settle = f.store.settleNewServerDestination.bind(f.store);
  f.store.settleNewServerDestination = async (...args) => { entered.resolve(); await gate.promise; return settle(...args); };
  const settling = f.service.settleJobDestination({ jobId: job.jobId, disposition: 'released' });
  await entered.promise;
  f.service.closeAdmission(); let drained = false;
  const draining = f.service.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); assert.equal(f.reservations.isDestinationHeld(job.serverId), true);
  gate.resolve(); await settling; await draining;
  assert.equal(drained, true); assert.equal(f.reservations.isDestinationHeld(job.serverId), false); assert.equal(f.executions, 0);
});

test('launch historical startup repairs archived failed callback without active recovery or target operations', async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f); const registry = await recordedAbandonment(f, launch);
  assert.equal((await registry.initialize()).records.length, 0);
  const { reconcileNewServerLaunches } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
  await reconcileNewServerLaunches({ operationStore: f.store, recoveryRegistry: registry, lifecycleService: f.service,
    launchOwner: f.owner, jobs: [job], launches: [launch], registrationState: () => 'absent' });
  assert.equal((await f.store.getNewServerLaunch(job.jobId, f.owner.epoch)).binding.destinationDisposition, 'released');
  assert.equal(registry.finishCalls, 1); assert.equal(f.executions, 0);
});

for (const mode of ['failed', 'cancelled', 'fault']) test(`launch settlement live unrecorded terminal pair is atomic mode=${mode}`, async t => {
  const cancellation = mode === 'cancelled';
  const f = await fixture(t);
  const { fixtureRegistry } = require('./runtime-authority-fixture.cjs');
  const registry = fixtureRegistry(f.root); await registry.ready;
  f.service.launchRecoveryRegistry = registry; f.service.launchRegistrationState = () => 'absent';
  const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
  const { createServerMutationContext } = require('../../electron/services/server-mutation-context.cjs');
  const coordinator = new ServerMutationCoordinator({ context: createServerMutationContext(), readContentRevision: () => 0,
    bumpContentRevision() { assert.fail('unrecorded fixture cannot change target revision'); } });
  coordinator.completeStartupRecovery([]); f.service.mutationCoordinator = coordinator;
  const reserved = await f.reservations.reserveWithNativeDialog({}); const request = await f.plan(reserved.instanceId);
  const runtime = f.service.mutationRuntime;
  runtime.resolveInstance = async () => ({ instanceId: reserved.instanceId, serverPath: f.reservations.resolve(reserved.instanceId).targetPath, priorRunning: false });
  runtime.revalidate = async ({ jobId, resolved }) => {
    // Production runtime's separate authority test below exercises the genuine
    // clean scan/lease-authorized target consumption that produces this handoff.
    await f.service.recordUnrecordedLaunchClosure({ jobId, instanceId: resolved.instanceId, targetPath: resolved.serverPath });
    if (cancellation) await f.store.requestCancellation(jobId);
    throw new ModpackError(cancellation ? 'CANCELLED' : 'PLAN_STALE', 'inert revalidation failure');
  };
  const publications = []; let terminalAttempts = 0; const write = f.durableFs.writeJsonAtomicAsync;
  f.store.durableFs = { ...f.durableFs, async writeJsonAtomicAsync(file, value, options) {
    if (value.launchBinding?.destinationDisposition === 'released') {
      terminalAttempts++; if (mode === 'fault') throw new Error('terminal CAS fails before publication');
    }
    publications.push({ phase: value.phase, disposition: value.launchBinding?.destinationDisposition });
    return write(file, value, options);
  } };
  const queued = await f.service.startOperation(request);
  await f.service.drain();
  const final = await f.service.getJob(queued.jobId);
  if (mode === 'fault') {
    assert.equal(terminalAttempts, 2, 'one complete reproved CAS retry only');
    assert.equal(final.phase, 'recovery-required');
    assert.equal((await f.store.getNewServerLaunch(queued.jobId, f.owner.epoch)).binding.destinationDisposition, 'held');
    return;
  }
  assert.equal(final.phase, cancellation ? 'cancelled' : 'failed');
  const terminalWrites = publications.filter(item => ['failed', 'cancelled'].includes(item.phase));
  assert.deepEqual(terminalWrites, [{ phase: cancellation ? 'cancelled' : 'failed', disposition: 'released' }]);
  assert.equal(f.reservations.isDestinationHeld(reserved.instanceId), false);
  assert.equal((await f.store.getNewServerLaunch(queued.jobId, f.owner.epoch)).binding.destinationDisposition, 'released');
});

test('launch settlement rejects restart absence as live-unrecorded proof', async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f);
  f.service.rememberNewServerLaunch(launch); f.reservations.restoreJobHold({ jobId: job.jobId, binding: launch.binding });
  f.service.launchRecoveryRegistry = cleanRecoveryRegistry(); f.service.launchRegistrationState = () => 'absent';
  await assert.rejects(f.service.settleJobDestination({ jobId: job.jobId, disposition: 'released', terminalUpdate: {
    expectedPhase: 'queued', nextPhase: 'failed', patch: { outcome: { status: 'failed', message: 'not proved', operationKind: 'install-new', actions: [] } }
  } }), { code: 'RECOVERY_REQUIRED' });
  assert.equal((await f.store.get(job.jobId)).phase, 'queued'); assert.equal(f.reservations.isDestinationHeld(job.serverId), true);
});

test('launch historical pending publication advertises only an actual bound application action', async t => {
  const f = await fixture(t); const { launch } = await seedLaunch(f);
  const registry = cleanRecoveryRegistry(); const scan = await registry.initialize();
  scan.pendingTerminalPublications.push(closureRecord({ jobId: launch.job.jobId,
    target: { kind: 'new', stableServerId: launch.job.serverId, path: launch.binding.targetPath } }));
  registry.initialize = async () => scan;
  registry.retryTerminalPublication = async () => { assert.fail('no record to publish'); };
  const { readLaunchRecoveryEvidence } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
  assert.equal((await readLaunchRecoveryEvidence({ recoveryRegistry: registry, launch })).recoveryAvailable, false);
  assert.equal((await readLaunchRecoveryEvidence({ recoveryRegistry: registry, launch, terminalPublicationAvailable: true })).recoveryAvailable, true);
});

for (const startup of [false, true]) test(`launch destination recovery releases only exact setup hold and preserves older restriction startup=${startup}`, { timeout: 10000 }, async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f);
  const { fixtureRegistry } = require('./runtime-authority-fixture.cjs');
  const registry = fixtureRegistry(f.root); await registry.ready;
  await registry.create({ schemaVersion: 2, sequence: 0, jobId: 'older-recovery', operationKind: 'install',
    target: { kind: 'new', stableServerId: 'older-instance', path: launch.binding.targetPath },
    candidatePath: null, rollbackPath: null, failedPath: null, restorePoint: null, restoreCreation: null, journalPath: null,
    priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', outcome: null });
  const failed = await f.store.transition(job.jobId, { expectedPhase: 'queued', nextPhase: 'failed', patch: { outcome: {
    status: 'failed', message: 'Mutation acquisition refused', operationKind: 'install-new', errorCode: 'RECOVERY_REQUIRED',
    failureReason: 'destination-recovery', actions: [] } } });
  f.service.rememberNewServerLaunch(launch); f.reservations.restoreJobHold({ jobId: job.jobId, binding: launch.binding });
  f.service.launchRecoveryRegistry = registry; f.service.launchRegistrationState = () => 'absent';
  const before = await registry.initialize(); let hydratedOutsideGate = false;
  const getJob = f.service.getJob.bind(f.service);
  f.service.getJob = async id => {
    await f.reservations.withDestinationGate(launch.binding.targetPath, () => { hydratedOutsideGate = true; });
    return getJob(id);
  };
  if (startup) {
    const { reconcileNewServerLaunches } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
    await reconcileNewServerLaunches({ operationStore: f.store, recoveryRegistry: registry, lifecycleService: f.service,
      launchOwner: f.owner, jobs: [failed], launches: [await f.store.getNewServerLaunch(job.jobId, f.owner.epoch)], registrationState: () => 'absent' });
  } else {
    assert.equal(await f.service.releaseServerDestination(job.serverId), true);
    assert.equal(hydratedOutsideGate, true);
  }
  assert.equal((await f.store.getNewServerLaunch(job.jobId, f.owner.epoch)).binding.destinationDisposition, 'released');
  assert.equal(f.reservations.isDestinationHeld(job.serverId), false); assert.deepEqual(await registry.initialize(), before);
  assert.equal(f.executions, 0);
});

test('launch queued startup closes intact prior-owner v2 atomically without target work', async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f);
  const { reconcileNewServerLaunches } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
  const result = await reconcileNewServerLaunches({ operationStore: f.store, recoveryRegistry: cleanRecoveryRegistry(),
    lifecycleService: f.service, launchOwner: f.owner, jobs: [job], launches: [launch], registrationState: () => 'absent' });
  const current = await f.store.getNewServerLaunch(job.jobId, f.owner.epoch);
  assert.equal(current.job.phase, 'failed'); assert.equal(current.binding.destinationDisposition, 'released');
  assert.equal(current.job.sequence, 1); assert.equal(current.job.outcome.message, 'The operation was interrupted before execution');
  assert.equal(f.reservations.isDestinationHeld(job.serverId), false); assert.equal(f.executions, 0);
  assert.equal(result.settlements[job.jobId].settlementStatus, 'settled');
});

for (const changed of ['registration', 'active-recovery', 'history', 'active-owner', 'admission', 'settlement', 'epoch', 'job-phase']) {
  test(`launch queued deferred gate reproof rejects changed ${changed}`, async t => {
    const f = await fixture(t); const { job, launch } = await seedLaunch(f);
    const { fixtureRegistry } = require('./runtime-authority-fixture.cjs');
    const registry = fixtureRegistry(f.root); await registry.ready;
    const entered = deferred(); const release = deferred(); const requested = deferred();
    const gate = f.reservations.withDestinationGate.bind(f.reservations);
    const blocker = gate(launch.binding.targetPath, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    f.reservations.withDestinationGate = (...args) => { requested.resolve(); return gate(...args); };
    let registration = 'absent'; let closeCalls = 0; let rawCalls = 0; let publicationCalls = 0;
    const close = f.store.closeInterruptedQueued.bind(f.store);
    f.store.closeInterruptedQueued = (...args) => { closeCalls++; return close(...args); };
    const { reconcileNewServerLaunches } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
    const work = reconcileNewServerLaunches({ operationStore: f.store, recoveryRegistry: registry, lifecycleService: f.service,
      launchOwner: f.owner, jobs: [job], launches: [launch], registrationState: () => registration,
      retryTerminalPublication() { rawCalls++; assert.fail('queued gate reproof must not execute raw recovery'); } });
    await requested.promise;
    if (changed === 'registration') registration = 'registered';
    if (['active-recovery', 'history'].includes(changed)) {
      await registry.create({ schemaVersion: 2, sequence: 0, jobId: job.jobId, operationKind: 'install',
        target: { kind: 'new', stableServerId: job.serverId, path: launch.binding.targetPath },
        candidatePath: null, rollbackPath: null, failedPath: null, restorePoint: null, restoreCreation: null, journalPath: null,
        priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
        directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
        createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', outcome: null });
      if (changed === 'history') await registry.finish(job.jobId, { terminalPhase: 'failed', outcome: { recovery: { action: 'revalidation-aborted' } } });
    }
    if (changed === 'active-owner') f.service.activeOperations.set(job.jobId, { settled: Promise.resolve() });
    if (changed === 'admission') f.service.pendingNewServerAdmissions.set('new-admission', {});
    const settling = Promise.resolve();
    if (changed === 'settlement') f.service.admittedTasks.add(settling);
    if (changed === 'epoch') f.owner.epoch = Symbol('replacement');
    if (changed === 'job-phase') await f.store.transition(job.jobId, { expectedPhase: 'queued', nextPhase: 'preflight', patch: {} });
    registry.retryTerminalPublication = async () => { publicationCalls++; assert.fail('queued gate reproof must not publish recovery metadata'); };
    release.resolve(); await blocker;
    try {
      if (changed === 'epoch') await assert.rejects(work, { code: 'PLAN_STALE' });
      else {
        const result = await work;
        assert.notEqual(result.settlements[job.jobId].settlementStatus, 'settled');
      }
    } finally {
      f.service.activeOperations.delete(job.jobId); f.service.pendingNewServerAdmissions.delete('new-admission'); f.service.admittedTasks.delete(settling);
    }
    assert.equal(closeCalls, 0, 'changed proof must not reach queued close CAS');
    assert.equal(rawCalls, 0); assert.equal(publicationCalls, 0);
    assert.equal((await f.store.getNewServerLaunch(job.jobId, f.owner.epoch)).binding.destinationDisposition, 'held');
    assert.equal(f.reservations.isDestinationHeld(job.serverId), true); assert.equal(f.executions, 0);
  });
}

test('launch queued deferred gate reproof also rejects changed admission before its one ambiguous retry', async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f);
  const entered = deferred(); const release = deferred(); let gateCalls = 0; let closeCalls = 0;
  const gate = f.reservations.withDestinationGate.bind(f.reservations);
  f.reservations.withDestinationGate = (...args) => {
    if (++gateCalls !== 2) return gate(...args);
    return gate(args[0], async () => { entered.resolve(); await release.promise; return args[1](); });
  };
  f.store.closeInterruptedQueued = async () => { closeCalls++; throw new Error('first CAS failed before publication'); };
  const { reconcileNewServerLaunches } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
  const work = reconcileNewServerLaunches({ operationStore: f.store, recoveryRegistry: cleanRecoveryRegistry(), lifecycleService: f.service,
    launchOwner: f.owner, jobs: [job], launches: [launch], registrationState: () => 'absent' });
  await entered.promise;
  f.service.pendingNewServerAdmissions.set('new-admission', {}); release.resolve();
  try { await work; } finally { f.service.pendingNewServerAdmissions.delete('new-admission'); }
  assert.equal(closeCalls, 1, 'second gate must reprove before attempting another CAS');
  assert.equal(gateCalls, 2);
  assert.equal((await f.store.getNewServerLaunch(job.jobId, f.owner.epoch)).binding.destinationDisposition, 'held');
  assert.equal(f.reservations.isDestinationHeld(job.serverId), true);
});

test('launch queued uncertain publication requires the exact prescribed terminal pair', async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f);
  const close = f.store.closeInterruptedQueued.bind(f.store); let calls = 0;
  f.store.closeInterruptedQueued = async (...args) => {
    if (++calls > 1) return close(...args);
    const current = await f.store.getNewServerLaunch(job.jobId, f.owner.epoch);
    await f.store.settleNewServerDestination(job.jobId, { expectedInstanceId: job.serverId,
      expectedRecordRevision: current.recordRevision, nextDisposition: 'released', terminalUpdate: {
        expectedPhase: 'queued', nextPhase: 'failed', patch: {
          outcome: { status: 'failed', message: 'The operation was interrupted before execution', errorCode: 'COMMIT_FAILED', operationKind: 'install-new', actions: [] },
          progress: { percent: 100, message: 'A different terminal publication', currentItem: null }
        }
      } }, f.owner.epoch);
    throw new Error('uncertain terminal publication');
  };
  const { reconcileNewServerLaunches } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
  const result = await reconcileNewServerLaunches({ operationStore: f.store, recoveryRegistry: cleanRecoveryRegistry(),
    lifecycleService: f.service, launchOwner: f.owner, jobs: [job], launches: [launch], registrationState: () => 'absent' });
  assert.equal(result.settlements[job.jobId].settlementStatus, 'support-required');
  assert.equal(f.reservations.isDestinationHeld(job.serverId), true);
});

for (const fault of ['before', 'after', 'always', 'revision', 'later-phase']) test(`launch queued uncertainty reproof is bounded fault=${fault}`, async t => {
  const f = await fixture(t); const { job, launch } = await seedLaunch(f);
  const close = f.store.closeInterruptedQueued.bind(f.store); let attempts = 0; let scans = 0;
  const registry = cleanRecoveryRegistry(); const initialize = registry.initialize;
  registry.initialize = async () => { scans++; return initialize(); };
  f.store.closeInterruptedQueued = async (...args) => {
    attempts++;
    if (fault === 'always' || (attempts === 1 && fault === 'before')) throw new Error('before publication');
    if (attempts === 1 && fault === 'revision') await f.store.transition(job.jobId, { expectedPhase: 'queued', nextPhase: 'queued', patch: {} });
    if (attempts === 1 && fault === 'later-phase') await f.store.transition(job.jobId, { expectedPhase: 'queued', nextPhase: 'preflight', patch: {} });
    const value = await close(...args);
    if (attempts === 1 && fault === 'after') throw new Error('after publication');
    return value;
  };
  const { reconcileNewServerLaunches } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
  await reconcileNewServerLaunches({ operationStore: f.store, recoveryRegistry: registry, lifecycleService: f.service,
    launchOwner: f.owner, jobs: [job], launches: [launch], registrationState: () => 'absent' });
  const current = await f.store.getNewServerLaunch(job.jobId, f.owner.epoch);
  const held = ['always', 'later-phase'].includes(fault);
  assert.equal(current.binding.destinationDisposition, held ? 'held' : 'released');
  assert.equal(f.reservations.isDestinationHeld(job.serverId), held);
  assert.equal(scans, ['before', 'always', 'revision'].includes(fault) ? 4 : 2,
    'each bounded attempt collects outside classification and gated final reproof');
  assert.ok(attempts <= 2, 'at most one retry, including idempotent after-publication validation');
  assert.equal(f.executions, 0);
});

test('launch destination recovery classifier rejects generic failures absent older proof and registration conflicts', () => {
  const { isDestinationRecoveryClosure: classify } = require('../../electron/services/modpack-lifecycle/new-server-launch-closure.cjs');
  const job = { phase: 'failed', terminalAt: '2026-10-11T00:00:00.000Z', operationKind: 'install-new',
    outcome: { failureReason: 'destination-recovery', errorCode: 'RECOVERY_REQUIRED' } };
  const evidence = { olderRestriction: true };
  assert.equal(classify(job, evidence, 'absent'), true);
  for (const changed of [{ phase: 'recovery-required' }, { terminalAt: null }, { operationKind: 'update' },
    { outcome: { errorCode: 'RECOVERY_REQUIRED' } }, { outcome: { ...job.outcome, errorCode: 'COMMIT_FAILED' } }]) {
    assert.equal(classify({ ...job, ...changed }, evidence, 'absent'), false);
  }
  for (const changed of [{ olderRestriction: false }, { corrupt: true }, { record: closureRecord() }]) {
    assert.equal(classify(job, { ...evidence, ...changed }, 'absent'), false);
  }
  for (const registration of ['registered', 'conflict', undefined]) assert.equal(classify(job, evidence, registration), false);
});

test('launch queued full proof rejects incomplete scan global pending history registration cancellation and owner changes', async t => {
  const { reconcileNewServerLaunches } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
  for (const kind of ['incomplete', 'global', 'pending', 'history', 'registered', 'cancelled', 'epoch', 'corrupt']) {
    await t.test(kind, async t => {
      const f = await fixture(t); const { job, launch } = await seedLaunch(f);
      const registry = cleanRecoveryRegistry(); const scan = await registry.initialize();
      if (kind === 'incomplete') delete scan.blocks;
      if (kind === 'global') scan.globalBlock = true;
      if (kind === 'pending') scan.pendingTerminalPublications.push({ jobId: job.jobId });
      if (kind === 'corrupt') scan.corrupt.push({ jobId: job.jobId });
      registry.initialize = async () => { if (kind === 'epoch') f.owner.epoch = Symbol('replacement'); return scan; };
      if (kind === 'history') registry.loadHistory = async () => ({ ...closureRecord(), jobId: job.jobId });
      if (kind === 'cancelled') await f.store.requestCancellation(job.jobId);
      const work = reconcileNewServerLaunches({ operationStore: f.store, recoveryRegistry: registry, lifecycleService: f.service,
        launchOwner: f.owner, jobs: [job], launches: [launch], registrationState: () => kind === 'registered' ? 'registered' : 'absent' });
      if (kind === 'epoch') await assert.rejects(work, { code: 'PLAN_STALE' }); else await work;
      const current = await f.store.getNewServerLaunch(job.jobId, f.owner.epoch);
      assert.equal(current.binding.destinationDisposition, 'held', kind); assert.equal(f.executions, 0);
    });
  }
});

test('launch legacy unknown origin without path stays v1 deferred and never adds global denial', async t => {
  const f = await fixture(t);
  const job = await f.store.create({ jobId: 'unknown-legacy', operationKind: 'install-new', serverId: 'legacy-server' });
  const { reconcileNewServerLaunches } = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');
  const result = await reconcileNewServerLaunches({ operationStore: f.store, recoveryRegistry: cleanRecoveryRegistry(),
    lifecycleService: f.service, launchOwner: f.owner, jobs: [job], launches: [], registrationState: () => 'absent' });
  assert.equal((await f.store.get(job.jobId)).sequence, 0);
  assert.deepEqual(result.settlements[job.jobId], { disposition: null, settlementStatus: 'support-required',
    reason: 'legacy-origin-unproven', recoveryAvailable: false });
  assert.equal(result.globalBlock, false);
});

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
