const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEGACY_FALLBACK_STATES,
  MAX_STARTUP_ISSUES,
  MODPACK_SERVICE_STATES,
  RECOVERY_GATE_BASES,
  STARTUP_FAILURE_REASONS,
  STARTUP_STATUSES,
  createStartupHealth,
  createStartupHealthTracker,
  describeStartupFailure
} = require('../electron/bootstrap/startup-health.cjs');

function isDeeplyFrozen(value) {
  if (!value || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeeplyFrozen);
}

function unexpectedFailure(stage = 'recovery') {
  return describeStartupFailure(new Error('composition failed'), { stage });
}

test('the documented health vocabularies are frozen', () => {
  assert.deepEqual(STARTUP_STATUSES, ['starting', 'ready', 'degraded']);
  assert.deepEqual(MODPACK_SERVICE_STATES, ['pending', 'ready', 'unavailable']);
  assert.deepEqual(LEGACY_FALLBACK_STATES, ['active', 'inactive']);
  assert.deepEqual(STARTUP_FAILURE_REASONS, [
    'archive-worker-missing', 'archive-worker-blocked', 'profile-on-network-share', 'unexpected'
  ]);
  assert.deepEqual(RECOVERY_GATE_BASES, ['boundary', 'no-recovery-records', 'read-only-scan', 'unreadable', 'unsettled']);
  for (const list of [STARTUP_STATUSES, MODPACK_SERVICE_STATES, LEGACY_FALLBACK_STATES, STARTUP_FAILURE_REASONS, RECOVERY_GATE_BASES]) {
    assert.equal(Object.isFrozen(list), true);
  }
});

test('the default health model is a deeply frozen starting snapshot with exactly the documented keys', () => {
  const health = createStartupHealth();

  assert.deepEqual(Object.keys(health), ['status', 'modpackServices', 'legacyFallbacks', 'failure', 'recoveryGate', 'issues']);
  assert.deepEqual(health, {
    status: 'starting',
    modpackServices: 'pending',
    legacyFallbacks: 'inactive',
    failure: null,
    recoveryGate: null,
    issues: []
  });
  assert.equal(isDeeplyFrozen(health), true);
});

test('a degraded model keeps frozen copies of its failure, recovery gate and issues', () => {
  const blockedServers = [{ instanceId: 'alpha', label: 'Alpha', operationId: 'job-alpha' }, 'beta'];
  const recoveryGate = { basis: 'read-only-scan', globalBlock: false, blockedServers };
  const issue = describeStartupFailure(new Error('tray icon missing'), { stage: 'cleanup' });
  const health = createStartupHealth({
    status: 'degraded',
    modpackServices: 'unavailable',
    legacyFallbacks: 'active',
    failure: unexpectedFailure(),
    recoveryGate,
    issues: [issue]
  });

  blockedServers.push('gamma');
  blockedServers[0].label = 'Changed';
  recoveryGate.globalBlock = true;

  assert.equal(health.status, 'degraded');
  assert.equal(health.failure.reason, 'unexpected');
  assert.equal(health.failure.stage, 'recovery');
  assert.deepEqual(health.recoveryGate, {
    basis: 'read-only-scan',
    globalBlock: false,
    blockedServers: [{ instanceId: 'alpha', label: 'Alpha', operationId: 'job-alpha' }, 'beta']
  });
  assert.deepEqual(health.issues, [issue]);
  assert.equal(isDeeplyFrozen(health), true);
});

