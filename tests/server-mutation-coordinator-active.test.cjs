const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ServerMutationCoordinator
} = require('../electron/services/server-mutation-coordinator.cjs');
const {
  createServerMutationContext
} = require('../electron/services/server-mutation-context.cjs');

const PATHS = Object.freeze({
  alpha: 'C:\\Minecraft\\Alpha',
  beta: 'C:\\Minecraft\\Beta',
  delta: 'C:\\Minecraft\\Delta',
  epsilon: 'C:\\Minecraft\\Epsilon',
  eta: 'C:\\Minecraft\\Eta',
  gamma: 'C:\\Minecraft\\Gamma',
  zeta: 'C:\\Minecraft\\Zeta'
});

function selector(name) {
  return { instanceId: name, serverPath: PATHS[name] };
}

function ordinaryOptions(operationId, overrides = {}) {
  return { operation: 'test-ordinary-write', operationId, revisionMode: 'none', quiesce: null, ordinary: true, ...overrides };
}

function startOptions(operationId) {
  return { operation: 'server-start', operationId, parentMutationLease: null };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function holdRun(start) {
  const signal = deferred();
  const gate = deferred();
  const run = start(async () => {
    signal.resolve();
    await gate.promise;
  });
  await Promise.race([
    signal.promise,
    run.then(() => {
      throw new Error('The run settled before its work started');
    })
  ]);
  return { gate, run };
}

function createCoordinator() {
  const coordinator = new ServerMutationCoordinator({
    context: createServerMutationContext(),
    readContentRevision: () => 0,
    bumpContentRevision: (_serverPath, { expectedRevision }) => expectedRevision + 1
  });
  return coordinator;
}

function byOperationId(entries) {
  return [...entries].sort((left, right) => (left.operationId < right.operationId ? -1 : 1));
}

test('listActiveOperations reports lifecycle, exclusive, shared and pending-start holders without changing state', async () => {
  const coordinator = createCoordinator();
  coordinator.completeStartupRecovery([]);
  assert.deepEqual(coordinator.listActiveOperations(), []);

  const holders = [
    await holdRun(work => coordinator.runMutation(selector('alpha'), {
      operation: 'update-managed', operationId: 'lifecycle-job', revisionMode: 'none', quiesce: null
    }, work)),
    await holdRun(work => coordinator.runMutation(selector('beta'), ordinaryOptions('restore-job', { stoppedOnly: true }), work)),
    await holdRun(work => coordinator.runManyMutations([selector('gamma'), selector('delta')], ordinaryOptions('save-job'), work)),
    await holdRun(work => coordinator.runMutation(selector('epsilon'), ordinaryOptions('player-job'), work)),
    await holdRun(work => coordinator.runMutation(selector('epsilon'), ordinaryOptions('settings-job'), work))
  ];
  const pendingStart = await coordinator.acquireStart(selector('zeta'), startOptions('pending-start'));
  const runningStart = await coordinator.acquireStart(selector('eta'), startOptions('running-start'));
  runningStart.markRunning({ pid: 5100 });

  const listed = coordinator.listActiveOperations();
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(listed.every(entry => Object.isFrozen(entry)), true);
  assert.deepEqual(byOperationId(listed), byOperationId([
    { operationId: 'lifecycle-job', operation: 'update-managed', holder: 'lifecycle', serverPath: PATHS.alpha },
    { operationId: 'restore-job', operation: 'test-ordinary-write', holder: 'ordinary-exclusive', serverPath: PATHS.beta },
    { operationId: 'save-job', operation: 'test-ordinary-write', holder: 'ordinary-exclusive', serverPath: PATHS.delta },
    { operationId: 'player-job', operation: 'test-ordinary-write', holder: 'ordinary-shared', serverPath: PATHS.epsilon },
    { operationId: 'settings-job', operation: 'test-ordinary-write', holder: 'ordinary-shared', serverPath: PATHS.epsilon },
    { operationId: 'pending-start', operation: 'server-start', holder: 'start-pending', serverPath: PATHS.zeta }
  ]));

  // Listing is read-only: the same holders are reported and still hold.
  assert.deepEqual(coordinator.listActiveOperations(), listed);
  await assert.rejects(
    coordinator.runMutation(selector('alpha'), ordinaryOptions('refused-writer'), async () => assert.fail('writer admitted')),
    error => error?.code === 'OPERATION_IN_PROGRESS' && error.details?.operationId === 'lifecycle-job'
  );

  pendingStart.release();
  runningStart.release();
  for (const holder of holders) holder.gate.resolve();
  await Promise.all(holders.map(holder => holder.run));
  assert.deepEqual(coordinator.listActiveOperations(), []);
});

test('listActiveOperations reports recovery work as a lifecycle holder', async () => {
  const coordinator = createCoordinator();
  coordinator.installRecoveryBlocks([{ operationId: 'recovery-job', selector: selector('alpha') }]);
  const recovery = await holdRun(work => coordinator.runRecoveryMutation(selector('alpha'), { operationId: 'recovery-job' }, work));
  assert.deepEqual(coordinator.listActiveOperations(), [
    { operationId: 'recovery-job', operation: 'modpack-recovery', holder: 'lifecycle', serverPath: PATHS.alpha }
  ]);
  recovery.gate.resolve();
  await recovery.run;
  assert.deepEqual(coordinator.listActiveOperations(), []);
});
