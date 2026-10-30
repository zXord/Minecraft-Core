const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { createStartupTrace } = require('../../electron/utils/startup-trace.cjs');
const { loadStartupAttributionModule } = require('../helpers/startup-attribution-loader.cjs');

function tracedGraph(markStartupTrace) {
  return loadStartupAttributionModule(
    require.resolve('../../electron/bootstrap/create-modpack-service-graph.cjs'),
    markStartupTrace,
    request => request.endsWith('/startup-recovery-bootstrap.cjs')
  ).createModpackServiceGraph;
}

const {
  channelOperationId,
  createProductionDurableFsFactory,
  createModpackServiceGraph,
  deriveRecoveryRuntimeTuple,
  createLiveInstanceResolver
} = require('../../electron/bootstrap/create-modpack-service-graph.cjs');
const { createMainBootstrap } = require('../../electron/bootstrap/create-main-bootstrap.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { createModpackStateObserver } = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');
const { isLegacyInstanceConfigFs } = require('../../electron/utils/instance-config-fs.cjs');
const { updateServerConfig, writeServerConfig } = require('../../electron/utils/config-manager.cjs');
const { WindowsDurableFsClient } = require('../../electron/utils/windows-durable-fs-client.cjs');

const EMPTY_RECOVERY_SERVICES = Object.freeze({
  registry: { async initialize() { return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
  recoveryService: { async recoverAll() { return { recovered: [], unresolved: [] }; } },
  runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } }
});

// A composition whose policy hooks answer like an unmanaged server: the observer
// reads no modpack state and every destination is free of client packs.
function unmanagedPolicyComposition(overrides = {}) {
  return fakeModpackComposition({
    stateObserver: { read: () => null, listHistory: () => ({ items: [], nextCursor: null }) },
    stateRepository: { read() { assert.fail('policy classification reads through the state observer'); } },
    clientPackIntegration: { async assertServerDestination() {} },
    ...overrides
  });
}

