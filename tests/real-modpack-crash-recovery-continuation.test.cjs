const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createRecoveryTargetEnvelope } = require('../electron/services/modpack-lifecycle/recovery-target-envelope.cjs');
const {
  createExistingSiblingPaths,
  createSiblingPaths
} = require('../electron/services/modpack-lifecycle/server-directory-transaction.cjs');

let continuation;
try {
  continuation = require('./e2e/fixtures/real-modpack-crash-recovery-continuation.cjs');
} catch {
  continuation = {};
}

const IDENTITY = Object.freeze({ provider: 'modrinth', scenario: 'hard-crash-recovery' });
const INITIAL_VERSION_ID = 'oQ6gSIoF';
const UPDATE_VERSION_ID = 'zH4ppiGM';
const JOB_ID = `op2-${'a'.repeat(32)}`;
const LEGACY_JOB_ID = 'job-crash-continuation';
const INSTANCE_ID = 'server-crash-continuation';
const PLAN_FINGERPRINT = 'a'.repeat(64);

test('scratch path containment permits the exact root and descendants but rejects siblings and outside paths', () => {
  assert.equal(typeof continuation.resolvePathInsideScratchRoot, 'function');
  const root = path.join(os.tmpdir(), `${continuation.SCRATCH_PREFIX}containment-proof`);
  const descendant = path.join(root, 'evidence', 'marker.json');
  const prefixSibling = path.join(path.dirname(root), `${path.basename(root)}-sibling`, 'server');

  assert.equal(continuation.resolvePathInsideScratchRoot(root, root), path.resolve(root));
  assert.equal(continuation.resolvePathInsideScratchRoot(root, descendant), path.resolve(descendant));
  assert.throws(
    () => continuation.resolvePathInsideScratchRoot(root, path.dirname(root)),
    /outside the disposable lifecycle root/iu
  );
  assert.throws(
    () => continuation.resolvePathInsideScratchRoot(root, prefixSibling),
    /outside the disposable lifecycle root/iu
  );
});

function checksumPayload(value, checksumKey = 'checksum') {
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== checksumKey));
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function publicOperation(jobId = JOB_ID, serverId = INSTANCE_ID, overrides = {}) {
  const record = {
    type: 'minecraft-core-modpack-job',
    schemaVersion: 1,
    sequence: 7,
    jobId,
    operationKind: 'update',
    serverId,
    planFingerprint: 'a'.repeat(64),
    phase: 'committing',
    swapStep: null,
    progress: { percent: 65, message: 'Committing the reviewed changes', currentItem: null },
    cancellationRequested: false,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:01:00.000Z',
    terminalAt: null,
    outcome: null,
    events: [],
    checksum: ''
  };
  Object.assign(record, overrides);
  record.checksum = checksumPayload(record);
  return record;
}

async function makeFixture({ prefix = 'minecraft-core-real-modrinth-crash-recovery-e2e-' } = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-crash-continuation-tests-'));
  const root = await fsp.mkdtemp(path.join(tempRoot, prefix));
  const lifecycle = {
    root,
    scratchLabel: 'modrinth-crash-recovery',
    userDataPath: path.join(root, 'user-data'),
    serverPath: path.join(root, 'server'),
    clientPath: path.join(root, 'client'),
    evidencePath: path.join(root, 'evidence'),
    identityPath: path.join(root, 'real-lifecycle-identity.json'),
    serverHost: '127.0.0.1',
    serverPort: 25591,
    managementPort: 25592
  };
  await Promise.all([
    fsp.mkdir(lifecycle.userDataPath),
    fsp.mkdir(lifecycle.serverPath),
    fsp.mkdir(lifecycle.clientPath),
    fsp.mkdir(lifecycle.evidencePath),
    fsp.writeFile(lifecycle.identityPath, JSON.stringify(IDENTITY), 'utf8')
  ]);
  const initialState = {
    type: 'modpack-state',
    instanceId: INSTANCE_ID,
    modpackManaged: true,
    lifecycleMode: 'managed',
    source: {
      provider: 'modrinth', projectId: 'ca0m6gMz', versionId: INITIAL_VERSION_ID,
      version: 'v1.2-1.20.1', title: 'Server Optimized'
    },
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.15.10', javaMajor: 17 },
    selectedOptionalFiles: [],
    installedAt: '2026-08-29T00:00:00.000Z',
    contentRevision: 1,
    managedFileCount: '42'
  };
  const stateRoot = path.join(lifecycle.serverPath, '.minecraft-core-state');
  await fsp.mkdir(stateRoot);
  await fsp.writeFile(path.join(stateRoot, 'modpack.json'), JSON.stringify({
    schemaVersion: 1,
    modpackManaged: true,
    source: initialState.source,
    runtime: initialState.runtime,
    selectedOptionalFiles: [],
    installedAt: initialState.installedAt,
    contentRevision: initialState.contentRevision,
    manifestId: 'manifest-initial'
  }), 'utf8');
  const dispose = async () => {
    if (typeof continuation.releasePendingCrashRecoveryLease === 'function') {
      await continuation.releasePendingCrashRecoveryLease(root, { tempRoot });
    }
    await fsp.rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
  };
  return { tempRoot, lifecycle, initialState, dispose };
}

