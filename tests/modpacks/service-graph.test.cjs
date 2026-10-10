const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const {
  createProductionDurableFsFactory,
  createModpackServiceGraph,
  deriveRecoveryRuntimeTuple,
  createLiveInstanceResolver
} = require('../../electron/bootstrap/create-modpack-service-graph.cjs');
const { createMainBootstrap } = require('../../electron/bootstrap/create-main-bootstrap.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');

test('production durable helper state is rooted beneath the explicit app user-data directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-helper-root-'));
  const userDataPath = path.join(root, 'user-data');
  const allowedRoot = path.join(root, 'server');
  fs.mkdirSync(userDataPath);
  fs.mkdirSync(allowedRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let receivedOptions = null;
  const durableFsFactory = createProductionDurableFsFactory({
    fsSync: fs,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    runtimeRoots: {
      resourcesPath: root,
      runtimeRoot: root,
      isPackaged: false,
      arch: 'x64'
    },
    userDataPath,
    durableClientFactory(options) {
      receivedOptions = options;
      return {
        moveWriteThrough() {},
        async moveWriteThroughAsync() {},
        replaceFileWriteThrough() {},
        async replaceFileWriteThroughAsync() {},
        flushDirectory() {},
        async flushDirectoryAsync() {}
      };
    }
  });

  const durableFs = durableFsFactory([allowedRoot]);

  assert.equal(typeof durableFs.writeJsonAtomic, 'function');
  assert.equal(typeof durableFs.writeJsonAtomicAsync, 'function');
  assert.equal(receivedOptions.appOwnedRoot, path.join(userDataPath, 'archive-worker', 'durable-fs'));
});

test('client durable factory requires positive native helper close for every scoped mutation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-durable-close-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let options;
  const factory = createProductionDurableFsFactory({ fsSync: fs, fsPromises: fs.promises,
    randomUUID: crypto.randomUUID, runtimeRoots: { runtimeRoot: root, isPackaged: false }, userDataPath: root,
    requireConfirmedClose: true, durableClientFactory(value) { options = value; return {
      moveWriteThrough() {}, replaceFileWriteThrough() {}, flushDirectory() {},
      async moveWriteThroughAsync() {}, async replaceFileWriteThroughAsync() {}, async flushDirectoryAsync() {} }; } });
  factory([root]); assert.equal(options.requireConfirmedClose, true);
});

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

test('startup inspects an imported server config without publishing defaults or reserving a mutation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-startup-config-readonly-'));
  const serverPath = path.join(root, 'imported-server');
  fs.mkdirSync(serverPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let mutationCalls = 0;
  let durabilityAcquisitions = 0;
  const coordinator = {
    runMutation() {
      mutationCalls += 1;
      throw new Error('startup inspection must not reserve a mutation');
    },
    runManyMutations() {},
    runRecoveryMutation() {},
    beginStartupRecovery() {},
    installRecoveryBlocks() {},
    completeStartupRecovery() {}
  };
  const values = {
    instances: [{ id: 'server-imported', name: 'Imported', type: 'server', path: serverPath }],
    lastServerPath: serverPath,
    serverSettings: { port: 25570, maxRam: 6 },
    autoRestart: { enabled: true, delay: 15, maxCrashes: 4 }
  };
  const store = {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; }
  };
  const { graph } = graphFixture({
    coordinator,
    durableFsFactory() {
      durabilityAcquisitions += 1;
      throw new Error('startup inspection must not acquire a write capability');
    },
    store
  });

  const result = await graph.startup.initializeServerConfig();

  assert.equal(result.port, 25570);
  assert.equal(result.maxRam, 6);
  assert.deepEqual(result.autoRestart, { enabled: true, delay: 15, maxCrashes: 4 });
  assert.equal(result.contentRevision, 0);
  assert.equal(mutationCalls, 0);
  assert.equal(durabilityAcquisitions, 0);
  assert.deepEqual(fs.readdirSync(serverPath), []);
});

