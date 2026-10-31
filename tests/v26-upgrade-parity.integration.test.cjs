const assert = require('node:assert/strict');
const { AsyncResource } = require('node:async_hooks');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { promisify } = require('node:util');
const test = require('node:test');
const AdmZip = require('adm-zip');

// Cross-batch v26.6.1 upgrade parity suite. One v26.6.1-shaped profile per
// process, composed like the service graph: the real server mutation policy,
// coordinator, state observer and config writer (the instance-config factory
// over the production strict factory, with the dev ArchiveWorker present), the
// real settings, player, server-properties, backup, management, mod, client and
// server handlers, the real client-pack integration and process guard, and the
// real server manager, whose start lease is held by a FakeChild Java process.
// Only process-wide boundaries are stubbed: the app store, logging, secrets,
// port probing (real for the one case that holds real sockets), the management
// HTTPS server, Java discovery and the Java process itself. A child_process spy
// records every spawn and refuses ArchiveWorker.exe.

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'v26-parity-')));
const USER_DATA = path.join(ROOT, 'user-data');
fs.mkdirSync(USER_DATA);
const JAVA_PATH = path.join(ROOT, 'java', 'bin', 'java.exe');
const EVENT = Object.freeze({ sender: Object.freeze({ id: 1 }) });
const BROWSER = Object.freeze({ sender: Object.freeze({ id: 'browser' }) });
const QUIET = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'Windows junctions and the native ArchiveWorker' };

const store = new Map();
const appStore = {
  get: key => (store.has(key) ? structuredClone(store.get(key)) : undefined),
  set: (key, value) => { store.set(key, structuredClone(value)); return true; },
  delete: key => { store.delete(key); return true; },
  has: key => store.has(key)
};

// Java runs as a FakeChild. A real ChildProcess reports 'exit' and 'close' in the
// async context it was spawned in, which is the start lease of that launch.
const javaProcesses = [];
let nextPid = 7100;
class FakeJavaProcess extends EventEmitter {
  constructor(args, options) {
    super();
    this.pid = nextPid++;
    this.args = [...args];
    this.cwd = options?.cwd;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new EventEmitter();
    this.stdin.writable = true;
    this.stdin.destroyed = false;
    this.stdin.writes = [];
    this.stdin.write = (value, callback) => {
      this.stdin.writes.push(String(value));
      if (String(value).trim() === 'stop') setImmediate(() => this.finish(0, null));
      if (typeof callback === 'function') setImmediate(callback);
      return true;
    };
    this.spawnContext = new AsyncResource('ParityJavaProcess');
  }

  finish(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdin.writable = false;
    this.stdout.end();
    this.stderr.end();
    this.spawnContext.runInAsyncScope(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    setImmediate(() => this.finish(null, signal));
    return true;
  }
}

const realChildProcess = require('node:child_process');
const spawned = [];
const isArchiveWorker = command => typeof command === 'string' && path.basename(command).toLowerCase() === 'archiveworker.exe';
function recordSpawn(kind, command, args) {
  spawned.push({ kind, command: String(command), args: Array.isArray(args) ? [...args] : [] });
  if (isArchiveWorker(command)) throw new Error('The parity suite refuses to run ArchiveWorker.exe');
}
function spyExecFile(command, args, ...rest) {
  recordSpawn('execFile', command, args);
  return realChildProcess.execFile(command, args, ...rest);
}
spyExecFile[promisify.custom] = (command, args, ...rest) => {
  recordSpawn('execFile', command, args);
  return promisify(realChildProcess.execFile)(command, args, ...rest);
};
const childProcessSpy = Object.freeze({
  ...realChildProcess,
  spawn(command, args, options) {
    recordSpawn('spawn', command, args);
    if (command === JAVA_PATH) {
      const child = new FakeJavaProcess(args, options);
      javaProcesses.push(child);
      return child;
    }
    return realChildProcess.spawn(command, args, options);
  },
  spawnSync(command, args, options) {
    recordSpawn('spawnSync', command, args);
    return realChildProcess.spawnSync(command, args, options);
  },
  execFile: spyExecFile,
  execFileSync(command, args, options) {
    recordSpawn('execFileSync', command, args);
    return realChildProcess.execFileSync(command, args, options);
  }
});

const managementStarts = [];
const managementServers = new Map();
function getManagementServer({ instanceId = null, serverPath = null } = {}) {
  const key = serverPath ? path.resolve(serverPath).toLowerCase() : `id:${instanceId}`;
  if (!managementServers.has(key)) {
    let running = null;
    managementServers.set(key, {
      setInviteSecret() {},
      setExternalHost() {},
      async start(port, targetPath) {
        managementStarts.push({ port, serverPath: targetPath });
        running = port;
        return { success: true, port };
      },
      async stop() { running = null; return { success: true }; },
      getStatus: () => ({ isRunning: running !== null, port: running })
    });
  }
  return managementServers.get(key);
}

const javaMajorFor = version => (/^1\.(?:1\d|20(?:\.[0-4])?)$/u.test(version) ? 17 : 21);
class FakeServerJavaManager {
  async getJavaRequirementsForMinecraft(minecraftVersion) {
    return { isAvailable: true, needsDownload: false, javaPath: JAVA_PATH, requiredJavaVersion: javaMajorFor(minecraftVersion) };
  }