async function writeCheckpoint(fixture) {
  assert.equal(typeof continuation.writeCrashRecoveryCheckpoint, 'function');
  const durableWrites = [];
  const checkpoint = await continuation.writeCrashRecoveryCheckpoint(fixture.lifecycle, {
    instanceId: INSTANCE_ID,
    initialState: fixture.initialState,
    initialVersionId: INITIAL_VERSION_ID,
    updateVersionId: UPDATE_VERSION_ID,
    planFingerprint: PLAN_FINGERPRINT
  }, {
    tempRoot: fixture.tempRoot,
    clock: () => new Date('2026-08-29T00:00:00.000Z'),
    reparseInspector: noReparseInspector(),
    durableFs: {
      async writeJsonAtomic(filePath, value, options) {
        durableWrites.push({ filePath, value, options });
        await fsp.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
      }
    }
  });
  assert.equal(durableWrites.length, 3);
  assert.equal(durableWrites[0].filePath, fixture.lifecycle.identityPath);
  assert.deepEqual(durableWrites[0].value, IDENTITY);
  assert.match(durableWrites[0].options.expectedTargetSha256, /^[a-f0-9]{64}$/u);
  assert.equal(durableWrites[1].filePath, path.join(fixture.lifecycle.evidencePath, 'hard-crash-fired.json'));
  assert.deepEqual(durableWrites[1].value, { fired: false, rollbackName: null });
  assert.deepEqual(durableWrites[1].options, { expectedTargetSha256: null });
  assert.equal(durableWrites[2].filePath, path.join(fixture.lifecycle.evidencePath, 'hard-crash-checkpoint.json'));
  assert.deepEqual(durableWrites[2].options, { expectedTargetSha256: null });
  assert.deepEqual(durableWrites[2].value.operation, {
    kind: 'update',
    planFingerprint: PLAN_FINGERPRINT
  });
  return checkpoint;
}

async function armExactCrashFixture(fixture) {
  const paths = createExistingSiblingPaths(fixture.lifecycle.serverPath, JOB_ID);
  const rollbackPath = paths.rollbackPath;
  const candidatePath = paths.candidatePath;
  const failedPath = paths.failedPath;
  const rollbackName = path.basename(rollbackPath);
  await fsp.mkdir(path.join(candidatePath, '.minecraft-core-state', 'operations', JOB_ID), { recursive: true });
  await fsp.writeFile(path.join(candidatePath, '.minecraft-core-state', 'modpack.json'), JSON.stringify({
    schemaVersion: 1,
    modpackManaged: true,
    source: {
      provider: 'modrinth', projectId: 'ca0m6gMz', versionId: UPDATE_VERSION_ID,
      version: 'v2-1.20.1', title: 'Server Optimized'
    },
    runtime: fixture.initialState.runtime,
    selectedOptionalFiles: [],
    installedAt: '2026-08-29T00:01:00.000Z',
    contentRevision: fixture.initialState.contentRevision + 1,
    manifestId: 'manifest-update'
  }), 'utf8');
  await fsp.rename(fixture.lifecycle.serverPath, rollbackPath);
  await fsp.writeFile(path.join(fixture.lifecycle.evidencePath, 'hard-crash-fired.json'), JSON.stringify({
    fired: true,
    rollbackName
  }), 'utf8');

  const activePath = path.join(fixture.lifecycle.userDataPath, 'modpack-lifecycle', 'active');
  const operationsPath = path.join(fixture.lifecycle.userDataPath, 'modpack-lifecycle', 'operations');
  await Promise.all([fsp.mkdir(activePath, { recursive: true }), fsp.mkdir(operationsPath, { recursive: true })]);
  const recovery = {
    schemaVersion: 2,
    sequence: 10,
    jobId: JOB_ID,
    operationKind: 'upgrade',
    target: { kind: 'existing', stableServerId: INSTANCE_ID, path: fixture.lifecycle.serverPath },
    candidatePath,
    rollbackPath,
    failedPath,
    restorePoint: { id: 'restore-crash', sha256: 'b'.repeat(64) },
    journalPath: path.join(candidatePath, '.minecraft-core-state', 'operations', JOB_ID, 'journal.json'),
    priorRuntime: { running: false, autoRestart: false },
    phase: 'committing',
    swapStep: 'prepared',
    directoryIdentities: {
      target: { volumeSerial: 'aa', fileId: '01' },
      candidate: { volumeSerial: 'aa', fileId: '02' },
      rollback: null,
      failed: null
    },
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:01:00.000Z',
    outcome: {
      live: { fingerprint: '1'.repeat(64) },
      candidate: { fingerprint: '2'.repeat(64) },
      rollback: { fingerprint: '1'.repeat(64) },
      revision: { source: 1, target: 2 }
    },
    restoreCreation: null
  };
  const envelope = createRecoveryTargetEnvelope(recovery);
  await Promise.all([
    fsp.writeFile(path.join(activePath, `${JOB_ID}.json`), JSON.stringify(recovery), 'utf8'),
    fsp.writeFile(path.join(activePath, `${JOB_ID}.target.json`), JSON.stringify(envelope), 'utf8'),
    fsp.writeFile(path.join(operationsPath, `${JOB_ID}.json`), JSON.stringify(publicOperation()), 'utf8')
  ]);
  return { rollbackName, rollbackPath, candidatePath };
}

