const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');

function temporaryRoot(t, prefix = 'minecraft-core-new-publication-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function code(expected) {
  return error => error && error.code === expected;
}

const noReparse = Object.freeze({
  async isReparsePoint() { return false; }
});

function nativeDurability() {
  return {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    flushDirectory() {}
  };
}

function durableFixture(t) {
  const root = temporaryRoot(t);
  let temporary = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: nativeDurability(),
    allowedRoots: [root],
    tempNameFactory: () => `publication-${++temporary}`
  });
  return { durableFs, root };
}

const RUNTIME = Object.freeze({
  minecraftVersion: '1.21.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 21,
  os: 'win32',
  architecture: 'x64'
});

async function transactionFixture(t, options = {}) {
  const { createSiblingPaths } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const { durableFs, root } = durableFixture(t);
  const serverParent = path.join(root, 'servers');
  fs.mkdirSync(serverParent);
  const targetPath = path.join(serverParent, options.targetName || 'server');
  const paths = createSiblingPaths(targetPath, options.jobId || 'job-transaction');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(userDataPath);
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const clock = () => new Date(now += 1000);
  const recoveryRegistry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs,
    clock,
    randomUUID: () => '00000000-0000-4000-8000-000000000020'
  });
  await recoveryRegistry.initialize();
  const jobId = options.jobId || 'job-transaction';
  const stableInstanceId = options.stableInstanceId || 'server-transaction';
  await recoveryRegistry.create({
    schemaVersion: 1,
    sequence: 0,
    jobId,
    operationKind: options.operationKind || 'install',
    target: { kind: 'new', stableServerId: stableInstanceId, path: targetPath },
    candidatePath: paths.candidatePath,
    rollbackPath: null,
    failedPath: paths.failedPath,
    restorePoint: null,
    journalPath: null,
    priorRuntime: { running: false, autoRestart: false },
    phase: 'queued',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    outcome: null
  });
  await recoveryRegistry.transition(jobId, {
    expectedPhase: 'queued', nextPhase: 'preflight', patch: {
      ...(options.initialOutcome ? { outcome: options.initialOutcome } : {})
    }
  });
  const calls = [];
  const mutationLease = Object.freeze({
    kind: 'mutation',
    operation: 'modpack-install',
    operationId: jobId,
    instanceId: stableInstanceId,
    serverPath: targetPath,
    baseRevision: 0,
    assertOwnedPath(candidate) { return candidate; },
    markDirty() { calls.push('lease:dirty'); return true; },
    release() { return false; }
  });
  const healthValidator = {
    async validateCandidate(request) {
      calls.push('health');
      if (options.healthError) throw options.healthError;
      assert.equal(request.candidatePath, paths.candidatePath);
      assert.equal(request.mutationLease, mutationLease);
      return Object.freeze({ ok: true, kind: 'candidate', durationMs: 1 });
    }
  };
  const context = {
    targetPath,
    jobId,
    operationKind: options.operationKind || 'install',
    stableInstanceId,
    durableFs,
    fsApi: fs,
    reparseInspector: noReparse,
    recoveryRegistry,
    mutationLease,
    plan: Object.freeze({ type: 'test-plan' }),
    currentSnapshot: Object.freeze({ type: 'test-snapshot' }),
    planValidator(plan, snapshot) {
      calls.push('plan');
      assert.equal(plan.type, 'test-plan');
      assert.equal(snapshot.type, 'test-snapshot');
      return plan;
    },
    async materializeCandidate({ candidatePath }) {
      calls.push('materialize');
      fs.writeFileSync(path.join(candidatePath, 'server.jar'), 'server bytes');
      fs.writeFileSync(path.join(candidatePath, 'server.properties'), 'motd=Pack\n');
      if (typeof options.afterMaterialize === 'function') options.afterMaterialize(candidatePath);
    },
    stateRepository: {
      writeCandidate(candidatePath) {
        calls.push('state');
        fs.writeFileSync(path.join(candidatePath, '.minecraft-core.json'), JSON.stringify({ contentRevision: 1 }));
        fs.writeFileSync(
          path.join(candidatePath, '.minecraft-core-state', 'modpack.json'),
          JSON.stringify({ schemaVersion: 1, modpackManaged: true, contentRevision: 1 })
        );
        return Object.freeze({ contentRevision: 1 });
      }
    },
    candidateState: Object.freeze({ contentRevision: 1 }),
    healthValidator,
    runtime: RUNTIME,
    maxRam: 8,
    healthTimeoutMs: 30000,
    signal: undefined,
    clock
  };
  if (options.persistCandidateState) context.persistCandidateState = options.persistCandidateState;
  if (options.validateCandidate === false) {
    context.validateCandidate = false;
    context.runtime = null;
  }
  return { calls, context, durableFs, paths, recoveryRegistry, root, serverParent, stableInstanceId, targetPath };
}

test('new publication never adopts a pre-existing target', async (t) => {
  const root = temporaryRoot(t, 'minecraft-core-new-publication-red-');
  const targetPath = path.join(root, 'server');
  fs.mkdirSync(targetPath);

  await assert.rejects(
    async () => {
      const { publishNewCandidate } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
      return publishNewCandidate({ targetPath });
    },
    error => error && error.code === 'TARGET_EXISTS'
  );
});

