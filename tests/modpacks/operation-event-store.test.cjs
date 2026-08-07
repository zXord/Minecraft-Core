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

test('durable operation mutations publish only the returned safe transition and preserve exact results', async () => {
  const published = [];
  const results = [record({ sequence: 0, phase: 'queued', progress: null }), record(),
    record({ sequence: 2, phase: 'cancelling', cancellationRequested: true }), record({ sequence: 3 })];
  const calls = [];
  const store = new OperationEventStore({
    operationStore: {
      async initialize() { return []; },
      async create(value) { calls.push(['create', value]); return results[0]; },
      async get(value) { calls.push(['get', value]); return results[1]; },
      async load(value) { calls.push(['load', value]); return results[1]; },
      async transition(jobId, value) { calls.push(['transition', jobId, value]); return results[1]; },
      async requestCancellation(jobId) { calls.push(['cancel', jobId]); return results[2]; },
      async appendEvent(jobId, value) { calls.push(['append', jobId, value]); return results[3]; }
    },
    nativeNotificationBridge: { publishJobEvent(value) { published.push(value); } }
  });
  assert.equal(await store.create({ operationKind: 'install' }), results[0]);
  assert.equal(await store.get('job-one'), results[1]);
  assert.equal(await store.load('job-one'), results[1]);
  assert.equal(await store.transition('job-one', { expectedPhase: 'queued' }), results[1]);
  assert.equal(await store.requestCancellation('job-one'), results[2]);
  assert.equal(await store.appendEvent('job-one', { channel: 'log', message: 'hello' }), results[3]);
  assert.equal(published.length, 4);
  assert.deepEqual(published[1], {
    channel: 'progress', jobId: 'job-one', operationKind: 'install', serverId: 'server-one',
    sequence: 1, phase: 'preflight', progress: { percent: 5, message: 'Checking', currentItem: null },
    cancellationRequested: false, terminal: false, outcome: null
  });
  assert.equal(JSON.stringify(published).includes('checksum'), false);
  assert.equal(JSON.stringify(published).includes('events'), false);
  assert.equal(calls.length, 6);
});

test('renderer delivery failure never invalidates a durable operation transition', async () => {
  const expected = record();
  const store = new OperationEventStore({
    operationStore: {
      async initialize() { return []; }, async create() { return expected; }, async get() { return expected; },
      async load() { return expected; }, async transition() { return expected; },
      async requestCancellation() { return expected; }, async appendEvent() { return expected; }
    },
    nativeNotificationBridge: { publishJobEvent() { throw new Error('window closed'); } }
  });
  assert.equal(await store.transition('job-one', {}), expected);
});
