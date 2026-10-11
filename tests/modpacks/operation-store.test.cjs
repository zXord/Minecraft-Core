const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const {
  JOB_PHASES,
  OperationStore,
  isLegalJobTransition,
  validatePublicJob
} = require('../../electron/services/modpack-lifecycle/operation-store.cjs');

const PHASES = [
  'queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'preflight',
  'snapshotting', 'staging', 'validating-candidate', 'committing', 'publishing', 'published', 'registering',
  'starting', 'validating-live', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed', 'cancelling',
  'cancelled', 'rolling-back', 'rolled-back', 'failed', 'recovery-required'
];

const MUTATION_TRANSITIONS = {
  queued: ['resolving', 'preflight', 'cancelling', 'failed'],
  resolving: ['downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'cancelling', 'failed'],
  downloading: ['verifying', 'cancelling', 'failed'],
  verifying: ['inspecting', 'cancelling', 'failed'],
  inspecting: ['planning', 'awaiting-user', 'cancelling', 'failed'],
  planning: ['awaiting-user', 'cancelling', 'failed'],
  'awaiting-user': ['preflight', 'cancelling', 'failed'],
  preflight: ['snapshotting', 'staging', 'cancelling', 'failed', 'recovery-required'],
  snapshotting: ['staging', 'cancelling', 'failed', 'recovery-required'],
  staging: ['validating-candidate', 'committing', 'cancelling', 'failed', 'recovery-required'],
  'validating-candidate': ['committing', 'cancelling', 'failed', 'recovery-required'],
  committing: ['publishing', 'starting', 'validating-live', 'rolling-back', 'recovery-required'],
  publishing: ['published', 'rolling-back', 'recovery-required'],
  published: ['registering', 'starting', 'validating-live', 'rolling-back', 'recovery-required'],
  registering: ['starting', 'validating-live', 'committed-healthy', 'rolling-back', 'recovery-required'],
  starting: ['validating-live', 'rolling-back', 'recovery-required'],
  'validating-live': ['committed-healthy', 'rolling-back', 'recovery-required'],
  'committed-healthy': ['cleanup', 'cleanup-pending'],
  cleanup: ['completed', 'cleanup-pending'],
  'cleanup-pending': ['cleanup', 'completed', 'recovery-required'],
  cancelling: ['cancelled', 'failed', 'recovery-required'],
  'rolling-back': ['rolled-back', 'recovery-required']
};

function fixture(t, { eventSink = () => {}, allowNewServerLaunchBindings = false, launchOwner = null } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-operation-store-'));
  let tempNumber = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    asyncFsApi: fs.promises,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      async moveWriteThroughAsync(source, destination) { await fs.promises.rename(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      async replaceFileWriteThroughAsync(source, destination) { await fs.promises.rename(source, destination); },
      flushDirectory() {},
      async flushDirectoryAsync() {}
    },
    allowedRoots: [userDataPath],
    tempNameFactory: () => `operation-${++tempNumber}`
  });
  let now = Date.parse('2026-08-02T00:00:00.000Z');
  let id = 0;
  const dependencies = {
    userDataPath,
    fsApi: fs,
    durableFs,
    clock: () => new Date(now += 1000),
    randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    eventSink,
    allowNewServerLaunchBindings,
    launchOwner
  };
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return { dependencies, store: new OperationStore(dependencies), userDataPath };
}

function job(overrides = {}) {
  return {
    jobId: 'job-0001',
    operationKind: 'install-existing',
    serverId: 'server-0001',
    planFingerprint: 'a'.repeat(64),
    ...overrides
  };
}

const PUBLIC_V1_KEYS = ['type', 'schemaVersion', 'sequence', 'jobId', 'operationKind', 'serverId',
  'planFingerprint', 'phase', 'swapStep', 'progress', 'cancellationRequested', 'createdAt', 'updatedAt',
  'terminalAt', 'outcome', 'events'];
function ownerFixture() {
  const owner = {
    epoch: 'test-owner', lease: {}, state: 'starting',
    assertCurrent(epoch, { allowClosing = false, startupOnly = false } = {}) {
      if (epoch !== this.epoch || !this.lease || this.state === 'disposed' ||
          (this.state === 'closing' && !allowClosing) || (startupOnly && this.state !== 'starting')) {
        throw Object.assign(new Error('Owner changed'), { code: 'PLAN_STALE' });
      }
    }
  };
  return owner;
}
function binding(overrides = {}) {
  return {
    planId: 'plan-launch-v1-00000000-0000-4000-8000-000000000001', planFingerprint: 'a'.repeat(64),
    instanceId: 'server-0001', targetPath: 'c:\\private\\new-server', capturedReservation: { kind: 'absent' },
    displayName: 'New server', destinationDisposition: 'held', ...overrides
  };
}
function launchJob(overrides = {}) { return job({ operationKind: 'install-new', launchBinding: binding(), ...overrides }); }
function recordFile(store, jobId = 'job-0001') { return path.join(store.operationsPath, `${jobId}.json`); }
function rewriteRecord(store, jobId, mutate) {
  const value = JSON.parse(fs.readFileSync(recordFile(store, jobId), 'utf8'));
  mutate(value);
  const payload = Object.fromEntries([...PUBLIC_V1_KEYS, ...(value.schemaVersion === 2 ? ['launchBinding'] : [])]
    .map(key => [key, value[key]]));
  value.checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  fs.writeFileSync(recordFile(store, jobId), `${JSON.stringify(value, null, 2)}\n`);
}

test('v2 launch storage preserves public v1 shape', async t => {
  const launchOwner = ownerFixture();
  const { store, dependencies } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  await store.initialize();
  const suppliedBinding = binding();
  const publicJob = await store.create(launchJob({ launchBinding: suppliedBinding }), launchOwner.epoch);
  const rawStored = JSON.parse(fs.readFileSync(recordFile(store), 'utf8'));
  const privateRead = await store.getNewServerLaunch(publicJob.jobId, launchOwner.epoch);
  assert.equal(publicJob.schemaVersion, 1);
  assert.equal(rawStored.schemaVersion, 2);
  assert.deepEqual(privateRead.binding, suppliedBinding);
  assert.deepEqual(Object.keys(publicJob).sort(), PUBLIC_V1_KEYS.slice().sort());
  assert.throws(() => validatePublicJob(rawStored));
  assert.equal(JSON.stringify(publicJob).includes('launchBinding'), false);
  assert.deepEqual(validatePublicJob(publicJob), publicJob);
  assert.equal(privateRead.recordRevision.sha256, crypto.createHash('sha256').update(fs.readFileSync(recordFile(store))).digest('hex'));
  const reloaded = new OperationStore(dependencies);
  assert.deepEqual(await reloaded.initialize(), [publicJob]);
  assert.deepEqual(await reloaded.get(publicJob.jobId), publicJob);
  const readOnlyV2 = new OperationStore({ ...dependencies, allowNewServerLaunchBindings: false, launchOwner: null });
  const bytesBeforeReload = fs.readFileSync(recordFile(store));
  assert.deepEqual(await readOnlyV2.initialize(), [publicJob]);
  assert.deepEqual(await readOnlyV2.get(publicJob.jobId), publicJob);
  assert.deepEqual(fs.readFileSync(recordFile(store)), bytesBeforeReload);
  await assert.rejects(readOnlyV2.getNewServerLaunch(publicJob.jobId, launchOwner.epoch), error => error.code === 'PLAN_STALE');
});

