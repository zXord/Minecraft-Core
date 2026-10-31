const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../../electron/services/modpacks/contracts.cjs');
const { ProductionCandidatePreparer } = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');
const { ProductionPlanningAdapter } = require('../../electron/services/modpacks/planning/production-planning-adapter.cjs');
const { createProductionServerSnapshot } = require('../../electron/services/modpacks/planning/production-server-snapshot.cjs');
const { planOwnership } = require('../../electron/services/modpacks/planning/ownership-planner.cjs');
const quiescent = require('../../electron/services/modpacks/planning/quiescent-plan-revalidation.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { runningServerFs } = require('./running-server-fs-fixture.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inspector = { async isReparsePoint() { return false; } };

function runtimeWithObservedReconciler(receivedManifests) {
  // Observe the real dependency boundary without a production-only test seam.
  // Delegate every call to the actual reconciler, including all its checks.
  const filename = require.resolve('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const regularRequire = Module.createRequire(filename);
  loaded.require = name => name === '../modpacks/planning/quiescent-plan-revalidation.cjs'
    ? { ...quiescent, reconcileQuiescentOwnership(input) {
        receivedManifests.push(input.incomingManifest);
        return quiescent.reconcileQuiescentOwnership(input);
      } }
    : regularRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports.ProductionMutationRuntime;
}

// `running`: the review reads the folder while the server runs and holds its
// world lock, as a server Minecraft Core started (`appStarted`) or one it did
// not. `recordedWorld`: an earlier update or adoption recorded the world, its
// lock included, as the user's files.
async function fixture(t, kind = 'prepared-server-pack', { recordedWorld = false, running = false, appStarted = running } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-repair-desired-contract-'));
  const serverPath = path.join(root, 'server');
  const archivePath = path.join(root, 'archive');
  fs.mkdirSync(serverPath);
  fs.mkdirSync(archivePath);
  const write = (directory, relative, bytes) => {
    const destination = path.join(directory, ...relative.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  };
  const packFiles = new Map([
    ['config/corrupt.toml', 'enabled=true\n'],
    ['config/nested/child.txt', 'nested healthy config'],
    ['config/nested.toml', 'healthy sibling config'],
    ['mods/healthy.jar', 'healthy managed pack mod']
  ]);
  for (const [relative, bytes] of packFiles) write(serverPath, relative, bytes);
  const runtimeJar = new AdmZip();
  runtimeJar.addFile('version.json', Buffer.from(JSON.stringify({ id: kind === 'mrpack-server' ? '1.21.1' : '1.20.1' })));
  const runtimeBytes = runtimeJar.toBuffer();
  write(serverPath, 'server.jar', runtimeBytes);
  write(serverPath, 'scripts/user.js', 'untracked executable addon');
  write(serverPath, 'world/notes.txt', 'untracked passive world data');
  const worldFiles = { 'world/level.dat': 'level', 'world/session.lock': '☃' };
  if (running || recordedWorld) for (const [relative, bytes] of Object.entries(worldFiles)) write(serverPath, relative, bytes);
  write(serverPath, '.minecraft-core.json', JSON.stringify({ contentRevision: 4 }));
  write(serverPath, 'config/corrupt.toml', 'corrupt before review');
  const runtimeTuple = kind === 'mrpack-server'
    ? { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10', javaMajor: 21, os: 'win32', architecture: 'x64' }
    : { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13', javaMajor: 17, os: 'win32', architecture: 'x64' };
  const sha512 = 'b'.repeat(128);
  const verified = finalizeVerifiedArtifactSet(createArtifactSetPlan({
    provider: 'modrinth', project: { id: 'project-one', slug: 'project-one', title: 'Project One' },
    release: { id: 'version-one', version: '1.0.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' },
    artifactSet: {
      kind: 'single', primaryPartId: 'part-one', groupingScheme: 'single', providerImmutable: true, attestationStatus: 'verified',
      parts: [{ partId: 'part-one', fileName: kind === 'mrpack-server' ? 'fixture.mrpack' : 'fixture.zip', size: '1',
        providerDigest: { algorithm: 'sha512', value: sha512 } }]
    }
  }), [{ partId: 'part-one', measuredSize: '1', sha256: 'a'.repeat(64), sha512 }]);
  const source = { provider: 'modrinth', projectId: 'project-one', versionId: 'version-one', version: '1.0.0', title: 'Project One' };
  const ownedEntry = (relative, bytes, origin, role) => ({
    path: relative, pathKey: relative, origin, managementPolicy: 'replaceable-managed', role,
    installedHash: digest(bytes), size: String(Buffer.byteLength(bytes)), priorBaseline: null
  });
  const currentState = {
    state: { modpackManaged: true, contentRevision: 4, runtime: runtimeTuple, selectedOptionalFiles: [],
      source: { ...source, artifactSetDigest: verified.artifactSet.setDigest } },
    manifest: { schemaVersion: 1, installationId: 'installation-current', entries: [
      ...[...packFiles].map(([relative, bytes]) => ownedEntry(relative, bytes, 'pack', relative.startsWith('mods/') ? 'mod' : 'configuration')),
      ownedEntry('server.jar', runtimeBytes, 'runtime', 'server'),
      ...(recordedWorld ? Object.entries(worldFiles).map(([relative, bytes]) =>
        ({ ...ownedEntry(relative, bytes, 'user', 'world'), managementPolicy: 'protected' })) : [])
    ] }
  };
  const archiveEntries = [];
  const addArchiveFile = (relative, bytes) => {
    write(archivePath, relative, bytes);
    archiveEntries.push({ entryName: relative, canonicalName: relative, type: 'file', size: String(Buffer.byteLength(bytes)) });
  };
  if (kind === 'mrpack-server') {
    const healthyBytes = Buffer.from(packFiles.get('mods/healthy.jar'));
    addArchiveFile('modrinth.index.json', JSON.stringify({
      formatVersion: 1, game: 'minecraft', versionId: 'version-one', name: 'Contract Fixture',
      dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' },
      files: [{ path: 'mods/healthy.jar', fileSize: healthyBytes.length,
        hashes: { sha1: crypto.createHash('sha1').update(healthyBytes).digest('hex'),
          sha512: crypto.createHash('sha512').update(healthyBytes).digest('hex') },
        env: { client: 'required', server: 'required' },
        downloads: ['https://cdn.modrinth.com/data/project/version/healthy.jar'] }]
    }));
    for (const [relative, bytes] of packFiles) {
      if (!relative.startsWith('mods/')) addArchiveFile(`overrides/${relative}`, bytes);
    }
  } else {
    for (const [relative, bytes] of packFiles) addArchiveFile(relative, bytes);
  }
  let outputSequence = 0;
  const outputs = new Map();
  const workspaceRegistry = {
    createStagingOutput({ ownerId }) {
      const id = `output-${++outputSequence}`;
      const output = path.join(root, id);
      fs.mkdirSync(output);
      outputs.set(id, { path: output, ownerId });
      return id;
    },
    resolveOwnedWorkspace({ id, ownerId, kind: requestedKind }) {
      assert.equal(requestedKind, 'output');
      const output = outputs.get(id);
      assert.equal(output.ownerId, ownerId);
      return { id, kind: 'output', path: output.path };
    }
  };
  let runtimePreparations = 0;
  let candidatePreparations = 0;
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: { async extractArchive({ destinationId }) {
      candidatePreparations += 1;
      await fs.promises.cp(archivePath, outputs.get(destinationId).path, { recursive: true });
    } },
    artifactDownloader: { async downloadPart() { assert.fail('healthy MRPACK parts must not be downloaded during repair'); } },
    artifactCache: { pathForSha256() { assert.fail('no repair download should require cached content'); } },
    reparseInspector: inspector, randomUUID: () => '00000000-0000-4000-8000-000000000001'
  });
  t.after(async () => { await preparer.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const stateRepository = {
    read() { return currentState; }, listHistory() { return { items: [], nextCursor: null }; },
    async writeCandidateAsync() { assert.fail('revalidation must not persist a candidate'); },
    async appendHistoryAsync() { assert.fail('revalidation must not commit history'); }
  };
  const instanceResolver = { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: appStarted }; } };
  const snapshotServer = createProductionServerSnapshot({ fsApi: fs, reparseInspector: inspector, stateRepository });
  const adapter = new ProductionPlanningAdapter({
    instanceResolver, stateRepository, reparseInspector: inspector,
    snapshotServer: running
      ? createProductionServerSnapshot({
          fsApi: fs, reparseInspector: inspector, stateRepository,
          fsPromises: runningServerFs({ locked: [path.join(serverPath, 'world', 'session.lock')] })
        })
      : snapshotServer,
    availableBytes: async () => '1000000000000', validateServerPorts: async () => ({ valid: true, errors: [] }),
    preparePlanInputs: context => preparer.preparePlanInputs(context)
  });
  const inspection = {
    inspectionId: 'inspection-one', verifiedArtifactSet: verified,
    result: {
      type: 'archive-inspection', archiveFamily: kind === 'mrpack-server' ? 'mrpack' : 'zip', integrity: 'tested', selectedRoot: null,
      entries: archiveEntries, artifactSet: { completeness: 'verified-complete-set', fingerprint: 'a'.repeat(64) },
      classification: { kind, confidence: 'exact', blocked: false, runtime: {
        minecraftVersion: runtimeTuple.minecraftVersion, loaderFamily: runtimeTuple.loaderFamily, loaderVersion: runtimeTuple.loaderVersion
      } },
      limitEvidence: { totals: { entryCount: archiveEntries.length,
        expandedBytes: archiveEntries.reduce((total, e) => total + BigInt(e.size), 0n).toString() } }
    }
  };
  const reviewed = await adapter.createPlan({
    request: { inspectionId: inspection.inspectionId, instanceId: 'server-one', operationKind: 'repair', selections: {} },
    inspection, source
  });
  const plan = reviewed.plan;
  const executionRecord = adapter.getExecutionRecord(plan);
  // Normal lifecycle claim transfers the already-reviewed workspace owner.
  for (const output of outputs.values()) output.ownerId = 'job-repair';
  if (!running) {
    const snapshot = await snapshotServer({ currentState, operationKind: 'repair', runtime: runtimeTuple, serverKind: 'existing', serverPath });
    assert.notDeepEqual(snapshot.pathPreconditions, plan.preconditions.paths, 'fixture must enter reordered-path reconciliation');
    assert.deepEqual([...snapshot.pathPreconditions].sort((a, b) => a.pathKey.localeCompare(b.pathKey, 'en-US')), plan.preconditions.paths,
      'the baseline discrepancy must be ordering only');
  }
  const ownershipManifests = [];
  const reconcilerManifests = [];
  const Runtime = runtimeWithObservedReconciler(reconcilerManifests);
  let recoveryRecord = null;
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 4,
    bumpContentRevision() { assert.fail('revalidation must not publish a revision'); } });
  coordinator.completeStartupRecovery([]);
  const runtime = new Runtime({
    coordinator,
    availableBytes: async () => '1000000000000', instanceResolver, planningAdapter: adapter, snapshotServer,
    workspaceRegistry, stateRepository, reparseInspector: inspector, fsApi: fs, userDataPath: root,
    planOwnershipFn(input) { ownershipManifests.push(input.incomingManifest); return planOwnership(input); },
    durableFsFactory: () => ({ async flushDirectoryAsync() {}, async renameDurableAsync() {}, async writeFileAtomicAsync() {} }),
    destinationReservations: { resolve() { return null; }, consume() { assert.fail('existing server reservation'); }, release() {} },
    healthValidator: { async validateCandidate() { assert.fail('no boot'); }, async validateLive() { assert.fail('no boot'); } },
    prepareRuntime: async () => { runtimePreparations += 1; assert.fail('healthy runtime must not be prepared in revalidation'); },
    releaseTrackingStore: { async list() { return []; }, async remove() {}, async upsert() {} },
    store: { get() { return []; }, set() {} },
    recoveryServices: {
      registry: {
        async create(value) { recoveryRecord = value; }, async load() { return recoveryRecord; },
        async transition(_id, request) { recoveryRecord = { ...recoveryRecord, ...request.patch, phase: request.nextPhase }; return recoveryRecord; },
        async finish() { return recoveryRecord; }
      },
      runtimeWriterAuthority: { async run(_jobId, work) { return work(); }, async assertRecoveryAllowed(value) { return value; } },
      recoveryService: { async recoverWithLease() {}, async rollbackWithLease() {}, async failNewWithLease() {} },
      runtimePolicy: { async suspend() {}, async ensureStopped() {}, async adoptValidatedHandoff() {}, async restoreAutoRestart() {} }
    }
  });
  const resolved = { instanceId: 'server-one', serverPath, priorRunning: appStarted };
  const lease = { kind: 'mutation', instanceId: 'server-one', serverPath, baseRevision: 4,
    markDirty() { assert.fail('revalidation must not dirty the server'); }, assertOwnedPath(value) { return value; } };
  return {
    serverPath, plan, executionRecord, runtime, ownershipManifests, reconcilerManifests, resolved, lease,
    templatePath: outputs.get(executionRecord.execution.templateOutputId).path,
    write: (relative, bytes) => write(serverPath, relative, bytes),
    run: () => coordinator.runMutation({ instanceId: resolved.instanceId, serverPath }, { operation: 'modpack-revalidate', operationId: 'job-repair', revisionMode: 'none' },
      mutationLease => runtime.revalidate({ jobId: 'job-repair', plan, resolved, lease: mutationLease,
        choices: { acceptEula: true, startAfterInstall: false, restorePointId: null } })),
    assertNoRuntimeWork() { assert.equal(runtimePreparations, 0); assert.equal(candidatePreparations, 1); }
  };
}

function assertFullOwnershipContract(c, calls = 1) {
  const desired = c.executionRecord.incomingManifest;
  assert.equal(c.ownershipManifests.length, calls);
  assert.equal(c.reconcilerManifests.length, calls);
  for (const manifest of c.ownershipManifests) assert.equal(manifest, desired, 'ownership must receive the adapter desired manifest');
  for (const manifest of c.reconcilerManifests) assert.equal(manifest, desired, 'reconciler must receive the same full desired manifest');
  assert.ok(desired.entries.some(e => e.path === 'server.jar' && e.origin === 'runtime'));
  assert.ok(desired.entries.some(e => e.path === 'mods/healthy.jar' && e.origin === 'pack'));
  c.assertNoRuntimeWork();
}

for (const kind of ['prepared-server-pack', 'mrpack-server']) {
  test(`actual ${kind} preparer and adapter retain full Repair ownership across reordered snapshot paths`, async t => {
    const c = await fixture(t, kind);
    const payload = c.executionRecord.execution.repairPayloadManifest;
    assert.equal(payload.entries.some(e => e.path === 'server.jar'), false);
    if (kind === 'mrpack-server') assert.deepEqual(payload.entries.map(e => e.path), ['config/corrupt.toml']);
    else assert.ok(payload.entries.some(e => e.path === 'mods/healthy.jar'), 'prepared-server payload is intentionally not filtered');
    await c.run();
    assertFullOwnershipContract(c);
    const actions = Object.fromEntries(c.runtime.contexts.get('job-repair').executionOwnership.actions.map(a => [a.path, a.action]));
    assert.equal(actions['config/corrupt.toml'], 'replace');
    assert.equal(actions['mods/healthy.jar'], 'unchanged');
    assert.equal(actions['server.jar'], 'unchanged');
    assert.equal(fs.readFileSync(path.join(c.serverPath, 'config/corrupt.toml'), 'utf8'), 'corrupt before review');
  });
}

for (const relative of ['config/corrupt.toml', 'mods/healthy.jar', 'server.jar', 'scripts/user.js']) {
  test(`Repair still rejects post-review changes to ${relative}`, async t => {
    const c = await fixture(t);
    c.write(relative, 'changed after review');
    await assert.rejects(c.run(), error => error.code === 'PLAN_STALE' && error.details?.field !== 'ownershipReconciliation');
    assertFullOwnershipContract(c);
  });
}

test('Repair still rejects changed template bytes before ownership reconciliation', async t => {
  const c = await fixture(t);
  fs.writeFileSync(path.join(c.templatePath, 'config', 'corrupt.toml'), 'changed archive template');
  await assert.rejects(c.run(), error => error.code === 'PLAN_STALE' && error.details.field === 'templateManifest');
  assert.equal(c.ownershipManifests.length, 0);
  assert.equal(c.reconcilerManifests.length, 0);
  c.assertNoRuntimeWork();
});

test('Repair reconciles allowed untracked passive world changes with the full desired manifest', async t => {
  const c = await fixture(t);
  c.write('world/notes.txt', 'updated passive world data');
  c.write('world/new-note.txt', 'new passive world data');
  await c.run();
  assertFullOwnershipContract(c);
  const actions = c.runtime.contexts.get('job-repair').executionOwnership.actions;
  assert.equal(actions.find(a => a.path === 'world/new-note.txt').action, 'preserve-user-addon');
});

function filesInUse(error) {
  assert.equal(error?.code, 'PLAN_STALE');
  assert.deepEqual(error.toPublicResult().error.details, { reasonCode: 'server-files-in-use' });
  return true;
}

test('Repair reviewed while the server runs is refused up front once an earlier lifecycle recorded its world', async t => {
  // The repair's desired manifest binds every recorded file, so Start would hold
  // the world exact, and the server's stop saves it.
  await assert.rejects(fixture(t, 'prepared-server-pack', { recordedWorld: true, running: true }), filesInUse);
});

test('Repair review holds a recorded world lock exact even for a server Minecraft Core did not start', async t => {
  // The review reads what the commit holds exact: the held lock is never left out.
  await assert.rejects(fixture(t, 'prepared-server-pack', { recordedWorld: true, running: true, appStarted: false }), filesInUse);
});

test('control: Repair of a server whose world is recorded, reviewed while stopped, revalidates', async t => {
  const c = await fixture(t, 'prepared-server-pack', { recordedWorld: true });
  await c.run();
  assertFullOwnershipContract(c);
  const actions = Object.fromEntries(c.runtime.contexts.get('job-repair').executionOwnership.actions.map(a => [a.path, a.action]));
  assert.equal(actions['world/session.lock'], 'unchanged');
});

for (const kind of ['prepared-server-pack', 'mrpack-server']) {
  test(`actual ${kind} Repair reviewed while the server ran revalidates after the stop where no lifecycle recorded the world`, async t => {
    const c = await fixture(t, kind, { running: true });
    assert.equal(c.plan.preconditions.paths.some(condition => condition.pathKey === 'world/session.lock'), false,
      'the review left out the lock the running server held');
    // Start stops the server, which saves its world once more and releases the lock.
    c.write('world/level.dat', 'saved on stop');
    await c.run();
    assertFullOwnershipContract(c);
    const actions = Object.fromEntries(c.runtime.contexts.get('job-repair').executionOwnership.actions.map(a => [a.path, a.action]));
    assert.equal(actions['config/corrupt.toml'], 'replace');
    assert.equal(actions['world/session.lock'], 'preserve-user-addon');
    assert.equal(actions['world/level.dat'], 'preserve-user-addon');
  });
}

async function stageFixture(c, { materialize = false } = {}) {
  const context = c.runtime.contexts.get('job-repair');
  const candidatePath = context.paths.candidatePath;
  const stopped = new Error(materialize ? 'stop after actual payload materialization' : 'stop after actual source authorization');
  let authorizationCalls = 0;
  let dirtyMarks = 0;
  const lease = { ...c.lease, markDirty() {
    assert.equal(materialize, true, 'authorization must precede candidate writes');
    dirtyMarks += 1;
  } };
  Object.assign(context.durableFs, {
    flushDirectory() {},
    readFileBounded(file, { allowMissing = false, maxBytes = Infinity } = {}) {
      if (allowMissing && !fs.existsSync(file)) return null;
      const bytes = fs.readFileSync(file);
      assert.ok(bytes.length <= maxBytes);
      return bytes;
    },
    async readFileBoundedAsync(file, options) { return this.readFileBounded(file, options); },
    async writeJsonAtomicAsync(file, value, options = {}) {
      assert.equal(materialize, true, 'authorization-only staging must not write');
      const relative = path.relative(candidatePath, file);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'writes belong only to the disposable candidate');
      if (Object.hasOwn(options, 'expectedTargetSha256')) {
        const currentHash = fs.existsSync(file) ? digest(fs.readFileSync(file)) : null;
        assert.equal(currentHash, options.expectedTargetSha256);
      }
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    }
  });
  const record = await c.runtime.recoveryRegistry.load('job-repair');
  const restorePoint = { id: 'restore-fixture', sha256: 'a'.repeat(64) };
  // The real transaction requires a recorded safety point. Its storage is an
  // external boundary here; source capture, authorization and candidate copy are real.
  await c.runtime.recoveryRegistry.transition('job-repair', {
    expectedPhase: record.phase, nextPhase: 'snapshotting', patch: { restorePoint }
  });
  context.restorePoint = restorePoint;
  const realBuild = c.runtime.buildExistingCandidateFn;
  c.runtime.buildExistingCandidateFn = transaction => {
    const authorize = transaction.authorizeSourceSnapshot;
    transaction.authorizeSourceSnapshot = async source => {
      authorizationCalls += 1;
      const result = await authorize(source);
      if (!materialize) throw stopped;
      return result;
    };
    if (materialize) {
      const applyIncoming = transaction.applyIncoming;
      transaction.applyIncoming = async request => { await applyIncoming(request); throw stopped; };
    }
    return realBuild(transaction);
  };
  return {
    candidatePath, stopped,
    run: () => c.runtime.buildCandidate({ jobId: 'job-repair', operationKind: 'repair', plan: c.plan,
      choices: { acceptEula: false, startAfterInstall: false }, resolved: c.resolved, lease }),
    assertBoundary() {
      assert.equal(authorizationCalls, 1, 'real existing transaction must call source authorization');
      if (!materialize) { assert.equal(dirtyMarks, 0); assert.equal(fs.existsSync(candidatePath), false); }
      c.assertNoRuntimeWork();
    }
  };
}