function addModpackEvidence(serverPath) {
  fs.mkdirSync(path.join(serverPath, '.minecraft-core-state'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{}\n');
}

function renameDurableFsFactory(onCall, prefix) {
  let sequence = 0;
  return allowedRoots => {
    onCall([...allowedRoots]);
    return createDurableFs({
      fsApi: fs,
      durableClient: {
        flushDirectory() {},
        moveWriteThrough(sourcePath, destinationPath) { fs.renameSync(sourcePath, destinationPath); },
        replaceFileWriteThrough(sourcePath, destinationPath) { fs.renameSync(sourcePath, destinationPath); }
      },
      allowedRoots,
      tempNameFactory: () => `${prefix}-${++sequence}`
    });
  };
}

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

function graphFixture(overrides = {}, createGraph = createModpackServiceGraph) {
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

  const graph = createGraph({
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

test('startup arms captured-window retirement without awaiting navigation readiness; missing adapter skips', async () => {
  let resolveReady; const ready = new Promise(resolve => { resolveReady = resolve; });
  const window = { id: 'captured' }; const armed = [];
  const { graph } = graphFixture({ startup: { async initializeRecovery() {},
    waitForWindowNavigationReady(value) { assert.equal(value, window); return ready; } },
    modpackFactory: async () => fakeModpackComposition({ armStartupRetirement(value) { armed.push(value); } }) });
  await graph.startup.initializeRecovery(graph);
  await graph.startup.afterWindowCreated(window, graph);
  assert.deepEqual(armed, [ready]); resolveReady(true);
  const absent = graphFixture({ startup: { async initializeRecovery() {} },
    modpackFactory: async () => fakeModpackComposition({ armStartupRetirement() { assert.fail('no readiness adapter'); } }) }).graph;
  await absent.startup.initializeRecovery(absent); await absent.startup.afterWindowCreated(window, absent);
});

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
  const clientPath = path.join(os.tmpdir(), 'minecraft-core-service-graph-client');
  const instances = [{ id: 'local', name: 'Local', type: 'client', path: clientPath }];
  const savedConfig = { serverProtocol: 'http', serverIp: 'saved.test', serverPort: '8443', clientId: 'remote-client',
    clientName: 'Synthetic', inviteSecret: 'private', sessionToken: 'legacy-token' };
  let connectionCore = null;
  const composition = fakeModpackComposition({
    providers: composedProviders,
    // A composition's own connection services are never exposed by the graph.
    managementSessionBroker: { marker: 'composition-broker' },
    async resolveClientByPath() { assert.fail('the graph resolves clients through its connection core'); },
    async acquireLegacyManagementContext() { assert.fail('the graph acquires legacy contexts through its connection core'); },
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
    dispose() { order.push(`modpacks:dispose broker-disposed=${connectionCore.managementSessionBroker.disposed}`); }
  });
  let factoryCalls = 0;
  const { graph } = graphFixture({
    store: { get: key => (key === 'instances' ? instances : null) },
    async readClientConfig(value) {
      assert.equal(value, clientPath);
      return { ...savedConfig };
    },
    startup: {
      afterWindowCreated(window, graphValue) {
        order.push('startup:after-window');
        assert.equal(window, windowToken);
        assert.equal(graphValue, graph);
      },
      dispose() { order.push(`startup:dispose broker-disposed=${connectionCore.managementSessionBroker.disposed}`); }
    },
    async recoveryFactory() { return recoveryServices; },
    async modpackFactory(input) {
      factoryCalls += 1;
      order.push('modpacks:compose');
      assert.equal(input.rawRecoveryServices, recoveryServices);
      assert.equal(typeof input.instanceResolver.resolveInstance, 'function');
      connectionCore = input.clientConnectionCore;
      return composition;
    }
  });

  // The connection core is built with the graph, so client sessions and legacy
  // management reads work before (and without) the modpack composition.
  assert.equal(graph.modpacks.lifecycleService, null);
  const broker = graph.modpacks.managementSessionBroker;
  assert.equal(typeof broker?.acquireWithProvenance, 'function');
  assert.deepEqual(await graph.modpacks.resolveClientByPath(clientPath), { clientId: 'local', clientPath: path.resolve(clientPath) });
  await assert.rejects(graph.modpacks.resolveClientByPath(path.join(clientPath, 'unregistered')), { code: 'INVALID_REQUEST' });
  assert.equal(graph.clientPackLaunchOptions.acquireLegacyManagementContext, graph.modpacks.acquireLegacyManagementContext);
  const early = await graph.clientPackLaunchOptions.acquireLegacyManagementContext(clientPath, { deadline: 1_750_000_005_000 });
  assert.equal(early.sessionToken, 'legacy-token'); assert.equal(early.baseOrigin, 'http://saved.test:8443');

  await graph.startup.initializeRecovery(graph);
  assert.equal(factoryCalls, 1);
  assert.equal(graph.modpacks.lifecycleService, composition.lifecycleService);
  assert.equal(connectionCore.managementSessionBroker, broker);
  assert.equal(graph.modpacks.managementSessionBroker, broker);
  assert.equal(graph.modpacks.resolveClientByPath, connectionCore.resolveClientByPath);
  assert.equal(graph.modpacks.acquireLegacyManagementContext, connectionCore.acquireLegacyManagementContext);
  assert.equal(graph.clientPackLaunchOptions.acquireLegacyManagementContext, connectionCore.acquireLegacyManagementContext);
  const legacy = await graph.clientPackLaunchOptions.acquireLegacyManagementContext(clientPath, { deadline: 1_750_000_005_000 });
  assert.equal(legacy.sessionToken, 'legacy-token'); assert.equal(legacy.baseOrigin, 'http://saved.test:8443');
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
  // The connection core outlives everything that may still use it and closes last.
  assert.deepEqual(order.slice(-4), ['monitor:stop', 'notifications:stop', 'modpacks:dispose broker-disposed=false',
    'startup:dispose broker-disposed=false']);
  assert.equal(broker.disposed, true);
  await assert.rejects(graph.modpacks.acquireLegacyManagementContext(clientPath), { code: 'CANCELLED' });
});

test('service graph disposes its connection core even when composition disposal fails', async () => {
  const failure = new Error('composition disposal failed');
  const { graph } = graphFixture({
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
    async modpackFactory() { return fakeModpackComposition({ async dispose() { throw failure; } }); }
  });
  await graph.startup.initializeRecovery(graph);
  const broker = graph.modpacks.managementSessionBroker;
  await assert.rejects(graph.startup.dispose(graph), error => error === failure);
  assert.equal(broker.disposed, true);
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

test('service graph writes configs and revisions of unmanaged servers without the strict writer; evidence gets the exact root', async (t) => {
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
  const strictFactory = renameDurableFsFactory(roots => requestedRoots.push(roots), 'graph-revision');
  let compositionInput = null;
  const { graph } = graphFixture({
    coordinator: undefined,
    serverMutationPolicy: undefined,
    store,
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
    async modpackFactory(input) {
      compositionInput = input;
      return unmanagedPolicyComposition();
    },
    durableFsFactory: strictFactory
  });
  await graph.startup.initializeRecovery(graph);
  // Modpack lifecycle paths keep the strict production writer.
  assert.equal(compositionInput.durableFsFactory, strictFactory);
  assert.notEqual(graph.coordinator.durableFsFactory, strictFactory);
  assert.equal(isLegacyInstanceConfigFs(graph.coordinator.durableFsFactory([serverPath])), true);
  assert.deepEqual(requestedRoots, []);
  const saveDisabledMods = graph.serverMutationPolicy.wrapHandler(
    'save-disabled-mods',
    async () => ({ success: true })
  );

  await saveDisabledMods({ sender: { id: 1 } }, serverPath, []);
  writeServerConfig(serverPath, { maxRam: 6 });
  updateServerConfig(serverPath, current => ({ ...current, port: 25570 }));
  const startLease = await graph.coordinator.acquireStart(
    { instanceId: 'server-durable', serverPath },
    { operation: 'start-server', operationId: 'start-after-durable-write', parentMutationLease: null }
  );
  startLease.markDirty();
  startLease.markRunning({ pid: 4242 });
  assert.equal(startLease.release(), true);

  const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(persisted.contentRevision, 2);
  assert.equal(persisted.preserved, true);
  assert.equal(persisted.maxRam, 6);
  assert.equal(persisted.port, 25570);
  assert.deepEqual(requestedRoots, [], 'a server without modpack evidence never needs the strict writer');

  addModpackEvidence(serverPath);
  await saveDisabledMods({ sender: { id: 1 } }, serverPath, []);
  assert.deepEqual(requestedRoots, [[serverPath]]);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).contentRevision, 3);
  writeServerConfig(serverPath, { maxRam: 8 });
  assert.deepEqual(requestedRoots, [[serverPath], [path.resolve(serverPath)]]);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).maxRam, 8);
});

test('unmanaged config writes and revision bumps start no ArchiveWorker through the wired production factory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-graph-worker-spawns-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(userDataPath);
  fs.mkdirSync(serverPath);
  const runtimeRoots = { resourcesPath: root, runtimeRoot: root, isPackaged: false, arch: 'x64' };
  const nativeClients = [];
  const spawns = [];
  const spawnSpy = (file, args) => {
    spawns.push([file, ...args]);
    throw Object.assign(new Error('the spawn spy refuses to start ArchiveWorker.exe'), { code: 'EACCES' });
  };
  const productionFactory = createProductionDurableFsFactory({
    fsSync: fs,
    fsPromises: fs.promises,
    randomUUID: crypto.randomUUID,
    runtimeRoots,
    userDataPath,
    durableClientFactory(options) {
      nativeClients.push([...options.allowedRoots]);
      return new WindowsDurableFsClient({ ...options, verifyWorker() {}, spawnSync: spawnSpy, spawn: spawnSpy });
    }
  });
  const store = { get: key => (key === 'instances' ? [{ id: 'server-spawn', name: 'Spawn', type: 'server', path: serverPath }] : null) };
  const { graph } = graphFixture({
    userDataPath,
    runtimeRoots,
    randomUUID: crypto.randomUUID,
    coordinator: undefined,
    serverMutationPolicy: undefined,
    store,
    durableFsFactory: productionFactory,
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
    async modpackFactory() { return unmanagedPolicyComposition(); }
  });
  await graph.startup.initializeRecovery(graph);

  writeServerConfig(serverPath, { maxRam: 6 });
  updateServerConfig(serverPath, current => ({ ...current, maxRam: 7 }));
  await graph.serverMutationPolicy.wrapHandler('save-disabled-mods', async () => ({ success: true }))(
    { sender: { id: 1 } }, serverPath, []);
  const startLease = await graph.coordinator.acquireStart(
    { instanceId: 'server-spawn', serverPath },
    { operation: 'start-server', operationId: 'start-without-worker', parentMutationLease: null }
  );
  startLease.markDirty();
  startLease.markRunning({ pid: 4243 });
  assert.equal(startLease.release(), true);

  const persisted = JSON.parse(fs.readFileSync(path.join(serverPath, '.minecraft-core.json'), 'utf8'));
  assert.equal(persisted.maxRam, 7);
  assert.equal(persisted.contentRevision, 2);
  assert.deepEqual(nativeClients, []);
  assert.deepEqual(spawns, []);
  assert.deepEqual(fs.readdirSync(serverPath).filter(name => name.includes('minecraft-core-tmp')), []);

  // Control: a server with modpack evidence reaches the native writer, which is
  // the only path that starts ArchiveWorker.exe.
  addModpackEvidence(serverPath);
  assert.throws(() => writeServerConfig(serverPath, { maxRam: 9 }), { code: 'COMMIT_FAILED' });
  assert.deepEqual(nativeClients, [[path.resolve(serverPath)]]);
  assert.ok(spawns.length > 0);
  assert.ok(spawns.every(([file]) => path.basename(file) === 'ArchiveWorker.exe'));
});