function noReparseInspector() {
  return { async isReparsePoint() { return false; }, close() {} };
}

test('crash checkpoint is durable and discovers the exact post-rename lifecycle after a runner restart', async () => {
  assert.equal(typeof continuation.discoverCrashRecoveryContinuation, 'function');
  const fixture = await makeFixture();
  try {
    const checkpoint = await writeCheckpoint(fixture);
    await armExactCrashFixture(fixture);

    const result = await continuation.discoverCrashRecoveryContinuation({
      tempRoot: fixture.tempRoot,
      processes: [],
      reparseInspector: noReparseInspector()
    });

    assert.equal(result.lifecycle.root, fixture.lifecycle.root);
    assert.equal(result.lifecycle.instanceId, INSTANCE_ID);
    assert.equal(result.lifecycle.crashedJobId, JOB_ID);
    assert.equal(result.lifecycle.serverPort, fixture.lifecycle.serverPort);
    assert.deepEqual(result.lifecycle.initialState, fixture.initialState);
    assert.equal(result.lifecycle.checkpoint.checksum, checkpoint.checksum);
    assert.equal(result.lifecycle.resumed, true);
    await result.lifecycle.dispose();
    assert.equal(await fsp.stat(fixture.lifecycle.root).then(() => true, () => false), true);
  } finally {
    await fixture.dispose();
  }
});

test('crash continuation fails closed and preserves a matching root when its checkpoint is missing', async () => {
  assert.equal(typeof continuation.discoverCrashRecoveryContinuation, 'function');
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      continuation.discoverCrashRecoveryContinuation({
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /checkpoint is missing/iu
    );
    assert.equal(await fsp.stat(fixture.lifecycle.root).then(() => true, () => false), true);
  } finally {
    await fixture.dispose();
  }
});

test('crash continuation fails closed on checkpoint identity mismatch and on a root-bound process', async () => {
  assert.equal(typeof continuation.loadCrashRecoveryContinuation, 'function');
  const fixture = await makeFixture();
  try {
    await writeCheckpoint(fixture);
    await armExactCrashFixture(fixture);
    const checkpointPath = path.join(fixture.lifecycle.evidencePath, 'hard-crash-checkpoint.json');
    const originalCheckpoint = await fsp.readFile(checkpointPath, 'utf8');
    const tampered = JSON.parse(originalCheckpoint);
    tampered.instance.id = 'server-mismatched';
    await fsp.writeFile(checkpointPath, JSON.stringify(tampered), 'utf8');
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /checkpoint checksum/iu
    );

    await fsp.writeFile(checkpointPath, originalCheckpoint, 'utf8');
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [{ Name: 'electron.exe', ProcessId: 42, CommandLine: `electron . --user-data-dir=${fixture.lifecycle.root}` }],
        reparseInspector: noReparseInspector()
      }),
      /root-bound Electron or Java process/iu
    );
  } finally {
    await fixture.dispose();
  }
});