for (const kind of ['prepared-server-pack', 'mrpack-server']) {
  test(`actual ${kind} staging source authorization uses full desired ownership after initial revalidation`, async t => {
    const c = await fixture(t, kind);
    await c.run();
    const stage = await stageFixture(c);
    await assert.rejects(stage.run(), error => error === stage.stopped);
    assertFullOwnershipContract(c, 2);
    assert.equal(c.runtime.contexts.get('job-repair').expectedTemplateManifest, c.executionRecord.execution.repairPayloadManifest,
      'physical template expectations must remain payload-specific');
    assert.equal(c.executionRecord.execution.repairPayloadManifest.entries.some(e => e.path === 'server.jar'), false);
    if (kind === 'mrpack-server') assert.deepEqual(c.executionRecord.execution.repairPayloadManifest.entries.map(e => e.path), ['config/corrupt.toml']);
    stage.assertBoundary();
  });
}

for (const relative of ['config/corrupt.toml', 'mods/healthy.jar', 'server.jar', 'scripts/user.js']) {
  test(`actual Repair staging refuses late drift to ${relative}`, async t => {
    const c = await fixture(t);
    await c.run();
    c.write(relative, 'changed after initial revalidation');
    const stage = await stageFixture(c);
    await assert.rejects(stage.run(), error => error.code === 'PLAN_STALE' && !error.cause);
    assertFullOwnershipContract(c, 2);
    stage.assertBoundary();
  });
}

