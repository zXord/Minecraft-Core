const assert = require('node:assert/strict');
const test = require('node:test');

const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { ModpackError, deepFreeze } = require('../../electron/services/modpacks/errors.cjs');
const { isLegalJobTransition } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { createModpackHandlers } = require('../../electron/ipc/modpack-handlers.cjs');

const FINGERPRINT = 'a'.repeat(64);

function serviceFor(plan) {
  const mutationRuntime = Object.fromEntries([
    'resolveInstance', 'suspendAutoRestart', 'quiesce', 'revalidate', 'createRestorePoint', 'buildCandidate',
    'validateCandidate', 'publishCandidate', 'registerPublishedInstance', 'commitCandidate', 'startFinal',
    'validateLive', 'persistOutcome', 'cleanup', 'rollback', 'abandonCandidate', 'restorePriorState'
  ].map(name => [name, async () => { throw new Error(`unexpected ${name}`); }]));
  return new ModpackLifecycleService({
    sourceResolver: { async resolveArtifactSetPlan() {} },
    artifactDownloader: { async downloadSet() {} },
    archiveInspector: { async inspectArchive() {} },
    inspectionLoader: { loadInspection() {} },
    planningAdapter: { async createPlan() {} },
    planRegistry: {
      create() {},
      get() {},
      claim() {
        return Object.freeze({
          jobId: 'job-downgrade',
          planId: 'plan-downgrade',
          fingerprint: FINGERPRINT,
          plan,
          planView: Object.freeze({}),
          expiresAt: '2026-08-02T02:00:00.000Z',
          claimedAt: '2026-08-02T00:00:00.000Z'
        });
      },
      releaseClaim() { return true; }
    },
    operationStore: {
      async create() { throw new Error('must not create a downgrade job'); },
      async get() { return null; },
      async requestCancellation() {},
      async transition() {}
    },
    mutationCoordinator: { runMutation() {} },
    mutationRuntime
  });
}

