const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { createMainBootstrap } = require('../electron/bootstrap/create-main-bootstrap.cjs');
const { createRuntimeFlags } = require('../electron/bootstrap/runtime-flags.cjs');

function recorder(order, name, result) {
  return async (...args) => {
    order.push(name);
    return typeof result === 'function' ? result(...args) : result;
  };
}

function bootstrapFixture({ testMode }) {
  const order = [];
  const userDataPath = path.join(os.tmpdir(), `minecraft-core-main-bootstrap-${testMode ? 'test' : 'production'}`);
  const appCalls = [];
  const app = {
    setName(value) { appCalls.push(['setName', value]); },
    setAppUserModelId(value) { appCalls.push(['setAppUserModelId', value]); },
    setPath(name, value) { appCalls.push(['setPath', name, value]); }
  };
  const window = Object.freeze({ id: 7 });
  const services = {
    updater: { start: recorder(order, 'updater:start'), dispose: recorder(order, 'updater:dispose') },
    tray: { start: recorder(order, 'tray:start'), dispose: recorder(order, 'tray:dispose') },
    watchdog: { start: recorder(order, 'watchdog:start'), dispose: recorder(order, 'watchdog:dispose') },
    nativeNotifications: { start: recorder(order, 'notifications:start'), dispose: recorder(order, 'notifications:dispose') },
    managementServer: { listen: recorder(order, 'management:listen'), dispose: recorder(order, 'management:dispose') }
  };
  const serviceGraph = {
    paths: { userData: userDataPath },
    startup: {
      installSecurity: recorder(order, 'security:install'),
      initializeRecovery: recorder(order, 'recovery:initialize'),
      cleanupRuntime: recorder(order, 'runtime:cleanup'),
      configureAfterReady: recorder(order, 'security:configure'),
      afterWindowCreated: recorder(order, 'window:after'),
      dispose: recorder(order, 'startup:dispose')
    },
    window: { create: recorder(order, 'window:create', window) },
    ...services
  };
  const runtimeFlags = createRuntimeFlags({
    env: testMode
      ? { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: userDataPath }
      : { NODE_ENV: 'production', MINECRAFT_CORE_TEST_MODE: '1' },
    platform: 'win32'
  });
  const bootstrap = createMainBootstrap({ electronApi: { app }, serviceGraph, runtimeFlags });
  return { appCalls, bootstrap, order, runtimeFlags, serviceGraph, userDataPath, window };
}

test('test mode is honored only under NODE_ENV=test and carries an isolated userData path', () => {
  const isolated = path.join(os.tmpdir(), 'minecraft-core-runtime-flags');
  const testFlags = createRuntimeFlags({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: isolated },
    platform: 'win32'
  });
  const productionFlags = createRuntimeFlags({
    env: { NODE_ENV: 'production', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: isolated },
    platform: 'win32'
  });

  assert.deepEqual(testFlags, {
    testMode: true,
    platform: 'win32',
    isolatedUserDataPath: path.resolve(isolated),
    updaterEnabled: false,
    trayEnabled: false,
    watchdogEnabled: false,
    nativeNotificationsEnabled: false,
    publicManagementListenersEnabled: false
  });
  assert.equal(productionFlags.testMode, false);
  assert.equal(productionFlags.isolatedUserDataPath, null);
  assert.equal(productionFlags.updaterEnabled, true);
  assert.equal(productionFlags.publicManagementListenersEnabled, true);
  assert.equal(Object.isFrozen(testFlags), true);
});

test('packaged binaries ignore test-mode environment flags', () => {
  const isolated = path.join(os.tmpdir(), 'minecraft-core-packaged-test-attempt');
  const flags = createRuntimeFlags({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: isolated },
    platform: 'win32',
    isPackaged: true
  });

  assert.equal(flags.testMode, false);
  assert.equal(flags.isolatedUserDataPath, null);
  assert.equal(flags.updaterEnabled, true);
  assert.equal(flags.publicManagementListenersEnabled, true);
});

test('test mode cannot accidentally start updater or public services', async () => {
  const { appCalls, bootstrap, order, userDataPath, window } = bootstrapFixture({ testMode: true });

  bootstrap.initializeBeforeReady();
  const result = await bootstrap.onReady();

  assert.equal(result, window);
  assert.deepEqual(appCalls, [
    ['setPath', 'userData', userDataPath],
    ['setName', 'Minecraft Core'],
    ['setAppUserModelId', 'com.minecraft-core.app']
  ]);
  assert.deepEqual(order, [
    'security:install',
    'recovery:initialize',
    'runtime:cleanup',
    'security:configure',
    'window:create',
    'window:after'
  ]);
  assert.equal(order.includes('updater:start'), false);
  assert.equal(order.includes('management:listen'), false);
  assert.equal(order.includes('tray:start'), false);
  assert.equal(order.includes('watchdog:start'), false);
  assert.equal(order.includes('notifications:start'), false);
});