test('the graph policy gives colon channels valid coordinator operation ids', async (t) => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-graph-operation-ids-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 0, bumpContentRevision: () => 1 });
  coordinator.completeStartupRecovery([]);
  const operationIds = [];
  for (const method of ['runMutation', 'runManyMutations']) {
    const original = coordinator[method].bind(coordinator);
    coordinator[method] = (selectors, options, work) => {
      operationIds.push(options.operationId);
      return original(selectors, options, work);
    };
  }
  const store = { get: key => (key === 'instances' ? [{ id: 'server-ids', name: 'Ids', type: 'server', path: serverPath }] : null) };
  const { graph } = graphFixture({
    coordinator,
    serverMutationPolicy: undefined,
    store,
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
    async modpackFactory() { return unmanagedPolicyComposition(); }
  });
  await graph.startup.initializeRecovery(graph);
  const handled = [];
  for (const [channel, payload] of [
    ['backups:delete', { serverPath, name: 'world-backup.zip' }],
    ['mod-watch:add', { serverPath, projectId: 'fixture-project' }]
  ]) {
    const wrapped = graph.serverMutationPolicy.wrapHandler(channel, async () => {
      handled.push(channel);
      return { success: true };
    });
    assert.deepEqual(await wrapped({ sender: { id: 1 } }, payload), { success: true });
  }
  assert.deepEqual(handled, ['backups:delete', 'mod-watch:add']);
  assert.equal(operationIds.length, 2);
  assert.match(operationIds[0], /^backups-delete-/);
  assert.match(operationIds[1], /^mod-watch-add-/);
  for (const operationId of operationIds) assert.match(operationId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
});

test('the graph builds writer operation ids the coordinator accepts before any policy sanitising', () => {
  const uuid = '0f8e2a4c-6b1d-4e3f-9a7b-5c2d1e0f3a4b';
  const ids = ['backups:delete', 'mod-watch:add', 'save-server-settings', 'server.properties/write']
    .map(channel => channelOperationId(channel, () => uuid));
  assert.deepEqual(ids, [
    `backups-delete-${uuid}`,
    `mod-watch-add-${uuid}`,
    `save-server-settings-${uuid}`,
    `server-properties-write-${uuid}`
  ]);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
});

test('the graph classifies servers through the modpack state observer', async (t) => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-graph-observer-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(serverPath, 'addon.jar'), 'addon');
  const store = { get: key => (key === 'instances' ? [{ id: 'server-observed', name: 'Observed', type: 'server', path: serverPath }] : null) };
  const stateObserver = { read: () => null, listHistory: () => ({ items: [], nextCursor: null }) };
  // The strict repository refuses folders the observer can still classify.
  const stateRepository = { read() { throw new ModpackError('INVALID_REQUEST', 'The strict repository refuses this folder'); } };
  const graphFor = composition => {
    const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 0, bumpContentRevision: () => 1 });
    coordinator.completeStartupRecovery([]);
    return graphFixture({
      coordinator,
      serverMutationPolicy: undefined,
      store,
      async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
      async modpackFactory() { return composition; }
    }).graph;
  };

  const graph = graphFor(fakeModpackComposition({ stateObserver, stateRepository,
    clientPackIntegration: { async assertServerDestination() {} } }));
  assert.equal(graph.modpacks.stateObserver, null);
  await graph.startup.initializeRecovery(graph);
  assert.equal(graph.modpacks.stateObserver, stateObserver);
  assert.equal(graph.modpacks.stateRepository, stateRepository);
  const deleteMod = graph.serverMutationPolicy.wrapHandler('delete-mod', async () => true);
  assert.equal(await deleteMod({ sender: { id: 1 } }, serverPath, 'addon.jar'), true);

  // A composition without an observer keeps the strict read, which fails closed.
  const strictOnly = graphFor(fakeModpackComposition({ stateRepository, clientPackIntegration: { async assertServerDestination() {} } }));
  await strictOnly.startup.initializeRecovery(strictOnly);
  assert.equal(strictOnly.modpacks.stateObserver, stateRepository);
  await assert.rejects(strictOnly.serverMutationPolicy.wrapHandler('delete-mod', async () => assert.fail('strict refusal'))(
    { sender: { id: 1 } }, serverPath, 'addon.jar'), { code: 'MANAGED_MOD_EDIT_BLOCKED' });
});

