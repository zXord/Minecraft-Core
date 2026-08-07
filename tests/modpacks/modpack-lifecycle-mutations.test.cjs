const assert = require('node:assert/strict');
const test = require('node:test');

const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { ModpackError, deepFreeze } = require('../../electron/services/modpacks/errors.cjs');
const { isLegalJobTransition } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');

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

test('downgrade cannot replace binaries without a compatible world restore point', async () => {
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
    service.startOperation({ planId: 'plan-downgrade', planFingerprint: FINGERPRINT, choices: {} }),
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
  constructor({ failCreate = false, failTransitionOnce = null } = {}) {
    this.failCreate = failCreate;
    this.failTransitionOnce = failTransitionOnce;
    this.records = new Map();
    this.phaseHistory = new Map();
  }

  async create(request) {
    if (this.failCreate) throw new ModpackError('COMMIT_FAILED', 'injected create failure');
    const record = {
      ...request,
      phase: 'queued',
      cancellationRequested: false,
      progress: null,
      outcome: null
    };
    this.records.set(request.jobId, record);
    this.phaseHistory.set(request.jobId, ['queued']);
    return deepFreeze(structuredClone(record));
  }

  async get(jobId) {
    const record = this.records.get(jobId);
    return record ? deepFreeze(structuredClone(record)) : null;
  }

  async transition(jobId, { expectedPhase, nextPhase, patch }) {
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
    failTransitionOnce: options.failTransitionOnce
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
    async runMutation(selector, mutationOptions, work) {
      calls.push(['coordinator', selector, mutationOptions.operation, mutationOptions.revisionMode]);
      await mutationOptions.quiesce({ operation: mutationOptions.operation, operationId: mutationOptions.operationId, selectors: [selector] });
      if (mutationOptions.signal.aborted) throw new ModpackError('CANCELLED', 'cancelled');
      return work({
        kind: 'mutation',
        operationId: mutationOptions.operationId,
        markDirty() { dirty = true; return true; }
      });
    }
  };
  const failureAt = options.failureAt || null;
  const gates = options.gates || {};
  const method = (name, result) => async context => {
    calls.push([name, context]);
    if (gates[name]) await gates[name].promise;
    if (failureAt === name) throw new ModpackError('COMMIT_FAILED', `injected ${name} failure`);
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
    createRestorePoint: method('createRestorePoint', { id: 'restore-new', verified: true }),
    buildCandidate: method('buildCandidate', { id: 'candidate-one' }),
    validateCandidate: method('validateCandidate', { healthy: true }),
    publishCandidate: method('publishCandidate', { id: 'committed-one' }),
    registerPublishedInstance: method('registerPublishedInstance', { instanceId: 'server-one' }),
    commitCandidate: method('commitCandidate', { id: 'committed-one' }),
    startFinal: method('startFinal', { running: true }),
    validateLive: method('validateLive', { healthy: true }),
    persistOutcome: method('persistOutcome', { contentRevision: 5 }),
    cleanup: method('cleanup'),
    rollback: method('rollback', { contentRevision: 5 }),
    abandonCandidate: method('abandonCandidate'),
    restorePriorState: method('restorePriorState')
  };
  if (options.durableCommitAfterFailure) {
    mutationRuntime.isDurablyCommitted = method('isDurablyCommitted', true);
  }
  const outcomeActionIssuer = options.issueOutcomeActions === false ? null : {
    async issue(context) {
      actionIssuances.push(context);
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
    outcomeActionIssuer
  });
  const choices = operationKind === 'downgrade'
    ? { restorePointId: 'restore-compatible' }
    : operationKind === 'rollback-restore-point'
      ? { restorePointId: 'restore-compatible' }
      : {};
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
      assert.deepEqual(phases, [
        'queued', 'preflight', 'staging', 'validating-candidate', 'committing', 'publishing',
        'published', 'registering', 'validating-live', 'committed-healthy', 'cleanup', 'completed'
      ]);
      assert.equal(fixture.calls.some(([name]) => name === 'createRestorePoint'), false);
      assert.equal(fixture.calls.some(([name]) => name === 'publishCandidate'), true);
      assert.equal(fixture.calls.some(([name]) => name === 'registerPublishedInstance'), true);
      assert.equal(fixture.calls.some(([name]) => name === 'commitCandidate'), false);
    } else {
      assert.deepEqual(phases, expectedExisting);
      assert.equal(fixture.calls.some(([name]) => name === 'createRestorePoint'), true);
      assert.equal(fixture.calls.some(([name]) => name === 'commitCandidate'), true);
      assert.equal(fixture.calls.some(([name]) => name === 'publishCandidate'), false);
    }
  });
}

test('a prior-running server is restarted only from the committed final directory', async () => {
  const fixture = mutationFixture('update', { priorRunning: true });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
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
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
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
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'committing');
  await assert.rejects(fixture.service.cancelJob(queued.jobId), error => error.code === 'PLAN_STALE');
  commitGate.resolve();
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
});

test('pre-commit failure records ordinary failure with no commit attempt', async () => {
  const fixture = mutationFixture('repair', { failureAt: 'validateCandidate' });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
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

test('post-commit validation failure durably rolls back before reporting an outcome', async () => {
  const fixture = mutationFixture('update', { failureAt: 'validateLive' });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
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

test('a durable committed recovery record prevents rollback when live validation returns an error late', async () => {
  const fixture = mutationFixture('update', {
    failureAt: 'validateLive',
    durableCommitAfterFailure: true
  });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
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
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
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
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
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
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
  });
  const completed = await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
  assert.deepEqual(completed.outcome.actions, []);
  assert.equal(completed.outcome.actionIssuanceFailed, true);
  assert.doesNotMatch(JSON.stringify(completed.outcome), /private|serverPath/i);
});

test('cleanup failure leaves healthy canonical bytes in cleanup-pending without rollback', async () => {
  const fixture = mutationFixture('update', { failureAt: 'cleanup' });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'cleanup-pending');
  assert.equal(fixture.calls.some(([name]) => name === 'rollback'), false);
  assert.deepEqual(fixture.released, []);
});

test('outcome persistence failure after durable live validation never rolls back the healthy canonical server', async () => {
  const fixture = mutationFixture('update', { failureAt: 'persistOutcome' });
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
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
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
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
    fixture.service.startOperation({ planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {} }),
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
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
  });
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
});

test('a claimed plan cannot be replayed for a second job', async () => {
  const fixture = mutationFixture('install-new');
  const queued = await fixture.service.startOperation({
    planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {}
  });
  await assert.rejects(
    fixture.service.startOperation({ planId: 'plan-one', planFingerprint: FINGERPRINT, choices: {} }),
    error => error.code === 'PLAN_STALE'
  );
  await waitForPhase(fixture.operationStore, queued.jobId, 'completed');
});
