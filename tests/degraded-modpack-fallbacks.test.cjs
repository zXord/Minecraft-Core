const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDegradedModpackFallbacks } = require('../electron/bootstrap/create-degraded-modpack-fallbacks.cjs');
const { createClientConnectionCore } = require('../electron/bootstrap/create-client-connection-core.cjs');
const { createLiveInstanceResolver } = require('../electron/bootstrap/create-modpack-service-graph.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
const { ModpackStateRepository } = require('../electron/services/modpacks/state/modpack-state-repository.cjs');
const { MANIFEST_NAME } = require('../electron/services/client-modpacks/client-pack-state.cjs');
const { ClientPackTransaction } = require('../electron/services/client-modpacks/client-pack-transaction.cjs');
const { clientPackManagementFields } = require('../electron/services/client-modpacks/client-pack-management.cjs');
const { normalizeServerDirectoryPath } = require('../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const { HOST_UNREACHABLE_REASON } = require('../electron/services/management-session-transport.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');

const SERVICES_UNAVAILABLE = { code: 'MODPACK_SERVICES_UNAVAILABLE' };
const RENAME_CLIENT = Object.freeze({
  moveWriteThrough: fs.renameSync,
  replaceFileWriteThrough: fs.renameSync,
  flushDirectory() {}
});
const NOT_A_REPARSE_POINT = Object.freeze({ async isReparsePoint() { return false; } });

function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  return { volumeSerial: stat.dev.toString(16), fileId: stat.ino.toString(16) };
}

// A pack journal exactly as ClientPackTransaction keeps one for a client.
function writeJournal(userDataPath, client, phase) {
  const journalRoot = path.join(userDataPath, 'client-packs', 'transactions');
  fs.mkdirSync(journalRoot, { recursive: true });
  const transaction = new ClientPackTransaction({ journalRoot, durableFs: {}, stateStore: {} });
  const target = { clientId: client.id, clientPath: client.path };
  const record = {
    schemaVersion: 1,
    operationId: crypto.randomUUID(),
    clientId: client.id,
    clientPath: normalizeServerDirectoryPath(client.path),
    parentIdentity: directoryIdentity(path.dirname(client.path)),
    oldTree: { directoryIdentity: directoryIdentity(client.path), fingerprint: 'b'.repeat(64) },
    candidateIdentity: null,
    candidateTree: null,
    phase
  };
  const journalPath = transaction._paths(target).journalPath;
  fs.writeFileSync(journalPath, `${JSON.stringify(record, null, 2)}\n`);
  return journalPath;
}

function fixture(t, { disposalPending = () => false, recoveryGate = null, requirement = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-degraded-fallbacks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(userDataPath);
  const folder = (...parts) => {
    const value = path.join(root, ...parts);
    fs.mkdirSync(value, { recursive: true });
    return value;
  };
  const servers = {
    legacy: folder('servers', 'legacy'),
    managed: folder('servers', 'managed'),
    detached: folder('servers', 'detached'),
    corrupt: folder('servers', 'corrupt')
  };
  const writeState = (serverPath, text) => {
    fs.mkdirSync(path.join(serverPath, '.minecraft-core-state'), { recursive: true });
    fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), text);
  };
  writeState(servers.managed, '{}\n');
  writeState(servers.detached, `${JSON.stringify({
    schemaVersion: 1, modpackManaged: false, lifecycleMode: 'uninstalled',
    source: { provider: 'github', repositoryId: '1', releaseId: '2', githubOwner: 'Owner', githubRepo: 'Pack',
      version: 'v2', title: 'Pack', selectedAssetIds: ['3'], artifactSetDigest: 'a'.repeat(64) },
    runtime: null, selectedOptionalFiles: [], installedAt: '2026-08-01T00:00:00.000Z', contentRevision: 3, manifestId: null,
    provenance: { classification: 'uninstalled', inspectionFingerprint: 'f'.repeat(64) }
  }, null, 2)}\n`);
  writeState(servers.corrupt, '{ not json');
  const clients = {
    legacy: { id: 'client-legacy', type: 'client', path: folder('clients', 'legacy') },
    packed: { id: 'client-packed', type: 'client', path: folder('clients', 'packed') },
    journaled: { id: 'client-journaled', type: 'client', path: folder('clients', 'journaled') }
  };
  fs.writeFileSync(path.join(clients.packed.path, MANIFEST_NAME), '{}\n');
  const instances = [
    ...Object.entries(servers).map(([name, serverPath]) => ({ id: `server-${name}`, type: 'server', path: serverPath })),
    ...Object.values(clients)
  ];
  const store = { get: key => (key === 'instances' ? instances : null) };
  const requirementReads = [];
  const broker = {
    async readServerInfo(clientId) {
      requirementReads.push(clientId);
      if (typeof requirement === 'function') return requirement(clientId);
      return { response: { success: true, clientModpack: null }, binding: { generation: 'generation-1' } };
    },
    async acquire() { throw new Error('no session is acquired here'); },
    invalidate() {},
    dispose() {}
  };
  const core = createClientConnectionCore({ store, clock: { now: () => Date.now() }, randomUUID: crypto.randomUUID });
  t.after(() => core.dispose());
  const fallbacks = createDegradedModpackFallbacks({
    userDataPath,
    store,
    clientConnectionCore: { resolveClient: core.resolveClient, resolveClientByPath: core.resolveClientByPath, managementSessionBroker: broker },
    instanceResolver: createLiveInstanceResolver({ store, isInstanceRunning: () => false }),
    recoveryGate,
    isCompositionDisposalPending: disposalPending,
    reparseInspector: NOT_A_REPARSE_POINT
  });
  return { clients, fallbacks, requirementReads, root, servers, userDataPath };
}