test('public v1 storage remains unchanged and launch binding creation is opt-in', async t => {
  const { store, dependencies } = fixture(t);
  await store.initialize();
  await assert.rejects(store.create(launchJob()), error => error.code === 'INVALID_REQUEST');
  const created = await store.create(job());
  const before = fs.readFileSync(recordFile(store));
  const raw = JSON.parse(before);
  assert.equal(raw.schemaVersion, 1);
  assert.deepEqual(Object.keys(raw), [...PUBLIC_V1_KEYS, 'checksum']);
  assert.deepEqual(await new OperationStore(dependencies).initialize(), [created]);
  assert.deepEqual(fs.readFileSync(recordFile(store)), before);
});

test('launch binding validates closed canonical identity without target filesystem access', async t => {
  const launchOwner = ownerFixture();
  const { store } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  await store.initialize();
  const malformed = [
    { extra: true }, { planId: 'plan-old' }, { planId: 'plan-launch-v1-00000000-0000-1000-8000-000000000001' },
    { planFingerprint: 'A'.repeat(64) }, { planFingerprint: 'b'.repeat(64) }, { instanceId: 'other' },
    { instanceId: '../bad' }, { targetPath: 'C:\\' }, { targetPath: 'C:\\private\\..\\new-server' },
    { destinationDisposition: 'released' }, { destinationDisposition: 'unknown' }, { displayName: 'CON' },
    { displayName: 'Bad\nName' }, { displayName: 'Bad\u0085Name' }, { capturedReservation: { kind: 'existing-unmanaged-directory' } },
    { capturedReservation: { kind: 'absent', extra: true } },
    { capturedReservation: { kind: 'empty-directory' } },
    { capturedReservation: { kind: 'empty-directory', identity: { dev: '1', ino: '2' } } },
    { capturedReservation: { kind: 'empty-directory', identity: { dev: 1, ino: '2', birthtimeNs: '3' } } },
    { capturedReservation: { kind: 'empty-directory', identity: { dev: '01', ino: '2', birthtimeNs: '3' } } },
    { capturedReservation: { kind: 'empty-directory', identity: { dev: '1', ino: '-2', birthtimeNs: '3' } } },
    { capturedReservation: { kind: 'empty-directory', identity: { dev: '1', ino: '2', birthtimeNs: '-0' } } },
    { capturedReservation: { kind: 'empty-directory', identity: { dev: '1', ino: '2', birthtimeNs: '3', extra: '4' } } }
  ];
  for (const patch of malformed) {
    await assert.rejects(store.create(launchJob({ launchBinding: binding(patch) }), launchOwner.epoch), error => error.code === 'INVALID_REQUEST');
  }
  for (const field of ['targetPath', 'capturedReservation']) {
    const accessor = binding();
    Object.defineProperty(accessor, field, { enumerable: true, get() { throw new Error('must not invoke accessor'); } });
    await assert.rejects(store.create(launchJob({ launchBinding: accessor }), launchOwner.epoch), error => error.code === 'INVALID_REQUEST');
  }
  const symbolic = binding(); symbolic[Symbol('private')] = true;
  await assert.rejects(store.create(launchJob({ launchBinding: symbolic }), launchOwner.epoch), error => error.code === 'INVALID_REQUEST');
  for (const location of ['capture', 'identity']) {
    const capturedReservation = { kind: 'empty-directory', identity: { dev: '1', ino: '2', birthtimeNs: '3' } };
    const object = location === 'capture' ? capturedReservation : capturedReservation.identity;
    object[Symbol('hidden')] = true;
    await assert.rejects(store.create(launchJob({ launchBinding: binding({ capturedReservation }) }), launchOwner.epoch), error => error.code === 'INVALID_REQUEST');
    delete object[Object.getOwnPropertySymbols(object)[0]];
    Object.defineProperty(object, location === 'capture' ? 'kind' : 'dev', { enumerable: true,
      get() { throw new Error('nested accessor must not execute'); } });
    await assert.rejects(store.create(launchJob({ launchBinding: binding({ capturedReservation }) }), launchOwner.epoch), error => error.code === 'INVALID_REQUEST');
  }
  await assert.rejects(store.create(launchJob({ operationKind: 'verify' }), launchOwner.epoch), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(store.create(launchJob(), 'wrong-owner'), error => error.code === 'PLAN_STALE');
  const capturedReservation = { kind: 'empty-directory', identity: { dev: '0', ino: '2', birthtimeNs: '-3' } };
  await store.create(launchJob({ launchBinding: binding({ targetPath: 'C:/Private/New-Server/', displayName: ' New server ', capturedReservation }) }), launchOwner.epoch);
  const exact = await store.getNewServerLaunch('job-0001', launchOwner.epoch);
  assert.equal(exact.binding.targetPath, 'c:\\private\\new-server');
  assert.equal(exact.binding.displayName, 'New server');
  assert.deepEqual(exact.binding.capturedReservation, capturedReservation);
  rewriteRecord(store, 'job-0001', value => { value.launchBinding.targetPath = 'C:\\private\\new-server'; });
  await assert.rejects(store.get('job-0001'), error => error.code === 'RECOVERY_REQUIRED');
  rewriteRecord(store, 'job-0001', value => { value.launchBinding.targetPath = 'c:\\private\\new-server'; });
  const raw = JSON.parse(fs.readFileSync(recordFile(store))); raw.checksum = 'f'.repeat(64);
  fs.writeFileSync(recordFile(store), JSON.stringify(raw));
  await assert.rejects(store.get('job-0001'), error => error.code === 'RECOVERY_REQUIRED');
});

test('launch create is tracked through post-publication failure', async t => {
  const launchOwner = ownerFixture();
  const { dependencies } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; });
  const begin = new Promise(resolve => { started = resolve; });
  const store = new OperationStore({ ...dependencies, durableFs: { ...dependencies.durableFs,
    async writeJsonAtomicAsync(...args) {
      started(); await gate;
      await dependencies.durableFs.writeJsonAtomicAsync(...args);
      throw new Error('transport response lost after publication');
    }
  } });
  await store.initialize();
  const witnesses = [];
  const creating = store.create(launchJob(), launchOwner.epoch, { onPublicationAttempt(value) { witnesses.push(value); } });
  const rejected = assert.rejects(creating, error => error.code === 'COMMIT_FAILED');
  await begin;
  assert.deepEqual(store.getLaunchPublicationState(launchOwner.epoch), { generation: 1, pending: true });
  assert.equal(witnesses.length, 1);
  assert.equal(Object.isFrozen(witnesses[0]), true);
  assert.equal(Object.isFrozen(witnesses[0].binding.capturedReservation), true);
  assert.equal(witnesses[0].expectedTargetSha256, null);
  let rereadDone = false;
  const reread = store.getNewServerLaunch('job-0001', launchOwner.epoch).then(value => { rereadDone = true; return value; });
  await Promise.resolve();
  assert.equal(rereadDone, false);
  await assert.rejects(store.findNewServerLaunch(binding(), launchOwner.epoch), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(store.listNewServerLaunchBindings(launchOwner.epoch), error => error.code === 'PLAN_STALE');
  release(); await rejected;
  assert.deepEqual(store.getLaunchPublicationState(launchOwner.epoch), { generation: 2, pending: false });
  assert.equal(store.activePublications.size, 0);
  assert.equal(store.records.size, 0);
  const found = await reread;
  assert.deepEqual(found.job, witnesses[0].job);
  assert.deepEqual(found.binding, witnesses[0].binding);
  assert.equal(found.job.sequence, 0);
  const credential = { planId: binding().planId, planFingerprint: binding().planFingerprint };
  assert.deepEqual(await store.findNewServerLaunch(credential, launchOwner.epoch), found);
  await assert.rejects(store.create(launchJob(), launchOwner.epoch, { onPublicationAttempt(value) { witnesses.push(value); } }), error => error.code === 'TARGET_EXISTS');
  await assert.rejects(store.create(launchJob({ jobId: 'different', launchBinding: binding({ destinationDisposition: 'released' }) }), launchOwner.epoch,
    { onPublicationAttempt(value) { witnesses.push(value); } }), error => error.code === 'INVALID_REQUEST');
  assert.equal(witnesses.length, 1);
});