test('read-only startup config inspection stays available while the mutation gate is occupied', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-startup-config-gate-'));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let tempSequence = 0;
  const durableFsFactory = allowedRoots => createDurableFs({
    fsApi: fs,
    allowedRoots,
    durableClient: {
      flushDirectory() {},
      moveWriteThrough(sourcePath, destinationPath) { fs.renameSync(sourcePath, destinationPath); },
      replaceFileWriteThrough(sourcePath, destinationPath) { fs.renameSync(sourcePath, destinationPath); }
    },
    tempNameFactory: () => `startup-config-${++tempSequence}`
  });
  const coordinator = new ServerMutationCoordinator({ durableFsFactory });
  coordinator.completeStartupRecovery([]);
  const values = {
    instances: [{ id: 'server-one', name: 'One', type: 'server', path: serverPath }],
    lastServerPath: serverPath,
    serverSettings: { port: 25570, maxRam: 6 },
    autoRestart: { enabled: true, delay: 15, maxCrashes: 4 }
  };
  const store = {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; }
  };
  const { graph } = graphFixture({ coordinator, durableFsFactory, store });
  const configPath = path.join(serverPath, '.minecraft-core.json');
  const originalConfigBytes = '{\n  "contentRevision": 5,\n  "version": "1.20.1",\n  "port": 25579,\n  "maxRam": 10\n}\n';
  const preservedMtime = new Date('2020-02-03T04:05:06.000Z');
  fs.writeFileSync(configPath, originalConfigBytes);
  fs.utimesSync(configPath, preservedMtime, preservedMtime);
  let releaseBlocker;
  let blockerEntered;
  const entered = new Promise(resolve => { blockerEntered = resolve; });
  const blocker = coordinator.runMutation(
    { instanceId: 'server-one', serverPath },
    {
      operation: 'test-blocker',
      operationId: 'test-startup-config-blocker',
      revisionMode: 'none',
      quiesce: null
    },
    async () => {
      blockerEntered();
      await new Promise(resolve => { releaseBlocker = resolve; });
    }
  );
  await entered;

  const inspectedWhileBlocked = await graph.startup.initializeServerConfig();
  assert.equal(inspectedWhileBlocked.port, 25579);
  assert.equal(inspectedWhileBlocked.maxRam, 10);
  assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfigBytes);
  assert.equal(fs.statSync(configPath).mtimeMs, preservedMtime.getTime());

  releaseBlocker();
  await blocker;
  const inspectedAfterBlock = await graph.startup.initializeServerConfig();
  assert.deepEqual(inspectedAfterBlock.autoRestart, { enabled: true, delay: 15, maxCrashes: 4 });
  assert.equal(inspectedAfterBlock.contentRevision, 5);
  assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfigBytes);
  assert.equal(fs.statSync(configPath).mtimeMs, preservedMtime.getTime());
});

test('startup config inspection cannot publish substituted bytes or install a recovery block', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-startup-config-substitution-'));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const substitutedBytes = '{"contentRevision":0,"substituted":true}\n';
  let tempSequence = 0;
  let movePublications = 0;
  let replacementPublications = 0;
  const durableFsFactory = allowedRoots => createDurableFs({
    fsApi: fs,
    allowedRoots,
    durableClient: {
      flushDirectory() {},
      moveWriteThrough(sourcePath, destinationPath) {
        movePublications += 1;
        fs.renameSync(sourcePath, destinationPath);
        fs.writeFileSync(destinationPath, substitutedBytes);
      },
      replaceFileWriteThrough(sourcePath, destinationPath) {
        replacementPublications += 1;
        fs.renameSync(sourcePath, destinationPath);
      }
    },
    tempNameFactory: () => `startup-substitution-${++tempSequence}`
  });
  const coordinator = new ServerMutationCoordinator({ durableFsFactory });
  coordinator.completeStartupRecovery([]);
  const values = {
    instances: [{ id: 'server-substitution', name: 'Substitution', type: 'server', path: serverPath }],
    lastServerPath: serverPath,
    serverSettings: { port: 25572, maxRam: 8 },
    autoRestart: { enabled: false, delay: 10, maxCrashes: 3 }
  };
  const store = {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; }
  };
  const { graph } = graphFixture({ coordinator, durableFsFactory, store });
  const selector = { instanceId: 'server-substitution', serverPath };
  const configPath = path.join(serverPath, '.minecraft-core.json');

  const inspected = await graph.startup.initializeServerConfig();

  assert.equal(inspected.port, 25572);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(movePublications, 0);
  assert.equal(replacementPublications, 0);
  let laterMutationRan = false;
  await coordinator.runMutation(selector, {
      operation: 'after-substitution',
      operationId: 'test-after-startup-substitution',
      revisionMode: 'none',
      quiesce: null
    }, async () => { laterMutationRan = true; });
  assert.equal(laterMutationRan, true);
});