test('degraded server state reads are null exactly where the strict repository reads null', async t => {
  const { fallbacks, root, servers } = fixture(t);
  const strict = new ModpackStateRepository({
    fsApi: fs,
    durableFs: createDurableFs({ fsApi: fs, durableClient: RENAME_CLIENT, allowedRoots: [path.join(root, 'servers')] })
  });
  const strictRead = serverPath => {
    try {
      return { value: strict.read(serverPath) };
    } catch (error) {
      return { error };
    }
  };

  assert.deepEqual(strictRead(servers.legacy), { value: null });
  assert.equal(fallbacks.stateRepository.read(servers.legacy), null);
  assert.equal(strictRead(servers.detached).value?.state?.modpackManaged, false, 'the detached fixture is a real detached state');
  assert.ok(strictRead(servers.corrupt).error, 'the corrupt fixture is refused by the strict read');
  for (const name of ['managed', 'detached', 'corrupt']) {
    assert.notEqual(strictRead(servers[name]).value, null);
    assert.throws(() => fallbacks.stateRepository.read(servers[name]), SERVICES_UNAVAILABLE, name);
  }
  assert.deepEqual(fallbacks.stateRepository.listHistory(servers.legacy), { items: [], nextCursor: null });

  assert.equal((await fallbacks.readServerState('server-legacy')).lifecycleMode, 'unmanaged');
  await assert.rejects(fallbacks.readServerState('server-detached'), SERVICES_UNAVAILABLE);
  await assert.rejects(fallbacks.readServerState('server-unknown'), { code: 'PLAN_STALE' });
});

test('a legacy client runs legacy, local and registry work and launches without a manifest', async t => {
  const { clients, fallbacks } = fixture(t);
  const integration = fallbacks.clientPackIntegration;
  const request = { clientId: clients.legacy.id, clientPath: clients.legacy.path };

  assert.equal(await integration.runLegacyMutation(request, async () => 'legacy-done'), 'legacy-done');
  assert.equal(await integration.runLocalMutation(request, async () => 'local-done'), 'local-done');
  assert.equal(await integration.runPersonalMutation(request, async () => 'personal-done'), 'personal-done');
  assert.equal(await integration.runRegistryMutation(request, async () => 'registry-done'), 'registry-done');
  const reservation = await integration.beginManagedLaunch({ clientPath: clients.legacy.path });
  assert.match(reservation.jvmArgument, /^-Dminecraft\.core\.clientLaunchId=/u);
  await reservation.abortBeforeSpawn();
  assert.deepEqual(fallbacks.listActiveMutations(), []);
  await integration.assertServerDestination(path.join(clients.legacy.path, 'server'));

  assert.deepEqual(await fallbacks.readClientState({ clientId: clients.legacy.id }),
    { clientId: clients.legacy.id, status: 'unmanaged', verified: false, descriptor: null });
  // The caller's own failure is never relabelled.
  const own = new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The caller failed');
  await assert.rejects(integration.runLegacyMutation(request, async () => { throw own; }), error => error === own);
});

test('a client with a manifest or an unsettled journal gives MODPACK_SERVICES_UNAVAILABLE', async t => {
  const { clients, fallbacks, userDataPath } = fixture(t);
  const integration = fallbacks.clientPackIntegration;
  writeJournal(userDataPath, clients.journaled, 'preparing');
  let ran = 0;
  for (const client of [clients.packed, clients.journaled]) {
    const request = { clientId: client.id, clientPath: client.path };
    await assert.rejects(integration.runLegacyMutation(request, async () => { ran += 1; }), SERVICES_UNAVAILABLE, client.id);
    await assert.rejects(integration.beginManagedLaunch({ clientPath: client.path }), SERVICES_UNAVAILABLE, client.id);
    await assert.rejects(fallbacks.readClientState({ clientId: client.id }), SERVICES_UNAVAILABLE, client.id);
  }
  assert.equal(ran, 0);
  await assert.rejects(integration.assertServerDestination(path.join(clients.packed.path, 'server')), SERVICES_UNAVAILABLE);
  // Another client's journal never touches a legacy client.
  assert.equal(await integration.runLegacyMutation({ clientId: clients.legacy.id, clientPath: clients.legacy.path },
    async () => 'still-works'), 'still-works');
});