test('crash continuation rejects missing, mismatched, or replaced lifecycle identity without deleting the root', async () => {
  assert.equal(typeof continuation.loadCrashRecoveryContinuation, 'function');
  const fixture = await makeFixture();
  try {
    await writeCheckpoint(fixture);
    await armExactCrashFixture(fixture);
    const originalIdentity = await fsp.readFile(fixture.lifecycle.identityPath, 'utf8');

    await fsp.writeFile(fixture.lifecycle.identityPath, JSON.stringify({
      provider: 'modrinth', scenario: 'different-scenario'
    }), 'utf8');
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /lifecycle identity/iu
    );

    await fsp.rm(fixture.lifecycle.identityPath);
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /lifecycle identity.*missing/iu
    );
    assert.equal(await fsp.stat(fixture.lifecycle.root).then(() => true, () => false), true);
    await fsp.writeFile(fixture.lifecycle.identityPath, originalIdentity, 'utf8');
  } finally {
    await fixture.dispose();
  }
});

test('crash continuation binds the checkpoint to the same root object and exact crash job lineage', async () => {
  assert.equal(typeof continuation.loadCrashRecoveryContinuation, 'function');
  const fixture = await makeFixture();
  try {
    await writeCheckpoint(fixture);
    await armExactCrashFixture(fixture);
    const checkpointPath = path.join(fixture.lifecycle.evidencePath, 'hard-crash-checkpoint.json');
    const originalCheckpoint = await fsp.readFile(checkpointPath, 'utf8');
    const replacedRoot = JSON.parse(originalCheckpoint);
    replacedRoot.rootIdentity.ino = String(BigInt(replacedRoot.rootIdentity.ino) + 1n);
    replacedRoot.checksum = checksumPayload(replacedRoot);
    await fsp.writeFile(checkpointPath, JSON.stringify(replacedRoot), 'utf8');
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /root identity/iu
    );

    await fsp.writeFile(checkpointPath, originalCheckpoint, 'utf8');
    const recoveryPath = path.join(
      fixture.lifecycle.userDataPath, 'modpack-lifecycle', 'active', `${JOB_ID}.json`
    );
    const originalRecovery = await fsp.readFile(recoveryPath, 'utf8');
    const runningRecovery = JSON.parse(originalRecovery);
    runningRecovery.priorRuntime.running = true;
    await fsp.writeFile(recoveryPath, JSON.stringify(runningRecovery), 'utf8');
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /exact prepared update checkpoint/iu
    );

    await fsp.writeFile(recoveryPath, originalRecovery, 'utf8');
    const markerPath = path.join(fixture.lifecycle.evidencePath, 'hard-crash-fired.json');
    await fsp.writeFile(markerPath, JSON.stringify({
      fired: true,
      rollbackName: '.server.minecraft-core.job-different.rollback'
    }), 'utf8');
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /post-crash .*topology|lineage/iu
    );
    assert.equal(await fsp.stat(fixture.lifecycle.root).then(() => true, () => false), true);
  } finally {
    await fixture.dispose();
  }
});

test('crash continuation binds rollback, candidate, and reviewed-plan semantics to the checkpoint', async () => {
  assert.equal(typeof continuation.loadCrashRecoveryContinuation, 'function');
  const fixture = await makeFixture();
  try {
    await writeCheckpoint(fixture);
    const crash = await armExactCrashFixture(fixture);
    const rollbackStatePath = path.join(crash.rollbackPath, '.minecraft-core-state', 'modpack.json');
    const candidateStatePath = path.join(crash.candidatePath, '.minecraft-core-state', 'modpack.json');
    const operationPath = path.join(
      fixture.lifecycle.userDataPath, 'modpack-lifecycle', 'operations', `${JOB_ID}.json`
    );
    const rollbackState = JSON.parse(await fsp.readFile(rollbackStatePath, 'utf8'));
    const candidateState = JSON.parse(await fsp.readFile(candidateStatePath, 'utf8'));
    const operation = JSON.parse(await fsp.readFile(operationPath, 'utf8'));

    await fsp.writeFile(rollbackStatePath, JSON.stringify({
      ...rollbackState,
      source: { ...rollbackState.source, versionId: 'rollback-tampered' }
    }), 'utf8');
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /rollback state/iu
    );

    await fsp.writeFile(rollbackStatePath, JSON.stringify(rollbackState), 'utf8');
    await fsp.writeFile(candidateStatePath, JSON.stringify({
      ...candidateState,
      source: { ...candidateState.source, versionId: 'candidate-tampered' }
    }), 'utf8');
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /candidate state/iu
    );

    await fsp.writeFile(candidateStatePath, JSON.stringify(candidateState), 'utf8');
    const changedOperation = { ...operation, planFingerprint: 'c'.repeat(64), checksum: '' };
    changedOperation.checksum = checksumPayload(changedOperation);
    await fsp.writeFile(operationPath, JSON.stringify(changedOperation), 'utf8');
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, {
        tempRoot: fixture.tempRoot,
        processes: [],
        reparseInspector: noReparseInspector()
      }),
      /reviewed plan/iu
    );
  } finally {
    await fixture.dispose();
  }
});