test('a selected recovery block still permits read-only startup inspection and window creation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-startup-config-recovery-'));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let tempSequence = 0;
  const durableFsFactory = allowedRoots => createDurableFs({
    fsApi: fs,
    allowedRoots,
    durableClient: {
      flushDirectory() {},
      moveWriteThrough(sourcePath, destinationPath) { fs.renameSync(sourcePath, destinationPath); },
      replaceFileWriteThrough(sourcePath, destinationPath) { fs.renameSync(sourcePath, destinationPath); }
    },
    tempNameFactory: () => `startup-recovery-${++tempSequence}`
  });
  const coordinator = new ServerMutationCoordinator({ durableFsFactory });
  const selector = { instanceId: 'server-recovery', serverPath };
  coordinator.installRecoveryBlocks([{ selector, operationId: 'recovery-job-one' }]);
  coordinator.completeStartupRecovery([{ selector, resolved: false }], { globalBlock: false });
  const values = {
    instances: [{ id: 'server-recovery', name: 'Recovery', type: 'server', path: serverPath }],
    lastServerPath: serverPath,
    serverSettings: { port: 25571, maxRam: 7 },
    autoRestart: { enabled: false, delay: 10, maxCrashes: 3 }
  };
  const store = {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; }
  };
  const { graph } = graphFixture({ coordinator, durableFsFactory, store });
  const configPath = path.join(serverPath, '.minecraft-core.json');

  const inspected = await graph.startup.initializeServerConfig();
  assert.equal(inspected.port, 25571);
  assert.equal(inspected.maxRam, 7);
  assert.equal(inspected.contentRevision, 0);
  assert.equal(fs.existsSync(configPath), false);

  let windowsCreated = 0;
  const window = Object.freeze({ id: 23 });
  const bootstrap = createMainBootstrap({
    electronApi: { app: { setName() {}, setAppUserModelId() {} } },
    serviceGraph: {
      paths: { userData: root },
      startup: {
        async initializeRecovery() {},
        initializeServerConfig: graph.startup.initializeServerConfig
      },
      window: {
        create() {
          windowsCreated += 1;
          return window;
        }
      }
    },
    runtimeFlags: {
      testMode: false,
      updaterEnabled: false,
      trayEnabled: false,
      watchdogEnabled: false,
      nativeNotificationsEnabled: false,
      publicManagementListenersEnabled: false,
      platform: 'win32'
    }
  });

  assert.equal(await bootstrap.onReady(), window);
  assert.equal(windowsCreated, 1);
  assert.equal(fs.existsSync(configPath), false);
});

