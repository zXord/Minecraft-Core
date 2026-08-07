const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const {
  createModpackServiceGraph,
  deriveRecoveryRuntimeTuple,
  createLiveInstanceResolver
} = require('../../electron/bootstrap/create-modpack-service-graph.cjs');

function fakeModpackComposition(overrides = {}) {
  const lifecycleService = { marker: 'production-lifecycle' };
  const notificationStore = { list() {}, acknowledge() {} };
  const releaseMonitor = { async checkAll() {}, async checkOne() {}, async start() {}, stop() {} };
  const releaseTrackingStore = { upsert() {} };
  const outcomeActionService = { performSafeAction() {} };
  const localArtifactSource = { selectWithNativeDialog() {} };
  const destinationReservationService = { reserveWithNativeDialog() {} };
  const recoveryService = { listRecovery() {}, recover() {} };
  const nativeNotificationBridge = { start() {}, stop() {} };
  return {
    lifecycleService,
    notificationStore,
    releaseMonitor,
    releaseTrackingStore,
    outcomeActionService,
    localArtifactSource,
    destinationReservationService,
    recoveryService,
    nativeNotificationBridge,
    async initialize() {},
    dispose() {},
    ...overrides
  };
}

function graphFixture(overrides = {}) {
  const userDataPath = path.join(os.tmpdir(), 'minecraft-core-service-graph-user-data');
  const runtimeRoot = path.resolve(__dirname, '../..');
  const resourcesPath = path.join(runtimeRoot, 'fixtures', 'resources');
  const store = { get: () => [] };
  const coordinator = {
    runMutation() {},
    runManyMutations() {},
    runRecoveryMutation() {},
    beginStartupRecovery() {},
    installRecoveryBlocks() {},
    completeStartupRecovery() {}
  };
  const serverMutationPolicy = { wrapHandler: value => value, wrapHandlers: value => value };
  const dnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const httpsRequest = () => { throw new Error('not called'); };
  const randomUUID = () => '00000000-0000-4000-8000-000000000001';
  const randomBytes = size => Buffer.alloc(size, 7);
  const workerFactory = options => ({ type: 'worker', options });
  const processFactory = options => ({ type: 'process', options });
  const windowFactory = () => ({ id: 9 });
  const clock = { now: () => 1_750_000_000_000 };
  const modpackFactory = async () => fakeModpackComposition();
  const app = {
    isPackaged: false,
    getPath(name) {
      if (name !== 'userData') throw new Error(`Unexpected app path ${name}`);
      return userDataPath;
    }
  };

  const graph = createModpackServiceGraph({
    app,
    store,
    userDataPath,
    runtimeRoots: { resourcesPath, runtimeRoot, isPackaged: false, arch: 'x64' },
    clock,
    dnsLookup,
    httpsRequest,
    randomUUID,
    randomBytes,
    workerFactory,
    processFactory,
    windowFactory,
    coordinator,
    serverMutationPolicy,
    modpackFactory,
    ...overrides
  });
  return {
    app,
    clock,
    coordinator,
    dnsLookup,
    graph,
    httpsRequest,
    processFactory,
    randomBytes,
    randomUUID,
    resourcesPath,
    runtimeRoot,
    serverMutationPolicy,
    store,
    userDataPath,
    windowFactory,
    workerFactory
  };
}