test('crash continuation grants one auto-reclaimable exclusive lease for an exact preserved root', async () => {
  assert.equal(typeof continuation.loadCrashRecoveryContinuation, 'function');
  const fixture = await makeFixture();
  let first = null;
  let third = null;
  try {
    const checkpoint = await writeCheckpoint(fixture);
    assert.deepEqual(checkpoint.lease, {
      kind: 'process-bound-local-endpoint-v1',
      id: checkpoint.lease.id
    });
    assert.match(checkpoint.lease.id, /^[a-f0-9]{64}$/u);
    await armExactCrashFixture(fixture);
    const options = {
      tempRoot: fixture.tempRoot,
      processes: [],
      reparseInspector: noReparseInspector()
    };

    first = await continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, options);
    await assert.rejects(
      continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, options),
      /continuation lease is already held or unavailable/iu
    );

    await first.dispose();
    first = null;
    third = await continuation.loadCrashRecoveryContinuation(fixture.lifecycle.root, options);
    assert.equal(third.root, fixture.lifecycle.root);
  } finally {
    if (first) await first.dispose();
    if (third) await third.dispose();
    await fixture.dispose();
  }
});

test('durable checkpoint continuously holds its exclusive claim before the deliberate crash', async () => {
  assert.equal(typeof continuation.continuationLeaseEndpoint, 'function');
  assert.equal(typeof continuation.releasePendingCrashRecoveryLease, 'function');
  const fixture = await makeFixture();
  try {
    const checkpoint = await writeCheckpoint(fixture);
    const endpoint = continuation.continuationLeaseEndpoint(checkpoint.lease.id);
    const competing = net.createServer();
    competing.unref();
    await assert.rejects(
      new Promise((resolve, reject) => {
        competing.once('error', reject);
        competing.listen({ path: endpoint, exclusive: true }, resolve);
      }),
      error => error?.code === 'EADDRINUSE'
    );
    assert.equal(competing.listening, false);
  } finally {
    await fixture.dispose();
  }
});

test('application-close wait clears its timer after both close and timeout', async () => {
  assert.equal(typeof continuation.waitForApplicationClose, 'function');
  let resolveClose;
  let timeoutCallback;
  const cleared = [];
  const closeWaits = [];
  const closePromise = new Promise(resolve => { resolveClose = resolve; });
  const waiting = continuation.waitForApplicationClose({
    waitForEvent(eventName, options) {
      closeWaits.push({ eventName, options });
      return closePromise;
    }
  }, 1234, {
    setTimeoutFn(callback) { timeoutCallback = callback; return 91; },
    clearTimeoutFn(value) { cleared.push(value); }
  });
  resolveClose();
  await waiting;
  assert.deepEqual(closeWaits, [{ eventName: 'close', options: { timeout: 0 } }]);
  assert.deepEqual(cleared, [91]);

  cleared.length = 0;
  const timedOut = continuation.waitForApplicationClose({ waitForEvent: () => new Promise(() => {}) }, 1234, {
    setTimeoutFn(callback) { timeoutCallback = callback; return 92; },
    clearTimeoutFn(value) { cleared.push(value); }
  });
  timeoutCallback();
  await assert.rejects(timedOut, /did not crash/iu);
  assert.deepEqual(cleared, [92]);
});