test('sibling paths are deterministic, exclusive names on the target volume', () => {
  const { createSiblingPaths } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const targetPath = 'C:\\Minecraft\\Servers\\Terra Firma';
  const paths = createSiblingPaths(targetPath, 'job-0001');
  assert.deepEqual(paths, {
    targetPath,
    candidatePath: 'C:\\Minecraft\\Servers\\.Terra Firma.minecraft-core.job-0001.candidate',
    failedPath: 'C:\\Minecraft\\Servers\\.Terra Firma.minecraft-core.job-0001.failed'
  });
  assert.equal(Object.isFrozen(paths), true);
  assert.throws(() => createSiblingPaths('C:\\Minecraft\\Servers\\Cafe\u0301', 'job-0001'), code('INVALID_REQUEST'));
  assert.throws(() => createSiblingPaths('C:\\Minecraft\\Servers\\..\\Escape', 'job-0001'), code('INVALID_REQUEST'));
  assert.throws(() => createSiblingPaths(targetPath, '../escape'), code('INVALID_REQUEST'));
});

test('directory identity is stable, hex-only, and revalidated by object identity', async (t) => {
  const {
    assertServerDirectoryIdentity,
    identifyServerDirectory
  } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
  const root = temporaryRoot(t);
  const serverPath = path.join(root, 'candidate');
  fs.mkdirSync(serverPath);
  const identity = await identifyServerDirectory(serverPath, { reparseInspector: noReparse });
  assert.match(identity.volumeSerial, /^[a-f0-9]+$/);
  assert.match(identity.fileId, /^[a-f0-9]+$/);
  assert.equal(Object.isFrozen(identity), true);
  assert.deepEqual(
    await assertServerDirectoryIdentity(serverPath, identity, { reparseInspector: noReparse }),
    identity
  );

  fs.renameSync(serverPath, `${serverPath}-old`);
  fs.mkdirSync(serverPath);
  await assert.rejects(
    assertServerDirectoryIdentity(serverPath, identity, { reparseInspector: noReparse }),
    code('RECOVERY_REQUIRED')
  );
});

test('directory identity and no-follow tree inspection reject links, reparses, and hardlinks', async (t) => {
  const {
    identifyServerDirectory,
    inspectServerDirectoryTree
  } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
  const root = temporaryRoot(t);
  const serverPath = path.join(root, 'candidate');
  fs.mkdirSync(serverPath);
  fs.writeFileSync(path.join(serverPath, 'server.jar'), 'server');

  const symlinkPath = path.join(root, 'server-link');
  try {
    fs.symlinkSync(serverPath, symlinkPath, 'junction');
    await assert.rejects(
      identifyServerDirectory(symlinkPath, { reparseInspector: noReparse }),
      code('UNSAFE_ARCHIVE_ENTRY')
    );
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
  }

  await assert.rejects(
    inspectServerDirectoryTree(serverPath, {
      reparseInspector: { async isReparsePoint(candidate) { return candidate.endsWith('server.jar'); } }
    }),
    code('UNSAFE_ARCHIVE_ENTRY')
  );

  const hardlinkPath = path.join(serverPath, 'server-copy.jar');
  fs.linkSync(path.join(serverPath, 'server.jar'), hardlinkPath);
  await assert.rejects(
    inspectServerDirectoryTree(serverPath, { reparseInspector: noReparse }),
    code('UNSAFE_ARCHIVE_ENTRY')
  );
});

test('operation journal is checksummed, compare-and-set, and contains no raw target path', async (t) => {
  const {
    OperationJournal,
    createDirectoryMarker,
    createTargetAbsenceEvidence,
    verifyDirectoryMarker
  } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
  const { durableFs, root } = durableFixture(t);
  const candidatePath = path.join(root, 'candidate');
  const operationPath = path.join(candidatePath, '.minecraft-core-state', 'operations', 'job-0001');
  const journalPath = path.join(operationPath, 'journal.json');
  fs.mkdirSync(operationPath, { recursive: true });
  const identity = { volumeSerial: '1a', fileId: '2b' };
  const marker = createDirectoryMarker({
    jobId: 'job-0001',
    operationKind: 'install',
    stableInstanceId: 'server-0001',
    createdAt: '2026-08-01T00:00:00.000Z'
  });
  assert.equal(verifyDirectoryMarker(marker).stableInstanceId, 'server-0001');
  const markerSha256 = marker.checksum;
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const journal = new OperationJournal({
    durableFs,
    fsApi: fs,
    clock: () => new Date(now += 1000)
  });
  const created = journal.create(journalPath, {
    jobId: 'job-0001',
    operationKind: 'install',
    stableInstanceId: 'server-0001',
    targetPath: path.join(root, 'server'),
    candidateIdentity: identity,
    markerSha256
  });
  assert.equal(created.phase, 'staging');
  assert.equal(created.sequence, 0);
  assert.equal(Object.isFrozen(created), true);
  const persisted = fs.readFileSync(journalPath, 'utf8');
  assert.equal(persisted.includes(root), false);
  assert.equal(persisted.includes('server\\'), false);

  const absence = await createTargetAbsenceEvidence(path.join(root, 'server'), identity, {
    clock: () => new Date('2026-08-01T00:00:03.000Z')
  });
  const publishing = journal.transition(journalPath, {
    expectedPhase: 'staging',
    nextPhase: 'publishing',
    patch: {
      swapStep: 'new-prepared',
      targetAbsence: absence
    }
  });
  assert.equal(publishing.sequence, 1);
  assert.equal(publishing.targetAbsence.targetPathHash, created.targetPathHash);
  assert.deepEqual(journal.load(journalPath), publishing);
  assert.throws(
    () => journal.transition(journalPath, {
      expectedPhase: 'staging', nextPhase: 'published', patch: { swapStep: 'candidate-published' }
    }),
    code('PLAN_STALE')
  );
});