test('downgrade rejects a caller-selected prior restore because execution creates its own current safety point', async () => {
  const plan = Object.freeze({
    fingerprint: FINGERPRINT,
    operation: Object.freeze({
      kind: 'downgrade',
      instanceId: 'server-one',
      expectedContentRevision: 4,
      downgrade: true
    }),
    requirements: Object.freeze({
      downgradeWorldRiskAcknowledged: true,
      compatibleWorldRestorePointId: null
    }),
    restorePoints: Object.freeze([])
  });
  const service = serviceFor(plan);

  await assert.rejects(
    service.startOperation({
      planId: 'plan-downgrade',
      planFingerprint: FINGERPRINT,
      choices: { restorePointId: 'restore-prior' }
    }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('downgrade rejects a claimed plan that lacks the explicit world-risk acknowledgement', async () => {
  const plan = Object.freeze({
    fingerprint: FINGERPRINT,
    operation: Object.freeze({
      kind: 'downgrade',
      serverKind: 'existing',
      instanceId: 'server-one',
      expectedContentRevision: 4,
      downgrade: true
    }),
    requirements: Object.freeze({
      downgradeWorldRiskAcknowledged: false,
      verifiedRestorePointRequired: true
    }),
    restorePoints: Object.freeze([])
  });

  await assert.rejects(
    serviceFor(plan).startOperation({
      planId: 'plan-downgrade',
      planFingerprint: FINGERPRINT,
      choices: { acceptEula: true }
    }),
    error => error.code === 'PLAN_STALE'
  );
});

function planFor(operationKind) {
  const operations = {
    'install-new': { kind: 'install', serverKind: 'new', expectedContentRevision: 0, downgrade: false },
    'install-existing': { kind: 'install', serverKind: 'existing', expectedContentRevision: 4, downgrade: false },
    update: { kind: 'upgrade', serverKind: 'existing', expectedContentRevision: 4, downgrade: false },
    downgrade: { kind: 'downgrade', serverKind: 'existing', expectedContentRevision: 4, downgrade: true },
    switch: { kind: 'switch', serverKind: 'existing', expectedContentRevision: 4, downgrade: false },
    repair: { kind: 'repair', serverKind: 'existing', expectedContentRevision: 4, downgrade: false },
    'rollback-restore-point': {
      kind: 'rollback-restore-point', serverKind: 'existing', expectedContentRevision: 4, downgrade: false
    }
  };
  return deepFreeze({
    type: 'modpack-preflight-plan',
    schemaVersion: 1,
    fingerprint: FINGERPRINT,
    operation: { ...operations[operationKind], instanceId: 'server-one' },
    ownership: {
      preserved: [{ path: 'mods/user-addon.jar', reason: 'user-owned' }],
      orphaned: [{ path: 'mods/old-pack.jar', reason: 'modified-managed' }]
    },
    artifact: {
      setDigest: 'c'.repeat(64),
      parts: [{ partId: 'archive-one', measuredSize: '4096', sha256: 'd'.repeat(64) }]
    },
    requirements: {
      downgradeWorldRiskAcknowledged: operationKind === 'downgrade',
      verifiedRestorePointRequired: operationKind !== 'install-new'
    },
    restorePoints: [{
      id: 'restore-compatible',
      sha256: 'b'.repeat(64),
      sourceRevision: 4,
      runtime: { minecraftVersion: '1.20.1' },
      worldIncluded: true
    }]
  });
}

class MemoryOperationStore {
  constructor({ failCreate = false, failTransitionOnce = null, failAppendEvent = false } = {}) {
    this.failCreate = failCreate;
    this.failTransitionOnce = failTransitionOnce;
    this.failAppendEvent = failAppendEvent;
    this.invalidTransitionRequests = 0;
    this.records = new Map();
    this.phaseHistory = new Map();
    this.progressHistory = new Map();
  }

  async create(request) {
    if (this.failCreate) throw new ModpackError('COMMIT_FAILED', 'injected create failure');
    const record = {
      ...request,
      phase: 'queued',
      cancellationRequested: false,
      progress: null,
      outcome: null,
      events: []
    };
    this.records.set(request.jobId, record);
    this.phaseHistory.set(request.jobId, ['queued']);
    this.progressHistory.set(request.jobId, []);
    return deepFreeze(structuredClone(record));
  }

  async get(jobId) {
    const record = this.records.get(jobId);
    return record ? deepFreeze(structuredClone(record)) : null;
  }

  async transition(jobId, request) {
    if (!request || typeof request !== 'object') {
      this.invalidTransitionRequests += 1;
      throw new ModpackError('INVALID_REQUEST', 'invalid transition request');
    }
    const { expectedPhase, nextPhase, patch } = request;
    const record = this.records.get(jobId);
    if (this.failTransitionOnce === `${expectedPhase}->${nextPhase}`) {
      this.failTransitionOnce = null;
      throw new ModpackError('COMMIT_FAILED', 'injected operation transition failure');
    }
    if (!record || record.phase !== expectedPhase || !isLegalJobTransition(expectedPhase, nextPhase, {
      operationKind: record.operationKind
    })) throw new ModpackError('PLAN_STALE', 'stale transition');
    Object.assign(record, patch, { phase: nextPhase });
    this.phaseHistory.get(jobId).push(nextPhase);
    if (patch.progress) this.progressHistory.get(jobId).push({ phase: nextPhase, ...structuredClone(patch.progress) });
    return deepFreeze(structuredClone(record));
  }

  async updateProgress(jobId, { expectedPhase, progress }) {
    const record = this.records.get(jobId);
    if (!record || record.phase !== expectedPhase ||
        (record.progress && progress.percent < record.progress.percent)) {
      throw new ModpackError('PLAN_STALE', 'stale progress update');
    }
    record.progress = structuredClone(progress);
    this.progressHistory.get(jobId).push({ phase: expectedPhase, ...structuredClone(progress) });
    return deepFreeze(structuredClone(record));
  }

  async requestCancellation(jobId) {
    const record = this.records.get(jobId);
    if (!record || !isLegalJobTransition(record.phase, 'cancelling', { operationKind: record.operationKind })) {
      throw new ModpackError('PLAN_STALE', 'cancellation boundary passed');
    }
    record.phase = 'cancelling';
    record.cancellationRequested = true;
    this.phaseHistory.get(jobId).push('cancelling');
    return deepFreeze(structuredClone(record));
  }

  async appendEvent(jobId, event) {
    if (this.failAppendEvent) throw new ModpackError('COMMIT_FAILED', 'injected event append failure');
    const record = this.records.get(jobId);
    if (!record || ['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required'].includes(record.phase)) {
      throw new ModpackError('PLAN_STALE', 'event append boundary passed');
    }
    record.events.push({
      ...structuredClone(event),
      sequence: record.events.length + 1,
      jobId,
      phase: record.phase,
      timestamp: '2026-08-02T00:00:00.000Z',
      progress: event.progress ?? null,
      currentItem: event.currentItem ?? null,
      details: event.details ?? null
    });
    return deepFreeze(structuredClone(record));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function mutationFixture(operationKind, options = {}) {
  const plan = planFor(operationKind);
  const operationStore = new MemoryOperationStore({
    failCreate: options.failCreate,
    failTransitionOnce: options.failTransitionOnce,
    failAppendEvent: options.failAppendEvent
  });
  const calls = [];
  const actionIssuances = [];
  const released = [];
  let claimed = false;
  const planRegistry = {
    create() {},
    get() {},
    claim({ planId, fingerprint }) {
      if (claimed || planId !== 'plan-one' || fingerprint !== FINGERPRINT) {
        throw new ModpackError('PLAN_STALE', 'plan already claimed');
      }
      claimed = true;
      return deepFreeze({
        jobId: 'job-one',
        planId,
        fingerprint,
        plan,
        planView: {},
        expiresAt: '2026-08-02T02:00:00.000Z',
        claimedAt: '2026-08-02T00:00:00.000Z'
      });
    },
    releaseClaim(jobId) {
      if (jobId !== 'job-one' || released.includes(jobId)) return false;
      released.push(jobId);
      return true;
    }
  };
  let dirty = false;
  const mutationCoordinator = {
    quarantineMutation(lease) { calls.push(['quarantine', lease]); },
    async runMutation(selector, mutationOptions, work) {
      calls.push(['coordinator', selector, mutationOptions.operation, mutationOptions.revisionMode]);
      if (options.coordinatorRunError) throw options.coordinatorRunError;
      await mutationOptions.quiesce({ operation: mutationOptions.operation, operationId: mutationOptions.operationId, selectors: [selector] });
      if (mutationOptions.signal.aborted) throw new ModpackError('CANCELLED', 'cancelled');
      let result;
      let workError = null;
      try {
        result = await work({
          kind: 'mutation',
          operationId: mutationOptions.operationId,
          markDirty() { dirty = true; return true; }
        });
      } catch (error) {
        workError = error;
      }
      if (gates.coordinatorRelease) {
        gates.coordinatorRelease.entered?.resolve();
        await gates.coordinatorRelease.promise;
      }
      if (options.coordinatorFinalizationError) throw options.coordinatorFinalizationError;
      if (workError && options.rejectDirtyNewLifecycleAsStale && dirty &&
          mutationOptions.revisionMode === 'lifecycle') {
        throw new ModpackError('PLAN_STALE', 'injected live revision mismatch');
      }
      if (workError) throw workError;
      return result;
    }
  };
  const failureAt = options.failureAt || null;
  const gates = options.gates || {};
  const method = (name, result) => async context => {
    calls.push([name, context]);
    if (gates[name]) {
      gates[name].entered?.resolve();
      await gates[name].promise;
    }
    if (failureAt === name) throw options.failureErrors?.[name] ||
      new ModpackError('COMMIT_FAILED', `injected ${name} failure`);
    return typeof result === 'function' ? result(context) : result;
  };
  const mutationRuntime = {
    resolveInstance: method('resolveInstance', {
      instanceId: 'server-one',
      serverPath: 'C:\\MinecraftCore\\Servers\\server-one',
      priorRunning: options.priorRunning === true
    }),
    suspendAutoRestart: method('suspendAutoRestart', { token: 'restart-policy' }),
    quiesce: method('quiesce'),
    revalidate: method('revalidate'),
    createRestorePoint: method('createRestorePoint', async context => {
      for (const event of options.restorePointProgress || []) {
        context.onProgress?.(event);
        if (options.yieldBetweenRestorePointProgress) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      return { id: 'restore-new', verified: true };
    }),
    buildCandidate: method('buildCandidate', async context => {
      for (const event of options.candidateProgress || []) await context.onProgress(event);
      return { id: 'candidate-one' };
    }),
    validateCandidate: method('validateCandidate', { healthy: true }),
    publishCandidate: method('publishCandidate', { id: 'committed-one' }),
    registerPublishedInstance: method('registerPublishedInstance', { instanceId: 'server-one' }),
    commitCandidate: method('commitCandidate', { id: 'committed-one' }),
    startFinal: method('startFinal', { running: true }),
    validateLive: method('validateLive', { healthy: true }),
    persistOutcome: method('persistOutcome', { contentRevision: 5 }),
    cleanup: method('cleanup'),
    rollback: method('rollback', options.rollbackResult || { contentRevision: 5 }),
    abandonCandidate: method('abandonCandidate'),
    restorePriorState: method('restorePriorState')
  };
  if (options.durableCommitAfterFailure) {
    mutationRuntime.isDurablyCommitted = method('isDurablyCommitted', true);
  }
  const outcomeActionIssuer = options.issueOutcomeActions === false ? null : {
    async issue(context) {
      actionIssuances.push(context);
      if (gates.outcomeActionIssue) {
        gates.outcomeActionIssue.entered?.resolve();
        await gates.outcomeActionIssue.promise;
      }
      return [{
        actionId: 'open-details',
        opaqueRef: `outcome:${context.jobId}:${context.phase}`
      }];
    }
  };
  const service = new ModpackLifecycleService({
    sourceResolver: { async resolveArtifactSetPlan() {} },
    artifactDownloader: { async downloadSet() {} },
    archiveInspector: { async inspectArchive() {} },
    inspectionLoader: { loadInspection() {} },
    planningAdapter: { async createPlan() {} },
    planRegistry,
    operationStore,
    mutationCoordinator,
    mutationRuntime,
    outcomeActionIssuer,
    ...(options.yieldControl ? { yieldControl: options.yieldControl } : {})
  });
  const choices = operationKind === 'rollback-restore-point'
      ? { restorePointId: 'restore-compatible' }
      : { acceptEula: true };
  return {
    calls,
    actionIssuances,
    choices,
    get dirty() { return dirty; },
    operationStore,
    plan,
    planRegistry,
    released,
    service
  };
}

async function waitForPhase(store, jobId, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await store.get(jobId);
    if (job && (typeof expected === 'function' ? expected(job.phase) : job.phase === expected)) return job;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`job ${jobId} did not reach ${String(expected)}; phases: ${store.phaseHistory.get(jobId)?.join(', ')}`);
}

const expectedExisting = [
  'queued', 'preflight', 'snapshotting', 'staging', 'validating-candidate', 'committing',
  'validating-live', 'committed-healthy', 'cleanup', 'completed'
];

test('production candidate callbacks advance durable lifecycle progress monotonically through the true validation phase', async () => {
  const fixture = mutationFixture('update', {
    candidateProgress: [
      { phase: 'staging', percent: 36, message: 'Checking the live server content', currentItem: null },
      { phase: 'staging', percent: 42, message: 'Reconciling reviewed modpack files', currentItem: null },
      { phase: 'validating-candidate', percent: 50, message: 'Recording the candidate state', currentItem: null },
      { phase: 'validating-candidate', percent: 57, message: 'Boot-testing the candidate on loopback', currentItem: null },
      { phase: 'validating-candidate', percent: 63, message: 'Sealing candidate integrity evidence', currentItem: null }
    ]
  });

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');

  const candidateProgress = fixture.operationStore.progressHistory.get(queued.jobId)
    .filter(event => event.percent >= 35 && event.percent <= 63);
  assert.deepEqual(candidateProgress.map(event => [event.phase, event.percent, event.message]), [
    ['staging', 35, 'Building the server candidate'],
    ['staging', 36, 'Checking the live server content'],
    ['staging', 42, 'Reconciling reviewed modpack files'],
    ['validating-candidate', 50, 'Recording the candidate state'],
    ['validating-candidate', 57, 'Boot-testing the candidate on loopback'],
    ['validating-candidate', 63, 'Sealing candidate integrity evidence']
  ]);
  assert.equal(candidateProgress.every((event, index) => index === 0 || event.percent >= candidateProgress[index - 1].percent), true);
  assert.deepEqual(fixture.operationStore.phaseHistory.get(queued.jobId), expectedExisting);
});

test('verified restore-point creation publishes bounded snapshot progress before candidate staging', async () => {
  const fixture = mutationFixture('update', {
    restorePointProgress: [
      { phase: 'scope', processedBytes: 0, totalBytes: null },
      { phase: 'archive-write', processedBytes: 50, totalBytes: 100, entriesProcessed: 2, entriesTotal: 4 },
      { phase: 'archive-hash', processedBytes: 25, totalBytes: 50 },
      { phase: 'entry-verify', processedBytes: 100, totalBytes: 100 }
    ]
  });

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');

  const snapshotProgress = fixture.operationStore.progressHistory.get(queued.jobId)
    .filter(event => event.phase === 'snapshotting');
  assert.equal(snapshotProgress.length > 1, true);
  assert.equal(snapshotProgress.every((event, index) =>
    index === 0 || event.percent >= snapshotProgress[index - 1].percent), true);
  assert.equal(snapshotProgress.some(event => /Saving the recovery snapshot/u.test(event.message)), true);
  assert.equal(snapshotProgress.at(-1).percent, 34);
  assert.equal(snapshotProgress.at(-1).message, 'Verified recovery snapshot ready');
});

test('a repeated restore archive verification sweep cannot move snapshot progress backwards', async () => {
  const fixture = mutationFixture('update', {
    yieldBetweenRestorePointProgress: true,
    restorePointProgress: [
      { phase: 'scope', processedBytes: 0, totalBytes: null },
      { phase: 'archive-write', processedBytes: 100, totalBytes: 100, entriesProcessed: 4, entriesTotal: 4 },
      { phase: 'archive-hash', processedBytes: 100, totalBytes: 100 },
      { phase: 'entry-verify', processedBytes: 100, totalBytes: 100 },
      { phase: 'archive-hash', processedBytes: 0, totalBytes: 100 },
      { phase: 'entry-verify', processedBytes: 0, totalBytes: 100 },
      { phase: 'entry-verify', processedBytes: 100, totalBytes: 100 }
    ]
  });

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');

  const snapshotProgress = fixture.operationStore.progressHistory.get(queued.jobId)
    .filter(event => event.phase === 'snapshotting');
  assert.equal(snapshotProgress.every((event, index) =>
    index === 0 || event.percent >= snapshotProgress[index - 1].percent), true);
  assert.equal(snapshotProgress.at(-1).percent, 34);
});

test('a final snapshot progress write failure reconciles the published restore point before failing', async () => {
  const fixture = mutationFixture('update');
  const updateProgress = fixture.operationStore.updateProgress.bind(fixture.operationStore);
  fixture.operationStore.updateProgress = async (jobId, request) => {
    if (request.progress.percent === 34) {
      throw new ModpackError('COMMIT_FAILED', 'injected final snapshot progress failure');
    }
    return updateProgress(jobId, request);
  };

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.equal(fixture.calls.filter(([name]) => name === 'abandonCandidate').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'buildCandidate'), false);
  assert.equal(fixture.calls.some(([name]) => name === 'commitCandidate'), false);
  assert.deepEqual(fixture.released, ['job-one']);
  assert.equal(failed.outcome.cleanupPending, false);
  assert.equal(fixture.actionIssuances.at(-1).restorePointId, 'restore-new');
});

test('cancellation during final snapshot progress reconciles the published restore point before cancelling', async () => {
  const finalProgressEntered = deferred();
  const releaseFinalProgress = deferred();
  const fixture = mutationFixture('update');
  const updateProgress = fixture.operationStore.updateProgress.bind(fixture.operationStore);
  fixture.operationStore.updateProgress = async (jobId, request) => {
    if (request.progress.percent === 34) {
      finalProgressEntered.resolve();
      await releaseFinalProgress.promise;
    }
    return updateProgress(jobId, request);
  };

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await finalProgressEntered.promise;
  const cancelling = await fixture.service.cancelJob(queued.jobId);
  assert.equal(cancelling.phase, 'cancelling');
  releaseFinalProgress.resolve();
  const cancelledJob = await waitForPhase(fixture.operationStore, queued.jobId, 'cancelled');

  assert.equal(fixture.calls.filter(([name]) => name === 'abandonCandidate').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'buildCandidate'), false);
  assert.equal(fixture.calls.some(([name]) => name === 'commitCandidate'), false);
  assert.deepEqual(fixture.released, ['job-one']);
  assert.equal(cancelledJob.outcome.cleanupPending, false);
  assert.equal(fixture.actionIssuances.at(-1).restorePointId, 'restore-new');
});

test('cancellation returned from restore-point creation reconciles its durable recovery record', async () => {
  const fixture = mutationFixture('update');
  let durableRecoveryActive = false;
  fixture.service.mutationRuntime.createRestorePoint = async context => {
    fixture.calls.push(['createRestorePoint', context]);
    durableRecoveryActive = true;
    throw new ModpackError('CANCELLED', 'cancelled after the restore point was recorded');
  };
  fixture.service.mutationRuntime.abandonCandidate = async context => {
    fixture.calls.push(['abandonCandidate', context]);
    assert.equal(durableRecoveryActive, true);
    durableRecoveryActive = false;
  };

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  const cancelledJob = await waitForPhase(fixture.operationStore, queued.jobId, 'cancelled');

  assert.equal(durableRecoveryActive, false);
  assert.equal(fixture.calls.filter(([name]) => name === 'abandonCandidate').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'buildCandidate'), false);
  assert.equal(fixture.calls.some(([name]) => name === 'commitCandidate'), false);
  assert.deepEqual(fixture.released, ['job-one']);
  assert.equal(cancelledJob.outcome.cleanupPending, false);
});

test('cancellation as revalidation returns reconciles the durable preflight recovery record', async () => {
  const revalidateEntered = deferred();
  const releaseRevalidate = deferred();
  const fixture = mutationFixture('update');
  let durableRecoveryActive = false;
  fixture.service.mutationRuntime.revalidate = async context => {
    fixture.calls.push(['revalidate', context]);
    durableRecoveryActive = true;
    revalidateEntered.resolve();
    await releaseRevalidate.promise;
  };
  fixture.service.mutationRuntime.abandonCandidate = async context => {
    fixture.calls.push(['abandonCandidate', context]);
    assert.equal(durableRecoveryActive, true);
    durableRecoveryActive = false;
  };

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await revalidateEntered.promise;
  const cancelling = await fixture.service.cancelJob(queued.jobId);
  assert.equal(cancelling.phase, 'cancelling');
  releaseRevalidate.resolve();
  const cancelledJob = await waitForPhase(fixture.operationStore, queued.jobId, 'cancelled');

  assert.equal(durableRecoveryActive, false);
  assert.equal(fixture.calls.filter(([name]) => name === 'abandonCandidate').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'createRestorePoint'), false);
  assert.equal(fixture.calls.some(([name]) => name === 'buildCandidate'), false);
  assert.deepEqual(fixture.released, ['job-one']);
  assert.equal(cancelledJob.outcome.cleanupPending, false);
});

test('snapshot job-transition failure reconciles the durable preflight recovery record', async () => {
  const fixture = mutationFixture('update', { failTransitionOnce: 'preflight->snapshotting' });
  let durableRecoveryActive = false;
  fixture.service.mutationRuntime.revalidate = async context => {
    fixture.calls.push(['revalidate', context]);
    durableRecoveryActive = true;
  };
  fixture.service.mutationRuntime.abandonCandidate = async context => {
    fixture.calls.push(['abandonCandidate', context]);
    assert.equal(durableRecoveryActive, true);
    durableRecoveryActive = false;
  };

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.equal(durableRecoveryActive, false);
  assert.equal(fixture.calls.filter(([name]) => name === 'abandonCandidate').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'createRestorePoint'), false);
  assert.equal(fixture.calls.some(([name]) => name === 'buildCandidate'), false);
  assert.deepEqual(fixture.released, ['job-one']);
  assert.equal(failed.outcome.cleanupPending, false);
});

test('cancellation during the snapshot job transition reconciles the durable preflight recovery record', async () => {
  const snapshotTransitionEntered = deferred();
  const releaseSnapshotTransition = deferred();
  const fixture = mutationFixture('update');
  let durableRecoveryActive = false;
  fixture.service.mutationRuntime.revalidate = async context => {
    fixture.calls.push(['revalidate', context]);
    durableRecoveryActive = true;
  };
  fixture.service.mutationRuntime.abandonCandidate = async context => {
    fixture.calls.push(['abandonCandidate', context]);
    assert.equal(durableRecoveryActive, true);
    durableRecoveryActive = false;
  };
  const transition = fixture.operationStore.transition.bind(fixture.operationStore);
  fixture.operationStore.transition = async (jobId, request) => {
    if (request.expectedPhase === 'preflight' && request.nextPhase === 'snapshotting') {
      snapshotTransitionEntered.resolve();
      await releaseSnapshotTransition.promise;
    }
    return transition(jobId, request);
  };

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await snapshotTransitionEntered.promise;
  const cancelling = await fixture.service.cancelJob(queued.jobId);
  assert.equal(cancelling.phase, 'cancelling');
  releaseSnapshotTransition.resolve();
  const cancelledJob = await waitForPhase(fixture.operationStore, queued.jobId, 'cancelled');

  assert.equal(durableRecoveryActive, false);
  assert.equal(fixture.calls.filter(([name]) => name === 'abandonCandidate').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'createRestorePoint'), false);
  assert.equal(fixture.calls.some(([name]) => name === 'buildCandidate'), false);
  assert.deepEqual(fixture.released, ['job-one']);
  assert.equal(cancelledJob.outcome.cleanupPending, false);
});

