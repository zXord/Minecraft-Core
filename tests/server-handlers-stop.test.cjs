const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const SELECTOR = Object.freeze({
  instanceId: 'disposable-server',
  targetPath: 'C:\\Temp\\minecraft-core-stop-test\\server'
});

async function withStopHandler(shutdownMinecraftServer, work) {
  const modulePath = path.resolve(__dirname, '../electron/ipc/server-handlers.cjs');
  const originalLoad = Module._load;
  const shutdownCalls = [];

  Module._load = function loadStopHandlerFixture(request, parent, isMain) {
    if (request === '../services/server-manager.cjs' || request.endsWith('/services/server-manager.cjs')) {
      return {
        startMinecraftServer: async () => ({ success: true }),
        async shutdownMinecraftServer(selector, options) {
          shutdownCalls.push({ selector, options });
          return shutdownMinecraftServer(selector, options);
        },
        killMinecraftServer: () => true,
        sendServerCommand: () => true,
        getServerState: () => ({ instanceId: SELECTOR.instanceId, isRunning: true, status: 'running' }),
        getAllServerStates: () => []
      };
    }
    if (request === './logger-handlers.cjs' || request.endsWith('/ipc/logger-handlers.cjs')) {
      return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    }
    if (request === '../utils/config-manager.cjs' || request.endsWith('/utils/config-manager.cjs')) {
      return { readServerConfig: () => null, getDefaultServerConfig: values => ({ ...values }) };
    }
    if (request === '../utils/port-validator.cjs' || request.endsWith('/utils/port-validator.cjs')) {
      return { validateServerPorts: async () => ({ valid: true, errors: [] }) };
    }
    if (request === '../utils/app-store.cjs' || request.endsWith('/utils/app-store.cjs')) {
      return { get: () => [], set() {} };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];
  try {
    const { createServerHandlers } = require(modulePath);
    return await work(createServerHandlers()['stop-server'], shutdownCalls);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

function shutdownResult(results) {
  return {
    success: results.every(result => result.stopped),
    forced: false,
    alreadyStopped: results.every(result => result.alreadyStopped),
    instanceIds: results.map(result => result.instanceId),
    results
  };
}

function serverResult(overrides) {
  return {
    instanceId: SELECTOR.instanceId,
    targetPath: SELECTOR.targetPath,
    stopped: false,
    forced: false,
    alreadyStopped: false,
    gracefulRequested: true,
    ...overrides
  };
}

test('a stop delivered to a server that is still saving at the timeout reports stopping, not a failure', async () => {
  await withStopHandler(async () => shutdownResult([serverResult({ stopped: false, gracefulRequested: true })]), async (stop, calls) => {
    const result = await stop({}, SELECTOR);
    assert.deepEqual(result, { success: true, stopping: true, forced: false, alreadyStopped: false });
    assert.deepEqual(calls, [{
      selector: { instanceId: SELECTOR.instanceId, targetPath: SELECTOR.targetPath },
      options: { gracefulTimeoutMs: 60000, killTimeoutMs: 5000, forceKill: false }
    }]);
  });
});

test('a stop that could not be delivered is reported as a failure', async () => {
  await withStopHandler(async () => shutdownResult([serverResult({ stopped: false, gracefulRequested: false })]), async stop => {
    const result = await stop({}, SELECTOR);
    assert.equal(result.success, false);
    assert.equal(result.stopping, undefined);
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, /Kill/);
  });

  // One delivered stop does not hide another server that could not be asked to stop.
  await withStopHandler(async () => shutdownResult([
    serverResult({ stopped: false, gracefulRequested: true }),
    serverResult({ instanceId: 'other-server', stopped: false, gracefulRequested: false })
  ]), async stop => {
    assert.equal((await stop({}, SELECTOR)).success, false);
  });
});

test('a completed or unnecessary stop keeps its existing result', async () => {
  await withStopHandler(async () => shutdownResult([serverResult({ stopped: true })]), async stop => {
    assert.deepEqual(await stop({}, SELECTOR), { success: true, forced: false, alreadyStopped: false });
  });
  await withStopHandler(async () => ({ success: true, alreadyStopped: true, instanceIds: [] }), async stop => {
    assert.deepEqual(await stop({}, SELECTOR), { success: true, forced: false, alreadyStopped: true });
  });
  await withStopHandler(async () => shutdownResult([
    serverResult({ stopped: true }),
    serverResult({ instanceId: 'saving-server', stopped: false, gracefulRequested: true })
  ]), async stop => {
    assert.deepEqual(await stop({}, SELECTOR), { success: true, stopping: true, forced: false, alreadyStopped: false });
  });
});
