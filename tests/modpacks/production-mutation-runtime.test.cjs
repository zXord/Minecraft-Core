const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProductionMutationRuntime,
  scanCandidateManifest
} = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
const {
  captureExistingUnmanagedTarget,
  captureReservedTarget,
  consumeReservedTarget
} = require('../../electron/services/modpack-lifecycle/reserved-target-authority.cjs');
const {
  scanManifest
} = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const {
  createProductionServerSnapshot
} = require('../../electron/services/modpacks/planning/production-server-snapshot.cjs');
const { planOwnership } = require('../../electron/services/modpacks/planning/ownership-planner.cjs');

// Runtime/registry integration is tested against the real authority separately.
// These materialization fixtures model trusted completion without real workers.
function controlledRuntimeAuthority() {
  return {
    async run(_jobId, work) {
      try { return await work(); }
      catch (error) {
        if (error.preserveWorkspace) error.runtimeWritersUnproven = true;
        throw error;
      }
    },
    async assertRecoveryAllowed(record) { return record; }
  };
}

function recordingHashService() {
  const hashedPaths = [];
  return {
    hashedPaths,
    async dispose() {},
    async hashFile(filePath, { expectedIdentity }) {
      hashedPaths.push(path.resolve(filePath));
      const bytes = fs.readFileSync(filePath);
      return {
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: String(bytes.length),
        identity: expectedIdentity
      };
    }
  };
}

function retainedHandoffDouble({ closes = true } = {}) {
  let live = true;
  let stopCalls = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const processHandle = {
    pid: 4242,
    closed,
    isLive() { return live; },
    async stopFully() {
      stopCalls += 1;
      const evidence = {
        clean: closes,
        closed: closes,
        exitCode: closes ? 0 : null,
        forced: !closes,
        signal: null
      };
      if (closes) {
        live = false;
        resolveClosed(evidence);
      }
      return evidence;
    }
  };
  return {
    handoff: { processHandle, startLease: { kind: 'start' } },
    isLive: () => live,
    stopCalls: () => stopCalls
  };
}

function registryDouble({
  createErrorAfterRecord = null,
  createErrorBeforeRecord = null,
  includeInitialize = true,
  initializeResult = null,
  onCreate = () => {},
  onTransition = () => {}
} = {}) {
  let record = null;
  let finishCalls = 0;
  const registry = {
    get finishCalls() { return finishCalls; },
    get record() { return record; },
    async create(value) {
      onCreate(value);
      if (createErrorBeforeRecord) throw createErrorBeforeRecord;
      record = structuredClone(value);
      if (createErrorAfterRecord) throw createErrorAfterRecord;
      return record;
    },
    async initialize() {
      return initializeResult || {
        records: record ? [structuredClone(record)] : [], corrupt: [], blocks: [], globalBlock: false
      };
    },
    async load() { return record && structuredClone(record); },
    async transition(jobId, request) {
      onTransition(request);
      assert.equal(jobId, record.jobId);
      assert.equal(request.expectedPhase, record.phase);
      record = { ...record, ...structuredClone(request.patch), phase: request.nextPhase, sequence: record.sequence + 1 };
      return structuredClone(record);
    },
    async finish() { finishCalls += 1; return record; }
  };
  if (!includeInitialize) delete registry.initialize;
  return registry;
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
  const recoveryRegistry = options.recoveryRegistry || registryDouble({
    createErrorAfterRecord: options.recoveryCreateErrorAfterRecord,
    createErrorBeforeRecord: options.recoveryCreateErrorBeforeRecord,
    includeInitialize: options.recoveryIncludeInitialize !== false,
    initializeResult: options.recoveryInitializeResult,
    onCreate: options.onRecoveryCreate,
    onTransition: options.onRecoveryTransition
  });
  const durableFs = options.durableFs || {
    flushDirectory() {},
    async flushDirectoryAsync() {},
    writeFileAtomic(filePath, bytes) { fs.writeFileSync(filePath, bytes); },
    async writeFileAtomicAsync(filePath, bytes) { fs.writeFileSync(filePath, bytes); },
    renameDurable(source, destination) { fs.renameSync(source, destination); },
    async renameDurableAsync(source, destination) { fs.renameSync(source, destination); },
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    async readFileBoundedAsync(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    writeJsonAtomic(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); },
    async writeJsonAtomicAsync(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
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
  let javaEnsureOptions = null;
  let requestedOwner = null;
  let preparedRuntimeOptions = null;
  let writtenState = null;
  let reservationReleaseCount = 0;
  let restoreAutoRestartCount = 0;
  let liveHealthCount = 0;
  let publishedCandidateVerificationCount = 0;
  let retainedLiveHandoff = null;
  let adoptedHandoffIsExact = null;
  const candidateHealthRequests = [];
  const liveHealthRequests = [];
  const adoptedHandoffs = [];
  let storedInstances = [];
  const liveValidationSteps = [];
  const revisionEvents = [];
  const stateRepository = {
    read() { return null; },
    writeCandidate(serverPath, state) { writtenState = structuredClone(state); return { state: writtenState }; },
    async writeCandidateAsync(serverPath, state) { writtenState = structuredClone(state); return { state: writtenState }; },
    recordFilesOnlyCandidate(_serverPath, operation) {
      writtenState = { contentRevision: operation.contentRevision, source: structuredClone(operation.source), filesOnly: true };
      return { state: { contentRevision: operation.contentRevision } };
    },
    listHistory() { return { items: [], nextCursor: null }; },
    appendHistory() {},
    async appendHistoryAsync() {}
  };
  const runtime = new ProductionMutationRuntime({
    clock: () => new Date(now),
    candidateHashService: options.candidateHashService,
    consumeReservedTargetFn: async request => {
      options.onConsumeReservedTarget?.();
      return consumeReservedTarget(request);
    },
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
      async validateCandidate(request) {
        candidateHealthRequests.push(structuredClone({ maxRam: request.maxRam }));
        return { evidence: { ok: true } };
      },
      async validateLive(request) {
        liveHealthCount += 1;
        liveHealthRequests.push(structuredClone({
          keepRunning: request.keepRunning,
          maxRam: request.maxRam,
          networkAccess: request.networkAccess,
          port: request.port,
          serverPath: request.serverPath
        }));
        liveValidationSteps.push('health');
        retainedLiveHandoff = request.keepRunning ? { processHandle: {}, startLease: {} } : null;
        return {
          evidence: { ok: true },
          handoff: retainedLiveHandoff
        };
      }
    },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath: targetPath, priorRunning: false }; } },
    planningAdapter: { getExecutionRecord() { return executionRecord; } },
    planValidator() {},
    prepareNewLiveValidationFn: async () => {
      liveValidationSteps.push('authorize');
      const current = await recoveryRegistry.load('job-one');
      await recoveryRegistry.transition('job-one', {
        expectedPhase: 'registering',
        nextPhase: 'validating-live',
        patch: {
          outcome: {
            ...(current.outcome || {}),
            liveMutationAuthorized: true,
            liveValidation: { properties: { existed: false, sha256: null } }
          }
        }
      });
      return { jobId: 'job-one' };
    },
    completeNewLiveValidationFn: async () => {
      liveValidationSteps.push('verify');
      return { phase: 'validating-live', verified: true };
    },
    verifyPublishedNewCandidateFn: async () => {
      publishedCandidateVerificationCount += 1;
      liveValidationSteps.push('verify-published-candidate');
      return {
        evidence: {
          kind: 'candidate',
          publicationVerified: true,
          validationSource: 'sealed-candidate'
        },
        handoff: null
      };
    },
    prepareRuntime: async ({ targetPath: candidatePath, ...options }) => {
      preparedRuntimeOptions = options;
      fs.writeFileSync(path.join(candidatePath, 'server.jar'), 'trusted-runtime');
      fs.writeFileSync(path.join(candidatePath, 'trusted-runtime.marker'), 'generated-by-runtime-preparation');
      return { prepared: true };
    },
    javaManagerFactory(candidatePath) {
      return {
        async ensureJava(_javaMajor, progressCallback, ensureOptions) {
          javaEnsureOptions = ensureOptions;
          for (const event of options.javaProgressEvents || []) progressCallback?.(event);
          const javaPath = path.join(candidatePath, 'java', 'bin', 'java.exe');
          fs.mkdirSync(path.dirname(javaPath), { recursive: true });
          fs.writeFileSync(javaPath, 'trusted-java');
          return { success: true, javaPath };
        }
      };
    },
    recoveryServices: {
      registry: recoveryRegistry,
      runtimeWriterAuthority: options.runtimeWriterAuthority || controlledRuntimeAuthority(),
      recoveryService: {
        async recoverWithLease(record, lease) {
          options.onRecoverWithLease?.(structuredClone(record), lease);
        },
        async rollbackWithLease() {},
        async failNewWithLease(...args) {
          options.onFailNewWithLease?.(...args);
        }
      },
      runtimePolicy: {
        suspend() { return { held: true }; },
        async ensureStopped() { return { alreadyStopped: true }; },
        async adoptValidatedHandoff(request) {
          adoptedHandoffIsExact = request.handoff === retainedLiveHandoff;
          adoptedHandoffs.push(structuredClone({
            eventId: request.eventId,
            instanceId: request.instanceId,
            jobId: request.jobId,
            serverPath: request.serverPath
          }));
          return { adopted: true };
        },
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
    snapshotServer: async request => {
      options.onSnapshotRequest?.(request);
      return ({
      liveSnapshot: { kind: 'new', worldDirectories: ['world'], protectedPaths: [], entries: [] },
      pathPreconditions: [], sourceRuntime: runtimeTuple
      });
    },
    availableBytes: async () => '999999999999',
    stateRepository,
    store: {
      get: key => key === 'instances' ? structuredClone(storedInstances) : null,
      set(key, value) {
        assert.equal(key, 'instances');
        storedInstances = structuredClone(value);
      }
    },
    instanceContext: { updateInstances() {} },
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
    ...(options.yieldControl ? { yieldControl: options.yieldControl } : {}),
    ...(options.durabilityHandoff ? { durabilityHandoff: options.durabilityHandoff } : {}),
    ...(options.useRealNewTransaction ? {} : { buildNewCandidateFn: async context => {
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
    } })
  });

  async function prepare({ filesOnly = false, signal } = {}) {
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
      selections: {
        optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
        maxRam: filesOnly ? null : (options.maxRam ?? 6),
        serverPort: filesOnly ? null : (options.serverPort ?? 25565),
        networkAccess: filesOnly ? null : (options.networkAccess ?? 'pack-default')
      },
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
      resolved, lease, signal
    });
    return { plan, resolved, lease };
  }
  return {
    adoptedHandoffs,
    get adoptedHandoffIsExact() { return adoptedHandoffIsExact; },
    candidateHealthRequests,
    get liveHealthCount() { return liveHealthCount; },
    liveHealthRequests,
    get publishedCandidateVerificationCount() { return publishedCandidateVerificationCount; },
    get javaEnsureOptions() { return javaEnsureOptions; },
    liveValidationSteps,
    get requestedOwner() { return requestedOwner; },
    get preparedRuntimeOptions() { return preparedRuntimeOptions; },
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

test('revalidation resolves the claimed private template and consumes only the exact empty reservation', async t => {
  const context = fixture(t);
  await context.prepare();

  assert.equal(context.requestedOwner, 'job-one');
  assert.equal(fs.existsSync(context.targetPath), false);
  assert.equal(context.recoveryRegistry.record.phase, 'preflight');
  assert.equal(context.recoveryRegistry.record.target.kind, 'new');
  assert.equal(context.recoveryRegistry.record.outcome.reservation.kind, 'empty-directory');
  assert.equal(context.recoveryRegistry.record.outcome.runtimeWriterProtocol, 1);
});

test('real candidate transaction preserves durable runtime settlement across stale builder outcome patches', async t => {
  const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
  const { ServerRuntimeWriterAuthority } = require('../../electron/services/modpack-lifecycle/server-runtime-writer-authority.cjs');
  const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
  const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-production-registry-'));
  t.after(() => fs.rmSync(registryRoot, { recursive: true, force: true }));
  const durableFs = createDurableFs({ allowedRoots: [registryRoot], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {}
  } });
  const registry = new RecoveryRegistry({ userDataPath: registryRoot, durableFs }); await registry.initialize();
  const guard = new ServerRuntimeWriterAuthority({ registry, getBootSequence: async () => 10 });
  const context = fixture(t, { recoveryRegistry: registry, runtimeWriterAuthority: guard, useRealNewTransaction: true });
  const prepared = await context.prepare();
  const originalJavaFactory = context.runtime.javaManagerFactory;
  context.runtime.javaManagerFactory = (...args) => {
    const manager = originalJavaFactory(...args);
    return { ...manager, async ensureJava(...javaArgs) {
      assert.equal((await registry.load('job-one')).outcome.runtimeWriterAuthority.state, 'unproven');
      return manager.ensureJava(...javaArgs);
    } };
  };
  await context.runtime.buildCandidate({ jobId: 'job-one', operationKind: 'install-new', ...prepared,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null }, restorePoint: null });
  const record = await registry.load('job-one');
  assert.equal(record.outcome.runtimeWriterAuthority.state, 'settled');
  assert.equal(record.outcome.runtimeWriterProtocol, 1);
  assert.deepEqual(record.outcome.runtimeWriterAuthority.candidateIdentity, record.directoryIdentities.candidate);
});