test('a junction-registered unmanaged server keeps its mod edits and its next start without the strict writer', {
  skip: process.platform !== 'win32' && 'directory junctions are Windows only'
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-graph-junction-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realServer = path.join(root, 'real-server');
  fs.mkdirSync(realServer);
  fs.writeFileSync(path.join(realServer, 'addon.jar'), 'addon');
  fs.writeFileSync(path.join(realServer, '.minecraft-core.json'), JSON.stringify({ contentRevision: 4 }));
  const serverPath = path.join(root, 'server-junction');
  try {
    fs.symlinkSync(realServer, serverPath, 'junction');
  } catch (error) {
    t.skip(`directory junctions are unavailable on this host: ${error.code}`);
    return;
  }
  const strictRoots = [];
  // Like production, the strict writer refuses a root that contains a reparse point.
  const strictFactory = roots => {
    strictRoots.push([...roots]);
    throw new ModpackError('RECOVERY_REQUIRED', 'Durable filesystem roots cannot contain a reparse point');
  };
  const strictRepository = {
    read() { throw new ModpackError('INVALID_REQUEST', 'The strict repository refuses a junction'); },
    listHistory() { throw new ModpackError('INVALID_REQUEST', 'The strict repository refuses a junction'); }
  };
  const store = { get: key => (key === 'instances' ? [{ id: 'server-junction', name: 'Junction', type: 'server', path: serverPath }] : null) };
  const { graph } = graphFixture({
    coordinator: undefined,
    serverMutationPolicy: undefined,
    store,
    durableFsFactory: strictFactory,
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
    async modpackFactory() {
      return fakeModpackComposition({
        stateObserver: createModpackStateObserver({ repository: strictRepository, fsApi: fs }),
        stateRepository: strictRepository,
        clientPackIntegration: { async assertServerDestination() {} }
      });
    }
  });
  await graph.startup.initializeRecovery(graph);
  const deleteMod = graph.serverMutationPolicy.wrapHandler('delete-mod', async (_event, folder, fileName) => {
    fs.unlinkSync(path.join(folder, fileName));
    return true;
  });

  assert.equal(await deleteMod({ sender: { id: 1 } }, serverPath, 'addon.jar'), true);
  assert.equal(fs.existsSync(path.join(realServer, 'addon.jar')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(realServer, '.minecraft-core.json'), 'utf8')).contentRevision, 5);
  const startLease = await graph.coordinator.acquireStart(
    { instanceId: 'server-junction', serverPath },
    { operation: 'start-server', operationId: 'start-junction-server', parentMutationLease: null }
  );
  assert.equal(startLease.release(), true);
  assert.deepEqual(strictRoots, []);
});

test('the graph exposes the client process guard activity for the update guard', async () => {
  const { graph } = graphFixture({
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
    async modpackFactory() {
      return fakeModpackComposition({ listActiveClientMutations: () => Object.freeze(['client-mutation:fixture']) });
    }
  });
  assert.equal(graph.modpacks.listActiveClientMutations, null);
  await graph.startup.initializeRecovery(graph);
  assert.deepEqual(graph.modpacks.listActiveClientMutations(), ['client-mutation:fixture']);
});