  async ensureJavaForMinecraft() {
    return { success: true };
  }
}

const electronStub = Object.freeze({
  app: { getPath: name => (name === 'userData' ? USER_DATA : ROOT), getVersion: () => '26.11.1', isPackaged: false },
  ipcMain: { handle() {}, on() {}, removeHandler() {} },
  BrowserWindow: class { static getAllWindows() { return []; } },
  Notification: class { static isSupported() { return false; } show() {} on() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' }
});

// Set to the real validator only while the case that holds real sockets runs.
let livePortValidator = null;
const STUBS = new Map([
  ['app-store.cjs', appStore],
  ['logger-handlers.cjs', { getLoggerHandlers: () => QUIET }],
  ['logger-service.cjs', { getLogger: () => QUIET }],
  ['secure-store.cjs', {
    ENCRYPTED_PREFIX: 'packed:',
    ensureEncryptionAvailable: () => true,
    packSecret: value => `packed:${value}`,
    unpackSecret: value => (typeof value === 'string' && value.startsWith('packed:') ? value.slice('packed:'.length) : value)
  }],
  ['servers-dat.cjs', { ensureServersDat: async () => ({ success: true }) }],
  // Every port is free, except for the case that checks real sockets.
  ['port-validator.cjs', {
    validateServerPorts: async options => (livePortValidator
      ? livePortValidator.validateServerPorts(options)
      : { valid: true, errors: [] })
  }],
  ['management-server.cjs', {
    getManagementServer,
    stopAndDisposeManagementServers: async () => ({ success: true }),
    configureClientModpackResolver() {}
  }],
  ['server-java-manager.cjs', { ServerJavaManager: FakeServerJavaManager }],
  // Error reporting only records; its module-level monitor keeps hourly timers alive.
  ['error-monitoring-handlers.cjs', { serverErrorMonitor: { logDownloadError() {}, logChecksumError() {} } }],
  ['pidusage', async () => ({ cpu: 0, memory: 0 })]
]);
const originalLoad = Module._load;
Module._load = function loadParityBoundaries(request, parent, isMain) {
  if (request === 'child_process' || request === 'node:child_process') return childProcessSpy;
  if (request === 'electron') return electronStub;
  const name = typeof request === 'string' ? path.posix.basename(request.replaceAll('\\', '/')) : '';
  // No process snapshots: launch evidence is optional and never changes a start.
  if (name === 'client-process-inspector.cjs') {
    return { ...originalLoad.call(this, request, parent, isMain), createClientProcessInspector: () => undefined };
  }
  return STUBS.get(name) || originalLoad.call(this, request, parent, isMain);
};
// The real validator, loaded past its stub; its own app store, logging and
// child_process are the boundaries above.
const realPortValidator = originalLoad.call(Module, require.resolve('../electron/utils/port-validator.cjs'), module, false);

const { createProductionDurableFsFactory } = require('../electron/bootstrap/create-modpack-service-graph.cjs');
const { stateRepositoryRouter } = require('../electron/bootstrap/create-production-modpack-composition.cjs');
const { clientDurableRouter } = require('../electron/bootstrap/create-client-pack-composition.cjs');
const { createClientConnectionCore } = require('../electron/bootstrap/create-client-connection-core.cjs');
const { WindowsDurableFsClient } = require('../electron/utils/windows-durable-fs-client.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { createInstanceConfigFsFactory, createLegacyInstanceConfigFs } = require('../electron/utils/instance-config-fs.cjs');
const { configureServerConfigDurableFsFactory, readServerConfig } = require('../electron/utils/config-manager.cjs');
const { readContentRevision } = require('../electron/services/server-content-revision.cjs');
const { inspectFolderEvidence } = require('../electron/services/modpacks/instance-ownership.cjs');
const {
  ModpackStateRepository,
  createModpackStateObserver
} = require('../electron/services/modpacks/state/modpack-state-repository.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const {
  installServerMutationCoordinator,
  markCurrentServerMutationDirty
} = require('../electron/services/server-mutation-context.cjs');
const { createServerMutationPolicy } = require('../electron/services/server-mutation-policy.cjs');
const { createClientPackIntegration } = require('../electron/services/client-modpacks/client-pack-integration.cjs');
const { ClientProcessGuard } = require('../electron/services/client-modpacks/client-process-guard.cjs');
const { ClientPackStateStore } = require('../electron/services/client-modpacks/client-pack-state.cjs');
const { ClientPackTransaction } = require('../electron/services/client-modpacks/client-pack-transaction.cjs');
const { createSettingsHandlers } = require('../electron/ipc/settings-handlers.cjs');
const { createPlayerHandlers } = require('../electron/ipc/player-handlers.cjs');
const { createServerPropertiesHandlers } = require('../electron/ipc/server-properties-handlers.cjs');
const { createBackupHandlers } = require('../electron/ipc/backup-handlers.cjs');
const { createManagementServerHandlers } = require('../electron/ipc/management-server-handlers.cjs');
const { createServerModHandlers } = require('../electron/ipc/mod-handlers/server-mod-handlers.cjs');
const { createManualModHandlers } = require('../electron/ipc/mod-handlers/manual-mod-handlers.cjs');
const { createModAvailabilityHandlers } = require('../electron/ipc/mod-availability-handlers.cjs');
const { createServerHandlers } = require('../electron/ipc/server-handlers.cjs');
const { setAutoRestartOptions } = require('../electron/services/auto-restart.cjs');
const serverManager = require('../electron/services/server-manager.cjs');
const browserPanel = require('../electron/services/browser-panel-server.cjs');

// The production composition (create-modpack-service-graph.cjs). The strict
// factory is the production one with the dev ArchiveWorker; its native client
// factory is the real one, observed. A folder in simulatedDriveRoots is refused
// as an allowed root, as the native client refuses a drive root (E:\).
const strictClientRoots = [];
const simulatedDriveRoots = new Set();
const folderKey = value => path.resolve(value).normalize('NFC').toLocaleLowerCase('en-US');
function productionFactory(requireConfirmedClose) {
  return createProductionDurableFsFactory({
    fsSync: fs,
    fsPromises: fs.promises,
    randomUUID: crypto.randomUUID,
    runtimeRoots: Object.freeze({ resourcesPath: REPO_ROOT, runtimeRoot: REPO_ROOT, isPackaged: false, arch: process.arch }),
    userDataPath: USER_DATA,
    requireConfirmedClose,
    durableClientFactory: options => {
      strictClientRoots.push([...options.allowedRoots]);
      if (options.allowedRoots.some(root => simulatedDriveRoots.has(folderKey(root)))) {
        throw new Error('A drive root cannot be a durable root');
      }
      return new WindowsDurableFsClient(options);
    }
  });
}
const strictFactory = productionFactory(false);
const clientStrictFactory = productionFactory(true);
const instanceConfigFsFactory = createInstanceConfigFsFactory({
  strictFactory,
  inspect: folder => inspectFolderEvidence(folder, { fsApi: fs }),
  legacyFs: createLegacyInstanceConfigFs({ fsApi: fs, tempNameFactory: crypto.randomUUID })
});
configureServerConfigDurableFsFactory(instanceConfigFsFactory);
const coordinator = new ServerMutationCoordinator({ durableFsFactory: instanceConfigFsFactory });
installServerMutationCoordinator(coordinator);
coordinator.completeStartupRecovery([]);
const stateRepository = stateRepositoryRouter({
  durableFsFactory: strictFactory, fsApi: fs, clock: { now: () => Date.now() }, userDataPath: USER_DATA
});
const stateObserver = createModpackStateObserver({ repository: stateRepository, fsApi: fs });

// The matching-client layer, as create-client-pack-composition.cjs builds it.
// The host is a v26.6.1 host: it answers without any client modpack field.
const clientPacksRoot = path.join(USER_DATA, 'client-packs');
for (const folder of ['transactions', 'processes']) fs.mkdirSync(path.join(clientPacksRoot, folder), { recursive: true });
const processScans = [];
const hostReads = [];
const connectionCore = createClientConnectionCore({ store: appStore, randomUUID: crypto.randomUUID, clock: { now: () => Date.now() } });
const clientDurableFs = clientDurableRouter({
  root: clientPacksRoot,
  getInstances: () => appStore.get('instances') || [],
  durableFsFactory: clientStrictFactory
});
const clientStateStore = new ClientPackStateStore({ durableFs: clientDurableFs });
const clientPackIntegration = createClientPackIntegration({
  resolveClient: connectionCore.resolveClient,
  resolveClientByPath: connectionCore.resolveClientByPath,
  processGuard: new ClientProcessGuard({
    root: path.join(clientPacksRoot, 'processes'),
    durableFs: clientStrictFactory([clientPacksRoot]),
    inspectProcesses: async () => {
      processScans.push(Date.now());
      return { complete: true, processes: [] };
    },
    acquireEndpointLease: async () => ({ async close() {}, assertHeld() {} })
  }),
  transaction: new ClientPackTransaction({
    journalRoot: path.join(clientPacksRoot, 'transactions'),
    durableFs: clientDurableFs,
    stateStore: clientStateStore,
    reparseInspector: { async isReparsePoint() { return false; } }
  }),
  stateStore: clientStateStore,
  managementClient: {
    async readRequirement(clientId) {
      hostReads.push(clientId);
      return { descriptor: null, binding: null, legacyHost: true };
    }
  },
  clientPackService: {}
});

const policy = createServerMutationPolicy({
  coordinator,
  getClientPackIntegration: () => clientPackIntegration,
  getModpackStateRepository: () => stateObserver,
  getInstances: () => appStore.get('instances') || [],
  createOperationId: channel => `${channel.replace(/[^A-Za-z0-9_-]/g, '-')}-${crypto.randomUUID()}`
});

// The game launch and a Modrinth mod update are network and game boundaries; their
// stand-ins run behind the real policy, gates and leases.
const launches = [];
const ipc = policy.wrapHandlers({
  ...createSettingsHandlers(),
  ...createPlayerHandlers(),
  ...createServerPropertiesHandlers(),
  ...createBackupHandlers({ getModpackStateRepository: () => stateRepository }),
  ...createManagementServerHandlers(null),
  ...createServerModHandlers(null),
  ...createManualModHandlers(),
  ...createModAvailabilityHandlers({ startWatcher: false }),
  ...createServerHandlers(),
  'set-auto-restart': (_event, options) => setAutoRestartOptions(options),
  'minecraft-launch': async (_event, { clientPath }) => {
    launches.push(clientPath);
    return { success: true };
  },
  'update-mod': async (_event, { serverPath, fileName, newFileName }) => {
    const modsDir = path.join(serverPath, 'client', 'mods');
    markCurrentServerMutationDirty(serverPath);
    fs.writeFileSync(path.join(modsDir, newFileName), 'updated mod');
    fs.unlinkSync(path.join(modsDir, fileName));
    return { success: true };
  }
});
const invoke = (channel, ...args) => ipc[channel](EVENT, ...args);

test.after(async () => {
  for (const child of javaProcesses) child.finish(0, null);
  serverManager.clearIntervals();
  connectionCore.dispose();
  Module._load = originalLoad;
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJar(filePath, label = path.basename(filePath)) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const archive = new AdmZip();
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\n\r\n'));
  archive.addFile('fixture.txt', Buffer.from(label));
  archive.writeZip(filePath);
}

// .minecraft-core.json exactly as v26.6.1 writes it: no contentRevision and no
// modpack field. v26.6.1 never creates .minecraft-core-state.
function v26ServerConfig(overrides = {}) {
  return {
    version: '1.21.1',
    fabric: null,
    loader: 'vanilla',
    loaderVersion: null,
    port: 25565,
    maxRam: 4,
    managementPort: 8080,
    autoStartMinecraft: false,
    autoStartManagement: false,
    autoRestart: { enabled: false, delay: 10, maxCrashes: 3 },
    managementInviteHost: '',
    managementInviteSecret: '',
    backupAutomation: {
      enabled: false, frequency: 86400000, type: 'world', retentionCount: 100,
      runOnLaunch: false, hour: 3, minute: 0, day: 0, lastRun: null
    },
    ...overrides
  };
}

function makeServer(name, { parent = ROOT, config = {} } = {}) {
  const serverPath = path.join(parent, name);
  for (const folder of ['world', 'mods', path.join('client', 'mods')]) fs.mkdirSync(path.join(serverPath, folder), { recursive: true });
  writeJson(path.join(serverPath, '.minecraft-core.json'), v26ServerConfig(config));
  fs.writeFileSync(path.join(serverPath, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(serverPath, 'server.properties'),
    '#Minecraft server properties\nserver-port=25565\nlevel-name=world\nmotd=A Minecraft Server\n');
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), 'level');
  for (const list of ['whitelist', 'ops', 'banned-players', 'banned-ips']) writeJson(path.join(serverPath, `${list}.json`), []);
  writeJar(path.join(serverPath, 'server.jar'));
  return serverPath;
}

function register(instance) {
  appStore.set('instances', [...(appStore.get('instances') || []), instance]);
  return instance;
}

function registerServer(id, serverPath, name = id) {
  return register({ id, type: 'server', name, path: serverPath });
}

function registerClient(id, clientPath, name = id) {
  writeJson(path.join(clientPath, 'client-config.json'), {
    clientId: id, clientName: name, serverIp: '127.0.0.1', serverPort: '8080', lastUpdated: '2026-06-20T10:00:00.000Z'
  });
  return register({ id, type: 'client', name, path: clientPath, clientId: id, clientName: name, serverIp: '127.0.0.1', serverPort: '8080' });
}

function junction(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
  return link;
}

function code(expected) {
  return error => error?.code === expected;
}

// Nothing this window did spawned ArchiveWorker or built a native durable client
// whose roots reach the given folders (the strict writer and strict repository).
function watchStrictMachinery() {
  const spawnMark = spawned.length;
  const rootMark = strictClientRoots.length;
  return {
    assertUnused(folders) {
      assert.deepEqual(spawned.slice(spawnMark).filter(entry => isArchiveWorker(entry.command)), []);
      const keys = folders.map(folderKey);
      const reached = strictClientRoots.slice(rootMark)
        .filter(roots => roots.some(root => keys.some(key => folderKey(root) === key || key.startsWith(`${folderKey(root)}${path.sep}`))));
      assert.deepEqual(reached, []);
    }
  };
}

async function startServer(instance, port = 25565) {
  const before = javaProcesses.length;
  const result = await invoke('start-server', { instanceId: instance.id, targetPath: instance.path, port, maxRam: 4 });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(javaProcesses.length, before + 1, 'the start spawned Java once');
  assert.equal(serverManager.getServerState({ instanceId: instance.id }).status, 'running');
  return javaProcesses[javaProcesses.length - 1];
}

async function stopServer(instance) {
  const result = await invoke('stop-server', { instanceId: instance.id, targetPath: instance.path });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(serverManager.getServerState({ instanceId: instance.id }).isRunning, false);
}

const launchArguments = child => child.args.filter(argument => !argument.startsWith('-Dminecraft.core.server.'));

test('every NT-02 action on a running v26.6.1 server succeeds, persists and never needs ArchiveWorker', async () => {
  const serverPath = makeServer('Default Server');
  writeJar(path.join(serverPath, 'client', 'mods', 'sodium.jar'));
  writeJar(path.join(serverPath, 'client', 'mods', 'zoomify.jar'));
  writeJar(path.join(serverPath, 'client', 'mods', 'old-client.jar'));
  const server = registerServer('default-server', serverPath, 'Default Server');
  const configPath = path.join(serverPath, '.minecraft-core.json');
  const strict = watchStrictMachinery();
  const java = await startServer(server);

  const payload = { instanceId: server.id, serverPath };
  // Players: add and remove on the whitelist, ops and bans; an IP ban from the context menu.
  for (const [list, kept, removed] of [['whitelist', 'Notch', 'Dinnerbone'], ['ops', 'jeb_', 'Grumm'], ['banned-players', 'Griefer', 'Spammer']]) {
    await invoke('add-player', list, serverPath, kept);
    await invoke('add-player', list, serverPath, removed);
    await invoke('remove-player', list, serverPath, removed);
  }
  await invoke('add-player', 'banned-ips', serverPath, '203.0.113.7 (Player: Griefer)');
  // Auto-restart, both auto-start boxes and the management port.
  assert.equal((await invoke('set-auto-restart', { enabled: true, delay: 15, maxCrashes: 3, targetPath: serverPath })).enabled, true);
  assert.equal((await invoke('update-settings', { ...payload, autoStartMinecraft: true, autoStartManagement: true })).success, true);
  assert.equal((await invoke('update-settings', { ...payload, managementPort: 8081 })).success, true);
  // Management: start it, change the invite host and regenerate the secret.
  assert.deepEqual(await invoke('start-management-server', { ...payload, port: 8081 }), { success: true, port: 8081 });
  assert.equal((await invoke('set-management-invite-host', { ...payload, host: 'play.example.test' })).success, true);
  const regenerated = await invoke('regenerate-management-invite-secret', payload);
  assert.equal(regenerated.success, true);
  // server.properties (the renderer then shows the restart-to-apply banner).
  assert.deepEqual(await invoke('write-server-properties', {
    serverPath, properties: { 'server-port': '25565', 'level-name': 'world', motd: 'Parity while running' }
  }), { success: true });
  // Backups: a manual backup is ancillary; rename, delete, automation and retention.
  const created = await invoke('backups:create', { serverPath, type: 'world', trigger: 'manual' });
  assert.equal(created.success, true, created.error);
  assert.equal((await invoke('backups:rename', { serverPath, oldName: created.name, newName: 'before-update.zip' })).success, true);
  assert.equal((await invoke('backups:delete', { serverPath, name: 'before-update.zip' })).success, true);
  assert.equal((await invoke('backups:configure-automation', {
    enabled: false, frequency: 86400000, type: 'full', retentionCount: 14, runOnLaunch: false, serverPath, hour: 4, minute: 30, day: 0
  })).success, true);
  assert.equal((await invoke('backups:save-retention-settings', {
    serverPath, settings: { countRetentionEnabled: true, maxCountValue: 14, ageRetentionEnabled: true, maxAgeValue: 30, maxAgeUnit: 'days' }
  })).success, true);
  // Client-only mods: update, disable and delete; a mod watch added and removed.
  assert.equal((await invoke('update-mod', { serverPath, fileName: 'sodium.jar', newFileName: 'sodium-2.jar' })).success, true);
  await invoke('save-disabled-mods', serverPath, ['zoomify.jar']);
  await invoke('delete-mod', serverPath, 'old-client.jar');
  const watch = { serverPath, projectId: 'lithium', modName: 'Lithium', targetMc: '1.21.2', targetLoader: 'fabric', targetLoaderVersion: '0.16.0' };
  assert.equal((await invoke('mod-watch:add', watch)).length, 1);
  await invoke('mod-watch:add', { ...watch, projectId: 'sodium', modName: 'Sodium' });
  assert.deepEqual((await invoke('mod-watch:remove', { ...watch, projectId: 'sodium' })).map(entry => entry.projectId), ['lithium']);
  // Rename the server.
  assert.equal((await invoke('rename-instance', { id: server.id, newName: 'Survival' })).success, true);

  assert.equal(serverManager.getServerState({ instanceId: server.id }).status, 'running');
  assert.equal(java.exitCode, null, 'the running server was never stopped');
  strict.assertUnused([serverPath]);
  assert.ok(readContentRevision(serverPath) > 0, 'ordinary writes still advance the change counter');
  assert.equal(inspectFolderEvidence(serverPath).state, 'unmanaged', 'no modpack evidence was created');

  await stopServer(server);
  // "Restart the app": everything persisted on disk and in the store.
  const config = readJson(configPath);
  assert.deepEqual(config.autoRestart, { enabled: true, delay: 15, maxCrashes: 3 });
  assert.equal(config.autoStartMinecraft, true);
  assert.equal(config.autoStartManagement, true);
  assert.equal(config.managementPort, 8081);
  assert.equal(config.managementInviteHost, 'play.example.test');
  assert.equal(config.managementInviteSecret, regenerated.secret);
  assert.equal(config.backupAutomation.retentionCount, 14);
  assert.equal(config.backupAutomation.type, 'full');
  const retention = appStore.get(`retentionSettings_${Buffer.from(serverPath).toString('base64')}`);
  assert.deepEqual([retention.countRetentionEnabled, retention.maxCountValue, retention.maxAgeValue], [true, 14, 30]);
  assert.deepEqual(readJson(path.join(serverPath, 'whitelist.json')).map(entry => entry.name), ['Notch']);
  assert.deepEqual(readJson(path.join(serverPath, 'ops.json')).map(entry => entry.name), ['jeb_']);
  assert.deepEqual(readJson(path.join(serverPath, 'banned-players.json')).map(entry => entry.name), ['Griefer']);
  assert.deepEqual(readJson(path.join(serverPath, 'banned-ips.json')).map(entry => entry.ip), ['203.0.113.7']);
  assert.match(fs.readFileSync(path.join(serverPath, 'server.properties'), 'utf8'), /^motd=Parity while running$/mu);
  assert.deepEqual(fs.readdirSync(path.join(serverPath, 'backups')).filter(name => name.endsWith('.zip')), []);
  assert.deepEqual(fs.readdirSync(path.join(serverPath, 'client', 'mods')).sort(), ['sodium-2.jar', 'zoomify.jar.disabled']);
  assert.deepEqual(readJson(path.join(serverPath, 'minecraft-core-configs', 'mod-availability-watches.json')).watches
    .map(entry => entry.projectId), ['lithium']);
  assert.equal(appStore.get('instances').find(instance => instance.id === server.id).name, 'Survival');

  // The next start is admitted: nothing the writes did quarantined the folder.
  await startServer(server);
  await stopServer(server);
  strict.assertUnused([serverPath]);
});

function listenOnLoopback(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(port, '127.0.0.1', () => resolve(socket));
  });
}

function closeSocket(socket) {
  return new Promise(resolve => (socket.listening ? socket.close(() => resolve()) : resolve()));
}

// Distinct loopback ports, each held by a real listening socket (the validator
// probes 127.0.0.1) until released. A port below the management minimum of
// 1025, or one a registered server already saves, is skipped.
async function holdLoopbackPorts(count) {
  const saved = new Set((appStore.get('instances') || []).filter(instance => instance?.type === 'server')
    .flatMap(instance => {
      const config = readServerConfig(instance.path) || {};
      return [config.port, config.managementPort];
    }));
  const held = [];
  const skipped = [];
  while (held.length < count) {
    const socket = await listenOnLoopback(0);
    const { port } = socket.address();
    if (port < 1025 || saved.has(port)) skipped.push(socket);
    else held.push({ port, release: () => closeSocket(socket) });
  }
  await Promise.all(skipped.map(closeSocket));
  return held;
}

test('NT-02 settings saves on a running server pass the real port check beside its own ports', async () => {
  // FakeJava and the management stub listen on nothing, so real sockets stand in
  // for the running server's Java process and, once started, its management server.
  const [javaw, firstManagement, management, taken] = await holdLoopbackPorts(4);
  await firstManagement.release();
  await management.release();
  let managementListener = null;
  try {
    const serverPath = makeServer('Ports Server', {
      config: { port: javaw.port, managementPort: firstManagement.port, autoStartMinecraft: true, autoStartManagement: true }
    });
    const server = registerServer('ports-server', serverPath, 'Ports Server');
    const strict = watchStrictMachinery();
    const java = await startServer(server, javaw.port);

    // ServerControls.updateSettings sends every field the Dashboard shows.
    const shown = { port: javaw.port, maxRam: 4, managementPort: firstManagement.port, autoStartMinecraft: true, autoStartManagement: true };
    const dashboardSave = values => invoke('update-settings', { instanceId: server.id, serverPath, ...values });
    livePortValidator = realPortValidator;
    try {
      // Untick "Auto-start server" while Java holds the saved Minecraft port.
      shown.autoStartMinecraft = false;
      const unticked = await dashboardSave(shown);
      assert.equal(unticked.success, true, JSON.stringify(unticked));
      // A management port another process holds is refused, naming that port alone.
      const refused = await dashboardSave({ ...shown, managementPort: taken.port });
      const expected = await realPortValidator.validateServerPorts({ instanceId: server.id, serverPath, managementPort: taken.port });
      assert.deepEqual(expected.errors.map(error => [error.type, error.scope, error.port]), [['management', 'external', taken.port]]);
      assert.deepEqual(refused, { success: false, error: expected.errors[0].message, details: expected.errors });
      // A free management port is saved and the management server starts there;
      // its "Auto-start" box is then unticked while both saved ports are held.
      shown.managementPort = management.port;
      const moved = await dashboardSave(shown);
      assert.equal(moved.success, true, JSON.stringify(moved));
      assert.deepEqual(await invoke('start-management-server', { instanceId: server.id, serverPath, port: management.port }),
        { success: true, port: management.port });
      managementListener = await listenOnLoopback(management.port);
      shown.autoStartManagement = false;
      const managementUnticked = await dashboardSave(shown);
      assert.equal(managementUnticked.success, true, JSON.stringify(managementUnticked));
    } finally {
      livePortValidator = null;
    }

    assert.equal(java.exitCode, null, 'the running server was never stopped');
    await stopServer(server);
    const config = readJson(path.join(serverPath, '.minecraft-core.json'));
    assert.deepEqual([config.port, config.maxRam, config.managementPort, config.autoStartMinecraft, config.autoStartManagement],
      [javaw.port, 4, management.port, false, false]);
    strict.assertUnused([serverPath]);
  } finally {
    await Promise.all([javaw.release(), taken.release(), managementListener && closeSocket(managementListener)]);
  }
});

test('the stopped-only writers still need the server stopped, and run once it is', async () => {
  const serverPath = makeServer('Stopped Only');
  const server = registerServer('stopped-only-server', serverPath);
  const calls = [];
  const spy = channel => async () => {
    calls.push(channel);
    return { success: true };
  };
  const requests = [
    ['backups:restore', { serverPath, name: 'backup.zip' }],
    ['delete-world', serverPath],
    ['delete-instance', { id: server.id, deleteFiles: false }],
    ['download-minecraft-server', { targetPath: serverPath, mcVersion: '1.21.1' }],
    ['download-and-install-loader', { targetPath: serverPath, loader: 'fabric' }],
    ['download-and-install-fabric', { path: serverPath, mcVersion: '1.21.1' }],
    ['repair-health', { targetPath: serverPath }]
  ];
  const wrapped = Object.fromEntries(requests.map(([channel]) => [channel, policy.wrapHandler(channel, spy(channel))]));
  const strict = watchStrictMachinery();
  await startServer(server);
  for (const [channel, request] of requests) {
    await assert.rejects(wrapped[channel](EVENT, request), code('SERVER_RUNNING'), channel);
  }
  assert.deepEqual(calls, []);
  // Only that set waits for a stop: its neighbours still run beside the server.
  assert.deepEqual(await policy.wrapHandler('update-settings', spy('update-settings'))(EVENT, { serverPath, instanceId: server.id, maxRam: 5 }),
    { success: true });
  assert.deepEqual(await policy.wrapHandler('add-player', spy('add-player'))(EVENT, 'whitelist', serverPath, 'Alex'), { success: true });
  assert.deepEqual(calls.splice(0), ['update-settings', 'add-player']);
  await stopServer(server);
  strict.assertUnused([serverPath]);
  for (const [channel, request] of requests) {
    assert.deepEqual(await wrapped[channel](EVENT, request), { success: true }, channel);
  }
  assert.deepEqual(calls, requests.map(([channel]) => channel));
});

test('N4: restoring full backups keeps the change counter monotonic and the server usable', async () => {
  const serverPath = makeServer('Backup Server');
  const server = registerServer('backup-server', serverPath);
  const configPath = path.join(serverPath, '.minecraft-core.json');
  const payload = { instanceId: server.id, serverPath };
  const strict = watchStrictMachinery();

  // A full backup as v26.6.1 left it: its config has no contentRevision.
  const v26 = await invoke('backups:create', { serverPath, type: 'full', trigger: 'manual' });
  assert.equal(v26.success, true, v26.error);
  assert.equal((await invoke('backups:rename', { serverPath, oldName: v26.name, newName: 'v26-full.zip' })).success, true);
  assert.equal(new AdmZip(path.join(serverPath, 'backups', 'v26-full.zip')).readAsText('.minecraft-core.json').includes('contentRevision'), false);

  assert.equal((await invoke('update-settings', { ...payload, maxRam: 6 })).success, true);
  await startServer(server);
  await stopServer(server);
  assert.equal((await invoke('update-settings', { ...payload, maxRam: 7 })).success, true);
  const beforeV26Restore = readContentRevision(serverPath);
  assert.ok(beforeV26Restore >= 2);

  const restored = await invoke('backups:restore', { serverPath, name: 'v26-full.zip', serverStatus: 'stopped' });
  assert.equal(restored.success, true, restored.error);
  assert.equal(readJson(configPath).maxRam, 4, 'the backup content is restored');
  assert.equal(readContentRevision(serverPath), beforeV26Restore + 1, 'the restore continues from the pre-restore counter');

  await startServer(server);
  await stopServer(server);
  assert.equal((await invoke('update-settings', { ...payload, maxRam: 5 })).success, true);
  assert.equal(readJson(configPath).maxRam, 5);

  // A full backup made in this build after a settings change carries an older counter.
  const current = await invoke('backups:create', { serverPath, type: 'full', trigger: 'manual' });
  assert.equal(current.success, true, current.error);
  assert.equal((await invoke('backups:rename', { serverPath, oldName: current.name, newName: 'new-full.zip' })).success, true);
  assert.equal((await invoke('update-settings', { ...payload, maxRam: 8 })).success, true);
  assert.equal((await invoke('update-settings', { ...payload, port: 25566 })).success, true);
  const beforeNewRestore = readContentRevision(serverPath);
  const restoredAgain = await invoke('backups:restore', { serverPath, name: 'new-full.zip', serverStatus: 'stopped' });
  assert.equal(restoredAgain.success, true, restoredAgain.error);
  assert.equal(readJson(configPath).maxRam, 5);
  assert.equal(readContentRevision(serverPath), beforeNewRestore + 1);

  await startServer(server);
  await stopServer(server);
  assert.equal((await invoke('update-settings', { ...payload, maxRam: 3 })).success, true);
  assert.equal(readContentRevision(serverPath), beforeNewRestore + 2);
  strict.assertUnused([serverPath]);
});

test('the Backups tab of a registered server whose folder is missing lists nothing and deletes as in v26.6.1', async () => {
  // The server's external drive is unplugged (or its folder was deleted or moved).
  const drive = path.join(ROOT, 'unplugged-drive');
  const serverPath = makeServer('Unplugged Server', { parent: drive });
  registerServer('unplugged-server', serverPath, 'Unplugged Server');
  fs.rmSync(drive, { recursive: true, force: true });
  const strict = watchStrictMachinery();

  // What the tab asks when it opens or refreshes.
  assert.deepEqual(await invoke('backups:list', { serverPath }), []);
  const sizes = await invoke('backups:calculate-sizes', { serverPath });
  assert.deepEqual([sizes.success, sizes.backups, sizes.totalSize, sizes.backupCount], [true, [], 0, 0], sizes.error);
  assert.deepEqual(await invoke('backups:check-size-alerts', { serverPath, maxSizeBytes: 1024 }),
    { success: true, alerts: [], totalSize: 0, maxSize: 1024 });
  assert.deepEqual(await invoke('backups:preview-retention-policy', { serverPath, policy: { maxCount: 14 } }), {
    success: true,
    preview: { totalBackups: 0, backupsToDelete: [], backupsToKeep: [], spaceThatWouldBeSaved: 0, spaceToKeep: 0, hasActiveRules: true }
  });
  assert.equal((await invoke('backups:watch-size-changes', { serverPath })).success, true);
  // v26.6.1 checked the name first and otherwise found nothing to delete.
  assert.deepEqual(await invoke('backups:delete', { serverPath, name: 'backup-world-2026-06-20_10-00-00.zip' }), { success: true });
  assert.deepEqual(await invoke('backups:delete', { serverPath, name: '../outside.zip' }), { success: false, error: 'Invalid backup name' });
  assert.deepEqual(await invoke('backups:apply-retention-policy', { serverPath, policy: { maxCount: 14 } }), {
    success: true, message: 'No backups found', deletedBackups: [], failedDeletions: [], spaceSaved: 0, totalBackups: 0, backupsRemaining: 0
  });

  assert.equal(fs.existsSync(drive), false, 'nothing recreated the missing folder');
  strict.assertUnused([serverPath]);
});

test('a server reached through a junction deletes a mod and is then admitted to start', WINDOWS_ONLY, async () => {
  const realPath = makeServer('Junction Target', { parent: path.join(ROOT, 'real-servers') });
  const serverPath = junction(realPath, path.join(ROOT, 'linked-servers', 'Junction Server'));
  writeJar(path.join(serverPath, 'mods', 'addon.jar'));
  const server = registerServer('junction-server', serverPath);
  const strict = watchStrictMachinery();

  const deleted = await invoke('delete-mod', serverPath, 'addon.jar');
  assert.equal(deleted.success, true, JSON.stringify(deleted));
  assert.equal(fs.existsSync(path.join(realPath, 'mods', 'addon.jar')), false);
  assert.equal(readContentRevision(serverPath), 1, 'the change counter was recorded through the junction');

  const java = await startServer(server);
  assert.equal(java.cwd, serverPath);
  await stopServer(server);
  strict.assertUnused([serverPath, realPath]);
});

test('a client reached through a junction toggles a manual mod and stays launchable', WINDOWS_ONLY, async () => {
  const realPath = path.join(ROOT, 'real-clients', 'Friend Client');
  fs.mkdirSync(path.join(realPath, 'mods'), { recursive: true });
  const clientPath = junction(realPath, path.join(ROOT, 'linked-clients', 'Friend Client'));
  const client = registerClient('junction-client', clientPath, 'Friend Client');
  writeJar(path.join(clientPath, 'mods', 'manual.jar'));
  const scans = processScans.length;
  const strict = watchStrictMachinery();

  const disabled = await invoke('toggle-manual-mod', { clientPath, fileName: 'manual.jar', enable: false });
  assert.equal(disabled.success, true, disabled.error);
  assert.equal(fs.existsSync(path.join(realPath, 'mods', 'manual.jar.disabled')), true);
  assert.equal(readJson(path.join(realPath, 'client-config.json')).contentRevision, 1);

  assert.deepEqual(await invoke('minecraft-launch', { clientPath, clientId: client.id }), { success: true });
  assert.deepEqual(launches.slice(-1), [clientPath]);
  const reservation = await clientPackIntegration.beginManagedLaunch({ clientPath });
  await reservation.abortBeforeSpawn();

  const enabled = await invoke('toggle-manual-mod', { clientPath, fileName: 'manual.jar', enable: true });
  assert.equal(enabled.success, true, enabled.error);
  assert.equal(fs.existsSync(path.join(realPath, 'mods', 'manual.jar')), true);
  assert.equal(processScans.length, scans, 'a client without pack evidence is never process-scanned');
  strict.assertUnused([clientPath, realPath]);
});

// A published modpack server: its .minecraft-core-state layout and summary as
// lifecycle publication leaves them.
function writePublishedModpack(serverPath, installationId) {
  const durableFs = createDurableFs({
    fsApi: fs,
    allowedRoots: [path.dirname(serverPath)],
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {},
      moveWriteThroughAsync: fs.promises.rename,
      replaceFileWriteThroughAsync: fs.promises.rename,
      async flushDirectoryAsync() {}
    }
  });
  const repository = new ModpackStateRepository({ fsApi: fs, durableFs, clock: () => new Date('2026-10-30T09:00:00.000Z') });
  repository.writeCandidate(serverPath, {
    schemaVersion: 1,
    modpackManaged: true,
    source: { provider: 'local', version: '1.0.0', title: 'Parity Pack', importId: `import-${installationId}`, artifactSha256: 'a'.repeat(64) },
    runtime: { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64' },
    selectedOptionalFiles: [],
    installedAt: '2026-10-30T08:00:00.000Z',
    contentRevision: 1,
    manifest: {
      schemaVersion: 1,
      installationId,
      entries: [{
        path: 'mods/pack-mod.jar', pathKey: 'mods/pack-mod.jar', origin: 'pack', managementPolicy: 'replaceable-managed',
        role: 'mod', installedHash: '1'.repeat(64), size: '4', priorBaseline: null
      }]
    }
  });
  assert.equal(inspectFolderEvidence(serverPath).state, 'lifecycle');
}

test('R2: a deleted modpack server folder takes a fresh install-new in the same session', async () => {
  const serverPath = makeServer('Pack Server', { parent: path.join(ROOT, 'packs') });
  writeJar(path.join(serverPath, 'mods', 'pack-mod.jar'));
  writePublishedModpack(serverPath, 'install-r2-0001');
  const server = registerServer('pack-server', serverPath, 'Pack Server');

  // Any coordinated write binds the server's id to its folder (here a rename).
  assert.equal((await invoke('rename-instance', { id: server.id, newName: 'Old Pack' })).success, true);
  assert.deepEqual(coordinator.pathBinding(serverPath), { instanceId: server.id });
  const deleted = await invoke('delete-instance', { id: server.id, deleteFiles: true });
  assert.equal(deleted.success, true, deleted.error);
  assert.equal(fs.existsSync(serverPath), false);
  assert.equal(coordinator.pathBinding(serverPath), null, 'the deleted registration is forgotten');

  // The setup wizard reserves the folder again (empty) under a fresh id, and the
  // install acquires its mutation exactly as the lifecycle service does.
  fs.mkdirSync(serverPath);
  const freshId = `server-${crypto.randomUUID()}`;
  const reached = await coordinator.runMutation({ instanceId: freshId, serverPath }, {
    operation: 'install-new',
    operationId: `op2-${crypto.randomUUID().replaceAll('-', '')}`,
    revisionMode: 'none',
    quiesce: async () => {}
  }, async lease => lease.instanceId);
  assert.equal(reached, freshId);
});

test('N5: the browser panel writes through the shared policy and its modpack checks', async () => {
  browserPanel.configureBrowserPanelMutationPolicy(policy);
  const panel = browserPanel.getBrowserPanel();
  assert.equal(panel.serverMutationPolicy, policy);

  const managedPath = makeServer('Panel Pack', { parent: path.join(ROOT, 'panel') });
  writeJar(path.join(managedPath, 'mods', 'pack-mod.jar'));
  writePublishedModpack(managedPath, 'install-n5-0001');
  registerServer('panel-pack', managedPath);
  await assert.rejects(panel.browserWriterHandlers.serverMods['delete-mod'](BROWSER, managedPath, 'pack-mod.jar'),
    code('MANAGED_MOD_EDIT_BLOCKED'));
  assert.equal(fs.existsSync(path.join(managedPath, 'mods', 'pack-mod.jar')), true);

  const plainPath = makeServer('Panel Plain', { parent: path.join(ROOT, 'panel') });
  writeJar(path.join(plainPath, 'mods', 'addon.jar'));
  const plain = registerServer('panel-plain', plainPath);
  await startServer(plain);
  try {
    assert.equal((await panel.browserWriterHandlers.serverMods['delete-mod'](BROWSER, plainPath, 'addon.jar')).success, true);
    assert.equal(fs.existsSync(path.join(plainPath, 'mods', 'addon.jar')), false);
    assert.deepEqual(await panel.browserWriterHandlers.management['start-management-server'](BROWSER, { port: 8090, serverPath: plainPath }),
      { success: true, port: 8090 });
  } finally {
    await stopServer(plain);
  }
});

test('a modpack-managed server still writes its config through the dev ArchiveWorker', WINDOWS_ONLY, async () => {
  // The control for every ArchiveWorker assertion in this suite: the same writer
  // on a folder with lifecycle evidence keeps the strict path to the native worker.
  const managedPath = makeServer('Managed Settings', { parent: path.join(ROOT, 'managed') });
  writePublishedModpack(managedPath, 'install-control-0001');
  const managed = registerServer('managed-settings', managedPath);
  const mark = spawned.length;

  const outcome = await invoke('update-settings', { serverPath: managedPath, instanceId: managed.id, maxRam: 6 })
    .catch(error => error);
  const workerSpawns = spawned.slice(mark).filter(entry => isArchiveWorker(entry.command));
  assert.ok(workerSpawns.length > 0, `the strict writer must reach ArchiveWorker, got ${outcome?.code || JSON.stringify(outcome)}`);
  assert.equal(path.resolve(workerSpawns[0].command), path.join(REPO_ROOT, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe'));
  assert.notEqual(readJson(path.join(managedPath, '.minecraft-core.json')).maxRam, 6, 'the refused worker let nothing through');
});

const V26_FORGE_ARGS = path.join('libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.2.0', 'win_args.txt');

test('a v26.6.1 Forge 1.20.1 server without .minecraft-core-state starts with the v26.6.1 arguments', async () => {
  const serverPath = makeServer('Forge Server', { config: { version: '1.20.1', loader: 'forge', loaderVersion: '47.2.0' } });
  fs.writeFileSync(path.join(serverPath, 'user_jvm_args.txt'), '# Xmx and Xms set the maximum and minimum RAM usage.\n');
  fs.mkdirSync(path.join(serverPath, path.dirname(V26_FORGE_ARGS)), { recursive: true });
  fs.writeFileSync(path.join(serverPath, V26_FORGE_ARGS), '-DlibraryDirectory=libraries\n--launchTarget forgeserver\n--fml.forgeVersion 47.2.0\n--fml.mcVersion 1.20.1\n');
  fs.writeFileSync(path.join(serverPath, 'run.bat'), `java @user_jvm_args.txt @${V26_FORGE_ARGS.replaceAll('\\', '/')} %*\r\n`);
  const server = registerServer('forge-server', serverPath, 'Forge Server');
  const strict = watchStrictMachinery();

  const java = await startServer(server);
  // v26.6.1 resolveForgeLaunchPlan: the user JVM file, -Xmx, -Xms1G, the args file, nogui.
  assert.deepEqual(launchArguments(java), ['@user_jvm_args.txt', '-Xmx4G', '-Xms1G', `@${V26_FORGE_ARGS}`, 'nogui']);
  assert.equal(java.cwd, serverPath);
  await stopServer(server);
  assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state')), false);
  strict.assertUnused([serverPath]);
});

test('v26.6.1 servers labelled quilt or neoforge start the plain server jar v26.6.1 started', async () => {
  for (const [loader, version, loaderVersion] of [['quilt', '1.20.1', null], ['neoforge', '1.21.1', '21.1.77']]) {
    const serverPath = makeServer(`Labelled ${loader}`, { config: { version, loader, loaderVersion } });
    if (loader === 'quilt') writeJar(path.join(serverPath, 'quilt-server-launch.jar'));
    else writeJar(path.join(serverPath, `neoforge-${loaderVersion}-installer.jar`));
    const server = registerServer(`labelled-${loader}`, serverPath);
    const strict = watchStrictMachinery();

    const java = await startServer(server);
    const jar = path.join(serverPath, 'server.jar');
    assert.deepEqual(launchArguments(java), ['-Xmx4G', '-Xms1G', '-jar', jar, 'nogui'], loader);
    // v26.6.1 ran the same jar; only -Xms1G is new for every plain-jar launch.
    assert.deepEqual(launchArguments(java).filter(argument => argument !== '-Xms1G'), ['-Xmx4G', '-jar', jar, 'nogui'], loader);
    await stopServer(server);
    assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state')), false, loader);
    strict.assertUnused([serverPath]);
  }
});

test('a server directly under a drive root keeps full mod management', async () => {
  // A stand-in for E:\: the native durable client refuses it as an allowed root,
  // exactly as it refuses a real drive root.
  const driveRoot = path.join(ROOT, 'drive-e');
  fs.mkdirSync(driveRoot);
  simulatedDriveRoots.add(folderKey(driveRoot));
  const serverPath = makeServer('Root Server', { parent: driveRoot });
  writeJar(path.join(serverPath, 'mods', 'lithium.jar'));
  writeJar(path.join(serverPath, 'mods', 'old.jar'));
  const source = path.join(ROOT, 'downloads', 'fabric-api.jar');
  writeJar(source);
  const server = registerServer('root-server', serverPath, 'Root Server');

  // The strict repository cannot serve this folder, as on a real drive-root child;
  // the observer answers without it, so the Mods tab knows the server is unmanaged.
  assert.throws(() => stateRepository.read(serverPath), code('RECOVERY_REQUIRED'));
  assert.equal(stateObserver.read(serverPath), null);

  const strict = watchStrictMachinery();
  await invoke('save-disabled-mods', serverPath, ['lithium.jar']);
  assert.equal((await invoke('delete-mod', serverPath, 'old.jar')).success, true);
  assert.equal((await invoke('add-mod', serverPath, source)).success, true);
  assert.equal((await invoke('mod-watch:add', {
    serverPath, projectId: 'sodium', modName: 'Sodium', targetMc: '1.21.2', targetLoader: 'fabric', targetLoaderVersion: '0.16.0'
  })).length, 1);
  assert.equal(fs.existsSync(path.join(serverPath, 'mods', 'lithium.jar.disabled')), true);
  assert.equal(fs.existsSync(path.join(serverPath, 'mods', 'old.jar')), false);
  assert.ok(readContentRevision(serverPath) >= 3);
  await startServer(server);
  await stopServer(server);
  strict.assertUnused([serverPath, driveRoot]);
});

test('client rename and delete work as in v26.6.1 without reading the host', async () => {
  const folder = name => {
    const clientPath = path.join(ROOT, 'clients', name);
    fs.mkdirSync(path.join(clientPath, 'mods'), { recursive: true });
    return clientPath;
  };
  const renamed = registerClient('client-rename', folder('Rename Me'));
  const kept = registerClient('client-keep', folder('Keep Files'));
  const removed = registerClient('client-files', folder('Delete Files'));
  const gone = registerClient('client-gone', folder('Already Gone'));
  const reads = hostReads.length;

  assert.equal((await invoke('rename-instance', { id: renamed.id, newName: 'Renamed Client' })).success, true);
  assert.equal(readJson(path.join(renamed.path, 'client-config.json')).clientName, 'Renamed Client');
  assert.equal((await invoke('delete-instance', { id: kept.id, deleteFiles: false })).success, true);
  assert.equal(fs.existsSync(kept.path), true);
  assert.equal((await invoke('delete-instance', { id: removed.id, deleteFiles: true })).success, true);
  assert.equal(fs.existsSync(removed.path), false);
  fs.rmSync(gone.path, { recursive: true, force: true });
  assert.equal((await invoke('delete-instance', { id: gone.id, deleteFiles: false })).success, true);

  const remaining = appStore.get('instances').filter(instance => instance.type === 'client' && instance.id.startsWith('client-'));
  assert.deepEqual(remaining.map(instance => [instance.id, instance.name]), [['client-rename', 'Renamed Client']]);
  assert.equal(hostReads.length, reads, 'registry edits never contact the host (it may be offline)');
});

// Every file below a folder, with a digest of its bytes.
function folderFiles(folder) {
  return Object.fromEntries(fs.readdirSync(folder, { recursive: true }).sort()
    .filter(relative => fs.statSync(path.join(folder, relative)).isFile())
    .map(relative => [relative, crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, relative))).digest('hex')]));
}

