const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');

const noReparse = Object.freeze({
  async isReparsePoint() { return false; }
});

const runtime = Object.freeze({
  minecraftVersion: '1.21.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 21,
  os: 'win32',
  architecture: 'x64'
});

function nativeDurability() {
  return {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    flushDirectory() {}
  };
}

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-existing-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function existingFixture(t, options = {}) {
  const {
    createSiblingPaths
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const root = fixtureRoot(t);
  const servers = path.join(root, 'servers');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(servers);
  fs.mkdirSync(userDataPath);
  const targetPath = path.join(servers, 'server');
  fs.mkdirSync(targetPath);
  fs.mkdirSync(path.join(targetPath, 'world'));
  fs.writeFileSync(path.join(targetPath, 'server.jar'), 'old-server');
  fs.writeFileSync(path.join(targetPath, 'server.properties'), 'motd=Canonical\nserver-port=25565\n');
  fs.writeFileSync(path.join(targetPath, 'world', 'level.dat'), 'world-state');

  let temporary = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: nativeDurability(),
    allowedRoots: [root],
    tempNameFactory: () => `existing-swap-${++temporary}`
  });
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const clock = () => new Date(now += 1000);
  const recoveryRegistry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs,
    clock,
    randomUUID: () => '00000000-0000-4000-8000-000000000021'
  });
  await recoveryRegistry.initialize();

  const jobId = 'job-existing-swap';
  const stableInstanceId = 'server-existing-swap';
  const basePaths = createSiblingPaths(targetPath, jobId);
  const rollbackPath = path.join(servers, '.server.minecraft-core.job-existing-swap.rollback');
  const paths = Object.freeze({ ...basePaths, rollbackPath });
  await recoveryRegistry.create({
    schemaVersion: 1,
    sequence: 0,
    jobId,
    operationKind: options.operationKind || 'upgrade',
    target: { kind: 'existing', stableServerId: stableInstanceId, path: targetPath },
    candidatePath: paths.candidatePath,
    rollbackPath,
    failedPath: paths.failedPath,
    restorePoint: { id: 'restore-existing', sha256: 'a'.repeat(64) },
    journalPath: null,
    priorRuntime: { running: options.priorRunning === true, autoRestart: true },
    phase: 'queued',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    outcome: null
  });
  await recoveryRegistry.transition(jobId, {
    expectedPhase: 'queued', nextPhase: 'preflight', patch: {
      ...(options.targetRunning === undefined
        ? {}
        : { outcome: { runtimePolicy: { targetRunning: options.targetRunning } } })
    }
  });
  await recoveryRegistry.transition(jobId, {
    expectedPhase: 'preflight', nextPhase: 'snapshotting', patch: {}
  });

  const calls = [];
  const fault = { boundary: null };
  const mutationLease = Object.freeze({
    kind: 'mutation',
    operation: 'modpack-upgrade',
    operationId: jobId,
    instanceId: stableInstanceId,
    serverPath: targetPath,
    baseRevision: 5,
    assertOwnedPath(candidate) { return candidate; },
    markDirty() { calls.push('lease:dirty'); return true; },
    release() { return false; }
  });
  const stateRepository = {
    read(serverPath) {
      assert.equal(serverPath, targetPath);
      return Object.freeze({ state: Object.freeze({ contentRevision: 5, runtime }) });
    },
    writeCandidate(candidatePath, state) {
      calls.push('state:write');
      assert.equal(state.contentRevision, 6);
      fs.writeFileSync(path.join(candidatePath, '.minecraft-core.json'), JSON.stringify({ contentRevision: 6 }));
      return Object.freeze({ state: Object.freeze({ contentRevision: 6 }) });
    }
  };
  const context = {
    targetPath,
    jobId,
    operationKind: options.operationKind || 'upgrade',
    stableInstanceId,
    durableFs,
    fsApi: fs,
    reparseInspector: noReparse,
    recoveryRegistry,
    mutationLease,
    plan: Object.freeze({ fingerprint: 'reviewed-plan' }),
    currentSnapshot: Object.freeze({ fingerprint: 'current-snapshot' }),
    planValidator() { calls.push('plan:validate'); },
    async applyIncoming({ candidatePath }) {
      calls.push('incoming:apply');
      if (options.assertFreshCandidate) await options.assertFreshCandidate(candidatePath);
      fs.writeFileSync(path.join(candidatePath, 'server.jar'), 'new-server');
      fs.mkdirSync(path.join(candidatePath, 'mods'));
      fs.writeFileSync(path.join(candidatePath, 'mods', 'pack.jar'), 'pack-mod');
      if (options.afterIncoming) await options.afterIncoming(candidatePath);
    },
    stateRepository,
    candidateState: Object.freeze({ contentRevision: 6 }),
    healthValidator: {
      async validateCandidate({ candidatePath }) {
        calls.push('health:candidate');
        assert.equal(fs.readFileSync(path.join(candidatePath, 'server.properties'), 'utf8'), 'motd=Canonical\nserver-port=25565\n');
        if (options.candidateHealthError) throw options.candidateHealthError;
        if (options.mutatePropertiesDuringCandidateHealth) {
          fs.writeFileSync(path.join(candidatePath, 'server.properties'), 'motd=Not restored\n');
        }
        return Object.freeze({ evidence: Object.freeze({ kind: 'candidate' }) });
      },
      async validateLive(request) {
        calls.push('health:live');
        assert.equal(request.keepRunning, options.targetRunning ?? options.priorRunning === true);
        if (options.liveHealthError) throw options.liveHealthError;
        return Object.freeze({
          evidence: Object.freeze({ kind: 'live' }),
          handoff: (options.targetRunning ?? options.priorRunning === true)
            ? Object.freeze({ processHandle: {}, startLease: {} })
            : null
        });
      }
    },
    runtime,
    maxRam: 8,
    port: 25565,
    healthTimeoutMs: 30000,
    clock,
    async afterBoundary(name) {
      calls.push(`boundary:${name}`);
      if (fault.boundary === name) throw new Error(`fault after ${name}`);
    },
    revisionPublisher: {
      async publishOnce(event) {
        if (!calls.includes(`revision:${event.eventId}`)) calls.push(`revision:${event.eventId}`);
      }
    },
    runtimePolicy: {
      async adoptValidatedHandoff(request) {
        calls.push(`handoff:${request.eventId}`);
        return Object.freeze({ adopted: true });
      }
    }
  };
  if (options.persistCandidateState) context.persistCandidateState = options.persistCandidateState;
  if (options.validateCandidate === false) context.validateCandidate = false;
  if (options.freshCandidate === true) context.freshCandidate = true;
  return { calls, context, fault, paths, recoveryRegistry, targetPath };
}

