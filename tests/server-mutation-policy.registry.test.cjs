const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// One environment per process: the settings handlers bind the app store when
// they load. Only process-wide boundaries (store, logger, secrets, runtime
// stop) are stubbed; the policy, coordinator, config writer, settings handlers,
// client-pack integration and client process guard are real.
const store = new Map();
const appStore = {
  get: key => (store.has(key) ? structuredClone(store.get(key)) : undefined),
  set: (key, value) => { store.set(key, structuredClone(value)); return true; },
  delete: key => { store.delete(key); return true; }
};
const runtime = { stops: [], failStop: false };
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const STUBS = new Map([
  ['app-store.cjs', appStore],
  ['logger-handlers.cjs', { getLoggerHandlers: () => QUIET }],
  ['instance-context.cjs', { updateInstances() {} }],
  ['secure-store.cjs', { ensureEncryptionAvailable: () => true, packSecret: value => `packed:${value}`, unpackSecret: value => value }],
  ['servers-dat.cjs', { ensureServersDat: async () => ({ success: true }) }],
  ['port-validator.cjs', { validateServerPorts: async () => ({ valid: true }) }],
  ['server-manager.cjs', {
    shutdownMinecraftServer: async selector => {
      runtime.stops.push(selector.instanceId);
      return { success: !runtime.failStop };
    }
  }],
  ['management-server.cjs', { stopAndDisposeManagementServers: async () => ({ success: true }) }]
]);
const originalLoad = Module._load;
Module._load = function loadWithBoundaries(request, parent, isMain) {
  const stub = typeof request === 'string' ? STUBS.get(path.posix.basename(request.replaceAll('\\', '/'))) : undefined;
  return stub || originalLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; });

