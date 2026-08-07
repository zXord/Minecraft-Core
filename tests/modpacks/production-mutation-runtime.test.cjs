const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProductionMutationRuntime,
  scanCandidateManifest
} = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
const {
  captureReservedTarget
} = require('../../electron/services/modpack-lifecycle/reserved-target-authority.cjs');
const {
  scanManifest
} = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');

function registryDouble() {
  let record = null;
  return {
    get record() { return record; },
    async create(value) { record = structuredClone(value); return record; },
    async load() { return record && structuredClone(record); },
    async transition(jobId, request) {
      assert.equal(jobId, record.jobId);
      assert.equal(request.expectedPhase, record.phase);
      record = { ...record, ...structuredClone(request.patch), phase: request.nextPhase, sequence: record.sequence + 1 };
      return structuredClone(record);
    },
    async finish() { return record; }
  };
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Reserved Server');
  const templatePath = path.join(root, 'template');
  fs.mkdirSync(targetPath);
  fs.mkdirSync(path.join(templatePath, 'config'), { recursive: true });
  fs.writeFileSync(path.join(templatePath, 'config', 'pack.toml'), 'enabled=true\n');
  const reparseInspector = { async isReparsePoint() { return false; } };
  const recoveryRegistry = registryDouble();
  const durableFs = {
    flushDirectory() {},
    writeFileAtomic(filePath, bytes) { fs.writeFileSync(filePath, bytes); },
    renameDurable(source, destination) { fs.renameSync(source, destination); },
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    writeJsonAtomic(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
  };
  const now = new Date('2026-08-02T00:00:00.000Z');
  const runtimeTuple = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  const source = {
    provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Owner', githubRepo: 'Pack',
    version: 'v1.0.0', title: 'Pack', selectedAssetIds: ['789']
  };
  let executionRecord;
  let requestedOwner = null;
  let writtenState = null;
  let reservationReleaseCount = 0;
  let restoreAutoRestartCount = 0;
  let liveHealthCount = 0;
  const revisionEvents = [];
  const stateRepository = {
    read() { return null; },
    writeCandidate(serverPath, state) { writtenState = structuredClone(state); return { state: writtenState }; },
    recordFilesOnlyCandidate(_serverPath, operation) {
      writtenState = { contentRevision: operation.contentRevision, source: structuredClone(operation.source), filesOnly: true };
      return { state: { contentRevision: operation.contentRevision } };
    },
    listHistory() { return { items: [], nextCursor: null }; },
    appendHistory() {}
  };
  const runtime = new ProductionMutationRuntime({
    clock: () => new Date(now),
    destinationReservations: {
      resolve(instanceId) {
        assert.equal(instanceId, 'server-reserved');
        return { instanceId, displayName: 'Reserved Server', targetPath, reservation: executionRecord.reservation };
      },
      consume() { return true; },
      release(instanceId) {
        assert.equal(instanceId, 'server-reserved');
        reservationReleaseCount += 1;
        return true;
      }
    },
    durableFsFactory: () => durableFs,
    fsApi: fs,
    healthValidator: {
      async validateCandidate() {},
      async validateLive() { liveHealthCount += 1; return { evidence: { ok: true } }; }
    },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath: targetPath, priorRunning: false }; } },
    planningAdapter: { getExecutionRecord() { return executionRecord; } },
    planValidator() {},
    prepareRuntime: async ({ targetPath: candidatePath }) => {
      fs.writeFileSync(path.join(candidatePath, 'server.jar'), 'trusted-runtime');
      fs.writeFileSync(path.join(candidatePath, 'trusted-runtime.marker'), 'generated-by-runtime-preparation');
      return { prepared: true };
    },
    javaManagerFactory(candidatePath) {
      return {
        async ensureJava() {
          const javaPath = path.join(candidatePath, 'java', 'bin', 'java.exe');
          fs.mkdirSync(path.dirname(javaPath), { recursive: true });
          fs.writeFileSync(javaPath, 'trusted-java');
          return { success: true, javaPath };
        }
      };
    },
    recoveryServices: {
      registry: recoveryRegistry,
      recoveryService: { async recoverWithLease() {}, async rollbackWithLease() {}, async failNewWithLease() {} },
      runtimePolicy: {
        suspend() { return { held: true }; },
        async ensureStopped() { return { alreadyStopped: true }; },
        async adoptValidatedHandoff() { return { adopted: true }; },
        restoreAutoRestart() {
          restoreAutoRestartCount += 1;
          return { restored: true };
        }
      }
    },
    releaseTrackingStore: { async list() { return []; }, async remove() { return false; }, async upsert() {} },
    revisionPublisher: {
      async publishOnce(event) {
        revisionEvents.push(structuredClone(event));
        if (options.revisionPublisher) return options.revisionPublisher(event, recoveryRegistry.record);
        return { published: true };
      }
    },
    reparseInspector,
    snapshotServer: async () => ({
      liveSnapshot: { kind: 'new', worldDirectories: ['world'], protectedPaths: [], entries: [] },
      pathPreconditions: [], sourceRuntime: runtimeTuple
    }),
    availableBytes: async () => '999999999999',
    stateRepository,
    store: { get: key => key === 'instances' ? [] : null, set() {} },
    userDataPath: root,
    workspaceRegistry: {
      resolveOwnedWorkspace({ ownerId, id, kind }) {
        requestedOwner = ownerId;
        assert.equal(id, 'output-template');
        assert.equal(kind, 'output');
        if (ownerId !== 'job-one') throw Object.assign(new Error('stale owner'), { code: 'PLAN_STALE' });
        return { id, kind, path: templatePath };
      }
    },
    buildNewCandidateFn: async context => {
      fs.mkdirSync(context.expectedPaths?.candidatePath || path.win32.join(path.win32.dirname(targetPath), '.unused'), { recursive: true });
      const candidatePath = context.expectedPaths?.candidatePath || context.candidatePath;
      await context.materializeCandidate({ candidatePath, jobId: context.jobId });
      if (context.persistCandidateState) {
        await context.persistCandidateState({
          candidatePath, candidateState: context.candidateState, jobId: context.jobId,
          stateRepository: context.stateRepository
        });
      } else {
        await context.stateRepository.writeCandidate(candidatePath, context.candidateState);
      }
      return { candidatePath };
    }
  });

  async function prepare({ filesOnly = false } = {}) {
    const incomingManifest = (await scanManifest(templatePath, 'installation-one', { reparseInspector })).manifest;
    const reservation = await captureReservedTarget({ targetPath, fsApi: fs, reparseInspector });
    executionRecord = {
      execution: { templateOutputId: 'output-template' },
      incomingManifest,
      inspectionResult: { classification: { kind: filesOnly ? 'files-only' : 'prepared-server-pack' } },
      reservation,
      serverKind: 'new',
      source,
      serverPath: targetPath
    };
    const plan = {
      fingerprint: 'a'.repeat(64),
      operation: { kind: filesOnly ? 'files-only' : 'install', serverKind: 'new', instanceId: 'server-reserved', expectedContentRevision: 0 },
      source: { provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Owner', githubRepo: 'Pack', version: 'v1.0.0' },
      artifact: { setDigest: 'b'.repeat(64) },
      runtime: filesOnly ? null : runtimeTuple,
      inspection: { fingerprint: 'c'.repeat(64) },
      ownership: {
        actions: [{ path: 'config/pack.toml', pathKey: 'config/pack.toml', action: 'add', role: 'configuration' }]
      },
      selections: { optionalFileIds: [], conflictChoices: { paths: {}, categories: {} } },
      preconditions: {
        artifactPartsFingerprint: 'd'.repeat(64), inspectionFingerprint: 'e'.repeat(64),
        ownershipFingerprint: 'f'.repeat(64), selectionsFingerprint: '1'.repeat(64),
        restorePointsFingerprint: '2'.repeat(64), assetPatternFingerprint: '3'.repeat(64),
        acceptedMappingFingerprint: '4'.repeat(64), operationFingerprint: '5'.repeat(64), minimumAvailableBytes: '1'
      }
    };
    const resolved = { instanceId: 'server-reserved', serverPath: targetPath, priorRunning: false };
    const lease = {
      kind: 'mutation', instanceId: 'server-reserved', serverPath: targetPath, baseRevision: 0,
      markDirty() {}, assertOwnedPath() {}
    };
    await runtime.revalidate({
      jobId: 'job-one', plan, choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
      resolved, lease
    });
    return { plan, resolved, lease };
  }
  return {
    get liveHealthCount() { return liveHealthCount; },
    get requestedOwner() { return requestedOwner; },
    get reservationReleaseCount() { return reservationReleaseCount; },
    get restoreAutoRestartCount() { return restoreAutoRestartCount; },
    get writtenState() { return writtenState; },
    revisionEvents,
    prepare,
    recoveryRegistry,
    runtime,
    targetPath,
    templatePath
  };
}

