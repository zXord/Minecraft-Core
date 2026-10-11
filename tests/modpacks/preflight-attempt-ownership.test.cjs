const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createModpackHandlers } = require('../../electron/ipc/modpack-handlers.cjs');
const { ArtifactCache } = require('../../electron/services/modpacks/artifacts/artifact-cache.cjs');

const { ArtifactWorkspaceRegistry, TTL_MS } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { ArchiveInputMaterializer } = require('../../electron/services/modpacks/archive/archive-input-materializer.cjs');
const { createArchiveExtractor } = require('../../electron/services/modpacks/archive/archive-extractor.cjs');
const { ProductionCandidatePreparer } = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');
const { ProductionPlanningAdapter } = require('../../electron/services/modpacks/planning/production-planning-adapter.cjs');
const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { PlanRegistry } = require('../../electron/services/modpack-lifecycle/plan-registry.cjs');
const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../../electron/services/modpacks/contracts.cjs');
const { computePlanFingerprint } = require('../../electron/services/modpacks/artifacts/artifact-fingerprint.cjs');
const { fileIdentityFromStat } = require('../../electron/services/modpacks/planning/candidate-hash-service.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');

const reparseInspector = { async isReparsePoint() { return false; } };
const runtime = { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10', javaMajor: 21, os: 'win32', architecture: 'x64' };
const source = { provider: 'modrinth', projectId: 'project-one', versionId: 'version-one', version: '1.0.0', title: 'Project One' };
const stale = error => error?.code === 'PLAN_STALE';

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-preflight-attempt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspaces');
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  let now = Date.parse('2026-10-11T08:00:00Z');
  let nextId = 0;
  const cacheReferences = new Map();
  const bytes = Buffer.from('pack');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const sha512 = crypto.createHash('sha512').update(bytes).digest('hex');
  const verified = finalizeVerifiedArtifactSet(createArtifactSetPlan({
    provider: 'modrinth', project: { id: 'project-one', slug: 'project-one', title: 'Project One' },
    release: { id: 'version-one', version: '1.0.0', channel: 'release', publishedAt: '2026-10-11T00:00:00Z' },
    artifactSet: { kind: 'single', groupingScheme: 'single', primaryPartId: 'part-one', providerImmutable: true, attestationStatus: 'verified',
      parts: [{ partId: 'part-one', fileName: 'pack.zip', size: '4', providerDigest: { algorithm: 'sha512', value: sha512 } }] }
  }), [{ partId: 'part-one', measuredSize: '4', sha256, sha512 }]);
  const registry = new ArtifactWorkspaceRegistry({
    root: workspaceRoot, clock: () => now, idFactory: () => `attempt-${++nextId}`, reparseInspector,
    artifactCache: {
      retain(digest) { cacheReferences.set(digest, (cacheReferences.get(digest) || 0) + 1); },
      release(digest) { cacheReferences.set(digest, cacheReferences.get(digest) - 1); },
      async materializeSet(_verified, destination, optionsForCreation = {}) {
      fs.mkdirSync(destination);
      optionsForCreation.onDestinationCreated?.();
      fs.writeFileSync(path.join(destination, 'pack.zip'), bytes);
      if (options.materialize) await options.materialize(destination);
      return path.join(destination, 'pack.zip');
      }
    },
    ...(options.removeTree ? { removeTree: options.removeTree } : {})
  });
  const materializer = new ArchiveInputMaterializer({ workspaceRegistry: registry, workspaceRoot });
  const context = await materializer.prepare(verified);
  const inspectionId = materializer.promote(context, {
    type: 'archive-inspection', archiveFamily: 'zip', integrity: 'tested', selectedRoot: null,
    engineEvidence: { family: 'zip', concreteFamily: 'zip', version: '26.02', tested: true },
    rootCandidates: ['config'],
    artifactSet: { completeness: 'verified-complete-set', fingerprint: computePlanFingerprint(verified) },
    classification: { kind: 'prepared-server-pack', confidence: 'exact', blocked: false, runtime },
    entries: [
      { entryName: 'config', canonicalName: 'config', type: 'directory', size: '0', packedSize: '0', depth: 1 },
      { entryName: 'config/changed.toml', canonicalName: 'config/changed.toml', type: 'file', size: '1', packedSize: '1', depth: 2 },
      { entryName: 'server.properties', canonicalName: 'server.properties', type: 'file', size: '0', packedSize: '0', depth: 1 }
    ],
    limitEvidence: { policyVersion: 1, totals: { entryCount: 3, fileCount: 2, directoryCount: 1, expandedBytes: '1', packedBytes: '1', maximumDepth: 2, maximumPathLength: 19 } }
  });
  const attempts = [];
  let activeCapability;
  const populateExtraction = async (destinationId, inputDirectoryId, preparationAttempt) => {
    const destination = registry.resolveOwnedWorkspace({ ownerId: inspectionId, id: destinationId, kind: 'output' }).path;
    fs.mkdirSync(path.join(destination, 'config'));
    fs.writeFileSync(path.join(destination, 'config', 'changed.toml'), '2');
    fs.writeFileSync(path.join(destination, 'server.properties'), '');
    attempts.push({ raw: destinationId, input: inputDirectoryId, capability: preparationAttempt });
    if (options.preparing) await options.preparing();
    if (options.failure) throw options.failure;
  };
  const archiveExtractor = options.realExtraction ? createArchiveExtractor({
    workspaceRegistry: registry, workspaceRoot, reparseInspector,
    diskProbe: async () => ({ availableBytes: '100000000000' }), watchdogIntervalMs: 1000,
    workerClient: { async run(request) {
      assert.equal(Object.hasOwn(request, 'preparationAttempt'), false, 'capability never enters worker or renderer JSON');
      assert.equal(request.operationId, inspectionId);
      assert.equal(request.artifactSetId, context.artifactSetId);
      await populateExtraction(request.outputDirectoryId, request.inputDirectoryId, activeCapability);
      return { type: 'status', ok: true, exitCode: 0, metrics: { stdoutBytes: '0', stderrBytes: '0', dataBytes: '0', elapsedMs: 1 } };
    } }
  }) : { async extractArchive({ destinationId, preparationAttempt }) {
    const materialized = await materializer.rematerialize(inspectionId, preparationAttempt);
    await populateExtraction(destinationId, materialized.inputDirectoryId, preparationAttempt);
  } };
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry: registry, reparseInspector, randomUUID: () => `prepared-${++nextId}`,
    artifactDownloader: { async downloadPart() { throw new Error('No external downloads expected'); } },
    artifactCache: { pathForSha256() { throw new Error('No external cache expected'); } },
    candidateHashService: {
      async hashFile(filePath) {
        const content = await fs.promises.readFile(filePath);
        return { identity: fileIdentityFromStat(await fs.promises.lstat(filePath, { bigint: true })), size: String(content.length),
          sha256: crypto.createHash('sha256').update(content).digest('hex') };
      }, async dispose() {}
    },
    archiveExtractor
  });
  const oldEntry = { path: 'config/changed.toml', pathKey: 'config/changed.toml', origin: 'pack', managementPolicy: 'replaceable-managed',
    role: 'configuration', installedHash: '1'.repeat(64), size: '1', priorBaseline: null };
  const adapter = new ProductionPlanningAdapter({
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    stateRepository: { read() { return { state: { modpackManaged: true, contentRevision: 7, runtime, selectedOptionalFiles: [], source },
      manifest: { schemaVersion: 1, installationId: 'installed-one', entries: [oldEntry] } }; } },
    reparseInspector, availableBytes: async () => '100000000000', validateServerPorts: async () => ({ valid: true, errors: [] }),
    preparePlanInputs: request => { activeCapability = request.preparationAttempt; return preparer.preparePlanInputs(request); },
    snapshotServer: async () => ({ liveSnapshot: { kind: 'existing', worldDirectories: ['world'], protectedPaths: [],
      entries: [{ path: oldEntry.path, pathKey: oldEntry.pathKey, type: 'file', sha256: '3'.repeat(64), size: '1' }] },
      pathPreconditions: [], sourceRuntime: runtime })
  });
  const planRegistry = new PlanRegistry({ workspaceRegistry: registry, clock: () => now, randomUUID: () => `plan-${++nextId}` });
  const service = new ModpackLifecycleService({
    sourceResolver: { async resolveArtifactSetPlan() {} }, artifactDownloader: { async downloadSet() {} },
    archiveInspector: { async inspectArchive() {} }, inspectionLoader: materializer,
    planningAdapter: adapter, planRegistry, workspaceRegistry: registry,
    operationStore: { async get() {}, async requestCancellation() {} }
  });
  service.inspections.set(inspectionId, { source, request: {} });
  const request = (choices = { paths: {}, categories: {} }) => ({ inspectionId, instanceId: 'server-one', operationKind: 'update',
    selections: { optionalFileIds: [], conflictChoices: choices, acknowledgeMissingProviderDigest: false,
      acknowledgeDowngradeWorldRisk: false, selectedRoot: null, runtimeChoice: null } });
  return { root, workspaceRoot, registry, materializer, inspectionId, originalInput: context.inputDirectoryId, artifactSetId: context.artifactSetId,
    service, adapter, planRegistry, attempts, request, cacheReferences, verified, bytes, advance(ms) { now += ms; },
    directory(id) { return path.join(workspaceRoot, id); } };
}

