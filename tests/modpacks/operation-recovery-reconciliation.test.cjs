const assert = require('node:assert/strict');
const test = require('node:test');

const { isLegalJobTransition } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const {
  reconcileOperationStoreWithRecovery
} = require('../../electron/services/modpack-lifecycle/operation-recovery-reconciler.cjs');

class MemoryOperationStore {
  constructor(records) {
    this.records = new Map(records.map(record => [record.jobId, structuredClone(record)]));
    this.transitions = [];
  }
  async transition(jobId, request) {
    const current = this.records.get(jobId);
    assert.equal(current.phase, request.expectedPhase);
    assert.equal(isLegalJobTransition(request.expectedPhase, request.nextPhase, {
      operationKind: current.operationKind
    }), true);
    const next = { ...current, ...structuredClone(request.patch), phase: request.nextPhase };
    this.records.set(jobId, next);
    this.transitions.push(`${request.expectedPhase}->${request.nextPhase}`);
    return structuredClone(next);
  }

  async reconcileRecovery(jobId, request) {
    const current = this.records.get(jobId);
    assert.equal(current.phase, 'recovery-required');
    assert.equal(['completed', 'failed', 'rolled-back'].includes(request.nextPhase), true);
    const next = { ...current, ...structuredClone(request.patch), phase: request.nextPhase };
    this.records.set(jobId, next);
    this.transitions.push(`recovery-required=>${request.nextPhase}`);
    return structuredClone(next);
  }
}

function job(jobId, phase, overrides = {}) {
  return { jobId, serverId: 'server-one', operationKind: 'install-new', phase, ...structuredClone(overrides) };
}

function recovered(jobId, overrides = {}) {
  return {
    jobId,
    operationKind: 'install',
    phase: 'completed',
    target: { kind: 'new', stableServerId: 'server-one', path: 'C:\\private\\server-one' },
    outcome: {
      revisionEvent: { eventId: `revision:${jobId}`, published: true },
      releaseTracking: { status: 'applied' }
    },
    ...structuredClone(overrides)
  };
}

function recoveredFailure(jobId, overrides = {}) {
  return {
    jobId,
    operationKind: 'upgrade',
    phase: 'failed',
    target: { kind: 'existing', stableServerId: 'server-one', path: 'C:\\private\\server-one' },
    outcome: {
      recovery: { action: 'between-renames-restored', operationId: jobId }
    },
    ...structuredClone(overrides)
  };
}