test('candidate Java and loader preparation cannot run before durable runtime writer admission', async t => {
  let admitted = false;
  const context = fixture(t, { runtimeWriterAuthority: {
    async run(jobId, work, { lease }) {
      assert.equal(jobId, 'job-one'); assert.equal(lease.kind, 'mutation'); admitted = true;
      throw Object.assign(new Error('refused before worker'), { code: 'RECOVERY_REQUIRED', runtimeWritersUnproven: true });
    },
    async assertRecoveryAllowed(record) { return record; }
  } });
  const prepared = await context.prepare();
  await assert.rejects(context.runtime.buildCandidate({ jobId: 'job-one', operationKind: 'install-new', ...prepared,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null }, restorePoint: null }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(admitted, true);
  assert.equal(context.javaEnsureOptions, null);
  assert.equal(context.preparedRuntimeOptions, null);
});

test('candidate cleanup waits for the cancelled runtime worker to close before releasing its destination', async t => {
  const { EventEmitter } = require('node:events');
  const { createManagedRuntimeWorkerClient } = require('../../electron/services/managed-runtime-worker-client.cjs');
  const child = new EventEmitter();
  child.send = (_request, callback) => callback?.(null);
  child.disconnect = () => {};
  child.kill = () => { throw new Error('an accepted descendant-capable worker must not be killed'); };
  const runWorker = createManagedRuntimeWorkerClient({ forkImpl: () => child });
  let recoveries = 0;
  const context = fixture(t, { onRecoverWithLease() { recoveries += 1; } });
  const prepared = await context.prepare();
  const controller = new AbortController();
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const workerResult = runWorker({
    operation: 'prepare-managed-server-runtime', targetPath: context.templatePath, runtime: prepared.plan.runtime,
    javaPath: path.join(context.templatePath, 'java.exe'), signal: controller.signal,
    terminationGraceMs: 5
  }).catch(error => error);
  controller.abort();
  const error = await workerResult;
  assert.equal(error.preserveWorkspace, true);
  let settled = false;
  const cleanup = context.runtime.abandonCandidate({ jobId: 'job-one', ...prepared, error })
    .finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recoveries, 0, 'recovery must not inspect or remove a still-writable candidate');
  assert.equal(context.reservationReleaseCount, 0);
  assert.equal(settled, false);
  child.emit('close', 65, null);
  await cleanup;
  assert.equal(recoveries, 1);
  assert.equal(context.reservationReleaseCount, 1);
});

