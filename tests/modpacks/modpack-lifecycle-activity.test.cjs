const assert = require('node:assert/strict');
const test = require('node:test');

const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationContext } = require('../../electron/services/server-mutation-context.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function lifecycle(overrides = {}) {
  return new ModpackLifecycleService({
    sourceResolver: { resolveArtifactSetPlan() {} },
    artifactDownloader: { downloadSet() {} },
    archiveInspector: { inspectArchive() {} },
    inspectionLoader: { loadInspection() {} },
    planningAdapter: { createPlan() {} },
    planRegistry: { create() {}, get() {}, claim() {} },
    operationStore: { get() {}, requestCancellation() {} },
    ...overrides
  });
}

async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  return done;
}

test('an admitted recovery is active work before it reaches its coordinator reservation', async () => {
  const service = lifecycle();
  const coordinator = new ServerMutationCoordinator({ context: createServerMutationContext(), readContentRevision: () => 0,
    bumpContentRevision() { assert.fail('recovery fixture never bumps a revision'); } });
  const selector = { instanceId: 'server-alpha', serverPath: 'C:\\Servers\\Alpha' };
  coordinator.installRecoveryBlocks([{ operationId: 'recovery-job', selector }]);
  coordinator.completeStartupRecovery([]);
  const admitted = deferred(); const reservationGate = deferred();
  // Production admits recovery as runAdmittedWork(() => recoveryFacade.recover(request));
  // the facade asks the coordinator for its reservation only later.
  const recovery = service.runAdmittedWork(async () => {
    admitted.resolve();
    await reservationGate.promise;
    return coordinator.runRecoveryMutation(selector, { operationId: 'recovery-job' }, async () => ({ resolved: true }));
  });
  await admitted.promise;
  assert.equal([...coordinator.records].some(record => record.mutation), false, 'the coordinator cannot see it yet');
  assert.equal(service.hasActiveWork(), true);
  const ids = service.listActiveOperationIds();
  assert.equal(ids.length, 1);
  assert.equal(Object.isFrozen(ids), true);
  assert.match(ids[0], /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  assert.deepEqual(service.listActiveOperationIds(), ids, 'the same admitted work keeps its identifier');
  assert.equal(await settled(service.drain()), false, 'quit would wait for the same work');

  reservationGate.resolve();
  assert.deepEqual(await recovery, { resolved: true });
  await service.drain();
  assert.equal(service.hasActiveWork(), false);
  assert.deepEqual(service.listActiveOperationIds(), []);
});

test('read-only state queries are never active work', async () => {
  const entered = deferred(); const gate = deferred();
  const service = lifecycle({
    instanceResolver: {
      async resolveInstance(instanceId) {
        entered.resolve();
        await gate.promise;
        return { instanceId, serverPath: 'C:\\Servers\\Alpha', priorRunning: false };
      }
    },
    stateRepository: { read() { return null; }, listHistory() { return { items: [], nextCursor: null }; } }
  });
  const reading = service.getState('server-alpha');
  await entered.promise;
  assert.equal(service.hasActiveWork(), false);
  assert.deepEqual(service.listActiveOperationIds(), []);
  assert.equal(await settled(service.drain()), true);
  gate.resolve();
  assert.equal((await reading).modpackManaged, false);
  assert.equal(service.hasActiveWork(), false);
});

test('running jobs and preflight inspections are listed once by their own identifiers', async () => {
  const service = lifecycle();
  const job = deferred(); const inspection = deferred(); const work = deferred();
  service.activeOperations.set('job-running', { settled: job.promise });
  service.planningInspections.set('inspection-preparing', { settled: inspection.promise, planId: null });
  const admitted = service.runAdmittedWork(() => work.promise);
  const ids = service.listActiveOperationIds();
  assert.equal(service.hasActiveWork(), true);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids.includes('job-running'), true);
  assert.equal(ids.includes('inspection-preparing'), true);

  const draining = service.drain();
  work.resolve(); await admitted;
  service.planningInspections.delete('inspection-preparing'); inspection.resolve();
  assert.deepEqual(service.listActiveOperationIds(), ['job-running']);
  assert.equal(await settled(draining), false);
  service.activeOperations.delete('job-running'); job.resolve();
  await draining;
  assert.equal(service.hasActiveWork(), false);
  assert.deepEqual(service.listActiveOperationIds(), []);
});
