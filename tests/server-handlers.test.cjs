const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function withServerHandlers({ state, configuredPort = 25565, shutdownMinecraftServer = async () => ({ success: true }) }, fn) {
  const modulePath = path.resolve(__dirname, '../electron/ipc/server-handlers.cjs');
  const originalLoad = Module._load;

  Module._load = function loadServerHandlersFixture(request, parent, isMain) {
    if (request.endsWith('/services/server-manager.cjs') || request === '../services/server-manager.cjs') {
      return {
        startMinecraftServer: async () => ({ success: true }),
        stopMinecraftServer: () => true,
        shutdownMinecraftServer,
        killMinecraftServer: () => true,
        sendServerCommand: () => true,
        getServerState: () => ({
          instanceId: 'disposable-server',
          isRunning: true,
          status: 'running',
          serverStartMs: 1,
          playersInfo: { count: 0, names: [] },
          port: 25565,
          targetPath: 'C:\\Temp\\minecraft-core-real-test\\server',
          loader: 'fabric',
          ...state
        }),
        getAllServerStates: () => []
      };
    }
    if (request.endsWith('/ipc/logger-handlers.cjs') || request === './logger-handlers.cjs') {
      return { getLoggerHandlers: () => ({ info() {}, warn() {}, error() {} }) };
    }
    if (request.endsWith('/utils/config-manager.cjs') || request === '../utils/config-manager.cjs') {
      return {
        readServerConfig: () => ({
          port: configuredPort,
          maxRam: 4,
          managementPort: 8080,
          autoStartMinecraft: false,
          autoStartManagement: false
        }),
        getDefaultServerConfig: values => ({
          port: 25565,
          maxRam: 4,
          managementPort: 8080,
          autoStartMinecraft: false,
          autoStartManagement: false,
          ...values
        })
      };
    }
    if (request.endsWith('/utils/port-validator.cjs') || request === '../utils/port-validator.cjs') {
      return { validateServerPorts: async () => ({ valid: true, errors: [] }) };
    }
    if (request.endsWith('/utils/app-store.cjs') || request === '../utils/app-store.cjs') {
      return { get: () => [], set() {} };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];
  try {
    const { createServerHandlers } = require(modulePath);
    return fn(createServerHandlers());
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

test('get-server-status reports the explicit port owned by a live server process', () => {
  withServerHandlers({
    configuredPort: 25565,
    state: { isRunning: true, status: 'running', port: 32123 }
  }, handlers => {
    const status = handlers['get-server-status']({}, {
      instanceId: 'disposable-server',
      targetPath: 'C:\\Temp\\minecraft-core-real-test\\server'
    });

    assert.equal(status.serverSettings.port, 32123);
  });
});

test('stop-server waits for the full server shutdown barrier', async () => {
  let releaseShutdown;
  const shutdown = new Promise(resolve => { releaseShutdown = resolve; });
  let settled = false;

  await withServerHandlers({
    state: { isRunning: true, status: 'running' },
    shutdownMinecraftServer: async selector => {
      assert.deepEqual(selector, {
        instanceId: 'disposable-server',
        targetPath: 'C:\\Temp\\minecraft-core-real-test\\server'
      });
      return shutdown;
    }
  }, async handlers => {
    const stopped = handlers['stop-server']({}, {
      instanceId: 'disposable-server',
      targetPath: 'C:\\Temp\\minecraft-core-real-test\\server'
    }).then(result => {
      settled = true;
      return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    releaseShutdown({ success: true, forced: false, alreadyStopped: false });
    assert.deepEqual(await stopped, { success: true, forced: false, alreadyStopped: false });
  });
});
