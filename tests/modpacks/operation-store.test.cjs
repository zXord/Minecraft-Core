const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const {
  JOB_PHASES,
  OperationStore,
  isLegalJobTransition
} = require('../../electron/services/modpack-lifecycle/operation-store.cjs');

const PHASES = [
  'queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'preflight',
  'snapshotting', 'staging', 'validating-candidate', 'committing', 'publishing', 'published', 'registering',
  'starting', 'validating-live', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed', 'cancelling',
  'cancelled', 'rolling-back', 'rolled-back', 'failed', 'recovery-required'
];

const MUTATION_TRANSITIONS = {
  queued: ['resolving', 'preflight', 'cancelling', 'failed'],
  resolving: ['downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'cancelling', 'failed'],
  downloading: ['verifying', 'cancelling', 'failed'],
  verifying: ['inspecting', 'cancelling', 'failed'],
  inspecting: ['planning', 'awaiting-user', 'cancelling', 'failed'],
  planning: ['awaiting-user', 'cancelling', 'failed'],
  'awaiting-user': ['preflight', 'cancelling', 'failed'],
  preflight: ['snapshotting', 'staging', 'cancelling', 'failed'],
  snapshotting: ['staging', 'cancelling', 'failed'],
  staging: ['validating-candidate', 'committing', 'cancelling', 'failed'],
  'validating-candidate': ['committing', 'cancelling', 'failed'],
  committing: ['publishing', 'starting', 'validating-live', 'rolling-back', 'recovery-required'],
  publishing: ['published', 'rolling-back', 'recovery-required'],
  published: ['registering', 'starting', 'validating-live', 'rolling-back', 'recovery-required'],
  registering: ['starting', 'validating-live', 'committed-healthy', 'rolling-back', 'recovery-required'],
  starting: ['validating-live', 'rolling-back', 'recovery-required'],
  'validating-live': ['committed-healthy', 'rolling-back', 'recovery-required'],
  'committed-healthy': ['cleanup', 'cleanup-pending'],
  cleanup: ['completed', 'cleanup-pending'],
  'cleanup-pending': ['cleanup', 'completed', 'recovery-required'],
  cancelling: ['cancelled', 'failed'],
  'rolling-back': ['rolled-back', 'recovery-required']
};

function fixture(t, { eventSink = () => {} } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-operation-store-'));
  let tempNumber = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      flushDirectory() {}
    },
    allowedRoots: [userDataPath],
    tempNameFactory: () => `operation-${++tempNumber}`
  });
  let now = Date.parse('2026-08-02T00:00:00.000Z');
  let id = 0;
  const dependencies = {
    userDataPath,
    fsApi: fs,
    durableFs,
    clock: () => new Date(now += 1000),
    randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    eventSink
  };
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return { dependencies, store: new OperationStore(dependencies), userDataPath };
}

function job(overrides = {}) {
  return {
    jobId: 'job-0001',
    operationKind: 'install-existing',
    serverId: 'server-0001',
    planFingerprint: 'a'.repeat(64),
    ...overrides
  };
}

test('the complete top-level phase graph rejects every unapproved mutation transition', () => {
  assert.deepEqual(JOB_PHASES, PHASES);
  for (const from of PHASES) {
    for (const to of PHASES) {
      const expected = (MUTATION_TRANSITIONS[from] || []).includes(to);
      assert.equal(
        isLegalJobTransition(from, to, { operationKind: 'install-existing' }),
        expected,
        `${from} -> ${to}`
      );
    }
  }
  assert.equal(isLegalJobTransition('queued', 'verifying', { operationKind: 'verify' }), true);
  assert.equal(isLegalJobTransition('verifying', 'completed', { operationKind: 'verify' }), true);
  assert.equal(isLegalJobTransition('verifying', 'completed', { operationKind: 'repair' }), false);
  assert.equal(isLegalJobTransition('unknown', 'failed', { operationKind: 'verify' }), false);
});