test('failure between renames retains enough identity to restore one canonical server', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);

  await transaction.buildExistingCandidate(fixture.context);
  fixture.fault.boundary = 'live-moved';
  await assert.rejects(
    transaction.swapExistingCandidate(fixture.context),
    /fault after live-moved/
  );

  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.phase, 'committing');
  assert.equal(record.swapStep, 'live-moved');
  assert.equal(fs.existsSync(fixture.targetPath), false);
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
  assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
  assert.deepEqual(record.directoryIdentities.rollback, record.directoryIdentities.target);
  assert.notDeepEqual(record.directoryIdentities.candidate, record.directoryIdentities.rollback);
});

test('existing update uses real copies, validates both paths, publishes one revision, and cleans only after health', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  const liveWorld = fs.statSync(path.join(fixture.targetPath, 'world', 'level.dat'), { bigint: true });

  const built = await transaction.buildExistingCandidate(fixture.context);
  assert.equal(built.phase, 'committing');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'server.jar'), 'utf8'), 'new-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'world', 'level.dat'), 'utf8'), 'world-state');
  const candidateWorld = fs.statSync(path.join(fixture.paths.candidatePath, 'world', 'level.dat'), { bigint: true });
  assert.notEqual(candidateWorld.ino, liveWorld.ino);
  assert.equal(candidateWorld.nlink, 1n);

  const prepared = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(prepared.phase, 'committing');
  assert.equal(prepared.swapStep, 'prepared');
  assert.equal(prepared.outcome.revision.source, 5);
  assert.equal(prepared.outcome.revision.target, 6);
  assert.equal(prepared.outcome.runtime.port, 25565);

  const swapped = await transaction.swapExistingCandidate(fixture.context);
  assert.equal(swapped.phase, 'starting');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'world', 'level.dat'), 'utf8'), 'world-state');

  const healthy = await transaction.markCommittedHealthy(fixture.context);
  assert.equal(healthy.phase, 'committed-healthy');
  assert.equal(healthy.revision, 6);
  await transaction.markCommittedHealthy(fixture.context);
  assert.equal(fixture.calls.filter(call => call.startsWith('revision:')).length, 1);
  assert.equal(fixture.calls.filter(call => call === 'health:live').length, 1);

  const cleaned = await transaction.cleanupCommittedTransaction(fixture.context);
  assert.deepEqual(cleaned, { phase: 'completed', rollbackRemoved: true });
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal(fs.existsSync(fixture.targetPath), true);
  const completed = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.swapStep, 'cleanup-complete');
  assert.equal(completed.outcome.cleanup.rollbackRemoved, true);
});