test('actual Repair staging authorizes late passive world changes without candidate writes', async t => {
  const c = await fixture(t);
  await c.run();
  c.write('world/notes.txt', 'updated after initial revalidation');
  c.write('world/new-note.txt', 'new after initial revalidation');
  const stage = await stageFixture(c);
  await assert.rejects(stage.run(), error => error === stage.stopped);
  assertFullOwnershipContract(c, 2);
  assert.equal(c.runtime.contexts.get('job-repair').executionOwnership.actions.find(a => a.path === 'world/new-note.txt').action, 'preserve-user-addon');
  stage.assertBoundary();
});

test('actual Repair staging still rejects template drift before applying replacement bytes', async t => {
  const c = await fixture(t);
  await c.run();
  fs.writeFileSync(path.join(c.templatePath, 'config', 'corrupt.toml'), 'changed after initial revalidation');
  const stage = await stageFixture(c, { materialize: true });
  await assert.rejects(stage.run(), error => error.code === 'PLAN_STALE' && !error.cause);
  assertFullOwnershipContract(c, 2);
  assert.equal(fs.readFileSync(path.join(stage.candidatePath, 'config', 'corrupt.toml'), 'utf8'), 'corrupt before review');
  assert.equal(fs.readFileSync(path.join(c.serverPath, 'config', 'corrupt.toml'), 'utf8'), 'corrupt before review');
  stage.assertBoundary();
});