function ipcFixture(f) {
  const unused = async () => { throw new Error('Unexpected IPC dependency'); };
  const handlers = createModpackHandlers({
    providers: { modrinth: { searchProjects: unused, getProject: unused, listVersions: unused }, github: { listReleases: unused, loadUploadedAssets: unused } },
    localArtifactSource: { selectWithNativeDialog: unused }, destinationReservationService: { reserveWithNativeDialog: unused, release: unused },
    lifecycleService: f.service, recoveryService: { listRecovery: unused, recover: unused }, notificationStore: { list: unused, acknowledge: unused },
    releaseMonitor: { checkAll: unused, checkOne: unused }, releaseTrackingStore: { upsert: unused, list: unused }, outcomeActionService: { performSafeAction: unused }
  });
  const sender = new EventEmitter();
  sender.id = 42;
  sender.send = () => {};
  let destroyed = false;
  sender.isDestroyed = () => destroyed;
  const event = { sender };
  f.service.inspectSource = async () => ({ inspectionId: f.inspectionId });
  return { handlers, event, destroy() { destroyed = true; sender.emit('destroyed'); } };
}

for (const outcome of ['conflict', 'failure', 'full-plan']) {
  test(`real IPC sender teardown settles exact ${outcome} preflight and disposes all owned references`, async t => {
    let enter;
    let resume;
    let gated = false;
    const started = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const f = await fixture(t, { preparing: async () => { if (gated) { enter(); await gate; if (outcome === 'failure') throw new ModpackError('HASH_MISMATCH', 'Synthetic failure'); } } });
    let request = f.request();
    if (outcome === 'full-plan') {
      const review = await f.service.createPlan(request);
      request = f.request({ paths: Object.fromEntries(review.conflicts.map(c => [c.id, { choice: c.allowedChoices.includes('use-pack') ? 'use-pack' : 'keep-mine' }])), categories: {} });
    }
    const ipc = ipcFixture(f);
    assert.equal((await ipc.handlers['modpacks:inspect'](ipc.event, { provider: 'modrinth', projectId: 'project-one', versionId: 'version-one' })).ok, true);
    gated = true;
    const pending = ipc.handlers['modpacks:preflight'](ipc.event, request);
    t.after(async () => { resume(); await pending; });
    await started;
    const explicitDiscard = await ipc.handlers['modpacks:cancel-inspection'](ipc.event, { inspectionId: f.inspectionId });
    assert.equal(explicitDiscard.error.code, 'OPERATION_IN_PROGRESS');
    ipc.destroy();
    await new Promise(resolve => setImmediate(resolve));
    const disposal = f.service.inspectionDisposals.get(f.inspectionId).inFlight;
    assert.equal(f.registry.records.size > 3, true, 'trusted teardown must not release running preparation');
    resume();
    await pending;
    await disposal;
    assert.equal(f.service.inspections.has(f.inspectionId), false);
    assert.equal(f.registry.records.size, 0);
    assert.equal(f.planRegistry.plans.size, 0, 'undeliverable plan must not remain available to claim');
    assert.deepEqual(fs.readdirSync(f.workspaceRoot), []);
    assert.equal([...f.cacheReferences.values()].every(n => n === 0), true);
    f.advance(8 * 60 * 60 * 1000);
    assert.equal(await f.registry.sweepExpired(), 0);
    assert.equal(ipc.event.sender.listenerCount('destroyed'), 0);
  });
}