test('fresh rollback candidate never inherits live bytes and still completes the exact two-rename transaction', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    operationKind: 'rollback',
    freshCandidate: true,
    async assertFreshCandidate(candidatePath) {
      assert.equal(fs.existsSync(path.join(candidatePath, 'server.jar')), false);
      assert.equal(fs.existsSync(path.join(candidatePath, 'server.properties')), false);
      assert.equal(fs.existsSync(path.join(candidatePath, 'world')), false);
      assert.equal(fs.existsSync(path.join(candidatePath, 'live-only.txt')), false);
    },
    async afterIncoming(candidatePath) {
      fs.writeFileSync(path.join(candidatePath, 'server.properties'), 'motd=Canonical\nserver-port=25565\n');
      fs.mkdirSync(path.join(candidatePath, 'world'));
      fs.writeFileSync(path.join(candidatePath, 'world', 'level.dat'), 'restored-world-state');
      fs.writeFileSync(path.join(candidatePath, 'restored-only.txt'), 'selected-restore');
    }
  });
  fs.writeFileSync(path.join(fixture.targetPath, 'live-only.txt'), 'must-not-overlay-selected-restore');

  const built = await transaction.buildExistingCandidate(fixture.context);
  assert.equal(built.phase, 'committing');
  const prepared = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.deepEqual(prepared.outcome.copy, { bytes: '0', files: '0' });
  assert.equal(fs.existsSync(path.join(fixture.paths.candidatePath, 'live-only.txt')), false);
  assert.equal(fs.readFileSync(path.join(fixture.paths.candidatePath, 'restored-only.txt'), 'utf8'), 'selected-restore');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'live-only.txt'), 'utf8'),
    'must-not-overlay-selected-restore');

  await transaction.swapExistingCandidate(fixture.context);
  assert.equal(fs.existsSync(path.join(fixture.targetPath, 'live-only.txt')), false);
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'world', 'level.dat'), 'utf8'), 'restored-world-state');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'live-only.txt'), 'utf8'),
    'must-not-overlay-selected-restore');
  await transaction.markCommittedHealthy(fixture.context);
  await transaction.cleanupCommittedTransaction(fixture.context);
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'completed');
});

test('existing install honors the reviewed start-after-install target policy even when the server was stopped', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, { priorRunning: false, targetRunning: true });

  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  const healthy = await transaction.markCommittedHealthy(fixture.context);

  assert.equal(healthy.handoffExpected, true);
  assert.equal(fixture.calls.filter(call => call === 'health:live').length, 1);
  assert.equal(fixture.calls.filter(call => call.startsWith('handoff:')).length, 1);
});