test('launch create before-publication failure and owner loss never imply adoption', async t => {
  const launchOwner = ownerFixture();
  const { dependencies } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  const store = new OperationStore({ ...dependencies, durableFs: { ...dependencies.durableFs,
    async writeJsonAtomicAsync() { throw new Error('before publication'); }
  } });
  await store.initialize();
  const witnesses = [];
  await assert.rejects(store.create(launchJob(), launchOwner.epoch, { onPublicationAttempt: value => witnesses.push(value) }), error => error.code === 'COMMIT_FAILED');
  assert.equal(witnesses.length, 1);
  assert.equal(await store.getNewServerLaunch('job-0001', launchOwner.epoch), null);
  assert.deepEqual(store.getLaunchPublicationState(launchOwner.epoch), { generation: 2, pending: false });
  launchOwner.lease = null;
  await assert.rejects(store.create(launchJob(), launchOwner.epoch, { onPublicationAttempt: value => witnesses.push(value) }), error => error.code === 'PLAN_STALE');
  assert.equal(witnesses.length, 1);
});

test('launch lookup validates complete durable catalogue without resetting index', async t => {
  const launchOwner = ownerFixture();
  const { store } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  await store.initialize(); await store.create(launchJob(), launchOwner.epoch); await store.create(job({ jobId: 'legacy' }));
  const records = store.records; const content = [...records];
  rewriteRecord(store, 'job-0001', value => { value.launchBinding.destinationDisposition = 'released'; value.sequence += 1; });
  const credential = { planId: binding().planId, planFingerprint: binding().planFingerprint };
  assert.equal((await store.findNewServerLaunch(credential, launchOwner.epoch)).binding.destinationDisposition, 'released');
  assert.equal((await store.listNewServerLaunchBindings(launchOwner.epoch)).length, 1);
  assert.equal(store.records, records); assert.deepEqual([...records], content);
  await assert.rejects(store.findNewServerLaunch({ ...credential, planFingerprint: 'b'.repeat(64) }, launchOwner.epoch), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(store.getNewServerLaunch('legacy', launchOwner.epoch), error => error.code === 'RECOVERY_REQUIRED');
  fs.writeFileSync(recordFile(store, 'legacy'), '{}');
  await assert.rejects(store.findNewServerLaunch(credential, launchOwner.epoch), error => error.code === 'RECOVERY_REQUIRED');
  await assert.rejects(store.listNewServerLaunchBindings(launchOwner.epoch), error => error.code === 'RECOVERY_REQUIRED');
  assert.equal(store.records, records); assert.deepEqual([...records], content);
});

test('launch duplicate associations and changed generation never certify absence', async t => {
  const launchOwner = ownerFixture();
  const { store, dependencies } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  await store.initialize(); await store.create(launchJob(), launchOwner.epoch);
  const secondBinding = binding({ planId: 'plan-launch-v1-00000000-0000-4000-8000-000000000002', instanceId: 'server-0002' });
  await assert.rejects(store.create(launchJob({ jobId: 'collision' }), launchOwner.epoch), error => error.code === 'TARGET_EXISTS');
  await store.create(launchJob({ jobId: 'job-second', serverId: 'server-0002', launchBinding: secondBinding }), launchOwner.epoch);
  for (const duplicate of ['plan', 'incarnation']) {
    rewriteRecord(store, 'job-second', value => {
      value.launchBinding.planId = duplicate === 'plan' ? binding().planId : secondBinding.planId;
      value.launchBinding.planFingerprint = value.planFingerprint = 'b'.repeat(64);
      value.launchBinding.instanceId = value.serverId = duplicate === 'incarnation' ? 'server-0001' : 'server-0002';
    });
    await assert.rejects(store.listNewServerLaunchBindings(launchOwner.epoch), error => error.code === 'RECOVERY_REQUIRED');
  }
  rewriteRecord(store, 'job-second', value => { value.launchBinding.instanceId = value.serverId = 'server-0002'; });
  let startedWrite; let publication;
  const racing = new OperationStore({ ...dependencies, durableFs: { ...dependencies.durableFs,
    readFileBounded(...args) {
      const bytes = dependencies.durableFs.readFileBounded(...args);
      if (startedWrite) { const work = startedWrite; startedWrite = null; work(); }
      return bytes;
    }
  } });
  await racing.initialize();
  startedWrite = () => { publication = racing.create(job({ jobId: 'racing-legacy' })); };
  await assert.rejects(racing.findNewServerLaunch({ planId: 'plan-launch-v1-00000000-0000-4000-8000-000000000099', planFingerprint: 'a'.repeat(64) }, launchOwner.epoch), error => error.code === 'PLAN_STALE');
  await publication;
  startedWrite = () => { launchOwner.lease = null; };
  await assert.rejects(racing.listNewServerLaunchBindings(launchOwner.epoch), error => error.code === 'PLAN_STALE');
});

test('launch disposition uses sequence and exact byte hash CAS', async t => {
  const launchOwner = ownerFixture();
  const { store } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  await store.initialize(); await store.create(launchJob(), launchOwner.epoch);
  let launch = await store.getNewServerLaunch('job-0001', launchOwner.epoch);
  const settle = (revision, nextDisposition = 'released', extra = {}) => store.settleNewServerDestination('job-0001', {
    expectedInstanceId: 'server-0001', expectedRecordRevision: revision, nextDisposition, ...extra
  }, launchOwner.epoch);
  const before = fs.readFileSync(recordFile(store));
  await assert.rejects(settle({ ...launch.recordRevision, sequence: 1 }), error => error.code === 'PLAN_STALE');
  await assert.rejects(settle({ ...launch.recordRevision, sha256: 'f'.repeat(64) }), error => error.code === 'PLAN_STALE');
  await assert.rejects(settle(launch.recordRevision, 'released', { expectedInstanceId: 'old-incarnation' }), error => error.code === 'PLAN_STALE');
  assert.deepEqual(fs.readFileSync(recordFile(store)), before);
  const progress = { percent: 10, message: 'Preparing', currentItem: null };
  await store.updateProgress('job-0001', { expectedPhase: 'queued', progress });
  await store.appendEvent('job-0001', { channel: 'log', message: 'Preparing' });
  await store.requestCancellation('job-0001');
  launch = await store.getNewServerLaunch('job-0001', launchOwner.epoch);
  assert.deepEqual(launch.binding, binding());
  assert.equal(JSON.parse(fs.readFileSync(recordFile(store))).schemaVersion, 2);
  const released = await settle(launch.recordRevision);
  assert.equal(released.sequence, launch.job.sequence + 1);
  const releasedBytes = fs.readFileSync(recordFile(store));
  assert.deepEqual(await settle(launch.recordRevision), released);
  assert.deepEqual(fs.readFileSync(recordFile(store)), releasedBytes);
  await assert.rejects(settle(launch.recordRevision, 'consumed'), error => error.code === 'RECOVERY_REQUIRED');
  await assert.rejects(settle(launch.recordRevision, 'held'), error => error.code === 'INVALID_REQUEST');
});

test('launch disposition terminal update is atomic and requires exact idempotent terminal pair', async t => {
  const launchOwner = ownerFixture();
  const { store } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  await store.initialize(); await store.create(launchJob(), launchOwner.epoch);
  const launch = await store.getNewServerLaunch('job-0001', launchOwner.epoch);
  const terminalUpdate = { expectedPhase: 'queued', nextPhase: 'failed', patch: {
    outcome: { status: 'failed', message: 'Stopped without mutation' },
    progress: { percent: 100, message: 'Stopped', currentItem: null }
  } };
  const request = { expectedInstanceId: 'server-0001', expectedRecordRevision: launch.recordRevision, nextDisposition: 'released', terminalUpdate };
  const terminal = await store.settleNewServerDestination('job-0001', request, launchOwner.epoch);
  assert.equal(terminal.phase, 'failed'); assert.equal(terminal.sequence, 1);
  assert.equal((await store.getNewServerLaunch('job-0001', launchOwner.epoch)).binding.destinationDisposition, 'released');
  assert.deepEqual(await store.settleNewServerDestination('job-0001', request, launchOwner.epoch), terminal);
  await assert.rejects(store.settleNewServerDestination('job-0001', { ...request, terminalUpdate: {
    ...terminalUpdate, patch: { ...terminalUpdate.patch, outcome: { status: 'failed', message: 'Other result' } }
  } }, launchOwner.epoch), error => error.code === 'RECOVERY_REQUIRED');
});

test('queued closure atomically fails and releases only under startup owner', async t => {
  const launchOwner = ownerFixture();
  const { store } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  await store.initialize(); await store.create(launchJob(), launchOwner.epoch); await store.create(job({ jobId: 'legacy', operationKind: 'import-files-only-new' }));
  for (const jobId of ['job-0001', 'legacy']) {
    const current = await store.get(jobId);
    const recordRevision = { sequence: current.sequence, sha256: crypto.createHash('sha256').update(fs.readFileSync(recordFile(store, jobId))).digest('hex') };
    const request = { expectedInstanceId: 'server-0001', expectedRecordRevision: recordRevision };
    launchOwner.state = 'ready';
    await assert.rejects(store.closeInterruptedQueued(jobId, request, launchOwner.epoch), error => error.code === 'PLAN_STALE');
    launchOwner.state = 'starting';
    await assert.rejects(store.closeInterruptedQueued(jobId, { ...request, expectedInstanceId: 'other' }, launchOwner.epoch), error => error.code === 'PLAN_STALE');
    await assert.rejects(store.closeInterruptedQueued(jobId, { ...request, expectedRecordRevision: { ...recordRevision, sha256: 'f'.repeat(64) } }, launchOwner.epoch), error => error.code === 'PLAN_STALE');
    const closed = await store.closeInterruptedQueued(jobId, request, launchOwner.epoch);
    assert.equal(closed.phase, 'failed'); assert.equal(closed.sequence, 1);
    assert.equal(closed.outcome.errorCode, 'COMMIT_FAILED'); assert.deepEqual(closed.outcome.actions, []);
    assert.equal(closed.progress.percent, 100);
    assert.equal(JSON.parse(fs.readFileSync(recordFile(store, jobId))).schemaVersion, jobId === 'legacy' ? 1 : 2);
    if (jobId !== 'legacy') assert.equal((await store.getNewServerLaunch(jobId, launchOwner.epoch)).binding.destinationDisposition, 'released');
    const bytes = fs.readFileSync(recordFile(store, jobId));
    assert.deepEqual(await store.closeInterruptedQueued(jobId, request, launchOwner.epoch), closed);
    assert.deepEqual(fs.readFileSync(recordFile(store, jobId)), bytes);
  }
  for (const phase of ['cancelling', 'preflight']) {
    const jobId = `job-${phase}`;
    await store.create(job({ jobId, operationKind: 'install-new' }));
    if (phase === 'cancelling') await store.requestCancellation(jobId);
    else await store.transition(jobId, { expectedPhase: 'queued', nextPhase: phase, patch: {} });
    const current = await store.get(jobId);
    const revision = { sequence: current.sequence, sha256: crypto.createHash('sha256').update(fs.readFileSync(recordFile(store, jobId))).digest('hex') };
    await assert.rejects(store.closeInterruptedQueued(jobId, { expectedInstanceId: 'server-0001', expectedRecordRevision: revision }, launchOwner.epoch), error => error.code === 'PLAN_STALE');
  }
});

test('queued closure publication faults require exact reread without target action replay', async t => {
  for (const afterPublication of [false, true]) {
    const launchOwner = ownerFixture();
    const { dependencies } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
    let fail = false;
    const store = new OperationStore({ ...dependencies, durableFs: { ...dependencies.durableFs,
      async writeJsonAtomicAsync(...args) {
        if (!fail || afterPublication) await dependencies.durableFs.writeJsonAtomicAsync(...args);
        if (fail) throw new Error('publication fault');
      }
    } });
    await store.initialize(); await store.create(launchJob(), launchOwner.epoch);
    const launch = await store.getNewServerLaunch('job-0001', launchOwner.epoch);
    const request = { expectedInstanceId: 'server-0001', expectedRecordRevision: launch.recordRevision };
    fail = true;
    await assert.rejects(store.closeInterruptedQueued('job-0001', request, launchOwner.epoch), error => error.code === 'COMMIT_FAILED');
    const reread = await store.getNewServerLaunch('job-0001', launchOwner.epoch);
    assert.equal(reread.job.phase, afterPublication ? 'failed' : 'queued');
    assert.equal(reread.binding.destinationDisposition, afterPublication ? 'released' : 'held');
    assert.equal(store.getLaunchPublicationState(launchOwner.epoch).pending, false);
    if (afterPublication) assert.deepEqual(await store.closeInterruptedQueued('job-0001', request, launchOwner.epoch), reread.job);
  }
});

test('launch exact reread retries only its own authenticated publication race', async t => {
  const launchOwner = ownerFixture();
  const { dependencies } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  let race = null; let publication;
  const store = new OperationStore({ ...dependencies, durableFs: { ...dependencies.durableFs,
    readFileBounded(...args) {
      if (race) {
        const work = race; race = null; work();
        throw Object.assign(new Error('atomic replacement changed bounded-read identity'), { code: 'COMMIT_FAILED' });
      }
      return dependencies.durableFs.readFileBounded(...args);
    }
  } });
  await store.initialize(); await store.create(launchJob(), launchOwner.epoch);
  race = () => { publication = store.updateProgress('job-0001', { expectedPhase: 'queued',
    progress: { percent: 5, message: 'Preparing', currentItem: null } }); };
  let observed;
  try { observed = await store.getNewServerLaunch('job-0001', launchOwner.epoch); }
  finally { await publication; }
  assert.equal(observed.job.sequence, 1);
  assert.equal(observed.job.progress.percent, 5);
  race = () => {};
  await assert.rejects(store.getNewServerLaunch('job-0001', launchOwner.epoch), error => error.code === 'RECOVERY_REQUIRED');
});

test('launch publication finalization clears tracking after directory revalidation or owner loss', async t => {
  for (const failure of ['directory', 'owner']) {
    const launchOwner = ownerFixture();
    const { dependencies } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
    let failNextStat = false;
    const fsApi = { ...fs, lstatSync(candidate, ...args) {
      assert.equal(candidate.startsWith(dependencies.userDataPath), true, 'no target filesystem access');
      if (failNextStat) { failNextStat = false; throw new Error('directory revalidation failed'); }
      return fs.lstatSync(candidate, ...args);
    } };
    const store = new OperationStore({ ...dependencies, fsApi, durableFs: { ...dependencies.durableFs,
      async writeJsonAtomicAsync(...args) {
        await dependencies.durableFs.writeJsonAtomicAsync(...args);
        if (failure === 'directory') failNextStat = true;
        else launchOwner.lease = null;
      }
    } });
    await store.initialize();
    const witnesses = [];
    await assert.rejects(store.create(launchJob(), launchOwner.epoch, { onPublicationAttempt: value => witnesses.push(value) }),
      error => error.code === (failure === 'directory' ? 'COMMIT_FAILED' : 'PLAN_STALE'));
    assert.equal(store.activePublications.size, 0); assert.equal(store.records.size, 0);
    assert.equal(store.publicationGeneration, 2);
    assert.equal(witnesses.length, 1);
    if (failure === 'owner') {
      await assert.rejects(store.getNewServerLaunch('job-0001', launchOwner.epoch), error => error.code === 'PLAN_STALE');
      launchOwner.lease = {};
    }
    assert.deepEqual((await store.getNewServerLaunch('job-0001', launchOwner.epoch)).job, witnesses[0].job);
  }
});

test('launch disposition guards exact bytes, consumed contradiction, closing owner and terminal mutations', async t => {
  const launchOwner = ownerFixture();
  const { store } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner });
  await store.initialize(); await store.create(launchJob({ operationKind: 'import-files-only-new' }), launchOwner.epoch);
  let launch = await store.getNewServerLaunch('job-0001', launchOwner.epoch);
  const request = { expectedInstanceId: 'server-0001', expectedRecordRevision: launch.recordRevision, nextDisposition: 'consumed' };
  const original = fs.readFileSync(recordFile(store), 'utf8');
  fs.writeFileSync(recordFile(store), `${original}\n`);
  await assert.rejects(store.settleNewServerDestination('job-0001', request, launchOwner.epoch), error => error.code === 'PLAN_STALE');
  await store.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'preflight', patch: {} });
  await store.transition('job-0001', { expectedPhase: 'preflight', nextPhase: 'recovery-required', patch: { outcome: { status: 'recovery-required' } } });
  await store.reconcileRecovery('job-0001', { nextPhase: 'failed', patch: { outcome: { status: 'failed' }, progress: { percent: 100, message: 'Recovered', currentItem: null } } });
  launch = await store.getNewServerLaunch('job-0001', launchOwner.epoch);
  assert.deepEqual(launch.binding, binding());
  launchOwner.state = 'closing';
  await assert.rejects(store.listNewServerLaunchBindings(launchOwner.epoch), error => error.code === 'PLAN_STALE');
  await assert.rejects(store.create(launchJob({ jobId: 'fresh' }), launchOwner.epoch), error => error.code === 'PLAN_STALE');
  await store.settleNewServerDestination('job-0001', { ...request, expectedRecordRevision: launch.recordRevision }, launchOwner.epoch);
  const consumed = await store.getNewServerLaunch('job-0001', launchOwner.epoch);
  assert.equal(consumed.binding.destinationDisposition, 'consumed');
  await assert.rejects(store.settleNewServerDestination('job-0001', { ...request, nextDisposition: 'released', expectedRecordRevision: consumed.recordRevision }, launchOwner.epoch), error => error.code === 'RECOVERY_REQUIRED');
  const serialized = JSON.stringify([await store.get('job-0001'), await store.initialize()]);
  assert.doesNotMatch(serialized, /launchBinding|targetPath|capturedReservation|recordRevision|epoch|checksum/);
});