test('runtime roots reached through a junction use their canonical drive path; a case-only difference keeps the given spelling', {
  skip: process.platform !== 'win32' && 'drive-letter runtime roots are Windows only'
}, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-roots-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const install = path.join(base, 'install');
  fs.mkdirSync(install);
  const canonical = fs.realpathSync.native(install);
  const linked = path.join(base, 'linked-install');
  try {
    fs.symlinkSync(install, linked, 'junction');
  } catch (error) {
    t.skip(`directory junctions are unavailable on this host: ${error.code}`);
    return;
  }
  let compositionInput = null;
  const junctioned = graphFixture({
    runtimeRoots: { resourcesPath: linked, runtimeRoot: linked, isPackaged: false, arch: 'x64' },
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
    async modpackFactory(input) {
      compositionInput = input;
      return fakeModpackComposition();
    }
  }).graph;
  assert.equal(junctioned.runtimeRoots.resourcesPath, canonical);
  assert.equal(junctioned.runtimeRoots.runtimeRoot, canonical);
  await junctioned.startup.initializeRecovery(junctioned);
  assert.equal(compositionInput.runtimeRoots, junctioned.runtimeRoots);
  assert.equal(compositionInput.clientWorkerDurableConfig.workerPath,
    path.join(canonical, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe'));

  const caseVariant = canonical.replace(/[a-z]/g, letter => letter.toUpperCase());
  assert.notEqual(caseVariant, canonical);
  assert.equal(fs.realpathSync.native(caseVariant), canonical);
  const caseOnly = graphFixture({
    runtimeRoots: { resourcesPath: caseVariant, runtimeRoot: caseVariant, isPackaged: false, arch: 'x64' }
  }).graph;
  assert.equal(caseOnly.runtimeRoots.resourcesPath, caseVariant);
  assert.equal(caseOnly.runtimeRoots.runtimeRoot, caseVariant);
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

test('startup attribution brackets lazy recovery and composition exactly once without private values', async () => {
  const order = [];
  const lines = [];
  const mark = createStartupTrace({ env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, now: () => 10,
    utcNow: () => '2026-10-11T00:00:00.000Z', pid: 123,
    sink(line) { lines.push(line); order.push(JSON.parse(line.slice('[Minecraft Core startup trace] '.length)).marker); } });
  const { graph } = graphFixture({
    async recoveryFactory() {
      order.push('factory-call');
      return { registry: { async initialize() { order.push('registry-call'); return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
        recoveryService: { async recoverAll() { assert.fail('no automatic cleanup'); } },
        async runtimeVerifier() { order.push('runtime-call'); return { quiescent: true }; } };
    },
    async modpackFactory() { order.push('composition-call'); return fakeModpackComposition({
      async initialize() { order.push('initialize-call'); } }); }
  }, tracedGraph(mark));
  assert.deepEqual(order, []);
  const first = graph.startup.initializeRecovery(graph);
  const second = graph.startup.initializeRecovery(graph);
  assert.equal(first, second);
  assert.deepEqual(await first, { recovered: [], unresolved: [], globalBlock: false });
  assert.equal(await second, await graph.startup.initializeRecovery(graph));
  assert.deepEqual(order, [
    'recovery:factory:start', 'factory-call', 'recovery:factory:complete',
    'recovery:runtime-verify:start', 'runtime-call', 'recovery:runtime-verify:complete',
    'recovery:registry-init:start', 'registry-call', 'recovery:registry-init:complete',
    'composition:factory:start', 'composition-call', 'composition:factory:complete',
    'composition:initialize:start', 'initialize-call', 'composition:initialize:complete'
  ]);
  for (const line of lines) assert.deepEqual(Object.keys(JSON.parse(line.slice('[Minecraft Core startup trace] '.length))), ['marker', 'pid', 'utc', 'elapsedMs']);
  assert.doesNotMatch(lines.join(''), /user-data|SECRET|serverPath|records|store/);
});

for (const phase of ['recovery-factory', 'runtime', 'registry', 'composition-factory-sync', 'composition-factory-async', 'composition-initialize']) {
  test(`startup attribution preserves ${phase} rejection identity and omits false completion`, async () => {
    const failure = new Error('SECRET_FAILURE');
    const expected = {
      'recovery-factory': ['recovery:factory:start'],
      runtime: ['recovery:factory:start', 'recovery:factory:complete', 'recovery:runtime-verify:start'],
      registry: ['recovery:factory:start', 'recovery:factory:complete', 'recovery:runtime-verify:start', 'recovery:runtime-verify:complete', 'recovery:registry-init:start'],
      'composition-factory-sync': ['recovery:factory:start', 'recovery:factory:complete', 'recovery:runtime-verify:start', 'recovery:runtime-verify:complete', 'recovery:registry-init:start', 'recovery:registry-init:complete', 'composition:factory:start'],
      'composition-factory-async': ['recovery:factory:start', 'recovery:factory:complete', 'recovery:runtime-verify:start', 'recovery:runtime-verify:complete', 'recovery:registry-init:start', 'recovery:registry-init:complete', 'composition:factory:start'],
      'composition-initialize': ['recovery:factory:start', 'recovery:factory:complete', 'recovery:runtime-verify:start', 'recovery:runtime-verify:complete', 'recovery:registry-init:start', 'recovery:registry-init:complete', 'composition:factory:start', 'composition:factory:complete', 'composition:initialize:start']
    }[phase];
    for (const enabled of [false, true]) {
      const lines = [];
      const mark = createStartupTrace({ env: { MINECRAFT_CORE_STARTUP_TRACE: enabled ? '1' : '0' },
        now: () => 0, utcNow: () => '2026-10-11T00:00:00.000Z', pid: 123, sink: line => { lines.push(line); } });
      const { graph } = graphFixture({
        async recoveryFactory() {
          if (phase === 'recovery-factory') throw failure;
          return { registry: { async initialize() { if (phase === 'registry') throw failure; return { records: [], corrupt: [], blocks: [], globalBlock: false }; } },
            recoveryService: { recoverAll() {} }, async runtimeVerifier() { if (phase === 'runtime') throw failure; return { quiescent: true }; } };
        },
        modpackFactory() {
          if (phase === 'composition-factory-sync') throw failure;
          if (phase === 'composition-factory-async') return Promise.reject(failure);
          return fakeModpackComposition({ async initialize() { if (phase === 'composition-initialize') throw failure; } });
        }
      }, tracedGraph(mark));
      const first = graph.startup.initializeRecovery(graph);
      await assert.rejects(first, error => error === failure);
      assert.equal(graph.startup.initializeRecovery(graph), first);
      assert.deepEqual(lines.map(line => JSON.parse(line.slice('[Minecraft Core startup trace] '.length)).marker), enabled ? expected : []);
      assert.doesNotMatch(lines.join(''), /SECRET_FAILURE/);
    }
  });
}

test('default production recovery services compose for a fresh isolated profile', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markers = [];
  const mark = createStartupTrace({ env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, now: () => 0,
    utcNow: () => '2026-10-11T00:00:00.000Z', pid: 123,
    sink: line => { markers.push(JSON.parse(line.slice('[Minecraft Core startup trace] '.length)).marker); } });
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
  }, tracedGraph(mark));

  const result = await fixture.graph.startup.initializeRecovery(fixture.graph);

  assert.deepEqual(result, { recovered: [], unresolved: [], globalBlock: false });
  assert.deepEqual(markers.slice(0, 4), ['recovery:factory:start', 'recovery:release-tracking-init:start',
    'recovery:release-tracking-init:complete', 'recovery:factory:complete']);
  const services = fixture.graph.recovery.getServices();
  assert.equal(typeof services.runtimeWriterAuthority?.run, 'function');
  assert.equal(services.recoveryService.runtimeWriterAuthority, services.runtimeWriterAuthority);
  assert.equal(typeof services.registry.clearRestoreCreationAfterCleanup, 'function');
  assert.equal(typeof services.restorePointService.cleanupInterruptedRestorePointCreation, 'function');
  assert.equal(typeof services.restorePointService.listAvailableRestorePoints, 'function');
  assert.equal(typeof services.restorePointService.withExactRetirementPoint, 'function');
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

const {
  createScanOnlyDurableFs,
  establishDegradedRecoveryGate,
  lifecycleRecordsProvablyAbsent
} = require('../../electron/services/modpack-lifecycle/degraded-recovery-gate.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');

const SEED_CLIENT = Object.freeze({
  moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
  moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {}
});

async function seedInterruptedJob(userDataPath, { jobId, serverId, serverPath }) {
  let token = 0;
  const registry = new RecoveryRegistry({
    userDataPath, fsApi: fs, randomUUID: crypto.randomUUID, clock: () => new Date('2026-10-30T00:00:00.000Z'),
    durableFs: createDurableFs({ allowedRoots: [userDataPath], durableClient: SEED_CLIENT, tempNameFactory: () => `seed-${++token}` })
  });
  await registry.initialize();
  const parent = path.dirname(serverPath);
  const name = path.basename(serverPath);
  await registry.create({
    schemaVersion: 1, sequence: 0, jobId, operationKind: 'install',
    target: { kind: 'existing', stableServerId: serverId, path: serverPath },
    candidatePath: path.join(parent, `.${name}.candidate-${jobId}`), rollbackPath: path.join(parent, `.${name}.rollback-${jobId}`),
    failedPath: path.join(parent, `.${name}.failed-${jobId}`), restorePoint: { id: 'restore-0001', sha256: 'a'.repeat(64) },
    journalPath: path.join(serverPath, '.minecraft-core-state', 'operations', jobId, 'journal.json'),
    priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', outcome: null
  });
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return {};
  const result = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of Object.entries(filesUnder(child))) result[path.join(entry.name, key)] = value;
    } else {
      result[entry.name] = fs.readFileSync(child).toString('base64');
    }
  }
  return result;
}

function degradedProfile(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const runtimeRoot = path.join(root, 'runtime-without-worker');
  const alpha = path.join(root, 'servers', 'alpha');
  const beta = path.join(root, 'servers', 'beta');
  for (const directory of [userDataPath, runtimeRoot, alpha, beta]) fs.mkdirSync(directory, { recursive: true });
  const instances = [
    { id: 'alpha', type: 'server', path: alpha },
    { id: 'beta', type: 'server', path: beta }
  ];
  return { alpha, beta, instances, root, runtimeRoot, userDataPath };
}

test('degraded startup mirrors the full recovery gate without ArchiveWorker: only the interrupted server stays blocked', async t => {
  const profile = degradedProfile(t, 'minecraft-core-degraded-gate-');
  await seedInterruptedJob(profile.userDataPath, { jobId: 'job-alpha', serverId: 'alpha', serverPath: profile.alpha });
  const before = filesUnder(path.join(profile.userDataPath, 'modpack-lifecycle'));
  const coordinator = new ServerMutationCoordinator();
  const failure = new ModpackError('EXTRACTOR_UNAVAILABLE', 'The archive worker is unavailable');
  const logged = [];
  const { graph } = graphFixture({
    userDataPath: profile.userDataPath,
    runtimeRoots: { resourcesPath: profile.runtimeRoot, runtimeRoot: profile.runtimeRoot, isPackaged: false, arch: 'x64' },
    store: { get: key => (key === 'instances' ? profile.instances : null) },
    coordinator,
    isInstanceRunning: () => false,
    logger: { error: (message, options) => logged.push([message, options.data]), warn() {} },
    async recoveryFactory() { throw failure; }
  });
  assert.equal(graph.startup.getHealth().status, 'starting');
  await assert.rejects(graph.startup.initializeRecovery(graph), error => error === failure);
  assert.equal(coordinator.recoveryOpen, true);

  const entered = graph.startup.enterDegradedMode(failure, graph);
  assert.equal(graph.startup.enterDegradedMode(new Error('later'), graph), entered, 'the first failure decides');
  assert.deepEqual(await entered, { mode: 'degraded' });

  assert.equal(coordinator.recoveryOpen, false);
  assert.equal(coordinator.globalRecoveryBlock, false);
  await assert.rejects(coordinator.acquireStart({ instanceId: 'alpha', serverPath: profile.alpha },
    { operation: 'server-start', operationId: 'start-alpha' }), { code: 'RECOVERY_REQUIRED' });
  const lease = await coordinator.acquireStart({ instanceId: 'beta', serverPath: profile.beta },
    { operation: 'server-start', operationId: 'start-beta' });
  assert.equal(lease.release(), true);

  const health = graph.startup.getHealth();
  assert.equal(health.status, 'degraded');
  assert.equal(health.modpackServices, 'unavailable');
  assert.equal(health.failure.reason, 'archive-worker-missing');
  assert.deepEqual(health.recoveryGate, {
    basis: 'read-only-scan', globalBlock: false, blockedServers: [{ operationId: 'job-alpha', instanceId: 'alpha' }]
  });
  assert.deepEqual(filesUnder(path.join(profile.userDataPath, 'modpack-lifecycle')), before, 'the degraded scan writes nothing');
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /degraded mode/u);
  assert.equal(logged[0][1].reason, 'archive-worker-missing');
  assert.equal(graph.modpacks.lifecycleService, null);
  assert.notEqual(graph.modpacks.degraded, null);
  assert.equal(graph.modpacks.clientPackIntegration, graph.modpacks.degraded.clientPackIntegration);
  assert.equal(graph.modpacks.stateRepository, graph.modpacks.degraded.stateRepository);
  assert.equal(graph.modpacks.companionResolver, graph.modpacks.degraded.companionResolver);
  assert.equal(graph.modpacks.companionResolver('beta'), null);
});

