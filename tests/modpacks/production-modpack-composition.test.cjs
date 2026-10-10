const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { createProductionModpackComposition } = require('../../electron/bootstrap/create-production-modpack-composition.cjs');
const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { createModpackPaths } = require('../../electron/services/modpacks/paths.cjs');
const { SelectionRegistry } = require('../../electron/services/modpacks/local/selection-registry.cjs');
const { computePreflightPlanFingerprint } = require('../../electron/services/modpacks/planning/plan-fingerprint.cjs');
const {
  PersistentCandidateHashService
} = require('../../electron/services/modpacks/planning/candidate-hash-service.cjs');
const { scanManifest } = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');
const {
  createArtifactSetPlan,
  finalizeVerifiedArtifactSet
} = require('../../electron/services/modpacks/contracts.cjs');

const SHA256 = 'a'.repeat(64);
const SHA512 = 'b'.repeat(128);

function verifiedLocalSet() {
  const plan = createArtifactSetPlan({
    provider: 'local',
    artifactSet: {
      kind: 'single', groupingScheme: 'single', primaryPartId: 'local-0001',
      providerImmutable: false, attestationStatus: 'unavailable',
      parts: [{ partId: 'local-0001', fileName: 'pack.zip', size: '1', updatedAt: '2026-08-02T00:00:00.000Z' }]
    }
  });
  return finalizeVerifiedArtifactSet(plan, [{
    partId: 'local-0001', measuredSize: '1', sha256: SHA256, sha512: SHA512
  }]);
}

function noOpMutationRuntime() {
  const runtime = {};
  for (const method of [
    'resolveInstance', 'suspendAutoRestart', 'quiesce', 'revalidate', 'createRestorePoint', 'buildCandidate',
    'validateCandidate', 'publishCandidate', 'registerPublishedInstance', 'commitCandidate', 'startFinal',
    'validateLive', 'persistOutcome', 'cleanup', 'rollback', 'abandonCandidate', 'restorePriorState'
  ]) runtime[method] = async () => null;
  return runtime;
}

