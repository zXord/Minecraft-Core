const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fixtureDurableFs, fixtureRegistry } = require('./runtime-authority-fixture.cjs');
const { ProductionMutationRuntime } = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
const { ModpackRecoveryService } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
const { ServerRuntimeWriterAuthority } = require('../../electron/services/modpack-lifecycle/server-runtime-writer-authority.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationContext } = require('../../electron/services/server-mutation-context.cjs');
const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
const { inspectServerDirectoryTree } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');

const runtimeTuple = { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14',
  javaMajor: 21, os: 'win32', architecture: 'x64' };
const jobId = 'job-between-renames';
const noReparse = { async isReparsePoint() { return false; } };

async function fixture(t, fault, { unprovenWriter = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-between-renames-'));
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(root), /^minecraft-core-between-renames-/);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'servers', 'Original');
  fs.mkdirSync(path.join(targetPath, 'world'), { recursive: true });
  fs.writeFileSync(path.join(targetPath, 'server.jar'), 'exact original server');
  fs.writeFileSync(path.join(targetPath, 'server.properties'), 'motd=Original\nserver-port=25565\n');
  fs.writeFileSync(path.join(targetPath, 'world', 'level.dat'), 'exact original world');
  const unrelated = path.join(root, 'servers', 'unrelated.txt');
  fs.writeFileSync(unrelated, 'never owned by this operation');
  const original = await inspectServerDirectoryTree(targetPath, { reparseInspector: noReparse });
  const paths = transaction.createExistingSiblingPaths(targetPath, jobId);
  const registry = fixtureRegistry(root);
  await registry.ready;
  const baseDurable = fixtureDurableFs(root);
  let injected = false;
  const injectedError = new Error(`injected ${fault} durability failure`);
  const durableFs = { ...baseDurable,
    async writeJsonAtomicAsync(filePath, value, options) {
      const journal = path.basename(filePath) === 'journal.json';
      if (!injected && fault === 'published-registry' && !journal && value.phase === 'starting') {
        injected = true;
        throw injectedError;
      }
      const result = await baseDurable.writeJsonAtomicAsync(filePath, value, options);
      if (!injected && fault === 'journal-completion' && journal && value.swapStep === 'live-moved') {
        injected = true;
        throw injectedError;
      }
      return result;
    },
    async renameDurableAsync(from, to, options) {
      if (!injected && fault === 'second-rename' && from === paths.candidatePath && to === targetPath) {
        injected = true;
        throw injectedError;
      }
      return baseDurable.renameDurableAsync(from, to, options);
    }
  };
  registry.durableFs = durableFs;
  await registry.create({ schemaVersion: 2, sequence: 0, jobId, operationKind: 'repair',
    target: { kind: 'existing', stableServerId: 'between-renames', path: targetPath },
    candidatePath: paths.candidatePath, rollbackPath: paths.rollbackPath, failedPath: paths.failedPath,
    journalPath: null, restorePoint: { id: 'fixture-restore', sha256: 'a'.repeat(64) },
    restoreCreation: null, priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', outcome: null });
  await registry.transition(jobId, { expectedPhase: 'queued', nextPhase: 'preflight', patch: {} });
  await registry.transition(jobId, { expectedPhase: 'preflight', nextPhase: 'snapshotting', patch: {} });
  const selector = { instanceId: 'between-renames', serverPath: targetPath };
  const coordinator = new ServerMutationCoordinator({ context: createServerMutationContext(),
    readContentRevision: () => 5, bumpContentRevision() { assert.fail('rollback must not publish a revision'); } });
  coordinator.installRecoveryBlocks([{ selector, operationId: jobId }]);
  coordinator.completeStartupRecovery([{ selector, resolved: false }]);
  const writerAuthority = new ServerRuntimeWriterAuthority({ registry, coordinator, getBootSequence: () => 1 });
  const runtimePolicy = {
    async suspend() { return { held: true }; }, async ensureStopped() { return { alreadyStopped: true }; },
    async restoreAutoRestart() { return { restored: true }; },
    async adoptValidatedHandoff() { assert.fail('stopped source must not be adopted'); }
  };
  const stateRepository = {
    read() { return { state: { contentRevision: 5, runtime: runtimeTuple } }; },
    async writeCandidateAsync(candidatePath, state) {
      fs.writeFileSync(path.join(candidatePath, '.minecraft-core.json'), JSON.stringify(state));
      return { state };
    }, async appendHistoryAsync() {}
  };
  const healthValidator = {
    async validateCandidate({ mutationLease }) {
      if (unprovenWriter) {
        const record = await registry.load(jobId);
        await registry.updateRuntimeWriterAuthority(jobId, { expectedSequence: record.sequence,
          authority: { schemaVersion: 1, jobId, candidatePath: record.candidatePath,
            candidateIdentity: record.directoryIdentities.candidate, bootSequence: 1, state: 'unproven' }, failureCode: null });
        return { evidence: { kind: 'candidate' } };
      }
      return writerAuthority.run(jobId, async () => ({ evidence: { kind: 'candidate' } }), { lease: mutationLease });
    },
    async validateLive({ serverPath, keepRunning }) {
      assert.equal(serverPath.toLowerCase(), targetPath.toLowerCase());
      assert.equal(keepRunning, false);
      assert.equal(fs.readFileSync(path.join(serverPath, 'server.jar'), 'utf8'), 'exact original server');
      return { evidence: { kind: 'source' }, handoff: null };
    }
  };
  const recoveryService = new ModpackRecoveryService({ coordinator, recoveryRegistry: registry,
    runtimeWriterAuthority: writerAuthority, runtimePolicy,
    contextFactory: async ({ record, mutationLease }) => ({ fsApi: fs, durableFs, reparseInspector: noReparse,
      jobId, targetPath, stableInstanceId: selector.instanceId, operationKind: record.operationKind,
      recoveryRegistry: registry, mutationLease, runtimePolicy, healthValidator,
      async resolveRecoveryRuntimeConfig() { return { runtime: runtimeTuple, maxRam: 4, port: 25565, networkAccess: 'pack-default' }; }
    }) });
  const plan = { fingerprint: 'fixture-plan', operation: { kind: 'repair', serverKind: 'existing', instanceId: selector.instanceId } };
  const resolved = { ...selector, priorRunning: false };
  const runtime = new ProductionMutationRuntime({ coordinator, durableFsFactory: () => durableFs,
    destinationReservations: { resolve() {}, consume() {}, release() {} }, instanceResolver: { async resolveInstance() { return resolved; } },
    planningAdapter: { getExecutionRecord() {} }, snapshotServer: async () => ({}),
    recoveryServices: { registry, recoveryService, runtimeWriterAuthority: writerAuthority, runtimePolicy },
    healthValidator, releaseTrackingStore: { async list() { return []; }, async remove() {}, async upsert() {} },
    reparseInspector: noReparse, stateRepository, store: { get() {} }, userDataPath: root,
    workspaceRegistry: { resolveOwnedWorkspace() {} }
  });
  // Only materialization context setup is injected; dispatch, opaque lease,
  // transaction, directory proofs, writer settlement and terminal history are real.
  runtime.contexts.set(jobId, { plan, resolved });
  const value = { root, targetPath, paths, original, unrelated, registry, coordinator, selector, runtime, plan, resolved,
    async run(work) {
      return coordinator.runRecoveryMutation(selector, { operationId: jobId }, async lease => {
        const context = { targetPath, jobId, operationKind: 'repair', stableInstanceId: selector.instanceId,
          durableFs, fsApi: fs, reparseInspector: noReparse, recoveryRegistry: registry, mutationLease: lease,
          plan, currentSnapshot: {}, planValidator() {}, stateRepository, candidateState: { contentRevision: 6 },
          healthValidator, runtime: runtimeTuple, maxRam: 4, port: 25565, healthTimeoutMs: 30000,
          async applyIncoming({ candidatePath }) { fs.writeFileSync(path.join(candidatePath, 'server.jar'), 'owned candidate server'); }
        };
        await transaction.buildExistingCandidate(context);
        const prepared = await registry.load(jobId);
        if (fault !== 'prepared') {
          if (fault) await assert.rejects(transaction.swapExistingCandidate(context), error => {
            for (let current = error; current; current = current.cause) if (current === injectedError) return true;
            return false;
          });
          else await transaction.swapExistingCandidate(context);
        }
        if (fault && fault !== 'prepared') assert.equal(injected, true);
        return work({ ...value, context, lease, prepared,
          rollback: () => runtime.rollback({ jobId, plan, resolved, lease, error: { code: 'COMMIT_FAILED' } }) });
      });
    }
  };
  return value;
}

async function assertOriginal(value) {
  const restored = await inspectServerDirectoryTree(value.targetPath, { reparseInspector: noReparse });
  assert.deepEqual(restored.directoryIdentity, value.original.directoryIdentity);
  assert.equal(restored.fingerprint, value.original.fingerprint);
  assert.equal(fs.readFileSync(path.join(value.targetPath, 'server.jar'), 'utf8'), 'exact original server');
  assert.equal(fs.readFileSync(path.join(value.targetPath, 'world', 'level.dat'), 'utf8'), 'exact original world');
  assert.equal(fs.readFileSync(value.unrelated, 'utf8'), 'never owned by this operation');
}

async function assertReleased(value) {
  const lease = await value.coordinator.acquireStart(value.selector,
    { operation: 'prove-release', operationId: 'ordinary-start', parentMutationLease: null });
  lease.release();
}

// Regression: live-moved must not use the candidate-absent-only rollback route
// after a journal publishes JSON but its durable completion rejects.
test('normal rollback restores exact original after live-moved journal completion rejects', async t => {
  const value = await fixture(t, 'journal-completion');
  await value.run(async c => {
    const record = await c.registry.load(jobId);
    assert.equal(record.phase, 'committing');
    assert.equal(record.swapStep, 'live-moved');
    const journal = JSON.parse(fs.readFileSync(record.journalPath, 'utf8'));
    assert.equal(journal.swapStep, 'live-moved');
    assert.equal(fs.existsSync(c.targetPath), false);
    assert.equal(fs.existsSync(c.paths.candidatePath), true);
    assert.equal(fs.existsSync(c.paths.rollbackPath), true);
    const result = await c.rollback();
    assert.equal(result.action, 'between-renames-restored');
    await assertOriginal(c);
    assert.equal(fs.existsSync(c.paths.candidatePath), false);
    assert.equal(fs.existsSync(c.paths.rollbackPath), false);
    assert.equal(fs.existsSync(c.paths.failedPath), false);
    assert.equal(await c.registry.load(jobId), null);
    const history = await c.registry.loadHistory(jobId);
    assert.equal(history.phase, 'failed');
    assert.deepEqual(history.outcome.recovery, { action: 'between-renames-restored', operationId: jobId });
    assert.equal(history.outcome.candidateCleanup.deletionAuthorized, true);
    return result;
  });
  await assertReleased(value);
});

// Regression: a rejected candidate-to-canonical rename must restore the original,
// never leave the already-published live-moved state quarantined unnecessarily.
test('normal rollback restores exact original when second rename rejects before effect', async t => {
  const value = await fixture(t, 'second-rename');
  await value.run(async c => {
    const record = await c.registry.load(jobId);
    assert.equal(record.phase, 'committing');
    assert.equal(record.swapStep, 'live-moved');
    assert.equal(JSON.parse(fs.readFileSync(record.journalPath, 'utf8')).swapStep, 'live-moved');
    assert.equal(fs.existsSync(c.targetPath), false);
    assert.equal(fs.existsSync(c.paths.candidatePath), true);
    const result = await c.rollback();
    assert.equal(result.action, 'between-renames-restored');
    await assertOriginal(c);
    assert.equal(fs.existsSync(c.paths.candidatePath), false);
    assert.equal(fs.existsSync(c.paths.rollbackPath), false);
    assert.equal(fs.existsSync(c.paths.failedPath), false);
    assert.equal(await c.registry.load(jobId), null);
    const history = await c.registry.loadHistory(jobId);
    assert.equal(history.phase, 'failed');
    assert.equal(history.swapStep, 'live-moved');
    assert.deepEqual(history.outcome.recovery, { action: 'between-renames-restored', operationId: jobId });
    return result;
  });
  await assertReleased(value);
});

// Regression: live-moved is not proof that the candidate still occupies its
// sibling slot; promotion may have succeeded before registry completion failed.
test('live-moved with candidate already canonical uses published rollback and retains failed candidate', async t => {
  const value = await fixture(t, 'published-registry');
  await value.run(async c => {
    const record = await c.registry.load(jobId);
    assert.equal(record.phase, 'committing');
    assert.equal(record.swapStep, 'live-moved');
    assert.equal(fs.existsSync(c.paths.candidatePath), false);
    assert.equal(fs.readFileSync(path.join(c.targetPath, 'server.jar'), 'utf8'), 'owned candidate server');
    const result = await c.rollback();
    assert.equal(result.action, 'rollback-restored');
    await assertOriginal(c);
    assert.equal(fs.existsSync(c.paths.rollbackPath), false);
    assert.equal(fs.readFileSync(path.join(c.paths.failedPath, 'server.jar'), 'utf8'), 'owned candidate server');
    assert.equal(await c.registry.load(jobId), null);
    const history = await c.registry.loadHistory(jobId);
    assert.equal(history.phase, 'rolled-back');
    assert.equal(history.swapStep, 'rollback-restored');
    assert.equal(history.outcome.recovery.action, 'rollback-restored');
    return result;
  });
  await assertReleased(value);
});

// Regressions: routing must not turn a mismatched original/candidate, an
// unsettled runtime writer, or conflicting names into restoration authority.
for (const corruption of ['original-identity', 'original-fingerprint', 'candidate-identity',
  'candidate-fingerprint', 'unproven-writer', 'unresolved-topology']) {
  test(`live-moved ${corruption} stays blocked with evidence preserved`, async t => {
    const value = await fixture(t, 'second-rename', { unprovenWriter: corruption === 'unproven-writer' });
    await value.run(async c => {
      if (corruption.endsWith('-identity')) {
        const slot = corruption.startsWith('original') ? 'rollbackPath' : 'candidatePath';
        const saved = path.join(c.root, `saved-${corruption}`);
        fs.renameSync(c.paths[slot], saved);
        fs.mkdirSync(c.paths[slot]);
        fs.writeFileSync(path.join(c.paths[slot], 'replacement.txt'), 'unrelated replacement');
      } else if (corruption.endsWith('-fingerprint')) {
        const slot = corruption.startsWith('original') ? 'rollbackPath' : 'candidatePath';
        fs.writeFileSync(path.join(c.paths[slot], 'server.jar'), 'changed bytes must survive refusal');
      } else if (corruption === 'unresolved-topology') {
        fs.mkdirSync(c.targetPath);
        fs.writeFileSync(path.join(c.targetPath, 'conflict.txt'), 'unrelated canonical occupant');
      }
      const before = await c.registry.load(jobId);
      const originalBefore = await inspectServerDirectoryTree(c.paths.rollbackPath, { reparseInspector: noReparse });
      const candidateBefore = await inspectServerDirectoryTree(c.paths.candidatePath, { reparseInspector: noReparse });
      const journalBefore = fs.readFileSync(path.join(corruption === 'candidate-identity'
        ? path.join(c.root, 'saved-candidate-identity') : c.paths.candidatePath,
      '.minecraft-core-state', 'operations', jobId, 'journal.json'));
      await assert.rejects(c.rollback(), { code: 'RECOVERY_REQUIRED' });
      assert.deepEqual(await c.registry.load(jobId), before);
      assert.equal(await c.registry.loadHistory(jobId), null);
      assert.deepEqual(await inspectServerDirectoryTree(c.paths.rollbackPath, { reparseInspector: noReparse }), originalBefore);
      assert.deepEqual(await inspectServerDirectoryTree(c.paths.candidatePath, { reparseInspector: noReparse }), candidateBefore);
      assert.deepEqual(fs.readFileSync(path.join(corruption === 'candidate-identity'
        ? path.join(c.root, 'saved-candidate-identity') : c.paths.candidatePath,
      '.minecraft-core-state', 'operations', jobId, 'journal.json')), journalBefore);
      assert.equal(fs.existsSync(c.targetPath), corruption === 'unresolved-topology');
      assert.equal(fs.existsSync(c.paths.failedPath), false);
      assert.equal(fs.readFileSync(c.unrelated, 'utf8'), 'never owned by this operation');
    });
    await assert.rejects(value.coordinator.acquireStart(value.selector,
      { operation: 'ordinary-start', operationId: 'blocked-start', parentMutationLease: null }), { code: 'RECOVERY_REQUIRED' });
  });
}

// Regressions: the new live-moved branch must not change established prepared
// failure disposition or the normal candidate-published rollback disposition.
for (const [fault, action, phase] of [['prepared', 'pre-swap-restored', 'failed'], [null, 'rollback-restored', 'rolled-back']]) {
  test(`existing ${fault || 'candidate-published'} rollback keeps its historical disposition`, async t => {
    const value = await fixture(t, fault);
    await value.run(async c => {
      const result = await c.rollback();
      assert.equal(result.action, action);
      await assertOriginal(c);
      assert.equal(fs.existsSync(c.paths.candidatePath), false);
      assert.equal(fs.existsSync(c.paths.rollbackPath), false);
      assert.equal(fs.existsSync(c.paths.failedPath), phase === 'rolled-back');
      assert.equal((await c.registry.loadHistory(jobId)).phase, phase);
      return result;
    });
    await assertReleased(value);
  });
}

// Regression: once durable healthy commit is recorded, rollback must refuse
// without moving the live tree or disposing its rollback evidence.
test('committed-healthy rollback refusal preserves published bytes and recovery block', async t => {
  const value = await fixture(t, null);
  await value.run(async c => {
    await c.registry.transition(jobId, { expectedPhase: 'starting', nextPhase: 'validating-live', patch: {} });
    await c.registry.transition(jobId, { expectedPhase: 'validating-live', nextPhase: 'committed-healthy', patch: {} });
    const before = await c.registry.load(jobId);
    await assert.rejects(c.rollback(), { code: 'RECOVERY_REQUIRED' });
    assert.deepEqual(await c.registry.load(jobId), before);
    assert.equal(await c.registry.loadHistory(jobId), null);
    assert.equal(fs.readFileSync(path.join(c.targetPath, 'server.jar'), 'utf8'), 'owned candidate server');
    assert.equal(fs.readFileSync(path.join(c.paths.rollbackPath, 'server.jar'), 'utf8'), 'exact original server');
    assert.equal(fs.existsSync(c.paths.candidatePath), false);
    assert.equal(fs.existsSync(c.paths.failedPath), false);
  });
  await assert.rejects(value.coordinator.acquireStart(value.selector,
    { operation: 'ordinary-start', operationId: 'blocked-start', parentMutationLease: null }), { code: 'RECOVERY_REQUIRED' });
});
