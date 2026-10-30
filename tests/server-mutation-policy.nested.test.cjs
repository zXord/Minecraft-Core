const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// One environment per process: the settings handlers bind the app store when
// they load. Only process-wide boundaries are stubbed.
const store = new Map();
const appStore = {
  get: key => (store.has(key) ? structuredClone(store.get(key)) : undefined),
  set: (key, value) => { store.set(key, structuredClone(value)); return true; },
  delete: key => { store.delete(key); return true; }
};
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const STUBS = new Map([
  ['app-store.cjs', appStore],
  ['logger-handlers.cjs', { getLoggerHandlers: () => QUIET }],
  ['instance-context.cjs', { updateInstances() {} }],
  ['secure-store.cjs', { ensureEncryptionAvailable: () => true, packSecret: value => `packed:${value}`, unpackSecret: value => value }],
  ['servers-dat.cjs', { ensureServersDat: async () => ({ success: true }) }],
  ['port-validator.cjs', { validateServerPorts: async () => ({ valid: true }) }],
  ['server-manager.cjs', { shutdownMinecraftServer: async () => ({ success: true }) }],
  ['management-server.cjs', { stopAndDisposeManagementServers: async () => ({ success: true }) }]
]);
const originalLoad = Module._load;
Module._load = function loadWithBoundaries(request, parent, isMain) {
  const stub = typeof request === 'string' ? STUBS.get(path.posix.basename(request.replaceAll('\\', '/'))) : undefined;
  return stub || originalLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; });

const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
const { CLIENT_PACK_MANIFEST } = require('../electron/services/modpacks/instance-ownership.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { createInstanceConfigFsFactory } = require('../electron/utils/instance-config-fs.cjs');
const configManager = require('../electron/utils/config-manager.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { canonicalCoordinatorSelector } = require('../electron/services/coordinator-identity.cjs');
const { createServerMutationPolicy } = require('../electron/services/server-mutation-policy.cjs');
const { createClientPackIntegration } = require('../electron/services/client-modpacks/client-pack-integration.cjs');
const { ClientProcessGuard } = require('../electron/services/client-modpacks/client-process-guard.cjs');
const { createSettingsHandlers } = require('../electron/ipc/settings-handlers.cjs');

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

const EVENT = { sender: { id: 1 } };
const NESTED_MESSAGE = 'This server folder and a client folder are inside each other, and that client uses a matching modpack. Move the client or the server into its own separate folder.';

function registered() {
  return appStore.get('instances') || [];
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-nested-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.clear();

  const revisions = new Map();
  const revisionKey = value => path.resolve(value).toLocaleLowerCase('en-US');
  const coordinator = new ServerMutationCoordinator({
    readContentRevision: value => revisions.get(revisionKey(value)) || 0,
    bumpContentRevision(value, { expectedRevision }) {
      const current = revisions.get(revisionKey(value)) || 0;
      if (current !== expectedRevision) throw new Error('content revision compare-and-set mismatch');
      revisions.set(revisionKey(value), current + 1);
      return current + 1;
    }
  });
  coordinator.completeStartupRecovery([]);
  const guardRoot = path.join(root, 'client-processes');
  fs.mkdirSync(guardRoot);
  const resolveClient = async clientId => {
    const matches = registered().filter(instance => instance?.id === clientId && instance.type === 'client');
    if (matches.length !== 1) throw new ModpackError('INVALID_REQUEST', 'Choose a registered client instance');
    return Object.freeze({ clientId, clientPath: path.resolve(matches[0].path) });
  };
  const integration = createClientPackIntegration({
    resolveClient,
    resolveClientByPath: async () => { throw new Error('launches are not part of these layouts'); },
    processGuard: new ClientProcessGuard({
      root: guardRoot,
      durableFs: jsDurableFs([guardRoot]),
      inspectProcesses: async () => ({ complete: true, processes: [] }),
      acquireEndpointLease: async () => ({ async close() {}, assertHeld() {} })
    }),
    transaction: { status: async () => null, assertNoUnsettledAtPath: async () => {} },
    stateStore: { read: async clientPath => (fs.existsSync(path.join(clientPath, CLIENT_PACK_MANIFEST)) ? { manifest: true } : null) },
    managementClient: { readRequirement: async () => ({ descriptor: null, binding: { generation: 'nested-fixture' } }) },
    clientPackService: {}
  });
  // Records the client each client channel is held for, then holds it as production does.
  const received = [];
  const recordingIntegration = Object.freeze({
    ...integration,
    ...Object.fromEntries(['runLegacyMutation', 'runLocalMutation', 'runPersonalMutation'].map(method => [method, (target, work) => {
      received.push([method, target.clientId, target.clientPath]);
      return integration[method](target, work);
    }]))
  });
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => registered(),
    getClientPackIntegration: () => recordingIntegration,
    getModpackStateRepository: () => ({ read: async () => null }),
    createOperationId: channel => `${channel}-${crypto.randomUUID()}`
  });

  function server(folder, id) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.minecraft-core.json'), `${JSON.stringify({ version: '1.20.1', port: 25565, maxRam: 4 }, null, 2)}\n`);
    return { id, name: id, type: 'server', path: folder };
  }

  function client(folder, id) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'client-config.json'), JSON.stringify({ serverIp: '192.0.2.4', serverPort: '8080', clientId: id, clientName: id }));
    return { id, clientId: id, name: id, clientName: id, type: 'client', path: folder };
  }

  async function startAndStop(instanceId, serverPath) {
    const selector = canonicalCoordinatorSelector({ instances: registered(), selector: { instanceId, serverPath }, coordinator });
    const lease = await coordinator.acquireStart(selector, {
      operation: 'server-start', operationId: `server-start-${crypto.randomUUID()}`, parentMutationLease: null
    });
    lease.markRunning({ pid: 6161 });
    lease.release();
    return lease.instanceId;
  }

  return { root, coordinator, policy, server, client, startAndStop, received };
}

