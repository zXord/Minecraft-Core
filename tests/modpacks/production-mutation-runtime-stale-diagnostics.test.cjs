const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ProductionMutationRuntime } = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-stale-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server');
  const templatePath = path.join(root, 'template');
  fs.mkdirSync(serverPath);
  fs.mkdirSync(templatePath);
  const manifest = { schemaVersion: 1, installationId: 'installation-one', entries: [] };
  const record = {
    serverKind: 'existing', serverPath, incomingManifest: manifest,
    execution: { templateOutputId: 'output-template', repairPayloadManifest: manifest },
    selectedRestorePoint: null, adoption: null,
    reviewedServerDisk: { candidateBytes: '0', restorePointBytes: '0', rollbackBytes: '0', journalBytes: '0' }
  };
  const snapshot = {
    pathPreconditions: [], liveSnapshot: { entries: [], worldDirectories: ['world'] },
    candidateBytes: '0', restorePointBytes: '0', rollbackBytes: '0', journalBytes: '0'
  };
  const plan = {
    type: 'modpack-preflight-plan', fingerprint: 'a'.repeat(64),
    operation: { kind: 'repair', serverKind: 'existing', instanceId: 'server-one', expectedContentRevision: 4 },
    source: {}, artifact: { setDigest: 'b'.repeat(64) }, runtime: {},
    preconditions: { paths: [] }, ownership: { actions: [] },
    selections: { conflictChoices: {} }, restorePoints: [],
    disk: { candidateBytes: '0', restorePointBytes: '0', rollbackBytes: '0', journalBytes: '0', downloadBytes: '0', expandedBytes: '0' }
  };
  // These guards run before any private runtime state or mutation is needed.
  // Keep the actual revalidate implementation; replace only external boundaries.
  const runtime = Object.assign(Object.create(ProductionMutationRuntime.prototype), {
    planningAdapter: { getExecutionRecord() { return context.record; } },
    workspaceRegistry: { resolveOwnedWorkspace() { return { path: templatePath }; } },
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: { read() { return { state: { modpackManaged: true }, manifest }; } },
    snapshotServer: async () => snapshot,
    availableBytes: async () => '1000000000000',
    planValidator() {},
    planOwnership() { return { actions: [], blocked: [] }; },
    destinationReservations: { resolve() { return null; } },
    durableFsFactory: () => ({ async flushDirectoryAsync() {}, async renameDurableAsync() {}, async writeFileAtomicAsync() {} })
  });
  const context = {
    root, serverPath, templatePath, record, snapshot, plan, runtime,
    resolved: { instanceId: 'server-one', serverPath, priorRunning: false },
    lease: { kind: 'mutation', instanceId: 'server-one', serverPath, baseRevision: 4 },
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null }
  };
  context.run = () => runtime.revalidate({ jobId: 'job-one', ...context });
  return context;
}

const guards = [
  ['missing execution record', 'executionRecord', c => { c.record = null; }],
  ['execution server mismatch', 'executionRecord', c => { c.record.serverKind = 'new'; }],
  ['missing template output', 'templateOutput', c => { delete c.record.execution.templateOutputId; }],
  ['missing incoming manifest', 'templateOutput', c => { delete c.record.incomingManifest; }],
  ['missing repair payload', 'repairPayloadManifest', c => { delete c.record.execution.repairPayloadManifest; }],
  ['changed template manifest', 'templateManifest', c => {
    c.record.execution.repairPayloadManifest = { ...c.record.incomingManifest, entries: [{ path: 'private-file', installedHash: 'secret-value' }] };
  }],
  ['invalid unmanaged adoption', 'unmanagedAdoption', c => { c.record.adoption = {}; }],
  ['changed content revision', 'contentRevision', c => { c.lease.baseRevision = 5; }],
  ['missing management output', 'managementOutput', c => {
    c.plan.type = 'modpack-management-plan'; c.plan.operation.kind = 'detach';
    c.record.operationKind = 'detach';
  }],
  ['missing rollback restore point', 'restorePoint', c => {
    c.plan.type = 'modpack-management-plan'; c.plan.operation.kind = 'rollback-restore-point';
    c.record.operationKind = 'rollback-restore-point'; c.record.execution.managementOutputId = 'output-management';
  }],
  ['unexpected selected restore point', 'restorePoint', c => {
    c.plan.type = 'modpack-management-plan'; c.plan.operation.kind = 'detach';
    c.record.operationKind = 'detach'; c.record.execution.managementOutputId = 'output-management';
    c.record.selectedRestorePoint = {};
  }],
  ['invalid new runtime selection', 'plannedRuntimeSelection', c => {
    c.plan.operation.kind = 'install'; c.plan.operation.serverKind = 'new'; c.plan.operation.expectedContentRevision = 0;
    c.record.serverKind = 'new'; c.plan.selections.maxRam = 0;
  }],
  ['non-stale ownership failure', 'ownershipReconciliation', c => {
    c.snapshot.pathPreconditions = [{ pathKey: 'config/changed.toml' }];
    c.runtime.planOwnership = () => {
      const error = new Error('C:\\private\\server secret-token');
      Object.defineProperty(error, 'details', { get() { throw Error('hostile getter'); } });
      throw error;
    };
  }]
];