const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { createInstanceConfigFsFactory } = require('../electron/utils/instance-config-fs.cjs');
const configManager = require('../electron/utils/config-manager.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { canonicalCoordinatorSelector } = require('../electron/services/coordinator-identity.cjs');
const { createServerMutationPolicy } = require('../electron/services/server-mutation-policy.cjs');
const { createClientPackIntegration } = require('../electron/services/client-modpacks/client-pack-integration.cjs');
const { ClientProcessGuard } = require('../electron/services/client-modpacks/client-process-guard.cjs');
const { createSettingsHandlers } = require('../electron/ipc/settings-handlers.cjs');

const EVENT = { sender: { id: 1 } };

function jsDurableFs(roots) {
  return createDurableFs({
    fsApi: fs,
    durableClient: {
      flushDirectory() {},
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      async flushDirectoryAsync() {},
      moveWriteThroughAsync: fs.promises.rename,
      replaceFileWriteThroughAsync: fs.promises.rename
    },
    allowedRoots: [...roots]
  });
}

configManager.configureServerConfigDurableFsFactory(createInstanceConfigFsFactory({ strictFactory: jsDurableFs }));
const settings = createSettingsHandlers();

function code(expected) {
  return error => error?.code === expected;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function registered() {
  return appStore.get('instances') || [];
}

function fixture(t, { recoveryBlocks = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.clear();
  runtime.stops.length = 0;
  runtime.failStop = false;

  const revisions = new Map();
  const revisionKey = value => path.resolve(value).toLocaleLowerCase('en-US');
  const coordinator = new ServerMutationCoordinator({
    readContentRevision: serverPath => revisions.get(revisionKey(serverPath)) || 0,
    bumpContentRevision(serverPath, { expectedRevision }) {
      const current = revisions.get(revisionKey(serverPath)) || 0;
      if (current !== expectedRevision) throw new Error('content revision compare-and-set mismatch');
      revisions.set(revisionKey(serverPath), current + 1);
      return current + 1;
    }
  });
  if (recoveryBlocks.length) coordinator.installRecoveryBlocks(recoveryBlocks);
  coordinator.completeStartupRecovery([]);

  const guardRoot = path.join(root, 'client-processes');
  fs.mkdirSync(guardRoot);
  const guard = new ClientProcessGuard({
    root: guardRoot,
    durableFs: jsDurableFs([guardRoot]),
    inspectProcesses: async () => ({ complete: true, processes: [] }),
    acquireEndpointLease: async () => ({ async close() {}, assertHeld() {} })
  });
  const resolveClient = async clientId => {
    const matches = registered().filter(instance => instance?.id === clientId && instance.type === 'client' &&
      typeof instance.path === 'string' && path.isAbsolute(instance.path));
    if (matches.length !== 1) throw new ModpackError('INVALID_REQUEST', 'Choose a registered client instance');
    return Object.freeze({ clientId, clientPath: path.resolve(matches[0].path) });
  };
  const integration = createClientPackIntegration({
    resolveClient,
    resolveClientByPath: async () => { throw new Error('the registry path never resolves launches'); },
    processGuard: guard,
    transaction: { status: async () => null, assertNoUnsettledAtPath: async () => {} },
    stateStore: { read: async () => null },
    // Production-shaped, but every network path throws: registry edits never read the host.
    managementClient: { async readRequirement() { throw new Error('registry edits must not contact the host'); } },
    clientPackService: {}
  });
  let sequence = 0;
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => registered(),
    getClientPackIntegration: () => integration,
    getModpackStateRepository: () => ({ read: async () => null }),
    // Production ids: `${channel}-${uuid}` (colons included).
    createOperationId: channel => `${channel}-${crypto.randomUUID()}-${++sequence}`
  });
  const wrap = channel => policy.wrapHandler(channel, settings[channel]);

  function server(name, { folder = path.join(root, name), id = `server-${name}`, write = true } = {}) {
    if (write) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, '.minecraft-core.json'), `${JSON.stringify({ version: '1.20.1', port: 25565, maxRam: 4 }, null, 2)}\n`);
    }
    return { id, name, type: 'server', path: folder };
  }

  function client(name, { folder = path.join(root, name), id = `client-${name}`, write = true } = {}) {
    if (write) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'client-config.json'), JSON.stringify({
        serverIp: '192.0.2.10', serverPort: '8080', serverProtocol: 'https', clientId: id, clientName: name
      }, null, 2));
    }
    return { id, clientId: id, name, clientName: name, type: 'client', path: folder };
  }

  async function start(instanceId, serverPath, { running = true } = {}) {
    const selector = canonicalCoordinatorSelector({ instances: registered(), selector: { instanceId, serverPath }, coordinator });
    const lease = await coordinator.acquireStart(selector, {
      operation: 'server-start', operationId: `server-start-${crypto.randomUUID()}`, parentMutationLease: null
    });
    if (running) lease.markRunning({ pid: 4242 });
    return lease;
  }

  function holdLifecycle(selector) {
    const entered = deferred();
    const gate = deferred();
    const run = coordinator.runMutation(selector, {
      operation: 'test-lifecycle', operationId: `lifecycle-${crypto.randomUUID()}`, revisionMode: 'none', quiesce: null
    }, async () => {
      entered.resolve();
      await gate.promise;
    });
    return { entered: entered.promise, release: () => { gate.resolve(); return run; } };
  }

  return { root, coordinator, guard, integration, policy, wrap, server, client, start, holdLifecycle };
}