test('real cache input collision is never adopted or deleted by attempt retirement', async t => {
  const f = await fixture(t);
  const cache = new ArtifactCache({ root: path.join(f.root, 'cache'), workspaceRoot: f.workspaceRoot });
  const artifactPath = cache.pathForSha256(f.verified.artifactSet.parts[0].calculatedDigests.sha256);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, f.bytes);
  f.registry.artifactCache.materializeSet = cache.materializeSet.bind(cache);
  f.registry.idFactory = () => 'input-collision';
  const collision = f.directory('input-input-collision');
  fs.mkdirSync(collision);
  fs.writeFileSync(path.join(collision, 'sentinel'), 'pre-existing');
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  await assert.rejects(attempt.materializeInput(f.artifactSetId), error => error.code === 'INVALID_REQUEST');
  await attempt.retire();
  attempt.finish();
  assert.equal(fs.readFileSync(path.join(collision, 'sentinel'), 'utf8'), 'pre-existing');
  assert.equal(f.registry.records.size, 3);
});

test('real cache created partial input remains exact attempt authority after copy failure and cleanup retry', async t => {
  const f = await fixture(t);
  const cache = new ArtifactCache({ root: path.join(f.root, 'cache'), workspaceRoot: f.workspaceRoot });
  cache.copyAndVerify = async (_source, target) => { fs.writeFileSync(target, 'partial'); throw new ModpackError('HASH_MISMATCH', 'Synthetic copy failure'); };
  f.registry.artifactCache.materializeSet = cache.materializeSet.bind(cache);
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  await assert.rejects(attempt.materializeInput(f.artifactSetId), error => error.code === 'HASH_MISMATCH');
  const partial = [...f.registry.records.values()].find(r => r.kind === 'input' && r.id !== f.originalInput);
  assert.equal(fs.readFileSync(path.join(f.directory(partial.id), 'pack.zip'), 'utf8'), 'partial');
  const remove = f.registry.removeTree;
  f.registry.removeTree = async () => { throw new Error('Synthetic sharing failure'); };
  await assert.rejects(attempt.retire(), error => error.code === 'CLEANUP_FAILED');
  attempt.finish();
  f.registry.removeTree = remove;
  assert.equal(await f.service.cancelInspection(f.inspectionId), true);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), []);
  assert.equal(f.registry.records.size, 0);
});

