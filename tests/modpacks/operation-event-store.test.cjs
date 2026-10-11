const assert = require('node:assert/strict');
const test = require('node:test');

const { OperationEventStore } = require('../../electron/services/modpack-lifecycle/operation-event-store.cjs');

function record(patch = {}) {
  return {
    jobId: 'job-one', operationKind: 'install', serverId: 'server-one', sequence: 1,
    phase: 'preflight', progress: { percent: 5, message: 'Checking', currentItem: null },
    cancellationRequested: false, terminalAt: null, outcome: null, ...patch
  };
}

test('launch reads and events never leak private metadata', async () => {
  const published = []; const calls = [];
  const envelope = { job: record(), binding: { targetPath: 'c:\\private\\target', capturedReservation: { kind: 'absent' } },
    recordRevision: { sequence: 1, sha256: 'a'.repeat(64) } };
  const state = { generation: 2, pending: false };
  const safe = record(); const callback = () => {}; const options = { onPublicationAttempt: callback };
  const underlying = {
    async initialize() { return []; }, async create(...args) { calls.push(['create', ...args]); return safe; },
    async get() { return safe; }, async load() { return safe; }, async transition() { return safe; },
    async reconcileRecovery() { return safe; }, async updateProgress() { return safe; },
    async requestCancellation() { return safe; }, async appendEvent() { return safe; },
    getNewServerLaunch(...args) { calls.push(['get', ...args]); return envelope; },
    findNewServerLaunch(...args) { calls.push(['find', ...args]); return envelope; },
    listNewServerLaunchBindings(...args) { calls.push(['list', ...args]); return [envelope]; },
    getLaunchPublicationState(...args) { calls.push(['state', ...args]); return state; },
    async settleNewServerDestination(...args) { calls.push(['settle', ...args]); return safe; },
    async closeInterruptedQueued(...args) { calls.push(['close', ...args]); return safe; }
  };
  const store = new OperationEventStore({ operationStore: underlying,
    nativeNotificationBridge: { publishJobEvent(value) { published.push(value); } } });
  const credential = { planId: 'test', planFingerprint: 'a'.repeat(64) };
  assert.equal(await store.getNewServerLaunch('job-one', 'epoch'), envelope);
  assert.equal(await store.findNewServerLaunch(credential, 'epoch'), envelope);
  assert.deepEqual(await store.listNewServerLaunchBindings('epoch'), [envelope]);
  assert.equal(store.getLaunchPublicationState('epoch'), state);
  assert.equal(published.length, 0);
  assert.equal(await store.create({ operationKind: 'install' }, 'epoch', options), safe);
  assert.equal(await store.settleNewServerDestination('job-one', credential, 'epoch'), safe);
  assert.equal(await store.closeInterruptedQueued('job-one', credential, 'epoch'), safe);
  assert.deepEqual(calls, [['get', 'job-one', 'epoch'], ['find', credential, 'epoch'], ['list', 'epoch'],
    ['state', 'epoch'], ['create', { operationKind: 'install' }, 'epoch', options],
    ['settle', 'job-one', credential, 'epoch'], ['close', 'job-one', credential, 'epoch']]);
  assert.equal(published.length, 3);
  assert.doesNotMatch(JSON.stringify(published), /launchBinding|targetPath|capturedReservation|recordRevision|epoch|checksum/);
});

