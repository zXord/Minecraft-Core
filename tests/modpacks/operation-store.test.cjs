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
  preflight: ['snapshotting', 'staging', 'cancelling', 'failed', 'recovery-required'],
  snapshotting: ['staging', 'cancelling', 'failed', 'recovery-required'],
  staging: ['validating-candidate', 'committing', 'cancelling', 'failed', 'recovery-required'],
  'validating-candidate': ['committing', 'cancelling', 'failed', 'recovery-required'],
  committing: ['publishing', 'starting', 'validating-live', 'rolling-back', 'recovery-required'],
  publishing: ['published', 'rolling-back', 'recovery-required'],
  published: ['registering', 'starting', 'validating-live', 'rolling-back', 'recovery-required'],
  registering: ['starting', 'validating-live', 'committed-healthy', 'rolling-back', 'recovery-required'],
  starting: ['validating-live', 'rolling-back', 'recovery-required'],
  'validating-live': ['committed-healthy', 'rolling-back', 'recovery-required'],
  'committed-healthy': ['cleanup', 'cleanup-pending'],
  cleanup: ['completed', 'cleanup-pending'],
  'cleanup-pending': ['cleanup', 'completed', 'recovery-required'],
  cancelling: ['cancelled', 'failed', 'recovery-required'],
  'rolling-back': ['rolled-back', 'recovery-required']
};