test('live instance resolver reads the current exact server record on every call', async () => {
  let instances = [{ id: 'server-one', name: 'One', type: 'server', path: 'C:\\servers\\one' }];
  let lookups = 0;
  const store = {
    get(key) {
      assert.equal(key, 'instances');
      lookups += 1;
      return instances;
    }
  };
  const resolver = createLiveInstanceResolver({
    store,
    isInstanceRunning({ instanceId, serverPath }) {
      return instanceId === 'server-one' && serverPath === 'C:\\servers\\two';
    }
  });

  assert.deepEqual(await resolver.resolveInstance('server-one'), {
    instanceId: 'server-one', serverPath: path.resolve('C:\\servers\\one'), priorRunning: false
  });
  instances = [{ id: 'server-one', name: 'One', type: 'server', path: 'C:\\servers\\two' }];
  assert.deepEqual(await resolver.resolveInstance('server-one'), {
    instanceId: 'server-one', serverPath: path.resolve('C:\\servers\\two'), priorRunning: true
  });
  assert.equal(lookups, 2);

  instances = [
    { id: 'server-one', type: 'server', path: 'C:\\servers\\two' },
    { id: 'server-one', type: 'server', path: 'C:\\servers\\other' }
  ];
  await assert.rejects(resolver.resolveInstance('server-one'), error => error?.code === 'PLAN_STALE');
});

test('startup recovery composes and initializes the complete modpack IPC graph before exposure', async () => {
  const order = [];
  const composedProviders = { modrinth: { fake: 'modrinth' }, github: { fake: 'github' } };
  const recoveryServices = {
    registry: { async initialize() { return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
    recoveryService: { async recoverAll() { return { recovered: [], unresolved: [] }; } },
    runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } }
  };
  const composition = fakeModpackComposition({
    providers: composedProviders,
    async initialize() { order.push('modpacks:initialize'); },
    releaseMonitor: {
      async checkAll() {}, async checkOne() {},
      async start() { order.push('monitor:start'); },
      stop() { order.push('monitor:stop'); }
    },
    nativeNotificationBridge: {
      start() { order.push('notifications:start'); },
      stop() { order.push('notifications:stop'); }
    },
    dispose() { order.push('modpacks:dispose'); }
  });
  let factoryCalls = 0;
  const { graph } = graphFixture({
    async recoveryFactory() { return recoveryServices; },
    async modpackFactory(input) {
      factoryCalls += 1;
      order.push('modpacks:compose');
      assert.equal(input.rawRecoveryServices, recoveryServices);
      assert.equal(typeof input.instanceResolver.resolveInstance, 'function');
      return composition;
    }
  });

  assert.equal(graph.modpacks.lifecycleService, null);
  await graph.startup.initializeRecovery(graph);
  assert.equal(factoryCalls, 1);
  assert.equal(graph.modpacks.lifecycleService, composition.lifecycleService);
  assert.equal(graph.modpacks.providers, composedProviders);
  assert.equal(graph.modpacks.localArtifactSource, composition.localArtifactSource);
  assert.equal(graph.modpacks.destinationReservationService, composition.destinationReservationService);
  assert.equal(graph.modpacks.recoveryService, composition.recoveryService);
  assert.equal(graph.modpacks.notificationStore, composition.notificationStore);
  assert.equal(graph.modpacks.releaseMonitor, composition.releaseMonitor);
  assert.equal(graph.modpacks.releaseTrackingStore, composition.releaseTrackingStore);
  assert.equal(graph.modpacks.outcomeActionService, composition.outcomeActionService);
  assert.deepEqual(order, ['modpacks:compose', 'modpacks:initialize']);

  await graph.startup.afterWindowCreated?.(graph);
  assert.deepEqual(order.slice(-2), ['notifications:start', 'monitor:start']);
  await graph.startup.dispose?.(graph);
  assert.deepEqual(order.slice(-3), ['monitor:stop', 'notifications:stop', 'modpacks:dispose']);
});

