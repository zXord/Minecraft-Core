const assert = require('node:assert/strict');
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
const {
  markCurrentServerMutationDirty
} = require('../electron/services/server-mutation-context.cjs');

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

test('path and instance aliases reserve one writer before its handler awaits', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-13-alias');
  const { coordinator } = createCoordinator();
  const policy = createPolicy(coordinator, serverPath);
  let releaseFirst;
  const firstSettled = new Promise(resolve => { releaseFirst = resolve; });
  let entered = false;
  const handlers = policy.wrapHandlers({
    'write-config': async () => {
      entered = true;
      await firstSettled;
      return { success: true };
    },
    'update-settings': async () => ({ success: true })
  });

  const first = handlers['write-config'](
    { sender: { id: 1 } },
    { serverPath, config: { version: '1.21.1' } }
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, true);

  await assert.rejects(
    handlers['update-settings'](
      { sender: { id: 2 } },
      { instanceId: 'server-alpha', port: 25566 }
    ),
    code('OPERATION_IN_PROGRESS')
  );

  releaseFirst();
  await first;
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

test('multi-instance persistence marks only the server roots it actually writes', async () => {
  const alphaPath = path.join(os.tmpdir(), 'minecraft-core-task-13-many-alpha');
  const betaPath = path.join(os.tmpdir(), 'minecraft-core-task-13-many-beta');
  const { coordinator, revisions } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [
      { id: 'server-alpha', type: 'server', path: alphaPath },
      { id: 'server-beta', type: 'server', path: betaPath }
    ],
    createOperationId: () => 'core-writer-many'
  });
  const handlers = policy.wrapHandlers({
    'save-instances': async () => {
      markCurrentServerMutationDirty(alphaPath);
      markCurrentServerMutationDirty(betaPath);
      return { success: true };
    }
  });

  await handlers['save-instances']({ sender: { id: 1 } }, [
    { id: 'server-alpha', type: 'server', path: alphaPath },
    { id: 'server-beta', type: 'server', path: betaPath }
  ]);

  assert.equal(revisions.get(path.resolve(alphaPath).toLocaleLowerCase('en-US')), 1);
  assert.equal(revisions.get(path.resolve(betaPath).toLocaleLowerCase('en-US')), 1);
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
