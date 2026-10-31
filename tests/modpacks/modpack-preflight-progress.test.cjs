const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const { createModpackHandlers } = require('../../electron/ipc/modpack-handlers.cjs');

const API_URL = pathToFileURL(path.resolve(__dirname, '../../src/utils/modpacks/modpackApi.js')).href;
const REQUEST = Object.freeze({
  inspectionId: 'inspection-one',
  instanceId: 'server-one',
  operationKind: 'install-new',
  selections: Object.freeze({
    optionalFileIds: Object.freeze([]),
    conflictChoices: Object.freeze({}),
    acknowledgeMissingProviderDigest: false
  })
});

async function loadApi(electron) {
  global.window = { electron };
  return import(`${API_URL}?preflight-progress=${Date.now()}-${Math.random()}`);
}

function dependencies(createPlan, createManagementPlan = null) {
  const value = async () => ({});
  return {
    providers: {
      modrinth: { searchProjects: value, getProject: value, listVersions: value },
      github: { listReleases: value, loadUploadedAssets: value }
    },
    localArtifactSource: { selectWithNativeDialog: value },
    destinationReservationService: { reserveWithNativeDialog: value, release: value },
    lifecycleService: {
      inspectSource: value,
      cancelInspection: value,
      createPlan,
      createManagementPlan: createManagementPlan || value,
      startOperation: value,
      cancelJob: value,
      getJob: value,
      getActiveJobs: value,
      getState: value,
      listHistory: value,
      listRollbackOptions: value,
      verify: value
    },
    recoveryService: { listRecovery: value, recover: value },
    notificationStore: { list: value, acknowledge: value },
    releaseMonitor: { checkAll: value, checkOne: value },
    releaseTrackingStore: { upsert: value, list: value },
    outcomeActionService: { performSafeAction: value }
  };
}

test('preflight correlates concurrent renderer progress and always removes its listener', async () => {
  const listeners = new Map();
  const calls = [];
  const pending = [];
  const electron = {
    on(channel, listener) { listeners.set(listener, channel); },
    removeListener(channel, listener) {
      calls.push(['removeListener', channel]);
      listeners.delete(listener);
    },
    invoke(channel, request) {
      calls.push(['invoke', channel, request]);
      return new Promise(resolve => pending.push(resolve));
    }
  };
  const { modpackApi } = await loadApi(electron);
  const firstEvents = [];
  const secondEvents = [];
  const first = modpackApi.preflight(REQUEST, event => firstEvents.push(event));
  const second = modpackApi.preflight({ ...REQUEST, inspectionId: 'inspection-two' }, event => secondEvents.push(event));
  const requests = calls.filter(call => call[0] === 'invoke').map(call => call[2]);

  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  for (const [listener, channel] of listeners) {
    assert.equal(channel, 'modpacks:preflight-progress');
    listener({ requestId: requests[0].requestId, phase: 'preparing-candidate', activity: 'extracting' });
    listener({ requestId: requests[1].requestId, phase: 'scanning-server' });
    listener({ requestId: 'stale-request', phase: 'complete' });
  }
  assert.deepEqual(firstEvents.map(event => event.phase), ['preparing-candidate']);
  assert.deepEqual(secondEvents.map(event => event.phase), ['scanning-server']);

  pending[0]({ ok: true, value: { planId: 'plan-one' } });
  pending[1]({ ok: false, error: { code: 'PLAN_STALE', message: 'Selection expired', details: {}, retryable: false } });
  assert.deepEqual(await first, { planId: 'plan-one' });
  await assert.rejects(second, error => error.code === 'PLAN_STALE');
  assert.deepEqual(calls.filter(call => call[0] === 'removeListener'), [
    ['removeListener', 'modpacks:preflight-progress'],
    ['removeListener', 'modpacks:preflight-progress']
  ]);
  assert.equal(listeners.size, 0);
});