test('revalidation rehashes the template as the claimed job and consumes only the exact empty reservation', async t => {
  const context = fixture(t);
  await context.prepare();

  assert.equal(context.requestedOwner, 'job-one');
  assert.equal(fs.existsSync(context.targetPath), false);
  assert.equal(context.recoveryRegistry.record.phase, 'preflight');
  assert.equal(context.recoveryRegistry.record.target.kind, 'new');
  assert.equal(context.recoveryRegistry.record.outcome.reservation.kind, 'empty-directory');
});

test('auto-restart restoration is idempotent even when the suspension token is immutable', async t => {
  const context = fixture(t);
  const resolved = { instanceId: 'server-reserved', serverPath: context.targetPath, priorRunning: false };
  const token = await context.runtime.suspendAutoRestart({
    jobId: 'job-one',
    plan: { operation: { serverKind: 'existing' } },
    resolved
  });

  const first = await context.runtime.restorePriorState({ jobId: 'job-one', resolved, restartToken: token });
  const second = await context.runtime.restorePriorState({ jobId: 'job-one', resolved, restartToken: token });

  assert.deepEqual(second, first);
  assert.equal(context.restoreAutoRestartCount, 1);
});

test('failed new-server cleanup releases its private destination reservation only after recovery returns', async t => {
  const context = fixture(t);
  const { plan, resolved, lease } = await context.prepare();

  await context.runtime.abandonCandidate({ jobId: 'job-one', plan, resolved, lease });

  assert.equal(context.reservationReleaseCount, 1);
});