test('operation journal write failure preserves the last durable phase', (t) => {
  const { OperationJournal } = require('../../electron/services/modpack-lifecycle/operation-journal.cjs');
  const { durableFs: base, root } = durableFixture(t);
  const operationPath = path.join(root, 'candidate', '.minecraft-core-state', 'operations', 'job-0002');
  const journalPath = path.join(operationPath, 'journal.json');
  fs.mkdirSync(operationPath, { recursive: true });
  let fail = false;
  const durableFs = {
    ...base,
    writeJsonAtomic(filePath, value, options) {
      if (fail) throw Object.assign(new Error('injected'), { code: 'COMMIT_FAILED' });
      return base.writeJsonAtomic(filePath, value, options);
    }
  };
  const journal = new OperationJournal({
    durableFs,
    fsApi: fs,
    clock: () => new Date('2026-08-01T00:00:00.000Z')
  });
  journal.create(journalPath, {
    jobId: 'job-0002', operationKind: 'install', stableInstanceId: 'server-0002',
    targetPath: path.join(root, 'server'), candidateIdentity: { volumeSerial: '1', fileId: '2' },
    markerSha256: 'a'.repeat(64)
  });
  fail = true;
  assert.throws(
    () => journal.transition(journalPath, {
      expectedPhase: 'staging', nextPhase: 'publishing', patch: { swapStep: 'new-prepared' }
    }),
    code('COMMIT_FAILED')
  );
  fail = false;
  assert.equal(journal.load(journalPath).phase, 'staging');
});

test('instance registration binds the verified published identity and is retry-idempotent', async (t) => {
  const { InstanceRegistry } = require('../../electron/services/modpack-lifecycle/instance-registry.cjs');
  const root = temporaryRoot(t);
  const targetPath = path.join(root, 'server');
  fs.mkdirSync(targetPath);
  const instances = [];
  const updates = [];
  const ownershipChecks = [];
  const appStore = {
    get(key) { assert.equal(key, 'instances'); return structuredClone(instances); },
    set(key, value) {
      assert.equal(key, 'instances');
      instances.splice(0, instances.length, ...structuredClone(value));
    }
  };
  const registry = new InstanceRegistry({
    appStore,
    instanceContext: { updateInstances(value) { updates.push(structuredClone(value)); } },
    async verifyOwnership(request) {
      ownershipChecks.push(request);
      return Object.freeze({
        targetPath,
        directoryIdentity: { volumeSerial: '1a', fileId: '2b' },
        jobId: 'job-0003',
        stableInstanceId: 'server-0003'
      });
    }
  });
  const request = {
    jobId: 'job-0003',
    stableInstanceId: 'server-0003',
    name: 'Terra Firma',
    targetPath,
    directoryIdentity: { volumeSerial: '1a', fileId: '2b' }
  };
  const first = await registry.registerPublishedInstance(request);
  const second = await registry.registerPublishedInstance(request);
  assert.deepEqual(first, { instanceId: 'server-0003', name: 'Terra Firma', type: 'server' });
  assert.deepEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(JSON.stringify(first).includes(root), false);
  assert.equal(ownershipChecks.length, 2);
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0], {
    id: 'server-0003', name: 'Terra Firma', type: 'server', path: targetPath
  });
  assert.equal(updates.length, 2);
});

test('instance registration rejects identity/path aliases and never mutates on failed ownership', async (t) => {
  const { InstanceRegistry } = require('../../electron/services/modpack-lifecycle/instance-registry.cjs');
  const root = temporaryRoot(t);
  const targetPath = path.join(root, 'server');
  fs.mkdirSync(targetPath);
  const instances = [{ id: 'other-server', name: 'Other', type: 'server', path: targetPath.toLocaleUpperCase('en-US') }];
  let updates = 0;
  const appStore = {
    get() { return structuredClone(instances); },
    set(_key, value) { instances.splice(0, instances.length, ...structuredClone(value)); }
  };
  const common = {
    appStore,
    instanceContext: { updateInstances() { updates += 1; } }
  };
  const request = {
    jobId: 'job-0004', stableInstanceId: 'server-0004', name: 'Server', targetPath,
    directoryIdentity: { volumeSerial: '1', fileId: '2' }
  };
  const conflicting = new InstanceRegistry({
    ...common,
    async verifyOwnership() {
      return {
        jobId: request.jobId,
        stableInstanceId: request.stableInstanceId,
        targetPath: request.targetPath,
        directoryIdentity: request.directoryIdentity
      };
    }
  });
  await assert.rejects(conflicting.registerPublishedInstance(request), code('TARGET_EXISTS'));
  assert.equal(instances.length, 1);
  assert.equal(updates, 0);

  const rejected = new InstanceRegistry({
    ...common,
    async verifyOwnership() { throw Object.assign(new Error('changed'), { code: 'RECOVERY_REQUIRED' }); }
  });
  await assert.rejects(rejected.registerPublishedInstance(request), code('RECOVERY_REQUIRED'));
  assert.equal(instances.length, 1);
  assert.equal(updates, 0);
});

test('instance registration rejects duplicate persisted ID or path aliases', async (t) => {
  const { InstanceRegistry } = require('../../electron/services/modpack-lifecycle/instance-registry.cjs');
  const root = temporaryRoot(t);
  const targetPath = path.join(root, 'server');
  fs.mkdirSync(targetPath);
  const instances = [
    { id: 'server-duplicate', name: 'Server', type: 'server', path: targetPath },
    { id: 'other-id', name: 'Alias', type: 'server', path: targetPath.toLocaleUpperCase('en-US') }
  ];
  let updates = 0;
  const registry = new InstanceRegistry({
    appStore: { get() { return structuredClone(instances); }, set() { throw new Error('must not write'); } },
    instanceContext: { updateInstances() { updates += 1; } },
    async verifyOwnership() {
      return {
        jobId: 'job-duplicate', stableInstanceId: 'server-duplicate', targetPath,
        directoryIdentity: { volumeSerial: '1', fileId: '2' }
      };
    }
  });
  await assert.rejects(registry.registerPublishedInstance({
    jobId: 'job-duplicate', stableInstanceId: 'server-duplicate', name: 'Server', targetPath,
    directoryIdentity: { volumeSerial: '1', fileId: '2' }
  }), code('TARGET_EXISTS'));
  assert.equal(updates, 0);
});