test('a client in a running server\'s own folder is deleted keeping its files; deleting its files waits for the stop', async () => {
  const serverPath = makeServer('Server With Client');
  const server = registerServer('server-with-client', serverPath, 'Server With Client');
  const friend = registerClient('friend-in-server', serverPath, 'Friend');
  const strict = watchStrictMachinery();
  const java = await startServer(server);
  try {
    const files = folderFiles(serverPath);
    // Owner decision Q7: deleting the client's files would delete the running server's folder.
    await assert.rejects(invoke('delete-instance', { id: friend.id, deleteFiles: true }), code('SERVER_RUNNING'));
    assert.deepEqual(folderFiles(serverPath), files);
    // Keeping the files only edits the registry, which v26.6.1 allowed while the server ran.
    const kept = await invoke('delete-instance', { id: friend.id, deleteFiles: false });
    assert.equal(kept.success, true, kept.error);
    assert.deepEqual(folderFiles(serverPath), files, 'no file was deleted or changed');
    assert.deepEqual(appStore.get('instances').filter(instance => instance.path === serverPath).map(instance => instance.id), [server.id]);
    assert.equal(java.exitCode, null, 'the running server was never stopped');
    assert.equal(serverManager.getServerState({ instanceId: server.id }).status, 'running');
    assert.equal((await invoke('update-settings', { serverPath, instanceId: server.id, maxRam: 5 })).success, true);
  } finally {
    await stopServer(server);
  }
  assert.deepEqual(coordinator.pathBinding(serverPath), { instanceId: server.id });
  await startServer(server);
  await stopServer(server);
  strict.assertUnused([serverPath]);
});

