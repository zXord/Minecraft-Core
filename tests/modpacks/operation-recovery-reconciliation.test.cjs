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
}

function job(jobId, phase) {
  return { jobId, serverId: 'server-one', operationKind: 'install-new', phase };
}

function recovered(jobId, overrides = {}) {
  return {
    jobId,
    phase: 'completed',
    target: { kind: 'new', stableServerId: 'server-one', path: 'C:\\private\\server-one' },
    outcome: {
      revisionEvent: { eventId: `revision:${jobId}`, published: true },
      releaseTracking: { status: 'applied' }
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