test('post-store context failure is retryable without creating a second instance', async (t) => {
  const { InstanceRegistry } = require('../../electron/services/modpack-lifecycle/instance-registry.cjs');
  const root = temporaryRoot(t);
  const targetPath = path.join(root, 'server');
  fs.mkdirSync(targetPath);
  let instances = [];
  let failContext = true;
  const registry = new InstanceRegistry({
    appStore: {
      get() { return structuredClone(instances); },
      set(_key, value) { instances = structuredClone(value); }
    },
    instanceContext: {
      updateInstances() {
        if (failContext) throw new Error('injected context failure');
      }
    },
    async verifyOwnership() {
      return {
        jobId: 'job-0005', stableInstanceId: 'server-0005', targetPath,
        directoryIdentity: { volumeSerial: '1', fileId: '2' }
      };
    }
  });
  const request = {
    jobId: 'job-0005', stableInstanceId: 'server-0005', name: 'Server', targetPath,
    directoryIdentity: { volumeSerial: '1', fileId: '2' }
  };
  await assert.rejects(registry.registerPublishedInstance(request), code('COMMIT_FAILED'));
  assert.equal(instances.length, 1);
  failContext = false;
  assert.equal((await registry.registerPublishedInstance(request)).instanceId, 'server-0005');
  assert.equal(instances.length, 1);
});

test('build, publish, and register form one durable new-server transaction without erasing preflight authority', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate,
    registerPublishedInstance
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    initialOutcome: {
      reservation: { kind: 'absent', parent: { volumeSerial: '1', fileId: '2' } },
      runtimePolicy: { targetRunning: true }
    }
  });
  const built = await buildNewCandidate(fixture.context);
  assert.equal(built.phase, 'committing');
  assert.equal(Object.isFrozen(built), true);
  assert.equal(JSON.stringify(built).includes(fixture.root), false);
  assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
  assert.equal(fs.existsSync(fixture.targetPath), false);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'committing');
  assert.deepEqual(fixture.calls.slice(0, 4), ['plan', 'lease:dirty', 'materialize', 'state']);
  assert.equal(fixture.calls.includes('health'), true);

  const published = await publishNewCandidate(fixture.context);
  assert.equal(published.phase, 'published');
  assert.equal(JSON.stringify(published).includes(fixture.root), false);
  assert.equal(fs.existsSync(fixture.paths.candidatePath), false);
  assert.equal(fs.existsSync(fixture.targetPath), true);
  const publishedRecord = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(publishedRecord.phase, 'published');
  assert.equal(publishedRecord.swapStep, 'candidate-published');
  assert.deepEqual(publishedRecord.directoryIdentities.target, built.directoryIdentity);
  assert.equal(publishedRecord.outcome.runtimePolicy.targetRunning, true);
  assert.equal(publishedRecord.outcome.reservation.kind, 'absent');

  let instances = [];
  const registered = await registerPublishedInstance({
    ...fixture.context,
    name: 'Terra Firma',
    appStore: {
      get() { return structuredClone(instances); },
      set(_key, value) { instances = structuredClone(value); }
    },
    instanceContext: { updateInstances() {} }
  });
  assert.deepEqual(registered, {
    instanceId: fixture.stableInstanceId,
    name: 'Terra Firma',
    type: 'server'
  });
  assert.equal(JSON.stringify(registered).includes(fixture.root), false);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].path, fixture.targetPath);
  const registeredRecord = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(registeredRecord.phase, 'registering');
  assert.equal(registeredRecord.outcome.registration.complete, true);
  assert.equal(registeredRecord.outcome.runtimePolicy.targetRunning, true);
  assert.equal(registeredRecord.outcome.reservation.kind, 'absent');
});

test('candidate validation failure never publishes a target', async (t) => {
  const { buildNewCandidate } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const failure = Object.assign(new Error('candidate unhealthy'), { code: 'HEALTH_CHECK_FAILED' });
  const fixture = await transactionFixture(t, { healthError: failure });
  await assert.rejects(buildNewCandidate(fixture.context), code('HEALTH_CHECK_FAILED'));
  assert.equal(fs.existsSync(fixture.targetPath), false);
  assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'validating-candidate');
});

test('files-only publication persists inactive provenance without inventing or validating a runtime', async (t) => {
  const { buildNewCandidate } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    operationKind: 'import',
    validateCandidate: false,
    persistCandidateState({ candidatePath }) {
      fs.writeFileSync(path.join(candidatePath, '.minecraft-core-state', 'modpack.json'), JSON.stringify({
        modpackManaged: false, lifecycleMode: 'files-only', contentRevision: 1
      }));
      return { state: { contentRevision: 1 } };
    }
  });

  const built = await buildNewCandidate(fixture.context);

  assert.equal(built.phase, 'committing');
  assert.equal(fixture.calls.includes('health'), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixture.paths.candidatePath, '.minecraft-core-state', 'modpack.json'))).lifecycleMode,
    'files-only'
  );
});