test('degraded gate releases a profile with no recovery records without building a registry', async t => {
  for (const layout of ['absent', 'empty']) {
    const profile = degradedProfile(t, `minecraft-core-degraded-empty-${layout}-`);
    if (layout === 'empty') {
      for (const name of ['active', 'history', 'retirements']) {
        fs.mkdirSync(path.join(profile.userDataPath, 'modpack-lifecycle', name), { recursive: true });
      }
    }
    assert.equal(lifecycleRecordsProvablyAbsent(profile.userDataPath), true, layout);
    const coordinator = new ServerMutationCoordinator();
    const result = await establishDegradedRecoveryGate({
      coordinator,
      userDataPath: profile.userDataPath,
      createRegistry() { assert.fail('no registry is built without recovery records'); }
    });
    assert.deepEqual(result, { basis: 'no-recovery-records', globalBlock: false, blocks: [], error: null }, layout);
    assert.equal(coordinator.recoveryOpen, false);
    assert.equal(coordinator.globalRecoveryBlock, false);
  }
});

test('a junction, a file or an unreadable entry takes the full scan-only path and keeps the global block when unreadable', async t => {
  const results = {};
  const runGate = async (name, prepare, fsApi = fs) => {
    const profile = degradedProfile(t, `minecraft-core-degraded-${name}-`);
    const lifecycle = path.join(profile.userDataPath, 'modpack-lifecycle');
    for (const directory of ['active', 'history']) fs.mkdirSync(path.join(lifecycle, directory), { recursive: true });
    if (prepare(lifecycle, profile) === false) return;
    assert.equal(lifecycleRecordsProvablyAbsent(profile.userDataPath, fsApi), false, name);
    const coordinator = new ServerMutationCoordinator();
    let registries = 0;
    const result = await establishDegradedRecoveryGate({
      coordinator,
      userDataPath: profile.userDataPath,
      fsApi,
      runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } },
      createRegistry(options) {
        registries += 1;
        return new RecoveryRegistry({
          ...options,
          durableFs: createScanOnlyDurableFs({ fsApi: options.fsApi, allowedRoots: [options.userDataPath] })
        });
      }
    });
    assert.equal(registries, 1, `${name} builds the read-only registry`);
    assert.equal(coordinator.recoveryOpen, false, name);
    assert.equal(coordinator.globalRecoveryBlock, true, name);
    results[name] = result.basis;
  };

  await runGate('junk-file', lifecycle => { fs.writeFileSync(path.join(lifecycle, 'active', 'junk.txt'), 'junk'); });
  await runGate('active-is-file', lifecycle => {
    fs.rmSync(path.join(lifecycle, 'active'), { recursive: true });
    fs.writeFileSync(path.join(lifecycle, 'active'), 'not a folder');
  });
  await runGate('junction', (lifecycle, profile) => {
    const target = path.join(profile.root, 'elsewhere');
    fs.mkdirSync(target);
    fs.rmSync(path.join(lifecycle, 'history'), { recursive: true });
    try {
      fs.symlinkSync(target, path.join(lifecycle, 'history'), 'junction');
    } catch {
      return false;
    }
    return true;
  });
  const deniedFs = Object.create(fs);
  deniedFs.lstatSync = (candidate, ...rest) => {
    if (path.basename(candidate) === 'active') throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return fs.lstatSync(candidate, ...rest);
  };
  await runGate('eperm', () => true, deniedFs);

  assert.equal(results['junk-file'], 'read-only-scan');
  assert.equal(results['active-is-file'], 'unreadable');
  assert.equal(results.eperm, 'unreadable');
  if (process.platform === 'win32') assert.equal(results.junction, 'unreadable');
});