test('management preflight correlates concurrent renderer progress and always removes its listener', async () => {
  const listeners = new Map();
  const calls = [];
  const pending = [];
  const electron = {
    on(channel, listener) { listeners.set(listener, channel); },
    removeListener(channel, listener) {
      calls.push(['removeListener', channel]);
      listeners.delete(listener);
    },
    invoke(channel, request) {
      calls.push(['invoke', channel, request]);
      return new Promise(resolve => pending.push(resolve));
    }
  };
  const { modpackApi } = await loadApi(electron);
  const firstEvents = [];
  const secondEvents = [];
  const first = modpackApi.preflightManagement(
    'server-one', 'rollback-restore-point', 'restore-one', event => firstEvents.push(event)
  );
  const second = modpackApi.preflightManagement(
    'server-two', 'rollback-restore-point', 'restore-two', event => secondEvents.push(event)
  );
  const requests = calls.filter(call => call[0] === 'invoke').map(call => call[2]);

  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  for (const [listener, channel] of listeners) {
    assert.equal(channel, 'modpacks:preflight-progress');
    listener({ requestId: requests[0].requestId, phase: 'scanning-server' });
    listener({
      requestId: requests[1].requestId,
      phase: 'verifying-restore-point',
      activity: 'verifying-archive',
      processedBytes: 5,
      totalBytes: 10
    });
    listener({ requestId: 'stale-request', phase: 'complete' });
  }
  assert.deepEqual(firstEvents.map(event => event.phase), ['scanning-server']);
  assert.deepEqual(secondEvents.map(event => event.phase), ['verifying-restore-point']);

  pending[0]({ ok: true, value: { planId: 'plan-one' } });
  pending[1]({ ok: false, error: { code: 'PLAN_STALE', message: 'Selection expired', details: {}, retryable: false } });
  assert.deepEqual(await first, { planId: 'plan-one' });
  await assert.rejects(second, error => error.code === 'PLAN_STALE');
  assert.deepEqual(calls.filter(call => call[0] === 'removeListener'), [
    ['removeListener', 'modpacks:preflight-progress'],
    ['removeListener', 'modpacks:preflight-progress']
  ]);
  assert.equal(listeners.size, 0);
});

test('preflight IPC reports validated backend phases and strips renderer correlation authority', async () => {
  const sent = [];
  let receivedRequest = null;
  const createPlan = async (request, { onProgress }) => {
    receivedRequest = request;
    onProgress({ phase: 'validating-destination' });
    onProgress({ phase: 'preparing-candidate', activity: 'extracting' });
    onProgress({
      phase: 'preparing-candidate', activity: 'downloading-pack-files',
      processedBytes: 5, totalBytes: 10
    });
    onProgress({ phase: 'scanning-server' });
    onProgress({ phase: 'calculating-changes' });
    onProgress({ phase: 'checking-capacity' });
    onProgress({ phase: 'sealing-plan' });
    onProgress({ phase: 'complete' });
    return { planId: 'plan-one' };
  };
  const handlers = createModpackHandlers(dependencies(createPlan));
  const result = await handlers['modpacks:preflight']({
    sender: { id: 7, send: (...args) => sent.push(args) }
  }, { ...REQUEST, requestId: 'preflight-renderer-one' });

  assert.equal(result.ok, true);
  assert.deepEqual(receivedRequest, REQUEST);
  assert.deepEqual(sent.map(([channel]) => channel), Array(8).fill('modpacks:preflight-progress'));
  assert.deepEqual(sent.map(([, event]) => event.phase), [
    'validating-destination',
    'preparing-candidate',
    'preparing-candidate',
    'scanning-server',
    'calculating-changes',
    'checking-capacity',
    'sealing-plan',
    'complete'
  ]);
  assert.ok(sent.every(([, event]) => event.requestId === 'preflight-renderer-one'));
});

