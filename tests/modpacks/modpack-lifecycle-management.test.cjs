const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { isLegalJobTransition } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { ModpackError, deepFreeze } = require('../../electron/services/modpacks/errors.cjs');
const { ModpackStateRepository } = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');

const FINGERPRINT = 'a'.repeat(64);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runtime() {
  return {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
}

function managedState(files) {
  return {
    schemaVersion: 1,
    modpackManaged: true,
    source: {
      provider: 'github', repositoryId: '1001', releaseId: '2002', githubOwner: 'FixtureOrg', githubRepo: 'FixturePack',
      version: '1.2.3', title: 'Reviewed Pack'
    },
    runtime: runtime(),
    selectedOptionalFiles: [],
    installedAt: '2026-08-02T00:00:00.000Z',
    contentRevision: 3,
    manifest: {
      schemaVersion: 1,
      installationId: 'installation-managed',
      entries: [
        {
          path: 'mods/pack.jar', pathKey: 'mods/pack.jar', origin: 'pack',
          managementPolicy: 'replaceable-managed', role: 'mod', installedHash: sha256(files.pack),
          size: String(files.pack.length), priorBaseline: null
        },
        ...(files.modified ? [{
          path: 'mods/modified-managed.jar', pathKey: 'mods/modified-managed.jar', origin: 'pack',
          managementPolicy: 'replaceable-managed', role: 'mod', installedHash: sha256(files.modified),
          size: String(files.modified.length), priorBaseline: null
        }] : []),
        ...(files.additional ? [{
          path: 'mods/additional-managed.jar', pathKey: 'mods/additional-managed.jar', origin: 'runtime',
          managementPolicy: 'replaceable-managed', role: 'library', installedHash: sha256(files.additional),
          size: String(files.additional.length), priorBaseline: null
        }] : []),
        {
          path: 'mods/user-addon.jar', pathKey: 'mods/user-addon.jar', origin: 'user',
          managementPolicy: 'protected', role: 'mod', installedHash: sha256(files.user),
          size: String(files.user.length), priorBaseline: null
        }
      ]
    }
  };
}

function snapshotServerContent(root) {
  const result = {};
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && (entry.name === '.minecraft-core-state' || entry.name === '.minecraft-core.json')) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result[relative] = { type: 'directory' };
        visit(absolute, relative);
      } else {
        const bytes = fs.readFileSync(absolute);
        result[relative] = { type: 'file', size: bytes.length, sha256: sha256(bytes) };
      }
    }
  }
  visit(root);
  return result;
}

class MemoryOperationStore {
  constructor() {
    this.records = new Map();
    this.phases = new Map();
    this.nextId = 0;
    this.failNextGet = false;
  }

  async create(request) {
    const jobId = request.jobId ?? `job-generated-${++this.nextId}`;
    const value = {
      ...request, jobId, phase: 'queued', cancellationRequested: false, progress: null, outcome: null, events: [],
      type: 'minecraft-core-modpack-job', schemaVersion: 1, sequence: 0, swapStep: null,
      createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', terminalAt: null
    };
    this.records.set(jobId, value);
    this.phases.set(jobId, ['queued']);
    return deepFreeze(structuredClone(value));
  }

  async get(jobId) {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new ModpackError('COMMIT_FAILED', 'injected one-shot read failure');
    }
    const value = this.records.get(jobId);
    return value ? deepFreeze(structuredClone(value)) : null;
  }

  async transition(jobId, { expectedPhase, nextPhase, patch }) {
    const value = this.records.get(jobId);
    if (!value || value.phase !== expectedPhase || !isLegalJobTransition(expectedPhase, nextPhase, {
      operationKind: value.operationKind
    })) throw new ModpackError('PLAN_STALE', 'The job transition is stale');
    Object.assign(value, structuredClone(patch), { phase: nextPhase });
    value.sequence += 1;
    if (['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required'].includes(nextPhase)) value.terminalAt = value.updatedAt;
    this.phases.get(jobId).push(nextPhase);
    return deepFreeze(structuredClone(value));
  }

  async requestCancellation(jobId) {
    const value = this.records.get(jobId);
    if (!value || !isLegalJobTransition(value.phase, 'cancelling', {
      operationKind: value.operationKind
    })) throw new ModpackError('PLAN_STALE', 'The cancellation boundary has passed');
    value.phase = 'cancelling';
    value.cancellationRequested = true;
    this.phases.get(jobId).push('cancelling');
    return deepFreeze(structuredClone(value));
  }

  async appendEvent(jobId, event) {
    const value = this.records.get(jobId);
    if (!value || ['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required'].includes(value.phase)) {
      throw new ModpackError('PLAN_STALE', 'The job event is stale');
    }
    value.events.push(structuredClone(event));
    return deepFreeze(structuredClone(value));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fixture(t, { modifiedManaged = false, additionalManaged = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-management-'));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(path.join(serverPath, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(serverPath, 'world'), { recursive: true });
  const files = {
    pack: Buffer.from('pack bytes'),
    user: Buffer.from('user bytes'),
    ...(modifiedManaged ? { modified: Buffer.from('managed baseline bytes') } : {}),
    ...(additionalManaged ? { additional: Buffer.from('additional managed bytes') } : {})
  };
  fs.writeFileSync(path.join(serverPath, 'mods', 'pack.jar'), files.pack);
  fs.writeFileSync(path.join(serverPath, 'mods', 'user-addon.jar'), files.user);
  if (files.modified) fs.writeFileSync(path.join(serverPath, 'mods', 'modified-managed.jar'), files.modified);
  if (files.additional) fs.writeFileSync(path.join(serverPath, 'mods', 'additional-managed.jar'), files.additional);
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(serverPath, 'server.properties'), 'motd=keep me\n');
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({ contentRevision: 2, maxRam: 8 }));
  let tempId = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => `management-${++tempId}`
  });
  const stateRepository = new ModpackStateRepository({
    fsApi: fs,
    durableFs,
    clock: () => new Date('2026-08-02T01:00:00.000Z')
  });
  stateRepository.writeCandidate(serverPath, managedState(files));
  if (files.modified) fs.writeFileSync(path.join(serverPath, 'mods', 'modified-managed.jar'), 'user modified bytes');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { durableFs, serverPath, stateRepository };
}

function unmanagedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-files-only-'));
  const serverPath = path.join(root, 'candidate');
  fs.mkdirSync(serverPath);
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({ contentRevision: 0, maxRam: 4 }));
  fs.writeFileSync(path.join(serverPath, 'README.txt'), 'review before use\n');
  fs.writeFileSync(path.join(serverPath, 'start.bat'), '@echo supplied script must not run\r\n');
  let tempId = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => `files-only-${++tempId}`
  });
  const stateRepository = new ModpackStateRepository({
    fsApi: fs,
    durableFs,
    clock: () => new Date('2026-08-02T02:00:00.000Z')
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { serverPath, stateRepository };
}

function serviceForManagement({
  serverPath,
  stateRepository,
  operationKind,
  serverKind = 'existing',
  expectedContentRevision = 3,
  possibleNonRunnable = false,
  persistOutcome = null,
  stateEventSink = null,
  managementPlanner = null,
  outcomeActionIssuer = null,
  onPlanCreated = null,
  priorRunning = false
}) {
  const operationStore = new MemoryOperationStore();
  const calls = [];
  const plan = deepFreeze({
    fingerprint: FINGERPRINT,
    operation: { kind: operationKind, serverKind, instanceId: 'server-one', expectedContentRevision },
    ownership: {
      confirmation: {
        unchangedManagedRemovalCount: '1',
        preservedCategories: ['configuration', 'mod', 'world'],
        possibleNonRunnable,
        instanceRetained: true,
        worldsRetained: true
      }
    },
    requirements: { filesOnlySafetyConfirmed: operationKind === 'files-only' },
    inspection: { kind: operationKind === 'files-only' ? 'files-only' : 'prepared-server-pack' }
  });
  const planRegistry = {
    create(request) {
      onPlanCreated?.(request);
      return deepFreeze({
        planId: 'plan-generated-management',
        fingerprint: request.fingerprint,
        planView: request.sanitizedView,
        expiresAt: '2026-08-02T05:00:00.000Z'
      });
    },
    get() {},
    claim() {
      return deepFreeze({
        jobId: 'job-management', planId: 'plan-management', fingerprint: FINGERPRINT, plan,
        planView: {}, expiresAt: '2026-08-02T03:00:00.000Z', claimedAt: '2026-08-02T01:00:00.000Z'
      });
    },
    releaseClaim() { return true; }
  };
  const method = (name, result) => async context => {
    calls.push(name);
    return typeof result === 'function' ? result(context) : result;
  };
  const mutationRuntime = {
    resolveInstance: method('resolveInstance', { instanceId: 'server-one', serverPath, priorRunning: false }),
    suspendAutoRestart: method('suspendAutoRestart', { token: 'restart' }),
    quiesce: method('quiesce'),
    revalidate: method('revalidate'),
    createRestorePoint: method('createRestorePoint', { id: 'restore-management', verified: true }),
    buildCandidate: method('buildCandidate', { id: 'candidate' }),
    validateCandidate: method('validateCandidate', { healthy: true }),
    publishCandidate: method('publishCandidate', { id: 'published' }),
    registerPublishedInstance: method('registerPublishedInstance'),
    commitCandidate: method('commitCandidate', { id: 'committed' }),
    startFinal: method('startFinal'),
    validateLive: method('validateLive', { healthy: true }),
    persistOutcome: method('persistOutcome', persistOutcome || (({ jobId }) => stateRepository.detachCandidate(serverPath, {
      operationId: jobId, timestamp: '2026-08-02T01:00:00.000Z', contentRevision: 4
    }))),
    cleanup: method('cleanup'),
    rollback: method('rollback'),
    abandonCandidate: method('abandonCandidate'),
    restorePriorState: method('restorePriorState')
  };
  const mutationCoordinator = {
    async runMutation(selector, options, work) {
      await options.quiesce({ selectors: [selector], operationId: options.operationId });
      return work({ markDirty() { return true; } });
    }
  };
  const service = new ModpackLifecycleService({
    sourceResolver: { async resolveArtifactSetPlan() {} },
    artifactDownloader: { async downloadSet() {} },
    archiveInspector: { async inspectArchive() {} },
    inspectionLoader: { loadInspection() {} },
    planningAdapter: {
      async createPlan() {},
      ...(managementPlanner ? { createManagementPlan: managementPlanner } : {})
    },
    planRegistry,
    operationStore,
    mutationCoordinator,
    mutationRuntime,
    instanceResolver: {
      resolveInstance(instanceId) {
        if (instanceId !== 'server-one') throw new ModpackError('PLAN_STALE', 'Unknown instance');
        return { instanceId, serverPath, priorRunning };
      }
    },
    stateRepository,
    stateEventSink,
    outcomeActionIssuer
  });
  return { calls, operationStore, service };
}

async function waitForPhase(store, jobId, phase) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await store.get(jobId);
    if (job?.phase === phase) return job;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`job ${jobId} did not reach ${phase}: ${store.phases.get(jobId)?.join(', ')}`);
}