test('a client is renamed in the store and in its client-config.json', async t => {
  const f = fixture(t);
  const alpha = f.server('Alpha');
  const me = f.client('Me');
  appStore.set('instances', [alpha, me]);

  const result = await f.wrap('rename-instance')(EVENT, { id: me.id, newName: 'Renamed' });

  assert.equal(result.success, true, result.error);
  const stored = registered().find(instance => instance.id === me.id);
  assert.equal(stored.name, 'Renamed');
  assert.equal(stored.clientName, 'Renamed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(me.path, 'client-config.json'), 'utf8')).clientName, 'Renamed');
});

test('a client is deleted keeping its files and deleting its files', async t => {
  const f = fixture(t);
  const keep = f.client('Keep');
  const remove = f.client('Remove');
  appStore.set('instances', [keep, remove]);

  const kept = await f.wrap('delete-instance')(EVENT, { id: keep.id, deleteFiles: false });
  assert.equal(kept.success, true, kept.error);
  assert.equal(fs.existsSync(keep.path), true);

  const removed = await f.wrap('delete-instance')(EVENT, { id: remove.id, deleteFiles: true });
  assert.equal(removed.success, true, removed.error);
  assert.equal(fs.existsSync(remove.path), false);
  assert.deepEqual(registered(), []);
});

test('a stale client whose folder and parent are gone is deleted', async t => {
  const f = fixture(t);
  const stale = f.client('Stale', { folder: path.join(f.root, 'gone-parent', 'Stale'), write: false });
  appStore.set('instances', [stale]);

  const result = await f.wrap('delete-instance')(EVENT, { id: stale.id, deleteFiles: true });

  assert.equal(result.success, true, result.error);
  assert.deepEqual(registered(), []);
});

test('an unknown id reaches the handler and reports Instance not found', async t => {
  const f = fixture(t);
  appStore.set('instances', [f.server('Alpha')]);

  assert.deepEqual(await f.wrap('rename-instance')(EVENT, { id: 'client-missing', newName: 'X' }),
    { success: false, error: 'Instance not found' });
  assert.deepEqual(await f.wrap('delete-instance')(EVENT, { id: 'client-missing', deleteFiles: true }),
    { success: false, error: 'Instance not found' });
});

test('a client delete with files over a lifecycle-held nested server is refused and deletes nothing', async t => {
  const f = fixture(t);
  const me = f.client('Minecraft');
  const pack = f.server('Server', { folder: path.join(me.path, 'Server'), id: 'server-pack' });
  fs.mkdirSync(path.join(pack.path, 'world'));
  fs.writeFileSync(path.join(pack.path, 'world', 'level.dat'), 'world');
  appStore.set('instances', [me, pack]);
  const lifecycle = f.holdLifecycle({ instanceId: pack.id, serverPath: pack.path });
  await lifecycle.entered;

  try {
    await assert.rejects(f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: true }), code('OPERATION_IN_PROGRESS'));
  } finally {
    await lifecycle.release();
  }
  assert.equal(fs.readFileSync(path.join(pack.path, 'world', 'level.dat'), 'utf8'), 'world');
  assert.deepEqual(registered().map(instance => instance.id), [me.id, pack.id]);
});

test('a client delete with files over a running nested server needs that server stopped', async t => {
  const f = fixture(t);
  const me = f.client('Minecraft');
  const nested = f.server('Server', { folder: path.join(me.path, 'Server'), id: 'server-nested' });
  appStore.set('instances', [me, nested]);
  const run = await f.start(nested.id, nested.path);

  try {
    await assert.rejects(f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: true }), code('SERVER_RUNNING'));
    // Keeping the files only edits the registry.
    const kept = await f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: false });
    assert.equal(kept.success, true, kept.error);
  } finally {
    run.release();
  }
  assert.equal(fs.existsSync(nested.path), true);
  assert.deepEqual(registered().map(instance => instance.id), [nested.id]);
});

test('a client rename or delete during an exclusive client-pack transaction is refused', async t => {
  const f = fixture(t);
  const me = f.client('Me');
  appStore.set('instances', [me]);
  const entered = deferred();
  const gate = deferred();
  const transaction = f.guard.withMutation({ clientId: me.id, clientPath: me.path }, async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;

  try {
    await assert.rejects(f.wrap('rename-instance')(EVENT, { id: me.id, newName: 'Renamed' }), code('CLIENT_RUNNING'));
    await assert.rejects(f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: true }), code('CLIENT_RUNNING'));
  } finally {
    gate.resolve();
    await transaction;
  }
  assert.equal(registered()[0].name, 'Me');
  assert.equal(fs.existsSync(me.path), true);
});