test('candidate links and post-validation content mutation fail closed before publication', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const hardlinked = await transactionFixture(t, {
    jobId: 'job-hardlink',
    stableInstanceId: 'server-hardlink',
    afterMaterialize(candidatePath) {
      fs.linkSync(path.join(candidatePath, 'server.jar'), path.join(candidatePath, 'server-copy.jar'));
    }
  });
  await assert.rejects(buildNewCandidate(hardlinked.context), code('UNSAFE_ARCHIVE_ENTRY'));
  assert.equal(fs.existsSync(hardlinked.targetPath), false);

  const changed = await transactionFixture(t, {
    jobId: 'job-changed',
    stableInstanceId: 'server-changed'
  });
  await buildNewCandidate(changed.context);
  fs.appendFileSync(path.join(changed.paths.candidatePath, 'server.jar'), 'changed');
  await assert.rejects(publishNewCandidate(changed.context), code('RECOVERY_REQUIRED'));
  assert.equal(fs.existsSync(changed.targetPath), false);
  assert.equal(fs.existsSync(changed.paths.candidatePath), true);
});

test('a target race at the write-through boundary remains unrelated and blocked', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    jobId: 'job-target-race',
    stableInstanceId: 'server-target-race'
  });
  await buildNewCandidate(fixture.context);
  let renameCalls = 0;
  fixture.context.durableFs = {
    ...fixture.durableFs,
    renameDurable(source, destination, options) {
      renameCalls += 1;
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, 'unrelated.txt'), 'unrelated');
      return fixture.durableFs.renameDurable(source, destination, options);
    }
  };
  await assert.rejects(publishNewCandidate(fixture.context), code('TARGET_EXISTS'));
  assert.equal(renameCalls, 1);
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'unrelated.txt'), 'utf8'), 'unrelated');
  assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.phase, 'publishing');
  assert.equal(record.swapStep, 'new-prepared');
});

test('case and Unicode sibling aliases plus pre-existing failed paths are never reused', async (t) => {
  const { buildNewCandidate } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const caseAlias = await transactionFixture(t, {
    jobId: 'job-case-alias', stableInstanceId: 'server-case-alias'
  });
  fs.mkdirSync(caseAlias.paths.failedPath.toLocaleUpperCase('en-US'));
  await assert.rejects(buildNewCandidate(caseAlias.context), code('TARGET_EXISTS'));
  assert.equal(fs.existsSync(caseAlias.targetPath), false);

  const unicodeAlias = await transactionFixture(t, {
    jobId: 'job-unicode-alias', stableInstanceId: 'server-unicode-alias', targetName: 'Caf\u00e9'
  });
  const decomposedCandidate = unicodeAlias.paths.candidatePath.normalize('NFD');
  assert.notEqual(decomposedCandidate, unicodeAlias.paths.candidatePath);
  try { fs.mkdirSync(decomposedCandidate); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await assert.rejects(buildNewCandidate(unicodeAlias.context), code('TARGET_EXISTS'));
  assert.equal(fs.existsSync(unicodeAlias.targetPath), false);
});

test('target parent substitution between durable planning and candidate creation fails closed', async (t) => {
  const { buildNewCandidate } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    jobId: 'job-parent-change', stableInstanceId: 'server-parent-change'
  });
  const originalRegistry = fixture.recoveryRegistry;
  let substituted = false;
  fixture.context.recoveryRegistry = {
    load: jobId => originalRegistry.load(jobId),
    async transition(jobId, request) {
      const result = await originalRegistry.transition(jobId, request);
      if (!substituted && request.expectedPhase === 'preflight' && request.nextPhase === 'staging') {
        substituted = true;
        fs.renameSync(fixture.serverParent, `${fixture.serverParent}.displaced`);
        fs.mkdirSync(fixture.serverParent);
      }
      return result;
    }
  };
  await assert.rejects(buildNewCandidate(fixture.context), code('RECOVERY_REQUIRED'));
  assert.equal(substituted, true);
  assert.equal(fs.existsSync(fixture.targetPath), false);
});

test('a target appearing after the staging record is durable blocks candidate creation', async (t) => {
  const { buildNewCandidate } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    jobId: 'job-staging-target-race', stableInstanceId: 'server-staging-target-race'
  });
  const originalRegistry = fixture.recoveryRegistry;
  fixture.context.recoveryRegistry = {
    load: jobId => originalRegistry.load(jobId),
    async transition(jobId, request) {
      const result = await originalRegistry.transition(jobId, request);
      if (request.expectedPhase === 'preflight' && request.nextPhase === 'staging') {
        fs.mkdirSync(fixture.targetPath);
        fs.writeFileSync(path.join(fixture.targetPath, 'unrelated.txt'), 'unrelated');
      }
      return result;
    }
  };
  await assert.rejects(buildNewCandidate(fixture.context), code('TARGET_EXISTS'));
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'unrelated.txt'), 'utf8'), 'unrelated');
  assert.equal(fs.existsSync(fixture.paths.candidatePath), false);
});

test('marker replacement and candidate directory substitution are recovery-only states', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const markerChanged = await transactionFixture(t, {
    jobId: 'job-marker-change', stableInstanceId: 'server-marker-change'
  });
  await buildNewCandidate(markerChanged.context);
  const markerPath = path.join(
    markerChanged.paths.candidatePath,
    '.minecraft-core-state', 'operations', markerChanged.context.jobId, 'directory-marker.json'
  );
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  marker.createdAt = '2026-08-02T00:00:00.000Z';
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  await assert.rejects(publishNewCandidate(markerChanged.context), code('RECOVERY_REQUIRED'));
  assert.equal(fs.existsSync(markerChanged.targetPath), false);

  const substituted = await transactionFixture(t, {
    jobId: 'job-directory-change', stableInstanceId: 'server-directory-change'
  });
  await buildNewCandidate(substituted.context);
  const displaced = `${substituted.paths.candidatePath}.displaced`;
  fs.renameSync(substituted.paths.candidatePath, displaced);
  fs.cpSync(displaced, substituted.paths.candidatePath, { recursive: true });
  await assert.rejects(publishNewCandidate(substituted.context), code('RECOVERY_REQUIRED'));
  assert.equal(fs.existsSync(substituted.targetPath), false);
  assert.equal(fs.existsSync(displaced), true);
});

