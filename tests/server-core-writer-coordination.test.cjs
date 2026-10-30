const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createServerMutationPolicy
} = require('../electron/services/server-mutation-policy.cjs');
const {
  ServerMutationCoordinator
} = require('../electron/services/server-mutation-coordinator.cjs');
const serverMutationContext = require('../electron/services/server-mutation-context.cjs');
const { createClientPackIntegration } = require('../electron/services/client-modpacks/client-pack-integration.cjs');
const { CLIENT_PACK_MANIFEST } = require('../electron/services/modpacks/instance-ownership.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { createInstanceConfigFsFactory } = require('../electron/utils/instance-config-fs.cjs');

const { markCurrentServerMutationDirty } = serverMutationContext;
const EVENT = { sender: { id: 1 } };
const NESTED_MESSAGE = 'This server folder and a client folder are inside each other, and that client uses a matching modpack. Move the client or the server into its own separate folder.';

function createCoordinator() {
  const revisions = new Map();
  const normalized = value => path.resolve(value).toLocaleLowerCase('en-US');
  const coordinator = new ServerMutationCoordinator({
    readContentRevision(serverPath) {
      return revisions.get(normalized(serverPath)) || 0;
    },
    bumpContentRevision(serverPath, { expectedRevision }) {
      const key = normalized(serverPath);
      assert.equal(revisions.get(key) || 0, expectedRevision);
      revisions.set(key, expectedRevision + 1);
      return expectedRevision + 1;
    }
  });
  coordinator.completeStartupRecovery([]);
  return { coordinator, revisions };
}

function createPolicy(coordinator, serverPath) {
  let sequence = 0;
  return createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'server-alpha', type: 'server', path: serverPath }],
    createOperationId: () => `core-writer-${++sequence}`
  });
}

function code(expected) {
  return error => error && error.code === expected;
}

test('a restore cannot write while the server run lease exists', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-13-running');
  const { coordinator } = createCoordinator();
  const policy = createPolicy(coordinator, serverPath);
  const handlers = policy.wrapHandlers({
    'backups:restore': async () => ({ success: true })
  });
  const runLease = await coordinator.acquireStart(
    { instanceId: 'server-alpha', serverPath },
    { operation: 'server-start', operationId: 'task-13-running', parentMutationLease: null }
  );
  runLease.markRunning({ pid: 101 });

  try {
    await assert.rejects(
      handlers['backups:restore'](
        { sender: { id: 1 } },
        { serverPath, name: 'before-update.zip', serverStatus: 'stopped' }
      ),
      code('SERVER_RUNNING')
    );
  } finally {
    runLease.release();
  }
});

test('path and instance aliases share one folder: the same config lane queues, other writers run', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-13-alias');
  const { coordinator, revisions } = createCoordinator();
  const policy = createPolicy(coordinator, serverPath);
  let releaseFirst;
  const firstSettled = new Promise(resolve => { releaseFirst = resolve; });
  const order = [];
  const handlers = policy.wrapHandlers({
    'write-config': async () => {
      order.push('write-config:start');
      await firstSettled;
      order.push('write-config:end');
      return { success: true };
    },
    'update-settings': async () => {
      order.push('update-settings');
      return { success: true };
    },
    'add-player': async () => {
      order.push('add-player');
      return [];
    }
  });

  const first = handlers['write-config'](
    { sender: { id: 1 } },
    { serverPath, config: { version: '1.21.1' } }
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['write-config:start']);

  // The instance alias reaches the same folder: its config write waits in line.
  const second = handlers['update-settings'](
    { sender: { id: 2 } },
    { instanceId: 'server-alpha', port: 25566 }
  );
  // A writer of another file on that folder runs beside them, as in v26.6.1.
  assert.deepEqual(await handlers['add-player']({ sender: { id: 3 } }, 'whitelist', serverPath, 'Alex'), []);
  assert.deepEqual(order, ['write-config:start', 'add-player']);

  releaseFirst();
  assert.deepEqual(await first, { success: true });
  assert.deepEqual(await second, { success: true });
  assert.deepEqual(order, ['write-config:start', 'add-player', 'write-config:end', 'update-settings']);
  assert.equal(revisions.get(path.resolve(serverPath).toLocaleLowerCase('en-US')), 2);
});