test('two copies of one client folder (one client ID) are renamed and deleted as in v26.6.1', async () => {
  // A copied client folder brings its client-config.json, and so its client ID, along.
  const copies = (name, id) => [name, `${name} - Copy`].map(folder => {
    const clientPath = path.join(ROOT, 'copied-clients', folder);
    writeJar(path.join(clientPath, 'mods', 'own.jar'), folder);
    return registerClient(id, clientPath, name);
  });
  const clientName = clientPath => readJson(path.join(clientPath, 'client-config.json')).clientName;
  const registrations = id => appStore.get('instances').filter(instance => instance.id === id)
    .map(instance => [instance.path, instance.name]);
  const [original, copy] = copies('Friend Client', 'copied-friend');
  const [first, second] = copies('Keep Client', 'copied-keep');
  const reads = hostReads.length;
  const strict = watchStrictMachinery();

  // v26.6.1 renames the first registration with that ID, in its own folder.
  const renamed = await invoke('rename-instance', { id: copy.id, newName: 'Friend Original' });
  assert.equal(renamed.success, true, renamed.error);
  assert.deepEqual(registrations(copy.id), [[original.path, 'Friend Original'], [copy.path, 'Friend Client']]);
  assert.deepEqual([clientName(original.path), clientName(copy.path)], ['Friend Original', 'Friend Client']);
  // Dragged above the original in the sidebar, the copy is the one renamed.
  const listed = appStore.get('instances');
  const isCopy = instance => instance.id === copy.id && instance.path === copy.path;
  assert.equal((await invoke('save-instances', [...listed.filter(isCopy), ...listed.filter(instance => !isCopy(instance))])).success, true);
  const renamedCopy = await invoke('rename-instance', { id: copy.id, newName: 'Friend Copy' });
  assert.equal(renamedCopy.success, true, renamedCopy.error);
  assert.deepEqual(registrations(copy.id), [[copy.path, 'Friend Copy'], [original.path, 'Friend Original']]);
  assert.deepEqual([clientName(original.path), clientName(copy.path)], ['Friend Original', 'Friend Copy']);

  // A delete removes every registration with that ID; with files, only the first one's folder.
  const deleted = await invoke('delete-instance', { id: copy.id, deleteFiles: true });
  assert.equal(deleted.success, true, deleted.error);
  assert.equal(fs.existsSync(copy.path), false);
  assert.equal(fs.existsSync(path.join(original.path, 'mods', 'own.jar')), true);
  assert.deepEqual(registrations(copy.id), []);
  const kept = await invoke('delete-instance', { id: second.id, deleteFiles: false });
  assert.equal(kept.success, true, kept.error);
  assert.deepEqual([first.path, second.path].map(clientPath => fs.existsSync(path.join(clientPath, 'mods', 'own.jar'))), [true, true]);
  assert.deepEqual(registrations(second.id), []);

  assert.equal(hostReads.length, reads, 'registry edits never contact the host');
  strict.assertUnused([original.path, copy.path, first.path, second.path]);
});