test('invalid or contradictory health models are refused', () => {
  const failure = unexpectedFailure();
  const invalid = [
    null,
    'ready',
    { status: 'broken' },
    { modpackServices: 'maybe' },
    { legacyFallbacks: 'sometimes' },
    { status: 'degraded', modpackServices: 'unavailable' },
    { status: 'degraded', modpackServices: 'ready', failure },
    { status: 'ready', modpackServices: 'ready', failure },
    { status: 'ready', modpackServices: 'unavailable' },
    { failure: { ...failure, reason: 'made-up' } },
    { status: 'degraded', modpackServices: 'unavailable', failure: { ...failure, summary: '' } },
    { recoveryGate: { basis: 'guess', globalBlock: true, blockedServers: [] } },
    { recoveryGate: { basis: 'boundary', globalBlock: 'yes', blockedServers: [] } },
    { recoveryGate: { basis: 'boundary', globalBlock: true, blockedServers: 'alpha' } },
    { recoveryGate: { basis: 'boundary', globalBlock: true, blockedServers: [{ nested: { deep: true } }] } },
    { recoveryGate: { basis: 'boundary', globalBlock: true, blockedServers: [''] } },
    { issues: 'none' },
    { issues: [{ ...failure, reason: 'made-up' }] },
    { issues: Array.from({ length: MAX_STARTUP_ISSUES + 1 }, () => unexpectedFailure('cleanup')) }
  ];
  for (const input of invalid) {
    assert.throws(() => createStartupHealth(input), TypeError, JSON.stringify(input));
  }
});

test('the tracker publishes frozen snapshots from starting to ready and records bounded issues', () => {
  const tracker = createStartupHealthTracker();
  const initial = tracker.snapshot();
  assert.equal(initial.status, 'starting');

  const withIssue = tracker.recordIssue('server-config', new Error('selected server config unreadable'));
  assert.equal(withIssue.issues.length, 1);
  assert.equal(withIssue.issues[0].stage, 'server-config');
  assert.equal(withIssue.issues[0].reason, 'unexpected');
  assert.equal(initial.issues.length, 0, 'earlier snapshots never change');

  const ready = tracker.markReady({ recoveryGate: { basis: 'boundary', globalBlock: false, blockedServers: [] } });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.modpackServices, 'ready');
  assert.equal(ready.legacyFallbacks, 'inactive');
  assert.equal(ready.failure, null);
  assert.equal(ready.recoveryGate.basis, 'boundary');
  assert.equal(ready.issues.length, 1);
  assert.equal(tracker.snapshot(), ready);

  for (let index = 0; index < MAX_STARTUP_ISSUES + 5; index += 1) {
    tracker.recordIssue(`stage-${index}`, new Error(`issue ${index}`));
  }
  assert.equal(tracker.snapshot().issues.length, MAX_STARTUP_ISSUES);
  assert.equal(tracker.snapshot().issues[0].stage, 'server-config', 'the earliest issues are kept');
  assert.equal(isDeeplyFrozen(tracker.snapshot()), true);
});

test('degraded health is sticky, keeps the first failure and describes it with the tracker context', () => {
  const tracker = createStartupHealthTracker({
    userDataPath: 'C:\\Users\\fixture\\AppData\\Roaming\\Minecraft Core',
    workerPath: 'C:\\fixture\\resources\\archive\\worker\\ArchiveWorker.exe',
    existsSync: () => false
  });
  const unavailable = Object.assign(new Error('The protected archive worker is unavailable'), { code: 'EXTRACTOR_UNAVAILABLE' });

  const degraded = tracker.markDegraded({
    stage: 'recovery',
    error: unavailable,
    recoveryGate: { basis: 'no-recovery-records', globalBlock: false, blockedServers: [] }
  });

  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.modpackServices, 'unavailable');
  assert.equal(degraded.legacyFallbacks, 'active');
  assert.equal(degraded.failure.stage, 'recovery');
  assert.equal(degraded.failure.reason, 'archive-worker-missing');
  assert.equal(degraded.recoveryGate.basis, 'no-recovery-records');
  assert.equal(tracker.markReady(), degraded, 'ready never replaces degraded');
  assert.equal(tracker.markDegraded({ stage: 'composition', error: new Error('second') }), degraded);
  assert.equal(tracker.snapshot().failure.stage, 'recovery');
});

test('a tracker refuses an invalid recovery gate without changing its published snapshot', () => {
  const tracker = createStartupHealthTracker();
  const before = tracker.snapshot();
  assert.throws(() => tracker.markDegraded({
    stage: 'recovery',
    error: new Error('failed'),
    recoveryGate: { basis: 'guess', globalBlock: true, blockedServers: [] }
  }), TypeError);
  assert.equal(tracker.snapshot(), before);
});
