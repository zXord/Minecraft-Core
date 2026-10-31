const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const API_URL = pathToFileURL(path.resolve(__dirname, '../../src/utils/modpacks/modpackApi.js')).href;

async function loadApi(electron) {
  global.window = { electron };
  return import(`${API_URL}?inspection-progress=${Date.now()}-${Math.random()}`);
}

test('inspect correlates simultaneous progress streams and removes each listener after its request settles', async () => {
  const listeners = new Map();
  const calls = [];
  const pending = [];
  const electron = {
    on(channel, listener) { listeners.set(listener, channel); },
    removeListener(channel, listener) { calls.push(['removeListener', channel]); listeners.delete(listener); },
    invoke(channel, request) {
      calls.push(['invoke', channel, request]);
      return new Promise(resolve => pending.push(resolve));
    }
  };
  const { modpackApi } = await loadApi(electron);
  const first = [];
  const second = [];
  const firstPromise = modpackApi.inspect({ provider: 'local', selectionId: 'selection-one' }, event => first.push(event));
  const secondPromise = modpackApi.inspect({ provider: 'local', selectionId: 'selection-two' }, event => second.push(event));
  const requests = calls.filter(call => call[0] === 'invoke').map(call => call[2]);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);

  for (const [listener, channel] of listeners) {
    assert.equal(channel, 'modpacks:inspection-progress');
    listener({ requestId: requests[0].requestId, phase: 'downloading', transferredBytes: 2, totalBytes: 4, percent: 50 });
    listener({ requestId: requests[1].requestId, phase: 'resolving' });
    listener({ requestId: 'stale-request', phase: 'complete' });
  }
  assert.deepEqual(first.map(event => event.phase), ['downloading']);
  assert.deepEqual(second.map(event => event.phase), ['resolving']);

  pending[0]({ ok: true, value: { inspectionId: 'inspection-one' } });
  pending[1]({ ok: true, value: { inspectionId: 'inspection-two' } });
  await Promise.all([firstPromise, secondPromise]);
  const failedInspection = modpackApi.inspect({ provider: 'local', selectionId: 'selection-three' }, () => {});
  assert.equal(listeners.size, 1);
  pending[2]({ ok: false, error: { code: 'PLAN_STALE', message: 'Selection expired', details: {}, retryable: false } });
  await assert.rejects(failedInspection, error => error.code === 'PLAN_STALE');
  assert.deepEqual(calls.filter(call => call[0] === 'removeListener').map(call => call[1]), [
    'modpacks:inspection-progress', 'modpacks:inspection-progress', 'modpacks:inspection-progress'
  ]);
  assert.equal(listeners.size, 0);
});

test('aborting an inspection invokes main-process cancellation for the exact opaque request', async () => {
  const calls = [];
  let settleInspection;
  const electron = {
    on() {},
    removeListener() {},
    invoke(channel, request) {
      calls.push([channel, request]);
      if (channel === 'modpacks:cancel-inspection') return Promise.resolve({ ok: true, value: true });
      return new Promise(resolve => { settleInspection = resolve; });
    }
  };
  const { modpackApi } = await loadApi(electron);
  const controller = new AbortController();
  const pending = modpackApi.inspect(
    { provider: 'local', selectionId: 'selection-cancelled' },
    undefined,
    { signal: controller.signal }
  );
  const requestId = calls[0][1].requestId;

  controller.abort();
  settleInspection({
    ok: false,
    error: { code: 'CANCELLED', message: 'Archive inspection was cancelled', details: {}, retryable: false }
  });

  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.deepEqual(calls, [
    ['modpacks:inspect', { provider: 'local', selectionId: 'selection-cancelled', requestId }],
    ['modpacks:cancel-inspection', { requestId }]
  ]);
});

test('an already-aborted inspection never creates a main-process workspace request', async () => {
  const calls = [];
  const electron = {
    on() {},
    removeListener() {},
    invoke(channel, request) {
      calls.push([channel, request]);
      return Promise.resolve({ ok: true, value: false });
    }
  };
  const { modpackApi } = await loadApi(electron);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    modpackApi.inspect(
      { provider: 'local', selectionId: 'selection-never-started' },
      undefined,
      { signal: controller.signal }
    ),
    error => error.code === 'CANCELLED'
  );
  assert.deepEqual(calls, []);
});

test('discardInspection releases one completed opaque inspection session', async () => {
  const calls = [];
  const electron = {
    invoke(channel, request) {
      calls.push([channel, request]);
      return Promise.resolve({ ok: true, value: true });
    }
  };
  const { modpackApi } = await loadApi(electron);

  assert.equal(await modpackApi.discardInspection('inspection-reviewed-one'), true);
  assert.deepEqual(calls, [[
    'modpacks:cancel-inspection',
    { inspectionId: 'inspection-reviewed-one' }
  ]]);
});

test('plan-stale review detection recognizes only the explicit closed failure code', async () => {
  const { isPlanStaleError, ModpackApiError } = await loadApi({});

  assert.equal(isPlanStaleError(new ModpackApiError({ code: 'PLAN_STALE', message: 'Expired' })), true);
  assert.equal(isPlanStaleError({ code: 'PLAN_STALE' }), true);
  assert.equal(isPlanStaleError(new ModpackApiError({ code: 'COMMIT_FAILED', message: 'Failed' })), false);
  assert.equal(isPlanStaleError(null), false);
});

test('a stale review keeps its backend reason only when the failure carries a closed reason code', async () => {
  const { planStaleReason, ModpackApiError } = await loadApi({});

  assert.equal(planStaleReason(new ModpackApiError({
    code: 'PLAN_STALE', message: 'Files were in use', details: { reasonCode: 'server-files-in-use' }, retryable: true
  })), 'server-files-in-use');
  assert.equal(planStaleReason(new ModpackApiError({ code: 'PLAN_STALE', message: 'Expired' })), null);
  assert.equal(planStaleReason({ code: 'PLAN_STALE', details: { reasonCode: '' } }), null);
  assert.equal(planStaleReason(new ModpackApiError({
    code: 'COMMIT_FAILED', message: 'Failed', details: { reasonCode: 'server-files-in-use' }
  })), null);
  assert.equal(planStaleReason(null), null);
});
