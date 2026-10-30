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
  // The real validator is asynchronous; yield so concurrent saves interleave.
  ['port-validator.cjs', { validateServerPorts: async () => { await new Promise(resolve => setImmediate(resolve)); return { valid: true }; } }],
  ['server-manager.cjs', { shutdownMinecraftServer: async () => ({ success: true }) }],
  ['management-server.cjs', { stopAndDisposeManagementServers: async () => ({ success: true }) }]
]);
const originalLoad = Module._load;
Module._load = function loadWithBoundaries(request, parent, isMain) {
  const stub = typeof request === 'string' ? STUBS.get(path.posix.basename(request.replaceAll('\\', '/'))) : undefined;
  return stub || originalLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; });

const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { createInstanceConfigFsFactory } = require('../electron/utils/instance-config-fs.cjs');
const configManager = require('../electron/utils/config-manager.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { canonicalCoordinatorSelector } = require('../electron/services/coordinator-identity.cjs');
const {
  SERVER_WRITER_POLICIES,
  createServerMutationPolicy
} = require('../electron/services/server-mutation-policy.cjs');
const { createSettingsHandlers } = require('../electron/ipc/settings-handlers.cjs');

configManager.configureServerConfigDurableFsFactory(createInstanceConfigFsFactory({
  strictFactory: roots => createDurableFs({
    fsApi: fs,
    durableClient: { flushDirectory() {}, moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync },
    allowedRoots: [...roots]
  })
}));
const settings = createSettingsHandlers();

const EVENT = { sender: { id: 1 } };
const SERVER_ID = 'server-alpha';
// The writers the v26.6.1 UI already disabled while the server ran.
const STOPPED_ONLY_CHANNELS = [
  'backups:restore', 'delete-instance', 'delete-world', 'download-and-install-fabric',
  'download-and-install-loader', 'download-minecraft-server', 'repair-health'
];
const MANAGEMENT_CHANNELS = [
  'regenerate-management-invite-secret', 'set-management-invite-host',
  'set-management-server-external-host', 'start-management-server'
];

function code(expected) {
  return error => error?.code === expected;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Production-shaped arguments that resolve every channel to the registered server.
function argsFor(channel, descriptor, serverPath) {
  if (channel === 'rename-instance') return [{ id: SERVER_ID, newName: 'Renamed' }];
  if (channel === 'delete-instance') return [{ id: SERVER_ID, deleteFiles: false }];
  if (descriptor.kind === 'many') return [[{ id: SERVER_ID, type: 'server', name: 'Alpha', path: serverPath }]];
  if (descriptor.selector === 'string') return [serverPath];
  if (descriptor.selector.startsWith('arg:')) {
    const index = Number.parseInt(descriptor.selector.slice('arg:'.length), 10);
    return Array.from({ length: index + 1 }, (_value, position) => (position === index ? serverPath : 'whitelist'));
  }
  const payload = {};
  for (const field of descriptor.selector.slice('payload:'.length).split('|')) {
    payload[field] = field === 'id' || field === 'instanceId' ? SERVER_ID : serverPath;
  }
  if (Object.hasOwn(payload, 'filePath')) payload.filePath = path.join(serverPath, 'mods', 'example.jar');
  if (Object.hasOwn(payload, 'modFilePath')) payload.modFilePath = path.join(serverPath, 'mods', 'example.jar');
  return [payload];
}

function wrappedChannels() {
  return Object.entries(SERVER_WRITER_POLICIES)
    .filter(([, descriptor]) => descriptor.kind === 'mutation' || descriptor.kind === 'many')
    .map(([channel, descriptor]) => ({ channel, descriptor }));
}

function fixture(t, { managed = null, repository, ordinaryWaitTimeoutMs, laneWaitTimeoutMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-running-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'Alpha');
  fs.mkdirSync(serverPath);
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), `${JSON.stringify({ version: '1.20.1', port: 25565, maxRam: 4 }, null, 2)}\n`);
  store.clear();
  appStore.set('instances', [{ id: SERVER_ID, type: 'server', name: 'Alpha', path: serverPath }]);

  const revisions = new Map();
  const revisionKey = value => path.resolve(value).toLocaleLowerCase('en-US');
  const coordinator = new ServerMutationCoordinator({
    readContentRevision: value => revisions.get(revisionKey(value)) || 0,
    bumpContentRevision(value, { expectedRevision }) {
      const current = revisions.get(revisionKey(value)) || 0;
      if (current !== expectedRevision) throw new Error('content revision compare-and-set mismatch');
      revisions.set(revisionKey(value), current + 1);
      return current + 1;
    },
    ...(ordinaryWaitTimeoutMs === undefined ? {} : { ordinaryWaitTimeoutMs })
  });
  coordinator.completeStartupRecovery([]);
  const integration = {
    async assertServerDestination() {},
    runLegacyMutation: async (_client, work) => work(),
    runLocalMutation: async (_client, work) => work(),
    runPersonalMutation: async (_client, work) => work(),
    runRegistryMutation: async (_client, work) => work()
  };
  const stateRepository = repository || { read: async () => (managed === null ? null : { state: { modpackManaged: managed } }) };
  const policyOptions = {
    coordinator,
    getInstances: () => appStore.get('instances') || [],
    // Production ids: `${channel}-${uuid}`, colons included.
    createOperationId: channel => `${channel}-${crypto.randomUUID()}`,
    ...(laneWaitTimeoutMs === undefined ? {} : { laneWaitTimeoutMs })
  };
  const policy = createServerMutationPolicy({
    ...policyOptions,
    getClientPackIntegration: () => integration,
    getModpackStateRepository: () => stateRepository
  });
  // The browser panel's own policy has no modpack-state or matching-client hooks.
  const panelPolicy = createServerMutationPolicy(policyOptions);

  async function start({ running = true, dirty = false } = {}) {
    const selector = canonicalCoordinatorSelector({
      instances: appStore.get('instances'), selector: { instanceId: SERVER_ID, serverPath }, coordinator
    });
    const lease = await coordinator.acquireStart(selector, {
      operation: 'server-start', operationId: `server-start-${crypto.randomUUID()}`, parentMutationLease: null
    });
    if (dirty) lease.markDirty();
    if (running) lease.markRunning({ pid: 5151 });
    return lease;
  }

  return { root, serverPath, coordinator, policy, panelPolicy, start, revision: () => revisions.get(revisionKey(serverPath)) || 0 };
}

