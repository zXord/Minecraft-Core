const assert = require('node:assert/strict');
const test = require('node:test');

const { OutcomeActionService } = require('../../electron/services/modpack-lifecycle/outcome-action-service.cjs');
const { ModpackError, deepFreeze } = require('../../electron/services/modpacks/errors.cjs');

function authority(records) {
  const values = new Map(Object.entries(records));
  const active = new Set();
  const consumed = new Set();
  const calls = [];
  return {
    calls,
    async claim(request) {
      calls.push(['claim', request]);
      const value = values.get(request.opaqueRef);
      if (!value || value.actionId !== request.actionId || active.has(request.opaqueRef) || consumed.has(request.opaqueRef)) {
        throw new ModpackError('INVALID_REQUEST', 'The outcome action reference is invalid');
      }
      active.add(request.opaqueRef);
      return deepFreeze({ claimId: `claim:${request.opaqueRef}`, reference: value });
    },
    async complete(claimId) {
      calls.push(['complete', claimId]);
      const opaqueRef = claimId.slice('claim:'.length);
      if (!active.delete(opaqueRef)) return false;
      consumed.add(opaqueRef);
      return true;
    },
    async release(claimId) {
      calls.push(['release', claimId]);
      return active.delete(claimId.slice('claim:'.length));
    }
  };
}

function reference(actionId, targetKind, targetId, extra = {}) {
  return deepFreeze({ actionId, targetKind, targetId, ...extra });
}

function fixture(records, { removeResult = true, execute = null } = {}) {
  const referenceAuthority = authority(records);
  const calls = [];
  const service = new OutcomeActionService({
    referenceAuthority,
    artifactCache: {
      async removeIfUnreferenced(sha256) { calls.push(['removeIfUnreferenced', sha256]); return removeResult; }
    },
    controlledFolderOpener: {
      async openCacheParent(...args) { calls.push(['openCacheParent', args]); }
    },
    actionExecutor: {
      async execute(request) {
        calls.push(['execute', request]);
        return execute ? execute(request) : { status: 'started', referenceId: `operation:${request.targetId}` };
      }
    }
  });
  return { calls, referenceAuthority, service };
}

test('retained-download folder action opens only the internally configured cache parent', async () => {
  const sha256 = 'a'.repeat(64);
  const context = fixture({
    'retained:one': reference(
      'open-retained-download-folder', 'retained-download', 'download-one', { cacheSha256: sha256 }
    )
  });

  const result = await context.service.performSafeAction({
    actionId: 'open-retained-download-folder',
    opaqueRef: 'retained:one'
  });

  assert.deepEqual(context.calls, [['openCacheParent', []]]);
  assert.deepEqual(result, {
    type: 'outcome-action-result',
    actionId: 'open-retained-download-folder',
    status: 'opened',
    destination: { kind: 'controlled-cache-parent' }
  });
  assert.doesNotMatch(JSON.stringify(result), /(?:path|url|directory|cacheSha256)/i);
});