test('a composition failure after the boundary keeps its blocks and disposal waits for it with no deadline', async t => {
  const profile = degradedProfile(t, 'minecraft-core-degraded-composition-');
  const coordinator = new ServerMutationCoordinator();
  const record = { jobId: 'job-alpha', target: { kind: 'existing', stableServerId: 'alpha', path: profile.alpha } };
  let releaseDisposal;
  const slowDisposal = new Promise(resolve => { releaseDisposal = resolve; });
  let disposeCalls = 0;
  const failure = new Error('composition initialize failed');
  const { graph } = graphFixture({
    userDataPath: profile.userDataPath,
    runtimeRoots: { resourcesPath: profile.runtimeRoot, runtimeRoot: profile.runtimeRoot, isPackaged: false, arch: 'x64' },
    store: { get: key => (key === 'instances' ? profile.instances : null) },
    coordinator,
    isInstanceRunning: () => false,
    async recoveryFactory() {
      return {
        registry: { async initialize() {
          return { records: [record], corrupt: [], blocks: [{ jobId: 'job-alpha', stableServerId: 'alpha', targetPathHash: null }], globalBlock: false };
        } },
        recoveryService: { async recoverAll() { assert.fail('no automatic recovery at startup'); } },
        runtimeVerifier: { async verifyBeforeRecovery() { return { quiescent: true }; } }
      };
    },
    async modpackFactory() {
      return fakeModpackComposition({
        async initialize() { throw failure; },
        dispose() { disposeCalls += 1; return slowDisposal; }
      });
    }
  });
  await assert.rejects(graph.startup.initializeRecovery(graph), error => error === failure);
  assert.equal(coordinator.recoveryOpen, false, 'the boundary settled before the composition failed');
  await graph.startup.enterDegradedMode(failure, graph);

  assert.equal(disposeCalls, 1, 'the half-built composition is disposed at once');
  assert.deepEqual(graph.startup.getHealth().recoveryGate, {
    basis: 'boundary', globalBlock: false, blockedServers: [{ operationId: 'job-alpha', instanceId: 'alpha' }]
  });
  await assert.rejects(coordinator.acquireStart({ instanceId: 'alpha', serverPath: profile.alpha },
    { operation: 'server-start', operationId: 'start-alpha' }), { code: 'RECOVERY_REQUIRED' });
  const lease = await coordinator.acquireStart({ instanceId: 'beta', serverPath: profile.beta },
    { operation: 'server-start', operationId: 'start-beta' });
  assert.equal(lease.release(), true);
  assert.deepEqual(graph.modpacks.degraded.listRecovery().items.map(item => item.serverId), ['alpha']);
  assert.deepEqual(graph.startup.listActiveWork(), ['modpack-composition-disposal'], 'an update install waits for the disposal');

  let disposed = false;
  const disposal = graph.startup.dispose(graph).then(() => { disposed = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(disposed, false, 'graph disposal (and with it an orderly quit) waits for the half-built composition');
  releaseDisposal();
  await disposal;
  assert.equal(disposed, true);
  assert.deepEqual(graph.startup.listActiveWork(), []);
});

test('active work for the update guard: modpack jobs, exclusive client and coordinator holders, never shared writers', async () => {
  const coordinator = {
    runMutation() {}, runManyMutations() {}, beginStartupRecovery() {}, installRecoveryBlocks() {}, completeStartupRecovery() {},
    listActiveOperations: () => [
      { operationId: 'op-lifecycle', holder: 'lifecycle' },
      { operationId: 'op-exclusive', holder: 'ordinary-exclusive' },
      { operationId: 'op-shared', holder: 'ordinary-shared' },
      { operationId: 'op-start', holder: 'start-pending' }
    ]
  };
  let admittedOnly = false;
  const { graph } = graphFixture({
    coordinator,
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
    async modpackFactory() {
      return fakeModpackComposition({
        lifecycleService: {
          listActiveOperationIds: () => (admittedOnly ? [] : ['job-install']),
          hasActiveWork: () => true
        },
        listActiveClientMutations: () => ['client-mutation:abc']
      });
    }
  });
  assert.deepEqual(graph.startup.listActiveWork(), ['op-lifecycle', 'op-exclusive'], 'before the modpack services exist');
  await graph.startup.initializeRecovery(graph);
  assert.deepEqual(graph.startup.listActiveWork(), ['job-install', 'client-mutation:abc', 'op-lifecycle', 'op-exclusive']);
  admittedOnly = true;
  assert.deepEqual(graph.startup.listActiveWork(), ['modpack-lifecycle-work', 'client-mutation:abc', 'op-lifecycle', 'op-exclusive']);
});

test('after-window modpack hooks report their failures and never stop the window', async () => {
  const warnings = [];
  const ran = [];
  const { graph } = graphFixture({
    logger: { warn: (message, options) => warnings.push([message, options.data.stage]), error() {} },
    startup: {
      async initializeRecovery() {},
      waitForWindowNavigationReady: () => Promise.resolve(true),
      afterWindowCreated() { ran.push('main-hook'); }
    },
    async modpackFactory() {
      return fakeModpackComposition({
        nativeNotificationBridge: { start() { throw new Error('toast bridge failed'); }, stop() {} },
        releaseMonitor: { async checkAll() {}, async checkOne() {}, async start() { ran.push('monitor'); throw new Error('monitor failed'); }, stop() {} },
        armStartupRetirement() { ran.push('retirement'); throw new Error('retirement failed'); }
      });
    }
  });
  await graph.startup.initializeRecovery(graph);
  await graph.startup.afterWindowCreated({ id: 1 }, graph);

  assert.deepEqual(ran, ['main-hook', 'monitor', 'retirement']);
  const stages = ['native-notifications:start', 'release-monitor:start', 'startup-retirement:arm'];
  assert.deepEqual(graph.startup.getHealth().issues.map(issue => issue.stage).filter(stage => stages.includes(stage)), stages);
  assert.deepEqual(warnings.map(([, stage]) => stage).filter(stage => stages.includes(stage)), stages);
  const fatal = graphFixture({ startup: { async initializeRecovery() {}, afterWindowCreated() { throw new Error('cleanup hook failed'); } } }).graph;
  await assert.rejects(fatal.startup.afterWindowCreated({ id: 2 }, fatal), /cleanup hook failed/u);
});

test('a full start is ready and reports a missing ArchiveWorker.exe without degrading', async t => {
  const profile = degradedProfile(t, 'minecraft-core-ready-health-');
  const { graph } = graphFixture({
    userDataPath: profile.userDataPath,
    runtimeRoots: { resourcesPath: profile.runtimeRoot, runtimeRoot: profile.runtimeRoot, isPackaged: false, arch: 'x64' },
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; }
  });
  assert.equal(graph.paths.archiveWorker, path.join(profile.runtimeRoot, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe'));
  await graph.startup.initializeRecovery(graph);
  const health = graph.startup.getHealth();
  assert.equal(health.status, 'ready');
  assert.equal(health.modpackServices, 'ready');
  assert.equal(health.failure, null);
  assert.deepEqual(health.recoveryGate, { basis: 'boundary', globalBlock: false, blockedServers: [] });
  assert.deepEqual(health.issues.map(issue => [issue.stage, issue.reason]), [['archive-worker', 'archive-worker-missing']]);

  fs.mkdirSync(path.dirname(graph.paths.archiveWorker), { recursive: true });
  fs.writeFileSync(graph.paths.archiveWorker, 'MZ');
  const withWorker = graphFixture({
    userDataPath: profile.userDataPath,
    runtimeRoots: { resourcesPath: profile.runtimeRoot, runtimeRoot: profile.runtimeRoot, isPackaged: false, arch: 'x64' },
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; }
  }).graph;
  await withWorker.startup.initializeRecovery(withWorker);
  assert.deepEqual(withWorker.startup.getHealth().issues, []);
});

test('full mode keeps the composition companion resolver and integration ahead of any fallback', async () => {
  const statuses = [];
  const { graph } = graphFixture({
    async recoveryFactory() { return EMPTY_RECOVERY_SERVICES; },
    async modpackFactory() {
      return fakeModpackComposition({
        companionService: { getStatus(request) { statuses.push(request); return 'descriptor'; } },
        clientPackIntegration: { marker: 'composition-integration' }
      });
    }
  });
  assert.equal(graph.modpacks.companionResolver, null, 'no resolver before the modpack services or degraded mode');
  await graph.startup.initializeRecovery(graph);
  assert.equal(graph.modpacks.degraded, null);
  assert.equal(graph.modpacks.clientPackIntegration.marker, 'composition-integration');
  assert.equal(graph.modpacks.companionResolver('server-1'), 'descriptor');
  assert.deepEqual(statuses, [{ serverId: 'server-1' }]);
});