test('startup completes publishing through cleanup-pending jobs from authoritative completed recovery history', async () => {
  const phases = ['publishing', 'published', 'registering', 'starting', 'validating-live',
    'committed-healthy', 'cleanup', 'cleanup-pending'];
  const jobs = phases.map((phase, index) => job(`job-${index}`, phase));
  const store = new MemoryOperationStore(jobs);
  const history = new Map(jobs.map(current => [current.jobId, recovered(current.jobId)]));
  const registry = {
    async load() { return null; },
    async loadHistory(jobId) { return structuredClone(history.get(jobId) || null); }
  };
  const issued = [];
  const outcomeActionIssuer = {
    async issue(context) {
      issued.push(structuredClone(context));
      return [{ actionId: 'open-details', opaqueRef: `oa:od:${context.jobId}` }];
    }
  };

  const result = await reconcileOperationStoreWithRecovery({
    operationStore: store, recoveryRegistry: registry, jobs, outcomeActionIssuer
  });

  assert.deepEqual(result, { reconciled: jobs.map(current => current.jobId).sort() });
  for (const current of jobs) {
    const terminal = store.records.get(current.jobId);
    assert.equal(terminal.phase, 'completed', current.phase);
    assert.deepEqual(terminal.outcome.actions, [
      { actionId: 'open-details', opaqueRef: `oa:od:${current.jobId}` }
    ]);
    assert.equal(terminal.outcome.status, 'completed');
  }
  assert.equal(issued.length, jobs.length);
  assert.equal(issued.every(context => context.phase === 'completed' && context.automaticRecovery === true), true);
  assert.deepEqual(store.transitions.slice(0, 5), [
    'publishing->published',
    'published->registering',
    'registering->committed-healthy',
    'committed-healthy->cleanup-pending',
    'cleanup-pending->completed'
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private|path|url/i);
});

test('active committed recovery advances only to cleanup-pending until completed history exists', async () => {
  const jobs = [job('job-active', 'publishing')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() {
      return recovered('job-active', { phase: 'cleanup-pending' });
    },
    async loadHistory() { throw new Error('active recovery remains authoritative'); }
  };
  let issued = 0;

  const result = await reconcileOperationStoreWithRecovery({
    operationStore: store,
    recoveryRegistry: registry,
    jobs,
    outcomeActionIssuer: { async issue() { issued += 1; return []; } }
  });

  assert.deepEqual(result, { reconciled: ['job-active'] });
  assert.equal(store.records.get('job-active').phase, 'cleanup-pending');
  assert.equal(store.records.get('job-active').outcome, undefined);
  assert.equal(issued, 0);
});

test('completed recovery still records a valid terminal outcome when action issuance fails', async () => {
  const jobs = [job('job-actions', 'cleanup-pending')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() { return recovered('job-actions'); }
  };

  await reconcileOperationStoreWithRecovery({
    operationStore: store,
    recoveryRegistry: registry,
    jobs,
    outcomeActionIssuer: { async issue() { throw new Error('transient action issuer failure'); } }
  });

  assert.deepEqual(store.records.get('job-actions').outcome, {
    status: 'completed',
    message: 'The modpack operation completed successfully',
    operationKind: 'install-new',
    actions: [],
    actionIssuanceFailed: true
  });
});

test('completed recovery rejects accessor action output without executing it', async () => {
  const jobs = [job('job-accessor', 'cleanup-pending')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() { return recovered('job-accessor'); }
  };
  let executed = false;
  const action = {};
  Object.defineProperty(action, 'actionId', {
    enumerable: true,
    get() { executed = true; return 'open-details'; }
  });
  Object.defineProperty(action, 'opaqueRef', { enumerable: true, value: 'oa:od:job-accessor' });

  await reconcileOperationStoreWithRecovery({
    operationStore: store,
    recoveryRegistry: registry,
    jobs,
    outcomeActionIssuer: { async issue() { return [action]; } }
  });

  assert.equal(executed, false);
  assert.deepEqual(store.records.get('job-accessor').outcome.actions, []);
  assert.equal(store.records.get('job-accessor').outcome.actionIssuanceFailed, true);
});

test('startup refuses to advance a job until release tracking intent is applied', async () => {
  const jobs = [job('job-pending', 'validating-live')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() {
      return recovered('job-pending', {
        phase: 'committed-healthy',
        outcome: {
          revisionEvent: { eventId: 'revision:job-pending', published: true },
          releaseTracking: { status: 'pending' }
        }
      });
    },
    async loadHistory() { throw new Error('history must not be used'); }
  };

  const result = await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });
  assert.deepEqual(result, { reconciled: [] });
  assert.equal(store.records.get('job-pending').phase, 'validating-live');
  assert.deepEqual(store.transitions, []);
});

test('startup does not trust a completed recovery record bound to another server', async () => {
  const jobs = [job('job-other', 'registering')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() {
      return recovered('job-other', { target: { stableServerId: 'another-server', path: 'C:\\private\\other' } });
    }
  };
  const result = await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });
  assert.deepEqual(result, { reconciled: [] });
  assert.deepEqual(store.transitions, []);
});

test('startup refuses a new-publication public phase backed by an existing-server recovery target', async () => {
  const jobs = [job('job-wrong-kind', 'publishing')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() {
      return recovered('job-wrong-kind', {
        target: { kind: 'existing', stableServerId: 'server-one', path: 'C:\\private\\server-one' }
      });
    }
  };

  const result = await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  assert.deepEqual(result, { reconciled: [] });
  assert.equal(store.records.get('job-wrong-kind').phase, 'publishing');
  assert.deepEqual(store.transitions, []);
});

