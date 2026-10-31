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
// client resolution, client-pack integration and client process guard are real.
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
const { createClientConnectionCore } = require('../electron/bootstrap/create-client-connection-core.cjs');
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
  // A test may make each client hold wait, to act while an edit takes its holds.
  let endpointGate = null;
  const guard = new ClientProcessGuard({
    root: guardRoot,
    durableFs: jsDurableFs([guardRoot]),
    inspectProcesses: async () => ({ complete: true, processes: [] }),
    acquireEndpointLease: async () => {
      await endpointGate?.();
      return { async close() {}, assertHeld() {} };
    }
  });
  const core = createClientConnectionCore({ store: appStore, clock: { now: () => Date.now() }, randomUUID: crypto.randomUUID });
  t.after(() => core.dispose());
  // Folders whose client-pack transaction is unsettled (an interrupted publication).
  const unsettled = new Set();
  const integration = createClientPackIntegration({
    resolveClient: core.resolveClient,
    resolveClientByPath: async () => { throw new Error('the registry path never resolves launches'); },
    processGuard: guard,
    transaction: {
      status: async () => null,
      async assertNoUnsettledAtPath(clientPath) {
        if (unsettled.has(path.resolve(clientPath))) throw new ModpackError('RECOVERY_REQUIRED', 'Unsettled client pack transaction');
      }
    },
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

  // A client folder the user copied: its client-config.json, so its client id, comes along.
  function copyClient(original, name) {
    const folder = path.join(root, name);
    fs.cpSync(original.path, folder, { recursive: true });
    return { ...original, path: folder };
  }

  return {
    root, coordinator, guard, integration, policy, wrap, server, client, copyClient, start, holdLifecycle, unsettled,
    gateClientHolds: gate => { endpointGate = gate; }
  };
}

function clientName(folder) {
  return JSON.parse(fs.readFileSync(path.join(folder, 'client-config.json'), 'utf8')).clientName;
}

// A keep-files client delete that waits for a server sharing one of its folders names that server.
function runningBeside(serverName) {
  const message = serverName === null
    ? 'This client\'s folder is also used by a running server. Stop it, then remove the client again; your files are kept.'
    : `This client's folder is also used by the running server '${serverName}'. Stop it, then remove the client again; your files are kept.`;
  return error => error?.code === 'SERVER_RUNNING' && error.message === message;
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
  assert.equal(f.coordinator.pathBinding(keep.path), null, 'the removed registration is forgotten');

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

test('a client in a running server\'s own folder is deleted keeping its files; with its files once the server stops', async t => {
  const f = fixture(t);
  const alpha = f.server('Alpha');
  const me = f.client('Me', { folder: alpha.path });
  appStore.set('instances', [alpha, me]);
  const run = await f.start(alpha.id, alpha.path);

  try {
    // Owner decision Q7: the files are the running server's folder.
    await assert.rejects(f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: true }), code('SERVER_RUNNING'));
    assert.deepEqual(registered().map(instance => instance.id), [alpha.id, me.id]);
    const kept = await f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: false });
    assert.equal(kept.success, true, kept.error);
    const updated = await f.wrap('update-settings')(EVENT, { serverPath: alpha.path, instanceId: alpha.id, maxRam: 5 });
    assert.equal(updated.success, true, updated.error);
  } finally {
    run.release();
  }
  assert.deepEqual(registered().map(instance => instance.id), [alpha.id]);
  assert.equal(fs.existsSync(path.join(alpha.path, 'client-config.json')), true, 'keeping the files deletes nothing');
  assert.deepEqual(f.coordinator.pathBinding(alpha.path), { instanceId: alpha.id });

  appStore.set('instances', [alpha, me]);
  const removed = await f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: true });
  assert.equal(removed.success, true, removed.error);
  assert.equal(fs.existsSync(alpha.path), false, 'with the server stopped the folder is deleted as in v26.6.1');
});