test('unproven runtime termination cannot authorize candidate cleanup', async t => {
  let recoveries = 0;
  const context = fixture(t, { onRecoverWithLease() { recoveries += 1; } });
  const prepared = await context.prepare();
  const error = Object.assign(new Error('worker termination was not proven'), { preserveWorkspace: true });
  await assert.rejects(
    context.runtime.abandonCandidate({ jobId: 'job-one', ...prepared, error }),
    failure => failure.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(recoveries, 0);
  assert.equal(context.reservationReleaseCount, 0);
});

test('revalidation forwards the lifecycle AbortSignal into the fresh server snapshot', async t => {
  const controller = new AbortController();
  let receivedSignal = null;
  const context = fixture(t, {
    onSnapshotRequest(request) { receivedSignal = request.signal; }
  });

  await context.prepare({ signal: controller.signal });

  assert.equal(receivedSignal, controller.signal);
});

test('revalidation rejects a durable filesystem that cannot yield mutation durability', async t => {
  const durableFs = {
    flushDirectory() {},
    writeFileAtomic(filePath, bytes) { fs.writeFileSync(filePath, bytes); },
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
  const context = fixture(t, { durableFs });

  await assert.rejects(context.prepare(), error => error?.code === 'INVALID_REQUEST');
});

test('new-server revalidation yields between durable recovery and destination-consumption boundaries', async t => {
  const events = [];
  const context = fixture(t, {
    onRecoveryCreate() { events.push('recovery-create'); },
    onRecoveryTransition(request) {
      if (request.expectedPhase === 'queued' && request.nextPhase === 'preflight') {
        events.push('recovery-preflight');
      }
    },
    onConsumeReservedTarget() { events.push('destination-consume'); },
    async durabilityHandoff() {
      events.push('durability-handoff');
      await new Promise(resolve => setImmediate(resolve));
    },
    async yieldControl() {
      events.push('cheap-yield');
    }
  });

  await context.prepare();

  assert.deepEqual(events, [
    'recovery-create', 'durability-handoff',
    'recovery-preflight', 'durability-handoff',
    'destination-consume', 'durability-handoff'
  ]);
});

test('revalidation cancellation immediately after recovery creation closes the queued record and reservation', async t => {
  const controller = new AbortController();
  let recoveryCalls = 0;
  const context = fixture(t, {
    onRecoveryCreate() { controller.abort(); },
    onRecoverWithLease() { recoveryCalls += 1; }
  });

  await assert.rejects(
    context.prepare({ signal: controller.signal }),
    error => error?.code === 'CANCELLED'
  );

  assert.equal(context.recoveryRegistry.finishCalls, 1);
  assert.equal(recoveryCalls, 0);
  assert.equal(context.reservationReleaseCount, 1);
  assert.equal(fs.existsSync(context.targetPath), false);
  assert.equal(context.runtime.contexts.has('job-one'), false);
});

test('revalidation reconciles a queued record retained by a rejected recovery create', async t => {
  const creationError = new ModpackError('COMMIT_FAILED', 'injected uncertain recovery publication');
  const context = fixture(t, { recoveryCreateErrorAfterRecord: creationError });

  await assert.rejects(context.prepare(), error => error === creationError);

  assert.equal(context.recoveryRegistry.finishCalls, 1);
  assert.equal(context.reservationReleaseCount, 1);
  assert.equal(fs.existsSync(context.targetPath), false);
  assert.equal(context.runtime.contexts.has('job-one'), false);
});

test('revalidation reports recovery required when rejected create leaves corrupt durable evidence', async t => {
  const context = fixture(t, {
    recoveryCreateErrorBeforeRecord: new ModpackError('COMMIT_FAILED', 'injected recovery publication failure'),
    recoveryInitializeResult: {
      records: [],
      corrupt: [{ jobId: 'job-one', recordValid: false, envelopeValid: true, mismatched: false }],
      blocks: [{ jobId: 'job-one', stableServerId: 'server-reserved' }],
      globalBlock: false
    }
  });

  await assert.rejects(context.prepare(), error => error?.code === 'RECOVERY_REQUIRED');

  assert.equal(context.recoveryRegistry.finishCalls, 0);
  assert.equal(context.reservationReleaseCount, 0);
  assert.equal(fs.existsSync(context.targetPath), true);
});

test('rejected recovery create with proven clean absence releases its exact target for reuse', async t => {
  const creationError = new ModpackError('COMMIT_FAILED', 'injected pre-publication create failure');
  const context = fixture(t, { recoveryCreateErrorBeforeRecord: creationError });

  await assert.rejects(context.prepare(), error => error === creationError);

  assert.equal(context.recoveryRegistry.finishCalls, 0);
  assert.equal(context.reservationReleaseCount, 1);
  assert.equal(fs.existsSync(context.targetPath), false);
  fs.mkdirSync(context.targetPath);
  assert.equal(fs.existsSync(context.targetPath), true);
  assert.equal(context.runtime.contexts.has('job-one'), false);
});

test('rejected recovery create without an integrity scan remains recovery required', async t => {
  const context = fixture(t, {
    recoveryCreateErrorBeforeRecord: new ModpackError('COMMIT_FAILED', 'injected pre-publication create failure'),
    recoveryIncludeInitialize: false
  });

  await assert.rejects(context.prepare(), error => error?.code === 'RECOVERY_REQUIRED');

  assert.equal(context.recoveryRegistry.finishCalls, 0);
  assert.equal(context.reservationReleaseCount, 0);
  assert.equal(fs.existsSync(context.targetPath), true);
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

test('candidate boot diagnostic is durable before recovery removes the failed candidate', async t => {
  let recoveryRecord = null;
  const context = fixture(t, {
    onRecoverWithLease(record) { recoveryRecord = record; }
  });
  const { plan, resolved, lease } = await context.prepare();
  const error = new ModpackError(
    'HEALTH_CHECK_FAILED',
    'Server health validation failed',
    { cause: new Error('C:\\private\\candidate ModLoadingException secret') }
  );
  Object.defineProperty(error, 'candidateBootDiagnostic', {
    enumerable: false,
    value: Object.freeze({
      stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
    })
  });

  await context.runtime.abandonCandidate({ jobId: 'job-one', plan, resolved, lease, error });

  assert.deepEqual(recoveryRecord?.outcome?.failure, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });
  assert.doesNotMatch(JSON.stringify(recoveryRecord), /private|secret|modloadingexception/i);
});

test('candidate cleanup stays blocked when its closed boot diagnostic cannot be persisted', async t => {
  let recoveryCalled = false;
  const context = fixture(t, {
    onRecoverWithLease() { recoveryCalled = true; }
  });
  const { plan, resolved, lease } = await context.prepare();
  const originalTransition = context.recoveryRegistry.transition.bind(context.recoveryRegistry);
  context.recoveryRegistry.transition = async (jobId, request) => {
    if (request.patch?.outcome?.failure?.stage === 'candidate-boot') {
      throw new ModpackError('COMMIT_FAILED', 'The candidate diagnostic could not be persisted');
    }
    return originalTransition(jobId, request);
  };
  const error = new ModpackError('HEALTH_CHECK_FAILED', 'Server health validation failed');
  Object.defineProperty(error, 'candidateBootDiagnostic', {
    enumerable: false,
    value: Object.freeze({
      stage: 'candidate-boot', boundary: 'readiness', category: 'health-failure'
    })
  });

  await assert.rejects(
    context.runtime.abandonCandidate({ jobId: 'job-one', plan, resolved, lease, error }),
    caught => caught?.code === 'COMMIT_FAILED'
  );

  assert.equal(recoveryCalled, false);
  assert.equal(context.reservationReleaseCount, 0);
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
  assert.equal(context.preparedRuntimeOptions.skipMutationMark, true);
});

test('new candidate copy remains bound to the reviewed manifest if the private template changes after revalidation', async t => {
  const context = fixture(t);
  const { plan, resolved, lease } = await context.prepare();
  fs.writeFileSync(path.join(context.templatePath, 'config', 'pack.toml'), 'enabled=nope\n');

  await assert.rejects(context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  }), error => error?.code === 'PLAN_STALE');
});

test('new candidate rejects an unreviewed template file before creating its destination file', async t => {
  const context = fixture(t);
  const { plan, resolved, lease } = await context.prepare();
  fs.writeFileSync(path.join(context.templatePath, 'unexpected-large.bin'), Buffer.alloc(1024 * 1024));

  await assert.rejects(context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  }), error => error?.code === 'PLAN_STALE');

  const candidatePath = context.recoveryRegistry.record?.candidatePath;
  assert.equal(typeof candidatePath, 'string');
  assert.equal(fs.existsSync(path.join(candidatePath, 'unexpected-large.bin')), false);
});

test('new candidate rejects an enlarged reviewed file before creating its destination file', async t => {
  const context = fixture(t);
  const { plan, resolved, lease } = await context.prepare();
  fs.appendFileSync(path.join(context.templatePath, 'config', 'pack.toml'), Buffer.alloc(1024 * 1024));

  await assert.rejects(context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  }), error => error?.code === 'PLAN_STALE');

  const candidatePath = context.recoveryRegistry.record?.candidatePath;
  assert.equal(typeof candidatePath, 'string');
  assert.equal(fs.existsSync(path.join(candidatePath, 'config', 'pack.toml')), false);
});

test('new candidate EULA publication awaits asynchronous durability without using the blocking API', async t => {
  let releaseWrite;
  let signalWriteStarted;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  t.after(() => releaseWrite());
  const durableFs = {
    flushDirectory() {},
    async flushDirectoryAsync() {},
    writeFileAtomic() { throw new Error('synchronous durable file publication must not run'); },
    async writeFileAtomicAsync(filePath, bytes) {
      signalWriteStarted();
      await writeGate;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, bytes);
    },
    renameDurable() { throw new Error('synchronous durable rename must not run'); },
    async renameDurableAsync(source, destination) { fs.renameSync(source, destination); },
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    async readFileBoundedAsync(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    writeJsonAtomic(filePath, value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomicAsync(filePath, value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    }
  };
  const context = fixture(t, { durableFs });
  const { plan, resolved, lease } = await context.prepare();
  const buildOutcome = context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  }).then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', error }));

  const first = await Promise.race([
    writeStarted.then(() => 'async-write-started'),
    buildOutcome.then(outcome => outcome.status)
  ]);
  assert.equal(first, 'async-write-started');
  assert.equal(await Promise.race([
    buildOutcome.then(outcome => outcome.status),
    new Promise(resolve => setImmediate(() => resolve('pending')))
  ]), 'pending');

  releaseWrite();
  const outcome = await buildOutcome;
  assert.equal(outcome.status, 'resolved', outcome.error?.stack);
  assert.equal(fs.readFileSync(path.join(outcome.value.candidatePath, 'eula.txt'), 'utf8'), 'eula=true\n');
});