test('startup config inspection does not acquire write durability and still permits window creation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-startup-config-durability-recovery-'));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let durabilityAcquisitions = 0;
  const durableFsFactory = allowedRoots => {
    durabilityAcquisitions += 1;
    assert.deepEqual([...allowedRoots], [serverPath]);
    throw new ModpackError('RECOVERY_REQUIRED', 'Durable filesystem worker setup requires recovery');
  };
  const coordinator = new ServerMutationCoordinator({ durableFsFactory });
  coordinator.completeStartupRecovery([]);
  const values = {
    instances: [{ id: 'server-durability-recovery', name: 'Durability recovery', type: 'server', path: serverPath }],
    lastServerPath: serverPath,
    serverSettings: { port: 25573, maxRam: 9 },
    autoRestart: { enabled: false, delay: 10, maxCrashes: 3 }
  };
  const store = {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; }
  };
  const { graph } = graphFixture({ coordinator, durableFsFactory, store });
  const configPath = path.join(serverPath, '.minecraft-core.json');
  let windowsCreated = 0;
  const window = Object.freeze({ id: 24 });
  const bootstrap = createMainBootstrap({
    electronApi: { app: { setName() {}, setAppUserModelId() {} } },
    serviceGraph: {
      paths: { userData: root },
      startup: {
        async initializeRecovery() {},
        initializeServerConfig: graph.startup.initializeServerConfig
      },
      window: {
        create() {
          windowsCreated += 1;
          return window;
        }
      }
    },
    runtimeFlags: {
      testMode: false,
      updaterEnabled: false,
      trayEnabled: false,
      watchdogEnabled: false,
      nativeNotificationsEnabled: false,
      publicManagementListenersEnabled: false,
      platform: 'win32'
    }
  });

  assert.equal(await bootstrap.onReady(), window);
  assert.equal(windowsCreated, 1);
  assert.equal(durabilityAcquisitions, 0);
  assert.equal(fs.existsSync(configPath), false);
  assert.deepEqual(fs.readdirSync(serverPath), []);
});

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
  const windowToken = Object.freeze({ id: 73 });
  const composedProviders = { modrinth: { fake: 'modrinth' }, github: { fake: 'github' } };
  const recoveryServices = {
    registry: { async initialize() { return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
    recoveryService: { async recoverAll() { return { recovered: [], unresolved: [] }; } },
    runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } }
  };
  const composition = fakeModpackComposition({
    providers: composedProviders,
    managementSessionBroker: { async acquire() { return { token: 'synthetic' }; }, async acquireWithProvenance() { return { snapshot: { token: 'synthetic' }, registrationAttempted: false }; } },
    async resolveClientByPath() { return { clientId: 'local' }; },
    async acquireLegacyManagementContext(value, options) {
      assert.equal(value, 'synthetic-client'); assert.deepEqual(options, { deadline: 123 });
      return { sessionToken: 'legacy-token', baseOrigin: 'https://saved.test', assertCurrent: async () => {} };
    },
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
    startup: {
      afterWindowCreated(window, graphValue) {
        order.push('startup:after-window');
        assert.equal(window, windowToken);
        assert.equal(graphValue, graph);
      }
    },
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
  assert.equal((await graph.modpacks.managementSessionBroker.acquire('local')).token, 'synthetic');
  assert.equal((await graph.modpacks.resolveClientByPath('synthetic')).clientId, 'local');
  const legacy = await graph.clientPackLaunchOptions.acquireLegacyManagementContext('synthetic-client', { deadline: 123 });
  assert.equal(legacy.sessionToken, 'legacy-token'); assert.equal(legacy.baseOrigin, 'https://saved.test');
  assert.equal(graph.modpacks.providers, composedProviders);
  assert.equal(graph.modpacks.localArtifactSource, composition.localArtifactSource);
  assert.equal(graph.modpacks.destinationReservationService, composition.destinationReservationService);
  assert.equal(graph.modpacks.recoveryService, composition.recoveryService);
  assert.equal(graph.modpacks.notificationStore, composition.notificationStore);
  assert.equal(graph.modpacks.releaseMonitor, composition.releaseMonitor);
  assert.equal(graph.modpacks.releaseTrackingStore, composition.releaseTrackingStore);
  assert.equal(graph.modpacks.outcomeActionService, composition.outcomeActionService);
  assert.deepEqual(order, ['modpacks:compose', 'modpacks:initialize']);

  await graph.startup.afterWindowCreated?.(windowToken, graph);
  assert.deepEqual(order.slice(-3), ['startup:after-window', 'notifications:start', 'monitor:start']);
  await graph.startup.dispose?.(graph);
  assert.deepEqual(order.slice(-3), ['monitor:stop', 'notifications:stop', 'modpacks:dispose']);
});