test('a client whose id is bound to the folder of a server added later still needs that server stopped to be deleted', async t => {
  const f = fixture(t);
  const me = f.client('Me');
  appStore.set('instances', [me]);
  // The client is used first, so its id is the folder's coordinator identity.
  assert.deepEqual(await f.policy.wrapHandler('minecraft-launch', async () => ({ success: true }))(EVENT, { clientPath: me.path }),
    { success: true });
  const alpha = f.server('Alpha', { folder: me.path });
  assert.equal((await f.wrap('save-instances')(EVENT, [me, alpha])).success, true);
  assert.deepEqual(f.coordinator.pathBinding(me.path), { instanceId: me.id });
  const run = await f.start(alpha.id, alpha.path);

  try {
    // Its binding can only be released while the folder is idle; the running
    // server's own writers would otherwise be refused until it stopped.
    await assert.rejects(f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: false }), runningBeside('Alpha'));
    // A server name that is no safe message text is left out.
    appStore.set('instances', registered().map(instance => (instance.id === alpha.id ? { ...instance, name: 'Alpha/2' } : instance)));
    await assert.rejects(f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: false }), runningBeside(null));
    const updated = await f.wrap('update-settings')(EVENT, { serverPath: alpha.path, instanceId: alpha.id, maxRam: 5 });
    assert.equal(updated.success, true, updated.error);
  } finally {
    run.release();
  }
  const kept = await f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: false });
  assert.equal(kept.success, true, kept.error);
  assert.equal(f.coordinator.pathBinding(alpha.path), null);
  const updated = await f.wrap('update-settings')(EVENT, { serverPath: alpha.path, instanceId: alpha.id, maxRam: 6 });
  assert.equal(updated.success, true, updated.error);
  (await f.start(alpha.id, alpha.path)).release();
  assert.deepEqual(f.coordinator.pathBinding(alpha.path), { instanceId: alpha.id });
});

test('two folders registered under one client id (a copied client) are renamed and deleted as in v26.6.1', async t => {
  const f = fixture(t);
  const original = f.client('Friend', { id: 'client-copied' });
  const copy = f.copyClient(original, 'Friend - Copy');
  appStore.set('instances', [original, copy]);
  // Launching the copy binds the shared id to the copy's folder.
  assert.deepEqual(await f.policy.wrapHandler('minecraft-launch', async () => ({ success: true }))(EVENT, { clientPath: copy.path }),
    { success: true });
  assert.deepEqual(f.coordinator.pathBinding(copy.path), { instanceId: copy.id });

  // v26.6.1 renames the first registration with the id, in its own folder.
  const renamed = await f.wrap('rename-instance')(EVENT, { id: copy.id, newName: 'Original' });
  assert.equal(renamed.success, true, renamed.error);
  assert.deepEqual(registered().map(instance => [instance.path, instance.name]), [[original.path, 'Original'], [copy.path, 'Friend']]);
  assert.deepEqual([clientName(original.path), clientName(copy.path)], ['Original', 'Friend']);
  // Moved above the original in the sidebar, the copy is the one renamed.
  appStore.set('instances', [...registered()].reverse());
  const renamedCopy = await f.wrap('rename-instance')(EVENT, { id: copy.id, newName: 'Copy' });
  assert.equal(renamedCopy.success, true, renamedCopy.error);
  assert.deepEqual(registered().map(instance => [instance.path, instance.name]), [[copy.path, 'Copy'], [original.path, 'Original']]);
  assert.deepEqual([clientName(original.path), clientName(copy.path)], ['Original', 'Copy']);

  // A delete removes every registration with the id; with files, only the first one's folder.
  const deleted = await f.wrap('delete-instance')(EVENT, { id: copy.id, deleteFiles: true });
  assert.equal(deleted.success, true, deleted.error);
  assert.deepEqual(registered(), []);
  assert.equal(fs.existsSync(copy.path), false);
  assert.equal(clientName(original.path), 'Original');
  assert.equal(f.coordinator.pathBinding(copy.path), null, 'the removed id is forgotten');

  const second = f.copyClient(original, 'Friend - Second');
  appStore.set('instances', [original, second]);
  assert.deepEqual(await f.policy.wrapHandler('minecraft-launch', async () => ({ success: true }))(EVENT, { clientPath: second.path }),
    { success: true });
  const kept = await f.wrap('delete-instance')(EVENT, { id: original.id, deleteFiles: false });
  assert.equal(kept.success, true, kept.error);
  assert.deepEqual(registered(), []);
  assert.deepEqual([original.path, second.path].map(folder => fs.existsSync(path.join(folder, 'client-config.json'))), [true, true]);
  assert.equal(f.coordinator.pathBinding(second.path), null, 'the other copy\'s binding is forgotten too');
});

