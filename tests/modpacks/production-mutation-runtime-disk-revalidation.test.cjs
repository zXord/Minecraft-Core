const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProductionMutationRuntime
} = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
const {
  scanManifest
} = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');
const {
  createProductionServerSnapshot
} = require('../../electron/services/modpacks/planning/production-server-snapshot.cjs');

const RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0',
  javaMajor: 17, os: 'win32', architecture: 'x64'
});

function writeSparseFile(filePath, size) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, 'w');
  try {
    fs.ftruncateSync(descriptor, size);
  } finally {
    fs.closeSync(descriptor);
  }
}

function reviewedServerDisk(snapshot) {
  return {
    candidateBytes: snapshot.candidateBytes,
    restorePointBytes: snapshot.restorePointBytes,
    rollbackBytes: snapshot.rollbackBytes,
    journalBytes: snapshot.journalBytes
  };
}

test('source revalidation includes growth in excluded backup, state, log, and crash paths before mutation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-source-disk-revalidation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Managed Server');
  const templatePath = path.join(root, 'template');
  fs.mkdirSync(path.join(serverPath, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(templatePath, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'mods', 'current.jar'), 'current');
  fs.writeFileSync(path.join(templatePath, 'mods', 'incoming.jar'), 'incoming');
  const source = {
    provider: 'github', repositoryId: 'repo-one', releaseId: 'release-two',
    githubOwner: 'Owner', githubRepo: 'Pack', version: 'v2'
  };
  const currentState = {
    state: {
      schemaVersion: 1, modpackManaged: true, contentRevision: 3, runtime: RUNTIME,
      source: { ...source, title: 'Pack', selectedAssetIds: ['server-pack'] }
    },
    manifest: { schemaVersion: 1, installationId: 'installed-one', entries: [] }
  };
  const stateRepository = {
    read() { return structuredClone(currentState); },
    listHistory() { return { items: [], nextCursor: null }; },
    async writeCandidateAsync() {},
    async appendHistoryAsync() {}
  };
  const reparseInspector = { async isReparsePoint() { return false; } };
  const snapshotServer = createProductionServerSnapshot({ fsApi: fs, reparseInspector, stateRepository });
  const reviewedSnapshot = await snapshotServer({
    currentState, operationKind: 'upgrade', runtime: RUNTIME,
    serverKind: 'existing', serverPath
  });
  const incomingManifest = (await scanManifest(templatePath, 'incoming-two', { reparseInspector })).manifest;

  // Sparse files make the reviewed capacity obsolete without reading or
  // allocating gigabytes of test data. Every path is intentionally outside the
  // ownership manifest but inside an operation's actual copy/archive scope.
  const growthBytes = 1_100_000_000;
  writeSparseFile(path.join(serverPath, 'backups', 'late.zip'), growthBytes);
  writeSparseFile(path.join(serverPath, '.minecraft-core-state', 'operations', 'late.bin'), growthBytes);
  writeSparseFile(path.join(serverPath, 'logs', 'late.log'), growthBytes);
  writeSparseFile(path.join(serverPath, 'crash-reports', 'late.txt'), growthBytes);

  const executionRecord = {
    execution: { templateOutputId: 'output-template' },
    incomingManifest,
    inspectionResult: { classification: { kind: 'prepared-server-pack' } },
    adoption: null,
    reservation: null,
    reviewedServerDisk: reviewedServerDisk(reviewedSnapshot),
    serverKind: 'existing',
    source,
    serverPath
  };
  const reviewedCandidateBytes = BigInt(reviewedSnapshot.candidateBytes) + BigInt('incoming'.length);
  const plan = {
    type: 'modpack-preflight-plan', schemaVersion: 1, fingerprint: 'a'.repeat(64),
    operation: { kind: 'upgrade', serverKind: 'existing', instanceId: 'server-one', expectedContentRevision: 3 },
    source,
    artifact: { setDigest: 'b'.repeat(64) },
    runtime: RUNTIME,
    inspection: { fingerprint: 'c'.repeat(64) },
    ownership: { actions: [] },
    selections: { optionalFileIds: [], conflictChoices: { paths: {}, categories: {} } },
    disk: {
      downloadBytes: '0', expandedBytes: '0', candidateBytes: reviewedCandidateBytes.toString(),
      restorePointBytes: reviewedSnapshot.restorePointBytes,
      rollbackBytes: reviewedSnapshot.rollbackBytes,
      journalBytes: reviewedSnapshot.journalBytes,
      reserveBytes: '0', requiredBytes: '1', availableBytes: '5000000000'
    },
    preconditions: {
      paths: reviewedSnapshot.pathPreconditions,
      artifactPartsFingerprint: 'd'.repeat(64), inspectionFingerprint: 'e'.repeat(64),
      ownershipFingerprint: 'f'.repeat(64), selectionsFingerprint: '1'.repeat(64),
      restorePointsFingerprint: '2'.repeat(64), assetPatternFingerprint: '3'.repeat(64),
      acceptedMappingFingerprint: '4'.repeat(64), operationFingerprint: '5'.repeat(64),
      minimumAvailableBytes: '1'
    }
  };
  let recoveryCreateCalls = 0;
  let record = null;
  const registry = {
    async create(value) { recoveryCreateCalls += 1; record = structuredClone(value); return structuredClone(record); },
    async load() { return record && structuredClone(record); },
    async transition(_jobId, request) {
      record = { ...record, ...structuredClone(request.patch), phase: request.nextPhase, sequence: record.sequence + 1 };
      return structuredClone(record);
    },
    async finish() { return record; }
  };
  const runtime = new ProductionMutationRuntime({
    availableBytes: async () => '5000000000',
    destinationReservations: { resolve() { return null; }, consume() { return true; }, release() { return true; } },
    durableFsFactory: () => ({
      async flushDirectoryAsync() {}, async renameDurableAsync() {}, async writeFileAtomicAsync() {}
    }),
    fsApi: fs,
    healthValidator: { async validateCandidate() {}, async validateLive() { return { evidence: { ok: true } }; } },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath, priorRunning: false }; } },
    planningAdapter: { getExecutionRecord(received) { assert.equal(received, plan); return executionRecord; } },
    planValidator() {},
    prepareRuntime: async () => ({ prepared: true }),
    recoveryServices: {
      registry,
      runtimeWriterAuthority: { async run(_jobId, work) { return work(); }, async assertRecoveryAllowed(record) { return record; } },
      recoveryService: { async recoverWithLease() {}, async rollbackWithLease() {}, async failNewWithLease() {} },
      runtimePolicy: {
        async suspend() { return { held: true }; }, async ensureStopped() { return { stopped: true }; },
        async adoptValidatedHandoff() { return { adopted: true }; }, async restoreAutoRestart() { return { restored: true }; }
      }
    },
    releaseTrackingStore: { async list() { return []; }, async remove() { return false; }, async upsert() {} },
    reparseInspector,
    snapshotServer,
    stateRepository,
    store: { get() { return []; }, set() {} },
    userDataPath: root,
    workspaceRegistry: {
      resolveOwnedWorkspace() { return { id: 'output-template', kind: 'output', path: templatePath }; }
    }
  });
  const resolved = { instanceId: 'server-one', serverPath, priorRunning: false };
  const lease = {
    kind: 'mutation', instanceId: 'server-one', serverPath, baseRevision: 3,
    markDirty() {}, assertOwnedPath(value) { return value; }
  };

  await assert.rejects(runtime.revalidate({
    jobId: 'job-source-disk', plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    resolved, lease
  }), error => error?.code === 'PLAN_STALE' && error?.details?.field === 'availableBytes');
  assert.equal(recoveryCreateCalls, 0);
});
