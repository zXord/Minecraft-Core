const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
// A missing production injection must fail inertly even during RED, never start CIM.
const inspectorModule = require('../../electron/services/client-modpacks/client-process-inspector.cjs');
const originalInspectorFactory = inspectorModule.createClientProcessInspector;
let deniedSystemProbes = 0;
inspectorModule.createClientProcessInspector = () => async () => { deniedSystemProbes++; throw new Error('fixture forbids system process inspection'); };
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { ModpackStateRepository } = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');
const { createClientPackComposition } = require('../../electron/bootstrap/create-client-pack-composition.cjs');
const { clientPackManagementFields } = require('../../electron/services/client-modpacks/client-pack-management.cjs');
const { createServerProcessRunner } = require('../../electron/services/server-process-runner.cjs');
inspectorModule.createClientProcessInspector = originalInspectorFactory;

const savedHttpConfig = Object.freeze({ serverProtocol: 'http', serverIp: 'saved.test', serverPort: '8443', clientId: 'remote-client',
  clientName: 'Synthetic', inviteSecret: 'private', sessionToken: 'saved-token' });
// A v26.6.1 host: success and no matching pack fields.
const legacyHostInfo = async () => ({ statusCode: 200, body: { success: true } });

// Independently hashed, hand-specified canonical identity for the fixture below;
// never derive the expected fingerprint with serverPackFingerprint.
const fingerprint = 'a483152d67a62ce78f4bfb9fd2ee9846469060a21b9dc02a4111d31b88067585';
const unexpected = () => assert.fail('Status and asset listing must not acquire or prepare artifacts');