test('jobs reload from durable storage with monotonic compare-and-transition sequence', async (t) => {
  const { dependencies, store } = fixture(t);
  await store.initialize();
  const created = await store.create(job());
  assert.equal(created.sequence, 0);
  assert.equal(created.phase, 'queued');
  assert.equal(Object.isFrozen(created), true);

  const transitioned = await store.transition('job-0001', {
    expectedPhase: 'queued',
    nextPhase: 'preflight',
    patch: {
      progress: { percent: 10, message: 'Checking the reviewed plan', currentItem: null },
      swapStep: null
    }
  });
  assert.equal(transitioned.sequence, 1);
  assert.equal(transitioned.phase, 'preflight');
  assert.equal(transitioned.progress.percent, 10);

  const reloadedStore = new OperationStore(dependencies);
  await reloadedStore.initialize();
  const reloaded = await reloadedStore.get('job-0001');
  assert.deepEqual(reloaded, transitioned);
  await assert.rejects(
    reloadedStore.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'resolving', patch: {} }),
    error => error.code === 'PLAN_STALE'
  );
  const staged = await reloadedStore.transition('job-0001', {
    expectedPhase: 'preflight', nextPhase: 'staging', patch: { swapStep: 'candidate-prepared' }
  });
  assert.equal(staged.sequence, 2);
  assert.equal(staged.swapStep, 'candidate-prepared');
});

test('one terminal state is final and cancellation is accepted only before commit', async (t) => {
  const { store } = fixture(t);
  await store.initialize();
  await store.create(job({ jobId: 'job-cancel' }));
  const cancelling = await store.requestCancellation('job-cancel');
  assert.equal(cancelling.phase, 'cancelling');
  assert.equal(cancelling.cancellationRequested, true);
  assert.equal((await store.requestCancellation('job-cancel')).sequence, cancelling.sequence);
  const cancelled = await store.transition('job-cancel', {
    expectedPhase: 'cancelling',
    nextPhase: 'cancelled',
    patch: { outcome: { status: 'cancelled', message: 'Nothing changed' } }
  });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(typeof cancelled.terminalAt, 'string');
  await assert.rejects(
    store.transition('job-cancel', { expectedPhase: 'cancelled', nextPhase: 'failed', patch: { outcome: { status: 'failed' } } }),
    error => error.code === 'PLAN_STALE'
  );

  await store.create(job({ jobId: 'job-commit' }));
  await store.transition('job-commit', { expectedPhase: 'queued', nextPhase: 'preflight', patch: {} });
  await store.transition('job-commit', { expectedPhase: 'preflight', nextPhase: 'staging', patch: {} });
  await store.transition('job-commit', { expectedPhase: 'staging', nextPhase: 'committing', patch: {} });
  await assert.rejects(store.requestCancellation('job-commit'), error => error.code === 'PLAN_STALE');
  await assert.rejects(
    store.transition('job-commit', { expectedPhase: 'committing', nextPhase: 'recovery-required', patch: {} }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('job events are scoped by store authority and redact paths URLs and secrets', async (t) => {
  const emitted = [];
  const { store } = fixture(t, { eventSink: event => emitted.push(event) });
  await store.initialize();
  await store.create(job({ jobId: 'job-events' }));
  await store.create(job({ jobId: 'job-other' }));
  const updated = await store.appendEvent('job-events', {
    channel: 'log',
    message: 'Downloaded https://example.invalid/private?token=hunter2 to C:\\Servers\\Pack',
    details: {
      token: 'hunter2',
      archivePath: 'C:\\Servers\\Pack\\pack.zip',
      sourceUrl: 'https://example.invalid/private',
      releaseId: 'release-42'
    }
  });

  assert.equal(updated.sequence, 1);
  assert.equal(updated.events.length, 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].jobId, 'job-events');
  assert.equal(Object.isFrozen(emitted[0]), true);
  const serialized = JSON.stringify(emitted[0]);
  assert.doesNotMatch(serialized, /hunter2|example\.invalid|Servers|pack\.zip/);
  assert.match(serialized, /release-42/);
  assert.equal((await store.get('job-other')).events.length, 0);
  await assert.rejects(
    store.appendEvent('job-events', { jobId: 'job-other', channel: 'log', message: 'wrong owner' }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('reload fails closed for a tampered durable job record', async (t) => {
  const { dependencies, store, userDataPath } = fixture(t);
  await store.initialize();
  await store.create(job());
  const recordPath = path.join(userDataPath, 'modpack-lifecycle', 'operations', 'job-0001.json');
  const value = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  value.phase = 'completed';
  fs.writeFileSync(recordPath, `${JSON.stringify(value, null, 2)}\n`);

  const reloadedStore = new OperationStore(dependencies);
  await assert.rejects(reloadedStore.initialize(), error => error.code === 'RECOVERY_REQUIRED');
});