test('state and history accept the production resolved-instance contract', async (t) => {
  const context = fixture(t);
  const execution = serviceForManagement({
    ...context,
    operationKind: 'detach'
  });

  const state = await execution.service.getState('server-one');
  const history = await execution.service.listHistory('server-one', { cursor: null, limit: 50 });

  assert.equal(state.instanceId, 'server-one');
  assert.equal(state.modpackManaged, true);
  assert.deepEqual(history, { instanceId: 'server-one', items: [], nextCursor: null });
});

test('detach removes no server file while disabling active management', async (t) => {
  const context = fixture(t);
  const execution = serviceForManagement({
    ...context,
    operationKind: 'detach'
  });
  const before = snapshotServerContent(context.serverPath);

  const queued = await execution.service.startOperation({
    planId: 'plan-management', planFingerprint: FINGERPRINT, choices: {}
  });
  await waitForPhase(execution.operationStore, queued.jobId, 'completed');

  assert.deepEqual(snapshotServerContent(context.serverPath), before);
  assert.equal(context.stateRepository.read(context.serverPath).state.modpackManaged, false);
  assert.equal(execution.calls.includes('createRestorePoint'), true);
});

test('verification accepts the production resolved-instance contract and hashes managed content', async (t) => {
  const context = fixture(t);
  const issuances = [];
  const execution = serviceForManagement({
    ...context,
    operationKind: 'repair',
    outcomeActionIssuer: {
      async issue(value) {
        issuances.push(value);
        return [{ actionId: 'open-details', opaqueRef: `verify:${value.jobId}` }];
      }
    }
  });
  const before = snapshotServerContent(context.serverPath);

  const queued = await execution.service.verify('server-one');
  assert.equal(queued.operationKind, 'verify');
  const completed = await waitForPhase(execution.operationStore, queued.jobId, 'completed');

  assert.equal(completed.outcome.result.healthy, true);
  assert.equal(completed.outcome.result.checkedFiles, '1');
  assert.equal(completed.outcome.result.repairAvailable, false);
  assert.equal(completed.outcome.result.repair, null);
  assert.deepEqual(completed.outcome.result.mismatches, []);
  assert.deepEqual(completed.outcome.actions, [{
    actionId: 'open-details', opaqueRef: `verify:${queued.jobId}`
  }]);
  assert.equal(issuances[0].operationKind, 'verify');
  assert.equal(issuances[0].phase, 'completed');
  assert.equal(issuances[0].instanceId, 'server-one');
  assert.deepEqual(snapshotServerContent(context.serverPath), before);
  assert.deepEqual(execution.calls, []);
});

test('active discovery preserves multiple independently owned verification jobs', async (t) => {
  const context = fixture(t);
  const gate = deferred();
  const original = context.stateRepository.verifyManagedFiles.bind(context.stateRepository);
  context.stateRepository.verifyManagedFiles = async (...args) => { await gate.promise; return original(...args); };
  const execution = serviceForManagement({ ...context, operationKind: 'repair' });
  const first = await execution.service.verify('server-one');
  const second = await execution.service.verify('server-one');
  try {
    const discovered = await execution.service.getActiveJobs('server-one');
    assert.deepEqual(discovered.items.map(item => item.job.jobId).sort(), [first.jobId, second.jobId].sort());
    assert.equal(discovered.items.every(item => item.ownership === 'running'), true);
  } finally { gate.resolve(); }
  await Promise.all([execution.service.getJob(first.jobId), execution.service.getJob(second.jobId)]);
});

test('failed verification jobs retain a closed filesystem diagnostic without raw error text', async (t) => {
  // This fails if the generic failed-job diagnostic is limited to mutation workflows.
  const context = fixture(t);
  const error = new ModpackError('COMMIT_FAILED', 'The filesystem operation could not continue', {
    cause: new Error('C:\\private\\provider-name\\managed.jar raw exception')
  });
  Object.defineProperty(error, 'durableFailureKind', { value: 'access-denied' });
  Object.defineProperty(error, 'durableFailureStage', { value: 'source-open' });
  context.stateRepository.verifyManagedFiles = () => { throw error; };
  const execution = serviceForManagement({ ...context, operationKind: 'repair' });

  const queued = await execution.service.verify('server-one');
  const failed = await waitForPhase(execution.operationStore, queued.jobId, 'failed');

  assert.deepEqual(failed.outcome.failure, {
    stage: 'filesystem-operation', category: 'access-denied', boundary: 'source-open'
  });
  assert.deepEqual(failed.events, [{
    channel: 'log',
    message: 'The filesystem operation could not continue',
    details: { errorCode: 'COMMIT_FAILED' }
  }]);
  assert.doesNotMatch(JSON.stringify(failed.outcome), /private|provider|managed\.jar|exception/i);
  assert.doesNotMatch(JSON.stringify(failed.events), /private|provider|managed\.jar|exception/i);
});