// The server writers a host uses on a server whose folder overlaps a client folder.
function serverWriters(f, srv) {
  const calls = [];
  const fake = channel => f.policy.wrapHandler(channel, async () => { calls.push(channel); return { success: true }; });
  return {
    calls,
    writes: [
      ['start-management-server', () => fake('start-management-server')(EVENT, { serverPath: srv.path, instanceId: srv.id, port: 8080 })],
      ['update-settings', () => f.policy.wrapHandler('update-settings', async (...args) => {
        calls.push('update-settings');
        return settings['update-settings'](...args);
      })(EVENT, { serverPath: srv.path, instanceId: srv.id, maxRam: 6 })],
      ['add-player', () => fake('add-player')(EVENT, 'whitelist', srv.path, 'Alex')],
      ['install-mod', () => fake('install-mod')(EVENT, srv.path, { name: 'extra.jar' })]
    ]
  };
}

for (const layout of ['client nested in the server', 'server nested in the client']) {
  function arrange(f) {
    const clientInside = layout === 'client nested in the server';
    const srv = f.server(clientInside ? path.join(f.root, 'Server') : path.join(f.root, 'Client', 'Server'), 'server-host');
    const cli = f.client(clientInside ? path.join(f.root, 'Server', 'client') : path.join(f.root, 'Client'), 'client-own');
    appStore.set('instances', [srv, cli]);
    return { srv, cli };
  }

  test(`${layout}: server writes, deletion and a reorder succeed`, async t => {
    const f = fixture(t);
    const { srv, cli } = arrange(f);
    const { calls, writes } = serverWriters(f, srv);
    for (const [channel, write] of writes) {
      const result = await write();
      assert.equal(result.success, true, `${channel}: ${result.error}`);
    }
    assert.deepEqual(calls, writes.map(([channel]) => channel));

    const reordered = await f.policy.wrapHandler('save-instances', settings['save-instances'])(EVENT, [cli, srv]);
    assert.equal(reordered.success, true, reordered.error);
    assert.deepEqual(registered().map(instance => instance.id), [cli.id, srv.id]);

    const deleted = await f.policy.wrapHandler('delete-instance', settings['delete-instance'])(EVENT, { id: srv.id, deleteFiles: false });
    assert.equal(deleted.success, true, deleted.error);
    assert.deepEqual(registered().map(instance => instance.id), [cli.id]);
  });

  test(`${layout}: a client with a matching pack refuses server writes with an explanation`, async t => {
    const f = fixture(t);
    const { srv, cli } = arrange(f);
    fs.writeFileSync(path.join(cli.path, CLIENT_PACK_MANIFEST), '{}');
    const { calls, writes } = serverWriters(f, srv);
    writes.push(['delete-instance', () => f.policy.wrapHandler('delete-instance', async () => {
      calls.push('delete-instance');
      return { success: true };
    })(EVENT, { id: srv.id, deleteFiles: true })]);
    for (const [channel, write] of writes) {
      await assert.rejects(write(), error => error?.code === 'INVALID_REQUEST' && error.message === NESTED_MESSAGE, channel);
    }
    assert.deepEqual(calls, []);

    // A reorder only edits the registry and never touches either folder.
    const reordered = await f.policy.wrapHandler('save-instances', settings['save-instances'])(EVENT, [cli, srv]);
    assert.equal(reordered.success, true, reordered.error);
  });
}