test('unmanaged existing revalidation pins the reviewed directory and creates a verified restore with exact available source runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-unmanaged-adoption-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Existing Server');
  const templatePath = path.join(root, 'template');
  fs.mkdirSync(path.join(targetPath, 'world'), { recursive: true });
  fs.mkdirSync(path.join(templatePath, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(targetPath, 'server.properties'), 'motd=existing\n');
  fs.writeFileSync(path.join(targetPath, 'world', 'level.dat'), 'world-sentinel');
  fs.writeFileSync(path.join(templatePath, 'mods', 'pack.jar'), 'pack-mod');
  const reparseInspector = { async isReparsePoint() { return false; } };
  const candidateHashService = recordingHashService();
  const incomingManifest = (await scanManifest(templatePath, 'installation-adopted', {
    candidateHashService,
    reparseInspector
  })).manifest;
  const adoption = await captureExistingUnmanagedTarget({ targetPath, fsApi: fs, reparseInspector });
  let currentState = null;
  const stateRepository = {
    read() { return currentState; },
    async writeCandidateAsync() { throw new Error('candidate persistence is not part of revalidation'); },
    async appendHistoryAsync() { throw new Error('history persistence is not part of revalidation'); },
    listHistory() { return { items: [], nextCursor: null }; }
  };
  const snapshotServer = createProductionServerSnapshot({ fsApi: fs, reparseInspector, stateRepository });
  const recoveryRegistry = registryDouble();
  const restoreRequests = [];
  const restoreOptions = [];
  const runtimeTuple = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  const executionRecord = {
    execution: { templateOutputId: 'output-adoption' },
    incomingManifest,
    inspectionResult: { classification: { kind: 'prepared-server-pack' } },
    adoption,
    reservation: null,
    serverKind: 'existing',
    source: {
      provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Owner', githubRepo: 'Pack',
      version: 'v1.0.0', title: 'Pack', selectedAssetIds: ['789']
    },
    serverPath: targetPath
  };
  const plan = {
    fingerprint: 'a'.repeat(64),
    operation: { kind: 'install', serverKind: 'existing', instanceId: 'server-existing', expectedContentRevision: 0 },
    source: {
      provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Owner', githubRepo: 'Pack', version: 'v1.0.0'
    },
    artifact: { setDigest: 'b'.repeat(64) },
    runtime: runtimeTuple,
    inspection: { fingerprint: 'c'.repeat(64) },
    ownership: { actions: [] },
    selections: { optionalFileIds: [], conflictChoices: { paths: {}, categories: {} } },
    preconditions: {
      artifactPartsFingerprint: 'd'.repeat(64), inspectionFingerprint: 'e'.repeat(64),
      ownershipFingerprint: 'f'.repeat(64), selectionsFingerprint: '1'.repeat(64),
      restorePointsFingerprint: '2'.repeat(64), assetPatternFingerprint: '3'.repeat(64),
      acceptedMappingFingerprint: '4'.repeat(64), operationFingerprint: '5'.repeat(64), minimumAvailableBytes: '1'
    }
  };
  const durableFs = {
    flushDirectory() {},
    async flushDirectoryAsync() {},
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    async readFileBoundedAsync(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    renameDurable(source, destination) { fs.renameSync(source, destination); },
    async renameDurableAsync(source, destination) { fs.renameSync(source, destination); },
    writeFileAtomic(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    async writeFileAtomicAsync(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    writeJsonAtomic(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`); },
    async writeJsonAtomicAsync(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`); }
  };
  const runtime = new ProductionMutationRuntime({
    availableBytes: async () => '999999999999',
    candidateHashService,
    destinationReservations: { resolve() { return null; }, consume() { return true; }, release() { return true; } },
    durableFsFactory: () => durableFs,
    fsApi: fs,
    healthValidator: { async validateCandidate() {}, async validateLive() { return { evidence: { ok: true } }; } },
    instanceResolver: {
      async resolveInstance(instanceId) { return { instanceId, serverPath: targetPath, priorRunning: false }; }
    },
    planningAdapter: { getExecutionRecord(received) { assert.equal(received, plan); return executionRecord; } },
    planValidator() {},
    prepareRuntime: async () => ({ prepared: true }),
    recoveryServices: {
      registry: recoveryRegistry,
      recoveryService: { async recoverWithLease() {}, async rollbackWithLease() {}, async failNewWithLease() {} },
      runtimeWriterAuthority: controlledRuntimeAuthority(),
      runtimePolicy: {
        async suspend() { return { held: true }; }, async ensureStopped() { return { stopped: true }; },
        async adoptValidatedHandoff() { return { adopted: true }; }, async restoreAutoRestart() { return { restored: true }; }
      }
    },
    releaseTrackingStore: { async list() { return []; }, async remove() { return false; }, async upsert() {} },
    reparseInspector,
    restorePointServiceFactory: () => ({
      async prepareVerifiedRestorePointCreation(request, options) {
        restoreRequests.push(structuredClone(request));
        restoreOptions.push({ stage: 'prepare', options });
        return { state: 'prepared' };
      },
      async createVerifiedRestorePoint(request, options) {
        restoreOptions.push({ stage: 'create', options });
        return {
          id: 'restore-unmanaged', sha256: '9'.repeat(64),
          sourceRevision: request.sourceRevision, sourceRuntime: request.sourceRuntime
        };
      },
      async restoreToOwnedCandidate() { throw new Error('not a rollback operation'); }
    }),
    snapshotServer,
    stateRepository,
    store: { get: key => key === 'instances' ? [] : null, set() {} },
    userDataPath: root,
    workspaceRegistry: {
      resolveOwnedWorkspace({ ownerId, id, kind }) {
        assert.match(ownerId, /^job-adoption(?:-inactive)?$/u);
        assert.equal(id, 'output-adoption');
        assert.equal(kind, 'output');
        return { id, kind, path: templatePath };
      }
    }
  });
  const resolved = { instanceId: 'server-existing', serverPath: targetPath, priorRunning: false };
  const lease = {
    kind: 'mutation', instanceId: 'server-existing', serverPath: targetPath, baseRevision: 0,
    markDirty() {}, assertOwnedPath() {}
  };

  await runtime.revalidate({
    jobId: 'job-adoption', plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    resolved,
    lease
  });
  const controller = new AbortController();
  const onProgress = () => {};
  const restorePoint = await runtime.createRestorePoint({
    jobId: 'job-adoption', plan, resolved, signal: controller.signal, onProgress
  });

  assert.equal(recoveryRegistry.record.target.kind, 'existing');
  assert.equal(recoveryRegistry.record.outcome.runtime.source, null);
  assert.equal(restoreRequests.length, 1);
  assert.equal(restoreRequests[0].sourceRevision, 0);
  assert.equal(restoreRequests[0].sourceRuntime, null);
  assert.equal(restorePoint.sourceRuntime, null);
  assert.deepEqual(restoreOptions.map(item => item.stage), ['prepare', 'create']);
  assert.equal(restoreOptions[0].options.signal, controller.signal);
  assert.equal(restoreOptions[0].options.onProgress, onProgress);
  assert.equal(restoreOptions[1].options.signal, controller.signal);
  assert.equal(restoreOptions[1].options.onProgress, onProgress);

  currentState = {
    state: {
      modpackManaged: false,
      contentRevision: 0,
      runtime: runtimeTuple,
      installedAt: '2026-07-01T00:00:00.000Z'
    },
    manifest: { schemaVersion: 1, installationId: 'detached-old-pack', entries: [] }
  };
  await runtime.revalidate({
    jobId: 'job-adoption-inactive', plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    resolved,
    lease
  });
  const inactiveRestore = await runtime.createRestorePoint({
    jobId: 'job-adoption-inactive', plan, resolved
  });

  assert.deepEqual(recoveryRegistry.record.outcome.runtime.source, runtimeTuple);
  assert.equal(restoreRequests.length, 2);
  assert.deepEqual(restoreRequests[1].sourceRuntime, runtimeTuple);
  assert.deepEqual(inactiveRestore.sourceRuntime, runtimeTuple);
});

test('existing update revalidation accepts post-review saves for a world recorded by an earlier lifecycle', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-quiescent-update-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server');
  const templatePath = path.join(root, 'template');
  fs.mkdirSync(path.join(serverPath, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(serverPath, 'world'), { recursive: true });
  fs.mkdirSync(path.join(templatePath, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'mods', 'pack.jar'), 'managed-pack');
  fs.writeFileSync(path.join(templatePath, 'mods', 'pack.jar'), 'managed-pack');
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), 'reviewed-world');

  const reparseInspector = { async isReparsePoint() { return false; } };
  const incomingManifest = (await scanManifest(templatePath, 'installation-update', {
    reparseInspector
  })).manifest;
  const runtimeTuple = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  const currentState = {
    state: {
      schemaVersion: 1,
      modpackManaged: true,
      source: {
        provider: 'github', repositoryId: '123', releaseId: '455', githubOwner: 'Owner', githubRepo: 'Pack',
        version: 'v0.9.0', title: 'Pack', selectedAssetIds: ['788'], artifactSetDigest: '8'.repeat(64)
      },
      runtime: runtimeTuple,
      selectedOptionalFiles: [],
      installedAt: '2026-08-01T00:00:00.000Z',
      contentRevision: 3
    },
    manifest: {
      ...incomingManifest,
      installationId: 'installation-current',
      entries: [
        ...incomingManifest.entries,
        {
          path: 'world/level.dat',
          pathKey: 'world/level.dat',
          origin: 'user',
          managementPolicy: 'protected',
          role: 'world',
          installedHash: crypto.createHash('sha256').update('reviewed-world').digest('hex'),
          size: String(Buffer.byteLength('reviewed-world')),
          priorBaseline: null
        }
      ].sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'))
    }
  };
  const stateRepository = {
    read() { return currentState; },
    async writeCandidateAsync() { throw new Error('candidate persistence is not part of revalidation'); },
    async appendHistoryAsync() { throw new Error('history persistence is not part of revalidation'); },
    listHistory() { return { items: [], nextCursor: null }; }
  };
  const snapshotServer = createProductionServerSnapshot({ fsApi: fs, reparseInspector, stateRepository });
  const reviewedSnapshot = await snapshotServer({
    currentState,
    operationKind: 'upgrade',
    runtime: runtimeTuple,
    serverKind: 'existing',
    serverPath
  });
  const reviewedOwnership = planOwnership({
    oldManifest: currentState.manifest,
    liveSnapshot: reviewedSnapshot.liveSnapshot,
    incomingManifest,
    conflictChoices: { paths: {}, categories: {} }
  });
  assert.equal(reviewedOwnership.blocked.length, 0);

  // This is the exact class of writes a graceful Minecraft shutdown performs
  // after the user reviewed the plan but before the mutation lease is acquired.
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), 'saved-during-stop');
  fs.writeFileSync(path.join(serverPath, 'world', 'session.lock'), 'new-during-stop');

  const recoveryRegistry = registryDouble();
  const durableFs = {
    flushDirectory() {},
    async flushDirectoryAsync() {},
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    async readFileBoundedAsync(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    renameDurable(source, destination) { fs.renameSync(source, destination); },
    async renameDurableAsync(source, destination) { fs.renameSync(source, destination); },
    writeFileAtomic(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    async writeFileAtomicAsync(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    writeJsonAtomic(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`); },
    async writeJsonAtomicAsync(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`); }
  };
  const source = {
    provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Owner', githubRepo: 'Pack',
    version: 'v1.0.0', title: 'Pack', selectedAssetIds: ['789']
  };
  const executionRecord = {
    execution: { templateOutputId: 'output-update' },
    incomingManifest,
    inspectionResult: { classification: { kind: 'prepared-server-pack' } },
    reservation: null,
    serverKind: 'existing',
    source,
    serverPath
  };
  let validatedSnapshot = null;
  let authorizeSourceSnapshot = null;
  const runtime = new ProductionMutationRuntime({
    availableBytes: async () => '999999999999',
    buildExistingCandidateFn: async context => {
      authorizeSourceSnapshot = context.authorizeSourceSnapshot;
      return { candidatePath: context.candidatePath };
    },
    destinationReservations: { resolve() { return null; }, consume() { return true; }, release() { return true; } },
    durableFsFactory: () => durableFs,
    fsApi: fs,
    healthValidator: { async validateCandidate() {}, async validateLive() { return { evidence: { ok: true } }; } },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: true }; } },
    planningAdapter: { getExecutionRecord() { return executionRecord; } },
    planValidator(_plan, snapshot) { validatedSnapshot = structuredClone(snapshot); },
    prepareRuntime: async () => ({ prepared: true }),
    recoveryServices: {
      registry: recoveryRegistry,
      recoveryService: { async recoverWithLease() {}, async rollbackWithLease() {}, async failNewWithLease() {} },
      runtimeWriterAuthority: controlledRuntimeAuthority(),
      runtimePolicy: {
        async suspend() { return { held: true }; }, async ensureStopped() { return { stopped: true }; },
        async adoptValidatedHandoff() { return { adopted: true }; }, async restoreAutoRestart() { return { restored: true }; }
      }
    },
    releaseTrackingStore: { async list() { return []; }, async remove() { return false; }, async upsert() {} },
    reparseInspector,
    snapshotServer,
    stateRepository,
    store: { get: key => key === 'instances' ? [] : null, set() {} },
    userDataPath: root,
    workspaceRegistry: {
      resolveOwnedWorkspace({ ownerId, id, kind }) {
        assert.equal(ownerId, 'job-update');
        assert.equal(id, 'output-update');
        assert.equal(kind, 'output');
        return { id, kind, path: templatePath };
      }
    }
  });
  const plan = {
    fingerprint: 'a'.repeat(64),
    operation: { kind: 'upgrade', serverKind: 'existing', instanceId: 'server-one', expectedContentRevision: 3 },
    source: { provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Owner', githubRepo: 'Pack', version: 'v1.0.0' },
    artifact: { setDigest: 'b'.repeat(64) },
    runtime: runtimeTuple,
    inspection: { fingerprint: 'c'.repeat(64) },
    ownership: reviewedOwnership,
    selections: { optionalFileIds: [], conflictChoices: { paths: {}, categories: {} } },
    preconditions: {
      paths: reviewedSnapshot.pathPreconditions,
      artifactPartsFingerprint: 'd'.repeat(64), inspectionFingerprint: 'e'.repeat(64),
      ownershipFingerprint: 'f'.repeat(64), selectionsFingerprint: '1'.repeat(64),
      restorePointsFingerprint: '2'.repeat(64), assetPatternFingerprint: '3'.repeat(64),
      acceptedMappingFingerprint: '4'.repeat(64), operationFingerprint: '5'.repeat(64), minimumAvailableBytes: '1'
    }
  };
  const resolved = { instanceId: 'server-one', serverPath, priorRunning: true };
  const lease = {
    kind: 'mutation', instanceId: 'server-one', serverPath, baseRevision: 3,
    markDirty() {}, assertOwnedPath() {}
  };

  await runtime.revalidate({
    jobId: 'job-update',
    plan,
    choices: { acceptEula: false, startAfterInstall: true, restorePointId: null },
    resolved,
    lease
  });

  assert.deepEqual(validatedSnapshot.pathPreconditions, reviewedSnapshot.pathPreconditions);
  const executionOwnership = runtime.contexts.get('job-update').executionOwnership;
  assert.equal(executionOwnership.actions.find(action => action.pathKey === 'world/level.dat').action, 'preserve-orphan');
  assert.equal(executionOwnership.actions.find(action => action.pathKey === 'world/session.lock').action, 'preserve-user-addon');
  assert.equal(recoveryRegistry.record.phase, 'preflight');

  await runtime.buildCandidate({
    jobId: 'job-update', operationKind: 'update', plan,
    choices: { acceptEula: false, startAfterInstall: true, restorePointId: null },
    restorePoint: null, resolved, lease
  });
  assert.equal(typeof authorizeSourceSnapshot, 'function');

  async function exactFenceSnapshot() {
    const current = await snapshotServer({
      currentState,
      operationKind: 'upgrade',
      runtime: runtimeTuple,
      serverKind: 'existing',
      serverPath
    });
    const entries = current.pathPreconditions.map(entry => ({
      path: entry.path,
      pathKey: entry.pathKey,
      type: entry.type,
      size: entry.size,
      sha256: entry.sha256,
      dev: entry.dev,
      ino: entry.ino,
      birthtime: entry.birthtime
    }));
    return {
      directoryIdentity: { volumeSerial: 'volume-1', fileId: 'server-one' },
      fingerprint: 'f'.repeat(64),
      totalBytes: entries.reduce((total, entry) => total + BigInt(entry.size), 0n).toString(),
      entries
    };
  }

  fs.mkdirSync(path.join(serverPath, 'world', 'region'));
  fs.writeFileSync(path.join(serverPath, 'world', 'region', 'r.0.0.mca'), 'late-passive-save');
  await authorizeSourceSnapshot(await exactFenceSnapshot());
  const fenceOwnership = runtime.contexts.get('job-update').executionOwnership;
  assert.equal(fenceOwnership.actions.find(action => action.pathKey === 'world/region/r.0.0.mca').action, 'preserve-user-addon');

  fs.writeFileSync(path.join(serverPath, 'mods', 'pack.jar'), 'managed-hack');
  await assert.rejects(
    authorizeSourceSnapshot(await exactFenceSnapshot()),
    error => error?.code === 'PLAN_STALE'
  );
  assert.equal(fs.readFileSync(path.join(serverPath, 'mods', 'pack.jar'), 'utf8'), 'managed-hack');
});