test('new candidate materialization copies only the reviewed template and adds trusted runtime plus explicit EULA state', async t => {
  const context = fixture(t);
  const { plan, resolved, lease } = await context.prepare();
  const candidate = await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  });

  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'config', 'pack.toml'), 'utf8'), 'enabled=true\n');
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'eula.txt'), 'utf8'), 'eula=true\n');
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'server.jar'), 'utf8'), 'trusted-runtime');
  assert.equal(context.writtenState.source.title, 'Pack');
  assert.deepEqual(context.writtenState.source.selectedAssetIds, ['789']);
  assert.equal(context.writtenState.source.artifactSetDigest, 'b'.repeat(64));
  assert.equal(context.writtenState.manifest.entries.some(entry => entry.pathKey === 'eula.txt'), false);
  assert.equal(context.writtenState.manifest.entries.find(entry => entry.pathKey === 'server.jar').origin, 'runtime');
  assert.equal(context.writtenState.manifest.entries.find(entry => entry.pathKey === 'trusted-runtime.marker').origin, 'runtime');
  assert.equal(context.writtenState.manifest.entries.find(entry => entry.pathKey === 'config/pack.toml').origin, 'pack');
});

test('files-only publication reaches a durable healthy boundary without runtime health or process adoption', async t => {
  const context = fixture(t);
  const { plan, resolved, lease } = await context.prepare({ filesOnly: true });
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'import-files-only-new', plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  });
  const preflight = await context.recoveryRegistry.load('job-one');
  await context.recoveryRegistry.transition('job-one', {
    expectedPhase: preflight.phase,
    nextPhase: 'registering',
    patch: {
      outcome: {
        ...(preflight.outcome || {}),
        registration: { instanceId: resolved.instanceId, complete: true }
      }
    }
  });

  const validation = await context.runtime.validateLive({
    jobId: 'job-one', operationKind: 'import-files-only-new', plan,
    resolved, running: false, lease
  });

  assert.deepEqual(validation, { skipped: true, reason: 'files-only' });
  assert.equal(context.liveHealthCount, 0);
  assert.equal((await context.recoveryRegistry.load('job-one')).phase, 'committed-healthy');
  assert.equal(context.recoveryRegistry.record.outcome.runtimePolicy.runningRestored, false);
  assert.equal(context.recoveryRegistry.record.outcome.releaseTracking.status, 'pending');
  assert.equal(context.recoveryRegistry.record.outcome.releaseTracking.action, 'upsert');
  assert.doesNotMatch(JSON.stringify(context.recoveryRegistry.record.outcome.releaseTracking), /(?:path|url|uri|cache|workspace)/i);
  assert.deepEqual(context.revisionEvents.map(event => event.operationKind), ['import']);
  assert.equal(context.writtenState.filesOnly, true);
});

