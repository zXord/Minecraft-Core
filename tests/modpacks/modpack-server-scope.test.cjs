const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const MODULE_URL = pathToFileURL(path.resolve(
  __dirname,
  '../../src/utils/modpacks/serverRequestScope.js'
)).href;

test('server request tokens stay stale across A to B to A switches', async () => {
  const { createServerRequestScope } = await import(`${MODULE_URL}?scope=${Date.now()}-${Math.random()}`);
  const scope = createServerRequestScope();

  assert.deepEqual(scope.activate('server-a'), { changed: true, serverId: 'server-a', epoch: 1 });
  const firstA = scope.begin();
  assert.equal(scope.isCurrent(firstA, 'server-a'), true);

  assert.deepEqual(scope.activate('server-b'), { changed: true, serverId: 'server-b', epoch: 2 });
  const serverB = scope.begin();
  assert.equal(scope.isCurrent(firstA, 'server-a'), false);
  assert.equal(scope.isCurrent(serverB, 'server-b'), true);

  assert.deepEqual(scope.activate('server-a'), { changed: true, serverId: 'server-a', epoch: 3 });
  const secondA = scope.begin();
  assert.equal(scope.isCurrent(firstA, 'server-a'), false);
  assert.equal(scope.isCurrent(serverB, 'server-b'), false);
  assert.equal(scope.isCurrent(secondA, 'server-a'), true);
});

test('empty and unchanged server activations are deterministic', async () => {
  const { createServerRequestScope } = await import(`${MODULE_URL}?scope=${Date.now()}-${Math.random()}`);
  const scope = createServerRequestScope('server-a');

  assert.deepEqual(scope.activate('server-a'), { changed: false, serverId: 'server-a', epoch: 0 });
  assert.deepEqual(scope.activate(''), { changed: true, serverId: '', epoch: 1 });
  assert.equal(scope.isCurrent(scope.begin(), ''), true);
  assert.throws(() => scope.activate('C:\\server'), TypeError);
});

test('reservation release coalesces an in-flight call and remains retryable after rejection', async () => {
  const { createRetryableReservationRelease } = await import(`${MODULE_URL}?release=${Date.now()}-${Math.random()}`);
  let calls = 0;
  let rejectFirst;
  const firstGate = new Promise((_resolve, reject) => { rejectFirst = reject; });
  const release = createRetryableReservationRelease(async instanceId => {
    calls += 1;
    assert.equal(instanceId, 'server-reserved-one');
    if (calls === 1) return firstGate;
    return true;
  });

  const first = release('server-reserved-one');
  const joined = release('server-reserved-one');
  assert.equal(first, joined);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  rejectFirst(new Error('transient IPC failure'));
  await assert.rejects(first, /transient IPC failure/);

  assert.equal(await release('server-reserved-one'), true);
  assert.equal(calls, 2);
});

test('destination recovery classification requires the exact closed terminal reason without invoking accessors', async () => {
  const { isNewServerDestinationRecoveryOutcome } = await import(`${MODULE_URL}?outcome=${Date.now()}-${Math.random()}`);

  assert.equal(isNewServerDestinationRecoveryOutcome({
    errorCode: 'RECOVERY_REQUIRED',
    failureReason: 'destination-recovery'
  }), true);
  assert.equal(isNewServerDestinationRecoveryOutcome({ errorCode: 'RECOVERY_REQUIRED' }), false);
  assert.equal(isNewServerDestinationRecoveryOutcome({
    errorCode: 'COMMIT_FAILED',
    failureReason: 'destination-recovery'
  }), false);

  let reads = 0;
  const hostile = { errorCode: 'RECOVERY_REQUIRED' };
  Object.defineProperty(hostile, 'failureReason', {
    enumerable: true,
    get() { reads += 1; return 'destination-recovery'; }
  });
  assert.equal(isNewServerDestinationRecoveryOutcome(hostile), false);
  assert.equal(reads, 0);
});

test('pending setup recovery filtering accepts only the explicit safe scope without invoking accessors', async () => {
  const { filterPendingNewServerRecoveryRecords } = await import(`${MODULE_URL}?pending=${Date.now()}-${Math.random()}`);
  const pending = {
    recoveryId: 'recovery-' + 'a'.repeat(32),
    visibilityScope: 'pending-new-server',
    actions: [{ actionId: 'retry-recovery', label: 'Resolve interrupted setup' }]
  };
  const registered = {
    recoveryId: 'recovery-' + 'b'.repeat(32),
    visibilityScope: 'registered-server'
  };
  const misleading = {
    recoveryId: 'pending-' + 'c'.repeat(32),
    visibilityScope: 'registered-server'
  };
  let scopeReads = 0;
  let pathReads = 0;
  const hostile = { recoveryId: 'recovery-' + 'd'.repeat(32) };
  Object.defineProperty(hostile, 'visibilityScope', {
    enumerable: true,
    get() { scopeReads += 1; return 'pending-new-server'; }
  });
  Object.defineProperty(hostile, 'path', {
    enumerable: true,
    get() { pathReads += 1; return 'C:\\private'; }
  });

  assert.deepEqual(
    filterPendingNewServerRecoveryRecords({ items: [pending, registered, misleading, hostile, null] }),
    [pending]
  );
  assert.deepEqual(filterPendingNewServerRecoveryRecords([pending]), [pending]);
  assert.deepEqual(filterPendingNewServerRecoveryRecords(null), []);
  assert.equal(scopeReads, 0);
  assert.equal(pathReads, 0);
});