test('outcome persistence yields between independent durable metadata publications', async t => {
  const events = [];
  const context = fixture(t, { async yieldControl() { events.push('yield'); } });
  const { plan, resolved, lease } = await context.prepare();
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  });
  context.runtime.stateRepository.appendHistoryAsync = async () => { events.push('history'); };
  context.runtime.releaseTrackingReconciler = {
    createIntent() { return { tracked: true }; },
    async persistIntent() { events.push('tracking-intent'); },
    async reconcile() { events.push('tracking-reconcile'); }
  };
  events.length = 0;

  await context.runtime.persistOutcome({
    jobId: 'job-one', operationKind: 'install-new', plan, restorePoint: null, resolved
  });

  assert.deepEqual(events, [
    'history', 'yield',
    'tracking-intent', 'yield',
    'tracking-reconcile', 'yield'
  ]);
});

test('outcome persistence awaits asynchronous history publication without using the blocking repository API', async t => {
  let releaseHistory;
  let signalHistoryStarted;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  const historyStarted = new Promise(resolve => { signalHistoryStarted = resolve; });
  t.after(() => releaseHistory());
  const context = fixture(t);
  const { plan, resolved, lease } = await context.prepare();
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  });
  context.runtime.stateRepository.appendHistory = () => {
    throw new Error('synchronous history publication must not run');
  };
  context.runtime.stateRepository.appendHistoryAsync = async () => {
    signalHistoryStarted();
    await historyGate;
  };
  const persistOutcome = context.runtime.persistOutcome({
    jobId: 'job-one', operationKind: 'install-new', plan, restorePoint: null, resolved
  }).then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', error }));

  const first = await Promise.race([
    historyStarted.then(() => 'async-history-started'),
    persistOutcome.then(outcome => outcome.status)
  ]);
  assert.equal(first, 'async-history-started');
  assert.equal(await Promise.race([
    persistOutcome.then(outcome => outcome.status),
    new Promise(resolve => setImmediate(() => resolve('pending')))
  ]), 'pending');

  releaseHistory();
  const outcome = await persistOutcome;
  assert.equal(outcome.status, 'resolved', outcome.error?.stack);
});