test('managed uninstall can persist an inactive files-only state without requiring candidate runtime validation', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, {
    operationKind: 'uninstall',
    validateCandidate: false,
    persistCandidateState({ candidatePath }) {
      fs.writeFileSync(path.join(candidatePath, '.minecraft-core-state', 'modpack.json'), JSON.stringify({
        modpackManaged: false, lifecycleMode: 'uninstalled', contentRevision: 6
      }));
      return { state: { contentRevision: 6 } };
    }
  });

  const built = await transaction.buildExistingCandidate(fixture.context);

  assert.equal(built.phase, 'committing');
  assert.equal(fixture.calls.includes('health:candidate'), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixture.paths.candidatePath, '.minecraft-core-state', 'modpack.json'))).lifecycleMode,
    'uninstalled'
  );
  await transaction.swapExistingCandidate(fixture.context);
  const healthy = await transaction.markCommittedHealthy({ ...fixture.context, validateLive: false });
  assert.equal(healthy.handoffExpected, false);
  assert.equal(fixture.calls.includes('health:live'), false);
  assert.deepEqual(await transaction.cleanupCommittedTransaction(fixture.context), {
    phase: 'completed', rollbackRemoved: true
  });
});

test('candidate health or exact properties restoration failure leaves the original live tree untouched', async (t) => {
  await t.test('health failure', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const failure = Object.assign(new Error('candidate unhealthy'), { code: 'HEALTH_CHECK_FAILED' });
    const fixture = await existingFixture(subtest, { candidateHealthError: failure });
    await assert.rejects(transaction.buildExistingCandidate(fixture.context), error => error === failure);
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'validating-candidate');
  });

  await t.test('properties not restored', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest, { mutatePropertiesDuringCandidateHealth: true });
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'HEALTH_CHECK_FAILED'
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.targetPath, 'server.properties'), 'utf8'),
      'motd=Canonical\nserver-port=25565\n'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  });
});

test('links, hardlinks, reparse entries, and sibling aliases fail before the original live path moves', async (t) => {
  await t.test('hardlink', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    fs.linkSync(
      path.join(fixture.targetPath, 'server.jar'),
      path.join(fixture.targetPath, 'server-copy.jar')
    );
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'UNSAFE_ARCHIVE_ENTRY'
    );
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });

  await t.test('reparse', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    fixture.context.reparseInspector = {
      async isReparsePoint(candidate) { return candidate.endsWith('level.dat'); }
    };
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'UNSAFE_ARCHIVE_ENTRY'
    );
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });

  await t.test('rollback alias', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    fs.mkdirSync(fixture.paths.rollbackPath);
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'TARGET_EXISTS'
    );
    assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
  });

  await t.test('junction or symlink when permitted', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    const link = path.join(fixture.targetPath, 'linked-world');
    try {
      fs.symlinkSync(path.join(fixture.targetPath, 'world'), link, 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return;
      throw error;
    }
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'UNSAFE_ARCHIVE_ENTRY'
    );
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });
});

test('target, candidate, and rollback content substitutions are rejected by identity and fingerprint', async (t) => {
  await t.test('target identity replacement', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    const unrelated = `${fixture.targetPath}-unrelated`;
    fs.renameSync(fixture.targetPath, `${fixture.targetPath}-original`);
    fs.mkdirSync(unrelated);
    fs.renameSync(unrelated, fixture.targetPath);
    await assert.rejects(
      transaction.swapExistingCandidate(fixture.context),
      error => error && error.code === 'RECOVERY_REQUIRED'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  });

  await t.test('candidate content mutation', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    fs.writeFileSync(path.join(fixture.paths.candidatePath, 'server.jar'), 'tampered');
    await assert.rejects(
      transaction.swapExistingCandidate(fixture.context),
      error => error && error.code === 'RECOVERY_REQUIRED'
    );
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });

  await t.test('rollback content mutation', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    await transaction.swapExistingCandidate(fixture.context);
    fs.writeFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'tampered rollback');
    await assert.rejects(
      transaction.markCommittedHealthy(fixture.context),
      error => error && error.code === 'RECOVERY_REQUIRED'
    );
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'starting');
  });
});