test('verification cancellation cannot strand a job when hashing completes after cancellation', async (t) => {
  const context = fixture(t);
  const hashing = deferred();
  const entered = deferred();
  const issuedPhases = [];
  let repositorySignal = null;
  context.stateRepository.verifyManagedFiles = async (_serverPath, options) => {
    repositorySignal = options?.signal ?? null;
    entered.resolve();
    await hashing.promise;
    return { healthy: true, checkedFiles: '1', repairAvailable: false, repair: null, mismatches: [] };
  };
  const execution = serviceForManagement({
    ...context,
    operationKind: 'repair',
    outcomeActionIssuer: {
      async issue(value) {
        issuedPhases.push(value.phase);
        return [];
      }
    }
  });

  const queued = await execution.service.verify('server-one');
  await entered.promise;
  assert.equal(typeof repositorySignal?.addEventListener, 'function');
  assert.equal(repositorySignal.aborted, false);
  const cancelling = await execution.service.cancelJob(queued.jobId);
  assert.equal(cancelling.phase, 'cancelling');
  assert.equal(repositorySignal.aborted, true);
  hashing.resolve();

  const cancelled = await waitForPhase(execution.operationStore, queued.jobId, 'cancelled');
  assert.equal(cancelled.outcome.status, 'cancelled');
  assert.deepEqual(cancelled.events, [{
    channel: 'log',
    message: 'The modpack operation was cancelled',
    details: { errorCode: 'CANCELLED' }
  }]);
  assert.equal(execution.operationStore.phases.get(queued.jobId).includes('completed'), false);
  assert.deepEqual(issuedPhases, ['cancelled']);
});

test('verification retries a transient job read before publishing failure', async (t) => {
  const context = fixture(t);
  const verification = deferred();
  const entered = deferred();
  context.stateRepository.verifyManagedFiles = async () => {
    entered.resolve();
    await verification.promise;
    throw new ModpackError('COMMIT_FAILED', 'injected verification failure');
  };
  const execution = serviceForManagement({ ...context, operationKind: 'repair' });

  const queued = await execution.service.verify('server-one');
  await entered.promise;
  execution.operationStore.failNextGet = true;
  verification.resolve();
  await new Promise(resolve => setImmediate(resolve));

  const failed = await waitForPhase(execution.operationStore, queued.jobId, 'failed');
  assert.equal(failed.outcome.status, 'failed');
});