async function runChannel(policy, channel, descriptor, serverPath) {
  let calls = 0;
  const handler = policy.wrapHandler(channel, async () => {
    calls += 1;
    return { success: true };
  });
  try {
    await handler(EVENT, ...argsFor(channel, descriptor, serverPath));
    return { calls, code: null };
  } catch (error) {
    return { calls, code: error?.code || 'THROWN', message: error?.message };
  }
}

test('the stopped-only and managed-only writer sets are exactly the reviewed ones', () => {
  const stoppedOnly = Object.entries(SERVER_WRITER_POLICIES)
    .filter(([, descriptor]) => descriptor.stoppedOnly === true).map(([channel]) => channel).sort();
  const managedOnly = Object.entries(SERVER_WRITER_POLICIES)
    .filter(([, descriptor]) => descriptor.stoppedOnlyWhenManaged === true).map(([channel]) => channel).sort();
  assert.deepEqual(stoppedOnly, STOPPED_ONLY_CHANNELS);
  assert.deepEqual(managedOnly, MANAGEMENT_CHANNELS);
});

test('every wrapped writer runs with production operation ids while the server is stopped', async t => {
  for (const { channel, descriptor } of wrappedChannels()) {
    const f = fixture(t);
    const outcome = await runChannel(f.policy, channel, descriptor, f.serverPath);
    assert.deepEqual({ channel, ...outcome }, { channel, calls: 1, code: null });
  }
});

test('while the server runs every writer except the stopped-only set runs', async t => {
  for (const { channel, descriptor } of wrappedChannels()) {
    const f = fixture(t);
    const run = await f.start();
    try {
      const outcome = await runChannel(f.policy, channel, descriptor, f.serverPath);
      const expected = STOPPED_ONLY_CHANNELS.includes(channel)
        ? { channel, calls: 0, code: 'SERVER_RUNNING' }
        : { channel, calls: 1, code: null };
      assert.deepEqual({ channel, calls: outcome.calls, code: outcome.code }, expected);
    } finally {
      run.release();
    }
  }
});

test('management writers on a modpack-managed server need it stopped through IPC and the panel policy', async t => {
  for (const channel of MANAGEMENT_CHANNELS) {
    const descriptor = SERVER_WRITER_POLICIES[channel];
    const f = fixture(t, { managed: true });
    const run = await f.start();
    try {
      assert.deepEqual(await runChannel(f.policy, channel, descriptor, f.serverPath), {
        calls: 0, code: 'SERVER_RUNNING', message: 'The server must be stopped before this operation can continue'
      });
      // Without modpack state the panel's own policy fails closed.
      assert.equal((await runChannel(f.panelPolicy, channel, descriptor, f.serverPath)).code, 'SERVER_RUNNING');
    } finally {
      run.release();
    }
    assert.deepEqual(await runChannel(f.policy, channel, descriptor, f.serverPath), { calls: 1, code: null });
  }
});