test('a copied client delete waits for a server running in a later copy\'s folder bound to that id, then retires it', async t => {
  const f = fixture(t);
  const original = f.client('Friend', { id: 'client-copied' });
  const copy = f.copyClient(original, 'Friend - Copy');
  appStore.set('instances', [original, copy]);
  // Launching the copy binds the shared id to its folder; a server is then created there.
  assert.deepEqual(await f.policy.wrapHandler('minecraft-launch', async () => ({ success: true }))(EVENT, { clientPath: copy.path }),
    { success: true });
  const alpha = f.server('Alpha', { folder: copy.path });
  assert.equal((await f.wrap('save-instances')(EVENT, [original, copy, alpha])).success, true);
  assert.deepEqual(f.coordinator.pathBinding(copy.path), { instanceId: copy.id });
  const run = await f.start(alpha.id, alpha.path);

  try {
    // The delete removes the copy's registration too, whose binding the running server holds.
    await assert.rejects(f.wrap('delete-instance')(EVENT, { id: original.id, deleteFiles: false }), runningBeside('Alpha'));
    await assert.rejects(f.wrap('delete-instance')(EVENT, { id: original.id, deleteFiles: true }), code('SERVER_RUNNING'));
    assert.deepEqual(registered().map(instance => instance.path), [original.path, copy.path, alpha.path]);
    assert.equal(fs.existsSync(path.join(original.path, 'client-config.json')), true);
    const updated = await f.wrap('update-settings')(EVENT, { serverPath: alpha.path, instanceId: alpha.id, maxRam: 5 });
    assert.equal(updated.success, true, updated.error);
  } finally {
    run.release();
  }

  // Once the server is stopped the delete goes through and the folder becomes the server's.
  const kept = await f.wrap('delete-instance')(EVENT, { id: original.id, deleteFiles: false });
  assert.equal(kept.success, true, kept.error);
  assert.deepEqual(registered().map(instance => instance.id), [alpha.id]);
  assert.equal(f.coordinator.pathBinding(copy.path), null);
  const updated = await f.wrap('update-settings')(EVENT, { serverPath: alpha.path, instanceId: alpha.id, maxRam: 6 });
  assert.equal(updated.success, true, updated.error);
  assert.deepEqual(f.coordinator.pathBinding(alpha.path), { instanceId: alpha.id });
});

test('a copied client delete held back by a server names the running server, wherever it runs', async t => {
  const f = fixture(t);
  const original = f.client('Friend', { id: 'client-copied' });
  const copy = f.copyClient(original, 'Friend - Copy');
  const alpha = f.server('Alpha', { folder: original.path });
  appStore.set('instances', [original, copy, alpha]);
  assert.deepEqual(await f.policy.wrapHandler('minecraft-launch', async () => ({ success: true }))(EVENT, { clientPath: copy.path }),
    { success: true });
  const beta = f.server('Beta', { folder: copy.path });
  assert.equal((await f.wrap('save-instances')(EVENT, [original, copy, alpha, beta])).success, true);

  // The copy's folder is bound to the client's id, so the delete holds it with the
  // original's folder and waits for every server running in either.
  for (const [running, name] of [[alpha, 'Alpha'], [beta, 'Beta']]) {
    const run = await f.start(running.id, running.path);
    try {
      await assert.rejects(f.wrap('delete-instance')(EVENT, { id: original.id, deleteFiles: false }), runningBeside(name), name);
    } finally {
      run.release();
    }
  }
  const kept = await f.wrap('delete-instance')(EVENT, { id: original.id, deleteFiles: false });
  assert.equal(kept.success, true, kept.error);
  assert.deepEqual(registered().map(instance => instance.id), [alpha.id, beta.id]);
});

test('a client registration that names no absolute folder is skipped, and refused when the edit acts on it', async t => {
  const f = fixture(t);
  const me = f.client('Me');
  const stray = { ...me, path: 'policy-registry-stray-client' };
  // Listed after a registration with a folder, the stray entry is only removed with it, as in v26.6.1.
  appStore.set('instances', [me, stray]);
  const renamed = await f.wrap('rename-instance')(EVENT, { id: me.id, newName: 'Renamed' });
  assert.equal(renamed.success, true, renamed.error);
  assert.equal(clientName(me.path), 'Renamed');
  const kept = await f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: false });
  assert.equal(kept.success, true, kept.error);
  assert.deepEqual(registered(), []);

  // Listed first, it is the registration the handler would act on: refused, and nothing is touched.
  appStore.set('instances', [stray, me]);
  for (const edit of [
    () => f.wrap('rename-instance')(EVENT, { id: me.id, newName: 'Stray' }),
    () => f.wrap('delete-instance')(EVENT, { id: me.id, deleteFiles: true })
  ]) {
    await assert.rejects(edit(), code('INVALID_REQUEST'));
  }
  assert.deepEqual(registered().map(instance => instance.path), [stray.path, me.path]);
  assert.equal(clientName(me.path), 'Renamed');
});