test('source mutation during copy and a different-volume candidate fail closed', async (t) => {
  await t.test('source mutation during copy', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    let armed = false;
    let mutated = false;
    const baseBoundary = fixture.context.afterBoundary;
    fixture.context.afterBoundary = async name => {
      if (name === 'candidate-created') armed = true;
      await baseBoundary(name);
    };
    const fsApi = Object.create(fs);
    fsApi.readSync = (...args) => {
      if (armed && !mutated) {
        mutated = true;
        fs.appendFileSync(path.join(fixture.targetPath, 'server.jar'), '-external-mutation');
      }
      return fs.readSync(...args);
    };
    fixture.context.fsApi = fsApi;
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && ['RECOVERY_REQUIRED', 'UNSAFE_ARCHIVE_ENTRY'].includes(error.code)
    );
    assert.equal(mutated, true);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });

  await t.test('different volume identity', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    const fsApi = Object.create(fs);
    fsApi.lstatSync = (candidate, options) => {
      const stat = fs.lstatSync(candidate, options);
      if (!stat || path.resolve(candidate) !== path.resolve(fixture.paths.candidatePath)) return stat;
      return new Proxy(stat, {
        get(target, property) {
          if (property === 'dev') return target.dev + 1n;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
    fixture.context.fsApi = fsApi;
    await assert.rejects(
      transaction.buildExistingCandidate(fixture.context),
      error => error && error.code === 'COMMIT_FAILED'
    );
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
    assert.equal(fs.existsSync(fixture.targetPath), true);
  });
});

test('rename and split registry-journal failures remain reconstructable without adopting unrelated paths', async (t) => {
  await t.test('first rename failure leaves live authoritative', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    const base = fixture.context.durableFs;
    const wrapped = {
      ...base,
      renameDurable() { throw Object.assign(new Error('rename blocked'), { code: 'COMMIT_FAILED' }); }
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
    await assert.rejects(transaction.swapExistingCandidate(fixture.context));
    assert.equal(fs.existsSync(fixture.targetPath), true);
    assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).swapStep, 'prepared');
  });

  await t.test('second rename failure leaves durable live-moved evidence', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    const base = fixture.context.durableFs;
    let renames = 0;
    const wrapped = {
      ...base,
      renameDurable(...args) {
        renames += 1;
        if (renames === 2) throw Object.assign(new Error('second rename blocked'), { code: 'COMMIT_FAILED' });
        return base.renameDurable(...args);
      }
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
    await assert.rejects(transaction.swapExistingCandidate(fixture.context));
    assert.equal(fs.existsSync(fixture.targetPath), false);
    assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).swapStep, 'live-moved');
  });

  await t.test('journal failure after registry live-moved remains discoverable', async (subtest) => {
    const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
    const fixture = await existingFixture(subtest);
    await transaction.buildExistingCandidate(fixture.context);
    const base = fixture.context.durableFs;
    const candidateJournal = path.join(
      fixture.paths.candidatePath,
      '.minecraft-core-state',
      'operations',
      fixture.context.jobId,
      'journal.json'
    );
    const wrapped = {
      ...base,
      writeJsonAtomic(filePath, value, options) {
        if (path.resolve(filePath) === path.resolve(candidateJournal) && value.swapStep === 'live-moved') {
          throw Object.assign(new Error('journal blocked'), { code: 'COMMIT_FAILED' });
        }
        return base.writeJsonAtomic(filePath, value, options);
      }
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
    await assert.rejects(transaction.swapExistingCandidate(fixture.context));
    const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
    assert.equal(record.swapStep, 'live-moved');
    assert.equal(fs.existsSync(fixture.targetPath), false);
    assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    assert.equal(fs.existsSync(fixture.paths.candidatePath), true);
  });
});