test('durable operation mutations publish only the returned safe transition and preserve exact results', async () => {
  const published = [];
  const appendedEvent = {
    sequence: 4, jobId: 'job-one', channel: 'log', phase: 'preflight',
    timestamp: '2026-08-02T00:00:00.000Z', message: 'hello', progress: null,
    currentItem: null, details: null
  };
  const results = [record({ sequence: 0, phase: 'queued', progress: null }), record(),
    record({ sequence: 2, progress: { percent: 6, message: 'Copying', currentItem: null } }),
    record({ sequence: 3, phase: 'cancelling', cancellationRequested: true }),
    record({ sequence: 4, events: [appendedEvent] }),
    record({ sequence: 5, phase: 'failed', terminalAt: '2026-08-02T00:00:00.000Z', outcome: { status: 'failed' } })];
  const calls = [];
  const store = new OperationEventStore({
    operationStore: {
      async initialize() { return []; },
      async create(value) { calls.push(['create', value]); return results[0]; },
      async get(value) { calls.push(['get', value]); return results[1]; },
      async load(value) { calls.push(['load', value]); return results[1]; },
      async transition(jobId, value) { calls.push(['transition', jobId, value]); return results[1]; },
      async reconcileRecovery(jobId, value) { calls.push(['reconcile', jobId, value]); return results[5]; },
      async updateProgress(jobId, value) { calls.push(['progress', jobId, value]); return results[2]; },
      async requestCancellation(jobId) { calls.push(['cancel', jobId]); return results[3]; },
      async appendEvent(jobId, value) { calls.push(['append', jobId, value]); return results[4]; }
    },
    nativeNotificationBridge: { publishJobEvent(value) { published.push(value); } }
  });
  assert.equal(await store.create({ operationKind: 'install' }), results[0]);
  assert.equal(await store.get('job-one'), results[1]);
  assert.equal(await store.load('job-one'), results[1]);
  assert.equal(await store.transition('job-one', { expectedPhase: 'queued' }), results[1]);
  assert.equal(await store.reconcileRecovery('job-one', { nextPhase: 'failed' }), results[5]);
  assert.equal(await store.updateProgress('job-one', { expectedPhase: 'preflight' }), results[2]);
  assert.equal(await store.requestCancellation('job-one'), results[3]);
  assert.equal(await store.appendEvent('job-one', { channel: 'log', message: 'hello' }), results[4]);
  assert.equal(published.length, 6);
  assert.deepEqual(published[1], {
    channel: 'progress', jobId: 'job-one', operationKind: 'install', serverId: 'server-one',
    sequence: 1, phase: 'preflight', progress: { percent: 5, message: 'Checking', currentItem: null },
    cancellationRequested: false, terminal: false, outcome: null
  });
  assert.deepEqual(published[5], appendedEvent);
  assert.equal(JSON.stringify(published).includes('checksum'), false);
  assert.equal(JSON.stringify(published).includes('events'), false);
  assert.equal(calls.length, 8);
});

test('renderer delivery failure never invalidates a durable operation transition', async () => {
  const expected = record();
  const store = new OperationEventStore({
    operationStore: {
      async initialize() { return []; }, async create() { return expected; }, async get() { return expected; },
      async load() { return expected; }, async transition() { return expected; },
      async reconcileRecovery() { return expected; },
      async updateProgress() { return expected; }, async requestCancellation() { return expected; },
      async appendEvent() { return expected; }
    },
    nativeNotificationBridge: { publishJobEvent() { throw new Error('window closed'); } }
  });
  assert.equal(await store.transition('job-one', {}), expected);
});

test('appending a durable log publishes the persisted safe event instead of a progress projection or raw request', async () => {
  const persistedEvent = {
    sequence: 7,
    jobId: 'job-one',
    channel: 'log',
    phase: 'staging',
    timestamp: '2026-09-04T00:00:00.000Z',
    message: 'The operation stopped before the server changed',
    progress: null,
    currentItem: null,
    details: { errorCode: 'PLAN_STALE', step: 'revalidate-plan', field: 'contentRevision' }
  };
  const persistedRecord = record({
    sequence: persistedEvent.sequence,
    phase: persistedEvent.phase,
    events: [persistedEvent]
  });
  const published = [];
  const rawRequest = {
    channel: 'log',
    message: 'C:\\private\\server failed with secret=raw-value',
    details: { token: 'raw-value' }
  };
  const store = new OperationEventStore({
    operationStore: {
      async initialize() { return []; }, async create() { return record(); }, async get() { return record(); },
      async load() { return record(); }, async transition() { return record(); },
      async reconcileRecovery() { return record(); }, async updateProgress() { return record(); },
      async requestCancellation() { return record(); },
      async appendEvent(jobId, event) {
        assert.equal(jobId, 'job-one');
        assert.equal(event, rawRequest);
        return persistedRecord;
      }
    },
    nativeNotificationBridge: { publishJobEvent(value) { published.push(value); } }
  });

  assert.equal(await store.appendEvent('job-one', rawRequest), persistedRecord);
  assert.deepEqual(published, [persistedEvent]);
  assert.doesNotMatch(JSON.stringify(published), /private|secret|raw-value|token/i);
});

test('terminal durable transitions schedule background cleanup without delaying the job result', async () => {
  // This fails if terminal jobs never trigger pruning, or if cleanup latency blocks the durable result.
  const terminal = record({ phase: 'failed', terminalAt: '2026-08-31T12:00:00.000Z', outcome: { status: 'failed' } });
  const scheduled = [];
  const store = new OperationEventStore({
    operationStore: {
      async initialize() { return []; }, async create() { return record(); }, async get() { return record(); },
      async load() { return record(); }, async transition() { return terminal; }, async reconcileRecovery() { return terminal; },
      async updateProgress() { return record(); }, async requestCancellation() { return record(); }, async appendEvent() { return record(); }
    },
    nativeNotificationBridge: { publishJobEvent() {} },
    onTerminal(recordValue) { scheduled.push(recordValue.jobId); return new Promise(() => {}); }
  });

  assert.equal(await store.transition('job-one', {}), terminal);
  assert.deepEqual(scheduled, ['job-one']);
});