test('a server deleted with its files kept can be re-added under a new id and used in the same session', async t => {
  const f = fixture(t);
  const old = f.server('Alpha', { id: 'server-1000' });
  appStore.set('instances', [old]);
  assert.equal((await f.wrap('update-settings')(EVENT, { serverPath: old.path, instanceId: old.id, maxRam: 5 })).success, true);
  (await f.start(old.id, old.path)).release();

  const deleted = await f.wrap('delete-instance')(EVENT, { id: old.id, deleteFiles: false });
  assert.equal(deleted.success, true, deleted.error);
  assert.equal(f.coordinator.pathBinding(old.path), null);

  const readded = { ...old, id: 'server-2000' };
  const saved = await f.wrap('save-instances')(EVENT, [readded]);
  assert.equal(saved.success, true, saved.error);
  const run = await f.start(readded.id, readded.path);
  run.release();
  const written = await f.policy.wrapHandler('write-config', async () => ({ success: true }))(EVENT,
    { serverPath: readded.path, config: { version: '1.20.1' } });
  assert.equal(written.success, true);
  const updated = await f.wrap('update-settings')(EVENT, { serverPath: readded.path, instanceId: readded.id, maxRam: 6 });
  assert.equal(updated.success, true, updated.error);
  assert.deepEqual(f.coordinator.pathBinding(readded.path), { instanceId: readded.id });
});

test('deleting the only default-server lets a new default-server in another folder start', async t => {
  const f = fixture(t);
  const first = f.server('First', { id: 'default-server' });
  appStore.set('instances', [first]);
  (await f.start(first.id, first.path)).release();

  assert.equal((await f.wrap('delete-instance')(EVENT, { id: first.id, deleteFiles: false })).success, true);
  const second = f.server('Second', { id: 'default-server' });
  assert.equal((await f.wrap('save-instances')(EVENT, [second])).success, true);

  const run = await f.start(second.id, second.path);
  run.release();
  const written = await f.policy.wrapHandler('write-config', async () => ({ success: true }))(EVENT,
    { serverPath: second.path, config: { version: '1.20.1' } });
  assert.equal(written.success, true);
});

test('a server removed through save-instances can be re-added and started', async t => {
  const f = fixture(t);
  const alpha = f.server('Alpha');
  const beta = f.server('Beta');
  appStore.set('instances', [alpha, beta]);
  (await f.start(beta.id, beta.path)).release();

  const removed = await f.wrap('save-instances')(EVENT, [alpha]);
  assert.equal(removed.success, true, removed.error);
  assert.deepEqual(runtime.stops, [beta.id]);
  assert.equal(f.coordinator.pathBinding(beta.path), null);

  const readded = { ...beta, id: 'server-beta-again' };
  assert.equal((await f.wrap('save-instances')(EVENT, [alpha, readded])).success, true);
  (await f.start(readded.id, readded.path)).release();
});

test('a failed server delete keeps the coordinator alias', async t => {
  const f = fixture(t);
  const alpha = f.server('Alpha', { id: 'server-1000' });
  appStore.set('instances', [alpha]);
  (await f.start(alpha.id, alpha.path)).release();
  runtime.failStop = true;

  const result = await f.wrap('delete-instance')(EVENT, { id: alpha.id, deleteFiles: false });

  assert.equal(result.success, false);
  assert.equal(result.code, 'INSTANCE_CLEANUP_FAILED');
  assert.deepEqual(f.coordinator.pathBinding(alpha.path), { instanceId: alpha.id });
  assert.deepEqual(registered().map(instance => instance.id), [alpha.id]);
});

test('a server delete under a recovery block stays RECOVERY_REQUIRED and keeps its alias', async t => {
  const root = path.join(os.tmpdir(), `policy-registry-blocked-${crypto.randomUUID()}`);
  const serverPath = path.join(root, 'Blocked');
  const f = fixture(t, {
    recoveryBlocks: [{ operationId: 'interrupted-update', selector: { instanceId: 'server-blocked', serverPath } }]
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blocked = f.server('Blocked', { folder: serverPath, id: 'server-blocked' });
  appStore.set('instances', [blocked]);

  await assert.rejects(f.wrap('delete-instance')(EVENT, { id: blocked.id, deleteFiles: true }), code('RECOVERY_REQUIRED'));

  assert.equal(fs.existsSync(serverPath), true);
  assert.deepEqual(registered().map(instance => instance.id), [blocked.id]);
  assert.deepEqual(f.coordinator.pathBinding(serverPath), { instanceId: blocked.id });
});
