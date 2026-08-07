const assert = require('node:assert/strict');
const test = require('node:test');

const { ModpackRecoveryFacade } = require('../../electron/services/modpack-lifecycle/modpack-recovery-facade.cjs');

function record(overrides = {}) {
  return {
    jobId: 'job-internal-one',
    operationKind: 'upgrade',
    phase: 'cleanup-pending',
    swapStep: 'candidate-published',
    target: {
      kind: 'existing',
      stableServerId: 'server-one',
      path: 'C:\\Minecraft\\Servers\\Private Pack'
    },
    ...overrides
  };
}

function fixture(records = [record()]) {
  const calls = [];
  let active = records;
  const recoveryRegistry = {
    async listActive() { return active; }
  };
  const recoveryService = {
    async recover(value) {
      calls.push(['recover', value]);
      return { jobId: value.jobId, resolved: true, action: 'internal-recovery-action', path: value.target.path };
    },
    async rollback(value, reason) {
      calls.push(['rollback', value, reason]);
      return { jobId: value.jobId, resolved: true, action: 'internal-rollback-action' };
    },
    async retryCommittedCleanup(value) {
      calls.push(['retryCommittedCleanup', value]);
      return { jobId: value.jobId, resolved: true, action: 'internal-cleanup-action' };
    }
  };
  return {
    calls,
    facade: new ModpackRecoveryFacade({ recoveryRegistry, recoveryService }),
    setActive(value) { active = value; }
  };
}

test('lists authority-free recovery DTOs with deterministic opaque IDs and closed actions', async () => {
  const { facade } = fixture();

  const first = await facade.listRecovery();
  const second = await facade.listRecovery();

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.items), true);
  assert.match(first.items[0].recoveryId, /^recovery-[a-f0-9]{32}$/);
  assert.equal(first.items[0].serverId, 'server-one');
  assert.equal(first.items[0].instanceId, 'server-one');
  assert.deepEqual(first.items[0].actions, [{
    actionId: 'retry-cleanup',
    label: 'Retry safe cleanup',
    recommended: true
  }]);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /Minecraft|Private Pack|job-internal-one|candidate-published/i);
  assert.equal(Object.hasOwn(first.items[0], 'path'), false);
});

test('re-resolves the opaque ID and dispatches only the action allowed by the current phase', async () => {
  const value = record();
  const context = fixture([value]);
  const listed = await context.facade.listRecovery();
  const recoveryId = listed.items[0].recoveryId;

  const result = await context.facade.recover({ recoveryId, actionId: 'retry-cleanup' });

  assert.deepEqual(context.calls, [['retryCommittedCleanup', value]]);
  assert.deepEqual(result, {
    recoveryId,
    serverId: 'server-one',
    actionId: 'retry-cleanup',
    resolved: true,
    status: 'resolved'
  });
  assert.doesNotMatch(JSON.stringify(result), /job-internal|internal-cleanup|Minecraft/i);
});

test('rejects stale IDs unknown actions and actions that became invalid without invoking recovery', async () => {
  const value = record();
  const context = fixture([value]);
  const recoveryId = (await context.facade.listRecovery()).items[0].recoveryId;

  await assert.rejects(
    context.facade.recover({ recoveryId: 'recovery-' + '0'.repeat(32), actionId: 'retry-cleanup' }),
    error => error.code === 'PLAN_STALE'
  );
  await assert.rejects(
    context.facade.recover({ recoveryId, actionId: 'rollback-server' }),
    error => error.code === 'INVALID_REQUEST'
  );

  context.setActive([record({ phase: 'starting' })]);
  await assert.rejects(
    context.facade.recover({ recoveryId, actionId: 'retry-cleanup' }),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.deepEqual(context.calls, []);
});

test('offers reviewed recovery and rollback only for a published existing-server topology', async () => {
  const value = record({ phase: 'validating-live' });
  const context = fixture([value]);
  const listed = await context.facade.listRecovery();
  assert.deepEqual(listed.items[0].actions, [
    { actionId: 'retry-recovery', label: 'Retry verified recovery', recommended: true },
    { actionId: 'rollback-server', label: 'Restore prior server', recommended: false }
  ]);

  await context.facade.recover({ recoveryId: listed.items[0].recoveryId, actionId: 'rollback-server' });
  assert.deepEqual(context.calls, [['rollback', value, 'user-reviewed-recovery']]);
});

test('never forwards renderer-shaped records or accepts prototype-bearing requests', async () => {
  const context = fixture();
  const listed = await context.facade.listRecovery();
  const request = Object.create({ path: 'C:\\attacker' });
  request.recoveryId = listed.items[0].recoveryId;
  request.actionId = 'retry-cleanup';

  await assert.rejects(context.facade.recover(request), error => error.code === 'INVALID_REQUEST');
  assert.deepEqual(context.calls, []);
});