test('launch public returns, persisted events and native notifications project no binding', async t => {
  const { OperationEventStore } = require('../../electron/services/modpack-lifecycle/operation-event-store.cjs');
  const launchOwner = ownerFixture(); const emitted = []; const notifications = [];
  const { store } = fixture(t, { allowNewServerLaunchBindings: true, launchOwner, eventSink: event => emitted.push(event) });
  const events = new OperationEventStore({ operationStore: store,
    nativeNotificationBridge: { publishJobEvent(value) { notifications.push(value); } } });
  const outputs = [await events.initialize(), await events.create(launchJob(), launchOwner.epoch)];
  outputs.push(await events.appendEvent('job-0001', { channel: 'log', message: 'Preparing new server' }));
  outputs.push(await events.get('job-0001'), await events.load('job-0001'));
  const launch = await events.getNewServerLaunch('job-0001', launchOwner.epoch);
  assert.equal(notifications.length, 2);
  outputs.push(await events.closeInterruptedQueued('job-0001', { expectedInstanceId: 'server-0001', expectedRecordRevision: launch.recordRevision }, launchOwner.epoch));
  assert.equal(notifications.length, 3);
  assert.doesNotMatch(JSON.stringify([outputs, emitted, notifications]), /launchBinding|targetPath|capturedReservation|recordRevision|epoch|checksum|private/);
  for (const output of outputs.filter(value => !Array.isArray(value))) assert.deepEqual(Object.keys(output).sort(), PUBLIC_V1_KEYS.slice().sort());
});