function fixture(t, { eventSink = () => {} } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-operation-store-'));
  let tempNumber = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    asyncFsApi: fs.promises,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      async moveWriteThroughAsync(source, destination) { await fs.promises.rename(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      async replaceFileWriteThroughAsync(source, destination) { await fs.promises.rename(source, destination); },
      flushDirectory() {},
      async flushDirectoryAsync() {}
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
  assert.equal(isLegalJobTransition('rolling-back', 'failed', { operationKind: 'install-new' }), true);
  assert.equal(isLegalJobTransition('rolling-back', 'failed', { operationKind: 'import-files-only-new' }), true);
  assert.equal(isLegalJobTransition('rolling-back', 'failed', { operationKind: 'update' }), false);
  assert.equal(isLegalJobTransition('unknown', 'failed', { operationKind: 'verify' }), false);
});

test('automatically generated operation IDs use the compact transaction namespace', async (t) => {
  const { store, userDataPath } = fixture(t);
  await store.initialize();

  const created = await store.create({
    operationKind: 'install-new',
    serverId: 'server-compact-path',
    planFingerprint: 'a'.repeat(64)
  });

  assert.match(created.jobId, /^op2-[0-9a-f]{32}$/u);
  assert.equal(
    fs.existsSync(path.join(userDataPath, 'modpack-lifecycle', 'operations', `${created.jobId}.json`)),
    true
  );
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

test('job creation and transitions require asynchronous durable JSON publication', async t => {
  const { dependencies } = fixture(t);
  let asyncWrites = 0;
  const durableFs = {
    ...dependencies.durableFs,
    writeJsonAtomic() { throw new Error('synchronous durable JSON write must not run'); },
    async writeJsonAtomicAsync(...args) {
      asyncWrites += 1;
      return dependencies.durableFs.writeJsonAtomicAsync(...args);
    }
  };
  const store = new OperationStore({ ...dependencies, durableFs });
  await store.initialize();
  await store.create(job({ jobId: 'job-async-write' }));
  await store.transition('job-async-write', {
    expectedPhase: 'queued', nextPhase: 'preflight', patch: {}
  });
  assert.equal(asyncWrites, 2);
});

test('concurrent asynchronous transitions preserve one compare-and-set winner', async t => {
  const { store } = fixture(t);
  await store.initialize();
  await store.create(job({ jobId: 'job-concurrent' }));

  const results = await Promise.allSettled([
    store.transition('job-concurrent', {
      expectedPhase: 'queued', nextPhase: 'preflight', patch: {}
    }),
    store.transition('job-concurrent', {
      expectedPhase: 'queued', nextPhase: 'resolving', patch: {}
    })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'COMMIT_FAILED');
  const winner = results.find(result => result.status === 'fulfilled').value;
  const stored = await store.get('job-concurrent');
  assert.equal(stored.sequence, 1);
  assert.equal(stored.phase, winner.phase);
});

test('job polling waits for the store own atomic publication instead of reporting false corruption', async t => {
  const { dependencies } = fixture(t);
  let blockNextWrite = false;
  let publicationActive = false;
  let releasePublication;
  let publicationStarted;
  const publicationGate = new Promise(resolve => { releasePublication = resolve; });
  const publicationStart = new Promise(resolve => { publicationStarted = resolve; });
  const durableFs = {
    ...dependencies.durableFs,
    readFileBounded(...args) {
      if (publicationActive) {
        const error = new Error('the atomic destination changed during the bounded read');
        error.code = 'COMMIT_FAILED';
        throw error;
      }
      return dependencies.durableFs.readFileBounded(...args);
    },
    async writeJsonAtomicAsync(...args) {
      if (!blockNextWrite) return dependencies.durableFs.writeJsonAtomicAsync(...args);
      blockNextWrite = false;
      publicationActive = true;
      publicationStarted();
      await publicationGate;
      try {
        return await dependencies.durableFs.writeJsonAtomicAsync(...args);
      } finally {
        publicationActive = false;
      }
    }
  };
  const store = new OperationStore({ ...dependencies, durableFs });
  await store.initialize();
  await store.create(job({ jobId: 'job-polled-during-publication' }));

  blockNextWrite = true;
  const transition = store.transition('job-polled-during-publication', {
    expectedPhase: 'queued', nextPhase: 'preflight', patch: {}
  });
  await publicationStart;
  const polled = store.get('job-polled-during-publication').then(
    value => ({ status: 'fulfilled', value }),
    error => ({ status: 'rejected', error })
  );
  const premature = await Promise.race([
    polled,
    new Promise(resolve => setTimeout(() => resolve('pending'), 25))
  ]);
  assert.equal(premature, 'pending');

  releasePublication();
  const [transitioned, observed] = await Promise.all([transition, polled]);
  assert.equal(observed.status, 'fulfilled');
  assert.equal(observed.value.sequence, transitioned.sequence);
  assert.equal(observed.value.phase, 'preflight');
});

test('same-phase progress is durably updated without weakening the phase graph or allowing regression', async (t) => {
  const { dependencies, store } = fixture(t);
  await store.initialize();
  await store.create(job({ jobId: 'job-progress' }));
  await store.transition('job-progress', {
    expectedPhase: 'queued', nextPhase: 'preflight',
    patch: { progress: { percent: 10, message: 'Checking the reviewed plan', currentItem: null } }
  });
  await store.transition('job-progress', {
    expectedPhase: 'preflight', nextPhase: 'staging',
    patch: { progress: { percent: 35, message: 'Building the server candidate', currentItem: null } }
  });

  const updated = await store.updateProgress('job-progress', {
    expectedPhase: 'staging',
    progress: { percent: 42, message: 'Reconciling reviewed modpack files', currentItem: null }
  });

  assert.equal(updated.phase, 'staging');
  assert.equal(updated.sequence, 3);
  assert.deepEqual(updated.progress, {
    percent: 42, message: 'Reconciling reviewed modpack files', currentItem: null
  });
  const reloadedStore = new OperationStore(dependencies);
  await reloadedStore.initialize();
  assert.deepEqual((await reloadedStore.get('job-progress')).progress, updated.progress);
  await assert.rejects(
    reloadedStore.updateProgress('job-progress', {
      expectedPhase: 'staging',
      progress: { percent: 41, message: 'Regressing candidate progress', currentItem: null }
    }),
    error => error.code === 'PLAN_STALE'
  );
  await assert.rejects(
    reloadedStore.updateProgress('job-progress', {
      expectedPhase: 'preflight',
      progress: { percent: 43, message: 'Using a stale phase', currentItem: null }
    }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(isLegalJobTransition('staging', 'staging', { operationKind: 'install-existing' }), false);
});

test('ordinary terminal states are final and recovery-required resolves only through dedicated reconciliation', async (t) => {
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

  const recoveryRequired = await store.transition('job-commit', {
    expectedPhase: 'committing',
    nextPhase: 'recovery-required',
    patch: {
      progress: { percent: 70, message: 'Recovery review required', currentItem: null },
      outcome: { status: 'recovery-required', message: 'Recovery review required' }
    }
  });
  assert.equal(recoveryRequired.phase, 'recovery-required');
  await assert.rejects(
    store.transition('job-commit', {
      expectedPhase: 'recovery-required', nextPhase: 'failed', patch: { outcome: { status: 'failed' } }
    }),
    error => error.code === 'PLAN_STALE'
  );
  const resolved = await store.reconcileRecovery('job-commit', {
    nextPhase: 'failed',
    patch: {
      progress: { percent: 100, message: 'Recovery completed safely', currentItem: null },
      outcome: { status: 'failed', message: 'The interrupted operation was recovered' }
    }
  });
  assert.equal(resolved.phase, 'failed');
  assert.equal(resolved.sequence, recoveryRequired.sequence + 1);
  assert.equal(resolved.outcome.status, 'failed');
  await assert.rejects(
    store.reconcileRecovery('job-commit', {
      nextPhase: 'completed',
      patch: {
        progress: { percent: 100, message: 'Invalid second resolution', currentItem: null },
        outcome: { status: 'completed', message: 'Invalid second resolution' }
      }
    }),
    error => error.code === 'PLAN_STALE'
  );
});

test('public terminal outcomes preserve only exact closed failure diagnostics', async t => {
  const { store } = fixture(t);
  await store.initialize();
  await store.create(job({ jobId: 'job-safe-diagnostic' }));
  const safe = await store.transition('job-safe-diagnostic', {
    expectedPhase: 'queued',
    nextPhase: 'failed',
    patch: {
      outcome: {
        status: 'failed',
        message: 'The candidate server did not become ready',
        failure: {
          stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
        }
      }
    }
  });
  assert.deepEqual(safe.outcome.failure, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });

  await store.create(job({ jobId: 'job-malformed-diagnostic' }));
  const malformed = await store.transition('job-malformed-diagnostic', {
    expectedPhase: 'queued',
    nextPhase: 'failed',
    patch: {
      outcome: {
        status: 'failed',
        message: 'The candidate server did not become ready',
        failure: {
          message: 'C:\\private\\candidate raw process output',
          stack: 'secret exception stack'
        }
      }
    }
  });
  assert.equal(Object.hasOwn(malformed.outcome, 'failure'), false);
  assert.doesNotMatch(JSON.stringify(malformed.outcome), /private|candidate raw|secret|exception|stack/i);
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