test('trusted teardown retains retry authority after cleanup failure and service disposal completes the whole inspection', async t => {
  let enter;
  let resume;
  let failRemoval = true;
  const started = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const f = await fixture(t, { preparing: async () => { enter(); await gate; }, removeTree: async request => {
    if (failRemoval) throw new Error('Synthetic sharing violation');
    await fs.promises.rm(request.path, { recursive: true });
  } });
  const ipc = ipcFixture(f);
  await ipc.handlers['modpacks:inspect'](ipc.event, { provider: 'modrinth', projectId: 'project-one', versionId: 'version-one' });
  const pending = ipc.handlers['modpacks:preflight'](ipc.event, f.request());
  t.after(async () => { resume(); await pending; });
  await started;
  ipc.destroy();
  const disposal = f.service.inspectionDisposals.get(f.inspectionId).inFlight;
  assert.equal(f.service.disposeInspection(f.inspectionId), disposal, 'trusted repeated teardown joins exact in-flight intent');
  const failedDisposal = assert.rejects(disposal, /Synthetic sharing violation/);
  resume();
  assert.equal((await pending).error.code, 'CLEANUP_FAILED');
  await failedDisposal;
  assert.equal(f.service.inspectionDisposals.has(f.inspectionId), true);
  assert.equal(f.service.inspections.has(f.inspectionId), true);
  await assert.rejects(f.service.createPlan(f.request()), error => error.code === 'OPERATION_IN_PROGRESS');
  failRemoval = false;
  await f.service.dispose();
  assert.equal(f.service.inspectionDisposals.size, 0);
  assert.equal(f.service.inspections.size, 0);
  assert.equal(f.registry.records.size, 0);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), []);
  assert.equal([...f.cacheReferences.values()].every(n => n === 0), true);
});