test('production startup completes recovery before launches and dispose is reverse-order idempotent', async () => {
  const { bootstrap, order } = bootstrapFixture({ testMode: false });

  bootstrap.initializeBeforeReady();
  await Promise.all([bootstrap.onReady(), bootstrap.onReady()]);
  await bootstrap.dispose();
  await bootstrap.dispose();

  assert.deepEqual(order, [
    'security:install',
    'recovery:initialize',
    'runtime:cleanup',
    'security:configure',
    'tray:start',
    'window:create',
    'updater:start',
    'watchdog:start',
    'notifications:start',
    'management:listen',
    'window:after',
    'management:dispose',
    'notifications:dispose',
    'watchdog:dispose',
    'updater:dispose',
    'tray:dispose',
    'startup:dispose'
  ]);
});

test('startup fails closed before window creation when no recovery boundary is injected', async () => {
  let windowsCreated = 0;
  const runtimeFlags = createRuntimeFlags({ env: { NODE_ENV: 'production' }, platform: 'win32' });
  const bootstrap = createMainBootstrap({
    electronApi: { app: { setName() {}, setAppUserModelId() {} } },
    serviceGraph: {
      paths: { userData: path.join(os.tmpdir(), 'minecraft-core-no-recovery') },
      window: { create() { windowsCreated += 1; return {}; } }
    },
    runtimeFlags
  });

  await assert.rejects(bootstrap.onReady(), /recovery/i);
  assert.equal(windowsCreated, 0);
});

test('production main entry delegates lifecycle ownership to the injected bootstrap', () => {
  const mainPath = path.resolve(__dirname, '../electron/main.cjs');
  const originalLoad = Module._load;
  const calls = [];
  const pendingReady = new Promise(() => {});
  const app = {
    isPackaged: false,
    getVersion: () => 'test',
    getPath: () => path.join(os.tmpdir(), 'minecraft-core-main-entry'),
    on: () => {},
    quit: () => {},
    setName: () => {},
    setAppUserModelId: () => {},
    setPath: () => {},
    whenReady() { calls.push('app:when-ready'); return pendingReady; }
  };
  const electron = {
    app,
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    Menu: { setApplicationMenu: () => {} },
    Tray: function FakeTray() {},
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    session: { defaultSession: { setCertificateVerifyProc: () => {} } },
    shell: { openExternal: async () => {}, openPath: async () => '' }
  };
  const store = { get: () => null, set: () => {} };
  const runtimeFlags = { testMode: false };
  const graph = { id: 'graph' };
  const bootstrap = {
    initializeBeforeReady() { calls.push('bootstrap:initialize'); },
    onReady() { calls.push('bootstrap:ready'); },
    dispose() { calls.push('bootstrap:dispose'); }
  };

  Module._load = function loadMainFixture(request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === './ipc-handlers.cjs') {
      calls.push('ipc-module:load');
      return { setupIpcHandlers: () => {} };
    }
    if (request === './utils/app-cleanup.cjs') return { setupAppCleanup: () => {} };
    if (request === './utils/safe-send.cjs') return { setMainWindow: () => {} };
    if (request === './utils/app-store.cjs') return store;
    if (request === './utils/config-manager.cjs') return { ensureConfigFile: () => {} };
    if (request === './utils/navigation-policy.cjs') return { shouldAllowNavigation: () => false };
    if (request === './utils/runtime-paths.cjs') return { cleanupRuntimeFiles: () => {} };
    if (request === './utils/tls-utils.cjs') return { getTlsFingerprint: () => null, normalizeFingerprint: value => value };
    if (request === './utils/runtime-mode.cjs') return { shouldUseDevServer: () => false };
    if (request === './services/update-service.cjs') return { getUpdateService: () => ({ startPeriodicChecks: () => {} }) };
    if (request === './services/server-mutation-coordinator.cjs') return { ServerMutationCoordinator: class {} };
    if (request === './services/server-mutation-context.cjs') return { installServerMutationCoordinator: () => {} };
    if (request === './services/logger-service.cjs') return { getLogger: () => ({ info: () => {}, fatal: () => {} }) };
    if (request === '../config/dev-config.cjs') return { enableDevConsole: false, enableDevServer: false };
    if (request === './bootstrap/runtime-flags.cjs') return {
      createRuntimeFlags() { calls.push('flags:create'); return runtimeFlags; }
    };
    if (request === './bootstrap/create-modpack-service-graph.cjs') {
      calls.push('graph-module:load');
      return {
        createModpackServiceGraph(dependencies) {
          calls.push('graph:create');
          assert.equal(dependencies.app, app);
          assert.equal(dependencies.store, store);
          return graph;
        }
      };
    }
    if (request === './bootstrap/create-main-bootstrap.cjs') {
      calls.push('bootstrap-module:load');
      return {
        createMainBootstrap(dependencies) {
          calls.push('bootstrap:create');
          assert.equal(dependencies.electronApi.app, app);
          assert.equal(dependencies.serviceGraph, graph);
          assert.equal(dependencies.runtimeFlags, runtimeFlags);
          return bootstrap;
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[mainPath];
  try {
    require(mainPath);
    assert.deepEqual(calls, [
      'flags:create',
      'bootstrap-module:load',
      'graph-module:load',
      'graph:create',
      'bootstrap:create',
      'bootstrap:initialize',
      'app:when-ready'
    ]);
  } finally {
    delete require.cache[mainPath];
    Module._load = originalLoad;
  }
});