test('durable swap role tuples stay associated with one operation through reload and recovery reconciliation', async t => {
  // Catches event loss when recovery rebuilds a terminal outcome and cross-job association.
  const { dependencies, store } = fixture(t);
  await store.initialize();
  await store.create(job());
  await store.create(job({ jobId: 'job-other' }));
  for (const [from, to] of [['queued', 'preflight'], ['preflight', 'staging'], ['staging', 'committing']]) {
    await store.transition('job-0001', { expectedPhase: from, nextPhase: to, patch: {} });
  }
  const entries = [
    { channel: 'log', message: 'Existing swap primary failure (candidate-promotion; durable-move; sharing-violation; handle-rename).', details: {
      errorCode: 'COMMIT_FAILED', failureRole: 'primary', swapCallsite: 'candidate-promotion',
      failure: { stage: 'durable-move', category: 'sharing-violation', boundary: 'handle-rename' }
    } },
    { channel: 'log', message: 'Existing swap fallback failure (rollback-settlement; native diagnostic unavailable).', details: {
      errorCode: 'RECOVERY_REQUIRED', failureRole: 'fallback', swapCallsite: 'rollback-settlement'
    } }
  ];
  await store.appendEvent('job-0001', entries[0]);
  await store.transition('job-0001', { expectedPhase: 'committing', nextPhase: 'rolling-back', patch: {} });
  await store.appendEvent('job-0001', entries[1]);
  const settled = await store.transition('job-0001', { expectedPhase: 'rolling-back', nextPhase: 'recovery-required', patch: {
    outcome: { status: 'recovery-required', message: 'Reviewed recovery is required', errorCode: 'RECOVERY_REQUIRED' }
  } });
  const reloaded = new OperationStore(dependencies);
  await reloaded.initialize();
  assert.deepEqual((await reloaded.get('job-0001')).events, settled.events);
  assert.deepEqual(settled.events.map(event => ({ channel: event.channel, message: event.message, details: event.details })), entries);
  assert.deepEqual(settled.events.map(event => [event.jobId, event.sequence, event.phase]), [
    ['job-0001', 4, 'committing'], ['job-0001', 6, 'rolling-back']
  ]);
  const reconciled = await reloaded.reconcileRecovery('job-0001', { nextPhase: 'rolled-back', patch: {
    progress: { percent: 100, message: 'Recovery completed safely', currentItem: null },
    outcome: { status: 'rolled-back', message: 'The interrupted operation was recovered' }
  } });
  assert.deepEqual(reconciled.events, settled.events);
  assert.equal((await reloaded.get('job-other')).events.length, 0);
  assert.equal(Object.hasOwn(reconciled.outcome, 'failureRole'), false);
  assert.equal(Object.hasOwn(reconciled, 'existingSwapCallsite'), false);
  const finalReload = new OperationStore(dependencies);
  await finalReload.initialize();
  assert.deepEqual((await finalReload.get('job-0001')).events, settled.events);
});