for (const operationKind of [
  'install-new', 'install-existing', 'update', 'downgrade', 'switch', 'repair', 'rollback-restore-point'
]) {
  test(`${operationKind} executes its exact durable lifecycle and releases its one-use workspace`, async () => {
    const fixture = mutationFixture(operationKind);
    const queued = await fixture.service.startOperation({
      planId: 'plan-one',
      planFingerprint: FINGERPRINT,
      choices: fixture.choices
    });
    assert.equal(queued.phase, 'queued');
    const completed = await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
    assert.equal(completed.outcome.status, 'completed');
    assert.equal(fixture.dirty, true);
    assert.deepEqual(fixture.released, ['job-one']);
    assert.equal(fixture.calls.find(([name]) => name === 'buildCandidate')[1].plan, fixture.plan);

    const phases = fixture.operationStore.phaseHistory.get(queued.jobId);
    if (operationKind === 'install-new') {
      assert.equal(fixture.calls.find(([name]) => name === 'coordinator')[3], 'none');
      assert.deepEqual(phases, [
        'queued', 'preflight', 'staging', 'committing', 'publishing',
        'published', 'registering', 'validating-live', 'committed-healthy', 'cleanup', 'completed'
      ]);
      assert.equal(fixture.calls.some(([name]) => name === 'validateCandidate'), false);
      assert.equal(fixture.calls.filter(([name]) => name === 'validateLive').length, 1);
      assert.equal(fixture.calls.find(([name]) => name === 'validateLive')[1].running, false);
      assert.equal(fixture.calls.some(([name]) => name === 'createRestorePoint'), false);
      assert.equal(fixture.calls.some(([name]) => name === 'publishCandidate'), true);
      assert.equal(fixture.calls.some(([name]) => name === 'registerPublishedInstance'), true);
      assert.equal(fixture.calls.some(([name]) => name === 'commitCandidate'), false);
    } else {
      assert.equal(fixture.calls.find(([name]) => name === 'coordinator')[3], 'lifecycle');
      assert.deepEqual(phases, expectedExisting);
      assert.equal(fixture.calls.some(([name]) => name === 'createRestorePoint'), true);
      assert.equal(fixture.calls.some(([name]) => name === 'commitCandidate'), true);
      assert.equal(fixture.calls.some(([name]) => name === 'publishCandidate'), false);
    }
  });
}

