const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ReleaseActionExecutor,
  ReleaseNotificationReferenceAuthority
} = require('../../electron/services/modpacks/notifications/release-action-authority.cjs');

function fixture() {
  const tracking = {
    trackingId: 'tracking-one', serverId: 'server-one', provider: 'github',
    lastSnapshot: { releaseId: 'release-200', version: 'v2', prerelease: false }
  };
  const notifications = [{
    notificationId: 'notification-one', serverId: 'server-one',
    release: { releaseId: 'release-200', version: 'v2', prerelease: false },
    action: { actionId: 'open-details', opaqueRef: 'release-review:tracking-one:release-200' }
  }, {
    notificationId: 'notification-two', serverId: 'server-one', release: null,
    action: { actionId: 'retry', opaqueRef: 'release-check:tracking-one' }
  }];
  const trackingStore = {
    async get(id) { return id === tracking.trackingId ? tracking : null; }
  };
  const notificationStore = {
    async list() { return notifications; }
  };
  let claimId = 0;
  return {
    notifications,
    tracking,
    authority: new ReleaseNotificationReferenceAuthority({
      notificationStore,
      trackingStore,
      randomUUID: () => `claim-${++claimId}`
    })
  };
}

test('claims only exact durable release notifications and returns closed authority-free targets', async () => {
  const context = fixture();
  const review = await context.authority.claim({
    actionId: 'open-details', opaqueRef: 'release-review:tracking-one:release-200'
  });
  assert.deepEqual(review.reference, {
    actionId: 'open-details',
    targetKind: 'details',
    targetId: 'release:tracking-one:release-200'
  });
  assert.doesNotMatch(JSON.stringify(review), /(?:path|url|directory|token|secret)/i);
  assert.equal(await context.authority.complete(review.claimId), true);
  const reopened = await context.authority.claim({
    actionId: 'open-details', opaqueRef: 'release-review:tracking-one:release-200'
  });
  assert.equal(await context.authority.complete(reopened.claimId), true);

  const retry = await context.authority.claim({ actionId: 'retry', opaqueRef: 'release-check:tracking-one' });
  assert.deepEqual(retry.reference, { actionId: 'retry', targetKind: 'retry', targetId: 'tracking-one' });
  assert.equal(await context.authority.release(retry.claimId), true);
});

test('rejects forged mismatched stale and concurrent references before any action can run', async () => {
  const context = fixture();
  for (const request of [
    { actionId: 'choose-another-asset', opaqueRef: 'release-review:tracking-one:release-200' },
    { actionId: 'open-details', opaqueRef: 'release-review:tracking-one:release-201' },
    { actionId: 'retry', opaqueRef: 'release-check:tracking-two' },
    { actionId: 'retry', opaqueRef: 'release-check:tracking-one', path: 'C:\\private' }
  ]) {
    await assert.rejects(context.authority.claim(request), error => error.code === 'INVALID_REQUEST');
  }

  const request = { actionId: 'retry', opaqueRef: 'release-check:tracking-one' };
  const first = await context.authority.claim(request);
  await assert.rejects(context.authority.claim(request), error => error.code === 'INVALID_REQUEST');
  assert.equal(await context.authority.release(first.claimId), true);
});

test('retry executor binds the exact tracking record to one forced monitor check', async () => {
  const calls = [];
  const executor = new ReleaseActionExecutor({
    releaseMonitor: {
      async checkOne(trackingId, options) { calls.push([trackingId, options]); return { checked: true }; }
    }
  });
  assert.deepEqual(await executor.execute({ actionId: 'retry', targetKind: 'retry', targetId: 'tracking-one' }), {
    status: 'completed', referenceId: 'release-check:tracking-one'
  });
  assert.deepEqual(calls, [['tracking-one', { force: true }]]);
  await assert.rejects(
    executor.execute({ actionId: 'retry', targetKind: 'retry', targetId: 'tracking-one', extra: true }),
    error => error.code === 'INVALID_REQUEST'
  );
});
