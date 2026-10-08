const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CompositeOutcomeActionExecutor,
  CompositeOutcomeReferenceAuthority,
  LifecycleOutcomeActionExecutor,
  LifecycleOutcomeActionIssuer,
  LifecycleOutcomeReferenceAuthority
} = require('../../electron/services/modpacks/notifications/lifecycle-outcome-actions.cjs');

function terminalJob({
  jobId = 'job-one',
  serverId = 'server-one',
  operationKind = 'install-existing',
  phase = 'failed',
  actions = []
} = {}) {
  return { jobId, serverId, operationKind, phase, outcome: { status: phase, actions } };
}

test('issuer exposes only durable actions with an implemented destination or effect', async () => {
  const issuer = new LifecycleOutcomeActionIssuer();
  const common = {
    jobId: 'job-one', operationKind: 'install-existing', instanceId: 'server-one',
    errorCode: null, plan: {}, restorePointId: null, automaticRecovery: false
  };

  assert.deepEqual(await issuer.issue({ ...common, phase: 'completed', status: 'completed' }), [
    { actionId: 'open-details', opaqueRef: 'oa:od:job-one' }
  ]);
  assert.deepEqual(await issuer.issue({ ...common, phase: 'failed', status: 'failed', errorCode: 'DOWNLOAD_FAILED' }), [
    { actionId: 'change-selection', opaqueRef: 'oa:cs:job-one' },
    { actionId: 'open-details', opaqueRef: 'oa:od:job-one' }
  ]);
  assert.deepEqual(await issuer.issue({ ...common, operationKind: 'verify', plan: null, phase: 'failed', status: 'failed' }), [
    { actionId: 'retry', opaqueRef: 'oa:rt:job-one' },
    { actionId: 'open-details', opaqueRef: 'oa:od:job-one' }
  ]);
  const singlePartPlan = { artifact: { setDigest: 'a'.repeat(64), parts: [{ sha256: 'b'.repeat(64) }] } };
  assert.deepEqual(await issuer.issue({ ...common, plan: singlePartPlan, phase: 'failed', status: 'failed' }), [
    { actionId: 'open-retained-download-folder', opaqueRef: `oa:of:job-one:${'a'.repeat(64)}` },
    { actionId: 'remove-retained-download', opaqueRef: `oa:rm:job-one:${'b'.repeat(64)}` },
    { actionId: 'choose-another-asset', opaqueRef: 'oa:ca:job-one' }
  ]);
  assert.deepEqual(await issuer.issue({
    ...common,
    plan: { artifact: { setDigest: 'c'.repeat(64), parts: [{ sha256: 'd'.repeat(64) }, { sha256: 'e'.repeat(64) }] } },
    phase: 'cancelled', status: 'cancelled'
  }), [
    { actionId: 'open-retained-download-folder', opaqueRef: `oa:of:job-one:${'c'.repeat(64)}` },
    { actionId: 'choose-another-asset', opaqueRef: 'oa:ca:job-one' }
  ]);
  assert.deepEqual(await issuer.issue({
    ...common, phase: 'rolled-back', status: 'rolled-back', restorePointId: 'restore-one'
  }), [
    { actionId: 'return-to-server', opaqueRef: 'oa:rs:job-one' },
    { actionId: 'review-restore-point', opaqueRef: 'oa:rp:job-one:restore-one' }
  ]);
  assert.deepEqual(await issuer.issue({
    ...common, phase: 'recovery-required', status: 'recovery-required', restorePointId: 'restore-one'
  }), [
    { actionId: 'review-recovery', opaqueRef: 'oa:rv:job-one' },
    { actionId: 'review-restore-point', opaqueRef: 'oa:rp:job-one:restore-one' },
    { actionId: 'open-details', opaqueRef: 'oa:od:job-one' }
  ]);
});

test('lifecycle authority revalidates the exact terminal operation and keeps navigation repeatable', async () => {
  const issued = [
    { actionId: 'change-selection', opaqueRef: 'oa:cs:job-one' },
    { actionId: 'open-details', opaqueRef: 'oa:od:job-one' }
  ];
  let job = terminalJob({ actions: issued });
  let uuid = 0;
  const authority = new LifecycleOutcomeReferenceAuthority({
    operationStore: { async get(id) { return id === 'job-one' ? job : null; } },
    randomUUID: () => `claim-${++uuid}`
  });

  const claim = await authority.claim(issued[0]);
  assert.deepEqual(claim.reference, {
    actionId: 'change-selection', targetKind: 'selection', targetId: 'server-one'
  });
  await assert.rejects(authority.claim(issued[0]), error => error.code === 'INVALID_REQUEST');
  assert.equal(await authority.complete(claim.claimId), true);
  const repeated = await authority.claim(issued[0]);
  assert.equal(await authority.complete(repeated.claimId), true);

  for (const forged of [
    { actionId: 'open-details', opaqueRef: 'oa:od:job-two' },
    { actionId: 'return-to-server', opaqueRef: 'oa:cs:job-one' },
    { actionId: 'review-restore-point', opaqueRef: 'oa:rp:job-one:restore-two' }
  ]) await assert.rejects(authority.claim(forged), error => error.code === 'INVALID_REQUEST');

  job = { ...job, phase: 'cleanup', outcome: null };
  await assert.rejects(authority.claim(issued[1]), error => error.code === 'INVALID_REQUEST');
});

