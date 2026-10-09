const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const { ModpackRecoveryService } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
const { ServerRuntimeWriterAuthority } = require('../../electron/services/modpack-lifecycle/server-runtime-writer-authority.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationContext } = require('../../electron/services/server-mutation-context.cjs');
const { RestorePointService } = require('../../electron/services/modpack-lifecycle/restore-point-service.cjs');
const { inspectServerDirectoryTree } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');

// Only the OS durability transport is controlled. Record/envelope validation,
// compare-and-swap updates, terminal publication and history reads remain real.
function fixtureDurableFs(root) {
  return createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync,
    async moveWriteThroughAsync(from, to) { await fs.promises.rename(from, to); },
    async replaceFileWriteThroughAsync(from, to) { await fs.promises.rename(from, to); },
    flushDirectory() {}, async flushDirectoryAsync() {}
  } });
}

function fixtureRegistry(root, {
  createErrorAfterRecord = null, createErrorBeforeRecord = null,
  includeInitialize = true, initializeResult = null,
  onCreate = () => {}, onTransition = () => {}
} = {}) {
  const userDataPath = path.join(root, 'recovery-data');
  fs.mkdirSync(userDataPath);
  const registry = new RecoveryRegistry({ userDataPath, durableFs: fixtureDurableFs(root) });
  const ready = registry.initialize();
  let observed = null;
  let finishCalls = 0;
  const load = registry.load.bind(registry);
  const create = registry.create.bind(registry);
  const transition = registry.transition.bind(registry);
  const finish = registry.finish.bind(registry);
  const initialize = registry.initialize.bind(registry);
  Object.defineProperties(registry, {
    record: { get: () => observed && structuredClone(observed) },
    finishCalls: { get: () => finishCalls },
    ready: { value: ready }
  });
  registry.load = async (...args) => { observed = await load(...args); return observed; };
  registry.create = async value => {
    onCreate(value);
    if (createErrorBeforeRecord) throw createErrorBeforeRecord;
    observed = await create(value);
    if (createErrorAfterRecord) throw createErrorAfterRecord;
    return observed;
  };
  registry.transition = async (jobId, request) => {
    onTransition(request);
    observed = await transition(jobId, request);
    return observed;
  };
  registry.finish = async (...args) => {
    finishCalls++;
    const result = await finish(...args);
    observed = await load(args[0]);
    return result;
  };
  registry.initialize = includeInitialize ? async () => initializeResult || initialize() : undefined;
  return registry;
}

function fixtureAuthority({ instanceId, serverPath, jobId, baseRevision = 0, registry, observeDirtyCalls = false }) {
  let activeLease = null;
  let dirtyCalls = 0;
  const coordinator = new ServerMutationCoordinator({ context: createServerMutationContext(),
    readContentRevision: () => baseRevision,
    bumpContentRevision() { assert.fail('partial fixture must not manufacture a content revision'); }
  });
  coordinator.completeStartupRecovery([]);
  const selector = { instanceId, serverPath };
  return {
    coordinator, selector,
    get dirtyCalls() { return dirtyCalls; },
    get lease() {
      assert.ok(activeLease, 'fixture operations must stay inside the awaited mutation callback');
      return activeLease;
    },
    async run(work, { operationId = jobId } = {}) {
      await registry?.ready;
      // Materialization/management boundary fixtures do not swap a canonical
      // tree or publish a live revision. They deliberately use none, not an
      // unconditional fake lifecycle increment. New targets also use none in
      // production. Completed existing lifecycles use the real lifecycle suites,
      // not this partial-boundary helper with its immutable revision reader.
      return coordinator.runMutation(selector, { operation: 'modpack-lifecycle', operationId, revisionMode: 'none' }, async lease => {
        activeLease = lease;
        assert.equal(lease.baseRevision, baseRevision);
        // Observe the real backing flag without replacing the opaque frozen
        // lease or changing what its markDirty closure writes.
        const state = observeDirtyCalls ? coordinator.leaseStates.get(lease) : null;
        let dirty = state?.dirty;
        if (state) Object.defineProperty(state, 'dirty', { configurable: true,
          get() { return dirty; }, set(value) { if (value) dirtyCalls++; dirty = value; }
        });
        try { return await work(lease); } finally {
          if (state) Object.defineProperty(state, 'dirty', { configurable: true, enumerable: true, writable: true, value: dirty });
          activeLease = null;
        }
      });
    }
  };
}

async function recordFixtureCandidate(registry, context) {
  const current = await registry.load(context.jobId);
  const evidence = await inspectServerDirectoryTree(context.candidatePath, { reparseInspector: context.reparseInspector });
  assert.equal(evidence.entryCount, 0, 'record ownership immediately after operation-owned candidate creation');
  await registry.transition(context.jobId, { expectedPhase: current.phase, nextPhase: current.phase,
    patch: { directoryIdentities: { ...current.directoryIdentities, candidate: evidence.directoryIdentity } }
  });
}

function fixtureRestorePreparation(root, request, options) {
  const service = new RestorePointService({ durableFs: fixtureDurableFs(root),
    extractVerifiedArchiveFn: async () => assert.fail('restore extraction is outside preparation-only fixture') });
  return service.prepareVerifiedRestorePointCreation(request, options);
}

function fixtureRecovery({ authority, registry, durableFs, runtimePolicy, reparseInspector,
  healthValidator, onRecoverWithLease = () => {}, onFailNewWithLease = () => {} }) {
  // Candidate materialization callers may control the worker transport in a
  // partial-scope test. That double is never source-closure authority: recovery
  // uses real writer assertion, coordinator binding, directory identity proof,
  // quarantine and authenticated active/history evidence below.
  const writerAuthority = new ServerRuntimeWriterAuthority({ registry, coordinator: authority.coordinator, getBootSequence: () => 1 });
  const service = new ModpackRecoveryService({ coordinator: authority.coordinator, recoveryRegistry: registry,
    runtimePolicy, runtimeWriterAuthority: writerAuthority,
    contextFactory: async ({ record, mutationLease }) => ({ fsApi: fs, durableFs, reparseInspector,
      jobId: record.jobId, mutationLease, targetPath: record.target.path,
      operationKind: record.operationKind, stableInstanceId: record.target.stableServerId,
      recoveryRegistry: registry, runtimePolicy,
      // The real recovery service derives source configuration from its bound
      // durable outcome. Resolving configuration does not itself launch a JVM.
      healthValidator: healthValidator || { async validateLive() { assert.fail('pre-publication fixture recovery must not boot a server'); } }
    })
  });
  const recover = service.recoverWithLease.bind(service);
  const failNew = service.failNewWithLease.bind(service);
  service.recoverWithLease = async (record, lease) => { onRecoverWithLease(record, lease); return recover(record, lease); };
  service.failNewWithLease = async (...args) => { onFailNewWithLease(...args); return failNew(...args); };
  return service;
}

module.exports = { fixtureAuthority, fixtureDurableFs, fixtureRegistry, fixtureRecovery,
  recordFixtureCandidate, fixtureRestorePreparation };