test('verification completion owns settlement before issuing terminal actions', async (t) => {
  const context = fixture(t);
  const actionIssuance = deferred();
  const actionEntered = deferred();
  const execution = serviceForManagement({
    ...context,
    operationKind: 'repair',
    outcomeActionIssuer: {
      async issue() {
        actionEntered.resolve();
        await actionIssuance.promise;
        return [];
      }
    }
  });

  const queued = await execution.service.verify('server-one');
  await actionEntered.promise;
  let cancellationSettled = false;
  const cancellation = execution.service.cancelJob(queued.jobId)
    .finally(() => { cancellationSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellationSettled, false);
  actionIssuance.resolve();

  const completed = await waitForPhase(execution.operationStore, queued.jobId, 'completed');
  assert.equal((await cancellation).phase, 'completed');
  assert.equal(completed.outcome.status, 'completed');
  assert.equal(execution.operationStore.phases.get(queued.jobId).includes('cancelling'), false);
});

test('verify offers a targeted repair only when a managed file differs', async (t) => {
  const context = fixture(t);
  fs.writeFileSync(path.join(context.serverPath, 'mods', 'pack.jar'), 'changed pack bytes');
  const execution = serviceForManagement({
    ...context,
    operationKind: 'repair'
  });

  const queued = await execution.service.verify('server-one');
  const completed = await waitForPhase(execution.operationStore, queued.jobId, 'completed');

  assert.equal(completed.outcome.result.healthy, false);
  assert.equal(completed.outcome.result.repairAvailable, true);
  assert.deepEqual(completed.outcome.result.repair, {
    operationKind: 'repair',
    mismatchCount: '1'
  });
  assert.deepEqual(completed.outcome.result.mismatches, [{
    entryName: 'mods/pack.jar',
    origin: 'pack',
    role: 'mod',
    status: 'modified'
  }]);
});

test('files-only import publishes an unmanaged instance without running supplied runtime content', async (t) => {
  const context = fixture(t);
  const execution = serviceForManagement({
    ...context,
    operationKind: 'files-only',
    serverKind: 'new',
    expectedContentRevision: 0,
    possibleNonRunnable: true,
    persistOutcome: () => ({ lifecycleMode: 'files-only' })
  });

  const queued = await execution.service.startOperation({
    planId: 'plan-management', planFingerprint: FINGERPRINT, choices: {}
  });
  const completed = await waitForPhase(execution.operationStore, queued.jobId, 'completed');

  assert.equal(queued.operationKind, 'import-files-only-new');
  assert.equal(completed.outcome.operationKind, 'import-files-only-new');
  assert.equal(execution.calls.includes('publishCandidate'), true);
  assert.equal(execution.calls.includes('registerPublishedInstance'), true);
  assert.equal(execution.calls.includes('validateLive'), true);
  for (const forbidden of ['createRestorePoint', 'validateCandidate', 'startFinal']) {
    assert.equal(execution.calls.includes(forbidden), false, forbidden);
  }
});

test('files-only persistence failure after no-health finalization never removes the registered canonical server', async (t) => {
  const context = fixture(t);
  const execution = serviceForManagement({
    ...context,
    operationKind: 'files-only',
    serverKind: 'new',
    expectedContentRevision: 0,
    possibleNonRunnable: true,
    persistOutcome: () => { throw new ModpackError('COMMIT_FAILED', 'injected files-only persistence failure'); }
  });

  const queued = await execution.service.startOperation({
    planId: 'plan-management', planFingerprint: FINGERPRINT, choices: {}
  });
  const pending = await waitForPhase(execution.operationStore, queued.jobId, 'cleanup-pending');

  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(execution.calls.includes('publishCandidate'), true);
  assert.equal(execution.calls.includes('registerPublishedInstance'), true);
  assert.equal(execution.calls.includes('validateLive'), true);
  assert.equal(execution.calls.includes('rollback'), false);
});

test('files-only candidate records provenance without creating active ownership', (t) => {
  const context = unmanagedFixture(t);
  const before = snapshotServerContent(context.serverPath);

  const written = context.stateRepository.recordFilesOnlyCandidate(context.serverPath, {
    operationId: 'job-files-only',
    timestamp: '2026-08-02T02:00:00.000Z',
    contentRevision: 1,
    source: {
      provider: 'local', importId: 'import-reviewed', artifactSha256: 'b'.repeat(64),
      version: 'local-import', title: 'Reviewed local archive'
    },
    provenance: {
      classification: 'files-only',
      inspectionFingerprint: 'c'.repeat(64)
    }
  });

  assert.equal(written.state.modpackManaged, false);
  assert.equal(written.state.lifecycleMode, 'files-only');
  assert.equal(written.state.manifestId, null);
  assert.equal(written.manifest, null);
  assert.equal(context.stateRepository.read(context.serverPath).state.source.importId, 'import-reviewed');
  assert.deepEqual(context.stateRepository.listHistory(context.serverPath).items.map(item => item.kind), ['import-files-only']);
  assert.deepEqual(snapshotServerContent(context.serverPath), before);
});

test('uninstall creates a restore point but skips runtime health for a files-only outcome', async (t) => {
  const context = fixture(t);
  const execution = serviceForManagement({
    ...context,
    operationKind: 'uninstall',
    possibleNonRunnable: true,
    persistOutcome: () => ({ lifecycleMode: 'files-only' })
  });

  const queued = await execution.service.startOperation({
    planId: 'plan-management', planFingerprint: FINGERPRINT, choices: {}
  });
  const completed = await waitForPhase(execution.operationStore, queued.jobId, 'completed');

  assert.equal(queued.operationKind, 'uninstall-managed');
  assert.equal(completed.outcome.operationKind, 'uninstall-managed');
  assert.equal(execution.calls.includes('createRestorePoint'), true);
  assert.equal(execution.calls.includes('commitCandidate'), true);
  assert.equal(execution.calls.includes('validateLive'), true);
  for (const forbidden of ['validateCandidate', 'startFinal']) {
    assert.equal(execution.calls.includes(forbidden), false, forbidden);
  }
});

test('non-runnable uninstall tracking failure after durable finalization never rolls back canonical bytes', async (t) => {
  const context = fixture(t);
  const execution = serviceForManagement({
    ...context,
    operationKind: 'uninstall',
    possibleNonRunnable: true,
    persistOutcome: () => { throw new ModpackError('COMMIT_FAILED', 'injected tracking failure'); }
  });

  const queued = await execution.service.startOperation({
    planId: 'plan-management', planFingerprint: FINGERPRINT, choices: {}
  });
  const pending = await waitForPhase(execution.operationStore, queued.jobId, 'cleanup-pending');

  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(execution.calls.includes('validateLive'), true);
  assert.equal(execution.calls.includes('rollback'), false);
});

test('uninstall removes only unchanged managed files while retaining the instance, worlds, and modified or protected content', (t) => {
  const context = fixture(t, { modifiedManaged: true });
  const before = snapshotServerContent(context.serverPath);

  const written = context.stateRepository.uninstallCandidate(context.serverPath, {
    operationId: 'job-uninstall',
    timestamp: '2026-08-02T02:30:00.000Z',
    contentRevision: 4,
    restorePointId: 'restore-before-uninstall',
    restorePointSha256: 'a'.repeat(64),
    confirmation: {
      unchangedManagedRemovalCount: '1',
      preservedCategories: ['configuration', 'mod', 'world'],
      possibleNonRunnable: true,
      instanceRetained: true,
      worldsRetained: true
    },
    removePathKeys: ['mods/pack.jar']
  });

  assert.equal(fs.existsSync(context.serverPath), true);
  assert.equal(fs.existsSync(path.join(context.serverPath, 'mods', 'pack.jar')), false);
  for (const retained of ['mods/modified-managed.jar', 'mods/user-addon.jar', 'world/level.dat', 'server.properties']) {
    const afterEntry = snapshotServerContent(context.serverPath)[retained];
    assert.deepEqual(afterEntry, before[retained], retained);
  }
  assert.equal(written.state.modpackManaged, false);
  assert.equal(written.state.lifecycleMode, 'files-only');
  assert.equal(written.state.manifestId, null);
  assert.equal(written.manifest, null);
  assert.deepEqual(written.confirmation, {
    filesRemoved: '1',
    preservedModifiedManagedFiles: '1',
    possibleNonRunnable: true,
    instanceRetained: true,
    worldsRetained: true
  });
  const history = context.stateRepository.listHistory(context.serverPath).items;
  assert.deepEqual(history.map(item => item.kind), ['uninstall']);
  assert.equal(history[0].restorePointId, 'restore-before-uninstall');
  assert.equal(history[0].restorePointSha256, 'a'.repeat(64));
});

test('state and history expose closed public DTOs and a durable state commit emits the same sanitized state', async (t) => {
  const context = fixture(t);
  const events = [];
  const execution = serviceForManagement({
    ...context,
    operationKind: 'detach',
    stateEventSink: event => events.push(event)
  });

  const queued = await execution.service.startOperation({
    planId: 'plan-management', planFingerprint: FINGERPRINT, choices: {}
  });
  await waitForPhase(execution.operationStore, queued.jobId, 'completed');

  const state = await execution.service.getState('server-one');
  assert.deepEqual(state, {
    type: 'modpack-state',
    instanceId: 'server-one',
    modpackManaged: false,
    lifecycleMode: 'detached',
    source: {
      provider: 'github', repositoryId: '1001', releaseId: '2002', githubOwner: 'FixtureOrg', githubRepo: 'FixturePack',
      version: '1.2.3', title: 'Reviewed Pack'
    },
    runtime: runtime(),
    selectedOptionalFiles: [],
    installedAt: '2026-08-02T00:00:00.000Z',
    contentRevision: 4,
    managedFileCount: '1'
  });
  assert.deepEqual(events, [state]);

  const history = await execution.service.listHistory('server-one', { cursor: null, limit: 1 });
  assert.equal(history.instanceId, 'server-one');
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].kind, 'detach');
  assert.equal(history.nextCursor, null);
  assert.doesNotMatch(JSON.stringify({ state, history, events }), /(?:serverPath|path|url|cache|workspace|token|secret|password)/i);
});