async function makeLegacyFixture() {
  const fixture = await makeFixture();
  await fsp.rm(fixture.lifecycle.serverPath, { recursive: true, force: true });
  const legacyPaths = createSiblingPaths(fixture.lifecycle.serverPath, LEGACY_JOB_ID);
  const candidatePath = legacyPaths.candidatePath;
  const failedPath = legacyPaths.failedPath;
  await fsp.mkdir(candidatePath);
  const activePath = path.join(fixture.lifecycle.userDataPath, 'modpack-lifecycle', 'active');
  const operationsPath = path.join(fixture.lifecycle.userDataPath, 'modpack-lifecycle', 'operations');
  await Promise.all([fsp.mkdir(activePath, { recursive: true }), fsp.mkdir(operationsPath, { recursive: true })]);
  const recovery = {
    schemaVersion: 1,
    sequence: 3,
    jobId: LEGACY_JOB_ID,
    operationKind: 'install',
    target: { kind: 'new', stableServerId: INSTANCE_ID, path: fixture.lifecycle.serverPath },
    candidatePath,
    rollbackPath: null,
    failedPath,
    restorePoint: null,
    journalPath: path.join(candidatePath, '.minecraft-core-state', 'operations', LEGACY_JOB_ID, 'journal.json'),
    priorRuntime: { running: false, autoRestart: false },
    phase: 'validating-candidate',
    swapStep: 'none',
    directoryIdentities: {
      target: null,
      candidate: { volumeSerial: 'aa', fileId: '02' },
      rollback: null,
      failed: null
    },
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:01:00.000Z',
    outcome: { reservation: { kind: 'empty-directory' } }
  };
  await Promise.all([
    fsp.writeFile(path.join(activePath, `${LEGACY_JOB_ID}.json`), JSON.stringify(recovery), 'utf8'),
    fsp.writeFile(path.join(activePath, `${LEGACY_JOB_ID}.target.json`), JSON.stringify(createRecoveryTargetEnvelope(recovery)), 'utf8'),
    fsp.writeFile(path.join(operationsPath, `${LEGACY_JOB_ID}.json`), JSON.stringify(publicOperation(LEGACY_JOB_ID, INSTANCE_ID, {
      operationKind: 'install-new',
      phase: 'failed',
      progress: { percent: 35, message: 'Building the server candidate', currentItem: null },
      terminalAt: '2026-08-29T00:02:00.000Z',
      outcome: {
        status: 'failed',
        message: 'The operation failed before the server changed',
        errorCode: 'COMMIT_FAILED',
        cleanupPending: false,
        retainedDownload: true,
        actions: []
      }
    })), 'utf8')
  ]);
  return fixture;
}

test('known abandoned pre-checkpoint root is deleted only for exact legacy topology with zero bound processes', async () => {
  assert.equal(typeof continuation.cleanupAbandonedCrashRecoveryRoots, 'function');
  const fixture = await makeLegacyFixture();
  try {
    const result = await continuation.cleanupAbandonedCrashRecoveryRoots({
      tempRoot: fixture.tempRoot,
      processes: [],
      reparseInspector: noReparseInspector()
    });
    assert.deepEqual(result.removed, [fixture.lifecycle.root]);
    assert.deepEqual(result.preserved, []);
    assert.equal(await fsp.stat(fixture.lifecycle.root).then(() => true, () => false), false);
  } finally {
    await fixture.dispose();
  }
});

test('legacy cleanup reports and preserves topology mismatch or any root-bound process', async () => {
  assert.equal(typeof continuation.cleanupAbandonedCrashRecoveryRoots, 'function');
  const topology = await makeLegacyFixture();
  try {
    await fsp.writeFile(path.join(topology.lifecycle.root, 'unexpected.txt'), 'preserve', 'utf8');
    const report = await continuation.cleanupAbandonedCrashRecoveryRoots({
      tempRoot: topology.tempRoot,
      processes: [],
      reparseInspector: noReparseInspector()
    });
    assert.equal(report.removed.length, 0);
    assert.equal(report.preserved.length, 1);
    assert.match(report.preserved[0].reason, /topology/iu);
    assert.equal(await fsp.stat(topology.lifecycle.root).then(() => true, () => false), true);
  } finally {
    await topology.dispose();
  }

  const active = await makeLegacyFixture();
  try {
    const report = await continuation.cleanupAbandonedCrashRecoveryRoots({
      tempRoot: active.tempRoot,
      processes: [{ Name: 'java.exe', ProcessId: 99, CommandLine: `java -jar ${active.lifecycle.root}\\server.jar` }],
      reparseInspector: noReparseInspector()
    });
    assert.equal(report.removed.length, 0);
    assert.equal(report.preserved.length, 1);
    assert.match(report.preserved[0].reason, /root-bound Electron or Java process/iu);
  } finally {
    await active.dispose();
  }
});