test('execution references are single-use and run only exact verify or current recovery targets', async () => {
  const retryAction = { actionId: 'retry', opaqueRef: 'oa:rt:job-verify' };
  const authority = new LifecycleOutcomeReferenceAuthority({
    operationStore: {
      async get(id) {
        return id === 'job-verify'
          ? terminalJob({ jobId: id, operationKind: 'verify', actions: [retryAction] })
          : null;
      }
    },
    randomUUID: () => 'claim-one'
  });
  const claim = await authority.claim(retryAction);
  assert.deepEqual(claim.reference, { actionId: 'retry', targetKind: 'retry', targetId: 'job-verify' });
  assert.equal(await authority.complete(claim.claimId), true);
  await assert.rejects(authority.claim(retryAction), error => error.code === 'INVALID_REQUEST');

  const calls = [];
  const executor = new LifecycleOutcomeActionExecutor({
    operationStore: { async get(id) { return terminalJob({ jobId: id, operationKind: 'verify' }); } },
    getLifecycleService: () => ({
      async verify(instanceId) { calls.push(['verify', instanceId]); return { jobId: 'job-retry' }; }
    }),
    recoveryService: {
      async listRecovery() {
        return { items: [{ recoveryId: 'recovery-one', automaticPossible: true,
          actions: [{ actionId: 'retry-recovery', recommended: true }] }] };
      },
      async recover(request) { calls.push(['recover', request]); return { resolved: true }; }
    }
  });
  assert.deepEqual(await executor.execute({ actionId: 'retry', targetKind: 'retry', targetId: 'job-verify' }), {
    status: 'started', referenceId: 'job-retry'
  });
  assert.deepEqual(await executor.execute({
    actionId: 'restart-and-recover', targetKind: 'recovery', targetId: 'recovery-one'
  }), { status: 'completed', referenceId: 'recovery-one' });
  assert.deepEqual(calls, [
    ['verify', 'server-one'],
    ['recover', { recoveryId: 'recovery-one', actionId: 'retry-recovery' }]
  ]);
});

test('retained cache actions carry only a durable digest and never offer partial multipart deletion', async () => {
  const open = { actionId: 'open-retained-download-folder', opaqueRef: `oa:of:job-one:${'a'.repeat(64)}` };
  const remove = { actionId: 'remove-retained-download', opaqueRef: `oa:rm:job-one:${'b'.repeat(64)}` };
  const choose = { actionId: 'choose-another-asset', opaqueRef: 'oa:ca:job-one' };
  const authority = new LifecycleOutcomeReferenceAuthority({
    operationStore: { async get() { return terminalJob({ actions: [open, remove, choose] }); } },
    randomUUID: (() => { let id = 0; return () => `retained-${++id}`; })()
  });
  assert.deepEqual((await authority.claim(open)).reference, {
    actionId: 'open-retained-download-folder', targetKind: 'retained-download', targetId: 'job-one', cacheSha256: 'a'.repeat(64)
  });
  assert.deepEqual((await authority.claim(remove)).reference, {
    actionId: 'remove-retained-download', targetKind: 'retained-download', targetId: 'job-one', cacheSha256: 'b'.repeat(64)
  });
  assert.deepEqual((await authority.claim(choose)).reference, {
    actionId: 'choose-another-asset', targetKind: 'asset-selection', targetId: 'server-one'
  });
});

test('composites route opaque namespaces and execution targets without probing effects', async () => {
  const calls = [];
  function authority(name) {
    return {
      async claim(request) {
        calls.push([name, 'claim', request]);
        return { claimId: `${name}-claim`, reference: {
          actionId: request.actionId,
          targetKind: request.actionId === 'retry' ? 'retry' : 'details',
          targetId: request.opaqueRef
        } };
      },
      async complete(id) { calls.push([name, 'complete', id]); return true; },
      async release(id) { calls.push([name, 'release', id]); return true; }
    };
  }
  const composite = new CompositeOutcomeReferenceAuthority({
    lifecycleAuthority: authority('lifecycle'), releaseAuthority: authority('release')
  });
  const lifecycleClaim = await composite.claim({ actionId: 'open-details', opaqueRef: 'oa:od:job-one' });
  const releaseClaim = await composite.claim({ actionId: 'retry', opaqueRef: 'release-check:tracking-one' });
  assert.equal(await composite.complete(lifecycleClaim.claimId), true);
  assert.equal(await composite.release(releaseClaim.claimId), true);
  assert.deepEqual(calls.map(call => call[0]), ['lifecycle', 'release', 'lifecycle', 'release']);

  const executor = new CompositeOutcomeActionExecutor({
    lifecycleExecutor: { async execute(value) { return { status: 'started', referenceId: `l:${value.targetId}` }; } },
    releaseExecutor: { async execute(value) { return { status: 'completed', referenceId: `r:${value.targetId}` }; } }
  });
  assert.deepEqual(await executor.execute({ actionId: 'retry', targetKind: 'retry', targetId: 'job-one' }), {
    status: 'started', referenceId: 'l:job-one'
  });
  assert.deepEqual(await executor.execute({
    actionId: 'retry', targetKind: 'retry', targetId: `op2-${'a'.repeat(32)}`
  }), {
    status: 'started', referenceId: `l:op2-${'a'.repeat(32)}`
  });
  assert.deepEqual(await executor.execute({ actionId: 'retry', targetKind: 'retry', targetId: 'tracking-one' }), {
    status: 'completed', referenceId: 'r:tracking-one'
  });
});