test('sender teardown at sealed-plan completion invalidates only that undeliverable plan before IPC success', async t => {
  const f = await fixture(t);
  const review = await f.service.createPlan(f.request());
  const request = f.request({ paths: Object.fromEntries(review.conflicts.map(c => [c.id, { choice: c.allowedChoices.includes('use-pack') ? 'use-pack' : 'keep-mine' }])), categories: {} });
  const ipc = ipcFixture(f);
  await ipc.handlers['modpacks:inspect'](ipc.event, { provider: 'modrinth', projectId: 'project-one', versionId: 'version-one' });
  let sealed;
  ipc.event.sender.send = (_channel, progress) => {
    if (progress.phase === 'complete') {
      sealed = [...f.planRegistry.plans.keys()][0];
      assert.equal(typeof sealed, 'string');
      ipc.destroy();
    }
  };
  const result = await ipc.handlers['modpacks:preflight'](ipc.event, { ...request, requestId: 'sealed-completion' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(f.planRegistry.plans.has(sealed), false);
  assert.equal(f.registry.records.size, 0);
  assert.equal(f.service.inspectionDisposals.size, 0);
});

test('trusted teardown never releases a plan already claimed by an authorized runtime', async t => {
  const f = await fixture(t);
  const review = await f.service.createPlan(f.request());
  const request = f.request({ paths: Object.fromEntries(review.conflicts.map(c => [c.id, { choice: c.allowedChoices.includes('use-pack') ? 'use-pack' : 'keep-mine' }])), categories: {} });
  let disposal;
  let claimed;
  const originalCreate = f.planRegistry.create.bind(f.planRegistry);
  f.planRegistry.create = options => {
    const result = originalCreate(options);
    claimed = f.planRegistry.claim({ planId: result.planId, fingerprint: result.fingerprint });
    disposal = f.service.disposeInspection(f.inspectionId);
    return result;
  };
  await f.service.createPlan(request);
  const runtime = await claimed;
  await disposal;
  assert.equal(f.planRegistry.claimedJobIds.has(runtime.jobId), true);
  assert.equal(f.registry.records.size, 4);
  assert.equal([...f.registry.records.values()].every(r => r.ownerId === runtime.jobId), true);
  await f.planRegistry.releaseClaim(runtime.jobId);
});

for (const boundary of ['unclaimed', 'cleanup-retry', 'claimed']) {
  test(`microtask sender destruction before IPC delivery preserves exact ${boundary} plan authority`, async t => {
    let failRemoval = false;
    const f = await fixture(t, { removeTree: async request => {
      if (failRemoval) throw new Error('Synthetic undeliverable-plan sharing violation');
      await fs.promises.rm(request.path, { recursive: true });
    } });
    const review = await f.service.createPlan(f.request());
    const request = f.request({ paths: Object.fromEntries(review.conflicts.map(c => [c.id, { choice: c.allowedChoices.includes('use-pack') ? 'use-pack' : 'keep-mine' }])), categories: {} });
    const ipc = ipcFixture(f);
    await ipc.handlers['modpacks:inspect'](ipc.event, { provider: 'modrinth', projectId: 'project-one', versionId: 'version-one' });
    let sealed;
    let claimed;
    ipc.event.sender.send = (_channel, progress) => {
      if (progress.phase === 'complete') queueMicrotask(() => {
        assert.equal(f.service.planningInspections.size, 0, 'destruction is after lifecycle finally');
        const record = [...f.planRegistry.plans.values()][0];
        sealed = record.planId;
        if (boundary === 'claimed') claimed = f.planRegistry.claim({ planId: record.planId, fingerprint: record.fingerprint });
        failRemoval = boundary === 'cleanup-retry';
        ipc.destroy();
      });
    };
    const result = await ipc.handlers['modpacks:preflight'](ipc.event, { ...request, requestId: `microtask-${boundary}` });
    assert.equal(result.ok, false, 'destroyed owner must not receive a usable credential');
    if (boundary === 'claimed') {
      const runtime = await claimed;
      assert.equal(f.registry.records.size, 4);
      assert.equal([...f.registry.records.values()].every(r => r.ownerId === runtime.jobId), true);
      assert.equal(f.planRegistry.claimedJobIds.has(runtime.jobId), true);
      await f.planRegistry.releaseClaim(runtime.jobId);
    } else if (boundary === 'cleanup-retry') {
      assert.equal(f.planRegistry.plans.has(sealed), true);
      assert.equal(f.service.inspectionDisposals.get(f.inspectionId)?.attempt?.planId, sealed, 'failed exact invalidation retains retry authority');
      failRemoval = false;
      await f.service.dispose();
    }
    assert.equal(f.planRegistry.plans.size, 0);
    assert.equal(f.registry.records.size, 0);
    assert.equal(f.service.inspectionDisposals.size, 0);
    assert.deepEqual(fs.readdirSync(f.workspaceRoot), []);
    assert.equal([...f.cacheReferences.values()].every(n => n === 0), true);
  });
}

test('undeliverable-result disposal rejects forged, cloned, and cross-service result authority', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const review = await f.service.createPlan(f.request());
  const request = f.request({ paths: Object.fromEntries(review.conflicts.map(c => [c.id, { choice: c.allowedChoices.includes('use-pack') ? 'use-pack' : 'keep-mine' }])), categories: {} });
  const result = await f.service.createPlan(request);
  for (const forged of [{ planId: result.planId }, { ...result }, JSON.parse(JSON.stringify(result)), null]) {
    assert.throws(() => f.service.disposeUndeliverablePlan(forged), error => error.code === 'INVALID_REQUEST');
  }
  assert.throws(() => other.service.disposeUndeliverablePlan(result), error => error.code === 'INVALID_REQUEST');
  assert.equal(f.planRegistry.plans.has(result.planId), true);
  assert.equal(f.registry.records.size, 4);
  await f.service.disposeUndeliverablePlan(result);
  assert.equal(f.registry.records.size, 0);
});

test('real cache exclusive-mkdir collision after freshness check preserves racing destination bytes', async t => {
  const f = await fixture(t);
  f.registry.idFactory = () => 'racing-input';
  const destination = f.directory('input-racing-input');
  const cache = new ArtifactCache({ root: path.join(f.root, 'cache'), workspaceRoot: f.workspaceRoot, fsApi: {
    ...fs.promises,
    async mkdir(target, options) {
      if (target === destination) {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'sentinel'), 'racing sibling');
      }
      return fs.promises.mkdir(target, options);
    }
  } });
  f.registry.artifactCache.materializeSet = cache.materializeSet.bind(cache);
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  await assert.rejects(attempt.materializeInput(f.artifactSetId), error => error.code === 'EEXIST');
  await attempt.retire();
  attempt.finish();
  assert.equal(fs.readFileSync(path.join(destination, 'sentinel'), 'utf8'), 'racing sibling');
  assert.equal(f.registry.records.size, 3);
});

test('input identity failure immediately after exclusive creation remains exact cleanup authority', async t => {
  const f = await fixture(t);
  const cache = new ArtifactCache({ root: path.join(f.root, 'cache'), workspaceRoot: f.workspaceRoot });
  f.registry.artifactCache.materializeSet = cache.materializeSet.bind(cache);
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  const originalLstat = fs.lstatSync;
  let created;
  fs.lstatSync = (target, ...args) => {
    if (path.dirname(String(target)) === f.workspaceRoot && path.basename(String(target)).startsWith('input-') && target !== f.directory(f.originalInput)) {
      created = target;
      throw Object.assign(new Error('Synthetic input identity failure'), { code: 'EIO' });
    }
    return originalLstat(target, ...args);
  };
  try { await assert.rejects(attempt.materializeInput(f.artifactSetId), error => error.code === 'EIO'); }
  finally { fs.lstatSync = originalLstat; }
  assert.equal(fs.existsSync(created), true);
  await attempt.retire();
  attempt.finish();
  assert.equal(fs.existsSync(created), false);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
});