test('startup marks a committing operation rolled back after automatic between-renames recovery', async () => {
  const jobs = [job('job-crashed-commit', 'committing', { operationKind: 'update' })];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() { return recoveredFailure('job-crashed-commit'); }
  };
  const issued = [];

  const result = await reconcileOperationStoreWithRecovery({
    operationStore: store,
    recoveryRegistry: registry,
    jobs,
    outcomeActionIssuer: {
      async issue(context) {
        issued.push(structuredClone(context));
        return [{ actionId: 'return-to-server', opaqueRef: `oa:rs:${context.jobId}` }];
      }
    }
  });

  assert.deepEqual(result, { reconciled: ['job-crashed-commit'] });
  assert.deepEqual(store.transitions, ['committing->rolling-back', 'rolling-back->rolled-back']);
  assert.deepEqual(store.records.get('job-crashed-commit').outcome, {
    status: 'rolled-back',
    message: 'The interrupted operation was rolled back safely',
    operationKind: 'update',
    actions: [{ actionId: 'return-to-server', opaqueRef: 'oa:rs:job-crashed-commit' }]
  });
  assert.equal(issued.length, 1);
  assert.equal(issued[0].automaticRecovery, true);
  assert.equal(issued[0].phase, 'rolled-back');
});

test('startup marks a pre-commit operation failed after automatic candidate cleanup', async () => {
  const jobs = [job('job-crashed-staging', 'staging', { operationKind: 'update' })];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() {
      return recoveredFailure('job-crashed-staging', {
        outcome: { recovery: { action: 'pre-swap-restored', operationId: 'job-crashed-staging' } }
      });
    }
  };

  const result = await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  assert.deepEqual(result, { reconciled: ['job-crashed-staging'] });
  assert.deepEqual(store.transitions, ['staging->failed']);
  assert.deepEqual(store.records.get('job-crashed-staging').outcome, {
    status: 'failed',
    message: 'The interrupted operation was recovered before publication',
    errorCode: 'COMMIT_FAILED',
    operationKind: 'update',
    actions: []
  });
});

test('reviewed new-server recovery replaces a stale terminal recovery-required job with failed', async () => {
  const jobs = [job('job-reviewed-new', 'recovery-required')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() {
      return recovered('job-reviewed-new', {
        operationKind: 'install',
        phase: 'failed',
        outcome: { recovery: { action: 'pre-publication-cleanup', operationId: 'job-reviewed-new' } }
      });
    }
  };

  const result = await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  assert.deepEqual(result, { reconciled: ['job-reviewed-new'] });
  assert.deepEqual(store.transitions, ['recovery-required=>failed']);
  assert.deepEqual(store.records.get('job-reviewed-new').outcome, {
    status: 'failed',
    message: 'The new server was not published',
    errorCode: 'COMMIT_FAILED',
    operationKind: 'install-new',
    actions: []
  });
});

test('startup reconciliation carries a closed publication failure diagnostic from durable recovery history', async () => {
  const jobs = [job('job-reviewed-diagnostic', 'recovery-required')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() {
      return recovered('job-reviewed-diagnostic', {
        operationKind: 'install',
        phase: 'failed',
        outcome: {
          recovery: { action: 'pre-publication-cleanup', operationId: 'job-reviewed-diagnostic' },
          failure: { stage: 'durable-move', category: 'access-denied' }
        }
      });
    }
  };

  await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  assert.deepEqual(store.records.get('job-reviewed-diagnostic').outcome.failure, {
    stage: 'durable-move', category: 'access-denied'
  });
  assert.equal(store.records.get('job-reviewed-diagnostic').outcome.errorCode, 'COMMIT_FAILED');
});

test('startup reconciliation carries a closed candidate boot diagnostic from durable recovery history', async () => {
  const jobs = [job('job-reviewed-candidate-boot', 'recovery-required')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() {
      return recovered('job-reviewed-candidate-boot', {
        operationKind: 'install',
        phase: 'failed',
        outcome: {
          recovery: { action: 'pre-publication-cleanup', operationId: 'job-reviewed-candidate-boot' },
          failure: {
            stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
          }
        }
      });
    }
  };

  await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  assert.deepEqual(store.records.get('job-reviewed-candidate-boot').outcome.failure, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });
  assert.equal(store.records.get('job-reviewed-candidate-boot').outcome.errorCode, 'HEALTH_CHECK_FAILED');
  assert.doesNotMatch(JSON.stringify(store.records.get('job-reviewed-candidate-boot').outcome), /private|stack|exception/i);
});