test('cleanup yields around tracking, transaction, and terminal recovery durability boundaries', async t => {
  const events = [];
  const context = fixture(t, { async yieldControl() { events.push('yield'); } });
  const { plan, resolved, lease } = await context.prepare();
  context.runtime.releaseTrackingReconciler = {
    async reconcile() { events.push('tracking-reconcile'); }
  };
  context.runtime.recoveryRegistry.finish = async () => {
    events.push('recovery-finish');
    return { phase: 'completed' };
  };
  events.length = 0;

  await context.runtime.cleanup({
    jobId: 'job-one', operationKind: 'install-new', plan, resolved, lease
  });

  assert.deepEqual(events, [
    'tracking-reconcile', 'yield',
    'recovery-finish', 'yield'
  ]);
});

test('new-server revalidation defers template hashing to the manifest-bound candidate copy', async t => {
  const serviceA = recordingHashService();
  const serviceB = recordingHashService();
  const contextA = fixture(t, { candidateHashService: serviceA });
  const contextB = fixture(t, { candidateHashService: serviceB });

  await contextA.prepare();
  assert.equal(serviceA.hashedPaths.length, 0);
  assert.equal(serviceB.hashedPaths.length, 0);
  await contextB.prepare();

  assert.equal(serviceA.hashedPaths.every(filePath => filePath.startsWith(contextA.templatePath)), true);
  assert.equal(serviceB.hashedPaths.every(filePath => filePath.startsWith(contextB.templatePath)), true);
  assert.equal(serviceA.hashedPaths.some(filePath => filePath.startsWith(contextB.templatePath)), false);
  assert.equal(serviceB.hashedPaths.some(filePath => filePath.startsWith(contextA.templatePath)), false);
});

test('new candidate uses manifest-bound copying and one post-runtime scan instead of repeated full scans', async t => {
  const hashService = recordingHashService();
  const context = fixture(t, { candidateHashService: hashService });
  const { plan, resolved, lease } = await context.prepare();
  hashService.hashedPaths.length = 0;

  const candidate = await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  });

  const generatedRuntimePath = path.join(candidate.candidatePath, 'trusted-runtime.marker');
  const templatePackPath = path.join(context.templatePath, 'config', 'pack.toml');
  const candidatePackPath = path.join(candidate.candidatePath, 'config', 'pack.toml');
  const importedPackHashes = hashService.hashedPaths.filter(filePath =>
    filePath === templatePackPath || filePath === candidatePackPath);
  const generatedRuntimeHashes = hashService.hashedPaths
    .filter(filePath => filePath === generatedRuntimePath);
  assert.equal(importedPackHashes.length, 3);
  assert.equal(importedPackHashes.filter(filePath => filePath === templatePackPath).length, 1);
  assert.equal(importedPackHashes.filter(filePath => filePath === candidatePackPath).length, 2);
  assert.equal(generatedRuntimeHashes.length, 1);
  assert.equal(
    context.writtenState.manifest.entries.find(entry => entry.pathKey === 'trusted-runtime.marker').installedHash,
    crypto.createHash('sha256').update('generated-by-runtime-preparation').digest('hex')
  );
});

test('new candidate Java acquisition receives the exact lifecycle cancellation signal', async t => {
  const context = fixture(t);
  const { plan, resolved, lease } = await context.prepare();
  const controller = new AbortController();

  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease, signal: controller.signal
  });

  assert.equal(context.javaEnsureOptions?.signal, controller.signal);
});

test('new candidate maps Java acquisition and runtime preparation into path-free monotonic lifecycle progress', async t => {
  const context = fixture(t, {
    javaProgressEvents: [
      { type: 'Preparing', task: 'private metadata', progress: 0 },
      { type: 'Downloading', task: 'private archive name', progress: 10 },
      { type: 'Downloading', task: 'private archive name', progress: 15 },
      { type: 'Downloading', task: 'private archive name', progress: 75 },
      { type: 'Downloading', task: 'private archive name', progress: 80 },
      { type: 'Extracting', task: 'private candidate path', progress: 0 },
      { type: 'Verifying', task: 'private executable path', progress: 90 },
      { type: 'Complete', task: 'private Java path', progress: 100 }
    ]
  });
  const { plan, resolved, lease } = await context.prepare();
  const progress = [];

  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease,
    onProgress: async event => { progress.push(structuredClone(event)); }
  });

  assert.deepEqual(progress.map(event => [event.percent, event.message]), [
    [40, 'Copying reviewed modpack files (0 of 1 files, 0 of 13 bytes)'],
    [43, 'Copying reviewed modpack files (1 of 1 files, 13 of 13 bytes)'],
    [44, 'Checking the exact Java runtime'],
    [44, 'Preparing the exact Java runtime'],
    [45, 'Downloading the exact Java runtime'],
    [46, 'Downloading the exact Java runtime'],
    [46, 'Extracting the exact Java runtime'],
    [47, 'Verifying the exact Java runtime'],
    [47, 'Exact Java runtime ready'],
    [47, 'Exact Java runtime ready'],
    [48, 'Installing the exact server loader runtime'],
    [49, 'Recording managed runtime file ownership']
  ]);
  assert.equal(progress.every((event, index) => index === 0 || event.percent >= progress[index - 1].percent), true);
  assert.equal(JSON.stringify(progress).includes('private'), false);
});

test('large packs refresh copied-file counts even while byte-weighted percent stays unchanged', async t => {
  const context = fixture(t);
  for (let index = 0; index < 128; index += 1) {
    fs.writeFileSync(
      path.join(context.templatePath, 'config', `a-${String(index).padStart(3, '0')}.toml`),
      'x'
    );
  }
  fs.writeFileSync(path.join(context.templatePath, 'config', 'zz-large.bin'), Buffer.alloc(1024 * 1024));
  const { plan, resolved, lease } = await context.prepare();
  const progress = [];

  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease,
    onProgress: async event => { progress.push(structuredClone(event)); }
  });

  const samePercentRefresh = progress.find(event =>
    event.percent === 40 && /Copying reviewed modpack files \(128 of 130 files,/u.test(event.message)
  );
  assert.ok(samePercentRefresh, JSON.stringify(progress.map(event => [event.percent, event.message])));
  assert.equal(progress.every((event, index) => index === 0 || event.percent >= progress[index - 1].percent), true);
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

test('files-only new-server publication and registration retain import recovery lineage', async t => {
  const context = fixture(t, { useRealNewTransaction: true });
  const { plan, resolved, lease } = await context.prepare({ filesOnly: true });
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'import-files-only-new', plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  });

  assert.equal(context.recoveryRegistry.record.operationKind, 'import');
  assert.equal((await context.runtime.publishCandidate({
    jobId: 'job-one', plan, resolved, lease
  })).phase, 'published');
  await context.runtime.registerPublishedInstance({ jobId: 'job-one', plan, resolved, lease });
  assert.equal(context.recoveryRegistry.record.phase, 'registering');
});

