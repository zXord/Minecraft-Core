const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const { createModpackServiceGraph } = require('../electron/bootstrap/create-modpack-service-graph.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../electron/services/modpack-lifecycle/recovery-registry.cjs');

const SERVICES_UNAVAILABLE = 'MODPACK_SERVICES_UNAVAILABLE';
const STARTUP_CHANNELS = ['startup:get-health', 'startup:relaunch', 'startup:open-logs'];
const UNMANAGED_STATE = Object.freeze({
  type: 'modpack-state', modpackManaged: false, lifecycleMode: 'unmanaged', source: null, runtime: null,
  selectedOptionalFiles: [], installedAt: null, contentRevision: null, managedFileCount: '0'
});

const RENAME_CLIENT = Object.freeze({
  moveWriteThrough: fs.renameSync,
  replaceFileWriteThrough: fs.renameSync,
  flushDirectory() {},
  moveWriteThroughAsync: fs.promises.rename,
  replaceFileWriteThroughAsync: fs.promises.rename,
  async flushDirectoryAsync() {}
});

// An interrupted modpack job for one server, written by a real registry the
// way a crashed modpack install leaves it.
async function seedInterruptedJob(userDataPath, { jobId, serverId, serverPath }) {
  let token = 0;
  const registry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs: createDurableFs({ allowedRoots: [userDataPath], durableClient: RENAME_CLIENT, tempNameFactory: () => `seed-${++token}` }),
    clock: () => new Date('2026-10-30T00:00:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  await registry.initialize();
  const parent = path.dirname(serverPath);
  const name = path.basename(serverPath);
  await registry.create({
    schemaVersion: 1,
    sequence: 0,
    jobId,
    operationKind: 'install',
    target: { kind: 'existing', stableServerId: serverId, path: serverPath },
    candidatePath: path.join(parent, `.${name}.candidate-${jobId}`),
    rollbackPath: path.join(parent, `.${name}.rollback-${jobId}`),
    failedPath: path.join(parent, `.${name}.failed-${jobId}`),
    restorePoint: { id: 'restore-0001', sha256: 'a'.repeat(64) },
    journalPath: path.join(serverPath, '.minecraft-core-state', 'operations', jobId, 'journal.json'),
    priorRuntime: { running: false, autoRestart: false },
    phase: 'queued',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    outcome: null
  });
}

function extractPreloadModpackChannels() {
  const source = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
  const match = source.match(/const MODPACK_INVOKE_CHANNELS = Object\.freeze\((\[[\s\S]*?\])\);/u);
  assert.ok(match, 'preload must declare its modpack invoke channels');
  return vm.runInNewContext(match[1]);
}

// The preload bridge as the renderer gets it, invoking through the captured handlers.
function loadPreloadBridge(invokeHandler) {
  const preloadPath = path.resolve(__dirname, '../electron/preload.cjs');
  const originalLoad = Module._load;
  const exposed = {};
  Module._load = function loadPreloadFixture(request, parent, isMain) {
    if (request === 'electron' && parent?.filename === preloadPath) {
      return {
        contextBridge: { exposeInMainWorld(name, api) { exposed[name] = api; } },
        ipcRenderer: { invoke: (channel, ...args) => invokeHandler(channel, ...args), on() {}, removeListener() {}, removeAllListeners() {} }
      };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    delete require.cache[preloadPath];
    Module._load = originalLoad;
  }
  return exposed.electron;
}

async function degradedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-degraded-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const runtimeRoot = path.join(root, 'runtime-without-worker');
  for (const directory of [userDataPath, runtimeRoot]) fs.mkdirSync(directory, { recursive: true });
  const servers = {
    legacy: path.join(root, 'servers', 'legacy'),
    managed: path.join(root, 'servers', 'managed'),
    blocked: path.join(root, 'servers', 'blocked')
  };
  for (const serverPath of Object.values(servers)) fs.mkdirSync(serverPath, { recursive: true });
  fs.mkdirSync(path.join(servers.managed, '.minecraft-core-state'));
  fs.writeFileSync(path.join(servers.managed, '.minecraft-core-state', 'modpack.json'), '{}\n');
  await seedInterruptedJob(userDataPath, { jobId: 'job-blocked', serverId: 'server-blocked', serverPath: servers.blocked });
  const clientPath = path.join(root, 'clients', 'friend');
  fs.mkdirSync(clientPath, { recursive: true });
  const instances = [
    { id: 'server-legacy', type: 'server', name: 'Legacy', path: servers.legacy },
    { id: 'server-managed', type: 'server', name: 'Managed', path: servers.managed },
    { id: 'server-blocked', type: 'server', name: 'Blocked', path: servers.blocked },
    { id: 'client-friend', type: 'client', name: 'Friend', path: clientPath }
  ];
  const store = { get: key => (key === 'instances' ? instances : null), set() {} };
  const coordinator = new ServerMutationCoordinator();
  const recoveryFailure = new ModpackError('EXTRACTOR_UNAVAILABLE', 'The archive worker is unavailable');
  const graph = createModpackServiceGraph({
    app: { isPackaged: false, getPath: () => userDataPath },
    store,
    userDataPath,
    runtimeRoots: { resourcesPath: runtimeRoot, runtimeRoot, isPackaged: false, arch: 'x64' },
    coordinator,
    windowFactory: () => ({ id: 1 }),
    isInstanceRunning: () => false,
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpsRequest: () => { throw new Error('no network in this test'); },
    async recoveryFactory() { throw recoveryFailure; },
    modpackFactory: async () => assert.fail('the modpack composition never starts here')
  });
  await assert.rejects(graph.startup.initializeRecovery(graph), error => error === recoveryFailure);
  if (typeof graph.startup.enterDegradedMode === 'function') await graph.startup.enterDegradedMode(recoveryFailure, graph);
  return { coordinator, graph, instances, root, servers, userDataPath };
}

// setupIpcHandlers with the real modpack, client pack and session IPC; the
// unrelated handler modules are stubbed so no app profile is read or written.
// The stubs stay in place until the test ends: IPC setup and the handlers
// require some modules lazily.
function loadIpcSetup(t) {
  const modulePath = path.resolve(__dirname, '../electron/ipc-handlers.cjs');
  const originalLoad = Module._load;
  const handlers = new Map();
  const registered = new Set();
  const calls = { backupOptions: null, resolver: null, opened: [], relaunched: 0, quit: 0 };
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); }
  };
  const emptyFactory = () => ({});
  const stubbedFactories = {
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
  const app = {
    getPath: name => { assert.equal(name, 'userData'); return 'C:\\profile'; },
    relaunch() { calls.relaunched += 1; },
    quit() { calls.quit += 1; }
  };
  const shell = { async openPath(value) { calls.opened.push(value); return ''; } };
  Module._load = function loadIpcFixture(request, parent, isMain) {
    if (parent?.filename === modulePath) {
      if (request === 'electron') return { ipcMain, app, shell };
      if (request === './utils/app-store.cjs') return { get() { throw new Error('the graph store is used'); } };
      if (request === './utils/ipc-helpers.cjs') {
        return { registeredHandlers: registered, registerIpcHandlers(value) { for (const [channel, handler] of Object.entries(value)) handlers.set(channel, handler); } };
      }
      if (request === './ipc/player-handlers.cjs') return { createPlayerHandlers: emptyFactory, initializePlayerIpMap() {} };
      if (request === './ipc/backup-handlers.cjs') {
        return { createBackupHandlers(options) { calls.backupOptions = options; return {}; }, loadBackupManager() {} };
      }
      if (request === './ipc/logger-handlers.cjs') return { getLoggerHandlers: () => ({ info() {} }) };
      if (request === './services/auto-restart.cjs') return { setAutoRestartOptions() {}, getAutoRestartState: () => ({}) };
      if (request === './services/management-server.cjs') return { configureClientModpackResolver(value) { calls.resolver = value; } };
      if (request === './services/server-manager.cjs') return { getAllServerStates: () => [] };
      if (stubbedFactories[request]) return { [stubbedFactories[request]]: emptyFactory };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  t.after(() => {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  });
  const { setupIpcHandlers } = require(modulePath);
  const sender = new EventEmitter();
  sender.id = 7;
  sender.mainFrame = {};
  sender.isDestroyed = () => false;
  const win = new EventEmitter();
  win.webContents = sender;
  win.isDestroyed = () => false;
  const invoke = (channel, ...args) => {
    const handler = handlers.get(channel);
    if (!handler) return Promise.reject(new Error(`No handler registered for '${channel}'`));
    return Promise.resolve(handler({ sender, senderFrame: sender.mainFrame }, ...args));
  };
  return { setup: graph => setupIpcHandlers(win, graph), handlers, invoke, calls };
}

// The renderer's own start gate (ServerControls.svelte) over the real modpackApi
// calls it makes, fed by the registered IPC.
async function rendererStartGate(invoke, serverId) {
  globalThis.window = { electron: { invoke } };
  try {
    const { modpackApi } = await import('../src/utils/modpacks/modpackApi.js');
    const { filterRecoveryRecordsForServer } = await import('../src/stores/modpackNotificationStore.js');
    const controls = fs.readFileSync(path.join(__dirname, '../src/components/server/ServerControls.svelte'), 'utf8');
    const gate = controls.match(/\$: recoveryStartBlocked = ([\s\S]*?);\r?\n/u);
    assert.ok(gate, 'ServerControls must declare its recovery start gate');
    let activityStatus = 'error';
    let activeOperationCount = 0;
    try {
      const result = await modpackApi.getActiveJobs(serverId);
      if (result?.serverId !== serverId || !Array.isArray(result.items)) throw new Error('Operation status unavailable');
      activeOperationCount = result.items.length;
      activityStatus = 'ready';
    } catch {
      activityStatus = 'error';
    }
    let recoveryStatus = 'error';
    let recoveryPendingCount = 0;
    try {
      const result = await modpackApi.listRecovery();
      const records = Array.isArray(result) ? result : result?.items;
      if (!Array.isArray(records)) throw new Error('Recovery list unavailable');
      recoveryPendingCount = filterRecoveryRecordsForServer(records, serverId).length;
      recoveryStatus = 'ready';
    } catch {
      recoveryStatus = 'error';
    }
    return vm.runInNewContext(gate[1], {
      currentInstanceId: serverId,
      serverPath: 'C:\\servers\\selected',
      recoveryStatus,
      activityStatus,
      activeOperationCount,
      recoveryPendingCount,
      recoveryScopeKey: 'scope',
      loadedRecoveryScopeKey: 'scope'
    });
  } finally {
    delete globalThis.window;
  }
}

test('degraded IPC setup registers every modpack, client pack, session and startup channel', async t => {
  const { graph } = await degradedFixture(t);
  assert.equal(graph.startup.getHealth().modpackServices, 'unavailable');
  const ipc = loadIpcSetup(t);

  assert.doesNotThrow(() => ipc.setup(graph));

  const expected = [...extractPreloadModpackChannels(), 'management-session:acquire', ...STARTUP_CHANNELS];
  assert.ok(expected.includes('modpacks:reconcile-new-server-launch') && expected.includes('client-packs:get-state'));
  for (const channel of expected) assert.equal(ipc.handlers.has(channel), true, `${channel} has a handler`);

  // The renderer may call the startup channels through the preload bridge.
  const bridged = [];
  const bridge = loadPreloadBridge(channel => { bridged.push(channel); return Promise.resolve(null); });
  for (const channel of STARTUP_CHANNELS) await bridge.invoke(channel);
  assert.deepEqual(bridged, STARTUP_CHANNELS);
});

test('degraded modpack IPC refuses modpack work and answers unmanaged state only without modpack state', async t => {
  const { graph } = await degradedFixture(t);
  const ipc = loadIpcSetup(t);
  ipc.setup(graph);

  const started = await ipc.invoke('modpacks:start-operation', {
    planId: 'plan-1', planFingerprint: 'a'.repeat(64), choices: { acceptEula: true, startAfterInstall: false, restorePointId: null }
  });
  assert.equal(started.ok, false);
  assert.equal(started.error.code, SERVICES_UNAVAILABLE);
  assert.match(started.error.message, /Modpack features are turned off/u);

  assert.deepEqual(await ipc.invoke('modpacks:get-state', { serverId: 'server-legacy' }),
    { ok: true, value: { ...UNMANAGED_STATE, instanceId: 'server-legacy' } });
  const managed = await ipc.invoke('modpacks:get-state', { serverId: 'server-managed' });
  assert.equal(managed.ok, false);
  assert.equal(managed.error.code, SERVICES_UNAVAILABLE);

  assert.deepEqual(await ipc.invoke('modpacks:get-active-jobs', { serverId: 'server-legacy' }),
    { ok: true, value: { serverId: 'server-legacy', items: [] } });
  const clientState = await ipc.invoke('client-packs:install', {
    clientId: 'client-friend', planId: 'plan-1', conflictChoices: {}, requestId: 'request-1'
  });
  assert.equal(clientState.ok, false);
  assert.equal(clientState.error.code, SERVICES_UNAVAILABLE);
});

test('degraded recovery listing keeps the renderer start gate open for an unmarked server and closed for a blocked one', async t => {
  const { coordinator, graph } = await degradedFixture(t);
  const ipc = loadIpcSetup(t);
  ipc.setup(graph);

  const listed = await ipc.invoke('modpacks:list-recovery', {});
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.value.items.map(item => [item.instanceId, item.stableServerId, item.actions.length]),
    [['server-blocked', 'server-blocked', 0]]);

  assert.equal(await rendererStartGate(ipc.invoke, 'server-legacy'), false);
  assert.equal(await rendererStartGate(ipc.invoke, 'server-blocked'), true);
  // The coordinator agrees with the renderer.
  await assert.rejects(coordinator.acquireStart({ instanceId: 'server-blocked', serverPath: graph.store.get('instances')[2].path },
    { operation: 'server-start', operationId: 'start-blocked' }), { code: 'RECOVERY_REQUIRED' });
});

test('degraded IPC wires the per-server companion resolver, the backup state reader and the startup channels', async t => {
  const { graph } = await degradedFixture(t);
  const ipc = loadIpcSetup(t);
  ipc.setup(graph);

  assert.equal(typeof ipc.calls.resolver, 'function');
  assert.equal(await ipc.calls.resolver('server-legacy'), null);
  assert.throws(() => ipc.calls.resolver('server-managed'), { code: SERVICES_UNAVAILABLE });

  const repository = ipc.calls.backupOptions.getModpackStateRepository();
  assert.equal(repository, graph.modpacks.stateRepository);
  assert.equal(repository.read(graph.store.get('instances')[0].path), null);

  assert.equal(await ipc.invoke('startup:get-health'), graph.startup.getHealth());
  assert.deepEqual(await ipc.invoke('startup:open-logs'), { success: true });
  assert.deepEqual(ipc.calls.opened, [path.join('C:\\profile', 'logs')]);
  assert.deepEqual(await ipc.invoke('startup:relaunch'), { success: true });
  assert.deepEqual([ipc.calls.relaunched, ipc.calls.quit], [1, 1]);
});