test('uninstall aborts a final revalidation race before removing any unchanged managed sibling', (t) => {
  const context = fixture(t, { additionalManaged: true });
  const racedPath = path.join(context.serverPath, 'mods', 'pack.jar');
  let racedLstats = 0;
  const racingFs = {
    ...fs,
    lstatSync(candidate, options) {
      if (path.resolve(candidate) === path.resolve(racedPath) && ++racedLstats === 3) {
        fs.writeFileSync(racedPath, 'external mutation during final validation');
      }
      return fs.lstatSync(candidate, options);
    }
  };
  const repository = new ModpackStateRepository({
    fsApi: racingFs,
    durableFs: context.durableFs,
    clock: () => new Date('2026-08-02T03:00:00.000Z')
  });

  assert.throws(() => repository.uninstallCandidate(context.serverPath, {
    operationId: 'job-uninstall-race',
    timestamp: '2026-08-02T03:00:00.000Z',
    contentRevision: 4,
    confirmation: {
      unchangedManagedRemovalCount: '2',
      preservedCategories: ['configuration', 'mod', 'world'],
      possibleNonRunnable: true,
      instanceRetained: true,
      worldsRetained: true
    },
    removePathKeys: ['mods/additional-managed.jar', 'mods/pack.jar']
  }), error => error.code === 'PLAN_STALE');

  assert.equal(fs.existsSync(path.join(context.serverPath, 'mods', 'additional-managed.jar')), true);
  assert.equal(fs.existsSync(racedPath), true);
  assert.equal(context.stateRepository.read(context.serverPath).state.modpackManaged, true);
  assert.deepEqual(context.stateRepository.listHistory(context.serverPath).items, []);
});

test('uninstall rejects a reparse substitution without touching its external target', (t) => {
  const context = fixture(t);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-uninstall-external-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const externalPack = path.join(external, 'pack.jar');
  fs.writeFileSync(externalPack, 'pack bytes');
  const modsPath = path.join(context.serverPath, 'mods');
  fs.renameSync(modsPath, path.join(context.serverPath, 'mods-original'));
  try {
    fs.symlinkSync(external, modsPath, 'junction');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('junction creation requires Windows privilege');
      return;
    }
    throw error;
  }

  assert.throws(() => context.stateRepository.uninstallCandidate(context.serverPath, {
    operationId: 'job-uninstall-reparse',
    timestamp: '2026-08-02T03:30:00.000Z',
    contentRevision: 4,
    confirmation: {
      unchangedManagedRemovalCount: '1',
      preservedCategories: ['configuration', 'mod', 'world'],
      possibleNonRunnable: true,
      instanceRetained: true,
      worldsRetained: true
    },
    removePathKeys: ['mods/pack.jar']
  }), error => error.code === 'PLAN_STALE');

  assert.equal(fs.readFileSync(externalPack, 'utf8'), 'pack bytes');
  assert.equal(context.stateRepository.read(context.serverPath).state.modpackManaged, true);
});