test('a journaled client is refused while a failed composition is still disposing, then works again', async t => {
  let pending = true;
  const { clients, fallbacks, userDataPath } = fixture(t, { disposalPending: () => pending });
  writeJournal(userDataPath, clients.journaled, 'abandoned');
  const integration = fallbacks.clientPackIntegration;
  const journaled = { clientId: clients.journaled.id, clientPath: clients.journaled.path };
  let ran = 0;

  await assert.rejects(integration.runLegacyMutation(journaled, async () => { ran += 1; }), SERVICES_UNAVAILABLE);
  await assert.rejects(integration.beginManagedLaunch({ clientPath: clients.journaled.path }), SERVICES_UNAVAILABLE);
  await assert.rejects(fallbacks.readClientState({ clientId: clients.journaled.id }), SERVICES_UNAVAILABLE);
  assert.equal(ran, 0);
  assert.equal(await integration.runLegacyMutation({ clientId: clients.legacy.id, clientPath: clients.legacy.path },
    async () => 'legacy-during-disposal'), 'legacy-during-disposal');

  pending = false;
  assert.equal(await integration.runLegacyMutation(journaled, async () => 'after-disposal'), 'after-disposal');
  assert.equal((await fallbacks.readClientState({ clientId: clients.journaled.id })).status, 'unmanaged');
});

test('client state follows the host requirement and keeps an unreachable host a connection problem', async t => {
  const descriptor = { schemaVersion: 1, status: 'unpaired', serverFingerprint: 'c'.repeat(64), serverVersion: '1.0.0',
    source: null, runtime: null, artifactSha256: null };
  const { clients, fallbacks } = fixture(t, {
    requirement(clientId) {
      if (clientId === clients.legacy.id) return { response: { success: true, clientModpack: descriptor }, binding: { generation: 'g' } };
      throw Object.defineProperty(new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The host gave no response'),
        'reason', { value: HOST_UNREACHABLE_REASON });
    }
  });
  assert.equal((await fallbacks.readClientState({ clientId: clients.legacy.id })).status, 'unpaired');
  assert.deepEqual(await fallbacks.readClientState({ clientId: clients.journaled.id }),
    { clientId: clients.journaled.id, status: 'requirement-unavailable', verified: false, descriptor: null });
  // A host that publishes a requirement still keeps legacy writes away from this client.
  await assert.rejects(fallbacks.clientPackIntegration.runLegacyMutation(
    { clientId: clients.legacy.id, clientPath: clients.legacy.path }, async () => assert.fail('never runs')), SERVICES_UNAVAILABLE);
});

test('the degraded companion resolver answers per server: legacy null, modpack state refused', async t => {
  const { fallbacks, userDataPath } = fixture(t);
  // Another server having a companion changes nothing for a legacy server.
  fs.mkdirSync(path.join(userDataPath, 'client-packs'), { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'client-packs', 'companions.json'), '{"companions":[{"serverId":"server-managed"}]}\n');

  assert.equal(fallbacks.companionResolver('server-legacy'), null);
  assert.throws(() => fallbacks.companionResolver('server-managed'), SERVICES_UNAVAILABLE);
  assert.throws(() => fallbacks.companionResolver('server-unknown'), { code: 'INVALID_REQUEST' });

  assert.deepEqual(await clientPackManagementFields('server-legacy', fallbacks.companionResolver), { clientModpack: null });
  const managed = await clientPackManagementFields('server-managed', fallbacks.companionResolver);
  assert.equal(managed.clientModpack, null);
  assert.equal(managed.clientModpackError.code, 'CLIENT_PACK_UNAVAILABLE', 'a managed server is refused, not reported as unmanaged');
});

test('degraded recovery listing names each blocked server, or every server under a global block', async t => {
  const blocked = fixture(t, {
    recoveryGate: {
      globalBlock: false,
      blocks: [
        { operationId: 'job-by-id', selector: { instanceId: 'server-managed' } },
        { operationId: 'job-by-path', selector: { serverPath: path.join(os.tmpdir(), 'not-registered') } }
      ]
    }
  });
  const listed = blocked.fallbacks.listRecovery();
  assert.deepEqual(listed.items.map(item => [item.serverId, item.instanceId, item.stableServerId, item.automaticPossible, item.actions.length]),
    [['server-managed', 'server-managed', 'server-managed', false, 0]]);
  assert.match(listed.items[0].recoveryId, /^recovery-[a-f0-9]{32}$/u);

  const byPath = fixture(t, { recoveryGate: { globalBlock: false, blocks: [] } });
  assert.deepEqual(byPath.fallbacks.listRecovery(), { items: [] });

  const global = fixture(t, { recoveryGate: { globalBlock: true, blocks: [] } });
  assert.deepEqual(global.fallbacks.listRecovery().items.map(item => item.serverId).sort(),
    ['server-corrupt', 'server-detached', 'server-legacy', 'server-managed']);

  const unknown = fixture(t);
  assert.throws(() => unknown.fallbacks.listRecovery(), SERVICES_UNAVAILABLE, 'an unknown gate keeps every start disabled');
});