test('disabled native notifications withhold the OS adapter while preserving persistent modpack notifications', async () => {
  class NativeNotification {}
  let receivedNotification = undefined;
  const recoveryServices = {
    registry: { async initialize() { return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
    recoveryService: { async recoverAll() { return { recovered: [], unresolved: [] }; } },
    runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } }
  };
  const { graph } = graphFixture({
    Notification: NativeNotification,
    ipc: { nativeNotificationsEnabled: false },
    async recoveryFactory() { return recoveryServices; },
    async modpackFactory(input) {
      receivedNotification = input.Notification;
      return fakeModpackComposition();
    }
  });

  await graph.startup.initializeRecovery(graph);
  assert.equal(receivedNotification, null);
  assert.notEqual(graph.modpacks.notificationStore, null);
});

test('service graph exposes explicit cache pruning before bounded orderly cleanup', async () => {
  // The graph can start maintenance early; composition disposal owns the bounded shutdown wait.
  let scheduled = 0;
  const composition = fakeModpackComposition({
    scheduleArtifactCachePrune() { scheduled += 1; return true; }
  });
  const recoveryServices = {
    registry: { async initialize() { return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
    recoveryService: { async recoverAll() { return { recovered: [], unresolved: [] }; } },
    runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } }
  };
  const { graph } = graphFixture({
    async recoveryFactory() { return recoveryServices; },
    async modpackFactory() { return composition; }
  });

  await graph.startup.initializeRecovery(graph);
  assert.equal(graph.startup.scheduleArtifactCachePrune(), true);
  assert.equal(scheduled, 1);
  await graph.startup.dispose(graph);
  assert.equal(scheduled, 1, 'graph disposal leaves the post-release shutdown prune to the composition');
});