test('new-server revision publication starts only after the durable committed-healthy boundary', async t => {
  const observed = [];
  const context = fixture(t, {
    revisionPublisher(_event, record) {
      observed.push(structuredClone(record));
      throw new Error('transient revision publication failure');
    }
  });
  const { plan, resolved, lease } = await context.prepare();
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  });
  const preflight = await context.recoveryRegistry.load('job-one');
  await context.recoveryRegistry.transition('job-one', {
    expectedPhase: preflight.phase,
    nextPhase: 'registering',
    patch: {
      outcome: {
        ...(preflight.outcome || {}),
        registration: { instanceId: resolved.instanceId, complete: true }
      }
    }
  });

  await assert.rejects(
    context.runtime.validateLive({
      jobId: 'job-one', operationKind: 'install-new', plan,
      resolved, running: false, lease
    }),
    /transient revision publication failure/
  );

  assert.equal(observed.length, 1);
  assert.equal(observed[0].phase, 'committed-healthy');
  assert.equal(observed[0].outcome.revisionEvent.published, false);
  assert.equal(observed[0].outcome.releaseTracking.status, 'pending');
  assert.equal(await context.runtime.isDurablyCommitted({ jobId: 'job-one', plan, resolved }), true);
});

test('cross-loader launcher metadata and dynamic Forge shims remain managed runtime files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'quilt-server-launcher.properties'), 'loader=quilt\n');
  fs.writeFileSync(path.join(root, 'forge-1.20.1-47.3.0-shim.jar'), 'trusted-shim');
  fs.writeFileSync(path.join(root, 'custom-addon.jar'), 'user-addon');
  const manifest = await scanCandidateManifest({
    candidatePath: root,
    installationId: 'installation-runtime',
    incomingManifest: { schemaVersion: 1, installationId: 'incoming-runtime', entries: [] },
    reparseInspector: { async isReparsePoint() { return false; } }
  });

  assert.equal(manifest.entries.find(entry => entry.pathKey === 'quilt-server-launcher.properties').origin, 'runtime');
  assert.equal(manifest.entries.find(entry => entry.pathKey === 'forge-1.20.1-47.3.0-shim.jar').origin, 'runtime');
  assert.equal(manifest.entries.find(entry => entry.pathKey === 'custom-addon.jar').origin, 'user');
});