test('management writers fail closed while running when the modpack state cannot be read', async t => {
  const f = fixture(t, { repository: { read: async () => { throw new Error('state unreadable'); } } });
  const run = await f.start();
  try {
    const outcome = await runChannel(f.policy, 'start-management-server', SERVER_WRITER_POLICIES['start-management-server'], f.serverPath);
    assert.equal(outcome.code, 'SERVER_RUNNING');
    assert.equal(outcome.calls, 0);
  } finally {
    run.release();
  }
});

test('a server that becomes managed before its management write is admitted needs it stopped', async t => {
  const reads = [null, { state: { modpackManaged: true } }];
  const f = fixture(t, { repository: { read: async () => (reads.length > 1 ? reads.shift() : reads[0]) } });
  const run = await f.start();
  try {
    const outcome = await runChannel(f.policy, 'set-management-invite-host', SERVER_WRITER_POLICIES['set-management-invite-host'], f.serverPath);
    assert.equal(outcome.code, 'SERVER_RUNNING');
    assert.equal(outcome.calls, 0);
  } finally {
    run.release();
  }
});

test('a dirty write while the server runs never blocks the next start', async t => {
  const f = fixture(t);
  const run = await f.start();
  const write = f.policy.wrapHandler('update-settings', async () => ({ success: true }));
  assert.deepEqual(await write(EVENT, { serverPath: f.serverPath, instanceId: SERVER_ID, maxRam: 6 }), { success: true });
  // The running server changes something itself before it stops.
  run.markDirty();
  run.release();

  const next = await f.start();
  next.release();
  assert.equal(f.revision(), 2);
});

test('two concurrent settings toggles both persist', async t => {
  const f = fixture(t);
  const update = f.policy.wrapHandler('update-settings', settings['update-settings']);

  const results = await Promise.all([
    update(EVENT, { serverPath: f.serverPath, instanceId: SERVER_ID, port: 25565, autoStartMinecraft: true }),
    update(EVENT, { serverPath: f.serverPath, instanceId: SERVER_ID, port: 25565, autoStartManagement: true })
  ]);

  assert.deepEqual(results.map(result => result.success), [true, true]);
  const config = JSON.parse(fs.readFileSync(path.join(f.serverPath, '.minecraft-core.json'), 'utf8'));
  assert.equal(config.autoStartMinecraft, true);
  assert.equal(config.autoStartManagement, true);
});

test('a read-modify-write lane wait is bounded', async t => {
  const f = fixture(t, { laneWaitTimeoutMs: 40 });
  const entered = deferred();
  const gate = deferred();
  const slow = f.policy.wrapHandler('write-config', async () => {
    entered.resolve();
    await gate.promise;
    return { success: true };
  })(EVENT, { serverPath: f.serverPath, config: {} });
  await entered.promise;
  let calls = 0;
  try {
    await assert.rejects(
      f.policy.wrapHandler('update-settings', async () => { calls += 1; return { success: true }; })(EVENT,
        { serverPath: f.serverPath, instanceId: SERVER_ID, maxRam: 5 }),
      code('OPERATION_IN_PROGRESS')
    );
    // Writers outside that lane share the folder.
    let players = 0;
    await f.policy.wrapHandler('add-player', async () => { players += 1; return []; })(EVENT, 'whitelist', f.serverPath, 'Alex');
    assert.equal(players, 1);
  } finally {
    gate.resolve();
    await slow;
  }
  assert.equal(calls, 0);
});

async function holdRestore(f) {
  const entered = deferred();
  const gate = deferred();
  const restore = f.policy.wrapHandler('backups:restore', async () => {
    entered.resolve();
    await gate.promise;
    return { success: true };
  })(EVENT, { serverPath: f.serverPath, name: 'backup.zip' });
  await entered.promise;
  return { release: () => { gate.resolve(); return restore; } };
}

test('a writer queued behind a stopped-only restore runs once the restore finishes', async t => {
  const f = fixture(t);
  const restore = await holdRestore(f);
  let calls = 0;
  const queued = f.policy.wrapHandler('add-player', async () => { calls += 1; return []; })(EVENT, 'whitelist', f.serverPath, 'Alex');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  await restore.release();
  assert.deepEqual(await queued, []);
  assert.equal(calls, 1);
});

test('a writer queued behind a stopped-only restore gives up after the ordinary wait bound', async t => {
  const f = fixture(t, { ordinaryWaitTimeoutMs: 40 });
  const restore = await holdRestore(f);
  let calls = 0;
  try {
    await assert.rejects(
      f.policy.wrapHandler('add-player', async () => { calls += 1; return []; })(EVENT, 'whitelist', f.serverPath, 'Alex'),
      code('OPERATION_IN_PROGRESS')
    );
  } finally {
    await restore.release();
  }
  assert.equal(calls, 0);
});