test('copies whose folder names differ only in Unicode form are each held when the client is deleted', async t => {
  const f = fixture(t);
  const original = f.client('Caf\u00e9', { id: 'client-copied' });
  if (fs.existsSync(path.join(f.root, 'Cafe\u0301'))) {
    t.skip('this file system treats both Unicode forms as one name');
    return;
  }
  const copy = f.copyClient(original, 'Cafe\u0301');
  appStore.set('instances', [original, copy]);
  let holds = 0;
  f.gateClientHolds(async () => { holds += 1; });

  const kept = await f.wrap('delete-instance')(EVENT, { id: original.id, deleteFiles: false });
  assert.equal(kept.success, true, kept.error);
  assert.equal(holds, 2, 'every folder client resolution tells apart is held');
  assert.deepEqual(registered(), []);
});

test('a copied client keeps its registrations while either copy has an unsettled pack transaction', async t => {
  const f = fixture(t);
  const original = f.client('Friend', { id: 'client-copied' });
  const copy = f.copyClient(original, 'Friend - Copy');
  appStore.set('instances', [original, copy]);
  f.unsettled.add(copy.path);

  // A delete removes the copy's registration too, which its recovery needs.
  for (const deleteFiles of [false, true]) {
    await assert.rejects(f.wrap('delete-instance')(EVENT, { id: original.id, deleteFiles }), code('RECOVERY_REQUIRED'));
  }
  assert.deepEqual(registered().map(instance => instance.path), [original.path, copy.path]);
  assert.deepEqual([original.path, copy.path].map(folder => fs.existsSync(path.join(folder, 'client-config.json'))), [true, true]);
  // A rename changes only the first registration; the copy itself stays refused.
  assert.equal((await f.wrap('rename-instance')(EVENT, { id: original.id, newName: 'Renamed' })).success, true);
  appStore.set('instances', [...registered()].reverse());
  await assert.rejects(f.wrap('rename-instance')(EVENT, { id: copy.id, newName: 'Refused' }), code('RECOVERY_REQUIRED'));
  assert.deepEqual([clientName(original.path), clientName(copy.path)], ['Renamed', 'Friend']);
});

test('a copied client delete never removes a registration added while it took its holds', async t => {
  const f = fixture(t);
  const original = f.client('Friend', { id: 'client-copied' });
  const copy = f.copyClient(original, 'Friend - Copy');
  appStore.set('instances', [original, copy]);
  const entered = deferred();
  const gate = deferred();
  f.gateClientHolds(async () => {
    entered.resolve();
    await gate.promise;
  });

  const deleting = f.wrap('delete-instance')(EVENT, { id: original.id, deleteFiles: false });
  await entered.promise;
  const third = f.copyClient(original, 'Friend - Third');
  appStore.set('instances', [...registered(), third]);
  f.gateClientHolds(null);
  gate.resolve();

  await assert.rejects(deleting, code('OPERATION_IN_PROGRESS'));
  assert.deepEqual(registered().map(instance => instance.path), [original.path, copy.path, third.path]);
});

test('a client folder registered twice renames and deletes each registration on its own (v26.6.1)', async t => {
  const f = fixture(t);
  const later = f.client('Twice', { id: 'client-b' });
  const lowest = { ...later, id: 'client-a', clientId: 'client-a', name: 'client-a', clientName: 'client-a' };
  appStore.set('instances', [later, lowest]);

  const renamed = await f.wrap('rename-instance')(EVENT, { id: later.id, newName: 'Later' });
  assert.equal(renamed.success, true, renamed.error);
  assert.deepEqual(registered().map(instance => [instance.id, instance.name]), [[later.id, 'Later'], [lowest.id, 'client-a']]);
  const kept = await f.wrap('delete-instance')(EVENT, { id: later.id, deleteFiles: false });
  assert.equal(kept.success, true, kept.error);
  assert.deepEqual(registered().map(instance => instance.id), [lowest.id]);
  assert.equal(fs.existsSync(path.join(later.path, 'client-config.json')), true);

  assert.equal((await f.wrap('rename-instance')(EVENT, { id: lowest.id, newName: 'Lowest' })).success, true);
  const removed = await f.wrap('delete-instance')(EVENT, { id: lowest.id, deleteFiles: true });
  assert.equal(removed.success, true, removed.error);
  assert.deepEqual(registered(), []);
  assert.equal(fs.existsSync(later.path), false);
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