test('service graph shares injected transport, clock, roots, factories, and coordinator', () => {
  const fixture = graphFixture();
  const { graph } = fixture;

  assert.equal(Object.isFrozen(graph), true);
  assert.equal(Object.isFrozen(graph.providers), true);
  assert.equal(Object.isFrozen(graph.runtimeRoots), true);
  assert.equal(graph.app, fixture.app);
  assert.equal(graph.store, fixture.store);
  assert.equal(graph.clock, fixture.clock);
  assert.equal(graph.network.lookup, fixture.dnsLookup);
  assert.equal(graph.network.request, fixture.httpsRequest);
  assert.equal(graph.network.http.lookup, fixture.dnsLookup);
  assert.equal(graph.network.http.requestImpl, fixture.httpsRequest);
  assert.equal(graph.providers.modrinth.http.client, graph.network.http);
  assert.equal(graph.providers.modrinth.http.baseUrl.href, 'https://api.modrinth.com/v2/');
  assert.equal(graph.providers.github.http.client, graph.network.http);
  assert.equal(graph.providers.github.http.baseUrl.href, 'https://api.github.com/');
  assert.equal(graph.providers.github.clock, fixture.clock);
  assert.equal(graph.random.randomUUID, fixture.randomUUID);
  assert.equal(graph.random.randomBytes, fixture.randomBytes);
  assert.equal(graph.factories.worker, fixture.workerFactory);
  assert.equal(graph.factories.process, fixture.processFactory);
  assert.equal(graph.window.create, fixture.windowFactory);
  assert.equal(graph.coordinator, fixture.coordinator);
  assert.equal(graph.serverMutationPolicy, fixture.serverMutationPolicy);
  assert.equal(graph.paths.userData, path.resolve(fixture.userDataPath));
  assert.equal(graph.paths.modpacks.root, path.join(path.resolve(fixture.userDataPath), 'modpack-lifecycle'));
  assert.deepEqual(graph.runtimeRoots, {
    resourcesPath: path.resolve(fixture.resourcesPath),
    runtimeRoot: path.resolve(fixture.runtimeRoot),
    isPackaged: false,
    arch: 'x64'
  });
});

test('service graph preserves explicit provider adapters instead of constructing hidden globals', () => {
  const modrinth = { name: 'fake-modrinth' };
  const github = { name: 'fake-github' };
  const local = { name: 'fake-local' };
  const { graph } = graphFixture({ providerAdapters: { modrinth, github, local } });

  assert.equal(graph.providers.modrinth, modrinth);
  assert.equal(graph.providers.github, github);
  assert.equal(graph.providers.local, local);
});