async function fixture(t, { managed = true, missing = false, managedJar = false, client = false, readClientConfig,
  processEvidenceFactory, managementSessionRequestJson, serverAlias = false, clientFields = {}, getPinnedHttpsAgent,
  clientConnectionCore, clock = { now: () => 0 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-client-composition-'));
  const serverPath = path.join(root, 'registered-server');
  fs.mkdirSync(serverPath);
  // An alias registers the server through a junction to its real folder.
  const registeredServerPath = serverAlias ? path.join(root, 'registered-server-link') : serverPath;
  if (serverAlias) fs.symlinkSync(serverPath, registeredServerPath, 'junction');
  if (managedJar) { fs.mkdirSync(path.join(serverPath, 'mods')); fs.writeFileSync(path.join(serverPath, 'mods/expected.jar'), 'pack'); }
  let composition;
  t.after(async () => {
    try { await composition?.dispose(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  // Keep production bounded/atomic filesystem behavior; substitute only native durability.
  const durableClient = {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    async moveWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
    async flushDirectoryAsync() {}
  };
  const durableFsFactory = allowedRoots => createDurableFs({ allowedRoots, durableClient });
  const repositoryFs = Object.create(fs);
  const repository = new ModpackStateRepository({ fsApi: repositoryFs, durableFs: durableFsFactory([root]) });
  if (!missing) repository.writeCandidate(serverPath, {
    schemaVersion: 1, modpackManaged: managed,
    source: { provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Pack-Team', githubRepo: 'Pack',
      version: 'v1', title: 'Pack', selectedAssetIds: ['10'], artifactSetDigest: 'a'.repeat(64) },
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' },
    selectedOptionalFiles: [], installedAt: '2026-10-08T00:00:00.000Z', contentRevision: 1,
    manifest: { schemaVersion: 1, installationId: 'install-one', entries: managedJar ? [{
      path: 'mods/expected.jar', pathKey: 'mods/expected.jar', origin: 'pack', managementPolicy: 'replaceable-managed',
      role: 'mod', size: '4', installedHash: '4862f447f2c7f272fa2f4aaf89dadb3b1ac09105bd5864f8d1a0c9452bb0a226', priorBaseline: null
    }] : [] }
  });
  // The legacy summary is not an authority for managed status or release identity.
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({ modpackManaged: true, modpackVersion: 'wrong-summary-version', modpackReleaseId: '999' }));
  const workspaceRegistry = { createStagingOutput: unexpected, resolveOwnedWorkspace: unexpected, releaseOwner: unexpected };
  const instances = [{ id: 'server-one', type: 'server', path: registeredServerPath }];
  const clientPath = path.join(root, 'registered-client');
  if (client) { fs.mkdirSync(clientPath); instances.push({ id: 'local-client', type: 'client', path: clientPath, ...clientFields }); }
  const evidence = processEvidenceFactory ? await processEvidenceFactory({ root, serverPath, clientPath }) : {};
  composition = createClientPackComposition({
    userDataPath: path.join(root, 'app-data'),
    store: { get(key) { assert.equal(key, 'instances'); return instances; } },
    readClientConfig,
    managementSessionRequestJson,
    getPinnedHttpsAgent,
    clientConnectionCore,
    clientProcessInspector: async () => ({ complete: true, processes: [] }),
    ...evidence,
    clientDurableFsFactory: durableFsFactory,
    clientWorkerDurableConfig: { workerPath: path.join(root, 'ArchiveWorker.exe'), workerManifestPath: path.join(root, 'manifest.json'), appOwnedRoot: root },
    stateRepository: repository,
    coordinator: { runMutation: unexpected },
    providers: { github: {
      async getRepositoryIdentity(url) {
        assert.equal(url, 'https://github.com/Pack-Team/Pack');
        return { repositoryId: '123', visibility: 'public' };
      },
      async listUploadedAssets(selector) {
        assert.deepEqual(selector, { repositoryId: '123', releaseId: '456' });
        return { repositoryId: '123', releaseId: '456', assets: [
          { assetId: '20', fileName: 'client.mrpack', size: '42', state: 'uploaded' },
          { assetId: '10', fileName: 'server.zip', size: '100', state: 'uploaded' },
          { assetId: '30', fileName: 'unfinished.mrpack', size: '60', state: 'new' }
        ] };
      }
    } },
    sourceResolver: { resolveArtifactSetPlan: unexpected }, artifactAcquisition: { downloadSet: unexpected },
    archiveInspector: { inspectArchive: unexpected, materializer: { workspaceRegistry } },
    workspaceRegistry,
    archiveExtractor: { extractArchive: unexpected, materializer: { loadInspection: unexpected } },
    artifactDownloader: { downloadPart: unexpected }, artifactCache: { pathForSha256: unexpected },
    candidateHashService: { hashFile: unexpected, async dispose() {} },
    reparseInspector: { async isReparsePoint() { return false; } }, randomUUID: crypto.randomUUID, clock
  });
  await composition.initialize();
  return { service: composition.companionService, composition, instances, clientPath, repository, repositoryFs, serverPath,
    registeredServerPath, evidence };
}

for (const provider of ['exact', 'absent', 'failed']) test(`evidence composition ${provider} server proof controls matching-client guarded launch`, async t => {
  const initialDeniedProbes = deniedSystemProbes;
  const config = { serverProtocol: 'http', serverIp: 'inert.invalid', serverPort: '8443', clientId: 'fixture-remote',
    clientName: 'Inert fixture', inviteSecret: 'fixture-only', sessionToken: 'fixture-only' };
  const f = await fixture(t, { client: true, readClientConfig: async () => config,
    managementSessionRequestJson: async () => ({ statusCode: 200, body: { clientModpack: null } }),
    async processEvidenceFactory({ root, serverPath }) {
      const owner = { pid: process.pid, parentPid: process.ppid, name: 'node.exe', creationTime: 'fixture-main', executablePath: process.execPath, commandLine: 'node inert-composition' };
      let row;
      const child = new EventEmitter(); child.pid = 5700; child.exitCode = null; child.signalCode = null; child.killed = false;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => assert.fail('composition proof must not kill a healthy server');
      const eventBus = new EventEmitter(); eventBus.on('server-process-owned', value => value.acknowledge({ ...value, ready: Promise.resolve() }));
      const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' };
      const runner = createServerProcessRunner({ eventBus, supervisionRequired: () => true,
        captureLaunchRoot: value => Object.freeze({ canonicalPath: value, identity: 'fixture-server-object' }),
        inspectProcesses: async () => ({ complete: true, processes: [owner, row] }),
        resolveLaunchPlan: () => ({ type: 'forge', loader: 'forge', runtime, jar: null, cwd: serverPath,
          args: ['@user_jvm_args.txt', '@libraries/win_args.txt', 'nogui'], readyMarkers: ['READY'], fatalMarkers: ['FATAL'] }),
        spawnProcess(file, args) { row = { pid: child.pid, parentPid: process.pid, name: 'java.exe', creationTime: 'fixture-server-start',
          executablePath: file, commandLine: `"${file}" ${args.join(' ')}` }; return child; }
      });
      const handle = runner.launchServerProcess({ instanceId: 'server-one', operationId: 'composition-fixture', javaPath: path.join(root, 'java.exe'),
        serverPath, runtime, maxRam: 4, publishEvents: false, onLine() {} });
      t.after(() => child.emit('close', 0, null)); await new Promise(resolve => setImmediate(resolve));
      return { clientProcessInspector: async () => ({ complete: true, processes: [owner, row] }),
        isCurrentUnrelatedServer: provider === 'exact' ? runner.isCurrentUnrelatedServer : provider === 'failed' ? () => { throw new Error('evidence unavailable'); } : undefined,
        handle };
    }
  });
  const integration = f.composition.clientPackIntegration;
  // A47: a client without matching pack evidence takes no process scan, so the
  // server proof only decides the strict client-pack operations.
  assert.equal(await integration.runPersonalMutation({ clientId: 'local-client', clientPath: f.clientPath }, () => 'personal admitted'), 'personal admitted');
  const launch = await integration.beginManagedLaunch({ clientPath: f.clientPath }); await launch.abortBeforeSpawn();
  if (provider === 'exact') {
    assert.equal((await f.composition.clientPackService.cleanup({ clientId: 'local-client' })).status, 'complete');
    assert.equal(f.evidence.handle.isLive(), true);
  } else {
    await assert.rejects(f.composition.clientPackService.cleanup({ clientId: 'local-client' }), { code: 'RECOVERY_REQUIRED' });
  }
  assert.equal(deniedSystemProbes, initialDeniedProbes, 'composition must consume the inert inspector injection');
});

test('legacy composition hook resolves only the registered path and refuses replacement before dispatch', async t => {
  const config = { serverProtocol: 'https', serverIp: 'saved.test', serverPort: '8443', managementCertFingerprint: 'a'.repeat(64),
    clientId: 'remote-client', clientName: 'Synthetic', inviteSecret: 'private', sessionToken: 'saved-token' };
  const f = await fixture(t, { client: true, readClientConfig: async () => ({ ...config }) });
  const context = await f.composition.acquireLegacyManagementContext(f.clientPath);
  assert.equal(context.baseOrigin, 'https://saved.test:8443'); assert.equal(context.sessionToken, 'saved-token');
  assert.equal(context.managementCertFingerprint, 'a'.repeat(64)); assert.equal(Object.isFrozen(context), true);
  await assert.rejects(f.composition.acquireLegacyManagementContext(path.join(f.clientPath, 'unregistered')), { code: 'INVALID_REQUEST' });
  f.instances.find(item => item.id === 'local-client').path = path.join(f.clientPath, 'replacement');
  await assert.rejects(context.assertCurrent(), { code: 'PLAN_STALE' });
});

test('production composition exposes an unpaired descriptor from the managed repository envelope', async t => {
  const { service } = await fixture(t);
  assert.deepEqual(await service.getStatus({ serverId: 'server-one' }), {
    schemaVersion: 1, status: 'unpaired', serverFingerprint: fingerprint, serverVersion: 'v1',
    source: null, runtime: null, artifactSha256: null
  });
});

test('actual composition refuses drift from real envelope and returns original identity after restoration', async t => {
  const { service, serverPath } = await fixture(t, { managedJar: true });
  const original = await service.getStatus({ serverId: 'server-one' });
  const jar = path.join(serverPath, 'mods/expected.jar'); fs.writeFileSync(jar, 'evil');
  await assert.rejects(service.getStatus({ serverId: 'server-one' }), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  await assert.rejects(service.listAssets({ serverId: 'server-one' }), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  fs.writeFileSync(jar, 'pack');
  assert.deepEqual(await service.getStatus({ serverId: 'server-one' }), original);
});

test('production composition lists matching client assets from the exact installed release', async t => {
  const { service } = await fixture(t);
  assert.deepEqual(await service.listAssets({ serverId: 'server-one' }), {
    serverFingerprint: fingerprint, serverVersion: 'v1', assets: [{ assetId: '20', fileName: 'client.mrpack', size: '42' }, { assetId: '10', fileName: 'server.zip', size: '100' }]
  });
});

for (const [name, options] of [['unmanaged', { managed: false }], ['missing', { missing: true }]]) {
  test(`production composition keeps ${name} repository state unavailable despite a managed summary`, async t => {
    const { service } = await fixture(t, options);
    assert.equal(await service.getStatus({ serverId: 'server-one' }), null);
    await assert.rejects(service.listAssets({ serverId: 'server-one' }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  });
}

test('production composition rejects malformed persisted state without fabricating a descriptor', async t => {
  const { service, serverPath } = await fixture(t);
  fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{malformed');
  await assert.rejects(service.getStatus({ serverId: 'server-one' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(service.listAssets({ serverId: 'server-one' }), { code: 'INVALID_REQUEST' });
});

test('production composition propagates failed authoritative reads without fabricating a descriptor', async t => {
  const { service, repositoryFs, serverPath } = await fixture(t);
  const failure = Object.assign(new Error('authoritative repository unavailable'), { code: 'EIO' });
  repositoryFs.lstatSync = (target, ...args) => {
    if (target === path.join(serverPath, '.minecraft-core-state', 'modpack.json')) throw failure;
    return fs.lstatSync(target, ...args);
  };
  await assert.rejects(service.getStatus({ serverId: 'server-one' }), error => error === failure);
  await assert.rejects(service.listAssets({ serverId: 'server-one' }), error => error === failure);
});

test('production composition only resolves registered server identities', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.getStatus({ serverId: 'unregistered-server' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(service.listAssets({ serverId: 'unregistered-server' }), { code: 'INVALID_REQUEST' });
});

const junctionsOnly = { skip: process.platform !== 'win32' && 'directory junctions are Windows only' };

test('a junction-registered unmanaged server reads as unmanaged for companions and management fields', junctionsOnly, async t => {
  const f = await fixture(t, { missing: true, serverAlias: true });
  assert.equal(await f.service.getStatus({ serverId: 'server-one' }), null);
  assert.deepEqual(await clientPackManagementFields('server-one', serverId => f.service.getStatus({ serverId })), { clientModpack: null });
  // Exactly what a server without modpack state answers.
  await assert.rejects(f.service.listAssets({ serverId: 'server-one' }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  // The strict repository itself still refuses the alias.
  assert.throws(() => f.repository.read(f.registeredServerPath), { code: 'INVALID_REQUEST' });
});

test('a managed server registered through a junction still fails closed with clientModpackError', junctionsOnly, async t => {
  const f = await fixture(t, { serverAlias: true });
  await assert.rejects(f.service.getStatus({ serverId: 'server-one' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.service.listAssets({ serverId: 'server-one' }), { code: 'INVALID_REQUEST' });
  const fields = await clientPackManagementFields('server-one', serverId => f.service.getStatus({ serverId }));
  assert.equal(fields.clientModpack, null);
  assert.equal(fields.clientModpackError.code, 'CLIENT_PACK_UNAVAILABLE');
});

test('a pinless https client config takes the pin of its registered client (A36, A49)', async t => {
  const registeredPin = Array.from({ length: 32 }, (_, index) => ((index * 37 + 11) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
  const pin = registeredPin.replaceAll(':', '').toLowerCase();
  const agents = [];
  const requests = [];
  const f = await fixture(t, {
    client: true,
    clientFields: { serverIp: 'saved.test', serverPort: '8443', serverProtocol: 'https', managementCertFingerprint: registeredPin },
    readClientConfig: async () => ({ ...savedHttpConfig, serverProtocol: 'https' }),
    async getPinnedHttpsAgent(host, port, expected) {
      agents.push([host, port, expected]);
      return { pinnedTo: expected };
    },
    async managementSessionRequestJson(url, options) {
      requests.push([url.href, options.agent?.pinnedTo]);
      return { statusCode: 200, body: { success: true } };
    }
  });
  const context = await f.composition.acquireLegacyManagementContext(f.clientPath);
  assert.equal(context.managementCertFingerprint, pin);
  assert.equal(context.sessionToken, 'saved-token');
  assert.equal((await f.composition.managementSessionBroker.readServerInfo('local-client')).response.success, true);
  assert.deepEqual(agents, [['saved.test', 8443, pin]]);
  assert.deepEqual(requests, [['https://saved.test:8443/api/server/info', pin]]);
});

test('an injected connection core is used, and only its owner disposes the broker', async t => {
  const { createClientConnectionCore } = require('../../electron/bootstrap/create-client-connection-core.cjs');
  let instances = [];
  const core = createClientConnectionCore({
    store: { get: key => (key === 'instances' ? instances : null) },
    clock: { now: () => 0 },
    readClientConfig: async () => ({ ...savedHttpConfig }),
    managementSessionRequestJson: legacyHostInfo
  });
  t.after(() => core.dispose());
  const resolvedPaths = [];
  const observedCore = Object.freeze({ ...core, async resolveClientByPath(value) {
    resolvedPaths.push(value);
    return core.resolveClientByPath(value);
  } });
  const f = await fixture(t, { client: true, clientConnectionCore: observedCore });
  instances = f.instances;
  assert.equal(f.composition.managementSessionBroker, core.managementSessionBroker);
  assert.equal(f.composition.resolveClientByPath, observedCore.resolveClientByPath);
  assert.equal(f.composition.acquireLegacyManagementContext, core.acquireLegacyManagementContext);
  const launch = await f.composition.clientPackIntegration.beginManagedLaunch({ clientPath: f.clientPath });
  await launch.abortBeforeSpawn();
  assert.deepEqual(resolvedPaths, [f.clientPath]);
  await f.composition.dispose();
  assert.equal(core.managementSessionBroker.disposed, false, 'the core owner disposes its broker');
  core.dispose();
  core.dispose();
  assert.equal(core.managementSessionBroker.disposed, true);

  const own = await fixture(t, { client: true });
  const ownBroker = own.composition.managementSessionBroker;
  assert.notEqual(ownBroker, core.managementSessionBroker);
  await own.composition.dispose();
  assert.equal(ownBroker.disposed, true);
});

test('a client folder registered twice still resolves for launch and legacy reads (v26.6.1 parity)', async t => {
  const f = await fixture(t, { client: true, readClientConfig: async () => ({ ...savedHttpConfig }),
    managementSessionRequestJson: legacyHostInfo });
  const expected = { clientId: 'local-client', clientPath: f.clientPath };
  // A second registration of the same folder, listed first, under an id that sorts later.
  f.instances.unshift({ id: 'zz-duplicate-client', type: 'client', path: f.clientPath });
  assert.deepEqual(await f.composition.resolveClientByPath(f.clientPath), expected);
  f.instances.reverse();
  assert.deepEqual(await f.composition.resolveClientByPath(f.clientPath), expected, 'never chosen by array order');
  const launch = await f.composition.clientPackIntegration.beginManagedLaunch({ clientPath: f.clientPath });
  await launch.abortBeforeSpawn();
  assert.equal((await f.composition.acquireLegacyManagementContext(f.clientPath)).sessionToken, 'saved-token');

  if (process.platform === 'win32') {
    // v26.6.1 re-added a folder picked with another spelling under the same id.
    const respelled = f.clientPath.toUpperCase();
    f.instances.push({ id: 'local-client', type: 'client', path: respelled });
    const resolved = await f.composition.resolveClientByPath(f.clientPath);
    assert.equal(resolved.clientId, 'local-client');
    assert.equal(resolved.clientPath, [f.clientPath, respelled].sort()[0]);
    f.instances.reverse();
    assert.deepEqual(await f.composition.resolveClientByPath(f.clientPath), resolved);
    const again = await f.composition.clientPackIntegration.beginManagedLaunch({ clientPath: f.clientPath });
    await again.abortBeforeSpawn();
  }

  // One id registered for two different folders stays ambiguous.
  f.instances.push({ id: 'local-client', type: 'client', path: path.join(path.dirname(f.clientPath), 'another-client') });
  await assert.rejects(f.composition.resolveClientByPath(f.clientPath), { code: 'INVALID_REQUEST' });
});

test('local client content edits bound the host requirement read with the composition clock', async t => {
  const timeouts = [];
  const f = await fixture(t, { client: true, clock: { now: () => 1_000_000 }, readClientConfig: async () => ({ ...savedHttpConfig }),
    async managementSessionRequestJson(_url, options) {
      timeouts.push(options.timeoutMs);
      return { statusCode: 200, body: { success: true } };
    } });
  const integration = f.composition.clientPackIntegration;
  const request = { clientId: 'local-client', clientPath: f.clientPath };
  assert.equal(await integration.runLocalMutation(request, () => 'local edit'), 'local edit');
  assert.deepEqual(timeouts, [10000]);
  // On the same clock, the host's answer spares the next edit a read until a settings change.
  assert.equal(await integration.runLocalMutation(request, () => 'next edit'), 'next edit');
  assert.deepEqual(timeouts, [10000]);
  assert.equal(await integration.runPersonalMutation(request, () => 'saved'), 'saved');
  assert.equal(await integration.runLocalMutation(request, () => 'edit after saving'), 'edit after saving');
  assert.deepEqual(timeouts, [10000, 10000]);
  assert.deepEqual(f.composition.listActiveMutations(), []);
});