test('verify rejects a managed-file mutation that occurs after that file was hashed', async (t) => {
  const context = fixture(t, { additionalManaged: true });
  const triggerPath = path.join(context.serverPath, 'mods', 'pack.jar');
  const racedPath = path.join(context.serverPath, 'mods', 'additional-managed.jar');
  let triggered = false;
  const racingFs = {
    ...fs,
    lstatSync(candidate, options) {
      if (!triggered && path.resolve(candidate) === path.resolve(triggerPath)) {
        triggered = true;
        fs.writeFileSync(racedPath, 'mutated after its verification pass');
      }
      return fs.lstatSync(candidate, options);
    }
  };
  const repository = new ModpackStateRepository({
    fsApi: racingFs,
    durableFs: context.durableFs,
    clock: () => new Date('2026-08-02T04:00:00.000Z')
  });

  await assert.rejects(
    repository.verifyManagedFiles(context.serverPath),
    error => error.code === 'PLAN_STALE'
  );
});

test('verify maps deletion between hashing and the identity recheck to a stale-plan result', async (t) => {
  const context = fixture(t);
  const racedPath = path.join(context.serverPath, 'mods', 'pack.jar');
  let racedLstats = 0;
  const racingFs = {
    ...fs,
    lstatSync(candidate, options) {
      if (path.resolve(candidate) === path.resolve(racedPath) && ++racedLstats === 2) {
        fs.unlinkSync(racedPath);
      }
      return fs.lstatSync(candidate, options);
    }
  };
  const repository = new ModpackStateRepository({
    fsApi: racingFs,
    durableFs: context.durableFs,
    clock: () => new Date('2026-08-02T04:30:00.000Z')
  });

  await assert.rejects(
    repository.verifyManagedFiles(context.serverPath),
    error => error.code === 'PLAN_STALE'
  );
});

test('public history pagination resumes from its opaque cursor after repository restart', async (t) => {
  const context = fixture(t);
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    context.stateRepository.appendHistory(context.serverPath, {
      schemaVersion: 1,
      operationId: `history-${sequence}`,
      sequence,
      kind: sequence === 3 ? 'repair' : 'upgrade',
      outcome: 'completed',
      timestamp: `2026-08-02T0${sequence}:00:00.000Z`,
      sourceRevision: sequence,
      targetRevision: sequence + 1,
      sourceRuntime: runtime(),
      targetRuntime: runtime()
    });
  }
  const firstService = serviceForManagement({ ...context, operationKind: 'repair' }).service;
  const first = await firstService.listHistory('server-one', { cursor: null, limit: 2 });
  assert.deepEqual(first.items.map(item => item.operationId), ['history-3', 'history-2']);
  assert.equal(typeof first.nextCursor, 'string');

  const restartedRepository = new ModpackStateRepository({
    fsApi: fs,
    durableFs: context.durableFs,
    clock: () => new Date('2026-08-02T05:00:00.000Z')
  });
  const restartedService = serviceForManagement({
    serverPath: context.serverPath,
    stateRepository: restartedRepository,
    operationKind: 'repair'
  }).service;
  const second = await restartedService.listHistory('server-one', { cursor: first.nextCursor, limit: 2 });

  assert.deepEqual(second.items.map(item => item.operationId), ['history-1']);
  assert.equal(second.nextCursor, null);
  assert.doesNotMatch(JSON.stringify({ first, second }), /(?:serverPath|path|url|cache|workspace|token|secret|password)/i);
});

test('detach planning is derived from current managed state without an inspection or renderer source authority', async (t) => {
  const context = fixture(t);
  let adapterInput = null;
  const execution = serviceForManagement({
    ...context,
    operationKind: 'detach',
    managementPlanner: async input => {
      adapterInput = input;
      return {
        plan: deepFreeze({
          fingerprint: FINGERPRINT,
          operation: {
            kind: 'detach', serverKind: 'existing', instanceId: 'server-one', expectedContentRevision: 3
          }
        }),
        sanitizedView: {
          operationKind: 'detach',
          server: { id: 'server-one', contentRevision: 3 },
          changes: { removed: 0, preserved: 4 },
          warnings: ['All server files will remain in place.']
        },
        planningSessionId: 'management-session-one'
      };
    }
  });

  const created = await execution.service.createManagementPlan({
    instanceId: 'server-one',
    operationKind: 'detach'
  });

  assert.deepEqual(created, {
    planId: 'plan-generated-management',
    planFingerprint: FINGERPRINT,
    planView: {
      operationKind: 'detach',
      server: { id: 'server-one', contentRevision: 3 },
      changes: { removed: 0, preserved: 4 },
      warnings: ['All server files will remain in place.']
    },
    expiresAt: '2026-08-02T05:00:00.000Z'
  });
  assert.equal(adapterInput.request.operationKind, 'detach');
  assert.equal(adapterInput.currentState.state.source.releaseId, '2002');
  assert.equal(adapterInput.currentState.state.contentRevision, 3);
  assert.equal(adapterInput.instance.instanceId, 'server-one');
  assert.equal(adapterInput.instance.serverPath, context.serverPath);
  assert.equal(adapterInput.instance.priorRunning, false);
  assert.doesNotMatch(JSON.stringify(created), /(?:serverPath|path|url|cache|workspace|token|secret|password|inspection)/i);
});