test('a checksummed journal cannot redirect target-absence evidence', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    jobId: 'job-journal-target-change', stableInstanceId: 'server-journal-target-change'
  });
  await buildNewCandidate(fixture.context);
  const journalPath = path.join(
    fixture.paths.candidatePath,
    '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.targetPathHash = 'b'.repeat(64);
  const payload = {};
  for (const [key, value] of Object.entries(journal)) {
    if (key !== 'checksum') payload[key] = value;
  }
  journal.checksum = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await assert.rejects(publishNewCandidate(fixture.context), code('RECOVERY_REQUIRED'));
  assert.equal(fs.existsSync(fixture.targetPath), false);
});

test('published ownership rejects a retargeted journal before registration', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate,
    registerPublishedInstance
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    jobId: 'job-published-retarget', stableInstanceId: 'server-published-retarget'
  });
  await buildNewCandidate(fixture.context);
  await publishNewCandidate(fixture.context);
  const journalPath = path.join(
    fixture.targetPath,
    '.minecraft-core-state', 'operations', fixture.context.jobId, 'journal.json'
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.targetPathHash = 'c'.repeat(64);
  journal.targetAbsence.targetPathHash = 'c'.repeat(64);
  const payload = {};
  for (const [key, value] of Object.entries(journal)) {
    if (key !== 'checksum') payload[key] = value;
  }
  journal.checksum = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await assert.rejects(registerPublishedInstance({
    ...fixture.context,
    name: 'Retargeted',
    appStore: { get() { return []; }, set() { throw new Error('must not register'); } },
    instanceContext: { updateInstances() { throw new Error('must not update'); } }
  }), code('RECOVERY_REQUIRED'));
});

test('target absence is the last application check before the write-through rename', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    jobId: 'job-absence-order', stableInstanceId: 'server-absence-order'
  });
  await buildNewCandidate(fixture.context);
  const events = [];
  const tracedFs = Object.create(fs);
  tracedFs.lstatSync = function lstatSync(candidate, options) {
    const result = fs.lstatSync(candidate, options);
    if (path.resolve(candidate).toLocaleLowerCase('en-US') === path.resolve(fixture.targetPath).toLocaleLowerCase('en-US')) {
      events.push(`target:${result ? 'present' : 'absent'}`);
    }
    return result;
  };
  fixture.context.fsApi = tracedFs;
  fixture.context.durableFs = {
    ...fixture.durableFs,
    renameDurable(source, destination, options) {
      events.push('rename');
      return fixture.durableFs.renameDurable(source, destination, options);
    }
  };
  await publishNewCandidate(fixture.context);
  const renameIndex = events.indexOf('rename');
  assert.ok(renameIndex > 0);
  assert.equal(events[renameIndex - 1], 'target:absent');
  assert.equal(events.filter(event => event === 'rename').length, 1);
});

test('journal and registry publication boundary failures retry without a second canonical server', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const journalFailure = await transactionFixture(t, {
    jobId: 'job-journal-retry', stableInstanceId: 'server-journal-retry'
  });
  await buildNewCandidate(journalFailure.context);
  let failJournal = true;
  journalFailure.context.durableFs = {
    ...journalFailure.durableFs,
    writeJsonAtomic(filePath, value, options) {
      if (failJournal && value?.phase === 'publishing' && filePath.endsWith('journal.json')) {
        failJournal = false;
        throw Object.assign(new Error('injected journal failure'), { code: 'COMMIT_FAILED' });
      }
      return journalFailure.durableFs.writeJsonAtomic(filePath, value, options);
    }
  };
  await assert.rejects(publishNewCandidate(journalFailure.context), code('COMMIT_FAILED'));
  assert.equal((await journalFailure.recoveryRegistry.load(journalFailure.context.jobId)).phase, 'committing');
  journalFailure.context.durableFs = journalFailure.durableFs;
  assert.equal((await publishNewCandidate(journalFailure.context)).phase, 'published');

  const registryFailure = await transactionFixture(t, {
    jobId: 'job-registry-retry', stableInstanceId: 'server-registry-retry'
  });
  await buildNewCandidate(registryFailure.context);
  let failRegistry = true;
  registryFailure.context.recoveryRegistry = {
    load: jobId => registryFailure.recoveryRegistry.load(jobId),
    transition(jobId, request) {
      if (failRegistry && request.expectedPhase === 'committing' && request.nextPhase === 'publishing') {
        failRegistry = false;
        throw Object.assign(new Error('injected registry failure'), { code: 'COMMIT_FAILED' });
      }
      return registryFailure.recoveryRegistry.transition(jobId, request);
    }
  };
  await assert.rejects(publishNewCandidate(registryFailure.context), code('COMMIT_FAILED'));
  assert.equal((await registryFailure.recoveryRegistry.load(registryFailure.context.jobId)).phase, 'committing');
  registryFailure.context.recoveryRegistry = registryFailure.recoveryRegistry;
  assert.equal((await publishNewCandidate(registryFailure.context)).phase, 'published');
  assert.equal(fs.existsSync(registryFailure.paths.candidatePath), false);
});

test('post-rename uncertainty is reconciled only by the exact marker and directory identity', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    jobId: 'job-uncertain-rename', stableInstanceId: 'server-uncertain-rename'
  });
  await buildNewCandidate(fixture.context);
  let renameCalls = 0;
  fixture.context.durableFs = {
    ...fixture.durableFs,
    renameDurable(source, destination, options) {
      renameCalls += 1;
      fixture.durableFs.renameDurable(source, destination, options);
      throw Object.assign(new Error('injected post-publication uncertainty'), {
        code: 'COMMIT_FAILED', commitPhase: 'post-publication-uncertain'
      });
    }
  };
  const result = await publishNewCandidate(fixture.context);
  assert.equal(result.phase, 'published');
  assert.equal(renameCalls, 1);
  assert.equal(fs.existsSync(fixture.targetPath), true);
  assert.equal(fs.existsSync(fixture.paths.candidatePath), false);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'published');
});