for (const delay of [TTL_MS - 1, TTL_MS, 31 * 60 * 1000, 8 * 60 * 60 * 1000]) {
  test(`actual production conflict review retires its attempt before a resolved retry after ${delay}ms`, async t => {
    const f = await fixture(t);
    const review = await f.service.createPlan(f.request());
    assert.equal(review.requiresConflictReview, true);
    assert.equal(f.attempts.length, 1);
    const first = f.attempts[0];
    assert.equal(fs.existsSync(f.directory(first.raw)), false, 'conflict raw output must be retired');
    assert.equal(fs.existsSync(f.directory(first.input)), false, 'conflict rematerialization must be retired');
    assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput], 'conflict template must also be retired');
    assert.equal(fs.readFileSync(path.join(f.directory(f.originalInput), 'pack.zip'), 'utf8'), 'pack');
    f.advance(delay);
    const result = await f.service.createPlan(f.request({ paths: Object.fromEntries(review.conflicts.map(conflict =>
      [conflict.id, { choice: conflict.allowedChoices.includes('use-pack') ? 'use-pack' : 'keep-mine' }])), categories: {} }));
    const sealed = await f.planRegistry.get({ planId: result.planId, fingerprint: result.planFingerprint });
    const template = f.adapter.getExecutionRecord(sealed.plan).execution.templateOutputId;
    assert.equal(f.registry.resolveOwnedWorkspace({ ownerId: result.planId, id: template, kind: 'output' }).id, template);
    assert.deepEqual(fs.readdirSync(f.workspaceRoot).sort(), [f.originalInput, template].sort());
    assert.equal(fs.readFileSync(path.join(f.directory(template), 'config', 'changed.toml'), 'utf8'), '2');
    assert.throws(() => first.capability.createStagingOutput(), stale);
  });
}

test('same-inspection concurrent preflight and discard reject before they can disturb the active attempt', async t => {
  let entered;
  let resume;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const outstanding = [];
  t.after(async () => { resume(); await Promise.allSettled(outstanding); });
  const f = await fixture(t, { preparing: async () => { entered(); await gate; } });
  const pending = f.service.createPlan(f.request());
  outstanding.push(pending);
  await started;
  const concurrent = f.service.createPlan(f.request());
  outstanding.push(concurrent);
  await assert.rejects(Promise.race([concurrent,
    new Promise(resolve => setImmediate(() => resolve('concurrent preflight was not rejected')))]), error => error.code === 'OPERATION_IN_PROGRESS');
  await assert.rejects(f.service.cancelInspection(f.inspectionId), error => error.code === 'OPERATION_IN_PROGRESS');
  await assert.rejects(f.service.dispose(), error => error.code === 'OPERATION_IN_PROGRESS');
  f.advance(8 * 60 * 60 * 1000);
  assert.equal(await f.registry.sweepExpired(), 0);
  assert.equal(f.attempts.length, 1);
  assert.equal(fs.existsSync(f.directory(f.attempts[0].raw)), true);
  resume();
  // Expired required raw/input authority must still fail; the active lease is not a TTL bypass.
  await assert.rejects(pending, stale);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
  assert.equal(await f.service.cancelInspection(f.inspectionId), true);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), []);
});

test('preparation failure retires only its attempt and leaves normal inspection discard usable', async t => {
  const f = await fixture(t, { failure: new ModpackError('EXTRACTOR_FAILED', 'Synthetic extraction failed') });
  await assert.rejects(f.service.createPlan(f.request()), error => error.code === 'EXTRACTOR_FAILED');
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
  assert.equal(f.materializer.loadInspection(f.inspectionId).artifactSetId, f.artifactSetId);
  assert.equal(await f.service.cancelInspection(f.inspectionId), true);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), []);
});

test('failed attempt cleanup refuses another preflight and discard retries partial cleanup then disposes the entire inspection', async t => {
  let fail = true;
  const removalPaths = [];
  const f = await fixture(t, { async removeTree(request) {
    removalPaths.push(request.path);
    if (fail) throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
    await fs.promises.rm(request.path, { recursive: true, force: false });
  } });
  await assert.rejects(f.service.createPlan(f.request()), error => error.code === 'CLEANUP_FAILED');
  const failedPath = removalPaths[0];
  assert.equal(f.attempts.length, 1);
  await assert.rejects(f.service.createPlan(f.request()), stale);
  assert.equal(f.attempts.length, 1, 'new preflight must not allocate while exact cleanup is pending');
  assert.equal(fs.existsSync(f.directory(f.originalInput)), true);
  fail = false;
  assert.equal(await f.service.cancelInspection(f.inspectionId), true);
  assert.equal(removalPaths[1], failedPath, 'discard resumes the exact partial quarantine');
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), []);
  assert.equal(f.registry.records.size, 0, 'whole-inspection disposal must not leak original artifact references');
  assert.deepEqual([...f.cacheReferences.values()], [0]);
  assert.equal(await f.service.cancelInspection(f.inspectionId), false);
});