test('prior running policy adopts the exact validated handoff before healthy commit', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t, { priorRunning: true });
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  assert.equal(fixture.calls.filter(call => call.startsWith('handoff:')).length, 1);
  const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
  assert.equal(record.outcome.runtimePolicy.runningRestored, true);
  assert.equal(record.priorRuntime.running, true);
});

test('cleanup failure becomes cleanup-pending and retry never rolls back a healthy canonical server', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const fixture = await existingFixture(t);
  await transaction.buildExistingCandidate(fixture.context);
  await transaction.swapExistingCandidate(fixture.context);
  await transaction.markCommittedHealthy(fixture.context);
  fixture.context.removeOwnedDirectory = async () => { throw new Error('cleanup blocked'); };

  const pending = await transaction.cleanupCommittedTransaction(fixture.context);
  assert.equal(pending.phase, 'cleanup-pending');
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
  assert.equal(fs.readFileSync(path.join(fixture.paths.rollbackPath, 'server.jar'), 'utf8'), 'old-server');
  assert.equal((await fixture.recoveryRegistry.load(fixture.context.jobId)).phase, 'cleanup-pending');

  delete fixture.context.removeOwnedDirectory;
  const completed = await transaction.cleanupCommittedTransaction(fixture.context);
  assert.equal(completed.phase, 'completed');
  assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
  assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'new-server');
});

test('every named swap, health, event, and cleanup boundary retains an unambiguous durable state', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  for (const boundary of ['live-renamed', 'candidate-renamed', 'candidate-published']) {
    await t.test(boundary, async (subtest) => {
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      fixture.fault.boundary = boundary;
      await assert.rejects(transaction.swapExistingCandidate(fixture.context), new RegExp(`fault after ${boundary}`));
      const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      if (boundary === 'live-renamed') assert.equal(record.swapStep, 'prepared');
      if (boundary === 'candidate-renamed') assert.equal(record.swapStep, 'live-moved');
      if (boundary === 'candidate-published') assert.equal(record.phase, 'starting');
      assert.equal(Number(fs.existsSync(fixture.targetPath)) + Number(fs.existsSync(fixture.paths.candidatePath)) >= 1, true);
      assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    });
  }

  for (const boundary of ['validating-live', 'committed-healthy', 'revision-published']) {
    await t.test(boundary, async (subtest) => {
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      await transaction.swapExistingCandidate(fixture.context);
      fixture.fault.boundary = boundary;
      await assert.rejects(transaction.markCommittedHealthy(fixture.context), new RegExp(`fault after ${boundary}`));
      const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      assert.equal(['validating-live', 'committed-healthy'].includes(record.phase), true);
      assert.equal(fs.existsSync(fixture.targetPath), true);
      assert.equal(fs.existsSync(fixture.paths.rollbackPath), true);
    });
  }

  for (const boundary of ['cleanup-started', 'rollback-removed', 'cleanup-complete']) {
    await t.test(boundary, async (subtest) => {
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      await transaction.swapExistingCandidate(fixture.context);
      await transaction.markCommittedHealthy(fixture.context);
      fixture.fault.boundary = boundary;
      const result = await transaction.cleanupCommittedTransaction(fixture.context);
      const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      assert.equal(fs.existsSync(fixture.targetPath), true);
      if (boundary === 'cleanup-complete') {
        assert.equal(result.phase, 'completed');
        assert.equal(record.phase, 'completed');
      } else {
        assert.equal(result.phase, 'cleanup-pending');
        assert.equal(record.phase, 'cleanup-pending');
      }
    });
  }
});