test('inactive new-server revision publication commits only after one canonical health boot', async t => {
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
  assert.deepEqual(context.liveValidationSteps, ['authorize', 'health', 'verify']);
  assert.equal(context.liveHealthCount, 1);
  assert.equal(context.publishedCandidateVerificationCount, 0);
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
  assertSnapshotRevision = null,
  baseRevision = 3,
  createSafetyRestore = false,
  expectedContentRevision = baseRevision,
  operationKind = 'repair',
  lifecycleSignal = null,
  removeActionCount = 0,
  corruptJava = false,
  corruptRuntime = false,
  cleanupResult = { phase: 'completed', rollbackRemoved: true },
  expectBuildFailure = false,
  stagedRuntimeMismatch = false,
  runtimePreparationError = null
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
  const removalPaths = Array.from(
    { length: removeActionCount },
    (_unused, index) => `mods/obsolete/old-addon-${String(index).padStart(3, '0')}.jar`
  );
  fs.writeFileSync(path.join(serverPath, 'server.jar'), liveRuntimeBytes);
  fs.writeFileSync(path.join(serverPath, 'libraries', 'healthy.bin'), healthyLibraryBytes);
  fs.mkdirSync(path.join(serverPath, 'java', 'java-21', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'java', 'java-21', 'bin', 'java.exe'), liveJavaBytes);
  fs.writeFileSync(path.join(templatePath, 'mods', 'missing.jar'), modBytes);
  for (const relative of removalPaths) {
    const destination = path.join(serverPath, ...relative.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `obsolete-${relative}`);
  }
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
  const removalEntries = removalPaths.map((relative, index) => ({
    ...managedEntry(relative, Buffer.from(`obsolete-${relative}`), index % 2 === 0 ? 'pack' : 'user', 'mod'),
    managementPolicy: index % 2 === 0 ? 'replaceable-managed' : 'protected'
  }));
  const incomingManifest = {
    schemaVersion: 1,
    installationId: 'installation-repair',
    entries: [javaEntry, libraryEntry, modEntry, runtimeEntry, ...removalEntries]
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
      schemaVersion: 1,
      installationId: 'installation-current',
      entries: [javaEntry, libraryEntry, modEntry, runtimeEntry, ...removalEntries]
    }
  };
  let preparedRuntimeCalls = 0;
  let ensuredJavaCalls = 0;
  let javaEnsureOptions = null;
  let preparedTargetPath = null;
  let dirtyCalls = 0;
  let flushDirectoryCalls = 0;
  const restoreRequests = [];
  let writtenState = null;
  const recoveryRegistry = registryDouble();
  const durableFs = {
    flushDirectory() { flushDirectoryCalls += 1; },
    async flushDirectoryAsync() { flushDirectoryCalls += 1; },
    writeFileAtomic(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    async writeFileAtomicAsync(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    renameDurable(source, destination) { fs.renameSync(source, destination); },
    async renameDurableAsync(source, destination) { fs.renameSync(source, destination); },
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    async readFileBoundedAsync(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    writeJsonAtomic(filePath, value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomicAsync(filePath, value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    }
  };
  const executionRecord = {
    execution: { templateOutputId: 'output-repair', repairPayloadManifest },
    incomingManifest: operationKind === 'repair' ? incomingManifest : repairPayloadManifest,
    inspectionResult: { classification: { kind: 'prepared-server-pack' } },
    reservation: null,
    serverKind: 'existing',
    source: currentState.state.source,
    serverPath
  };
  const plan = {
    fingerprint: 'a'.repeat(64),
    operation: { kind: operationKind, serverKind: 'existing', instanceId: 'server-one', expectedContentRevision },
    source: {
      provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Owner', githubRepo: 'Pack', version: 'v1.0.0'
    },
    artifact: { setDigest: 'b'.repeat(64) },
    runtime: runtimeTuple,
    inspection: { fingerprint: 'c'.repeat(64) },
    ownership: {
      actions: [
        ...removalPaths.map((relative, index) => ({
          path: relative,
          pathKey: relative,
          action: index % 2 === 0 ? 'remove' : 'remove-user-addon',
          role: 'mod'
        })),
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
    cleanupCommittedTransactionFn: async () => structuredClone(cleanupResult),
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
        async ensureJava(_javaMajor, _progressCallback, ensureOptions) {
          ensuredJavaCalls += 1;
          javaEnsureOptions = ensureOptions;
          if (operationKind !== 'repair') {
            return {
              success: true,
              javaPath: path.join(javaRoot, 'java', 'java-21', 'bin', 'java.exe')
            };
          }
          if (!corruptJava) throw new Error('healthy runtime must not be downloaded');
          const javaPath = path.join(javaRoot, 'java', 'java-21', 'bin', 'java.exe');
          fs.mkdirSync(path.dirname(javaPath), { recursive: true });
          fs.writeFileSync(javaPath, healthyJavaBytes);
          return { success: true, javaPath };
        }
      };
    },
    planValidator(_plan, snapshot) {
      if (assertSnapshotRevision !== null) assert.equal(snapshot.contentRevision, assertSnapshotRevision);
    },
    planningAdapter: { getExecutionRecord() { return executionRecord; } },
    prepareRuntime: async ({ targetPath }) => {
      preparedRuntimeCalls += 1;
      if (operationKind !== 'repair') return { prepared: true };
      if (!corruptRuntime) throw new Error('healthy runtime must not be rewritten');
      preparedTargetPath = targetPath;
      fs.mkdirSync(path.join(targetPath, 'libraries'), { recursive: true });
      fs.writeFileSync(
        path.join(targetPath, 'server.jar'),
        stagedRuntimeMismatch ? Buffer.from('unexpected-runtime-build') : trustedRuntimeBytes
      );
      fs.writeFileSync(path.join(targetPath, 'libraries', 'healthy.bin'), runtimeWriterLibraryBytes);
      if (runtimePreparationError) throw runtimePreparationError;
    },
    recoveryServices: {
      registry: recoveryRegistry,
      recoveryService: { async recoverWithLease() {}, async rollbackWithLease() {}, async failNewWithLease() {} },
      runtimeWriterAuthority: controlledRuntimeAuthority(),
      releaseTrackingReconciler: {
        async reconcile() { return { reconciled: true }; },
        createIntent() { return null; },
        async persistIntent() { return { persisted: true }; }
      },
      runtimePolicy: {
        suspend() { return { held: true }; }, async ensureStopped() { return { alreadyStopped: true }; },
        async adoptValidatedHandoff() { return { adopted: true }; }, restoreAutoRestart() { return { restored: true }; }
      }
    },
    releaseTrackingStore: { async list() { return []; }, async remove() { return false; }, async upsert() {} },
    reparseInspector,
    restorePointServiceFactory: () => ({
      async prepareVerifiedRestorePointCreation(request) {
        restoreRequests.push(structuredClone(request));
        return { state: 'prepared' };
      },
      async createVerifiedRestorePoint(request) {
        return {
          id: 'restore-reviewed-revision', sha256: 'a'.repeat(64),
          sourceRevision: request.sourceRevision, sourceRuntime: request.sourceRuntime
        };
      },
      async restoreToOwnedCandidate() { throw new Error('not a rollback operation'); }
    }),
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
      async writeCandidateAsync(_candidatePath, state) { writtenState = structuredClone(state); return { state: writtenState }; },
      listHistory() { return { items: [], nextCursor: null }; }, appendHistory() {}, async appendHistoryAsync() {}
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
    kind: 'mutation', instanceId: 'server-one', serverPath, baseRevision,
    markDirty() { dirtyCalls += 1; }, assertOwnedPath() {}
  };
  const choices = { acceptEula: false, startAfterInstall: false, restorePointId: null };

  await runtime.revalidate({ jobId: 'job-repair', plan, choices, resolved, lease });
  const safetyRestore = createSafetyRestore
    ? await runtime.createRestorePoint({ jobId: 'job-repair', plan, resolved })
    : null;
  let buildError = null;
  let built = null;
  if (!createSafetyRestore) {
    try {
      built = await runtime.buildCandidate({
        jobId: 'job-repair', operationKind: operationKind === 'upgrade' ? 'update' : operationKind,
        plan, choices, restorePoint: null, resolved, lease,
        ...(lifecycleSignal ? { signal: lifecycleSignal } : {})
      });
    } catch (error) {
      if (!expectBuildFailure) throw error;
      buildError = error;
    }
  }

  return {
    buildError,
    built,
    dirtyCalls,
    ensuredJavaCalls,
    flushDirectoryCalls,
    javaEnsureOptions,
    hash,
    healthyLibraryBytes,
    healthyJavaBytes,
    modBytes,
    preparedRuntimeCalls,
    preparedTargetPath,
    plan,
    removalPaths,
    recoveryRegistry,
    resolved,
    restoreRequests,
    runtime,
    safetyRestore,
    trustedRuntimeBytes,
    writtenState,
    lease
  };
}

test('inactive new server persists and boots with its reviewed resources and loopback network', async t => {
  const context = fixture(t, {
    maxRam: 6,
    serverPort: 25571,
    networkAccess: 'loopback',
    useRealNewTransaction: true
  });
  const { plan, resolved, lease } = await context.prepare();
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: false, restorePointId: null },
    restorePoint: null, resolved, lease
  });

  assert.deepEqual(context.candidateHealthRequests, []);
  const staged = await context.recoveryRegistry.load('job-one');
  const candidateConfig = JSON.parse(fs.readFileSync(path.join(staged.candidatePath, '.minecraft-core.json'), 'utf8'));
  assert.equal(candidateConfig.maxRam, 6);
  assert.equal(candidateConfig.port, 25571);
  assert.equal(candidateConfig.networkAccess, 'loopback');
  const candidateProperties = fs.readFileSync(path.join(staged.candidatePath, 'server.properties'), 'utf8');
  assert.match(candidateProperties, /(?:^|\n)server-port=25571(?:\n|$)/u);
  assert.match(candidateProperties, /(?:^|\n)server-ip=127\.0\.0\.1(?:\n|$)/u);
  await context.recoveryRegistry.transition('job-one', {
    expectedPhase: staged.phase,
    nextPhase: 'registering',
    patch: {
      outcome: {
        ...(staged.outcome || {}),
        registration: { instanceId: resolved.instanceId, complete: true }
      }
    }
  });
  await context.runtime.validateLive({
    jobId: 'job-one', operationKind: 'install-new', plan,
    resolved, running: false, lease
  });

  assert.deepEqual(context.liveHealthRequests, [{
    keepRunning: false,
    maxRam: 6,
    networkAccess: 'loopback',
    port: 25571,
    serverPath: resolved.serverPath
  }]);
  assert.deepEqual(context.liveValidationSteps, ['authorize', 'health', 'verify']);
  assert.equal(context.publishedCandidateVerificationCount, 0);
  assert.deepEqual(context.adoptedHandoffs, []);
  assert.equal(context.recoveryRegistry.record.outcome.runtime.maxRam, 6);
  assert.equal(context.recoveryRegistry.record.outcome.runtime.networkAccess, 'loopback');
});

test('new server requested to remain running still performs one final live boot and adopts it', async t => {
  const context = fixture(t, { useRealNewTransaction: true });
  const { plan, resolved, lease } = await context.prepare();
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: true, restorePointId: null },
    restorePoint: null, resolved, lease
  });
  assert.deepEqual(context.candidateHealthRequests, []);
  const staged = await context.recoveryRegistry.load('job-one');
  await context.recoveryRegistry.transition('job-one', {
    expectedPhase: staged.phase,
    nextPhase: 'registering',
    patch: {
      outcome: {
        ...(staged.outcome || {}),
        registration: { instanceId: resolved.instanceId, complete: true }
      }
    }
  });

  await context.runtime.validateLive({
    jobId: 'job-one', operationKind: 'install-new', plan,
    resolved, running: true, lease
  });

  assert.deepEqual(context.liveValidationSteps, ['authorize', 'health', 'verify']);
  assert.equal(context.liveHealthCount, 1);
  assert.equal(context.publishedCandidateVerificationCount, 0);
  assert.deepEqual(context.liveHealthRequests, [{
    keepRunning: true,
    maxRam: 6,
    networkAccess: 'pack-default',
    port: 25565,
    serverPath: resolved.serverPath
  }]);
  assert.deepEqual(context.adoptedHandoffs, [{
    eventId: 'modpack-runtime-handoff:job-one',
    instanceId: resolved.instanceId,
    jobId: 'job-one',
    serverPath: resolved.serverPath
  }]);
  assert.equal(context.adoptedHandoffIsExact, true);
  assert.equal(context.recoveryRegistry.record.outcome.runtimePolicy.runningRestored, true);
});