for (const [name, field, arrange] of guards) {
  test(`revalidation identifies ${name} without exposing content`, async t => {
    const c = fixture(t);
    arrange(c);
    await assert.rejects(c.run(), error => {
      assert.equal(error.code, 'PLAN_STALE');
      assert.equal(error.safeMessage, 'The reviewed modpack mutation is stale');
      assert.deepEqual(error.details, { field });
      assert.doesNotMatch(JSON.stringify(error.toPublicResult()), /private|secret|hostile/u);
      return true;
    });
  });
}

test('ownership reconciliation preserves an existing specific stale error unchanged', async t => {
  const c = fixture(t);
  c.snapshot.pathPreconditions = [{ pathKey: 'config/changed.toml' }];
  const original = new ModpackError('PLAN_STALE', 'The server changed after review', { details: { field: 'paths' } });
  c.runtime.planOwnership = () => { throw original; };
  await assert.rejects(c.run(), error => error === original && error.details.field === 'paths');
});

test('template scan cancellation keeps its original cancellation code', async t => {
  const c = fixture(t);
  const controller = new AbortController();
  fs.writeFileSync(path.join(c.templatePath, 'test.txt'), 'tiny');
  controller.abort();
  await assert.rejects(c.runtime.revalidate({ jobId: 'job-one', ...c, signal: controller.signal }),
    error => error.code === 'CANCELLED');
});

test('the real lifecycle durably publishes the production stale field and excludes hostile causes', async t => {
  const c = fixture(t);
  // Exercise the wrapping branch so the production error carries a hostile cause.
  guards.at(-1)[2](c);
  let temp = 0;
  const durableFs = createDurableFs({
    fsApi: fs, asyncFsApi: fs.promises, allowedRoots: [c.root],
    tempNameFactory: () => `diagnostic-${++temp}`,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      async moveWriteThroughAsync(source, destination) { await fs.promises.rename(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      async replaceFileWriteThroughAsync(source, destination) { await fs.promises.rename(source, destination); },
      flushDirectory() {}, async flushDirectoryAsync() {}
    }
  });
  const storeOptions = { userDataPath: c.root, fsApi: fs, durableFs };
  const operationStore = new OperationStore(storeOptions);
  await operationStore.initialize();
  const unexpected = async () => { throw Error('unexpected mutation'); };
  const mutationRuntime = Object.fromEntries([
    'createRestorePoint', 'buildCandidate', 'validateCandidate', 'publishCandidate',
    'registerPublishedInstance', 'commitCandidate', 'startFinal', 'validateLive', 'persistOutcome', 'cleanup', 'rollback'
  ].map(name => [name, unexpected]));
  Object.assign(mutationRuntime, {
    async resolveInstance() { return c.resolved; }, async suspendAutoRestart() {}, async quiesce() {},
    revalidate: () => c.run(), async abandonCandidate() {}, async restorePriorState() {}
  });
  const service = new ModpackLifecycleService({
    sourceResolver: { async resolveArtifactSetPlan() {} }, artifactDownloader: { async downloadSet() {} },
    archiveInspector: { async inspectArchive() {} }, inspectionLoader: { loadInspection() {} },
    planningAdapter: { async createPlan() {} },
    planRegistry: {
      create() {}, get() {}, releaseClaim() { return true; },
      claim() { return { jobId: 'job-one', planId: 'plan-one', fingerprint: c.plan.fingerprint, plan: c.plan }; }
    },
    operationStore, mutationRuntime,
    mutationCoordinator: { async runMutation(_selector, options, work) { await options.quiesce({}); return work(c.lease); } }
  });
  const queued = await service.startOperation({ planId: 'plan-one', planFingerprint: c.plan.fingerprint, choices: c.choices });
  let terminal;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    terminal = await operationStore.get(queued.jobId);
    if (terminal.phase === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(terminal.phase, 'failed');
  const reloaded = new OperationStore(storeOptions);
  await reloaded.initialize();
  const persisted = await reloaded.get(queued.jobId);
  assert.deepEqual(persisted.events[0].details, {
    errorCode: 'PLAN_STALE', step: 'revalidate-plan', field: 'ownershipReconciliation'
  });
  const journal = fs.readFileSync(path.join(c.root, 'modpack-lifecycle', 'operations', 'job-one.json'), 'utf8');
  assert.doesNotMatch(journal, /private|secret|hostile|config\/changed/u);
});