for (const order of ['server first', 'client first']) {
  test(`a server and a client sharing one folder (${order}): writes, reorder and start succeed`, async t => {
    const f = fixture(t);
    const folder = path.join(f.root, 'Shared');
    const srv = f.server(folder, 'server-shared');
    const cli = f.client(folder, 'client-shared');
    const list = order === 'server first' ? [srv, cli] : [cli, srv];
    appStore.set('instances', list);
    const { calls, writes } = serverWriters(f, srv);
    const clientWrite = () => f.policy.wrapHandler('install-client-mod', async () => { calls.push('install-client-mod'); return { success: true }; })(
      EVENT, { clientPath: folder, fileName: 'own.jar' });

    for (const round of [1, 2]) {
      for (const [channel, write] of writes) assert.equal((await write()).success, true, `${round} ${channel}`);
      assert.equal((await clientWrite()).success, true);
      assert.equal(await f.startAndStop(srv.id, folder), srv.id);
      const reordered = await f.policy.wrapHandler('save-instances', settings['save-instances'])(EVENT, [...registered()].reverse());
      assert.equal(reordered.success, true, reordered.error);
    }
    assert.equal(calls.filter(channel => channel === 'install-client-mod').length, 2);
  });
}

for (const order of ['first registration listed first', 'second registration listed first']) {
  test(`two registrations of one server folder (${order}): writes, reorder and start succeed`, async t => {
    const f = fixture(t);
    const folder = path.join(f.root, 'Twice');
    const first = f.server(folder, 'server-1');
    const second = { ...first, id: 'server-2', name: 'server-2' };
    appStore.set('instances', order === 'first registration listed first' ? [first, second] : [second, first]);

    for (const round of [1, 2]) {
      for (const srv of [first, second]) {
        const { writes } = serverWriters(f, srv);
        for (const [channel, write] of writes) assert.equal((await write()).success, true, `${round} ${srv.id} ${channel}`);
        assert.equal(await f.startAndStop(srv.id, folder), 'server-1');
      }
      const reordered = await f.policy.wrapHandler('save-instances', settings['save-instances'])(EVENT, [...registered()].reverse());
      assert.equal(reordered.success, true, reordered.error);
    }
  });
}

// A client's launch, host sync, own-content toggle and connection settings, with the
// client-pack hold each one takes (launch takes its own hold when it starts the game).
const CLIENT_CHANNELS = [
  ['minecraft-launch', null, folder => ({ clientPath: folder, username: 'Alex' })],
  ['minecraft-check-mods', 'runLegacyMutation', folder => ({ clientPath: folder, requiredMods: [] })],
  ['toggle-client-asset', 'runLocalMutation', folder => ({ clientPath: folder, assetType: 'shaderpacks', fileName: 'own.zip', enable: false })],
  ['save-client-config', 'runPersonalMutation', folder => ({ path: folder, serverIp: '192.0.2.4', serverPort: '8080' })]
];

async function runClientChannel(f, channel, payload) {
  f.received.length = 0;
  let ran = 0;
  const result = await f.policy.wrapHandler(channel, async () => { ran += 1; return { success: true }; })(EVENT, payload);
  return { success: result.success, ran, received: [...f.received] };
}