function installDurabilityProbe(fixture, { failAt = null, kind }) {
  const baseDurable = fixture.context.durableFs;
  const baseFs = fixture.context.fsApi;
  let count = 0;
  const fail = () => {
    count += 1;
    if (count === failAt) throw Object.assign(new Error(`injected ${kind} ${count}`), { code: 'COMMIT_FAILED' });
  };
  if (kind === 'write') {
    const wrapped = {
      ...baseDurable,
      writeJsonAtomic(...args) { fail(); return baseDurable.writeJsonAtomic(...args); }
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
  } else if (kind === 'directory-flush') {
    const wrapped = {
      ...baseDurable,
      flushDirectory(...args) { fail(); return baseDurable.flushDirectory(...args); }
    };
    fixture.context.durableFs = wrapped;
    fixture.recoveryRegistry.durableFs = wrapped;
  } else if (kind === 'file-flush') {
    const wrappedFs = Object.create(baseFs);
    wrappedFs.fsyncSync = (...args) => { fail(); return baseFs.fsyncSync(...args); };
    fixture.context.fsApi = wrappedFs;
  } else {
    throw new TypeError('unknown durability probe');
  }
  return () => count;
}

test('every candidate record write, directory flush, and file flush fails before the original live path moves', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  for (const kind of ['write', 'directory-flush', 'file-flush']) {
    const baseline = await existingFixture(t);
    const count = installDurabilityProbe(baseline, { kind });
    await transaction.buildExistingCandidate(baseline.context);
    const boundaryCount = count();
    assert.equal(boundaryCount > 0, true);

    for (let failAt = 1; failAt <= boundaryCount; failAt += 1) {
      await t.test(`${kind} ${failAt}/${boundaryCount}`, async (subtest) => {
        const fixture = await existingFixture(subtest);
        installDurabilityProbe(fixture, { failAt, kind });
        await assert.rejects(transaction.buildExistingCandidate(fixture.context));
        assert.equal(fs.existsSync(fixture.targetPath), true);
        assert.equal(fs.existsSync(fixture.paths.rollbackPath), false);
        assert.equal(fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8'), 'old-server');
        const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
        assert.equal(record !== null, true);
        assert.equal(['snapshotting', 'staging', 'validating-candidate', 'committing'].includes(record.phase), true);
      });
    }
  }
});

test('every post-build registry or journal write failure leaves a provable canonical choice', async (t) => {
  const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const baseline = await existingFixture(t);
  await transaction.buildExistingCandidate(baseline.context);
  const count = installDurabilityProbe(baseline, { kind: 'write' });
  await transaction.swapExistingCandidate(baseline.context);
  await transaction.markCommittedHealthy(baseline.context);
  await transaction.cleanupCommittedTransaction(baseline.context);
  const writeCount = count();
  assert.equal(writeCount > 0, true);

  for (let failAt = 1; failAt <= writeCount; failAt += 1) {
    await t.test(`post-build write ${failAt}/${writeCount}`, async (subtest) => {
      const fixture = await existingFixture(subtest);
      await transaction.buildExistingCandidate(fixture.context);
      installDurabilityProbe(fixture, { failAt, kind: 'write' });
      try {
        await transaction.swapExistingCandidate(fixture.context);
        await transaction.markCommittedHealthy(fixture.context);
        await transaction.cleanupCommittedTransaction(fixture.context);
      } catch { /* the durable state below is the assertion */ }
      const record = await fixture.recoveryRegistry.load(fixture.context.jobId);
      assert.equal(record !== null, true);
      const target = fs.existsSync(fixture.targetPath);
      const candidate = fs.existsSync(fixture.paths.candidatePath);
      const rollback = fs.existsSync(fixture.paths.rollbackPath);
      assert.equal(target || candidate || rollback, true);
      assert.equal(target && candidate, false);
      if (!target) {
        assert.equal(candidate, true);
        assert.equal(rollback, true);
        assert.equal(['prepared', 'live-moved'].includes(record.swapStep), true);
      } else {
        const bytes = fs.readFileSync(path.join(fixture.targetPath, 'server.jar'), 'utf8');
        assert.equal(['old-server', 'new-server'].includes(bytes), true);
      }
    });
  }
});