test('new start-after-install selects one canonical boot instead of a candidate boot plus a live boot', async () => {
  const fixture = mutationFixture('install-new');
  const queued = await fixture.service.startOperation({
    planId: 'plan-one',
    planFingerprint: FINGERPRINT,
    choices: { ...fixture.choices, startAfterInstall: true }
  });

  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');

  assert.deepEqual(fixture.operationStore.phaseHistory.get(queued.jobId), [
    'queued', 'preflight', 'staging', 'committing', 'publishing', 'published', 'registering',
    'starting', 'validating-live', 'committed-healthy', 'cleanup', 'completed'
  ]);
  assert.equal(fixture.calls.some(([name]) => name === 'validateCandidate'), false);
  assert.equal(fixture.calls.filter(([name]) => name === 'validateLive').length, 1);
  assert.equal(fixture.calls.filter(([name]) => name === 'startFinal').length, 1);
  assert.equal(fixture.calls.find(([name]) => name === 'validateLive')[1].running, true);
});

test('successful completion is published only after mutation ownership is released', async () => {
  const coordinatorRelease = deferred();
  coordinatorRelease.entered = deferred();
  const fixture = mutationFixture('update', { gates: { coordinatorRelease } });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await coordinatorRelease.entered.promise;

  const stillOwned = await fixture.operationStore.get(queued.jobId);
  assert.equal(stillOwned.phase, 'cleanup');

  coordinatorRelease.resolve();
  const completed = await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
  assert.equal((await fixture.service.getJob(queued.jobId)).phase, 'completed');
  assert.equal(completed.outcome.status, 'completed');
});

