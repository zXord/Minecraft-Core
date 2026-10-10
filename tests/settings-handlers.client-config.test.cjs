const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { ManagementSessionBroker } = require('../electron/services/management-session-broker.cjs');

async function withSettingsHandlers(initialInstances, fn, { serverConfig = null, invalidateManagementSession = () => {}, writeGate = null } = {}) {
  const originalLoad = Module._load;
  const modulePath = require.resolve('../electron/ipc/settings-handlers.cjs');
  const store = new Map([['instances', initialInstances]]);
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  const serversDatCalls = [];
  Module._load = function loadSettingsHandlerFixture(request, parent, isMain) {
    if (typeof request === 'string' && request.endsWith('utils/app-store.cjs')) {
      return {
        get: key => store.get(key),
        set: (key, value) => {
          store.set(key, value);
          return true;
        }
      };
    }
    if (typeof request === 'string' && request.endsWith('utils/servers-dat.cjs')) {
      return {
        ensureServersDat: async (...args) => {
          serversDatCalls.push(args);
          return { success: true };
        }
      };
    }
    if (typeof request === 'string' && request.endsWith('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => logger };
    }
    if (typeof request === 'string' && request.endsWith('utils/instance-context.cjs')) return { updateInstances() {} };
    if (request === 'fs/promises' && writeGate) return { ...fs, async rename(...args) { await writeGate(); return fs.rename(...args); } };
    if (typeof request === 'string' && request.endsWith('utils/config-manager.cjs')) {
      return {
        getDefaultServerConfig: value => value,
        readServerConfig: () => serverConfig,
        updateServerConfig: () => true,
        readClientConfig: () => null
      };
    }
    if (typeof request === 'string' && request.endsWith('utils/secure-store.cjs')) {
      return {
        ensureEncryptionAvailable: () => true,
        packSecret: value => `packed:${value}`,
        unpackSecret: value => value
      };
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
    if (typeof request === 'string' && request.endsWith('services/server-mutation-context.cjs')) {
      return { markCurrentServerMutationDirty() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const settingsHandlers = require(modulePath);
    return await fn(settingsHandlers.createSettingsHandlers({ invalidateManagementSession }), store, {
      serversDatCalls,
      writeClientConfigAtomic: settingsHandlers.writeClientConfigAtomic
    });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}
test('explicit client save, rename and removal invalidate local instance identity without serialization changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'client-session-settings-')); const calls = [];
  try {
    await withSettingsHandlers([{ id: 'local', clientId: 'remote', type: 'client', path: root, name: 'Client' }], async handlers => {
      const event = { sender: { id: 1 } };
      assert.equal((await handlers['save-client-config'](event, { path: root, serverIp: 'saved.example', serverPort: '25566', clientId: 'remote', clientName: 'Client', sessionToken: 'seed', inviteSecret: 'invite', initializeMultiplayer: false })).success, true);
      assert.deepEqual(calls, ['local']);
      const saved = JSON.parse(await fs.readFile(path.join(root, 'client-config.json'), 'utf8'));
      assert.equal(saved.sessionToken, 'packed:seed'); assert.equal(saved.inviteSecret, 'packed:invite');
      assert.equal((await handlers['rename-instance'](event, { id: 'local', newName: 'Renamed' })).success, true);
      assert.deepEqual(calls, ['local', 'local']);
      assert.equal((await handlers['delete-instance'](event, { id: 'local', deleteFiles: false })).success, true);
      assert.deepEqual(calls, ['local', 'local', 'local']);
      assert.equal((await fs.stat(root)).isDirectory(), true);
    }, { invalidateManagementSession: id => calls.push(id) });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('save invalidates before its asynchronous atomic-write boundary, not after completion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'client-session-write-race-')); const calls = [];
  let enter; let finish; const ready = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { finish = resolve; });
  try {
    await withSettingsHandlers([{ id: 'local', type: 'client', path: root }], async handlers => {
      const pending = handlers['save-client-config']({ sender: { id: 1 } }, { path: root, serverIp: 'saved.example', clientId: 'remote', clientName: 'Client', initializeMultiplayer: false });
      await ready; const observed = [...calls]; finish(); await pending; assert.deepEqual(observed, ['local']);
    }, { invalidateManagementSession: id => calls.push(id), writeGate: () => { enter(); return gate; } });
  } finally { finish(); await fs.rm(root, { recursive: true, force: true }); }
});
test('settings invalidation rejects old registration during a pending atomic config write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'client-session-save-invalidation-'));
  const configFile = path.join(root, 'client-config.json'); let enter; let release;
  const ready = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  let writeEnter; let writeRelease; const writing = new Promise(resolve => { writeEnter = resolve; }); const writeGate = new Promise(resolve => { writeRelease = resolve; });
  const broker = new ManagementSessionBroker({ resolveClient: async id => ({ clientId: id, clientPath: root }),
    readClientConfig: async () => JSON.parse(await fs.readFile(configFile, 'utf8')),
    requestJson: async () => { enter(); await gate; return { statusCode: 200, body: { success: true, token: 'b'.repeat(64) } }; } });
  try {
    await fs.writeFile(configFile, JSON.stringify({ serverProtocol: 'http', serverIp: 'old.example', serverPort: '25566', clientId: 'remote', clientName: 'Synthetic', inviteSecret: 'invite', sessionToken: 'seed' }));
    const snapshot = await broker.acquire('local');
    const rotating = broker.acquire('local', { reason: 'authorization-rejected', observedBindingGeneration: snapshot.bindingGeneration, observedRevision: 0 }).catch(error => error); await ready;
    await withSettingsHandlers([{ id: 'local', clientId: 'remote', type: 'client', path: root }], async handlers => {
      const saving = handlers['save-client-config']({ sender: { id: 1 } }, { path: root, serverIp: 'new.example', serverPort: '25566', serverProtocol: 'http', clientId: 'remote', clientName: 'Synthetic', sessionToken: 'seed', inviteSecret: 'invite', initializeMultiplayer: false });
      await writing; assert.equal((await rotating).code, 'PLAN_STALE');
      const duringWrite = await broker.acquire('local'); assert.notEqual(duringWrite.bindingGeneration, snapshot.bindingGeneration);
      writeRelease(); assert.equal((await saving).success, true); release();
      await assert.rejects(broker.acquire('local', { expectedBinding: duringWrite.binding }), { code: 'PLAN_STALE' });
      assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).serverIp, 'new.example');
    }, { invalidateManagementSession: id => broker.invalidate(id), writeGate: () => { writeEnter(); return writeGate; } });
  } finally { writeRelease(); release(); broker.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
test('invalid requests and server-only rename do not invalidate client sessions', async () => {
  const calls = [];
  await withSettingsHandlers([{ id: 'server-one', name: 'Server', type: 'server' }], async handlers => {
    const event = { sender: { id: 1 } };
    assert.equal((await handlers['rename-instance'](event, { id: 'server-one', newName: 'Renamed server' })).success, true);
    assert.equal((await handlers['rename-instance'](event, { id: 'server-one', newName: '' })).success, false);
    assert.equal((await handlers['save-client-config'](event, { serverIp: 'saved.example' })).success, false);
    assert.deepEqual(calls, []);
  }, { invalidateManagementSession: id => calls.push(id) });
});

test('get-settings exposes the durable read-only server content revision', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-settings-content-revision-test');
  await withSettingsHandlers([{
    id: 'disposable-server',
    name: 'Disposable server',
    type: 'server',
    path: serverPath
  }], async (handlers) => {
    const result = await handlers['get-settings']({ sender: { id: 1 } }, {
      instanceId: 'disposable-server'
    });

    assert.equal(result.success, true);
    assert.equal(result.settings.serverPath, serverPath);
    assert.equal(result.settings.contentRevision, 4);
  }, {
    serverConfig: {
      port: 25565,
      maxRam: 4,
      managementPort: 8080,
      autoStartMinecraft: false,
      autoStartManagement: false,
      contentRevision: 4
    }
  });
});

test('save-client-config keeps an existing instance name synchronized with clientName', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-client-config-name-test-'));
  const clientPath = path.join(root, 'client');
  const previousName = 'E2E_001122334455';
  const nextName = 'E2E_aabbccddeeff';
  try {
    await fs.mkdir(clientPath);
    await fs.writeFile(path.join(clientPath, '.servers-initialized'), '{}');
    await withSettingsHandlers([{
      id: 'disposable-client-join-e2e',
      name: previousName,
      clientName: previousName,
      type: 'client',
      path: clientPath,
      serverIp: '127.0.0.1',
      serverPort: '49152'
    }], async (handlers, store) => {
      const result = await handlers['save-client-config']({ sender: { id: 1 } }, {
        path: clientPath,
        serverIp: '127.0.0.1',
        serverPort: '49153',
        clientId: 'disposable-client-join-e2e',
        clientName: nextName
      });

      assert.deepEqual(result, { success: true });
      const [saved] = store.get('instances');
      assert.equal(saved.name, nextName);
      assert.equal(saved.clientName, nextName);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('auth-only client config persistence leaves multiplayer files uninitialized', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-client-auth-only-test-'));
  const clientPath = path.join(root, 'client');
  try {
    await fs.mkdir(clientPath);
    await withSettingsHandlers([{
      id: 'client-auth-only',
      name: 'Auth-only client',
      clientName: 'Auth-only client',
      type: 'client',
      path: clientPath,
      serverIp: '127.0.0.1',
      serverPort: '49152'
    }], async (handlers, _store, { serversDatCalls }) => {
      const result = await handlers['save-client-config']({ sender: { id: 1 } }, {
        path: clientPath,
        serverIp: '127.0.0.1',
        serverPort: '49152',
        clientId: 'client-auth-only',
        clientName: 'Auth-only client',
        sessionToken: 'replacement-session-token',
        initializeMultiplayer: false
      });

      assert.deepEqual(result, { success: true });
      assert.equal(serversDatCalls.length, 0);
      assert.equal(await fs.stat(path.join(clientPath, '.servers-initialized')).then(() => true, () => false), false);
      assert.equal(await fs.stat(path.join(clientPath, 'servers.dat')).then(() => true, () => false), false);
      const persisted = JSON.parse(await fs.readFile(path.join(clientPath, 'client-config.json'), 'utf8'));
      assert.equal(persisted.sessionToken, 'packed:replacement-session-token');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('explicit client setup still initializes the multiplayer entry by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-client-setup-test-'));
  const clientPath = path.join(root, 'client');
  try {
    await fs.mkdir(clientPath);
    await withSettingsHandlers([], async (handlers, _store, { serversDatCalls }) => {
      const result = await handlers['save-client-config']({ sender: { id: 1 } }, {
        path: clientPath,
        serverIp: '127.0.0.1',
        serverPort: '49152',
        clientId: 'client-explicit-setup',
        clientName: 'Explicit setup'
      });

      assert.deepEqual(result, { success: true });
      assert.equal(serversDatCalls.length, 1);
      assert.equal(await fs.stat(path.join(clientPath, '.servers-initialized')).then(() => true, () => false), true);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('atomic client config persistence preserves the prior file after a partial temporary write failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-client-config-atomic-test-'));
  const clientPath = path.join(root, 'client');
  const configFile = path.join(clientPath, 'client-config.json');
  try {
    await fs.mkdir(clientPath);
    await fs.writeFile(configFile, '{"stable":true}\n');
    await withSettingsHandlers([], async (_handlers, _store, { writeClientConfigAtomic }) => {
      assert.equal(typeof writeClientConfigAtomic, 'function', 'atomic client config writer is required');
      const failingFs = {
        async writeFile(filePath, data, options) {
          await fs.writeFile(filePath, String(data).slice(0, 7), options);
          throw new Error('simulated partial temporary write');
        },
        rename: fs.rename.bind(fs),
        unlink: fs.unlink.bind(fs)
      };

      await assert.rejects(
        writeClientConfigAtomic(configFile, { stable: false }, {
          fsApi: failingFs,
          tokenFactory: () => 'partial-write'
        }),
        /simulated partial temporary write/u
      );
    });

    assert.equal(await fs.readFile(configFile, 'utf8'), '{"stable":true}\n');
    assert.deepEqual(await fs.readdir(clientPath), ['client-config.json']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('atomic client config persistence replaces an existing file without retaining a temporary sibling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-client-config-replace-test-'));
  const clientPath = path.join(root, 'client');
  const configFile = path.join(clientPath, 'client-config.json');
  try {
    await fs.mkdir(clientPath);
    await fs.writeFile(configFile, '{"version":"old"}\n');
    await withSettingsHandlers([], async (_handlers, _store, { writeClientConfigAtomic }) => {
      await writeClientConfigAtomic(configFile, { version: 'new' }, {
        tokenFactory: () => 'successful-replacement'
      });
    });

    assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), { version: 'new' });
    assert.deepEqual(await fs.readdir(clientPath), ['client-config.json']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