test('attempt capability rejects forged, cross-owner, wrong-template, and completed allocations', async t => {
  const f = await fixture(t);
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  assert.throws(() => f.registry.beginPreparationAttempt({ ownerId: f.inspectionId }), stale);
  assert.throws(() => f.registry.createStagingOutput({ ownerId: f.inspectionId, preparationAttempt: {} }), stale);
  assert.throws(() => f.registry.createStagingOutput({ ownerId: 'another-owner', preparationAttempt: attempt }), stale);
  const output = attempt.createStagingOutput();
  const input = await attempt.materializeInput(f.artifactSetId);
  await assert.rejects(attempt.retire({ templateOutputId: f.originalInput }), stale);
  await assert.rejects(attempt.retire({ templateOutputId: input }), stale);
  assert.throws(() => f.registry.transferOwnership({ fromOwnerId: f.inspectionId, toOwnerId: 'plan-forged' }), stale);
  await attempt.retire({ templateOutputId: output });
  assert.throws(() => attempt.createStagingOutput(), stale);
  assert.throws(() => f.registry.transferOwnership({ fromOwnerId: f.inspectionId, toOwnerId: 'plan-forged', preparationAttempt: {} }), stale);
  assert.equal(f.registry.transferOwnership({ fromOwnerId: f.inspectionId, toOwnerId: 'plan-valid', preparationAttempt: attempt }), 4);
  attempt.finish();
  await assert.rejects(attempt.retire(), stale);
  assert.throws(() => attempt.createStagingOutput(), stale);
  assert.equal(fs.existsSync(f.directory(input)), false);
  assert.equal(fs.existsSync(f.directory(output)), true);
});

test('attempt finish and owner release cannot race pending materialization or targeted cleanup', async t => {
  const f = await fixture(t);
  let resume;
  f.registry.artifactCache.materializeSet = async (_set, destination, { onDestinationCreated }) => {
    fs.mkdirSync(destination);
    onDestinationCreated();
    fs.writeFileSync(path.join(destination, 'pack.zip'), 'pack');
    await new Promise(resolve => { resume = resolve; });
    return path.join(destination, 'pack.zip');
  };
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  const materializing = attempt.materializeInput(f.artifactSetId);
  assert.throws(() => attempt.finish(), stale);
  assert.throws(() => f.registry.releaseOwner(f.inspectionId), stale);
  await assert.rejects(attempt.retire(), stale);
  f.advance(8 * 60 * 60 * 1000);
  assert.equal(await f.registry.sweepExpired(), 0);
  resume();
  await materializing;
  let releaseCleanup;
  let cleanupStarted;
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  const announced = new Promise(resolve => { cleanupStarted = resolve; });
  f.registry.removeTree = async request => { cleanupStarted(); await cleanupGate; await fs.promises.rm(request.path, { recursive: true }); };
  const cleanup = attempt.retire();
  await announced;
  assert.throws(() => attempt.finish(), stale);
  assert.throws(() => f.registry.releaseOwner(f.inspectionId), stale);
  assert.throws(() => f.registry.transferOwnership({ fromOwnerId: f.inspectionId, toOwnerId: 'plan-racing', preparationAttempt: attempt }), stale);
  releaseCleanup();
  await cleanup;
  attempt.finish();
  assert.equal(await f.service.cancelInspection(f.inspectionId), true);
});

test('failed output allocation does not claim or delete a pre-existing colliding directory', async t => {
  const f = await fixture(t);
  f.registry.idFactory = () => 'collision';
  const collision = f.directory('output-collision');
  fs.mkdirSync(collision);
  fs.writeFileSync(path.join(collision, 'sentinel.txt'), 'not allocated by this attempt');
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  assert.throws(() => attempt.createStagingOutput(), error => error.code === 'EEXIST');
  await attempt.retire();
  attempt.finish();
  assert.equal(fs.readFileSync(path.join(collision, 'sentinel.txt'), 'utf8'), 'not allocated by this attempt');
  assert.equal(f.registry.records.size, 3);
});

test('output identity failure after directory creation remains registered for exact-attempt cleanup', async t => {
  const f = await fixture(t);
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  const originalLstat = fs.lstatSync;
  let failedDirectory;
  fs.lstatSync = (candidate, ...args) => {
    if (path.dirname(String(candidate)) === f.workspaceRoot && path.basename(String(candidate)).startsWith('output-')) {
      failedDirectory = String(candidate);
      throw Object.assign(new Error('synthetic identity read failure'), { code: 'EIO' });
    }
    return originalLstat(candidate, ...args);
  };
  try { assert.throws(() => attempt.createStagingOutput(), error => error.code === 'EIO'); }
  finally { fs.lstatSync = originalLstat; }
  assert.equal(fs.existsSync(failedDirectory), true);
  await attempt.retire();
  attempt.finish();
  assert.equal(fs.existsSync(failedDirectory), false, 'created output must not escape attempt bookkeeping');
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
});

test('failed rematerialization retires the exact partial input without releasing original inspection authority', async t => {
  let fail = false;
  const f = await fixture(t, { async materialize() { if (fail) throw new ModpackError('HASH_MISMATCH', 'Synthetic archive bytes changed'); } });
  fail = true;
  await assert.rejects(f.service.createPlan(f.request()), error => error.code === 'HASH_MISMATCH');
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
  assert.equal(f.materializer.loadInspection(f.inspectionId).artifactSetId, f.artifactSetId);
  assert.equal(await f.service.cancelInspection(f.inspectionId), true);
});