test('the complete top-level phase graph rejects every unapproved mutation transition', () => {
  assert.deepEqual(JOB_PHASES, PHASES);
  for (const from of PHASES) {
    for (const to of PHASES) {
      const expected = (MUTATION_TRANSITIONS[from] || []).includes(to);
      assert.equal(
        isLegalJobTransition(from, to, { operationKind: 'install-existing' }),
        expected,
        `${from} -> ${to}`
      );
    }
  }
  assert.equal(isLegalJobTransition('queued', 'verifying', { operationKind: 'verify' }), true);
  assert.equal(isLegalJobTransition('verifying', 'completed', { operationKind: 'verify' }), true);
  assert.equal(isLegalJobTransition('verifying', 'completed', { operationKind: 'repair' }), false);
  assert.equal(isLegalJobTransition('rolling-back', 'failed', { operationKind: 'install-new' }), true);
  assert.equal(isLegalJobTransition('rolling-back', 'failed', { operationKind: 'import-files-only-new' }), true);
  assert.equal(isLegalJobTransition('rolling-back', 'failed', { operationKind: 'update' }), false);
  assert.equal(isLegalJobTransition('unknown', 'failed', { operationKind: 'verify' }), false);
});

test('automatically generated operation IDs use the compact transaction namespace', async (t) => {
  const { store, userDataPath } = fixture(t);
  await store.initialize();

  const created = await store.create({
    operationKind: 'install-new',
    serverId: 'server-compact-path',
    planFingerprint: 'a'.repeat(64)
  });

  assert.match(created.jobId, /^op2-[0-9a-f]{32}$/u);
  assert.equal(
    fs.existsSync(path.join(userDataPath, 'modpack-lifecycle', 'operations', `${created.jobId}.json`)),
    true
  );
});