test('registration failure retains the published target and exact retry completes once', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate,
    registerPublishedInstance
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await transactionFixture(t, {
    jobId: 'job-register-retry', stableInstanceId: 'server-register-retry'
  });
  await buildNewCandidate(fixture.context);
  await publishNewCandidate(fixture.context);
  let instances = [];
  let failSet = true;
  const registrationContext = {
    ...fixture.context,
    name: 'Retry Server',
    appStore: {
      get() { return structuredClone(instances); },
      set(_key, value) {
        if (failSet) throw new Error('injected store failure');
        instances = structuredClone(value);
      }
    },
    instanceContext: { updateInstances() {} }
  };
  await assert.rejects(registerPublishedInstance(registrationContext), code('COMMIT_FAILED'));
  assert.equal(fs.existsSync(fixture.targetPath), true);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'registering');
  assert.equal(instances.length, 0);
  failSet = false;
  assert.equal((await registerPublishedInstance(registrationContext)).instanceId, fixture.stableInstanceId);
  assert.equal(instances.length, 1);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).outcome.registration.complete, true);
});

test('every Task 20 candidate journal write and directory flush boundary fails before publication', async (t) => {
  const { buildNewCandidate } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');

  const writeBaseline = await transactionFixture(t, {
    jobId: 'job-write-baseline', stableInstanceId: 'server-write-baseline'
  });
  let writeCount = 0;
  writeBaseline.context.durableFs = {
    ...writeBaseline.durableFs,
    writeJsonAtomic(filePath, value, options) {
      writeCount += 1;
      return writeBaseline.durableFs.writeJsonAtomic(filePath, value, options);
    }
  };
  await buildNewCandidate(writeBaseline.context);
  assert.ok(writeCount >= 4);

  for (let failureIndex = 1; failureIndex <= writeCount; failureIndex += 1) {
    await t.test(`candidate durable write ${failureIndex}/${writeCount}`, async (subtest) => {
      const fixture = await transactionFixture(subtest, {
        jobId: `job-write-${failureIndex}`, stableInstanceId: `server-write-${failureIndex}`
      });
      let current = 0;
      fixture.context.durableFs = {
        ...fixture.durableFs,
        writeJsonAtomic(filePath, value, options) {
          current += 1;
          if (current === failureIndex) throw Object.assign(new Error('injected write failure'), { code: 'COMMIT_FAILED' });
          return fixture.durableFs.writeJsonAtomic(filePath, value, options);
        }
      };
      await assert.rejects(buildNewCandidate(fixture.context), code('COMMIT_FAILED'));
      assert.equal(fs.existsSync(fixture.targetPath), false);
    });
  }

  const flushBaseline = await transactionFixture(t, {
    jobId: 'job-flush-baseline', stableInstanceId: 'server-flush-baseline'
  });
  let flushCount = 0;
  flushBaseline.context.durableFs = {
    ...flushBaseline.durableFs,
    flushDirectory(directoryPath) {
      flushCount += 1;
      return flushBaseline.durableFs.flushDirectory(directoryPath);
    }
  };
  await buildNewCandidate(flushBaseline.context);
  assert.ok(flushCount >= 10);

  for (let failureIndex = 1; failureIndex <= flushCount; failureIndex += 1) {
    await t.test(`candidate directory flush ${failureIndex}/${flushCount}`, async (subtest) => {
      const fixture = await transactionFixture(subtest, {
        jobId: `job-flush-${failureIndex}`, stableInstanceId: `server-flush-${failureIndex}`
      });
      let current = 0;
      fixture.context.durableFs = {
        ...fixture.durableFs,
        flushDirectory(directoryPath) {
          current += 1;
          if (current === failureIndex) throw Object.assign(new Error('injected flush failure'), { code: 'COMMIT_FAILED' });
          return fixture.durableFs.flushDirectory(directoryPath);
        }
      };
      await assert.rejects(buildNewCandidate(fixture.context), code('COMMIT_FAILED'));
      assert.equal(fs.existsSync(fixture.targetPath), false);
    });
  }
});

test('every Task 20 candidate file flush boundary fails before publication', async (t) => {
  const { buildNewCandidate } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const baseline = await transactionFixture(t, {
    jobId: 'job-fsync-baseline', stableInstanceId: 'server-fsync-baseline'
  });
  let fsyncCount = 0;
  const countingFs = Object.create(fs);
  countingFs.fsyncSync = function fsyncSync(descriptor) {
    fsyncCount += 1;
    return fs.fsyncSync(descriptor);
  };
  baseline.context.fsApi = countingFs;
  await buildNewCandidate(baseline.context);
  assert.ok(fsyncCount >= 8);

  for (let failureIndex = 1; failureIndex <= fsyncCount; failureIndex += 1) {
    await t.test(`candidate file flush ${failureIndex}/${fsyncCount}`, async (subtest) => {
      const fixture = await transactionFixture(subtest, {
        jobId: `job-fsync-${failureIndex}`, stableInstanceId: `server-fsync-${failureIndex}`
      });
      let current = 0;
      const failingFs = Object.create(fs);
      failingFs.fsyncSync = function fsyncSync(descriptor) {
        current += 1;
        if (current === failureIndex) throw Object.assign(new Error('injected fsync failure'), { code: 'COMMIT_FAILED' });
        return fs.fsyncSync(descriptor);
      };
      fixture.context.fsApi = failingFs;
      await assert.rejects(buildNewCandidate(fixture.context), code('COMMIT_FAILED'));
      assert.equal(fs.existsSync(fixture.targetPath), false);
    });
  }
});