test('terminal failures are neither persisted nor published until mutation ownership is released', async () => {
  const coordinatorRelease = deferred();
  coordinatorRelease.entered = deferred();
  const fixture = mutationFixture('update', {
    failureAt: 'buildCandidate',
    gates: { coordinatorRelease }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await coordinatorRelease.entered.promise;
  assert.equal((await fixture.operationStore.get(queued.jobId)).phase, 'staging');
  assert.equal((await fixture.service.getJob(queued.jobId)).phase, 'staging');
  assert.equal(fixture.operationStore.phaseHistory.get(queued.jobId).includes('failed'), false);

  coordinatorRelease.resolve();
  const completed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');
  assert.equal(completed.phase, 'failed');
});

test('cancellation cannot replace a failure that is already settling behind mutation ownership', async () => {
  const coordinatorRelease = deferred();
  coordinatorRelease.entered = deferred();
  const fixture = mutationFixture('update', {
    failureAt: 'buildCandidate',
    gates: { coordinatorRelease }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await coordinatorRelease.entered.promise;

  let cancellationSettled = false;
  const cancellation = fixture.service.cancelJob(queued.jobId)
    .finally(() => { cancellationSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellationSettled, false);
  assert.equal((await fixture.operationStore.get(queued.jobId)).phase, 'staging');

  coordinatorRelease.resolve();
  assert.equal((await cancellation).phase, 'failed');
  assert.equal(fixture.operationStore.phaseHistory.get(queued.jobId).includes('cancelling'), false);
});

test('cancellation cannot replace a failure that is already settling before mutation ownership begins', async () => {
  const outcomeActionIssue = deferred();
  outcomeActionIssue.entered = deferred();
  const fixture = mutationFixture('install-new', {
    failureAt: 'resolveInstance',
    failureErrors: {
      resolveInstance: new ModpackError('HEALTH_CHECK_FAILED', 'injected pre-coordinator failure')
    },
    gates: { outcomeActionIssue }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await outcomeActionIssue.entered.promise;

  let cancellationSettled = false;
  const cancellation = fixture.service.cancelJob(queued.jobId)
    .finally(() => { cancellationSettled = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(cancellationSettled, false);
  assert.equal((await fixture.operationStore.get(queued.jobId)).phase, 'queued');
  outcomeActionIssue.resolve();

  const failed = await cancellation;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.outcome.errorCode, 'HEALTH_CHECK_FAILED');
  assert.equal(fixture.operationStore.phaseHistory.get(queued.jobId).includes('cancelling'), false);
});

test('cancellation that wins before outer failure settlement remains cancelled', async () => {
  const resolveInstance = deferred();
  resolveInstance.entered = deferred();
  const fixture = mutationFixture('install-new', {
    failureAt: 'resolveInstance',
    gates: { resolveInstance }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await resolveInstance.entered.promise;

  const cancelling = await fixture.service.cancelJob(queued.jobId);
  assert.equal(cancelling.phase, 'cancelling');
  resolveInstance.resolve();

  const cancelled = await waitForPhase(fixture.operationStore, queued.jobId, 'cancelled');
  assert.equal(cancelled.outcome.status, 'cancelled');
  assert.equal(cancelled.outcome.errorCode, 'COMMIT_FAILED');
});

test('new-server canonical health failure is quarantined with its closed boot diagnostic', async () => {
  const healthError = new ModpackError('HEALTH_CHECK_FAILED', 'canonical boot failed');
  Object.defineProperty(healthError, 'candidateBootDiagnostic', {
    value: Object.freeze({
      stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
    })
  });
  const fixture = mutationFixture('install-new', {
    failureAt: 'validateLive',
    failureErrors: {
      validateLive: healthError
    },
    rollbackResult: {
      jobId: 'job-one',
      resolved: true,
      action: 'new-health-failed',
      failure: { stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure' }
    },
    rejectDirtyNewLifecycleAsStale: true
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');
  assert.equal(failed.outcome.errorCode, 'HEALTH_CHECK_FAILED');
  assert.equal(failed.outcome.message, 'The failed new server was quarantined safely');
  assert.deepEqual(failed.outcome.failure, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });
  assert.equal(fixture.calls.some(([name]) => name === 'validateCandidate'), false);
  assert.equal(fixture.calls.filter(([name]) => name === 'validateLive').length, 1);
  assert.equal(fixture.calls.find(([name]) => name === 'coordinator')[3], 'none');
});

for (const failureCase of [
  {
    name: 'rollback success',
    options: { failureAt: 'validateLive' },
    terminalPhase: 'rolled-back'
  },
  {
    name: 'rollback failure',
    options: {
      failureAt: 'validateLive',
      failureErrors: { rollback: new ModpackError('RECOVERY_REQUIRED', 'injected rollback failure') }
    },
    terminalPhase: 'recovery-required'
  }
]) {
  test(`${failureCase.name} remains non-terminal until mutation ownership is released`, async () => {
    const coordinatorRelease = deferred();
    coordinatorRelease.entered = deferred();
    const fixture = mutationFixture('update', {
      ...failureCase.options,
      gates: { coordinatorRelease }
    });
    if (failureCase.options.failureErrors?.rollback) {
      fixture.service.mutationRuntime.rollback = async context => {
        fixture.calls.push(['rollback', context]);
        throw failureCase.options.failureErrors.rollback;
      };
    }
    const queued = await fixture.service.startOperation({
      planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
    });

    await coordinatorRelease.entered.promise;
    assert.equal((await fixture.operationStore.get(queued.jobId)).phase, 'rolling-back');
    assert.equal(fixture.operationStore.phaseHistory.get(queued.jobId).includes(failureCase.terminalPhase), false);

    coordinatorRelease.resolve();
    const terminal = await waitForPhase(fixture.operationStore, queued.jobId, failureCase.terminalPhase);
    assert.equal(terminal.phase, failureCase.terminalPhase);
  });
}

test('coordinator finalization failure cannot leave a successful terminal job', async () => {
  const fixture = mutationFixture('update', {
    coordinatorFinalizationError: new ModpackError('COMMIT_FAILED', 'injected revision finalization failure')
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  const recovery = await waitForPhase(fixture.operationStore, queued.jobId, 'cleanup-pending');

  assert.equal(recovery.phase, 'cleanup-pending');
  assert.equal(fixture.operationStore.phaseHistory.get(queued.jobId).includes('completed'), false);
});

test('coordinator finalization failure overrides a deferred rollback outcome with recovery-required', async () => {
  const fixture = mutationFixture('update', {
    failureAt: 'validateLive',
    coordinatorFinalizationError: new ModpackError('COMMIT_FAILED', 'injected revision finalization failure')
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const recovery = await waitForPhase(fixture.operationStore, queued.jobId, 'recovery-required');

  assert.equal(recovery.outcome.errorCode, 'COMMIT_FAILED');
  assert.equal(fixture.operationStore.phaseHistory.get(queued.jobId).includes('rolled-back'), false);
});

test('coordinator finalization recovery retries after release without repeating rollback', async () => {
  const coordinatorRelease = deferred();
  coordinatorRelease.entered = deferred();
  const fixture = mutationFixture('update', {
    failureAt: 'validateLive',
    coordinatorFinalizationError: new ModpackError('COMMIT_FAILED', 'injected revision finalization failure'),
    failTransitionOnce: 'rolling-back->recovery-required',
    gates: { coordinatorRelease }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  await coordinatorRelease.entered.promise;
  assert.equal((await fixture.operationStore.get(queued.jobId)).phase, 'rolling-back');
  assert.equal(fixture.operationStore.phaseHistory.get(queued.jobId).includes('recovery-required'), false);
  coordinatorRelease.resolve();

  const recovery = await waitForPhase(fixture.operationStore, queued.jobId, 'recovery-required');
  assert.equal(recovery.outcome.errorCode, 'COMMIT_FAILED');
  assert.equal(fixture.calls.filter(([name]) => name === 'rollback').length, 1);
  assert.equal(fixture.operationStore.phaseHistory.get(queued.jobId).includes('rolled-back'), false);
});

test('deferred terminal publication retries the same safe outcome after a one-shot store failure', async () => {
  const fixture = mutationFixture('update', {
    failureAt: 'validateLive',
    failTransitionOnce: 'rolling-back->rolled-back'
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const rolledBack = await waitForPhase(fixture.operationStore, queued.jobId, 'rolled-back');

  assert.equal(rolledBack.outcome.status, 'rolled-back');
  assert.equal(fixture.calls.filter(([name]) => name === 'rollback').length, 1);
});

test('a prior-running server is restarted only from the committed final directory', async () => {
  const fixture = mutationFixture('update', { priorRunning: true });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
  assert.deepEqual(fixture.operationStore.phaseHistory.get(queued.jobId), [
    'queued', 'preflight', 'snapshotting', 'staging', 'validating-candidate', 'committing',
    'starting', 'validating-live', 'committed-healthy', 'cleanup', 'completed'
  ]);
  const commitIndex = fixture.calls.findIndex(([name]) => name === 'commitCandidate');
  const startIndex = fixture.calls.findIndex(([name]) => name === 'startFinal');
  assert.ok(commitIndex >= 0 && startIndex > commitIndex);
  assert.equal(fixture.calls.find(([name]) => name === 'restorePriorState')[1].running, true);
});

test('cancellation during staging abandons the candidate and never reaches commit', async () => {
  const buildGate = deferred();
  const fixture = mutationFixture('switch', { gates: { buildCandidate: buildGate } });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'staging');
  const cancelling = await fixture.service.cancelJob(queued.jobId);
  assert.equal(cancelling.phase, 'cancelling');
  buildGate.resolve();
  const cancelledJob = await waitForPhase(fixture.operationStore, queued.jobId, 'cancelled');
  assert.equal(cancelledJob.outcome.status, 'cancelled');
  assert.equal(cancelledJob.outcome.retainedDownload, true);
  assert.equal(fixture.calls.some(([name]) => name === 'abandonCandidate'), true);
  assert.equal(fixture.calls.some(([name]) => name === 'commitCandidate'), false);
  assert.deepEqual(fixture.released, ['job-one']);
});

test('cancellation is refused once commit begins and the durable operation continues', async () => {
  const commitGate = deferred();
  const fixture = mutationFixture('update', { gates: { commitCandidate: commitGate } });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'committing');
  await assert.rejects(fixture.service.cancelJob(queued.jobId), error => error.code === 'PLAN_STALE');
  commitGate.resolve();
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
});

test('pre-commit failure records ordinary failure with no commit attempt', async () => {
  const fixture = mutationFixture('repair', { failureAt: 'validateCandidate' });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');
  assert.equal(failed.outcome.errorCode, 'COMMIT_FAILED');
  assert.equal(failed.outcome.retainedDownload, true);
  assert.deepEqual(failed.outcome.actions, [{
    actionId: 'open-details', opaqueRef: 'outcome:job-one:failed'
  }]);
  assert.equal(fixture.actionIssuances[0].status, 'failed');
  assert.equal(fixture.actionIssuances[0].instanceId, 'server-one');
  assert.equal(fixture.calls.some(([name]) => name === 'commitCandidate'), false);
  assert.equal(fixture.calls.some(([name]) => name === 'rollback'), false);
  assert.deepEqual(fixture.released, ['job-one']);
});

test('runtime shutdown waiting is visible before candidate cleanup settles', async () => {
  const cleanupGate = deferred();
  const entered = deferred();
  cleanupGate.entered = entered;
  const fixture = mutationFixture('switch', {
    failureAt: 'buildCandidate',
    failureErrors: {
      buildCandidate: Object.assign(new ModpackError('CANCELLED', 'runtime cancellation'), { preserveWorkspace: true })
    },
    gates: { abandonCandidate: cleanupGate }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await entered.promise;
  const waiting = await fixture.operationStore.get(queued.jobId);
  cleanupGate.resolve();
  await waitForPhase(fixture.operationStore, queued.jobId, 'cancelled');
  assert.equal(waiting.events.some(event => event.channel === 'log' &&
    event.details?.step === 'wait-runtime-workers'), true);
  assert.equal(waiting.phase, 'staging');
});

test('review revalidation failure records only its safe mismatched precondition field', async () => {
  const failure = new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale', {
    details: {
      field: 'paths',
      path: 'C:\\private\\server',
      expected: 'secret-old-value',
      actual: 'secret-new-value'
    }
  });
  const fixture = mutationFixture('update', {
    failureAt: 'revalidate',
    failureErrors: { revalidate: failure }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.equal(failed.events.length, 1);
  assert.deepEqual(failed.events[0].details, {
    errorCode: 'PLAN_STALE',
    step: 'revalidate-plan',
    field: 'paths'
  });
  assert.doesNotMatch(JSON.stringify(failed), /private|secret-old|secret-new/u);
});

test('coordinator acquisition failure records one safe preflight diagnostic without leaking its cause', async () => {
  const coordinatorError = new ModpackError(
    'RECOVERY_REQUIRED',
    'Server recovery must be completed before this operation can continue',
    {
      cause: new Error('C:\\private\\Server Test secret-provider-token'),
      details: { operationId: 'unfinished-new-server' }
    }
  );
  const fixture = mutationFixture('install-new', { coordinatorRunError: coordinatorError });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.equal(failed.outcome.errorCode, 'RECOVERY_REQUIRED');
  assert.equal(failed.outcome.failureReason, 'destination-recovery');
  assert.equal(failed.events.length, 1);
  assert.deepEqual(failed.events[0], {
    channel: 'log',
    message: 'Server recovery must be completed before this operation can continue',
    details: { errorCode: 'RECOVERY_REQUIRED', step: 'acquire-mutation' },
    sequence: 1,
    jobId: 'job-one',
    phase: 'preflight',
    timestamp: '2026-08-02T00:00:00.000Z',
    progress: null,
    currentItem: null
  });
  assert.doesNotMatch(JSON.stringify(failed), /private|Server Test|secret-provider-token/u);
  assert.equal(fixture.calls.some(([name]) => name === 'revalidate'), false);
});

test('recovery-required failures are not labeled as destination recovery without the exact new-server acquisition evidence', async () => {
  for (const [operationKind, error] of [
    [
      'install-new',
      new ModpackError('RECOVERY_REQUIRED', 'The modpack operation requires recovery')
    ],
    [
      'install-existing',
      new ModpackError('RECOVERY_REQUIRED', 'Server recovery must be completed before this operation can continue', {
        details: { operationId: 'unfinished-existing-server' }
      })
    ]
  ]) {
    const fixture = mutationFixture(operationKind, { coordinatorRunError: error });
    const queued = await fixture.service.startOperation({
      planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
    });

    const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

    assert.equal(failed.outcome.errorCode, 'RECOVERY_REQUIRED');
    assert.equal(Object.hasOwn(failed.outcome, 'failureReason'), false);
  }
});

test('diagnostic append failure never replaces the authoritative terminal outcome', async () => {
  const fixture = mutationFixture('install-new', {
    coordinatorRunError: new ModpackError('RECOVERY_REQUIRED', 'Server recovery must be completed before this operation can continue'),
    failAppendEvent: true
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.equal(failed.outcome.errorCode, 'RECOVERY_REQUIRED');
  assert.deepEqual(failed.events, []);
});

test('pre-publication filesystem failures persist only an actionable redacted diagnostic', async () => {
  // This fails if failed jobs omit a durable boundary or leak raw filesystem/provider details.
  const error = new ModpackError('COMMIT_FAILED', 'The filesystem operation could not continue', {
    cause: new Error('C:\\private\\provider-name\\candidate.zip raw exception')
  });
  Object.defineProperty(error, 'durableFailureKind', { value: 'integrity-failure' });
  Object.defineProperty(error, 'durableFailureStage', { value: 'destination-parent-open' });
  const fixture = mutationFixture('repair', {
    failureAt: 'validateCandidate', failureErrors: { validateCandidate: error }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.deepEqual(failed.outcome.failure, {
    stage: 'filesystem-operation', category: 'integrity-failure', boundary: 'destination-parent-open'
  });
  assert.doesNotMatch(JSON.stringify(failed.outcome), /private|provider|candidate|zip|exception/i);
});

test('candidate boot failures persist only their closed actionable diagnostic', async () => {
  const error = new ModpackError('HEALTH_CHECK_FAILED', 'Server health validation failed', {
    cause: new Error('C:\\private\\server ModLoadingException from secret-mod.jar')
  });
  Object.defineProperty(error, 'candidateBootDiagnostic', {
    enumerable: false,
    value: Object.freeze({
      stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
    })
  });
  const fixture = mutationFixture('update', {
    failureAt: 'validateCandidate', failureErrors: { validateCandidate: error }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.deepEqual(failed.outcome.failure, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });
  assert.doesNotMatch(JSON.stringify(failed.outcome), /private|secret|modloadingexception|\.jar/i);
});

test('durable lifecycle transitions yield a main-loop turn before post-health finalization continues', async () => {
  const liveGate = deferred();
  const fixture = mutationFixture('install-new', { gates: { validateLive: liveGate } });
  const originalPersistOutcome = fixture.service.mutationRuntime.persistOutcome;
  let timerFired = false;
  let timerFiredBeforePersistence = null;
  fixture.service.mutationRuntime.persistOutcome = async context => {
    timerFiredBeforePersistence = timerFired;
    return originalPersistOutcome(context);
  };

  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT,
    choices: { ...fixture.choices, startAfterInstall: true }
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'validating-live');
  setImmediate(() => { timerFired = true; });
  liveGate.resolve();

  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
  assert.equal(timerFiredBeforePersistence, true);
});

for (const operationKind of ['install-new', 'rollback-restore-point']) {
  test(`${operationKind} abandons partial candidate materialization when the build throws`, async () => {
    const fixture = mutationFixture(operationKind, { failureAt: 'buildCandidate' });
    const queued = await fixture.service.startOperation({
      planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
    });

    const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

    assert.equal(fixture.calls.some(([name]) => name === 'abandonCandidate'), true);
    assert.equal(failed.outcome.cleanupPending, false);
    assert.deepEqual(fixture.released, ['job-one']);
  });
}

function eulaGateFixture(plan) {
  let createCalls = 0;
  let releaseCalls = 0;
  const service = new ModpackLifecycleService({
    sourceResolver: { async resolveArtifactSetPlan() {} },
    artifactDownloader: { async downloadSet() {} },
    archiveInspector: { async inspectArchive() {} },
    inspectionLoader: { loadInspection() {} },
    planningAdapter: { async createPlan() {} },
    planRegistry: {
      create() {}, get() {},
      async claim({ planId, fingerprint }) {
        return deepFreeze({
          jobId: 'job-eula', planId, fingerprint, plan, planView: {},
          expiresAt: '2026-08-02T02:00:00.000Z', claimedAt: '2026-08-02T00:00:00.000Z'
        });
      },
      async releaseClaim() { releaseCalls += 1; return true; }
    },
    operationStore: {
      async create() {
        createCalls += 1;
        throw new ModpackError('COMMIT_FAILED', 'Injected operation store boundary');
      },
      async get() { return null; }, async requestCancellation() {}, async transition() {}
    },
    mutationCoordinator: { runMutation() {} },
    mutationRuntime: Object.fromEntries([
      'resolveInstance', 'suspendAutoRestart', 'quiesce', 'revalidate', 'createRestorePoint', 'buildCandidate',
      'validateCandidate', 'publishCandidate', 'registerPublishedInstance', 'commitCandidate', 'startFinal',
      'validateLive', 'persistOutcome', 'cleanup', 'rollback', 'abandonCandidate', 'restorePriorState'
    ].map(name => [name, async () => { throw new Error(`unexpected ${name}`); }]))
  });
  return {
    service,
    get createCalls() { return createCalls; },
    get releaseCalls() { return releaseCalls; }
  };
}

function eulaPlan(operationKind) {
  const operation = {
    'install-new': { kind: 'install', serverKind: 'new' },
    'install-existing': { kind: 'install', serverKind: 'existing' },
    update: { kind: 'upgrade', serverKind: 'existing' },
    downgrade: { kind: 'downgrade', serverKind: 'existing' },
    switch: { kind: 'switch', serverKind: 'existing' },
    repair: { kind: 'repair', serverKind: 'existing' },
    detach: { kind: 'detach', serverKind: 'existing' },
    'rollback-restore-point': { kind: 'rollback-restore-point', serverKind: 'existing' },
    'uninstall-managed': { kind: 'uninstall', serverKind: 'existing' },
    'import-files-only-new': { kind: 'files-only', serverKind: 'new' }
  }[operationKind];
  const plan = {
    fingerprint: FINGERPRINT,
    operation: { ...operation, instanceId: 'server-one', expectedContentRevision: 0, downgrade: operationKind === 'downgrade' },
    requirements: {
      downgradeWorldRiskAcknowledged: operationKind === 'downgrade',
      ...(operationKind === 'import-files-only-new' ? { filesOnlySafetyConfirmed: true } : {})
    },
    restorePoints: operationKind === 'rollback-restore-point'
      ? [{ id: 'restore-one', sha256: 'b'.repeat(64), sourceRevision: 0, runtime: {}, worldIncluded: true }]
      : []
  };
  if (operationKind === 'uninstall-managed') {
    plan.ownership = { confirmation: {
      unchangedManagedRemovalCount: '0', preservedCategories: [], possibleNonRunnable: false,
      instanceRetained: true, worldsRetained: true
    } };
  }
  if (operationKind === 'import-files-only-new') plan.inspection = { kind: 'files-only' };
  return deepFreeze(plan);
}

test('main lifecycle requires explicit EULA acceptance for every runtime-bearing source mutation', async () => {
  for (const operationKind of ['install-new', 'install-existing', 'update', 'downgrade', 'switch', 'repair']) {
    const fixture = eulaGateFixture(eulaPlan(operationKind));
    await assert.rejects(
      fixture.service.startOperation({ planId: 'plan-eula', planFingerprint: FINGERPRINT, choices: { acceptEula: false } }),
      error => error.code === 'INVALID_REQUEST',
      operationKind
    );
    assert.equal(fixture.createCalls, 0, operationKind);
    assert.equal(fixture.releaseCalls, 1, operationKind);
  }
});

test('direct IPC cannot bypass the main lifecycle EULA gate', async () => {
  const fixture = eulaGateFixture(eulaPlan('install-existing'));
  const noop = async () => ({});
  const handlers = createModpackHandlers({
    providers: {
      modrinth: { searchProjects: noop, getProject: noop, listVersions: noop },
      github: { listReleases: noop, loadUploadedAssets: noop }
    },
    localArtifactSource: { selectWithNativeDialog: noop },
    destinationReservationService: { reserveWithNativeDialog: noop, release: noop },
    lifecycleService: fixture.service,
    recoveryService: { listRecovery: noop, recover: noop },
    notificationStore: { list: noop, acknowledge: noop },
    releaseMonitor: { checkAll: noop, checkOne: noop },
    releaseTrackingStore: { upsert: noop, list: noop },
    outcomeActionService: { performSafeAction: noop }
  });

  const result = await handlers['modpacks:start-operation']({ sender: { id: 41 } }, {
    planId: 'plan-eula',
    planFingerprint: FINGERPRINT,
    choices: { acceptEula: false }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_REQUEST');
  assert.equal(fixture.createCalls, 0);
  assert.equal(fixture.releaseCalls, 1);
});

test('main lifecycle does not require EULA acceptance for non-runtime management and files-only operations', async () => {
  for (const operationKind of ['detach', 'uninstall-managed', 'rollback-restore-point', 'import-files-only-new']) {
    const fixture = eulaGateFixture(eulaPlan(operationKind));
    const choices = {
      acceptEula: false,
      ...(operationKind === 'rollback-restore-point' ? { restorePointId: 'restore-one' } : {})
    };
    await assert.rejects(
      fixture.service.startOperation({ planId: 'plan-eula', planFingerprint: FINGERPRINT, choices }),
      error => error.code === 'COMMIT_FAILED',
      operationKind
    );
    assert.equal(fixture.createCalls, 1, operationKind);
    assert.equal(fixture.releaseCalls, 1, operationKind);
  }
});

test('partial candidate cleanup failure is persisted as cleanup pending', async () => {
  const fixture = mutationFixture('rollback-restore-point', { failureAt: 'buildCandidate' });
  fixture.service.mutationRuntime.abandonCandidate = async context => {
    fixture.calls.push(['abandonCandidate', context]);
    throw new ModpackError('RECOVERY_REQUIRED', 'partial candidate remains');
  };
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.equal(failed.outcome.cleanupPending, true);
  assert.equal(failed.outcome.errorCode, 'COMMIT_FAILED');
  assert.equal(failed.outcome.cleanupErrorCode, 'RECOVERY_REQUIRED');
});

test('unproven runtime shutdown reports recovery with the original error and retains quarantine and claims', async () => {
  const runtimeError = Object.assign(new ModpackError('RECOVERY_REQUIRED', 'closure timeout'), {
    runtimeWritersUnproven: true, runtimeFailureCode: 'RUNTIME_INCOMPLETE', preserveWorkspace: true,
    runtimeDiagnostic: { stage: 'finalizer-publish', reason: 'io', osCode: 'EACCES' }
  });
  const fixture = mutationFixture('update', { failureAt: 'buildCandidate', failureErrors: { buildCandidate: runtimeError } });
  fixture.service.mutationRuntime.abandonCandidate = async () => { throw runtimeError; };
  const queued = await fixture.service.startOperation({ planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices });
  const failed = await waitForPhase(fixture.operationStore, queued.jobId, phase => ['failed', 'recovery-required'].includes(phase));
  assert.equal(failed.phase, 'recovery-required');
  assert.equal(failed.outcome.errorCode, 'RUNTIME_INCOMPLETE');
  assert.equal(failed.outcome.cleanupPending, true);
  assert.deepEqual(failed.outcome.runtimeDiagnostic, runtimeError.runtimeDiagnostic);
  assert.equal(failed.events.some(event => event.details?.errorCode === 'RUNTIME_INCOMPLETE' &&
    event.message.includes('finalizer-publish') && event.message.includes('EACCES')), true);
  assert.equal(fixture.calls.filter(([name]) => name === 'quarantine').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'restorePriorState'), false);
  assert.deepEqual(fixture.released, []);
});

test('cancellation cannot report success while runtime writers remain unproven', async () => {
  const error = Object.assign(new ModpackError('CANCELLED', 'cancel requested'), {
    runtimeWritersUnproven: true, runtimeFailureCode: 'CANCELLED', preserveWorkspace: true
  });
  const fixture = mutationFixture('update', { failureAt: 'buildCandidate', failureErrors: { buildCandidate: error } });
  fixture.service.mutationRuntime.abandonCandidate = async () => { throw error; };
  const queued = await fixture.service.startOperation({ planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices });
  const result = await waitForPhase(fixture.operationStore, queued.jobId, phase => ['cancelled', 'recovery-required'].includes(phase));
  assert.equal(result.phase, 'recovery-required'); assert.equal(result.outcome.cleanupPending, true);
  assert.equal(result.outcome.errorCode, 'CANCELLED'); assert.deepEqual(fixture.released, []);
});

test('pre-commit cleanup failure preserves the primary health error and reports cleanup separately', async () => {
  const fixture = mutationFixture('rollback-restore-point', {
    failureAt: 'buildCandidate',
    failureErrors: {
      buildCandidate: new ModpackError('HEALTH_CHECK_FAILED', 'candidate boot failed')
    }
  });
  fixture.service.planRegistry.releaseClaim = async () => {
    throw new ModpackError('COMMIT_FAILED', 'workspace cleanup failed');
  };
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.equal(failed.outcome.cleanupPending, true);
  assert.equal(failed.outcome.errorCode, 'HEALTH_CHECK_FAILED');
  assert.equal(failed.outcome.cleanupErrorCode, 'COMMIT_FAILED');
});

test('post-commit validation failure durably rolls back before reporting an outcome', async () => {
  const fixture = mutationFixture('update', { failureAt: 'validateLive' });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  const rolledBack = await waitForPhase(fixture.operationStore, queued.jobId, 'rolled-back');
  assert.equal(rolledBack.outcome.status, 'rolled-back');
  assert.deepEqual(rolledBack.outcome.actions, [{
    actionId: 'open-details', opaqueRef: 'outcome:job-one:rolled-back'
  }]);
  assert.equal(fixture.actionIssuances[0].restorePointId, 'restore-new');
  assert.equal(fixture.calls.some(([name]) => name === 'rollback'), true);
  assert.deepEqual(fixture.released, ['job-one']);
});

test('new-server publication failure reports a failed unpublished install instead of claiming an original server was restored', async () => {
  const fixture = mutationFixture('install-new', {
    failureAt: 'publishCandidate',
    rollbackResult: { jobId: 'job-one', resolved: true, action: 'pre-publication-cleanup' }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.equal(failed.outcome.status, 'failed');
  assert.equal(failed.outcome.errorCode, 'COMMIT_FAILED');
  assert.equal(failed.outcome.message, 'The new server was not published');
  assert.doesNotMatch(failed.outcome.message, /original server|restored/i);
  assert.deepEqual(fixture.operationStore.phaseHistory.get(queued.jobId).slice(-3), [
    'publishing', 'rolling-back', 'failed'
  ]);
  assert.deepEqual(fixture.released, ['job-one']);
});

test('new-server publication failure exposes only its closed durable move diagnostic', async () => {
  const publicationError = new ModpackError('COMMIT_FAILED', 'The server could not be published', {
    cause: new Error('C:\\private\\candidate is locked')
  });
  Object.defineProperty(publicationError, 'durableFailureKind', { value: 'sharing-violation' });
  Object.defineProperty(publicationError, 'commitPhase', { value: 'post-publication-uncertain' });
  const fixture = mutationFixture('install-new', {
    failureAt: 'publishCandidate',
    failureErrors: { publishCandidate: publicationError },
    rollbackResult: {
      jobId: 'job-one',
      resolved: true,
      action: 'pre-publication-cleanup',
      failure: { stage: 'durable-move', category: 'C:\\private\\malformed' }
    }
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const failed = await waitForPhase(fixture.operationStore, queued.jobId, 'failed');

  assert.deepEqual(failed.outcome.failure, {
    stage: 'durable-move', category: 'sharing-violation'
  });
  assert.doesNotMatch(JSON.stringify(failed.outcome), /private|candidate|locked|stack|errno/i);
});

test('a durable committed recovery record prevents rollback when live validation returns an error late', async () => {
  const fixture = mutationFixture('update', {
    failureAt: 'validateLive',
    durableCommitAfterFailure: true
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const pending = await waitForPhase(fixture.operationStore, queued.jobId, 'cleanup-pending');

  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(fixture.calls.some(([name]) => name === 'isDurablyCommitted'), true);
  assert.equal(fixture.calls.some(([name]) => name === 'rollback'), false);
  assert.deepEqual(fixture.released, []);
});

test('rollback failure leaves durable recovery-required state and retains recovery inputs', async () => {
  const fixture = mutationFixture('update', { failureAt: 'validateLive' });
  const originalRollback = fixture.service.mutationRuntime.rollback;
  fixture.service.mutationRuntime.rollback = async context => {
    await originalRollback(context);
    throw new ModpackError('COMMIT_FAILED', 'rollback failed');
  };
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  const recovery = await waitForPhase(fixture.operationStore, queued.jobId, 'recovery-required');
  assert.equal(recovery.outcome.status, 'recovery-required');
  assert.deepEqual(recovery.outcome.actions, [{
    actionId: 'open-details', opaqueRef: 'outcome:job-one:recovery-required'
  }]);
  assert.equal(fixture.actionIssuances[0].automaticRecovery, false);
  assert.deepEqual(fixture.released, []);
});

test('successful terminal outcomes contain only normalized opaque actions from the issuer', async () => {
  const fixture = mutationFixture('update');
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  const completed = await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
  assert.deepEqual(completed.outcome.actions, [{
    actionId: 'open-details', opaqueRef: 'outcome:job-one:completed'
  }]);
  assert.equal(fixture.actionIssuances.length, 1);
  assert.equal(Object.isFrozen(fixture.actionIssuances[0]), true);
  assert.equal(fixture.actionIssuances[0].operationKind, 'update');
  assert.equal(fixture.actionIssuances[0].restorePointId, 'restore-new');
  assert.equal(fixture.actionIssuances[0].plan, fixture.plan);
});

test('invalid action issuance cannot leak authority or prevent a terminal job record', async () => {
  const fixture = mutationFixture('update');
  fixture.service.outcomeActionIssuer = {
    async issue() {
      return [{ actionId: 'open-details', opaqueRef: 'C:\\private\\server' }];
    }
  };
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  const completed = await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
  assert.deepEqual(completed.outcome.actions, []);
  assert.equal(completed.outcome.actionIssuanceFailed, true);
  assert.doesNotMatch(JSON.stringify(completed.outcome), /private|serverPath/i);
});

test('cleanup failure leaves healthy canonical bytes in cleanup-pending without rollback', async () => {
  const fixture = mutationFixture('update', { failureAt: 'cleanup' });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'cleanup-pending');
  assert.equal(fixture.calls.some(([name]) => name === 'rollback'), false);
  assert.deepEqual(fixture.released, []);
  assert.equal(fixture.operationStore.invalidTransitionRequests, 0);
});

test('outcome persistence failure after durable live validation never rolls back the healthy canonical server', async () => {
  const fixture = mutationFixture('update', { failureAt: 'persistOutcome' });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const pending = await waitForPhase(fixture.operationStore, queued.jobId, 'cleanup-pending');
  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(fixture.calls.some(([name]) => name === 'validateLive'), true);
  assert.equal(fixture.calls.some(([name]) => name === 'rollback'), false);
  assert.deepEqual(fixture.released, []);
  assert.equal(
    fixture.operationStore.phaseHistory.get(queued.jobId).includes('committed-healthy'),
    true
  );
});

test('operation-store failure immediately after durable commit reconciles through cleanup-pending without rollback', async () => {
  const fixture = mutationFixture('update', {
    failTransitionOnce: 'validating-live->committed-healthy'
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });

  const pending = await waitForPhase(fixture.operationStore, queued.jobId, 'cleanup-pending');
  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(fixture.calls.some(([name]) => name === 'rollback'), false);
  assert.deepEqual(fixture.operationStore.phaseHistory.get(queued.jobId).slice(-2), [
    'committed-healthy', 'cleanup-pending'
  ]);
});

test('durable job creation failure releases only the exact claimed workspace', async () => {
  const fixture = mutationFixture('install-new', { failCreate: true });
  await assert.rejects(
    fixture.service.startOperation({ planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices }),
    error => error.code === 'COMMIT_FAILED'
  );
  assert.deepEqual(fixture.released, ['job-one']);
  assert.equal(fixture.calls.length, 0);
});

test('execution choices reject authority-bearing strings before the one-use plan is claimed', async () => {
  const fixture = mutationFixture('update');
  await assert.rejects(
    fixture.service.startOperation({
      planId: 'plan-one',
      planFingerprint: FINGERPRINT,
      choices: { restorePointId: 'C:\\Servers\\unsafe' }
    }),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.deepEqual(fixture.released, []);
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
});

test('a claimed plan cannot be replayed for a second job', async () => {
  const fixture = mutationFixture('install-new');
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices
  });
  await assert.rejects(
    fixture.service.startOperation({ planId: 'plan-one', planFingerprint: FINGERPRINT, choices: fixture.choices }),
    error => error.code === 'PLAN_STALE'
  );
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
});
