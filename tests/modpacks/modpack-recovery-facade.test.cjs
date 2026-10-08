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

function fixture(records = [record()], {
  canExposePendingNewServer = () => true,
  onResolved = null
} = {}) {
  const calls = [];
  const reconciliations = [];
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
    reconciliations,
    facade: new ModpackRecoveryFacade({
      recoveryRegistry,
      recoveryService,
      canExposePendingNewServer,
      onResolved: onResolved || (async jobId => { reconciliations.push(jobId); return true; })
    }),
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
  assert.equal(first.items[0].visibilityScope, 'registered-server');
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
    status: 'resolved',
    operationStateReconciled: true
  });
  assert.deepEqual(context.reconciliations, ['job-internal-one']);
  assert.doesNotMatch(JSON.stringify(result), /job-internal|internal-cleanup|Minecraft/i);
});

test('unknown runtime closure is not advertised as a verified automatic cleanup option', async () => {
  for (const value of [record({ phase: 'validating-candidate' }), record({ outcome: { runtimeWriterAuthority: { state: 'unproven' } } })]) {
    const context = fixture([value]); const listed = (await context.facade.listRecovery()).items[0];
    assert.equal(listed.automaticPossible, false); assert.match(listed.summary, /shutdown.*not.*confirmed/i);
    assert.deepEqual(listed.actions, [{ actionId: 'retry-recovery', label: 'Recheck runtime shutdown', recommended: true }]);
    assert.equal(context.calls.length, 0);
    await context.facade.recover({ recoveryId: listed.recoveryId, actionId: 'retry-recovery' });
    assert.equal(context.calls[0][0], 'recover');
  }
});

test('declared pre-runtime failures keep ordinary recovery without suggesting a reboot', async () => {
  const context = fixture([record({ phase: 'validating-candidate', outcome: { runtimeWriterProtocol: 1 } })]);
  const listed = (await context.facade.listRecovery()).items[0];
  assert.equal(listed.automaticPossible, true); assert.doesNotMatch(listed.summary, /restart|shutdown/i);
});

test('marks an unpublished new-server recovery for setup without exposing its destination authority', async () => {
  const pending = record({
    operationKind: 'install-new',
    phase: 'validating-candidate',
    swapStep: 'not-started',
    target: {
      kind: 'new',
      path: 'C:\\Minecraft\\Servers\\Abandoned Setup'
    }
  });
  const context = fixture([pending]);

  const listed = await context.facade.listRecovery();

  assert.equal(listed.items[0].visibilityScope, 'pending-new-server');
  assert.deepEqual(listed.items[0].actions, [{
    actionId: 'resolve-interrupted-setup',
    label: 'Resolve interrupted setup',
    recommended: true
  }]);
  assert.doesNotMatch(JSON.stringify(listed), /Abandoned Setup|Minecraft|job-internal-one|not-started/i);
  assert.equal(Object.hasOwn(listed.items[0], 'path'), false);

  const result = await context.facade.recover({
    recoveryId: listed.items[0].recoveryId,
    actionId: 'resolve-interrupted-setup'
  });
  assert.deepEqual(context.calls, [['recover', pending]]);
  assert.equal(result.resolved, true);
});

test('rejects a pending setup action if registration authority changes before invocation', async () => {
  let mayExposePending = true;
  const pending = record({
    operationKind: 'install-new',
    phase: 'registering',
    swapStep: 'candidate-published',
    target: {
      kind: 'new',
      stableServerId: 'server-registration-race',
      path: 'C:\\Minecraft\\Servers\\Registration Race'
    },
    outcome: { registration: { instanceId: 'server-registration-race', complete: false } }
  });
  const context = fixture([pending], {
    canExposePendingNewServer: () => mayExposePending
  });
  const listed = await context.facade.listRecovery();
  const issuedActionId = listed.items[0].actions[0].actionId;

  assert.equal(listed.items[0].visibilityScope, 'pending-new-server');
  mayExposePending = false;

  await assert.rejects(
    context.facade.recover({ recoveryId: listed.items[0].recoveryId, actionId: issuedActionId }),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.deepEqual(context.calls, []);
});

test('does not route an already-published new-server recovery back into setup', async () => {
  const published = record({
    operationKind: 'install-new',
    phase: 'cleanup-pending',
    swapStep: 'candidate-published',
    target: { kind: 'new', stableServerId: 'published-server', path: 'C:\\private' },
    outcome: { registration: { complete: true } }
  });

  const listed = await fixture([published]).facade.listRecovery();

  assert.equal(listed.items[0].visibilityScope, 'registered-server');
  assert.equal(listed.items[0].serverId, 'published-server');
});

test('fails closed when pending-new-server visibility authority denies or cannot classify the target', async () => {
  const pending = record({
    operationKind: 'install-new',
    phase: 'registering',
    swapStep: 'candidate-published',
    target: {
      kind: 'new',
      stableServerId: 'server-registration-crash',
      path: 'C:\\Minecraft\\Servers\\Registration Crash'
    },
    outcome: { registration: { instanceId: 'server-registration-crash', complete: false } }
  });

  for (const canExposePendingNewServer of [
    () => false,
    () => { throw new Error('authoritative instance registry unavailable'); }
  ]) {
    const listed = await fixture([pending], { canExposePendingNewServer }).facade.listRecovery();

    assert.equal(listed.items[0].visibilityScope, 'registered-server');
    assert.deepEqual(listed.items[0].actions, [{
      actionId: 'retry-recovery',
      label: 'Retry verified recovery',
      recommended: true
    }]);
  }
});

test('reports a durable recovery as resolved when operation-state reconciliation must retry later', async () => {
  const context = fixture([record()], { onResolved: async () => { throw new Error('durable store unavailable'); } });
  const recoveryId = (await context.facade.listRecovery()).items[0].recoveryId;

  const result = await context.facade.recover({ recoveryId, actionId: 'retry-cleanup' });

  assert.equal(result.resolved, true);
  assert.equal(result.status, 'resolved');
  assert.equal(result.operationStateReconciled, false);
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

test('offers reviewed recovery and rollback only for a published existing-server topology with settled writers', async () => {
  const candidatePath = 'c:\\minecraft\\.candidate';
  const candidateIdentity = { volumeSerial: 'aa', fileId: 'bb' };
  const value = record({ phase: 'validating-live', candidatePath, directoryIdentities: { candidate: candidateIdentity },
    outcome: { runtimeWriterAuthority: { schemaVersion: 1, jobId: 'job-internal-one', candidatePath,
      candidateIdentity, bootSequence: 10, state: 'settled' } } });
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