test('targeted retirement never accepts a same-owner sibling template or deletes unrelated owner records', async t => {
  const f = await fixture(t);
  const sibling = f.registry.createStagingOutput({ ownerId: f.inspectionId });
  const unrelated = f.registry.createStagingOutput({ ownerId: 'unrelated-owner' });
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  const current = attempt.createStagingOutput();
  await assert.rejects(attempt.retire({ templateOutputId: sibling }), stale);
  await attempt.retire();
  attempt.finish();
  assert.equal(fs.existsSync(f.directory(current)), false);
  assert.equal(fs.existsSync(f.directory(sibling)), true);
  assert.equal(fs.existsSync(f.directory(unrelated)), true);
  assert.equal(fs.existsSync(f.directory(f.originalInput)), true);
});

test('required successful template still expires between targeted cleanup and plan ownership transfer', async t => {
  const f = await fixture(t);
  const attempt = f.registry.beginPreparationAttempt({ ownerId: f.inspectionId });
  const template = attempt.createStagingOutput();
  await attempt.retire({ templateOutputId: template });
  f.advance(TTL_MS);
  assert.throws(() => f.registry.transferOwnership({ fromOwnerId: f.inspectionId, toOwnerId: 'plan-late', preparationAttempt: attempt }), stale);
  await attempt.retire();
  attempt.finish();
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
});

test('lifecycle rejects a private execution record naming a non-attempt template and retires the current candidate', async t => {
  const f = await fixture(t);
  const review = await f.service.createPlan(f.request());
  f.adapter.getExecutionRecord = () => ({ execution: { templateOutputId: f.originalInput } });
  await assert.rejects(f.service.createPlan(f.request({ paths: Object.fromEntries(review.conflicts.map(conflict =>
    [conflict.id, { choice: conflict.allowedChoices.includes('use-pack') ? 'use-pack' : 'keep-mine' }])), categories: {} })), stale);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
  assert.equal(await f.service.cancelInspection(f.inspectionId), true);
});

test('real archive extractor keeps rematerialization in the attempt through actual production conflict return and eight-hour retry', async t => {
  const f = await fixture(t, { realExtraction: true });
  const review = await f.service.createPlan(f.request());
  assert.equal(review.requiresConflictReview, true);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
  f.advance(8 * 60 * 60 * 1000);
  const result = await f.service.createPlan(f.request({ paths: Object.fromEntries(review.conflicts.map(conflict =>
    [conflict.id, { choice: conflict.allowedChoices.includes('use-pack') ? 'use-pack' : 'keep-mine' }])), categories: {} }));
  const sealed = await f.planRegistry.get({ planId: result.planId, fingerprint: result.planFingerprint });
  const template = f.adapter.getExecutionRecord(sealed.plan).execution.templateOutputId;
  assert.deepEqual(fs.readdirSync(f.workspaceRoot).sort(), [f.originalInput, template].sort());
  assert.equal(f.registry.resolveOwnedWorkspace({ ownerId: result.planId, id: f.originalInput, kind: 'input' }).id, f.originalInput);
});

test('source preflight fails closed without a real workspace registry capability issuer', async t => {
  const f = await fixture(t);
  f.service.workspaceRegistry = null;
  await assert.rejects(f.service.createPlan(f.request()), error => error.code === 'INVALID_REQUEST');
  assert.equal(f.attempts.length, 0);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
});

test('source preflight never seals after a private execution record omits its required template', async t => {
  const f = await fixture(t);
  const review = await f.service.createPlan(f.request());
  f.adapter.getExecutionRecord = () => ({ execution: {} });
  const choices = { paths: Object.fromEntries(review.conflicts.map(conflict =>
    [conflict.id, { choice: conflict.allowedChoices.includes('use-pack') ? 'use-pack' : 'keep-mine' }])), categories: {} };
  await assert.rejects(f.service.createPlan(f.request(choices)), error => error.code === 'INVALID_REQUEST');
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), [f.originalInput]);
});

test('preparation plus cleanup failure retains both causes and ordinary discard can finish exact cleanup', async t => {
  let fail = true;
  const primary = new ModpackError('EXTRACTOR_FAILED', 'Synthetic extraction failed');
  const f = await fixture(t, { failure: primary, async removeTree(request) {
    if (fail) throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
    await fs.promises.rm(request.path, { recursive: true });
  } });
  await assert.rejects(f.service.createPlan(f.request()), error => error.code === 'CLEANUP_FAILED' &&
    error.cause instanceof AggregateError && error.cause.errors.includes(primary));
  fail = false;
  assert.equal(await f.service.cancelInspection(f.inspectionId), true);
  assert.equal(f.registry.records.size, 0);
  assert.deepEqual(fs.readdirSync(f.workspaceRoot), []);
});