test('retained-download removal delegates to reference-counted cache deletion and rejects replay', async () => {
  const sha256 = 'b'.repeat(64);
  const context = fixture({
    'remove:one': reference('remove-retained-download', 'retained-download', 'download-one', { cacheSha256: sha256 })
  }, { removeResult: false });

  const result = await context.service.performSafeAction({
    actionId: 'remove-retained-download',
    opaqueRef: 'remove:one'
  });

  assert.deepEqual(context.calls, [['removeIfUnreferenced', sha256]]);
  assert.deepEqual(result, {
    type: 'outcome-action-result',
    actionId: 'remove-retained-download',
    status: 'retained',
    removed: false
  });
  await assert.rejects(
    context.service.performSafeAction({ actionId: 'remove-retained-download', opaqueRef: 'remove:one' }),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.deepEqual(context.calls, [['removeIfUnreferenced', sha256]]);
});

test('review and navigation actions return only closed opaque destinations', async () => {
  const destinations = new Map([
    ['change-selection', 'selection'],
    ['open-details', 'details'],
    ['choose-another-asset', 'asset-selection'],
    ['return-to-server', 'server'],
    ['review-restore-point', 'restore-point'],
    ['review-recovery', 'recovery']
  ]);
  const records = {};
  for (const [actionId, targetKind] of destinations) {
    records[`ref:${actionId}`] = reference(actionId, targetKind, `${targetKind}-one`);
  }
  const context = fixture(records);

  for (const [actionId, targetKind] of destinations) {
    const result = await context.service.performSafeAction({ actionId, opaqueRef: `ref:${actionId}` });
    assert.deepEqual(result, {
      type: 'outcome-action-result',
      actionId,
      status: 'ready',
      destination: { kind: targetKind, targetId: `${targetKind}-one` }
    });
    assert.doesNotMatch(JSON.stringify(result), /(?:path|url|directory|cache|workspace|command|token|secret|password)/i);
  }
  assert.deepEqual(context.calls, []);
});

test('retry and recovery actions execute only their reference-bound backend target', async () => {
  const targets = new Map([
    ['retry', 'retry'],
    ['restart-and-recover', 'recovery'],
    ['restore-from-restore-point', 'restore-point']
  ]);
  const records = {};
  for (const [actionId, targetKind] of targets) {
    records[`ref:${actionId}`] = reference(actionId, targetKind, `${targetKind}-one`);
  }
  const context = fixture(records);

  for (const [actionId, targetKind] of targets) {
    const result = await context.service.performSafeAction({ actionId, opaqueRef: `ref:${actionId}` });
    assert.deepEqual(result, {
      type: 'outcome-action-result',
      actionId,
      status: 'started',
      operationRef: `operation:${targetKind}-one`
    });
  }
  assert.deepEqual(context.calls, [...targets].map(([actionId, targetKind]) => ['execute', {
    actionId,
    targetKind,
    targetId: `${targetKind}-one`
  }]));
});

test('forged, mismatched, replayed, and authority-bearing renderer requests never reach an action target', async () => {
  const sha256 = 'c'.repeat(64);
  const context = fixture({
    'open:once': reference('open-retained-download-folder', 'retained-download', 'download-one', { cacheSha256: sha256 }),
    'wrong:kind': reference('open-details', 'server', 'server-one')
  });

  for (const request of [
    { actionId: 'open-details', opaqueRef: 'forged:one' },
    { actionId: 'unknown-action', opaqueRef: 'open:once' },
    { actionId: 'open-details', opaqueRef: 'wrong:kind', path: 'C:\\private' },
    { actionId: 'open-details', opaqueRef: 'wrong:kind', url: 'https://example.invalid' }
  ]) {
    await assert.rejects(context.service.performSafeAction(request), error => error.code === 'INVALID_REQUEST');
  }
  assert.deepEqual(context.calls, []);

  const concurrent = await Promise.allSettled([
    context.service.performSafeAction({ actionId: 'open-retained-download-folder', opaqueRef: 'open:once' }),
    context.service.performSafeAction({ actionId: 'open-retained-download-folder', opaqueRef: 'open:once' })
  ]);
  assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(item => item.status === 'rejected' && item.reason.code === 'INVALID_REQUEST').length, 1);
  assert.deepEqual(context.calls, [['openCacheParent', []]]);
});

test('a claimed reference with the wrong backend target kind is released without performing an effect', async () => {
  const context = fixture({
    'wrong:kind': reference('open-details', 'server', 'server-one')
  });

  await assert.rejects(
    context.service.performSafeAction({ actionId: 'open-details', opaqueRef: 'wrong:kind' }),
    error => error.code === 'INVALID_REQUEST'
  );

  assert.deepEqual(context.calls, []);
  assert.deepEqual(context.referenceAuthority.calls.map(call => call[0]), ['claim', 'release']);
});