test('successful dirty writes increment once while failed validation does not increment', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-13-revision');
  const { coordinator, revisions } = createCoordinator();
  const policy = createPolicy(coordinator, serverPath);
  const handlers = policy.wrapHandlers({
    'write-config': async (_event, request) => request.config.valid
      ? { success: true }
      : { success: false, error: 'invalid config' }
  });

  await handlers['write-config'](
    { sender: { id: 1 } },
    { serverPath, config: { valid: true } }
  );
  assert.equal(revisions.get(path.resolve(serverPath).toLocaleLowerCase('en-US')), 1);

  await handlers['write-config'](
    { sender: { id: 1 } },
    { serverPath, config: { valid: false } }
  );
  assert.equal(revisions.get(path.resolve(serverPath).toLocaleLowerCase('en-US')), 1);
});

test('instance-list persistence reserves and marks only the registrations it adds or removes', async () => {
  const alphaPath = path.join(os.tmpdir(), 'minecraft-core-task-13-many-alpha');
  const betaPath = path.join(os.tmpdir(), 'minecraft-core-task-13-many-beta');
  const gammaPath = path.join(os.tmpdir(), 'minecraft-core-task-13-many-gamma');
  const { coordinator, revisions } = createCoordinator();
  const alpha = { id: 'server-alpha', type: 'server', path: alphaPath };
  const beta = { id: 'server-beta', type: 'server', path: betaPath };
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [alpha, beta],
    createOperationId: () => 'core-writer-many'
  });
  const reserved = [];
  const handlers = policy.wrapHandlers({
    'save-instances': async () => {
      for (const candidate of [alphaPath, betaPath, gammaPath]) {
        try {
          markCurrentServerMutationDirty(candidate);
          reserved.push(candidate);
        } catch (error) {
          assert.equal(error.code, 'INVALID_REQUEST');
        }
      }
      return { success: true };
    }
  });

  // Registered servers re-listed unchanged are neither reserved nor marked.
  await handlers['save-instances']({ sender: { id: 1 } }, [beta, alpha, { id: 'server-gamma', type: 'server', path: gammaPath }]);

  assert.deepEqual(reserved, [gammaPath]);
  assert.equal(revisions.get(path.resolve(alphaPath).toLocaleLowerCase('en-US')) || 0, 0);
  assert.equal(revisions.get(path.resolve(betaPath).toLocaleLowerCase('en-US')) || 0, 0);
  assert.equal(revisions.get(path.resolve(gammaPath).toLocaleLowerCase('en-US')), 1);
});

test('read-only handlers stay outside the mutation reservation', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-13-read');
  const { coordinator } = createCoordinator();
  const policy = createPolicy(coordinator, serverPath);
  const runLease = await coordinator.acquireStart(
    { instanceId: 'server-alpha', serverPath },
    { operation: 'server-start', operationId: 'task-13-read', parentMutationLease: null }
  );
  runLease.markRunning({ pid: 102 });
  const handlers = policy.wrapHandlers({
    'read-config': async () => ({ version: '1.21.1' }),
    'get-management-invite-info': async () => ({ success: true, configured: false, inviteLink: '' }),
    'update-management-server-path': async () => ({ success: true, changed: false })
  });

  try {
    assert.deepEqual(await handlers['read-config']({ sender: { id: 1 } }, serverPath), {
      version: '1.21.1'
    });
    assert.deepEqual(await handlers['get-management-invite-info']({ sender: { id: 1 } }, {
      instanceId: 'server-alpha',
      serverPath
    }), {
      success: true,
      configured: false,
      inviteLink: ''
    });
    assert.deepEqual(await handlers['update-management-server-path']({ sender: { id: 1 } }, {
      instanceId: 'server-alpha',
      serverPath
    }), {
      success: true,
      changed: false
    });
  } finally {
    runLease.release();
  }
});