test('actual MRPACK Repair materializes its replacement-only payload while preserving healthy pack and runtime', async t => {
  const c = await fixture(t, 'mrpack-server');
  await c.run();
  const stage = await stageFixture(c, { materialize: true });
  await assert.rejects(stage.run(), error => error === stage.stopped);
  assertFullOwnershipContract(c, 2);
  assert.deepEqual(c.executionRecord.execution.repairPayloadManifest.entries.map(e => e.path), ['config/corrupt.toml']);
  assert.equal(fs.readFileSync(path.join(stage.candidatePath, 'config', 'corrupt.toml'), 'utf8'), 'enabled=true\n');
  for (const relative of ['mods/healthy.jar', 'server.jar', 'world/notes.txt']) {
    assert.deepEqual(fs.readFileSync(path.join(stage.candidatePath, relative)), fs.readFileSync(path.join(c.serverPath, relative)));
  }
  assert.equal(fs.readFileSync(path.join(c.serverPath, 'config', 'corrupt.toml'), 'utf8'), 'corrupt before review');
  const manifest = c.runtime.contexts.get('job-repair').candidateState.manifest;
  assert.ok(manifest.entries.some(e => e.path === 'server.jar' && e.origin === 'runtime'));
  assert.ok(manifest.entries.some(e => e.path === 'mods/healthy.jar' && e.origin === 'pack'));
  stage.assertBoundary();
});