test('management preflight IPC reports validated backend progress and strips renderer correlation authority', async () => {
  const sent = [];
  let receivedRequest = null;
  const createManagementPlan = async (request, { onProgress }) => {
    receivedRequest = request;
    onProgress({ phase: 'scanning-server' });
    onProgress({
      phase: 'verifying-restore-point',
      activity: 'verifying-archive',
      processedBytes: 5,
      totalBytes: 10
    });
    onProgress({ phase: 'calculating-changes' });
    onProgress({ phase: 'checking-capacity' });
    onProgress({ phase: 'sealing-plan' });
    onProgress({ phase: 'complete' });
    return { planId: 'plan-management-one' };
  };
  const handlers = createModpackHandlers(dependencies(async () => ({}), createManagementPlan));
  const result = await handlers['modpacks:preflight-management']({
    sender: { id: 9, send: (...args) => sent.push(args) }
  }, {
    serverId: 'server-one',
    operationKind: 'rollback-restore-point',
    selectionRef: 'restore-one',
    requestId: 'preflight-management-renderer-one'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(receivedRequest, {
    instanceId: 'server-one',
    operationKind: 'rollback-restore-point',
    selectionRef: 'restore-one'
  });
  assert.deepEqual(sent.map(([channel]) => channel), Array(6).fill('modpacks:preflight-progress'));
  assert.deepEqual(sent.map(([, event]) => event.phase), [
    'scanning-server',
    'verifying-restore-point',
    'calculating-changes',
    'checking-capacity',
    'sealing-plan',
    'complete'
  ]);
  assert.ok(sent.every(([, event]) => event.requestId === 'preflight-management-renderer-one'));
});

test('a review refused as stale leaves its closed codes in the app log, never a path or a message', async () => {
  const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
  const lockPath = String.raw`C:\Servers\Adrenaline\world\session.lock`;
  const busy = Object.assign(new Error(`EBUSY: resource busy or locked, read '${lockPath}'`), {
    code: 'EBUSY', syscall: 'read', path: lockPath
  });
  const inUse = new ModpackError('PLAN_STALE', 'Modpack or server files changed or were locked while this review read them. ' +
    'If the server is running, stop it, then review again. Nothing was changed on the server.', {
    cause: new ModpackError('PLAN_STALE', 'The server changed while its modpack plan was prepared', { cause: busy }),
    details: { reasonCode: 'server-files-in-use' },
    retryable: true
  });
  const logged = [];
  const logger = { warn: (message, options) => logged.push([message, options]) };
  const refuse = async () => { throw inUse; };
  const handlers = createModpackHandlers({ ...dependencies(refuse, refuse), logger });
  const sender = { id: 3, send() {} };

  const source = await handlers['modpacks:preflight']({ sender }, { ...REQUEST, requestId: 'preflight-stale' });
  const management = await handlers['modpacks:preflight-management']({ sender }, {
    serverId: 'server-one', operationKind: 'uninstall', selectionRef: null, requestId: 'preflight-management-stale'
  });

  for (const result of [source, management]) {
    assert.equal(result.ok, false);
    assert.deepEqual(result.error.details, { reasonCode: 'server-files-in-use' });
  }
  const entry = operation => ['A modpack review was refused as stale', {
    category: 'core',
    data: { operation, code: 'PLAN_STALE', reasonCode: 'server-files-in-use', causeCode: 'EBUSY' }
  }];
  assert.deepEqual(logged, [entry('preflight'), entry('preflight-management')]);
  assert.doesNotMatch(JSON.stringify(logged), /Servers|Adrenaline|session\.lock|stop it/u);

  // Any other refusal leaves the log alone, and a missing logger changes nothing.
  logged.length = 0;
  const other = createModpackHandlers({
    ...dependencies(async () => { throw new ModpackError('DOWNGRADE_REQUIRED', 'Retry this operation as a downgrade.'); }),
    logger
  });
  assert.equal((await other['modpacks:preflight']({ sender }, { ...REQUEST, requestId: 'preflight-downgrade' })).ok, false);
  assert.deepEqual(logged, []);
  const unlogged = await createModpackHandlers(dependencies(refuse))['modpacks:preflight']({ sender }, {
    ...REQUEST, requestId: 'preflight-unlogged'
  });
  assert.deepEqual(unlogged.error.details, { reasonCode: 'server-files-in-use' });
});