test('adding and reordering instances while a server runs persists and leaves its config untouched', async () => {
  const runningPath = makeServer('Running Server');
  const running = registerServer('running-server', runningPath, 'Running Server');
  const strict = watchStrictMachinery();
  await startServer(running);
  const runningConfig = fs.readFileSync(path.join(runningPath, '.minecraft-core.json'));
  let addedPath = null;
  try {
    // The custom-server flow: settings for the new folder, then the registry save.
    addedPath = makeServer('Custom Server');
    assert.equal((await invoke('update-settings', { serverPath: addedPath, port: 25570, maxRam: 3, managementPort: 8085 })).success, true);
    const added = { id: 'custom-server', type: 'server', name: 'Custom Server', path: addedPath };
    const withAdded = [...appStore.get('instances'), added];
    assert.equal((await invoke('save-instances', withAdded)).success, true);
    // Drag-reorder the sidebar: the new server first, the running one last.
    const reordered = [added, ...withAdded.filter(instance => instance.id !== added.id && instance.id !== running.id),
      withAdded.find(instance => instance.id === running.id)];
    assert.equal((await invoke('save-instances', reordered)).success, true);

    const saved = appStore.get('instances');
    assert.equal(saved[0].id, added.id);
    assert.equal(saved.at(-1).id, running.id);
    assert.equal(readJson(path.join(addedPath, '.minecraft-core.json')).port, 25570);
    assert.deepEqual(fs.readFileSync(path.join(runningPath, '.minecraft-core.json')), runningConfig);
    assert.equal(serverManager.getServerState({ instanceId: running.id }).status, 'running');
  } finally {
    await stopServer(running);
  }
  strict.assertUnused([runningPath, addedPath]);
});

test('auto-start runs the renderer start sequence for a v26.6.1 profile', async () => {
  const serverPath = makeServer('Auto Start', { config: { autoStartMinecraft: true, autoStartManagement: true, managementPort: 8095 } });
  const server = registerServer('auto-start-server', serverPath, 'Auto Start');
  const starts = managementStarts.length;
  const strict = watchStrictMachinery();

  // App.svelte autoStartInstancesIfNeeded, for this server.
  const { settings } = await invoke('get-settings', { instanceId: server.id, serverPath });
  assert.equal(settings.autoStartManagement, true);
  assert.equal(settings.autoStartMinecraft, true);
  assert.equal((await invoke('start-management-server', { instanceId: server.id, serverPath, port: settings.managementPort })).success, true);
  const before = javaProcesses.length;
  const started = await invoke('start-server', {
    instanceId: server.id, targetPath: serverPath, port: settings.port, maxRam: settings.maxRam, managementPort: settings.managementPort
  });
  assert.equal(started.success, true, JSON.stringify(started));
  assert.equal(javaProcesses.length, before + 1);
  assert.deepEqual(managementStarts.slice(starts), [{ port: 8095, serverPath }]);
  await stopServer(server);
  strict.assertUnused([serverPath]);
});