test('new running server stops the exact retained handoff when canonical completion verification fails', async t => {
  const context = fixture(t, { useRealNewTransaction: true });
  const { plan, resolved, lease } = await context.prepare();
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: true, restorePointId: null },
    restorePoint: null, resolved, lease
  });
  const staged = await context.recoveryRegistry.load('job-one');
  await context.recoveryRegistry.transition('job-one', {
    expectedPhase: staged.phase,
    nextPhase: 'registering',
    patch: {
      outcome: {
        ...(staged.outcome || {}),
        registration: { instanceId: resolved.instanceId, complete: true }
      }
    }
  });
  const retained = retainedHandoffDouble();
  context.runtime.healthValidator.validateLive = async () => ({
    evidence: { ok: true },
    handoff: retained.handoff
  });
  context.runtime.completeNewLiveValidationFn = async () => {
    throw new ModpackError('HEALTH_CHECK_FAILED', 'injected canonical completion failure');
  };

  await assert.rejects(context.runtime.validateLive({
    jobId: 'job-one', operationKind: 'install-new', plan,
    resolved, running: true, lease
  }), error => error?.code === 'HEALTH_CHECK_FAILED');

  assert.equal(retained.stopCalls(), 1);
  assert.equal(retained.isLive(), false);
  assert.deepEqual(context.adoptedHandoffs, []);
});

test('new running server stops the exact retained handoff when process adoption rejects', async t => {
  const context = fixture(t, { useRealNewTransaction: true });
  const { plan, resolved, lease } = await context.prepare();
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: true, restorePointId: null },
    restorePoint: null, resolved, lease
  });
  const staged = await context.recoveryRegistry.load('job-one');
  await context.recoveryRegistry.transition('job-one', {
    expectedPhase: staged.phase,
    nextPhase: 'registering',
    patch: {
      outcome: {
        ...(staged.outcome || {}),
        registration: { instanceId: resolved.instanceId, complete: true }
      }
    }
  });
  const retained = retainedHandoffDouble();
  context.runtime.healthValidator.validateLive = async () => ({
    evidence: { ok: true },
    handoff: retained.handoff
  });
  context.runtime.runtimePolicy.adoptValidatedHandoff = async () => {
    throw new Error('injected adoption failure');
  };

  await assert.rejects(context.runtime.validateLive({
    jobId: 'job-one', operationKind: 'install-new', plan,
    resolved, running: true, lease
  }), /injected adoption failure/u);

  assert.equal(retained.stopCalls(), 1);
  assert.equal(retained.isLive(), false);
});

test('an unproven retained process blocks new-server quarantine instead of renaming a live canonical', async t => {
  let failNewCalls = 0;
  const context = fixture(t, {
    useRealNewTransaction: true,
    onFailNewWithLease() { failNewCalls += 1; }
  });
  const { plan, resolved, lease } = await context.prepare();
  await context.runtime.buildCandidate({
    jobId: 'job-one', operationKind: 'install-new', plan,
    choices: { acceptEula: true, startAfterInstall: true, restorePointId: null },
    restorePoint: null, resolved, lease
  });
  const staged = await context.recoveryRegistry.load('job-one');
  await context.recoveryRegistry.transition('job-one', {
    expectedPhase: staged.phase,
    nextPhase: 'registering',
    patch: {
      outcome: {
        ...(staged.outcome || {}),
        registration: { instanceId: resolved.instanceId, complete: true }
      }
    }
  });
  const retained = retainedHandoffDouble({ closes: false });
  context.runtime.healthValidator.validateLive = async () => ({
    evidence: { ok: true },
    handoff: retained.handoff
  });
  context.runtime.completeNewLiveValidationFn = async () => {
    throw new ModpackError('HEALTH_CHECK_FAILED', 'injected canonical completion failure');
  };

  let validationError;
  await assert.rejects(context.runtime.validateLive({
    jobId: 'job-one', operationKind: 'install-new', plan,
    resolved, running: true, lease
  }), error => {
    validationError = error;
    return error?.code === 'HEALTH_CHECK_FAILED';
  });
  await assert.rejects(context.runtime.rollback({
    jobId: 'job-one', plan, resolved, lease, error: validationError
  }), error => error?.code === 'RECOVERY_REQUIRED');

  assert.equal(retained.stopCalls(), 1);
  assert.equal(retained.isLive(), true);
  assert.equal(failNewCalls, 0);
  assert.equal((await context.recoveryRegistry.load('job-one')).phase, 'validating-live');
});

test('existing candidate batches durability at the transaction boundary while applying many removals', async t => {
  const removeActionCount = 64;
  const result = await targetedRepairFixture(t, { operationKind: 'upgrade', removeActionCount });

  assert.equal(result.plan.ownership.actions.filter(action => action.action === 'remove').length, removeActionCount / 2);
  assert.equal(
    result.plan.ownership.actions.filter(action => action.action === 'remove-user-addon').length,
    removeActionCount / 2
  );
  for (const relative of result.removalPaths) {
    assert.equal(fs.existsSync(path.join(result.built.candidatePath, ...relative.split('/'))), false, relative);
  }
  assert.equal(result.dirtyCalls, removeActionCount + 3);
  assert.equal(result.flushDirectoryCalls, 0);
});

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

test('cleanup-pending is never finalized as a successful production mutation', async t => {
  const result = await targetedRepairFixture(t, {
    cleanupResult: { phase: 'cleanup-pending', rollbackRemoved: false }
  });

  await assert.rejects(
    result.runtime.cleanup({
      jobId: 'job-repair', operationKind: 'repair', plan: result.plan,
      resolved: result.resolved, lease: result.lease
    }),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(result.recoveryRegistry.finishCalls, 0);
});

test('existing candidate revision advances from the coordinator when ordinary writes are newer than managed state', async t => {
  const result = await targetedRepairFixture(t, { baseRevision: 8 });

  assert.equal(result.writtenState.contentRevision, 9);
});

test('existing update and downgrade safety restores use the reviewed coordinator revision ahead of managed state', async t => {
  for (const operationKind of ['upgrade', 'downgrade']) {
    const result = await targetedRepairFixture(t, {
      baseRevision: 8,
      createSafetyRestore: true,
      expectedContentRevision: 8,
      operationKind
    });

    assert.equal(result.restoreRequests.length, 1, operationKind);
    assert.equal(result.restoreRequests[0].sourceRevision, 8, operationKind);
    assert.equal(result.safetyRestore.sourceRevision, 8, operationKind);
  }
});

test('revalidation exposes the leased coordinator revision instead of echoing a stale reviewed revision', async t => {
  await assert.rejects(
    targetedRepairFixture(t, {
      assertSnapshotRevision: 8,
      baseRevision: 8,
      expectedContentRevision: 7
    }),
    error => error?.code === 'PLAN_STALE'
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

test('repair Java acquisition receives the exact lifecycle cancellation signal', async t => {
  const controller = new AbortController();
  const result = await targetedRepairFixture(t, {
    corruptJava: true,
    lifecycleSignal: controller.signal
  });

  assert.equal(result.ensuredJavaCalls, 1);
  assert.equal(result.javaEnsureOptions?.signal, controller.signal);
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

test('repair retains its nested staging directory when runtime shutdown is unproven', async t => {
  const runtimePreparationError = Object.assign(new Error('runtime child still owns staging'), { preserveWorkspace: true });
  const result = await targetedRepairFixture(t, {
    corruptRuntime: true,
    expectBuildFailure: true,
    runtimePreparationError
  });
  assert.equal(result.buildError, runtimePreparationError);
  assert.equal(fs.existsSync(result.preparedTargetPath), true);
});