test('read-config never rewrites a legacy configuration during hydration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-task-13-read-config-'));
  const configPath = path.join(root, '.minecraft-core.json');
  const original = '{\n  "version": "1.20.1"\n}\n';
  fs.writeFileSync(configPath, original);
  const originalLoad = Module._load;
  Module._load = function loadWithSilentLogger(request, parent, isMain) {
    if (typeof request === 'string' && request.endsWith('logger-handlers.cjs')) {
      const logger = {
        debug() {},
        error() {},
        info() {},
        warn() {}
      };
      return { getLoggerHandlers: () => logger };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = require.resolve('../electron/ipc/config-handlers.cjs');
    delete require.cache[modulePath];
    const { createConfigHandlers } = require(modulePath);
    const result = await createConfigHandlers()['read-config']({ sender: { id: 1 } }, root);
    assert.equal(result.version, '1.20.1');
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the file-handler config read remains a read-only successful hydration path', async () => {
  const root = path.join(os.tmpdir(), 'minecraft-core-task-13-file-read');
  const originalLoad = Module._load;
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  Module._load = function loadFileHandlerFixture(request, parent, isMain) {
    if (request === 'electron') {
      return {
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        shell: { openPath: async () => '' }
      };
    }
    if (typeof request === 'string' && request.endsWith('utils/app-store.cjs')) {
      return { get: () => [], set: () => true };
    }
    if (typeof request === 'string' && request.endsWith('utils/config-manager.cjs')) {
      return {
        ensureConfigFile: () => ({}),
        readServerConfig: () => ({ version: '1.21.1' }),
        updateServerConfig: () => ({})
      };
    }
    if (typeof request === 'string' && request.endsWith('utils/backup-util.cjs')) {
      return { createZip: async () => {} };
    }
    if (typeof request === 'string' && request.endsWith('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => logger };
    }
    if (typeof request === 'string' && request.endsWith('utils/security-boundaries.cjs')) {
      return { isPathInside: () => true };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = require.resolve('../electron/ipc/file-handlers.cjs');
    delete require.cache[modulePath];
    const { createFileHandlers } = require(modulePath);
    const result = await createFileHandlers(null)['read-config']({ sender: { id: 1 } }, root);
    assert.deepEqual(result, { version: '1.21.1' });
  } finally {
    Module._load = originalLoad;
    const modulePath = require.resolve('../electron/ipc/file-handlers.cjs');
    delete require.cache[modulePath];
  }
});

test('read-server-properties never creates a default backup during hydration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-task-13-read-properties-'));
  const propertiesPath = path.join(root, 'server.properties');
  const defaultPath = path.join(root, 'server.properties.default');
  fs.writeFileSync(propertiesPath, 'motd=Read only\n');
  const originalLoad = Module._load;
  Module._load = function loadWithKnownInstance(request, parent, isMain) {
    if (typeof request === 'string' && request.endsWith('utils/app-store.cjs')) {
      return {
        get(key) {
          return key === 'instances' ? [{ id: 'server-read', type: 'server', path: root }] : null;
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = require.resolve('../electron/ipc/server-properties-handlers.cjs');
    delete require.cache[modulePath];
    const { createServerPropertiesHandlers } = require(modulePath);
    const result = await createServerPropertiesHandlers()['read-server-properties'](
      { sender: { id: 1 } },
      root
    );
    assert.equal(result.success, true);
    assert.equal(result.properties.motd, 'Read only');
    assert.equal(fs.existsSync(defaultPath), false);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('get-instances hydrates without migrating config or persisting read results', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-13-instances');
  const storedInstances = [{
    id: 'server-read',
    name: 'Read server',
    type: 'server',
    path: serverPath,
    managementInviteSecret: 'packed-secret'
  }];
  const storeWrites = [];
  const configWrites = [];
  const contextWrites = [];
  const originalLoad = Module._load;
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  Module._load = function loadSettingsFixture(request, parent, isMain) {
    if (typeof request === 'string' && request.endsWith('utils/app-store.cjs')) {
      return {
        get(key) {
          if (key === 'instances') return storedInstances;
          if (key === 'lastServerPath') return serverPath;
          return null;
        },
        set(key, value) {
          storeWrites.push({ key, value });
          return true;
        },
        delete() { return true; }
      };
    }
    if (typeof request === 'string' && request.endsWith('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => logger };
    }
    if (typeof request === 'string' && request.endsWith('utils/instance-context.cjs')) {
      return { updateInstances(value) { contextWrites.push(value); } };
    }
    if (typeof request === 'string' && request.endsWith('utils/config-manager.cjs')) {
      return {
        getDefaultServerConfig: value => ({ ...(value || {}) }),
        readClientConfig: () => null,
        readServerConfig: () => ({ managementInviteHost: 'server.example' }),
        updateServerConfig(...args) {
          configWrites.push(args);
          return { managementInviteSecret: 'plain-secret' };
        }
      };
    }
    if (typeof request === 'string' && request.endsWith('utils/secure-store.cjs')) {
      return {
        ensureEncryptionAvailable() { return true; },
        packSecret: value => `packed:${value}`,
        unpackSecret: () => 'plain-secret'
      };
    }
    if (typeof request === 'string' && request.endsWith('utils/servers-dat.cjs')) {
      return { ensureServersDat: async () => ({ success: true }) };
    }
    if (typeof request === 'string' && request.endsWith('utils/port-validator.cjs')) {
      return { validateServerPorts: () => ({ valid: true }) };
    }
    if (typeof request === 'string' && request.endsWith('services/server-manager.cjs')) {
      return { shutdownMinecraftServer: async () => ({ success: true }) };
    }
    if (typeof request === 'string' && request.endsWith('services/management-server.cjs')) {
      return { stopAndDisposeManagementServers: async () => ({ success: true }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = require.resolve('../electron/ipc/settings-handlers.cjs');
    delete require.cache[modulePath];
    const { createSettingsHandlers } = require(modulePath);
    const result = await createSettingsHandlers()['get-instances']({ sender: { id: 1 } });
    assert.equal(result.length, 1);
    assert.equal(result[0].managementInviteHost, 'server.example');
    assert.equal(result[0].managementInviteSecret, 'packed-secret');
    assert.deepEqual(configWrites, []);
    assert.deepEqual(storeWrites, []);
    assert.deepEqual(contextWrites, []);
  } finally {
    Module._load = originalLoad;
    const modulePath = require.resolve('../electron/ipc/settings-handlers.cjs');
    delete require.cache[modulePath];
  }
});

test('backup size reads do not create a missing backup directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-task-13-backup-read-'));
  const backupDir = path.join(root, 'backups');
  const originalLoad = Module._load;
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  Module._load = function loadBackupHandlerFixture(request, parent, isMain) {
    if (typeof request === 'string' && request.endsWith('services/backup-service.cjs')) {
      return {};
    }
    if (typeof request === 'string' && request.endsWith('utils/app-store.cjs')) {
      return { get: () => null, set: () => true };
    }
    if (typeof request === 'string' && request.endsWith('utils/safe-send.cjs')) {
      return { safeSend() {} };
    }
    if (typeof request === 'string' && request.endsWith('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => logger };
    }
    if (typeof request === 'string' && request.endsWith('utils/config-manager.cjs')) {
      return {
        DEFAULT_BACKUP_AUTOMATION: {},
        getDefaultServerConfig: value => value || {},
        readServerConfig: () => null,
        updateServerConfig: () => ({})
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = require.resolve('../electron/ipc/backup-handlers.cjs');
    delete require.cache[modulePath];
    const { backupSizeTracker } = require(modulePath);
    const result = await backupSizeTracker.calculateTotalSize(root);
    assert.deepEqual(result, { totalSize: 0, backupCount: 0, cached: false });
    assert.equal(fs.existsSync(backupDir), false);
  } finally {
    Module._load = originalLoad;
    const modulePath = require.resolve('../electron/ipc/backup-handlers.cjs');
    delete require.cache[modulePath];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SETTINGS_MODULES = ['../electron/ipc/settings-handlers.cjs', '../electron/utils/config-manager.cjs'];

// The real settings handlers and config writer, loaded for one test with only
// the app store, logger, secrets and runtime stop stubbed.
function loadSettingsEnvironment(t) {
  const store = new Map();
  const appStore = {
    get: key => (store.has(key) ? structuredClone(store.get(key)) : undefined),
    set: (key, value) => { store.set(key, structuredClone(value)); return true; },
    delete: key => { store.delete(key); return true; }
  };
  const stops = [];
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  const stubs = new Map([
    ['app-store.cjs', appStore],
    ['logger-handlers.cjs', { getLoggerHandlers: () => logger }],
    ['instance-context.cjs', { updateInstances() {} }],
    ['secure-store.cjs', { ensureEncryptionAvailable: () => true, packSecret: value => `packed:${value}`, unpackSecret: value => value }],
    ['servers-dat.cjs', { ensureServersDat: async () => ({ success: true }) }],
    ['port-validator.cjs', { validateServerPorts: async () => ({ valid: true }) }],
    ['server-manager.cjs', { shutdownMinecraftServer: async selector => { stops.push(selector.instanceId); return { success: true }; } }],
    ['management-server.cjs', { stopAndDisposeManagementServers: async () => ({ success: true }) }]
  ]);
  const modulePaths = SETTINGS_MODULES.map(modulePath => require.resolve(modulePath));
  const saved = modulePaths.map(modulePath => require.cache[modulePath]);
  const originalLoad = Module._load;
  Module._load = function loadSettingsBoundaries(request, parent, isMain) {
    const stub = typeof request === 'string' ? stubs.get(path.posix.basename(request.replaceAll('\\', '/'))) : undefined;
    return stub || originalLoad.call(this, request, parent, isMain);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-registry-'));
  t.after(() => {
    Module._load = originalLoad;
    modulePaths.forEach((modulePath, index) => {
      delete require.cache[modulePath];
      if (saved[index]) require.cache[modulePath] = saved[index];
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const modulePath of modulePaths) delete require.cache[modulePath];
  require(modulePaths[1]).configureServerConfigDurableFsFactory(createInstanceConfigFsFactory({
    strictFactory: roots => createDurableFs({
      fsApi: fs,
      durableClient: { flushDirectory() {}, moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync },
      allowedRoots: [...roots]
    })
  }));
  const settings = require(modulePaths[0]).createSettingsHandlers();
  return { appStore, settings, stops, root };
}

function serverFolder(root, name, config = { version: '1.20.1', port: 25565, maxRam: 4 }) {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.minecraft-core.json'), `${JSON.stringify(config, null, 2)}\n`);
  return folder;
}

function settingsPolicy(env, coordinator) {
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => env.appStore.get('instances') || [],
    createOperationId: channel => `${channel}-${crypto.randomUUID()}`
  });
  return Object.assign(channel => policy.wrapHandler(channel, env.settings[channel]), { policy });
}

async function runServer(coordinator, instanceId, serverPath) {
  const lease = await coordinator.acquireStart({ instanceId, serverPath }, {
    operation: 'server-start', operationId: `server-start-${crypto.randomUUID()}`, parentMutationLease: null
  });
  lease.markRunning({ pid: 7070 });
  return lease;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const running of [false, true]) {
  test(`the custom-server setup registers its server ${running ? 'while another server runs' : 'with nothing running'}`, async t => {
    const env = loadSettingsEnvironment(t);
    const { coordinator } = createCoordinator();
    const wrap = settingsPolicy(env, coordinator);
    const alpha = { id: 'server-alpha', name: 'Alpha', type: 'server', path: serverFolder(env.root, 'Alpha') };
    const custom = { id: 'server-custom', name: 'Custom', type: 'server', path: serverFolder(env.root, 'Custom') };
    env.appStore.set('instances', [alpha]);
    const lease = running ? await runServer(coordinator, alpha.id, alpha.path) : null;

    try {
      // The setup wizard sends both without awaiting the first.
      const [updated, saved] = await Promise.all([
        wrap('update-settings')(EVENT, { serverPath: custom.path, port: 25570, maxRam: 4, managementPort: 8090 }),
        wrap('save-instances')(EVENT, [alpha, custom])
      ]);
      assert.equal(updated.success, true, updated.error);
      assert.equal(saved.success, true, saved.error);
    } finally {
      lease?.release();
    }
    assert.deepEqual(env.appStore.get('instances').map(instance => instance.id), [alpha.id, custom.id]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(custom.path, '.minecraft-core.json'), 'utf8')).port, 25570);
  });
}

test('a sidebar reorder while a server runs is saved and leaves its v26.6.1 config byte-identical', async t => {
  const env = loadSettingsEnvironment(t);
  const { coordinator } = createCoordinator();
  const wrap = settingsPolicy(env, coordinator);
  const alphaPath = serverFolder(env.root, 'Alpha', {
    version: '1.20.1', loader: 'fabric', fabric: '0.15.11', port: 25565, maxRam: 4,
    managementPort: 8080, autoStartMinecraft: false, autoStartManagement: false
  });
  const configPath = path.join(alphaPath, '.minecraft-core.json');
  const before = fs.readFileSync(configPath);
  const alpha = { id: 'server-alpha', name: 'Alpha', type: 'server', path: alphaPath };
  const clientPath = path.join(env.root, 'Client');
  fs.mkdirSync(clientPath);
  const client = { id: 'client-me', clientId: 'client-me', name: 'Me', clientName: 'Me', type: 'client', path: clientPath };
  env.appStore.set('instances', [alpha, client]);
  const lease = await runServer(coordinator, alpha.id, alphaPath);

  try {
    // The renderer echoes values it shows for the server; none are written back.
    const saved = await wrap('save-instances')(EVENT, [client, { ...alpha, managementInviteHost: 'play.example' }]);
    assert.equal(saved.success, true, saved.error);
  } finally {
    lease.release();
  }
  assert.deepEqual(env.appStore.get('instances').map(instance => instance.id), [client.id, alpha.id]);
  assert.deepEqual(fs.readFileSync(configPath), before);
});

test('removing a running server from the instance list needs it stopped', async t => {
  const env = loadSettingsEnvironment(t);
  const { coordinator } = createCoordinator();
  const wrap = settingsPolicy(env, coordinator);
  const alpha = { id: 'server-alpha', name: 'Alpha', type: 'server', path: serverFolder(env.root, 'Alpha') };
  const beta = { id: 'server-beta', name: 'Beta', type: 'server', path: serverFolder(env.root, 'Beta') };
  env.appStore.set('instances', [alpha, beta]);
  const lease = await runServer(coordinator, alpha.id, alpha.path);

  try {
    await assert.rejects(wrap('save-instances')(EVENT, [beta]), code('SERVER_RUNNING'));
  } finally {
    lease.release();
  }
  assert.deepEqual(env.appStore.get('instances').map(instance => instance.id), [alpha.id, beta.id]);
  assert.deepEqual(env.stops, []);
});

test('a listed server whose folder is gone never stops a client from being added, and is not recreated', async t => {
  const env = loadSettingsEnvironment(t);
  const { coordinator } = createCoordinator();
  const wrap = settingsPolicy(env, coordinator);
  const gonePath = path.join(env.root, 'Unplugged', 'Server');
  const gone = { id: 'server-gone', name: 'Gone', type: 'server', path: gonePath, managementInviteHost: '' };
  const live = { id: 'server-live', name: 'Live', type: 'server', path: serverFolder(env.root, 'Live'), managementInviteHost: '' };
  const clientPath = path.join(env.root, 'Client');
  fs.mkdirSync(clientPath);
  const client = { id: 'client-new', clientId: 'client-new', name: 'New', clientName: 'New', type: 'client', path: clientPath };
  env.appStore.set('instances', [gone, live]);

  const saved = await wrap('save-instances')(EVENT, [gone, live, client]);

  assert.equal(saved.success, true, saved.error);
  assert.deepEqual(env.appStore.get('instances').map(instance => instance.id), [gone.id, live.id, client.id]);
  assert.equal(fs.existsSync(path.join(env.root, 'Unplugged')), false);
});

test('a listed server with a damaged config is left untouched by an instance save', async t => {
  const env = loadSettingsEnvironment(t);
  const { coordinator } = createCoordinator();
  const wrap = settingsPolicy(env, coordinator);
  const damagedPath = path.join(env.root, 'Damaged');
  fs.mkdirSync(damagedPath);
  const configPath = path.join(damagedPath, '.minecraft-core.json');
  fs.writeFileSync(configPath, '{ "version": "1.20.1", ');
  const before = fs.readFileSync(configPath);
  const damaged = { id: 'server-damaged', name: 'Damaged', type: 'server', path: damagedPath };
  const clientPath = path.join(env.root, 'Client');
  fs.mkdirSync(clientPath);
  const client = { id: 'client-new', clientId: 'client-new', name: 'New', clientName: 'New', type: 'client', path: clientPath };
  env.appStore.set('instances', [damaged]);

  const saved = await wrap('save-instances')(EVENT, [{ ...damaged, managementInviteHost: 'play.example' }, client]);

  assert.equal(saved.success, true, saved.error);
  assert.deepEqual(fs.readFileSync(configPath), before);
  assert.deepEqual(fs.readdirSync(damagedPath), ['.minecraft-core.json']);
});

test('a registration published while an instance save waits is neither stopped nor unregistered', async t => {
  const env = loadSettingsEnvironment(t);
  const { coordinator } = createCoordinator();
  const wrap = settingsPolicy(env, coordinator);
  const alpha = { id: 'server-alpha', name: 'Alpha', type: 'server', path: serverFolder(env.root, 'Alpha') };
  const fresh = { id: 'server-new', name: 'New', type: 'server', path: serverFolder(env.root, 'NewCustom') };
  const packPath = serverFolder(env.root, 'PackServer');
  env.appStore.set('instances', [alpha]);

  // update-settings for the new folder is still running when save-instances arrives.
  const slowEntered = deferred();
  const slowGate = deferred();
  const slow = wrap.policy.wrapHandler('update-settings', async () => {
    slowEntered.resolve();
    await slowGate.promise;
    return { success: true };
  })(EVENT, { instanceId: fresh.id, serverPath: fresh.path });
  await slowEntered.promise;
  const save = wrap('save-instances')(EVENT, [alpha, fresh]);
  save.catch(() => {});

  // Meanwhile a modpack install publishes a new server and still holds it.
  const lifecycleEntered = deferred();
  const lifecycleGate = deferred();
  const lifecycle = coordinator.runMutation({ instanceId: 'server-pack', serverPath: packPath }, {
    operation: 'install-new', operationId: 'op-lifecycle-1', revisionMode: 'none', quiesce: null
  }, async () => {
    env.appStore.set('instances', [...env.appStore.get('instances'), { id: 'server-pack', name: 'Pack', type: 'server', path: packPath }]);
    lifecycleEntered.resolve();
    await lifecycleGate.promise;
  });
  await lifecycleEntered.promise;

  slowGate.resolve();
  await slow;
  await assert.rejects(save, code('OPERATION_IN_PROGRESS'));
  assert.deepEqual(env.stops, []);
  assert.deepEqual(env.appStore.get('instances').map(instance => instance.id), [alpha.id, 'server-pack']);
  lifecycleGate.resolve();
  await lifecycle;
});

async function selectServerFolder({ folder, instances, coordinator, assertServerDestination = null, ensured = [] }) {
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  const modulePath = require.resolve('../electron/ipc/file-handlers.cjs');
  const originalLoad = Module._load;
  Module._load = function loadSelectFolderFixture(request, parent, isMain) {
    if (request === 'electron') {
      return { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }) }, shell: {} };
    }
    if (typeof request === 'string' && request.endsWith('utils/app-store.cjs')) {
      return { get: key => (key === 'instances' ? instances : null), set: () => true };
    }
    if (typeof request === 'string' && request.endsWith('utils/config-manager.cjs')) {
      return {
        ensureConfigFile: target => { ensured.push(target); return {}; },
        readServerConfig: () => null,
        updateServerConfig: () => ({})
      };
    }
    if (typeof request === 'string' && request.endsWith('utils/backup-util.cjs')) return { createZip: async () => {} };
    if (typeof request === 'string' && request.endsWith('logger-handlers.cjs')) return { getLoggerHandlers: () => logger };
    if (typeof request === 'string' && request.endsWith('services/server-mutation-context.cjs')) {
      return { ...serverMutationContext, getServerMutationCoordinator: () => coordinator };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const { createFileHandlers } = require(modulePath);
    const handlers = createFileHandlers(null, { assertServerDestination });
    const result = await handlers['select-folder'](EVENT, { instanceType: 'server' });
    return { result, ensured };
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

function clientDestinationCheck() {
  const integration = createClientPackIntegration({
    resolveClient: async () => null,
    resolveClientByPath: async () => null,
    transaction: { status: async () => null, assertNoUnsettledAtPath: async () => {} }
  });
  return value => integration.assertServerDestination(value);
}

test('a new server folder inside a plain client folder is initialised; a matching-pack client still refuses', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-select-folder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clientPath = path.join(root, 'Client');
  const folder = path.join(clientPath, 'Server');
  fs.mkdirSync(folder, { recursive: true });
  const instances = [{ id: 'client-me', type: 'client', path: clientPath }];
  const { coordinator } = createCoordinator();
  const assertServerDestination = clientDestinationCheck();

  const plain = await selectServerFolder({ folder, instances, coordinator, assertServerDestination });
  assert.equal(plain.result, folder);
  assert.deepEqual(plain.ensured, [folder]);

  fs.writeFileSync(path.join(clientPath, CLIENT_PACK_MANIFEST), '{}');
  const ensured = [];
  await assert.rejects(
    selectServerFolder({ folder, instances, coordinator, assertServerDestination, ensured }),
    error => error?.code === 'INVALID_REQUEST' && error.message === NESTED_MESSAGE
  );
  assert.deepEqual(ensured, []);
});

test('initialising a server folder is an ordinary writer that a running server does not block', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-select-running-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'Server');
  fs.mkdirSync(folder);
  const { coordinator } = createCoordinator();
  const lease = await runServer(coordinator, 'server-alpha', folder);

  try {
    const selected = await selectServerFolder({ folder, instances: [{ id: 'server-alpha', type: 'server', path: folder }], coordinator });
    assert.equal(selected.result, folder);
    assert.deepEqual(selected.ensured, [folder]);
  } finally {
    lease.release();
  }
});