test('jobs reload from durable storage with monotonic compare-and-transition sequence', async (t) => {
  const { dependencies, store } = fixture(t);
  await store.initialize();
  const created = await store.create(job());
  assert.equal(created.sequence, 0);
  assert.equal(created.phase, 'queued');
  assert.equal(Object.isFrozen(created), true);

  const transitioned = await store.transition('job-0001', {
    expectedPhase: 'queued',
    nextPhase: 'preflight',
    patch: {
      progress: { percent: 10, message: 'Checking the reviewed plan', currentItem: null },
      swapStep: null
    }
  });
  assert.equal(transitioned.sequence, 1);
  assert.equal(transitioned.phase, 'preflight');
  assert.equal(transitioned.progress.percent, 10);

  const reloadedStore = new OperationStore(dependencies);
  await reloadedStore.initialize();
  const reloaded = await reloadedStore.get('job-0001');
  assert.deepEqual(reloaded, transitioned);
  await assert.rejects(
    reloadedStore.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'resolving', patch: {} }),
    error => error.code === 'PLAN_STALE'
  );
  const staged = await reloadedStore.transition('job-0001', {
    expectedPhase: 'preflight', nextPhase: 'staging', patch: { swapStep: 'candidate-prepared' }
  });
  assert.equal(staged.sequence, 2);
  assert.equal(staged.swapStep, 'candidate-prepared');
});

test('job creation and transitions require asynchronous durable JSON publication', async t => {
  const { dependencies } = fixture(t);
  let asyncWrites = 0;
  const durableFs = {
    ...dependencies.durableFs,
    writeJsonAtomic() { throw new Error('synchronous durable JSON write must not run'); },
    async writeJsonAtomicAsync(...args) {
      asyncWrites += 1;
      return dependencies.durableFs.writeJsonAtomicAsync(...args);
    }
  };
  const store = new OperationStore({ ...dependencies, durableFs });
  await store.initialize();
  await store.create(job({ jobId: 'job-async-write' }));
  await store.transition('job-async-write', {
    expectedPhase: 'queued', nextPhase: 'preflight', patch: {}
  });
  assert.equal(asyncWrites, 2);
});