async function targetedRepairFixture(t, {
  corruptJava = false,
  corruptRuntime = false,
  expectBuildFailure = false,
  stagedRuntimeMismatch = false
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-targeted-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server');
  const templatePath = path.join(root, 'repair-template');
  fs.mkdirSync(serverPath, { recursive: true });
  fs.mkdirSync(path.join(serverPath, 'libraries'), { recursive: true });
  fs.mkdirSync(path.join(templatePath, 'mods'), { recursive: true });
  const trustedRuntimeBytes = Buffer.from('healthy-trusted-runtime');
  const liveRuntimeBytes = corruptRuntime ? Buffer.from('corrupt-runtime') : trustedRuntimeBytes;
  const healthyLibraryBytes = Buffer.from('healthy-runtime-sibling');
  const healthyJavaBytes = Buffer.from('healthy-managed-java');
  const liveJavaBytes = corruptJava ? Buffer.from('corrupt-managed-java') : healthyJavaBytes;
  const runtimeWriterLibraryBytes = Buffer.from('runtime-writer-must-not-touch-healthy-sibling');
  const modBytes = Buffer.from('managed-mod-to-repair');
  fs.writeFileSync(path.join(serverPath, 'server.jar'), liveRuntimeBytes);
  fs.writeFileSync(path.join(serverPath, 'libraries', 'healthy.bin'), healthyLibraryBytes);
  fs.mkdirSync(path.join(serverPath, 'java', 'java-21', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'java', 'java-21', 'bin', 'java.exe'), liveJavaBytes);
  fs.writeFileSync(path.join(templatePath, 'mods', 'missing.jar'), modBytes);
  const reparseInspector = { async isReparsePoint() { return false; } };
  const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const runtimeTuple = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  const managedEntry = (entryPath, bytes, origin, role) => ({
    path: entryPath, pathKey: entryPath.toLocaleLowerCase('en-US'), origin,
    managementPolicy: 'replaceable-managed', role, installedHash: hash(bytes),
    size: String(bytes.length), priorBaseline: null
  });
  const runtimeEntry = managedEntry('server.jar', trustedRuntimeBytes, 'runtime', 'server');
  const libraryEntry = managedEntry('libraries/healthy.bin', healthyLibraryBytes, 'runtime', 'library');
  const javaEntry = managedEntry('java/java-21/bin/java.exe', healthyJavaBytes, 'runtime', 'library');
  const modEntry = managedEntry('mods/missing.jar', modBytes, 'pack', 'mod');
  const incomingManifest = {
    schemaVersion: 1, installationId: 'installation-repair', entries: [javaEntry, libraryEntry, modEntry, runtimeEntry]
  };
  const repairPayloadManifest = (await scanManifest(templatePath, 'installation-repair', { reparseInspector })).manifest;
  const currentState = {
    state: {
      schemaVersion: 1, modpackManaged: true,
      source: {
        provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Owner', githubRepo: 'Pack',
        version: 'v1.0.0', title: 'Pack', selectedAssetIds: ['789'], artifactSetDigest: 'b'.repeat(64)
      },
      runtime: runtimeTuple, selectedOptionalFiles: [], installedAt: '2026-08-01T00:00:00.000Z',
      contentRevision: 3
    },
    manifest: {
      schemaVersion: 1, installationId: 'installation-current', entries: [javaEntry, libraryEntry, modEntry, runtimeEntry]
    }
  };
  let preparedRuntimeCalls = 0;
  let ensuredJavaCalls = 0;
  let preparedTargetPath = null;
  let writtenState = null;
  const recoveryRegistry = registryDouble();
  const durableFs = {
    flushDirectory() {},
    writeFileAtomic(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    renameDurable(source, destination) { fs.renameSync(source, destination); },
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    writeJsonAtomic(filePath, value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    }
  };
  const executionRecord = {
    execution: { templateOutputId: 'output-repair', repairPayloadManifest },
    incomingManifest,
    inspectionResult: { classification: { kind: 'prepared-server-pack' } },
    reservation: null,
    serverKind: 'existing',
    source: currentState.state.source,
    serverPath
  };
  const plan = {
    fingerprint: 'a'.repeat(64),
    operation: { kind: 'repair', serverKind: 'existing', instanceId: 'server-one', expectedContentRevision: 3 },
    source: {
      provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Owner', githubRepo: 'Pack', version: 'v1.0.0'
    },
    artifact: { setDigest: 'b'.repeat(64) },
    runtime: runtimeTuple,
    inspection: { fingerprint: 'c'.repeat(64) },
    ownership: {
      actions: [
        { path: 'mods/missing.jar', pathKey: 'mods/missing.jar', action: 'restore-missing', role: 'mod' },
        {
          path: 'server.jar', pathKey: 'server.jar',
          action: corruptRuntime ? 'replace' : 'unchanged', role: 'server'
        },
        {
          path: 'java/java-21/bin/java.exe', pathKey: 'java/java-21/bin/java.exe',
          action: corruptJava ? 'replace' : 'unchanged', role: 'library'
        },
        { path: 'libraries/healthy.bin', pathKey: 'libraries/healthy.bin', action: 'unchanged', role: 'library' }
      ]
    },
    selections: { optionalFileIds: [], conflictChoices: { paths: {}, categories: {} } },
    preconditions: {
      artifactPartsFingerprint: 'd'.repeat(64), inspectionFingerprint: 'e'.repeat(64),
      ownershipFingerprint: 'f'.repeat(64), selectionsFingerprint: '1'.repeat(64),
      restorePointsFingerprint: '2'.repeat(64), assetPatternFingerprint: '3'.repeat(64),
      acceptedMappingFingerprint: '4'.repeat(64), operationFingerprint: '5'.repeat(64), minimumAvailableBytes: '1'
    }
  };
  const runtime = new ProductionMutationRuntime({
    availableBytes: async () => '999999999999',
    buildExistingCandidateFn: async context => {
      fs.cpSync(serverPath, context.candidatePath, { recursive: true, force: false, errorOnExist: true });
      fs.mkdirSync(
        path.join(context.candidatePath, '.minecraft-core-state', 'operations', 'job-repair'),
        { recursive: true }
      );
      await context.applyIncoming({ candidatePath: context.candidatePath });
      await context.stateRepository.writeCandidate(context.candidatePath, context.candidateState);
      return { candidatePath: context.candidatePath };
    },
    clock: () => new Date('2026-08-02T00:00:00.000Z'),
    destinationReservations: { resolve() { return null; }, consume() { return true; }, release() { return true; } },
    durableFsFactory: () => durableFs,
    fsApi: fs,
    healthValidator: { async validateCandidate() {}, async validateLive() { return { evidence: { ok: true } }; } },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    javaManagerFactory(javaRoot) {
      return {
        getJavaValidationStatus() {
          const javaPath = path.join(javaRoot, 'java', 'java-21', 'bin', 'java.exe');
          return { isInstalled: fs.existsSync(javaPath), javaPath };
        },
        async ensureJava() {
          ensuredJavaCalls += 1;
          if (!corruptJava) throw new Error('healthy runtime must not be downloaded');
          const javaPath = path.join(javaRoot, 'java', 'java-21', 'bin', 'java.exe');
          fs.mkdirSync(path.dirname(javaPath), { recursive: true });
          fs.writeFileSync(javaPath, healthyJavaBytes);
          return { success: true, javaPath };
        }
      };
    },
    planValidator() {},
    planningAdapter: { getExecutionRecord() { return executionRecord; } },
    prepareRuntime: async ({ targetPath }) => {
      preparedRuntimeCalls += 1;
      if (!corruptRuntime) throw new Error('healthy runtime must not be rewritten');
      preparedTargetPath = targetPath;
      fs.mkdirSync(path.join(targetPath, 'libraries'), { recursive: true });
      fs.writeFileSync(
        path.join(targetPath, 'server.jar'),
        stagedRuntimeMismatch ? Buffer.from('unexpected-runtime-build') : trustedRuntimeBytes
      );
      fs.writeFileSync(path.join(targetPath, 'libraries', 'healthy.bin'), runtimeWriterLibraryBytes);
    },
    recoveryServices: {
      registry: recoveryRegistry,
      recoveryService: { async recoverWithLease() {}, async rollbackWithLease() {}, async failNewWithLease() {} },
      runtimePolicy: {
        suspend() { return { held: true }; }, async ensureStopped() { return { alreadyStopped: true }; },
        async adoptValidatedHandoff() { return { adopted: true }; }, restoreAutoRestart() { return { restored: true }; }
      }
    },
    releaseTrackingStore: { async list() { return []; }, async remove() { return false; }, async upsert() {} },
    reparseInspector,
    snapshotServer: async () => ({
      liveSnapshot: {
        kind: 'existing', worldDirectories: ['world'], protectedPaths: [],
        entries: [
          {
            path: 'server.jar', pathKey: 'server.jar', type: 'file',
            sha256: hash(liveRuntimeBytes), size: String(liveRuntimeBytes.length)
          },
          {
            path: 'java/java-21/bin/java.exe', pathKey: 'java/java-21/bin/java.exe', type: 'file',
            sha256: hash(liveJavaBytes), size: String(liveJavaBytes.length)
          },
          {
            path: 'libraries/healthy.bin', pathKey: 'libraries/healthy.bin', type: 'file',
            sha256: hash(healthyLibraryBytes), size: String(healthyLibraryBytes.length)
          }
        ]
      },
      pathPreconditions: [], sourceRuntime: runtimeTuple, candidateBytes: String(liveRuntimeBytes.length),
      restorePointBytes: String(trustedRuntimeBytes.length), rollbackBytes: String(trustedRuntimeBytes.length), journalBytes: '1',
      restorePoints: [], writeable: true
    }),
    stateRepository: {
      read() { return currentState; },
      writeCandidate(_candidatePath, state) { writtenState = structuredClone(state); return { state: writtenState }; },
      listHistory() { return { items: [], nextCursor: null }; }, appendHistory() {}
    },
    store: { get: key => key === 'instances' ? [] : null, set() {} },
    userDataPath: root,
    workspaceRegistry: {
      resolveOwnedWorkspace({ ownerId, id, kind }) {
        assert.equal(ownerId, 'job-repair');
        assert.equal(id, 'output-repair');
        assert.equal(kind, 'output');
        return { id, kind, path: templatePath };
      }
    }
  });
  const resolved = { instanceId: 'server-one', serverPath, priorRunning: false };
  const lease = {
    kind: 'mutation', instanceId: 'server-one', serverPath, baseRevision: 3,
    markDirty() {}, assertOwnedPath() {}
  };
  const choices = { acceptEula: false, startAfterInstall: false, restorePointId: null };

  await runtime.revalidate({ jobId: 'job-repair', plan, choices, resolved, lease });
  let buildError = null;
  let built = null;
  try {
    built = await runtime.buildCandidate({
      jobId: 'job-repair', operationKind: 'repair', plan, choices, restorePoint: null, resolved, lease
    });
  } catch (error) {
    if (!expectBuildFailure) throw error;
    buildError = error;
  }

  return {
    buildError,
    built,
    ensuredJavaCalls,
    hash,
    healthyLibraryBytes,
    healthyJavaBytes,
    modBytes,
    preparedRuntimeCalls,
    preparedTargetPath,
    trustedRuntimeBytes,
    writtenState
  };
}

test('repair restores one missing mod without invoking healthy runtime writers or downloads', async t => {
  const result = await targetedRepairFixture(t);

  assert.equal(
    fs.readFileSync(path.join(result.built.candidatePath, 'server.jar'), 'utf8'),
    result.trustedRuntimeBytes.toString()
  );
  assert.equal(fs.readFileSync(path.join(result.built.candidatePath, 'mods', 'missing.jar'), 'utf8'), result.modBytes.toString());
  assert.deepEqual(fs.readdirSync(path.join(result.built.candidatePath, 'mods')), ['missing.jar']);
  assert.equal(result.ensuredJavaCalls, 0);
  assert.equal(result.preparedRuntimeCalls, 0);
  assert.equal(
    result.writtenState.manifest.entries.find(entry => entry.pathKey === 'server.jar').installedHash,
    result.hash(result.trustedRuntimeBytes)
  );
  assert.equal(
    result.writtenState.manifest.entries.find(entry => entry.pathKey === 'mods/missing.jar').installedHash,
    result.hash(result.modBytes)
  );
});

test('repair stages a corrupt runtime and copies back only reviewed mismatched runtime paths', async t => {
  const result = await targetedRepairFixture(t, { corruptRuntime: true });

  assert.equal(
    fs.readFileSync(path.join(result.built.candidatePath, 'server.jar'), 'utf8'),
    result.trustedRuntimeBytes.toString()
  );
  assert.equal(
    fs.readFileSync(path.join(result.built.candidatePath, 'libraries', 'healthy.bin'), 'utf8'),
    result.healthyLibraryBytes.toString()
  );
  assert.equal(result.ensuredJavaCalls, 0);
  assert.equal(result.preparedRuntimeCalls, 1);
  assert.equal(
    result.preparedTargetPath,
    path.join(result.built.candidatePath, '.minecraft-core-state', 'operations', 'job-repair', 'runtime-repair')
  );
  assert.equal(fs.existsSync(result.preparedTargetPath), false);
  assert.equal(
    result.writtenState.manifest.entries.find(entry => entry.pathKey === 'server.jar').installedHash,
    result.hash(result.trustedRuntimeBytes)
  );
  assert.equal(
    result.writtenState.manifest.entries.find(entry => entry.pathKey === 'libraries/healthy.bin').installedHash,
    result.hash(result.healthyLibraryBytes)
  );
});

test('repair restores a corrupt managed Java executable without rewriting healthy runtime siblings', async t => {
  const result = await targetedRepairFixture(t, { corruptJava: true });

  assert.equal(
    fs.readFileSync(path.join(result.built.candidatePath, 'java', 'java-21', 'bin', 'java.exe'), 'utf8'),
    result.healthyJavaBytes.toString()
  );
  assert.equal(
    fs.readFileSync(path.join(result.built.candidatePath, 'server.jar'), 'utf8'),
    result.trustedRuntimeBytes.toString()
  );
  assert.equal(
    fs.readFileSync(path.join(result.built.candidatePath, 'libraries', 'healthy.bin'), 'utf8'),
    result.healthyLibraryBytes.toString()
  );
  assert.equal(result.ensuredJavaCalls, 1);
  assert.equal(result.preparedRuntimeCalls, 0);
  assert.equal(
    result.writtenState.manifest.entries.find(entry => entry.pathKey === 'java/java-21/bin/java.exe').installedHash,
    result.hash(result.healthyJavaBytes)
  );
});

test('repair rejects a staged runtime path that does not match the trusted installed baseline', async t => {
  const result = await targetedRepairFixture(t, {
    corruptRuntime: true,
    expectBuildFailure: true,
    stagedRuntimeMismatch: true
  });

  assert.equal(result.built, null);
  assert.equal(result.buildError?.code, 'RUNTIME_INCOMPLETE');
  assert.equal(result.preparedRuntimeCalls, 1);
  assert.equal(fs.existsSync(result.preparedTargetPath), false);
});