test('nested client folders each keep launch, sync, toggles and settings as their own client (v26.6.1 parity)', async t => {
  const f = fixture(t);
  const outer = f.client(path.join(f.root, 'Client'), 'client-outer');
  const inner = f.client(path.join(f.root, 'Client', 'Second'), 'client-inner');
  appStore.set('instances', [outer, inner]);

  for (const cli of [outer, inner, inner, outer]) {
    for (const [channel, method, payload] of CLIENT_CHANNELS) {
      assert.deepEqual(await runClientChannel(f, channel, payload(cli.path)),
        { success: true, ran: 1, received: method ? [[method, cli.id, cli.path]] : [] }, `${cli.id} ${channel}`);
    }
  }
});

for (const order of ['b-client listed first', 'a-client listed first']) {
  test(`a client folder registered twice (${order}) keeps every client channel, held as its lowest id`, async t => {
    const f = fixture(t);
    const folder = path.join(f.root, 'Twice');
    const later = f.client(folder, 'b-client');
    const lowest = { ...later, id: 'a-client', clientId: 'a-client', name: 'a-client', clientName: 'a-client' };
    appStore.set('instances', order === 'b-client listed first' ? [later, lowest] : [lowest, later]);

    for (const round of [1, 2]) {
      for (const [channel, method, payload] of CLIENT_CHANNELS) {
        assert.deepEqual(await runClientChannel(f, channel, payload(folder)),
          { success: true, ran: 1, received: method ? [[method, 'a-client', folder]] : [] }, `${round} ${channel}`);
      }
      // A writer that names the other registration by id is held as the same client.
      assert.deepEqual(await runClientChannel(f, 'set-download-preferences', { instanceId: 'b-client', preferences: {} }),
        { success: true, ran: 1, received: [['runPersonalMutation', 'a-client', folder]] }, `${round} set-download-preferences`);
      appStore.set('instances', [...registered()].reverse());
    }
  });
}

test('retyping a registered client as a server stays refused', async t => {
  const f = fixture(t);
  const cli = f.client(path.join(f.root, 'Client'), 'client-retype');
  appStore.set('instances', [cli]);
  let calls = 0;

  await assert.rejects(f.policy.wrapHandler('save-instances', async () => { calls += 1; return { success: true }; })(EVENT,
    [{ id: cli.id, type: 'server', name: 'retyped', path: cli.path }]), error => error?.code === 'INVALID_REQUEST');

  assert.equal(calls, 0);
  assert.deepEqual(registered(), [cli]);
});

test('a new server is initialised inside a plain client folder and registered', async t => {
  const f = fixture(t);
  const cli = f.client(path.join(f.root, 'Client'), 'client-plain');
  appStore.set('instances', [cli]);
  const folder = path.join(cli.path, 'NewServer');
  fs.mkdirSync(folder);
  const wizard = channel => f.policy.wrapHandler(channel, async () => ({ success: true }));

  assert.equal((await wizard('save-version-selection')(EVENT, { path: folder, mcVersion: '1.20.1' })).success, true);
  assert.equal((await wizard('write-eula')(EVENT, { path: folder, content: 'eula=true' })).success, true);
  const saved = await f.policy.wrapHandler('save-instances', settings['save-instances'])(EVENT,
    [cli, { id: 'server-new', type: 'server', name: 'New', path: folder }]);
  assert.equal(saved.success, true, saved.error);
  assert.deepEqual(registered().map(instance => instance.id), [cli.id, 'server-new']);

  fs.writeFileSync(path.join(cli.path, CLIENT_PACK_MANIFEST), '{}');
  const other = path.join(cli.path, 'OtherServer');
  fs.mkdirSync(other);
  await assert.rejects(wizard('write-eula')(EVENT, { path: other, content: 'eula=true' }),
    error => error?.code === 'INVALID_REQUEST' && error.message === NESTED_MESSAGE);
  await assert.rejects(f.policy.wrapHandler('save-instances', settings['save-instances'])(EVENT,
    [...registered(), { id: 'server-other', type: 'server', name: 'Other', path: other }]),
  error => error?.code === 'INVALID_REQUEST' && error.message === NESTED_MESSAGE);
});