test('startup reconciliation drops malformed recovery diagnostics without exposing stored private data', async () => {
  const jobs = [job('job-reviewed-malformed', 'recovery-required')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() {
      return recovered('job-reviewed-malformed', {
        operationKind: 'install',
        phase: 'failed',
        outcome: {
          recovery: { action: 'pre-publication-cleanup', operationId: 'job-reviewed-malformed' },
          failure: {
            stage: 'durable-move',
            category: 'C:\\private\\candidate',
            stack: 'sensitive stack'
          }
        }
      });
    }
  };

  await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  const outcome = store.records.get('job-reviewed-malformed').outcome;
  assert.equal(Object.hasOwn(outcome, 'failure'), false);
  assert.doesNotMatch(JSON.stringify(outcome), /private|candidate|sensitive|stack/i);
});

test('reviewed new-server health recovery reports that the failed published server was quarantined', async () => {
  const jobs = [job('job-reviewed-new-health', 'recovery-required')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() {
      return recovered('job-reviewed-new-health', {
        operationKind: 'install',
        phase: 'failed',
        outcome: { recovery: { action: 'new-health-failed', operationId: 'job-reviewed-new-health' } }
      });
    }
  };

  const result = await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  assert.deepEqual(result, { reconciled: ['job-reviewed-new-health'] });
  assert.equal(store.records.get('job-reviewed-new-health').phase, 'failed');
  assert.equal(store.records.get('job-reviewed-new-health').outcome.message, 'The failed new server was quarantined safely');
  assert.doesNotMatch(store.records.get('job-reviewed-new-health').outcome.message, /before publication/i);
});

test('reviewed existing-server recovery replaces a stale terminal recovery-required job with rolled-back', async () => {
  const jobs = [job('job-reviewed-existing', 'recovery-required', { operationKind: 'update' })];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() { return recoveredFailure('job-reviewed-existing'); }
  };

  const result = await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  assert.deepEqual(result, { reconciled: ['job-reviewed-existing'] });
  assert.deepEqual(store.transitions, ['recovery-required=>rolled-back']);
  assert.equal(store.records.get('job-reviewed-existing').outcome.status, 'rolled-back');
});

test('reviewed committed recovery replaces a stale terminal recovery-required job with completed', async () => {
  const jobs = [job('job-reviewed-complete', 'recovery-required')];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() { return recovered('job-reviewed-complete'); }
  };

  const result = await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  assert.deepEqual(result, { reconciled: ['job-reviewed-complete'] });
  assert.deepEqual(store.transitions, ['recovery-required=>completed']);
  assert.equal(store.records.get('job-reviewed-complete').outcome.status, 'completed');
});

test('startup ignores terminal recovery history with the wrong target kind or operation binding', async () => {
  const jobs = [
    job('job-wrong-target', 'committing', { operationKind: 'update' }),
    job('job-wrong-operation', 'committing', { operationKind: 'update' })
  ];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory(jobId) {
      if (jobId === 'job-wrong-target') {
        return recoveredFailure(jobId, {
          target: { kind: 'new', stableServerId: 'server-one', path: 'C:\\private\\server-one' }
        });
      }
      return recoveredFailure(jobId, { operationKind: 'repair' });
    }
  };

  const result = await reconcileOperationStoreWithRecovery({ operationStore: store, recoveryRegistry: registry, jobs });

  assert.deepEqual(result, { reconciled: [] });
  assert.deepEqual(store.transitions, []);
});

test('automatic rollback remains terminal when recovery outcome action issuance fails', async () => {
  const jobs = [job('job-recovered-actions', 'rolling-back', { operationKind: 'update' })];
  const store = new MemoryOperationStore(jobs);
  const registry = {
    async load() { return null; },
    async loadHistory() {
      return recoveredFailure('job-recovered-actions', {
        phase: 'rolled-back',
        outcome: { recovery: { action: 'rollback-restored', operationId: 'job-recovered-actions' } }
      });
    }
  };

  await reconcileOperationStoreWithRecovery({
    operationStore: store,
    recoveryRegistry: registry,
    jobs,
    outcomeActionIssuer: { async issue() { throw new Error('transient action issuer failure'); } }
  });

  assert.equal(store.records.get('job-recovered-actions').phase, 'rolled-back');
  assert.deepEqual(store.records.get('job-recovered-actions').outcome.actions, []);
  assert.equal(store.records.get('job-recovered-actions').outcome.actionIssuanceFailed, true);
});