function fixture(t, { useDefaultMutationRuntime = false, useDefaultArchiveRuntime = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-composition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(userDataPath, { recursive: true });
  const paths = { userData: userDataPath, modpacks: createModpackPaths(userDataPath) };
  fs.mkdirSync(paths.modpacks.cache, { recursive: true });
  let temporary = 0;
  const durableFsFactory = () => createDurableFs({
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
    allowedRoots: [root],
    tempNameFactory: () => `composition-${++temporary}`
  });
  let uuid = 0;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`;
  let downloaderCalls = 0;
  const retentionCalls = [];
  let pruneCalls = 0;
  const rendererEvents = [];
  const artifactCache = {
    root: paths.modpacks.cache,
    retain() {}, release() {},
    async commitPart() { throw new Error('not used'); },
    async materializeSet() { throw new Error('not used'); },
    pathForSha256() { return path.join(paths.modpacks.cache, SHA256); },
    async removeIfUnreferenced() { return true; },
    async retainForOutcome(value) { retentionCalls.push(value); return true; },
    async prune() { pruneCalls += 1; return { removed: 0, reclaimedBytes: 0 }; }
  };
  const artifactDownloader = {
    async downloadSet() { downloaderCalls += 1; throw new Error('local verified set was downloaded again'); },
    async downloadPart() { throw new Error('not used'); }
  };
  const store = {
    values: new Map([['instances', []]]),
    get(key) { return this.values.get(key); },
    set(key, value) { this.values.set(key, value); }
  };
  const providers = {
    modrinth: { async getVersion() {}, async resolveArtifactSetPlan() {} },
    github: { repository() {}, async getRelease() {}, async buildArtifactSetPlan() {}, async getRepositoryIdentity() {}, async listUploadedAssets() {} }
  };
  const recoveryRegistry = {
    async initialize() { return { records: await this.listActive(), pendingTerminalPublications: [] }; },
    async listActive() { return []; },
    async create(value) { return value; },
    async load() { return null; },
    async transition(_jobId, request) { return { phase: request.nextPhase }; },
    async finish() { return null; }
  };
  const recoveryService = {
    async recover() {}, async rollback() {}, async retryCommittedCleanup() {},
    async recoverWithLease() {}, async rollbackWithLease() {}, async failNewWithLease() {}
  };
  const runtimePolicy = {
    async suspend() { return { held: true }; },
    async ensureStopped() { return { stopped: true }; },
    async adoptValidatedHandoff() { return { adopted: true }; },
    async restoreAutoRestart() { return { restored: true }; }
  };
  const healthValidator = {
    async validateCandidate() { return { ok: true }; },
    async validateLive() { return { evidence: { ok: true }, handoff: null }; }
  };
  const now = Date.parse('2026-08-02T00:00:00.000Z');
  let workerOptions = null;
  const input = {
      app: {}, artifactCache, artifactDownloader,
      clock: { now: () => now },
      coordinator: { async runMutation() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      durableFsFactory, fsPromises: fsp, fsSync: fs,
      clientDurableFsFactory: durableFsFactory,
      clientWorkerDurableConfig: { workerPath: path.join(root, 'worker.exe'), workerManifestPath: path.join(root, 'worker.json'), appOwnedRoot: path.join(userDataPath, 'archive-worker', 'durable-fs') },
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => rendererEvents.push(args) } }),
      instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath: path.join(root, instanceId), priorRunning: false }; } },
      Notification: null,
      paths,
      processFactory() {},
      providers,
      randomBytes: size => Buffer.alloc(size, 7),
      randomUUID,
      rawRecoveryServices: { registry: recoveryRegistry, recoveryService, runtimePolicy, healthValidator },
      recoveryServices: { registry: recoveryRegistry, recoveryService, runtimePolicy, healthValidator },
      reparseInspector: { async isReparsePoint() { return false; } },
      runtimeRoots: { resourcesPath: root, runtimeRoot: root, isPackaged: false, arch: 'x64' },
      selectionRegistry: new SelectionRegistry({ clock: () => now, randomId: () => 'x'.repeat(32) }),
      shell: { async openPath() { return ''; } },
      store,
      userDataPath,
      workerFactory(options) {
        workerOptions = options;
        return { async run() { throw new Error('not used'); } };
      }
  };
  if (!useDefaultArchiveRuntime) {
    input.archiveRuntime = {
      resourcesRoot: root, runtimeLayout: 'repository',
      workerPath: path.join(root, 'worker.exe'), workerManifestPath: path.join(root, 'worker.json')
    };
  }
  if (!useDefaultMutationRuntime) input.mutationRuntime = noOpMutationRuntime();
  return {
    get downloaderCalls() { return downloaderCalls; },
    get retentionCalls() { return retentionCalls; },
    get pruneCalls() { return pruneCalls; },
    get workerOptions() { return workerOptions; },
    rendererEvents,
    input
  };
}

test('production active discovery uses registration authority without reading a swapping canonical tree and shares recovery ownership', async t => {
  const f = fixture(t);
  f.input.store.set('instances', [{ id: 'server-one', type: 'server', path: path.join(f.input.userDataPath, 'temporarily-swapping') }]);
  f.input.instanceResolver.resolveInstance = async () => { throw new Error('canonical tree is unavailable during swap'); };
  const composition = await createProductionModpackComposition(f.input);
  t.after(() => composition.dispose());
  await composition.initialize();
  assert.deepEqual(await composition.lifecycleService.getActiveJobs('server-one'), { serverId: 'server-one', items: [] });
  await assert.rejects(composition.lifecycleService.getActiveJobs('unknown-server'));
  const record = { jobId: 'job-owned', operationKind: 'repair', phase: 'cleanup', swapStep: 'candidate-published', target: { kind: 'existing', stableServerId: 'server-one', path: path.join(f.input.userDataPath, 'temporarily-swapping') } };
  f.input.rawRecoveryServices.registry.listActive = async () => [record];
  composition.lifecycleService.activeOperations.set('job-owned', { serverId: 'server-one' });
  assert.deepEqual(await composition.recoveryService.listRecovery(), { items: [] });
  composition.lifecycleService.activeOperations.delete('job-owned');
  assert.equal((await composition.recoveryService.listRecovery()).items.length, 1);
});

test('production composition exposes guarded client services and unavailable pairing does not break initialization', async t => {
  const f = fixture(t);
  const registryRoot = path.join(f.input.userDataPath, 'client-packs');
  fs.mkdirSync(registryRoot, { recursive: true });
  fs.writeFileSync(path.join(registryRoot, 'companions.json'), '{bad registry');
  const composition = await createProductionModpackComposition(f.input);
  t.after(() => composition.dispose());
  await composition.initialize();
  assert.equal(typeof composition.clientPackService?.preview, 'function');
  assert.equal(typeof composition.clientPackIntegration?.beginManagedLaunch, 'function');
  assert.equal(typeof composition.companionService?.getStatus, 'function');
  await assert.rejects(composition.managementSessionBroker.acquire('unregistered'), { code: 'INVALID_REQUEST' });
  await assert.rejects(composition.resolveClientByPath(path.join(f.input.userDataPath, 'unregistered')), { code: 'INVALID_REQUEST' });
  await assert.rejects(composition.acquireLegacyManagementContext(path.join(f.input.userDataPath, 'unregistered')), { code: 'INVALID_REQUEST' });
  assert.equal(fs.readFileSync(path.join(registryRoot, 'companions.json'), 'utf8'), '{bad registry');
  const unregisteredPath = path.join(f.input.userDataPath, 'unregistered-client');
  fs.mkdirSync(unregisteredPath);
  await composition.clientPackIntegration.assertServerDestination(unregisteredPath);
  fs.writeFileSync(path.join(unregisteredPath, '.minecraft-core-client-pack.json'), '{corrupt ownership');
  await assert.rejects(composition.clientPackIntegration.assertServerDestination(unregisteredPath), { code: 'CLIENT_PACK_UNAVAILABLE' });
});

function controlledHashWorker() {
  const worker = new EventEmitter();
  const requests = [];
  const postWaiters = [];
  let terminated = 0;
  worker.postMessage = request => {
    requests.push(request);
    for (const resolve of postWaiters.splice(0)) resolve();
  };
  worker.ref = () => {};
  worker.unref = () => {};
  worker.terminate = () => { terminated += 1; return Promise.resolve(1); };
  return {
    get posted() { return requests.length; },
    get terminated() { return terminated; },
    waitForPost() {
      if (requests.length > 0) return Promise.resolve();
      return new Promise(resolve => postWaiters.push(resolve));
    },
    resolveNext() {
      const request = requests.shift();
      assert.ok(request, 'expected one pending candidate hash request');
      const bytes = fs.readFileSync(request.path);
      worker.emit('message', {
        version: 1,
        id: request.id,
        ok: true,
        result: {
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          size: String(bytes.length),
          identity: request.expectedIdentity
        }
      });
    },
    worker
  };
}

async function waitForHashWorkerPosts(workers, timeoutMs = 10_000) {
  let timeout;
  try {
    await Promise.race([
      Promise.all(workers.map(worker => worker.waitForPost())),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Candidate hash workers did not receive their requests')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('production composition resolves default archive paths without verifying absent runtime artifacts', async t => {
  const context = fixture(t, { useDefaultArchiveRuntime: true });
  const composition = await createProductionModpackComposition(context.input);

  assert.equal(typeof composition.archiveInspector.inspectArchive, 'function');
  await composition.dispose();
});

test('production composition persists terminal retained-download holds and schedules best-effort cache pruning', async t => {
  // This fails if terminal outcomes can be pruned while their actions remain valid, or if startup/shutdown skip pruning.
  const context = fixture(t);
  const composition = await createProductionModpackComposition(context.input);
  await composition.initialize();
  await new Promise(resolve => setImmediate(resolve));
  const digest = 'c'.repeat(64);
  const actions = await composition.lifecycleService.outcomeActionIssuer.issue({
    jobId: 'job-retained', operationKind: 'install-new', instanceId: 'server-one', phase: 'failed', status: 'failed',
    errorCode: 'COMMIT_FAILED', automaticRecovery: false, restorePointId: null,
    plan: { artifact: { setDigest: 'a'.repeat(64), parts: [{ partId: 'archive', measuredSize: '1', sha256: digest }] } }
  });

  assert.deepEqual(actions.map(action => action.actionId), [
    'open-retained-download-folder', 'remove-retained-download', 'choose-another-asset'
  ]);
  assert.deepEqual(context.retentionCalls, [{ ownerId: 'job-retained', sha256s: [digest] }]);
  assert.equal(context.pruneCalls, 1);
  assert.equal(composition.scheduleArtifactCachePrune(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.pruneCalls, 2);
  await composition.dispose();
});

test('startup schedules archive pruning without delaying app initialization', async t => {
  const context = fixture(t);
  let resolvePrune;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  context.input.artifactCache.prune = () => {
    markStarted();
    return new Promise(resolve => { resolvePrune = resolve; });
  };
  const composition = await createProductionModpackComposition(context.input);

  const initialized = composition.initialize();
  await started;
  assert.equal(await Promise.race([
    initialized.then(() => 'initialized'),
    new Promise(resolve => setTimeout(() => resolve('blocked'), 50))
  ]), 'initialized');

  resolvePrune({ removed: 0, reclaimedBytes: 0 });
  await new Promise(resolve => setImmediate(resolve));
  context.input.artifactCache.prune = async () => ({ removed: 0, reclaimedBytes: 0 });
  await composition.dispose();
});

test('production shutdown waits for cache pruning and clears its deadline after success', async t => {
  const context = fixture(t);
  let resolvePrune;
  let markPruneStarted;
  const pruneStarted = new Promise(resolve => { markPruneStarted = resolve; });
  let pruneCalls = 0;
  context.input.artifactCache.prune = () => {
    pruneCalls += 1;
    markPruneStarted();
    return pruneCalls === 1
      ? new Promise(resolve => { resolvePrune = resolve; })
      : Promise.resolve({ removed: 0, reclaimedBytes: 0 });
  };
  const deadline = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
  let deadlineCallback = null;
  let deadlineDelay = null;
  const cleared = [];
  context.input.shutdownSetTimeoutFn = (callback, delay) => {
    deadlineCallback = callback;
    deadlineDelay = delay;
    return deadline;
  };
  context.input.shutdownClearTimeoutFn = handle => { cleared.push(handle); };
  const composition = await createProductionModpackComposition(context.input);

  assert.equal(composition.scheduleArtifactCachePrune(), true);
  await pruneStarted;
  let settled = false;
  const pending = composition.dispose().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(pruneCalls, 1);
  assert.equal(settled, false);
  assert.equal(deadlineDelay, 2_000);
  assert.equal(typeof deadlineCallback, 'function');
  assert.equal(deadline.unrefCalls, 1);

  resolvePrune({ removed: 0, reclaimedBytes: 0 });
  await pending;

  assert.equal(settled, true);
  assert.equal(pruneCalls, 2, 'shutdown runs one fresh pass after owner references are released');
  assert.deepEqual(cleared, [deadline]);
});

test('production shutdown releases workspace references before its fresh cache-prune pass', async t => {
  const context = fixture(t);
  let resolveEarlyPrune;
  let markEarlyPruneStarted;
  const earlyPruneStarted = new Promise(resolve => { markEarlyPruneStarted = resolve; });
  let referencesReleased = false;
  const observations = [];
  context.input.artifactCache.prune = () => {
    observations.push(referencesReleased);
    if (observations.length === 1) {
      markEarlyPruneStarted();
      return new Promise(resolve => { resolveEarlyPrune = resolve; });
    }
    return Promise.resolve({ removed: 1, reclaimedBytes: 1 });
  };
  const deadline = { unref() {} };
  context.input.shutdownSetTimeoutFn = () => deadline;
  context.input.shutdownClearTimeoutFn = () => {};
  const composition = await createProductionModpackComposition(context.input);
  composition.workspaceRegistry.dispose = async () => {
    referencesReleased = true;
    return true;
  };

  assert.equal(composition.scheduleArtifactCachePrune(), true);
  await earlyPruneStarted;
  const pending = composition.dispose();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(referencesReleased, true, 'workspace ownership is released without waiting on the early pass');
  assert.deepEqual(observations, [false]);

  resolveEarlyPrune({ removed: 0, reclaimedBytes: 0 });
  await pending;

  assert.deepEqual(observations, [false, true]);
});

test('production shutdown waits for cache-prune failure without rejecting disposal', async t => {
  const context = fixture(t);
  let rejectPrune;
  let markPruneStarted;
  const pruneStarted = new Promise(resolve => { markPruneStarted = resolve; });
  context.input.artifactCache.prune = () => {
    markPruneStarted();
    return new Promise((resolve, reject) => { rejectPrune = reject; });
  };
  const deadline = {};
  const cleared = [];
  context.input.shutdownSetTimeoutFn = () => deadline;
  context.input.shutdownClearTimeoutFn = handle => { cleared.push(handle); };
  const composition = await createProductionModpackComposition(context.input);

  let settled = false;
  const pending = composition.dispose().then(() => { settled = true; });
  await pruneStarted;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false);

  rejectPrune(new Error('cache prune failed'));
  await pending;

  assert.equal(settled, true);
  assert.deepEqual(cleared, [deadline]);
});

test('production shutdown stops waiting when the cache-prune deadline expires', async t => {
  const context = fixture(t);
  let markPruneStarted;
  const pruneStarted = new Promise(resolve => { markPruneStarted = resolve; });
  context.input.artifactCache.prune = () => {
    markPruneStarted();
    return new Promise(() => {});
  };
  const deadline = {};
  let deadlineCallback = null;
  let deadlineDelay = null;
  context.input.shutdownSetTimeoutFn = (callback, delay) => {
    deadlineCallback = callback;
    deadlineDelay = delay;
    return deadline;
  };
  context.input.shutdownClearTimeoutFn = () => {};
  const composition = await createProductionModpackComposition(context.input);

  let settled = false;
  const pending = composition.dispose().then(() => { settled = true; });
  await pruneStarted;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(deadlineDelay, 2_000);
  assert.equal(typeof deadlineCallback, 'function');

  deadlineCallback();
  await pending;

  assert.equal(settled, true);
});

test('production shutdown keeps a fresh post-release cache prune queued after an early prune consumes the deadline', async t => {
  const context = fixture(t);
  let resolveEarlyPrune;
  let markEarlyPruneStarted;
  const earlyPruneStarted = new Promise(resolve => { markEarlyPruneStarted = resolve; });
  let referencesReleased = false;
  const observations = [];
  context.input.artifactCache.prune = () => {
    observations.push(referencesReleased);
    if (observations.length === 1) {
      markEarlyPruneStarted();
      return new Promise(resolve => { resolveEarlyPrune = resolve; });
    }
    return Promise.resolve({ removed: 1, reclaimedBytes: 1 });
  };
  const deadline = {};
  let deadlineCallback = null;
  context.input.shutdownSetTimeoutFn = callback => {
    deadlineCallback = callback;
    return deadline;
  };
  context.input.shutdownClearTimeoutFn = () => {};
  const composition = await createProductionModpackComposition(context.input);
  composition.workspaceRegistry.dispose = async () => {
    referencesReleased = true;
    return true;
  };

  assert.equal(composition.scheduleArtifactCachePrune(), true);
  await earlyPruneStarted;
  const pending = composition.dispose();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(referencesReleased, true);
  assert.deepEqual(observations, [false]);
  deadlineCallback();
  await pending;

  resolveEarlyPrune({ removed: 0, reclaimedBytes: 0 });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(observations, [false, true]);
});

test('production composition reclaims exact crash workspaces before constructing the archive worker', async t => {
  const context = fixture(t);
  const orphan = path.join(context.input.paths.modpacks.workspaces, 'output-11111111-1111-4111-8111-111111111111');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'orphan.bin'), 'orphaned');
  let workerConstructed = false;
  context.input.workerFactory = () => {
    assert.equal(fs.existsSync(orphan), false);
    workerConstructed = true;
    return { async run() { throw new Error('not used'); } };
  };

  const composition = await createProductionModpackComposition(context.input);

  assert.equal(workerConstructed, true);
  await composition.dispose();
});

test('production composition accepts an injected path-only runtime resolver at startup', async t => {
  const context = fixture(t, { useDefaultArchiveRuntime: true });
  let receivedRoots = null;
  context.input.archiveRuntimePathResolver = roots => {
    receivedRoots = roots;
    return {
      resourcesRoot: context.input.userDataPath,
      runtimeLayout: 'repository',
      workerPath: path.join(context.input.userDataPath, 'worker.exe'),
      workerManifestPath: path.join(context.input.userDataPath, 'worker.json')
    };
  };

  const composition = await createProductionModpackComposition(context.input);

  assert.equal(receivedRoots, context.input.runtimeRoots);
  await composition.dispose();
});

test('production composition shares its reparse inspector with the archive worker', async t => {
  const context = fixture(t);
  const composition = await createProductionModpackComposition(context.input);

  assert.equal(context.workerOptions.reparseInspector, context.input.reparseInspector);
  await composition.dispose();
});

test('production disposal releases inspection and plan ownership before its first await', async t => {
  const context = fixture(t);
  const order = [];
  let finishHashDisposal;
  context.input.candidateHashService = {
    async hashFile() { throw new Error('not used'); },
    dispose() {
      order.push('candidate-hash');
      return new Promise(resolve => { finishHashDisposal = resolve; });
    }
  };
  const composition = await createProductionModpackComposition(context.input);
  composition.lifecycleService.dispose = () => { order.push('inspections'); };
  composition.planRegistry.dispose = () => { order.push('plans'); };
  composition.releaseMonitor.stop = () => { order.push('release-monitor'); };
  composition.nativeNotificationBridge.stop = () => { order.push('notifications'); };
  composition.workspaceRegistry.dispose = async () => { order.push('workspaces'); return true; };

  const pending = composition.dispose();

  assert.deepEqual(order, [
    'inspections',
    'plans',
    'release-monitor',
    'notifications'
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(order.at(-1), 'candidate-hash');
  finishHashDisposal();
  await pending;
  assert.deepEqual(order, [
    'inspections',
    'plans',
    'release-monitor',
    'notifications',
    'candidate-hash',
    'workspaces'
  ]);
});

test('client operation settlement precedes shared hash and workspace shutdown', async t => {
  const context = fixture(t); const order = [];
  context.input.candidateHashService = { async hashFile() {}, async dispose() { order.push('hash'); } };
  const composition = await createProductionModpackComposition(context.input);
  let settle; const gate = new Promise(resolve => { settle = resolve; });
  composition.clientPackService.dispose = async () => { order.push('client-cancel'); await gate; order.push('client-settled'); };
  const originalDispose = composition.workspaceRegistry.dispose.bind(composition.workspaceRegistry);
  composition.workspaceRegistry.dispose = async () => { order.push('workspace'); await originalDispose(); };
  const pending = composition.dispose();
  assert.equal(composition.managementSessionBroker.disposed, true, 'broker cancellation begins before operation settlement');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['client-cancel']);
  settle(); await pending;
  assert.deepEqual(order, ['client-cancel', 'client-settled', 'hash', 'workspace']);
});
test('production shutdown cancels a pending session before releasing existing workspace ownership', async t => {
  const context = fixture(t); let enter; let release; const ready = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const clientPath = path.join(context.input.userDataPath, 'synthetic-client');
  const storeGet = context.input.store.get.bind(context.input.store);
  context.input.store.get = key => key === 'instances' ? [{ id: 'local', type: 'client', path: clientPath }] : storeGet(key);
  context.input.readClientConfig = async () => { enter(); await gate; return { serverProtocol: 'http', serverIp: 'saved.example', serverPort: '25566', clientId: 'remote', clientName: 'Synthetic', inviteSecret: 'invite', sessionToken: 'seed' }; };
  context.input.managementSessionRequestJson = () => assert.fail('shutdown never dispatches management network');
  const composition = await createProductionModpackComposition(context.input);
  const pending = composition.managementSessionBroker.acquire('local').catch(error => error); await ready;
  const workspaceDispose = composition.workspaceRegistry.dispose.bind(composition.workspaceRegistry);
  composition.workspaceRegistry.dispose = async () => { assert.equal((await pending).code, 'CANCELLED'); return workspaceDispose(); };
  try { await composition.dispose(); assert.equal((await pending).code, 'CANCELLED'); } finally { release(); }
});

test('production disposal is cached and attempts every stage after lifecycle and plan disposal throw', async t => {
  const context = fixture(t);
  const order = [];
  const lifecycleFailure = new Error('lifecycle disposal failed');
  const planFailure = new Error('plan disposal failed');
  let finishHashDisposal;
  context.input.candidateHashService = {
    async hashFile() { throw new Error('not used'); },
    dispose() {
      order.push('candidate-hash');
      return new Promise(resolve => { finishHashDisposal = resolve; });
    }
  };
  const composition = await createProductionModpackComposition(context.input);
  composition.lifecycleService.dispose = () => {
    order.push('inspections');
    throw lifecycleFailure;
  };
  composition.planRegistry.dispose = () => {
    order.push('plans');
    throw planFailure;
  };
  composition.releaseMonitor.stop = () => { order.push('release-monitor'); };
  composition.nativeNotificationBridge.stop = () => { order.push('notifications'); };
  composition.workspaceRegistry.dispose = async () => { order.push('workspaces'); return true; };

  const pending = composition.dispose();

  assert.equal(composition.dispose(), pending);
  assert.deepEqual(order, [
    'inspections',
    'plans',
    'release-monitor',
    'notifications'
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(order.at(-1), 'candidate-hash');
  finishHashDisposal();
  await assert.rejects(
    pending,
    error => error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors[0] === lifecycleFailure &&
      error.errors[1] === planFailure
  );
  assert.deepEqual(order, [
    'inspections',
    'plans',
    'release-monitor',
    'notifications',
    'candidate-hash',
    'workspaces'
  ]);
});

test('production disposal releases the workspace lease after asynchronous candidate hash disposal fails', async t => {
  const context = fixture(t);
  const order = [];
  const candidateFailure = new Error('candidate hash disposal failed');
  let failHashDisposal;
  context.input.candidateHashService = {
    async hashFile() { throw new Error('not used'); },
    dispose() {
      order.push('candidate-hash');
      return new Promise((resolve, reject) => { failHashDisposal = reject; });
    }
  };
  const composition = await createProductionModpackComposition(context.input);
  composition.lifecycleService.dispose = () => { order.push('inspections'); };
  composition.planRegistry.dispose = () => { order.push('plans'); };
  composition.releaseMonitor.stop = () => { order.push('release-monitor'); };
  composition.nativeNotificationBridge.stop = () => { order.push('notifications'); };
  composition.workspaceRegistry.dispose = async () => { order.push('workspaces'); return true; };

  const pending = composition.dispose();

  assert.deepEqual(order, [
    'inspections',
    'plans',
    'release-monitor',
    'notifications'
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(order.at(-1), 'candidate-hash');
  failHashDisposal(candidateFailure);
  await assert.rejects(pending, error => error === candidateFailure);
  assert.deepEqual(order, [
    'inspections',
    'plans',
    'release-monitor',
    'notifications',
    'candidate-hash',
    'workspaces'
  ]);
});

test('two production compositions isolate their candidate hash workers and disposal', async t => {
  const contextA = fixture(t, { useDefaultMutationRuntime: true });
  const contextB = fixture(t, { useDefaultMutationRuntime: true });
  const controlledA = controlledHashWorker();
  const controlledB = controlledHashWorker();
  const serviceA = new PersistentCandidateHashService({
    workerFactory: () => controlledA.worker,
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 60_000
  });
  const serviceB = new PersistentCandidateHashService({
    workerFactory: () => controlledB.worker,
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 60_000
  });
  contextA.input.candidateHashService = serviceA;
  contextB.input.candidateHashService = serviceB;
  const compositionA = await createProductionModpackComposition(contextA.input);
  t.after(() => compositionA.dispose());
  const compositionB = await createProductionModpackComposition(contextB.input);
  t.after(() => compositionB.dispose());
  const candidateRootA = path.join(contextA.input.userDataPath, 'candidate-hash-dispose-a');
  const candidateRootB = path.join(contextB.input.userDataPath, 'candidate-hash-dispose-b');
  fs.mkdirSync(candidateRootA);
  fs.mkdirSync(candidateRootB);
  fs.writeFileSync(path.join(candidateRootA, 'pack.jar'), 'candidate-a');
  fs.writeFileSync(path.join(candidateRootB, 'pack.jar'), 'candidate-b');

  assert.equal(compositionA.candidatePreparer.candidateHashService, serviceA);
  assert.equal(compositionA.mutationRuntime.candidateHashService, serviceA);
  assert.equal(compositionB.candidatePreparer.candidateHashService, serviceB);
  assert.equal(compositionB.mutationRuntime.candidateHashService, serviceB);
  assert.equal((await scanManifest(candidateRootA, 'installation-short-lived', {
    reparseInspector: contextA.input.reparseInspector
  })).totalBytes, String(Buffer.byteLength('candidate-a')));
  assert.equal(controlledA.posted, 0);
  assert.equal(controlledB.posted, 0);
  const pendingA = scanManifest(candidateRootA, 'installation-dispose-a', {
    candidateHashService: serviceA,
    reparseInspector: contextA.input.reparseInspector
  });
  const pendingB = scanManifest(candidateRootB, 'installation-dispose-b', {
    candidateHashService: serviceB,
    reparseInspector: contextB.input.reparseInspector
  });
  void pendingA.catch(() => {});
  void pendingB.catch(() => {});
  await waitForHashWorkerPosts([controlledA, controlledB]);
  assert.equal(controlledA.posted, 1);
  assert.equal(controlledB.posted, 1);

  await compositionA.dispose();

  await assert.rejects(pendingA, error => error?.code === 'UNSAFE_ARCHIVE_ENTRY');
  assert.equal(controlledA.terminated, 1);
  assert.equal(controlledB.terminated, 0);
  controlledB.resolveNext();
  assert.equal((await pendingB).totalBytes, String(Buffer.byteLength('candidate-b')));
  await compositionB.dispose();
  assert.equal(controlledB.terminated, 1);
  await assert.rejects(
    serviceA.hashFile(path.join(candidateRootA, 'pack.jar'), { expectedIdentity: {} }),
    error => error?.code === 'CANDIDATE_HASH_SERVICE_DISPOSED'
  );
});

test('production composition preserves an explicitly injected verified runtime resolver', async t => {
  const context = fixture(t, { useDefaultArchiveRuntime: true });
  let invoked = 0;
  context.input.archiveRuntimePathResolver = () => assert.fail('legacy verified resolver must take precedence');
  context.input.archiveRuntimeResolver = async roots => {
    invoked += 1;
    assert.equal(roots, context.input.runtimeRoots);
    return {
      resourcesRoot: context.input.userDataPath,
      runtimeLayout: 'repository',
      workerPath: path.join(context.input.userDataPath, 'worker.exe'),
      workerManifestPath: path.join(context.input.userDataPath, 'worker.json')
    };
  };

  const composition = await createProductionModpackComposition(context.input);

  assert.equal(invoked, 1);
  await composition.dispose();
});

test('production composition keeps local verified sets app-issued and one workspace authority across the lifecycle', async t => {
  const context = fixture(t);
  const composition = await createProductionModpackComposition(context.input);
  await composition.initialize();

  const verifiedSet = verifiedLocalSet();
  assert.equal(await composition.artifactAcquisition.downloadSet(verifiedSet), verifiedSet);
  assert.equal(context.downloaderCalls, 0);

  await composition.notificationStore.create({
    type: 'update-available',
    serverId: 'server-one',
    source: { provider: 'modrinth', sourceId: 'project-one' },
    release: { releaseId: 'version-two', version: '2.0.0', prerelease: false },
    title: 'Update available',
    message: 'Version 2.0.0 is ready to review.',
    action: { actionId: 'open-details', opaqueRef: 'notification-release-one' },
    dedupeKey: 'server-one:version-two:update'
  });
  assert.equal(context.rendererEvents.some(([channel]) => channel === 'modpacks:notification'), true);

  const registry = composition.workspaceRegistry;
  assert.equal(composition.archiveInspector.materializer.workspaceRegistry, registry);
  assert.equal(composition.candidatePreparer.workspaceRegistry, registry);
  assert.equal(composition.planRegistry.workspaceRegistry, registry);

  const inspectionOwner = registry.createPlanningSession();
  registry.registerVerifiedSet({ ownerId: inspectionOwner, verifiedSet });
  const templateId = registry.createStagingOutput({ ownerId: inspectionOwner });
  registry.transferOwnership({ fromOwnerId: inspectionOwner, toOwnerId: 'plan-reviewed' });
  registry.transferOwnership({ fromOwnerId: 'plan-reviewed', toOwnerId: 'job-authorized' });
  assert.throws(() => registry.resolveOwnedWorkspace({ ownerId: inspectionOwner, id: templateId, kind: 'output' }), error => error?.code === 'PLAN_STALE');
  assert.throws(() => registry.resolveOwnedWorkspace({ ownerId: 'plan-reviewed', id: templateId, kind: 'output' }), error => error?.code === 'PLAN_STALE');
  assert.equal(registry.resolveOwnedWorkspace({ ownerId: 'job-authorized', id: templateId, kind: 'output' }).id, templateId);

  await composition.dispose();
});

test('production composition constructs the real mutation runtime used by packaged startup', async t => {
  const context = fixture(t, { useDefaultMutationRuntime: true });
  const composition = await createProductionModpackComposition(context.input);
  await composition.initialize();

  const { ProductionMutationRuntime } = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
  assert.equal(composition.mutationRuntime instanceof ProductionMutationRuntime, true);
  for (const method of [
    'revalidate', 'buildCandidate', 'publishCandidate', 'registerPublishedInstance', 'commitCandidate',
    'validateLive', 'rollback', 'abandonCandidate', 'restorePriorState'
  ]) assert.equal(typeof composition.mutationRuntime[method], 'function', method);

  await composition.dispose();
});

test('production composition startup completes durable recovery history with issued terminal actions', async t => {
  const context = fixture(t);
  const operationStore = new OperationStore({
    userDataPath: context.input.userDataPath,
    fsApi: fs,
    durableFs: context.input.durableFsFactory(),
    clock: () => new Date('2026-08-02T00:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000099'
  });
  await operationStore.initialize();
  let job = await operationStore.create({
    jobId: 'job-startup-reconcile',
    operationKind: 'install-new',
    serverId: 'server-one',
    planFingerprint: SHA256
  });
  for (const phase of ['preflight', 'snapshotting', 'staging', 'validating-candidate', 'committing', 'publishing', 'published', 'registering']) {
    job = await operationStore.transition(job.jobId, {
      expectedPhase: job.phase,
      nextPhase: phase,
      patch: {}
    });
  }
  context.input.rawRecoveryServices.registry.loadHistory = async jobId => jobId === job.jobId ? {
    jobId,
    operationKind: 'install',
    phase: 'completed',
    target: { kind: 'new', stableServerId: 'server-one', path: 'C:\\private\\server-one' },
    outcome: {
      revisionEvent: { eventId: 'revision:job-startup-reconcile', published: true },
      releaseTracking: { status: 'applied' }
    }
  } : null;

  const composition = await createProductionModpackComposition(context.input);
  await composition.initialize();

  const reconciled = await composition.lifecycleService.getJob(job.jobId);
  assert.equal(reconciled.phase, 'completed');
  assert.deepEqual(reconciled.outcome.actions, [{
    actionId: 'open-details', opaqueRef: 'oa:od:job-startup-reconcile'
  }]);
  assert.doesNotMatch(JSON.stringify(reconciled), /private|serverPath|url/i);
  await composition.dispose();
});

test('production composition startup closes a crash-recovered committing update as rolled back', async t => {
  const context = fixture(t);
  const operationStore = new OperationStore({
    userDataPath: context.input.userDataPath,
    fsApi: fs,
    durableFs: context.input.durableFsFactory(),
    clock: () => new Date('2026-08-02T00:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000100'
  });
  await operationStore.initialize();
  let job = await operationStore.create({
    jobId: 'job-crash-recovered-update',
    operationKind: 'update',
    serverId: 'server-one',
    planFingerprint: SHA256
  });
  for (const phase of ['preflight', 'snapshotting', 'staging', 'validating-candidate', 'committing']) {
    job = await operationStore.transition(job.jobId, {
      expectedPhase: job.phase,
      nextPhase: phase,
      patch: {}
    });
  }
  context.input.rawRecoveryServices.registry.loadHistory = async jobId => jobId === job.jobId ? {
    jobId,
    operationKind: 'upgrade',
    phase: 'failed',
    target: { kind: 'existing', stableServerId: 'server-one', path: 'C:\\private\\server-one' },
    outcome: {
      recovery: { action: 'between-renames-restored', operationId: jobId }
    }
  } : null;

  const composition = await createProductionModpackComposition(context.input);
  await composition.initialize();

  const reconciled = await composition.lifecycleService.getJob(job.jobId);
  assert.equal(reconciled.phase, 'rolled-back');
  assert.equal(reconciled.outcome.status, 'rolled-back');
  assert.deepEqual(reconciled.outcome.actions, [{
    actionId: 'return-to-server', opaqueRef: 'oa:rs:job-crash-recovered-update'
  }]);
  assert.doesNotMatch(JSON.stringify(reconciled), /private|serverPath|url/i);
  await composition.dispose();
});

test('reviewed recovery reconciles the durable operation before returning to the renderer', async t => {
  const context = fixture(t);
  const operationStore = new OperationStore({
    userDataPath: context.input.userDataPath,
    fsApi: fs,
    durableFs: context.input.durableFsFactory(),
    clock: () => new Date('2026-08-02T00:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000101'
  });
  await operationStore.initialize();
  let job = await operationStore.create({
    jobId: 'job-reviewed-recovery-update',
    operationKind: 'update',
    serverId: 'server-one',
    planFingerprint: SHA256
  });
  for (const phase of ['preflight', 'snapshotting', 'staging']) {
    job = await operationStore.transition(job.jobId, { expectedPhase: job.phase, nextPhase: phase, patch: {} });
  }

  const activeRecord = {
    jobId: job.jobId,
    operationKind: 'upgrade',
    phase: 'staging',
    swapStep: 'none',
    target: { kind: 'existing', stableServerId: 'server-one', path: 'C:\\private\\server-one' }
  };
  let active = activeRecord;
  let historical = null;
  const registry = context.input.rawRecoveryServices.registry;
  registry.listActive = async () => active ? [active] : [];
  registry.load = async jobId => active?.jobId === jobId ? active : null;
  registry.loadHistory = async jobId => historical?.jobId === jobId ? historical : null;
  context.input.rawRecoveryServices.recoveryService.recover = async value => {
    assert.equal(value, activeRecord);
    active = null;
    historical = {
      ...activeRecord,
      phase: 'failed',
      outcome: { recovery: { action: 'pre-swap-restored', operationId: activeRecord.jobId } }
    };
    return { jobId: value.jobId, resolved: true, action: 'pre-swap-restored' };
  };

  const composition = await createProductionModpackComposition(context.input);
  await composition.initialize();
  assert.equal((await composition.lifecycleService.getJob(job.jobId)).phase, 'staging');
  const recoveryWorkspaceId = composition.workspaceRegistry.createStagingOutput({ ownerId: job.jobId });
  const recoveryWorkspace = path.join(context.input.paths.modpacks.workspaces, recoveryWorkspaceId);
  fs.writeFileSync(path.join(recoveryWorkspace, 'candidate.bin'), 'candidate');
  const listed = await composition.recoveryService.listRecovery();
  const result = await composition.recoveryService.recover({
    recoveryId: listed.items[0].recoveryId,
    actionId: 'retry-recovery'
  });

  assert.equal(result.resolved, true);
  assert.equal(result.operationStateReconciled, true);
  assert.equal((await composition.lifecycleService.getJob(job.jobId)).phase, 'failed');
  assert.equal(fs.existsSync(recoveryWorkspace), false);
  await composition.dispose();
});

test('reviewed recovery releases the same-process plan claim and its workspace ownership', async t => {
  const context = fixture(t);
  let active = null;
  const recoveryRegistry = context.input.rawRecoveryServices.registry;
  recoveryRegistry.listActive = async () => active ? [active] : [];
  recoveryRegistry.load = async jobId => active?.jobId === jobId ? active : null;
  context.input.rawRecoveryServices.recoveryService.recover = async record => {
    assert.equal(record, active);
    active = null;
    return { jobId: record.jobId, resolved: true, action: 'pre-swap-restored' };
  };

  const composition = await createProductionModpackComposition(context.input);
  t.after(() => composition.dispose());
  await composition.initialize();
  const planningSessionId = composition.workspaceRegistry.createPlanningSession();
  const outputId = composition.workspaceRegistry.createStagingOutput({ ownerId: planningSessionId });
  const planWithoutFingerprint = {
    type: 'modpack-preflight-plan',
    schemaVersion: 1,
    operation: { instanceId: 'server-one', expectedContentRevision: 7 },
    source: { provider: 'github', releaseId: '42', downloadUrl: 'https://example.invalid/private' },
    workspace: { artifactSetId: 'artifact-set-internal', outputDirectoryId: outputId }
  };
  const plan = { ...planWithoutFingerprint, fingerprint: computePreflightPlanFingerprint(planWithoutFingerprint) };
  const created = composition.planRegistry.create({
    plan,
    sanitizedView: { title: 'Reviewed Pack', server: { id: 'server-one' } },
    fingerprint: plan.fingerprint,
    planningSessionId
  });
  const claimed = await composition.planRegistry.claim({ planId: created.planId, fingerprint: created.fingerprint });
  const output = path.join(context.input.paths.modpacks.workspaces, outputId);
  active = {
    jobId: claimed.jobId,
    operationKind: 'upgrade',
    phase: 'staging',
    swapStep: 'none',
    target: { kind: 'existing', stableServerId: 'server-one', path: 'C:\\private\\server-one' }
  };

  const listed = await composition.recoveryService.listRecovery();
  const result = await composition.recoveryService.recover({
    recoveryId: listed.items[0].recoveryId,
    actionId: 'retry-recovery'
  });

  assert.equal(result.operationStateReconciled, true);
  assert.equal(fs.existsSync(output), false);
  assert.equal(await composition.planRegistry.releaseClaim(claimed.jobId), false);
});

test('recovery visibility uses authoritative registration across the post-registration crash window', async t => {
  const context = fixture(t);
  const registeredPath = path.join(context.input.userDataPath, 'registered-after-crash');
  const abandonedPath = path.join(context.input.userDataPath, 'abandoned-setup');
  context.input.store.set('instances', [{
    id: 'server-registration-crash',
    name: 'Registered Before Crash',
    type: 'server',
    path: registeredPath
  }]);
  context.input.rawRecoveryServices.registry.listActive = async () => [{
    jobId: 'job-registration-crash',
    operationKind: 'install-new',
    phase: 'registering',
    swapStep: 'candidate-published',
    target: {
      kind: 'new',
      stableServerId: 'server-registration-crash',
      path: registeredPath
    },
    outcome: { registration: { instanceId: 'server-registration-crash', complete: false } }
  }, {
    jobId: 'job-abandoned-setup',
    operationKind: 'install-new',
    phase: 'validating-candidate',
    swapStep: 'not-started',
    target: {
      kind: 'new',
      stableServerId: 'server-abandoned-setup',
      path: abandonedPath
    },
    outcome: null
  }];

  const composition = await createProductionModpackComposition(context.input);
  const listed = await composition.recoveryService.listRecovery();
  const byServerId = new Map(listed.items.map(item => [item.serverId, item]));

  assert.equal(byServerId.get('server-registration-crash').visibilityScope, 'registered-server');
  assert.equal(byServerId.get('server-registration-crash').actions[0].actionId, 'retry-recovery');
  assert.equal(byServerId.get('server-registration-crash').actions[0].label, 'Retry verified recovery');
  assert.equal(byServerId.get('server-abandoned-setup').visibilityScope, 'pending-new-server');
  assert.equal(byServerId.get('server-abandoned-setup').actions[0].actionId, 'resolve-interrupted-setup');
  assert.equal(byServerId.get('server-abandoned-setup').actions[0].label, 'Resolve interrupted setup');
  await composition.dispose();
});

test('resolved same-session new-server publication consumes its destination reservation', async t => {
  const context = fixture(t);
  const targetPath = path.join(context.input.userDataPath, 'recovered-published-server');
  fs.mkdirSync(targetPath);
  context.input.dialog = {
    async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; }
  };
  let active = null;
  const registry = context.input.rawRecoveryServices.registry;
  registry.listActive = async () => active ? [active] : [];
  context.input.rawRecoveryServices.recoveryService.recover = async record => {
    assert.equal(record, active);
    context.input.store.set('instances', [{
      id: record.target.stableServerId,
      name: 'Recovered Published Server',
      type: 'server',
      path: record.target.path
    }]);
    active = null;
    return { jobId: record.jobId, resolved: true, action: 'new-publication-completed' };
  };

  const composition = await createProductionModpackComposition(context.input);
  t.after(() => composition.dispose());
  await composition.initialize();
  const reserved = await composition.destinationReservationService.reserveWithNativeDialog({});
  active = {
    jobId: 'job-same-session-published-server',
    operationKind: 'install-new',
    phase: 'registering',
    swapStep: 'candidate-published',
    target: { kind: 'new', stableServerId: reserved.instanceId, path: targetPath },
    outcome: { registration: { complete: false } }
  };
  const listed = await composition.recoveryService.listRecovery();

  const result = await composition.recoveryService.recover({
    recoveryId: listed.items[0].recoveryId,
    actionId: 'resolve-interrupted-setup'
  });

  assert.equal(result.resolved, true);
  assert.equal(result.operationStateReconciled, true);
  assert.equal(composition.destinationReservationService.resolve(reserved.instanceId), null);
  context.input.store.set('instances', []);
  const next = await composition.destinationReservationService.reserveWithNativeDialog({});
  assert.notEqual(next.instanceId, reserved.instanceId, 'a consumed identity must not be reused after publication');
  assert.equal(composition.destinationReservationService.release(next.instanceId), true);
});

for (const recoveryAction of ['pre-publication-cleanup', 'new-health-failed']) {
  test(`resolved same-session ${recoveryAction} releases its destination reservation for retry`, async t => {
    const context = fixture(t);
    const targetPath = path.join(context.input.userDataPath, `recovered-${recoveryAction}`);
    fs.mkdirSync(targetPath);
    context.input.dialog = {
      async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; }
    };
    let active = null;
    const registry = context.input.rawRecoveryServices.registry;
    registry.listActive = async () => active ? [active] : [];
    context.input.rawRecoveryServices.recoveryService.recover = async record => {
      assert.equal(record, active);
      active = null;
      return { jobId: record.jobId, resolved: true, action: recoveryAction };
    };

    const composition = await createProductionModpackComposition(context.input);
    t.after(() => composition.dispose());
    await composition.initialize();
    const reserved = await composition.destinationReservationService.reserveWithNativeDialog({});
    active = {
      jobId: `job-same-session-${recoveryAction}`,
      operationKind: 'install-new',
      phase: recoveryAction === 'pre-publication-cleanup' ? 'validating-candidate' : 'starting',
      swapStep: recoveryAction === 'pre-publication-cleanup' ? 'none' : 'candidate-published',
      target: { kind: 'new', stableServerId: reserved.instanceId, path: targetPath },
      outcome: null
    };
    const listed = await composition.recoveryService.listRecovery();

    const result = await composition.recoveryService.recover({
      recoveryId: listed.items[0].recoveryId,
      actionId: 'resolve-interrupted-setup'
    });

    assert.equal(result.resolved, true);
    assert.equal(result.operationStateReconciled, true);
    assert.equal(composition.destinationReservationService.resolve(reserved.instanceId), null);
    const retry = await composition.destinationReservationService.reserveWithNativeDialog({});
    assert.equal(retry.instanceId, reserved.instanceId, 'a released identity must remain bound to the same retry path');
    assert.equal(composition.destinationReservationService.release(retry.instanceId), true);
  });
}

for (const registrationState of ['registered', 'absent']) test(`authenticated metadata ${registrationState} completion preserves production reservation and reconciliation semantics`, {
  skip: process.platform !== 'win32'
}, async t => {
  const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
  const { ModpackRecoveryService } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
  const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
  const { createServerMutationContext } = require('../../electron/services/server-mutation-context.cjs');
  const context = fixture(t);
  const unexpected = () => assert.fail('metadata recovery crossed into source/runtime work');
  const coordinator = new ServerMutationCoordinator({ context: createServerMutationContext(), readContentRevision: () => 0, bumpContentRevision: unexpected });
  context.input.coordinator = coordinator;
  const targetPath = path.join(context.input.userDataPath, `metadata-${registrationState}`);
  fs.mkdirSync(targetPath);
  context.input.dialog = { async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; } };
  let failEnvelope = true;
  const base = context.input.durableFsFactory();
  const registry = new RecoveryRegistry({ userDataPath: context.input.userDataPath, durableFs: { ...base,
    async renameDurableAsync(from, to, options) {
      if (failEnvelope && from.endsWith('.target.json')) throw new Error('injected envelope move failure');
      return base.renameDurableAsync(from, to, options);
    }
  } });
  await registry.initialize();
  const service = new ModpackRecoveryService({ coordinator, recoveryRegistry: registry, contextFactory: unexpected,
    runtimeWriterAuthority: { assertRecoveryAllowed: unexpected }, runtimePolicy: {
      suspend: unexpected, ensureStopped: unexpected, adoptValidatedHandoff: unexpected, restoreAutoRestart: unexpected
    }
  });
  Object.assign(context.input.rawRecoveryServices, { registry, recoveryService: service });
  const composition = await createProductionModpackComposition(context.input); t.after(() => composition.dispose());
  const reserved = await composition.destinationReservationService.reserveWithNativeDialog({});
  const jobId = `job-metadata-${registrationState}`;
  const operationStore = new OperationStore({ userDataPath: context.input.userDataPath, durableFs: context.input.durableFsFactory() });
  await operationStore.initialize();
  let job = await operationStore.create({ jobId, operationKind: 'install-new', serverId: reserved.instanceId, planFingerprint: SHA256 });
  const phases = registrationState === 'registered'
    ? ['preflight', 'snapshotting', 'staging', 'validating-candidate', 'committing', 'publishing', 'published', 'registering']
    : ['preflight', 'snapshotting', 'staging'];
  for (const phase of phases) job = await operationStore.transition(jobId, { expectedPhase: job.phase, nextPhase: phase, patch: {} });
  const initial = await registry.create({ schemaVersion: 2, sequence: 0, jobId, operationKind: 'install',
    target: { kind: 'new', stableServerId: reserved.instanceId, path: targetPath }, candidatePath: null, rollbackPath: null,
    failedPath: null, restorePoint: null, restoreCreation: null, journalPath: null,
    priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', outcome: null });
  if (registrationState === 'registered') context.input.store.set('instances', [{ id: reserved.instanceId, type: 'server', name: 'Metadata Server', path: targetPath }]);
  const outcome = registrationState === 'registered' ? { revisionEvent: { eventId: `revision:${jobId}`, published: true } }
    : { recovery: { action: 'pre-publication-cleanup', operationId: jobId }, failure: { stage: 'durable-move', category: 'sharing-violation' } };
  await assert.rejects(registry.finish(jobId, { terminalPhase: registrationState === 'registered' ? 'completed' : 'failed', outcome }), { code: 'COMMIT_FAILED' });
  const historicalPath = path.join(registry.historyPath, `${jobId}.json`);
  const bytes = fs.readFileSync(historicalPath);
  coordinator.installRecoveryBlocks([{ operationId: jobId, selector: { instanceId: reserved.instanceId, serverPath: targetPath } }]);
  coordinator.completeStartupRecovery([{ selector: { instanceId: reserved.instanceId, serverPath: targetPath }, resolved: false }]);
  await composition.initialize();
  assert.equal((await composition.lifecycleService.getJob(jobId)).phase, registrationState === 'registered' ? 'completed' : 'failed');
  // The existing history reader may reconcile an operation before publication;
  // that callback/read is not authority to clear the coordinator block.
  await assert.rejects(coordinator.runMutation({ instanceId: reserved.instanceId, serverPath: targetPath }, {
    operation: 'probe', operationId: 'metadata-probe', revisionMode: 'none'
  }, unexpected), { code: 'RECOVERY_REQUIRED' });
  const item = (await composition.recoveryService.listRecovery()).items[0];
  assert.deepEqual(item.actions, [{ actionId: 'retry-history-publication', label: 'Finish recovery bookkeeping', recommended: true }]);
  const request = { recoveryId: item.recoveryId, actionId: 'retry-history-publication' };
  await assert.rejects(composition.recoveryService.recover(request), { code: 'RECOVERY_REQUIRED' });
  assert.ok(composition.destinationReservationService.resolve(reserved.instanceId));
  assert.equal(fs.existsSync(path.join(registry.activePath, `${jobId}.target.json`)), true);
  failEnvelope = false;
  const result = await composition.recoveryService.recover(request);
  assert.equal(result.resolved, true); assert.equal(result.operationStateReconciled, true);
  assert.equal(composition.destinationReservationService.resolve(reserved.instanceId), null);
  assert.deepEqual(fs.readFileSync(historicalPath), bytes); assert.deepEqual((await registry.initialize()).blocks, []);
  context.input.store.set('instances', []);
  const next = await composition.destinationReservationService.reserveWithNativeDialog({});
  if (registrationState === 'registered') assert.notEqual(next.instanceId, reserved.instanceId);
  else assert.equal(next.instanceId, reserved.instanceId);
  composition.destinationReservationService.release(next.instanceId);
});
