const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const API_URL = pathToFileURL(path.resolve(__dirname, '../../src/utils/modpacks/modpackApi.js')).href;
async function loadApi(t, electron) {
  const previous = global.window;
  global.window = { electron };
  t.after(() => { if (previous === undefined) delete global.window; else global.window = previous; });
  return import(`${API_URL}?launch-reconciliation=${Date.now()}-${Math.random()}`);
}

test('launch API reads retain credentials and opaque pagination without invoking start or release', async t => {
  const calls = [];
  const credentials = { planId: 'plan-launch-v1-12345678-1234-4234-8234-123456789abc', planFingerprint: 'a'.repeat(64) };
  const page = { cursor: 'launch-cursor-v1-12345678-1234-4234-8234-123456789abc', limit: 1 };
  const { modpackApi, modpackInvokeChannels } = await loadApi(t, {
    invoke(channel, request) {
      calls.push([channel, request]);
      return Promise.resolve({ ok: true, value: channel.includes('reconcile')
        ? { ...credentials, status: 'pending' } : { items: [], nextCursor: null } });
    }
  });
  assert.equal(typeof modpackApi.reconcileNewServerLaunch, 'function');
  assert.equal(typeof modpackApi.listNewServerLaunches, 'function');
  assert.deepEqual(await modpackApi.reconcileNewServerLaunch(credentials), { ...credentials, status: 'pending' });
  assert.deepEqual(await modpackApi.listNewServerLaunches(page), { items: [], nextCursor: null });
  await modpackApi.listNewServerLaunches();
  assert.deepEqual(calls, [
    ['modpacks:reconcile-new-server-launch', credentials], ['modpacks:list-new-server-launches', page],
    ['modpacks:list-new-server-launches', {}]
  ]);
  assert.equal(modpackInvokeChannels.reconcileNewServerLaunch, 'modpacks:reconcile-new-server-launch');
  assert.equal(modpackInvokeChannels.listNewServerLaunches, 'modpacks:list-new-server-launches');
});

test('launch API failures preserve safe errors and transport rejection without mutation retries', async t => {
  const calls = [];
  const transportFailure = new Error('Transport unavailable');
  const failures = [
    { code: 'LAUNCH_CURSOR_EXPIRED', message: 'The setup list expired. Refresh it to continue.', details: {}, retryable: true },
    { code: 'LAUNCH_DISCOVERY_CAPACITY', message: 'The setup list is busy. Try again shortly.', details: {}, retryable: true },
    { code: 'LAUNCH_LIST_LIMIT_EXCEEDED', message: 'Too many setups are available to list. Use an exact setup reference.', details: {}, retryable: false }
  ];
  let response;
  const { modpackApi, ModpackApiError } = await loadApi(t, {
    invoke(channel, request) {
      calls.push([channel, request]);
      if (response === transportFailure) return Promise.reject(response);
      return Promise.resolve(response);
    }
  });
  assert.equal(typeof modpackApi.reconcileNewServerLaunch, 'function');
  assert.equal(typeof modpackApi.listNewServerLaunches, 'function');
  for (const error of failures) {
    response = { ok: false, error };
    await assert.rejects(modpackApi.listNewServerLaunches({ limit: 50 }), result => result instanceof ModpackApiError &&
      result.code === error.code && result.message === error.message && result.retryable === error.retryable &&
      Object.keys(result.details).length === 0);
  }
  response = transportFailure;
  const credentials = { planId: 'legacy-plan', planFingerprint: 'b'.repeat(64) };
  await assert.rejects(modpackApi.reconcileNewServerLaunch(credentials), error => error === transportFailure);
  response = null;
  await assert.rejects(modpackApi.reconcileNewServerLaunch(credentials), { code: 'COMMIT_FAILED' });
  assert.deepEqual(calls, [
    ...failures.map(() => ['modpacks:list-new-server-launches', { limit: 50 }]),
    ['modpacks:reconcile-new-server-launch', credentials], ['modpacks:reconcile-new-server-launch', credentials]
  ]);
});
