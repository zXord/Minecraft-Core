const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProductionModpackComposition } = require('../../electron/bootstrap/create-production-modpack-composition.cjs');
const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { createModpackPaths } = require('../../electron/services/modpacks/paths.cjs');
const { SelectionRegistry } = require('../../electron/services/modpacks/local/selection-registry.cjs');
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

function fixture(t, { useDefaultMutationRuntime = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-composition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(userDataPath, { recursive: true });
  const paths = { userData: userDataPath, modpacks: createModpackPaths(userDataPath) };
  fs.mkdirSync(paths.modpacks.cache, { recursive: true });
  let temporary = 0;
  const durableFsFactory = () => createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => `composition-${++temporary}`
  });
  let uuid = 0;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`;
  let downloaderCalls = 0;
  const rendererEvents = [];
  const artifactCache = {
    root: paths.modpacks.cache,
    retain() {}, release() {},
    async commitPart() { throw new Error('not used'); },
    async materializeSet() { throw new Error('not used'); },
    pathForSha256() { return path.join(paths.modpacks.cache, SHA256); },
    async removeIfUnreferenced() { return true; }
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
    github: { repository() {}, async getRelease() {}, async buildArtifactSetPlan() {} }
  };
  const recoveryRegistry = {
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
  const input = {
      app: {}, artifactCache, artifactDownloader,
      clock: { now: () => now },
      coordinator: { async runMutation() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      durableFsFactory, fsPromises: fsp, fsSync: fs,
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
      archiveRuntime: {
        resourcesRoot: root, runtimeLayout: 'repository',
        workerPath: path.join(root, 'worker.exe'), workerManifestPath: path.join(root, 'worker.json')
      },
      workerFactory() { return { async run() { throw new Error('not used'); } }; }
  };
  if (!useDefaultMutationRuntime) input.mutationRuntime = noOpMutationRuntime();
  return {
    get downloaderCalls() { return downloaderCalls; },
    rendererEvents,
    input
  };
}

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