test('concurrent asynchronous transitions preserve one compare-and-set winner', async t => {
  const { store } = fixture(t);
  await store.initialize();
  await store.create(job({ jobId: 'job-concurrent' }));

  const results = await Promise.allSettled([
    store.transition('job-concurrent', {
      expectedPhase: 'queued', nextPhase: 'preflight', patch: {}
    }),
    store.transition('job-concurrent', {
      expectedPhase: 'queued', nextPhase: 'resolving', patch: {}
    })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'COMMIT_FAILED');
  const winner = results.find(result => result.status === 'fulfilled').value;
  const stored = await store.get('job-concurrent');
  assert.equal(stored.sequence, 1);
  assert.equal(stored.phase, winner.phase);
});

test('job polling waits for the store own atomic publication instead of reporting false corruption', async t => {
  const { dependencies } = fixture(t);
  let blockNextWrite = false;
  let publicationActive = false;
  let releasePublication;
  let publicationStarted;
  const publicationGate = new Promise(resolve => { releasePublication = resolve; });
  const publicationStart = new Promise(resolve => { publicationStarted = resolve; });
  const durableFs = {
    ...dependencies.durableFs,
    readFileBounded(...args) {
      if (publicationActive) {
        const error = new Error('the atomic destination changed during the bounded read');
        error.code = 'COMMIT_FAILED';
        throw error;
      }
      return dependencies.durableFs.readFileBounded(...args);
    },
    async writeJsonAtomicAsync(...args) {
      if (!blockNextWrite) return dependencies.durableFs.writeJsonAtomicAsync(...args);
      blockNextWrite = false;
      publicationActive = true;
      publicationStarted();
      await publicationGate;
      try {
        return await dependencies.durableFs.writeJsonAtomicAsync(...args);
      } finally {
        publicationActive = false;
      }
    }
  };
  const store = new OperationStore({ ...dependencies, durableFs });
  await store.initialize();
  await store.create(job({ jobId: 'job-polled-during-publication' }));

  blockNextWrite = true;
  const transition = store.transition('job-polled-during-publication', {
    expectedPhase: 'queued', nextPhase: 'preflight', patch: {}
  });
  await publicationStart;
  const polled = store.get('job-polled-during-publication').then(
    value => ({ status: 'fulfilled', value }),
    error => ({ status: 'rejected', error })
  );
  const premature = await Promise.race([
    polled,
    new Promise(resolve => setTimeout(() => resolve('pending'), 25))
  ]);
  assert.equal(premature, 'pending');

  releasePublication();
  const [transitioned, observed] = await Promise.all([transition, polled]);
  assert.equal(observed.status, 'fulfilled');
  assert.equal(observed.value.sequence, transitioned.sequence);
  assert.equal(observed.value.phase, 'preflight');
});

test('same-phase progress is durably updated without weakening the phase graph or allowing regression', async (t) => {
  const { dependencies, store } = fixture(t);
  await store.initialize();
  await store.create(job({ jobId: 'job-progress' }));
  await store.transition('job-progress', {
    expectedPhase: 'queued', nextPhase: 'preflight',
    patch: { progress: { percent: 10, message: 'Checking the reviewed plan', currentItem: null } }
  });
  await store.transition('job-progress', {
    expectedPhase: 'preflight', nextPhase: 'staging',
    patch: { progress: { percent: 35, message: 'Building the server candidate', currentItem: null } }
  });

  const updated = await store.updateProgress('job-progress', {
    expectedPhase: 'staging',
    progress: { percent: 42, message: 'Reconciling reviewed modpack files', currentItem: null }
  });

  assert.equal(updated.phase, 'staging');
  assert.equal(updated.sequence, 3);
  assert.deepEqual(updated.progress, {
    percent: 42, message: 'Reconciling reviewed modpack files', currentItem: null
  });
  const reloadedStore = new OperationStore(dependencies);
  await reloadedStore.initialize();
  assert.deepEqual((await reloadedStore.get('job-progress')).progress, updated.progress);
  await assert.rejects(
    reloadedStore.updateProgress('job-progress', {
      expectedPhase: 'staging',
      progress: { percent: 41, message: 'Regressing candidate progress', currentItem: null }
    }),
    error => error.code === 'PLAN_STALE'
  );
  await assert.rejects(
    reloadedStore.updateProgress('job-progress', {
      expectedPhase: 'preflight',
      progress: { percent: 43, message: 'Using a stale phase', currentItem: null }
    }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(isLegalJobTransition('staging', 'staging', { operationKind: 'install-existing' }), false);
});

test('ordinary terminal states are final and recovery-required resolves only through dedicated reconciliation', async (t) => {
  const { store } = fixture(t);
  await store.initialize();
  await store.create(job({ jobId: 'job-cancel' }));
  const cancelling = await store.requestCancellation('job-cancel');
  assert.equal(cancelling.phase, 'cancelling');
  assert.equal(cancelling.cancellationRequested, true);
  assert.equal((await store.requestCancellation('job-cancel')).sequence, cancelling.sequence);
  const cancelled = await store.transition('job-cancel', {
    expectedPhase: 'cancelling',
    nextPhase: 'cancelled',
    patch: { outcome: { status: 'cancelled', message: 'Nothing changed' } }
  });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(typeof cancelled.terminalAt, 'string');
  await assert.rejects(
    store.transition('job-cancel', { expectedPhase: 'cancelled', nextPhase: 'failed', patch: { outcome: { status: 'failed' } } }),
    error => error.code === 'PLAN_STALE'
  );

  await store.create(job({ jobId: 'job-commit' }));
  await store.transition('job-commit', { expectedPhase: 'queued', nextPhase: 'preflight', patch: {} });
  await store.transition('job-commit', { expectedPhase: 'preflight', nextPhase: 'staging', patch: {} });
  await store.transition('job-commit', { expectedPhase: 'staging', nextPhase: 'committing', patch: {} });
  await assert.rejects(store.requestCancellation('job-commit'), error => error.code === 'PLAN_STALE');
  await assert.rejects(
    store.transition('job-commit', { expectedPhase: 'committing', nextPhase: 'recovery-required', patch: {} }),
    error => error.code === 'INVALID_REQUEST'
  );

  const recoveryRequired = await store.transition('job-commit', {
    expectedPhase: 'committing',
    nextPhase: 'recovery-required',
    patch: {
      progress: { percent: 70, message: 'Recovery review required', currentItem: null },
      outcome: { status: 'recovery-required', message: 'Recovery review required' }
    }
  });
  assert.equal(recoveryRequired.phase, 'recovery-required');
  await assert.rejects(
    store.transition('job-commit', {
      expectedPhase: 'recovery-required', nextPhase: 'failed', patch: { outcome: { status: 'failed' } }
    }),
    error => error.code === 'PLAN_STALE'
  );
  const resolved = await store.reconcileRecovery('job-commit', {
    nextPhase: 'failed',
    patch: {
      progress: { percent: 100, message: 'Recovery completed safely', currentItem: null },
      outcome: { status: 'failed', message: 'The interrupted operation was recovered' }
    }
  });
  assert.equal(resolved.phase, 'failed');
  assert.equal(resolved.sequence, recoveryRequired.sequence + 1);
  assert.equal(resolved.outcome.status, 'failed');
  await assert.rejects(
    store.reconcileRecovery('job-commit', {
      nextPhase: 'completed',
      patch: {
        progress: { percent: 100, message: 'Invalid second resolution', currentItem: null },
        outcome: { status: 'completed', message: 'Invalid second resolution' }
      }
    }),
    error => error.code === 'PLAN_STALE'
  );
});

test('public terminal outcomes preserve only exact closed failure diagnostics', async t => {
  const { store } = fixture(t);
  await store.initialize();
  await store.create(job({ jobId: 'job-safe-diagnostic' }));
  const safe = await store.transition('job-safe-diagnostic', {
    expectedPhase: 'queued',
    nextPhase: 'failed',
    patch: {
      outcome: {
        status: 'failed',
        message: 'The candidate server did not become ready',
        failure: {
          stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
        }
      }
    }
  });
  assert.deepEqual(safe.outcome.failure, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });

  await store.create(job({ jobId: 'job-malformed-diagnostic' }));
  const malformed = await store.transition('job-malformed-diagnostic', {
    expectedPhase: 'queued',
    nextPhase: 'failed',
    patch: {
      outcome: {
        status: 'failed',
        message: 'The candidate server did not become ready',
        failure: {
          message: 'C:\\private\\candidate raw process output',
          stack: 'secret exception stack'
        }
      }
    }
  });
  assert.equal(Object.hasOwn(malformed.outcome, 'failure'), false);
  assert.doesNotMatch(JSON.stringify(malformed.outcome), /private|candidate raw|secret|exception|stack/i);
});

test('job events are scoped by store authority and redact paths URLs and secrets', async (t) => {
  const emitted = [];
  const { store } = fixture(t, { eventSink: event => emitted.push(event) });
  await store.initialize();
  await store.create(job({ jobId: 'job-events' }));
  await store.create(job({ jobId: 'job-other' }));
  const updated = await store.appendEvent('job-events', {
    channel: 'log',
    message: 'Downloaded https://example.invalid/private?token=hunter2 to C:\\Servers\\Pack',
    details: {
      token: 'hunter2',
      archivePath: 'C:\\Servers\\Pack\\pack.zip',
      sourceUrl: 'https://example.invalid/private',
      releaseId: 'release-42'
    }
  });

  assert.equal(updated.sequence, 1);
  assert.equal(updated.events.length, 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].jobId, 'job-events');
  assert.equal(Object.isFrozen(emitted[0]), true);
  const serialized = JSON.stringify(emitted[0]);
  assert.doesNotMatch(serialized, /hunter2|example\.invalid|Servers|pack\.zip/);
  assert.match(serialized, /release-42/);
  assert.equal((await store.get('job-other')).events.length, 0);
  await assert.rejects(
    store.appendEvent('job-events', { jobId: 'job-other', channel: 'log', message: 'wrong owner' }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('reload fails closed for a tampered durable job record', async (t) => {
  const { dependencies, store, userDataPath } = fixture(t);
  await store.initialize();
  await store.create(job());
  const recordPath = path.join(userDataPath, 'modpack-lifecycle', 'operations', 'job-0001.json');
  const value = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  value.phase = 'completed';
  fs.writeFileSync(recordPath, `${JSON.stringify(value, null, 2)}\n`);

  const reloadedStore = new OperationStore(dependencies);
  await assert.rejects(reloadedStore.initialize(), error => error.code === 'RECOVERY_REQUIRED');
});