test('every post-build journal boundary resumes to one registered canonical server', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate,
    registerPublishedInstance
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const baseline = await transactionFixture(t, {
    jobId: 'job-all-write-baseline', stableInstanceId: 'server-all-write-baseline'
  });
  let baselineWrites = 0;
  let baselineInstances = [];
  baseline.context.durableFs = {
    ...baseline.durableFs,
    writeJsonAtomic(filePath, value, options) {
      baselineWrites += 1;
      return baseline.durableFs.writeJsonAtomic(filePath, value, options);
    }
  };
  await buildNewCandidate(baseline.context);
  await publishNewCandidate(baseline.context);
  await registerPublishedInstance({
    ...baseline.context,
    name: 'Baseline',
    appStore: {
      get() { return structuredClone(baselineInstances); },
      set(_key, value) { baselineInstances = structuredClone(value); }
    },
    instanceContext: { updateInstances() {} }
  });
  assert.equal(baselineWrites, 8);

  for (let failureIndex = 5; failureIndex <= baselineWrites; failureIndex += 1) {
    await t.test(`lifecycle journal write ${failureIndex}/${baselineWrites}`, async (subtest) => {
      const fixture = await transactionFixture(subtest, {
        jobId: `job-lifecycle-write-${failureIndex}`,
        stableInstanceId: `server-lifecycle-write-${failureIndex}`
      });
      let current = 0;
      let instances = [];
      const appStore = {
        get() { return structuredClone(instances); },
        set(_key, value) { instances = structuredClone(value); }
      };
      const instanceContext = { updateInstances() {} };
      fixture.context.durableFs = {
        ...fixture.durableFs,
        writeJsonAtomic(filePath, value, options) {
          current += 1;
          if (current === failureIndex) throw Object.assign(new Error('injected lifecycle journal failure'), { code: 'COMMIT_FAILED' });
          return fixture.durableFs.writeJsonAtomic(filePath, value, options);
        }
      };
      await assert.rejects(async () => {
        await buildNewCandidate(fixture.context);
        await publishNewCandidate(fixture.context);
        await registerPublishedInstance({
          ...fixture.context, name: 'Lifecycle Retry', appStore, instanceContext
        });
      }, code('COMMIT_FAILED'));
      fixture.context.durableFs = fixture.durableFs;
      let record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      if (['committing', 'publishing'].includes(record.phase)) {
        await publishNewCandidate(fixture.context);
        record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      }
      assert.ok(['published', 'registering'].includes(record.phase));
      await registerPublishedInstance({
        ...fixture.context, name: 'Lifecycle Retry', appStore, instanceContext
      });
      assert.equal(instances.length, 1);
      assert.equal(fs.existsSync(fixture.targetPath), true);
      assert.equal(fs.existsSync(fixture.paths.candidatePath), false);
      assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).outcome.registration.complete, true);
    });
  }
});

test('every recovery-registry transition boundary stays discoverable and never adopts an unrelated target', async (t) => {
  const {
    buildNewCandidate,
    publishNewCandidate,
    registerPublishedInstance
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const transitionCount = 7;
  for (let failureIndex = 1; failureIndex <= transitionCount; failureIndex += 1) {
    await t.test(`lifecycle registry transition ${failureIndex}/${transitionCount}`, async (subtest) => {
      const fixture = await transactionFixture(subtest, {
        jobId: `job-registry-boundary-${failureIndex}`,
        stableInstanceId: `server-registry-boundary-${failureIndex}`
      });
      const originalRegistry = fixture.recoveryRegistry;
      let transitions = 0;
      let instances = [];
      const appStore = {
        get() { return structuredClone(instances); },
        set(_key, value) { instances = structuredClone(value); }
      };
      const instanceContext = { updateInstances() {} };
      fixture.context.recoveryRegistry = {
        load: jobId => originalRegistry.load(jobId),
        transition(jobId, request) {
          transitions += 1;
          if (transitions === failureIndex) {
            throw Object.assign(new Error('injected registry transition failure'), { code: 'COMMIT_FAILED' });
          }
          return originalRegistry.transition(jobId, request);
        }
      };
      await assert.rejects(async () => {
        await buildNewCandidate(fixture.context);
        await publishNewCandidate(fixture.context);
        await registerPublishedInstance({
          ...fixture.context, name: 'Registry Retry', appStore, instanceContext
        });
      }, code('COMMIT_FAILED'));
      assert.equal(transitions, failureIndex);
      const interrupted = await originalRegistry.load(fixture.context.jobId);
      assert.ok(interrupted);
      if (['preflight', 'staging', 'validating-candidate', 'committing'].includes(interrupted.phase)) {
        assert.equal(fs.existsSync(fixture.targetPath), false);
      }

      fixture.context.recoveryRegistry = originalRegistry;
      if (interrupted.phase === 'preflight') {
        await buildNewCandidate(fixture.context);
        await publishNewCandidate(fixture.context);
      } else if (['staging', 'validating-candidate'].includes(interrupted.phase)) {
        assert.equal(fs.existsSync(fixture.paths.candidatePath) || failureIndex === 1, true);
        return;
      } else if (['committing', 'publishing'].includes(interrupted.phase)) {
        await publishNewCandidate(fixture.context);
      }
      await registerPublishedInstance({
        ...fixture.context, name: 'Registry Retry', appStore, instanceContext
      });
      assert.equal(instances.length, 1);
      assert.equal(fs.existsSync(fixture.targetPath), true);
      assert.equal((await originalRegistry.load(fixture.context.jobId)).outcome.registration.complete, true);
    });
  }
});