test('management planning tells the planner whether Minecraft Core runs the server', async (t) => {
  // A review of a running server refuses up front what Start, which stops the
  // server first, could only refuse after the stop.
  for (const priorRunning of [true, false]) {
    const context = fixture(t);
    let adapterInput = null;
    const execution = serviceForManagement({
      ...context,
      operationKind: 'uninstall',
      priorRunning,
      managementPlanner: async input => {
        adapterInput = input;
        return {
          plan: deepFreeze({
            fingerprint: FINGERPRINT,
            operation: { kind: 'uninstall', serverKind: 'existing', instanceId: 'server-one', expectedContentRevision: 3 }
          }),
          sanitizedView: { operationKind: 'uninstall' },
          planningSessionId: 'management-running-session'
        };
      }
    });
    await execution.service.createManagementPlan({ instanceId: 'server-one', operationKind: 'uninstall' });
    assert.deepEqual(adapterInput.instance, { instanceId: 'server-one', serverPath: context.serverPath, priorRunning });
  }
});

test('management planning forwards safe progress and completes only after registering the reviewed plan', async (t) => {
  const context = fixture(t);
  let registered = false;
  const observed = [];
  const execution = serviceForManagement({
    ...context,
    operationKind: 'detach',
    onPlanCreated() { registered = true; },
    managementPlanner: async ({ request, onProgress }) => {
      onProgress({ phase: 'scanning-server' });
      onProgress({ phase: 'calculating-changes' });
      return {
        plan: deepFreeze({
          fingerprint: FINGERPRINT,
          operation: {
            kind: request.operationKind,
            serverKind: 'existing',
            instanceId: request.instanceId,
            expectedContentRevision: 3,
            downgrade: false
          }
        }),
        sanitizedView: { operationKind: 'detach' },
        planningSessionId: 'management-progress-session'
      };
    }
  });

  const created = await execution.service.createManagementPlan({
    instanceId: 'server-one',
    operationKind: 'detach'
  }, {
    onProgress(event) {
      if (event.phase === 'scanning-server') throw new Error('renderer observer failed');
      observed.push({ phase: event.phase, registered });
    }
  });

  assert.equal(created.planId, 'plan-generated-management');
  assert.deepEqual(observed, [
    { phase: 'calculating-changes', registered: false },
    { phase: 'complete', registered: true }
  ]);
});

test('management planning admits only the four state-derived operations and binds opaque selections to the reviewed plan', async (t) => {
  const context = fixture(t);
  const requests = [];
  const execution = serviceForManagement({
    ...context,
    operationKind: 'repair',
    managementPlanner: async ({ request }) => {
      requests.push(request);
      const plan = {
        fingerprint: FINGERPRINT,
        operation: {
          kind: request.operationKind,
          serverKind: 'existing',
          instanceId: request.instanceId,
          expectedContentRevision: 3,
          downgrade: false
        },
        ...(request.operationKind === 'rollback-restore-point'
          ? { restorePoints: [{ id: request.selectionRef, sourceRevision: 2, worldIncluded: true }] }
          : {})
      };
      return {
        plan: deepFreeze(plan),
        sanitizedView: {
          operationKind: request.operationKind,
          selectionRequired: request.selectionRef !== null
        },
        planningSessionId: `session-${request.operationKind}`
      };
    }
  });
  const cases = [
    { instanceId: 'server-one', operationKind: 'detach' },
    { instanceId: 'server-one', operationKind: 'uninstall' },
    { instanceId: 'server-one', operationKind: 'repair', selectionRef: 'asset-choice-one' },
    { instanceId: 'server-one', operationKind: 'rollback-restore-point', selectionRef: 'restore-point-one' }
  ];

  for (const request of cases) {
    const created = await execution.service.createManagementPlan(request);
    assert.equal(created.planView.operationKind, request.operationKind);
  }
  assert.deepEqual(requests, cases.map(request => ({ ...request, selectionRef: request.selectionRef ?? null })));

  for (const request of [
    { instanceId: 'server-one', operationKind: 'install' },
    { instanceId: 'server-one', operationKind: 'detach', selectionRef: 'unexpected' },
    { instanceId: 'server-one', operationKind: 'rollback-restore-point' },
    { instanceId: 'server-one', operationKind: 'repair', source: { provider: 'github' } },
    { instanceId: 'server-one', operationKind: 'repair', serverPath: 'C:\\private' }
  ]) {
    await assert.rejects(execution.service.createManagementPlan(request), error => error.code === 'INVALID_REQUEST');
  }
  assert.equal(requests.length, cases.length);
});

test('management planning rejects an adapter plan that drifts from the resolved instance or current revision', async (t) => {
  const context = fixture(t);
  const execution = serviceForManagement({
    ...context,
    operationKind: 'repair',
    managementPlanner: async () => ({
      plan: deepFreeze({
        fingerprint: FINGERPRINT,
        operation: {
          kind: 'repair', serverKind: 'existing', instanceId: 'server-one', expectedContentRevision: 2
        }
      }),
      sanitizedView: {},
      planningSessionId: 'stale-management-session'
    })
  });

  await assert.rejects(
    execution.service.createManagementPlan({ instanceId: 'server-one', operationKind: 'repair' }),
    error => error.code === 'PLAN_STALE'
  );
});