test('packaged smoke startup keeps release monitoring inactive while retaining production composition', async () => {
  const order = [];
  const composition = fakeModpackComposition({
    async initialize() { order.push('modpacks:initialize'); },
    releaseMonitor: {
      async checkAll() {}, async checkOne() {},
      async start() { order.push('monitor:start'); },
      stop() { order.push('monitor:stop'); }
    },
    nativeNotificationBridge: {
      start() { order.push('notifications:start'); },
      stop() { order.push('notifications:stop'); }
    }
  });
  const recoveryServices = {
    registry: { async initialize() { return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
    recoveryService: { async recoverAll() { return { recovered: [], unresolved: [] }; } },
    runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } }
  };
  const { graph } = graphFixture({
    startup: { automaticReleaseChecksEnabled: false },
    async recoveryFactory() { return recoveryServices; },
    async modpackFactory() { return composition; }
  });

  await graph.startup.initializeRecovery(graph);
  await graph.startup.afterWindowCreated({}, graph);

  assert.deepEqual(order, ['modpacks:initialize', 'notifications:start']);
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
  assert.equal(graph.providers.modrinth.http.maxRedirects, 0);
  assert.equal(graph.providers.github.http.client, graph.network.http);
  assert.equal(graph.providers.github.http.baseUrl.href, 'https://api.github.com/');
  assert.equal(graph.providers.github.http.maxRedirects, 1);
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

test('service graph cache publication cannot complete before the production durability barrier', async (t) => {
  // This fails if the real cache silently falls back to file-only sync without the native directory authority.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-cache-durability-'));
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(userDataPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const barrierFailure = new Error('injected production cache directory barrier failure');
  const requestedRoots = [];
  const { graph } = graphFixture({
    userDataPath,
    durableFsFactory(allowedRoots) {
      requestedRoots.push([...allowedRoots]);
      return {
        async flushDirectoriesAsync() { throw barrierFailure; }
      };
    }
  });
  const content = Buffer.from('production cache durability authority');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const partialRoot = path.join(graph.paths.modpacks.cache, 'partials');
  const partialPath = path.join(partialRoot, 'production.part');
  await fs.promises.mkdir(partialRoot, { recursive: true });
  await fs.promises.writeFile(partialPath, content);

  await assert.rejects(graph.artifacts.cache.commitPart({
    partialPath,
    sha256,
    measuredSize: String(content.length)
  }), error => error === barrierFailure);
  assert.deepEqual(requestedRoots, [[path.resolve(userDataPath)]]);
});

test('service graph gives the production coordinator exact-root revision durability', async (t) => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-graph-durable-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const configPath = path.join(serverPath, '.minecraft-core.json');
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 0, preserved: true }));
  const store = {
    get(key) {
      return key === 'instances'
        ? [{ id: 'server-durable', name: 'Durable', type: 'server', path: serverPath }]
        : null;
    }
  };
  const requestedRoots = [];
  let sequence = 0;
  const { graph } = graphFixture({
    coordinator: undefined,
    serverMutationPolicy: undefined,
    store,
    async recoveryFactory() { return {
      registry: { async initialize() { return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
      recoveryService: { async recoverAll() { return { recovered: [], unresolved: [] }; } },
      runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } }
    }; },
    async modpackFactory() { return fakeModpackComposition({
      stateRepository: { read: () => null },
      clientPackIntegration: { async assertServerDestination() {} }
    }); },
    durableFsFactory(allowedRoots) {
      requestedRoots.push([...allowedRoots]);
      return createDurableFs({
        fsApi: fs,
        durableClient: {
          flushDirectory() {},
          moveWriteThrough(sourcePath, destinationPath) {
            fs.renameSync(sourcePath, destinationPath);
          },
          replaceFileWriteThrough(sourcePath, destinationPath) {
            fs.renameSync(sourcePath, destinationPath);
          }
        },
        allowedRoots,
        tempNameFactory: () => `graph-revision-${++sequence}`
      });
    }
  });
  await graph.startup.initializeRecovery(graph);
  const saveDisabledMods = graph.serverMutationPolicy.wrapHandler(
    'save-disabled-mods',
    async () => ({ success: true })
  );

  await saveDisabledMods({ sender: { id: 1 } }, serverPath, []);

  const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(persisted.contentRevision, 1);
  assert.equal(persisted.preserved, true);
  assert.deepEqual(requestedRoots, [[serverPath]]);
  const startLease = await graph.coordinator.acquireStart(
    { instanceId: 'server-durable', serverPath },
    { operation: 'start-server', operationId: 'start-after-durable-write', parentMutationLease: null }
  );
  assert.equal(startLease.release(), true);
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

test('a modpack-only durable override cannot become config coordinator or recovery authority', async () => {
  const modpackDurableFsFactory = () => ({ subsystem: 'modpack-only' });
  let recoveryDurableFsFactory = null;
  let observedModpackDurableFsFactory = null;
  const recoveryServices = {
    registry: { async initialize() { return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
    recoveryService: { async recoverAll() { return { recovered: [], unresolved: [] }; } },
    runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } }
  };
  const { graph } = graphFixture({
    modpackDurableFsFactory,
    async recoveryFactory(input) {
      recoveryDurableFsFactory = input.durableFsFactory;
      return recoveryServices;
    },
    async modpackFactory(input) {
      observedModpackDurableFsFactory = input.durableFsFactory;
      return fakeModpackComposition();
    }
  });

  await graph.startup.initializeRecovery(graph);

  assert.equal(observedModpackDurableFsFactory, modpackDurableFsFactory);
  assert.notEqual(recoveryDurableFsFactory, modpackDurableFsFactory);
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

test('service graph lazily establishes the reviewed startup recovery boundary exactly once', async () => {
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
    async recoverAll() { throw new Error('startup must not perform expensive automatic cleanup'); }
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
  assert.deepEqual(order, ['begin', 'runtime-quiescent', 'scan-1', 'complete']);
});

test('default production recovery services compose for a fresh isolated profile', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = graphFixture({
    userDataPath: root,
    coordinator: new ServerMutationCoordinator(),
    recoveryDurableFsFactory: allowedRoots => createDurableFs({ allowedRoots, durableClient: {
      moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
      moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {}
    } }),
    runtimeWriterGetBootSequence: async () => 10,
    recoveryRuntimeVerifier: {
      async verifyBeforeRecovery() { return { quiescent: true }; }
    }
  });

  const result = await fixture.graph.startup.initializeRecovery(fixture.graph);

  assert.deepEqual(result, { recovered: [], unresolved: [], globalBlock: false });
  const services = fixture.graph.recovery.getServices();
  assert.equal(typeof services.runtimeWriterAuthority?.run, 'function');
  assert.equal(services.recoveryService.runtimeWriterAuthority, services.runtimeWriterAuthority);
  assert.equal(typeof services.registry.clearRestoreCreationAfterCleanup, 'function');
  assert.equal(typeof services.restorePointService.cleanupInterruptedRestorePointCreation, 'function');
  assert.equal(typeof services.restorePointService.listAvailableRestorePoints, 'function');
});

test('service graph rejects a relative userData path before constructing services', () => {
  assert.throws(
    () => graphFixture({ userDataPath: 'relative-user-data' }),
    /userData/i
  );
});

test('IPC setup consumes the graph store, filesystem, and mutation policy', async () => {
  const modulePath = path.resolve(__dirname, '../../electron/ipc-handlers.cjs');
  const originalLoad = Module._load;
  const registered = new Set();
  const wrapped = [];
  const initializedPaths = [];
  let nativeNotificationStartEnabled = null;
  let receivedModpackDependencies = null;
  let receivedLaunchOptions = null;
  let settingsSessionOptions; const invoked = new Map(); const disposers = []; const invalidated = [];
  const ipcMain = {
    handle(channel, handler) { registered.add(channel); invoked.set(channel, handler); },
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
    assert.throws(() => setupIpcHandlers({ webContents: { on() {} } }, {
      store: graphStore, filesystem: { sync: graphFs }, serverMutationPolicy: graphPolicy,
      modpacks: { clientPackService: {}, companionService: {} },
      ipc: { handlerFactories: { createModpackHandlers: emptyFactory,
        createClientPackHandlers: () => ({ handlers: {}, async dispose() {} }) } }
    }), /main.*launch|launch.*authority/i);
    const clientPackLaunchOptions = { async beginManagedLaunch() {} };
    const sender = new EventEmitter(); sender.mainFrame = {}; sender.isDestroyed = () => false;
    const win = new EventEmitter(); win.webContents = sender;
    const managementSessionBroker = { invalidate: id => invalidated.push(id), async acquire(id) {
      assert.equal(id, 'local'); return { token: 'synthetic-token', baseOrigin: 'https://saved.example:25566', bindingGeneration: 'generation', binding: { generation: 'generation' }, revision: 0 };
    }, async acquireWithProvenance(id) { return { snapshot: await this.acquire(id), registrationAttempted: false }; } };
    setupIpcHandlers(win, {
      store: graphStore,
      filesystem: { sync: graphFs },
      serverMutationPolicy: graphPolicy,
      clientPackLaunchOptions,
      modpacks: { lifecycleService: { marker: 'lifecycle' }, clientPackService: {}, companionService: {}, managementSessionBroker,
        resolveClientByPath: async value => { assert.equal(value, path.resolve('synthetic-client')); return { clientId: 'local' }; } },
      registerClientPackIpcDisposer: dispose => disposers.push(dispose),
      ipc: {
        nativeNotificationsEnabled: false,
        handlerFactories: {
          createSettingsHandlers(options) { settingsSessionOptions = options; return {}; },
          createMinecraftLauncherHandlers(_win, options) { receivedLaunchOptions = options; return {}; },
          createClientPackHandlers() { return { handlers: { 'client-packs:get-state': () => ({ ok: true }) }, async dispose() {} }; },
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
    assert.equal(registered.has('client-packs:get-state'), true);
    assert.equal(receivedLaunchOptions, clientPackLaunchOptions);
    assert.equal(registered.has('management-session:acquire'), true);
    const acquire = invoked.get('management-session:acquire');
    const session = await acquire({ sender, senderFrame: sender.mainFrame }, { clientPath: path.resolve('synthetic-client'), reason: 'reuse' });
    assert.equal(session.value.sessionToken, 'synthetic-token'); assert.equal(session.value.baseOrigin, 'https://saved.example:25566');
    assert.equal((await acquire({ sender, senderFrame: {} }, { clientInstanceId: 'local', reason: 'reuse' })).ok, false);
    settingsSessionOptions.invalidateManagementSession('local'); assert.deepEqual(invalidated, ['local']);
    await Promise.all(disposers.map(dispose => dispose())); assert.equal(sender.listenerCount('destroyed'), 0);
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