test('startup recovery derives an exact legacy runtime tuple when no managed state exists yet', () => {
  assert.deepEqual(deriveRecoveryRuntimeTuple({
    version: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.3.12'
  }), {
    minecraftVersion: '1.20.1',
    loaderFamily: 'forge',
    loaderVersion: '47.3.12',
    javaMajor: 17,
    os: 'win32',
    architecture: 'x64'
  });
  assert.deepEqual(deriveRecoveryRuntimeTuple({ version: '1.21.1' }), {
    minecraftVersion: '1.21.1',
    loaderFamily: 'vanilla',
    loaderVersion: '1.21.1',
    javaMajor: 21,
    os: 'win32',
    architecture: 'x64'
  });
  assert.throws(
    () => deriveRecoveryRuntimeTuple({ version: '1.21.1', loader: 'fabric' }),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
});

test('service graph lazily composes and runs real startup recovery exactly once', async () => {
  const order = [];
  let factoryCalls = 0;
  let scans = 0;
  const coordinator = {
    runMutation() {},
    runManyMutations() {},
    runRecoveryMutation() {},
    beginStartupRecovery() { order.push('begin'); },
    installRecoveryBlocks() { throw new Error('empty scan cannot install a block'); },
    completeStartupRecovery(outcomes, options) {
      order.push('complete');
      assert.deepEqual(outcomes, []);
      assert.deepEqual(options, { globalBlock: false });
    }
  };
  const registry = {
    async initialize() {
      scans += 1;
      order.push(`scan-${scans}`);
      return { records: [], corrupt: [], blocks: [], globalBlock: false };
    }
  };
  const recoveryService = {
    async recoverAll(scan) {
      order.push('recover-all');
      assert.deepEqual(scan.records, []);
      return { recovered: [], unresolved: [] };
    }
  };
  const runtimeVerifier = {
    async verifyBeforeRecovery() {
      order.push('runtime-quiescent');
      return { quiescent: true };
    }
  };
  const { graph } = graphFixture({
    coordinator,
    async recoveryFactory(input) {
      factoryCalls += 1;
      assert.equal(input.coordinator, coordinator);
      return { registry, recoveryService, runtimeVerifier };
    }
  });

  assert.equal(factoryCalls, 0);
  assert.equal(Object.hasOwn(graph.startup, 'completeRecovery'), false);
  const first = await graph.startup.initializeRecovery(graph);
  const second = await graph.startup.initializeRecovery(graph);

  assert.equal(first, second);
  assert.equal(factoryCalls, 1);
  assert.equal(graph.recovery.getServices().registry, registry);
  assert.deepEqual(order, ['begin', 'runtime-quiescent', 'scan-1', 'recover-all', 'scan-2', 'complete']);
});

test('service graph rejects a relative userData path before constructing services', () => {
  assert.throws(
    () => graphFixture({ userDataPath: 'relative-user-data' }),
    /userData/i
  );
});

test('IPC setup consumes the graph store, filesystem, and mutation policy', () => {
  const modulePath = path.resolve(__dirname, '../../electron/ipc-handlers.cjs');
  const originalLoad = Module._load;
  const registered = new Set();
  const wrapped = [];
  const initializedPaths = [];
  let nativeNotificationStartEnabled = null;
  let receivedModpackDependencies = null;
  const ipcMain = {
    handle(channel) { registered.add(channel); },
    removeHandler(channel) { registered.delete(channel); }
  };
  const fallbackStore = { get() { throw new Error('fallback store used'); } };
  const fallbackFs = { existsSync() { throw new Error('fallback filesystem used'); } };
  const graphStore = {
    get(key) {
      if (key === 'instances') return [];
      if (key === 'lastServerPath') return 'C:\\servers\\injected';
      return null;
    }
  };
  const graphFs = { existsSync: value => value === 'C:\\servers\\injected' };
  const graphPolicy = {
    wrapHandler(channel, handler) { wrapped.push(channel); return handler; },
    wrapHandlers(handlers) { wrapped.push(...Object.keys(handlers)); return handlers; }
  };
  const emptyFactory = () => ({});

  Module._load = function loadIpcFixture(request, parent, isMain) {
    if (request === 'electron') return { ipcMain };
    if (request === 'fs') return fallbackFs;
    if (request === './utils/app-store.cjs') return fallbackStore;
    if (request === './utils/ipc-helpers.cjs') {
      return {
        registeredHandlers: registered,
        registerIpcHandlers(handlers) {
          for (const channel of Object.keys(handlers)) registered.add(channel);
        }
      };
    }
    if (request === './ipc/player-handlers.cjs') {
      return { createPlayerHandlers: () => ({ 'player:read': () => true }), initializePlayerIpMap: value => initializedPaths.push(value) };
    }
    if (request === './ipc/backup-handlers.cjs') return { createBackupHandlers: emptyFactory, loadBackupManager: () => {} };
    if (request === './ipc/logger-handlers.cjs') return { getLoggerHandlers: () => ({ info: () => {} }) };
    if (request === './services/server-mutation-policy.cjs') {
      return { createServerMutationPolicy() { throw new Error('fallback mutation policy used'); } };
    }
    if (request === './services/auto-restart.cjs') return { setAutoRestartOptions: () => {}, getAutoRestartState: () => ({}) };
    if (/^\.\/ipc\/.+\.cjs$/.test(request)) {
      const exportNames = {
        './ipc/server-handlers.cjs': 'createServerHandlers',
        './ipc/file-handlers.cjs': 'createFileHandlers',
        './ipc/install-handlers.cjs': 'createInstallHandlers',
        './ipc/settings-handlers.cjs': 'createSettingsHandlers',
        './ipc/mod-handlers.cjs': 'createModHandlers',
        './ipc/mod-handlers/client-mod-handlers.cjs': 'createClientModHandlers',
        './ipc/config-handlers.cjs': 'createConfigHandlers',
        './ipc/server-properties-handlers.cjs': 'createServerPropertiesHandlers',
        './ipc/management-server-handlers.cjs': 'createManagementServerHandlers',
        './ipc/browser-panel-handlers.cjs': 'createBrowserPanelHandlers',
        './ipc/minecraft-launcher-handlers.cjs': 'createMinecraftLauncherHandlers',
        './ipc/server-java-handlers.cjs': 'createServerJavaHandlers',
        './ipc/app-settings-handlers.cjs': 'createAppSettingsHandlers',
        './ipc/update-handlers.cjs': 'createUpdateHandlers',
        './ipc/metrics-handlers.cjs': 'createMetricsHandlers',
        './ipc/error-monitoring-handlers.cjs': 'createErrorMonitoringHandlers',
        './ipc/utility-handlers.cjs': 'createUtilityHandlers',
        './ipc/mod-availability-handlers.cjs': 'createModAvailabilityHandlers'
      };
      if (exportNames[request]) return { [exportNames[request]]: emptyFactory };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const { setupIpcHandlers } = require(modulePath);
    setupIpcHandlers({ webContents: { on: () => {} } }, {
      store: graphStore,
      filesystem: { sync: graphFs },
      serverMutationPolicy: graphPolicy,
      modpacks: { lifecycleService: { marker: 'lifecycle' } },
      ipc: {
        nativeNotificationsEnabled: false,
        handlerFactories: {
          createModAvailabilityHandlers(options) {
            nativeNotificationStartEnabled = options?.startWatcher;
            return { 'mod-watch:list': () => [] };
          },
          createModpackHandlers(value) {
            receivedModpackDependencies = value;
            return { 'modpacks:get-job': () => ({ ok: true }) };
          }
        }
      }
    });
    assert.deepEqual(initializedPaths, ['C:\\servers\\injected']);
    assert.equal(nativeNotificationStartEnabled, false);
    assert.equal(wrapped.includes('player:read'), true);
    assert.equal(registered.has('get-auto-restart'), true);
    assert.equal(receivedModpackDependencies.lifecycleService.marker, 'lifecycle');
    assert.equal(registered.has('modpacks:get-job'), true);
    assert.equal(wrapped.includes('modpacks:get-job'), true);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
});

test('mod availability IPC can stay registered without starting its native watcher', () => {
  const modulePath = path.resolve(__dirname, '../../electron/ipc/mod-availability-handlers.cjs');
  const originalLoad = Module._load;
  let starts = 0;
  const asyncValue = async () => [];
  Module._load = function loadAvailabilityFixture(request, parent, isMain) {
    if (request === '../services/mod-availability-watcher.cjs') {
      return {
        addModAvailabilityWatch: asyncValue,
        removeModAvailabilityWatch: asyncValue,
        clearModAvailabilityWatches: asyncValue,
        listModAvailabilityWatches: asyncValue,
        getModAvailabilityHistory: asyncValue,
        clearModAvailabilityHistory: asyncValue,
        setModAvailabilityInterval: asyncValue,
        getModAvailabilityConfig: asyncValue,
        startModAvailabilityWatcher() { starts += 1; }
      };
    }
    if (request === './logger-handlers.cjs') return { getLoggerHandlers: () => ({}) };
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const { createModAvailabilityHandlers } = require(modulePath);
    const handlers = createModAvailabilityHandlers({ startWatcher: false });
    assert.equal(starts, 0);
    assert.equal(typeof handlers['mod-watch:list'], 'function');
    createModAvailabilityHandlers();
    assert.equal(starts, 1);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
});
