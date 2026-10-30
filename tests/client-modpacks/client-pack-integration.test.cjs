const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { ClientProcessGuard } = require('../../electron/services/client-modpacks/client-process-guard.cjs');
const { ClientPackTransaction } = require('../../electron/services/client-modpacks/client-pack-transaction.cjs');
const { ManagementPackClient } = require('../../electron/services/client-modpacks/management-pack-client.cjs');
const { ManagementSessionBroker } = require('../../electron/services/management-session-broker.cjs');
const { createClientPackIntegration } = require('../../electron/services/client-modpacks/client-pack-integration.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const unreachable = () => Object.defineProperty(new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The matching client requirement could not be read'),
  'reason', { value: 'host-unreachable' });
// The exact /api/server/info key set a v26.6.1 host sends: it predates matching client packs.
const v2661Info = { success: true, instanceId: 'server-one', serverPath: 'C:\\Servers\\One', serverProperties: { 'server-port': '25565' },
  minecraftPort: '25565', minecraftServerStatus: 'running', minecraftVersion: '1.20.1', loaderType: 'forge', loaderVersion: '47.3.12',
  requiredMods: [], allClientMods: [], appVersion: '26.6.1', serverInfo: { name: 'Server', maxPlayers: 20, gamemode: 'survival', difficulty: 'normal' } };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-pack-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { journal: null, manifest: null, requirement: null, held: false, writes: 0, binding: Object.freeze({ generation: 'launch-binding' }), reads: [], proofs: [] };
  const target = { clientId: 'client-a', clientPath: root };
  const reservation = { jvmArgument: '-Dmain=marker', abortBeforeSpawn: async () => { state.held = false; }, attach() {}, close() {} };
  const integration = createClientPackIntegration({ resolveClient: async id => id === target.clientId ? target : null,
    resolveClientByPath: async value => value === root ? target : null,
    readClientConfig: async () => ({ serverIp: 'saved.example', serverPort: '8080', minecraftPort: '25575' }),
    processGuard: { withMutation: async (actual, work, options) => { assert.deepEqual(actual, target); state.proofs.push(options?.proof ?? 'strict'); state.held = true; try { return await work(); } finally { state.held = false; } },
      beginLaunch: async (actual, options) => { assert.deepEqual(actual, target); state.proofs.push(options?.proof ?? 'strict'); state.held = true; return reservation; } },
    transaction: { status: async () => state.journal,
      async assertNoUnsettledAtPath() { if (state.ownershipError) throw state.ownershipError; } }, stateStore: { read: async () => state.manifest },
    managementClient: { getRequirement: async () => { assert.equal(state.held, true); if (state.error) throw state.error; return state.requirement; },
      readRequirement: async (_id, options = {}) => { state.reads.push(options); assert.equal(state.held, true); if (state.error) throw state.error; return { descriptor: state.requirement, binding: state.binding }; },
      getLaunchConnection: async (_id, _authority, options = {}) => { state.reads.push(options); if (state.changed && options.expectedBinding !== state.binding) throw Object.assign(new Error('changed binding'), { code: 'PLAN_STALE' }); return { serverIp: 'saved.example', serverPort: 25575 }; } },
    clientPackService: { getLaunchAuthority: async (_request, options = {}) => { state.reads.push(options); assert.equal(state.held, true); if (state.launchError) throw state.launchError; state.beforeAuthorityReturn?.();
      return { ...target, runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13' }, profileId: '1.20.1-forge-47.4.13', javaPath: path.join(root, 'java', 'javaw.exe') }; } }
  });
  return { state, integration, target, reservation, write: () => ++state.writes };
}

function realManagedFixture(t, coreForm) {
  const f = fixture(t); const root = f.target.clientPath; const crypto = require('node:crypto');
  const { ClientPackStateStore } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
  const { ClientPackService } = require('../../electron/services/client-modpacks/client-pack-service.cjs');
  const { ClientRuntimeInstaller } = require('../../electron/services/client-modpacks/client-runtime-installer.cjs');
  const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13', javaMajor: 17, os: 'win32', architecture: 'x64' };
  const descriptor = { schemaVersion: 1, status: 'ready', serverFingerprint: 'a'.repeat(64), serverVersion: 'v1', artifactSha256: 'b'.repeat(64), runtime,
    source: { provider: 'github', repositoryId: '1', githubOwner: 'Example', githubRepo: 'Pack', releaseId: '2', assetId: '3' } };
  const put = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const lib = name => {
    const [body, extension = 'jar'] = name.split('@'); const [group, artifact, version, classifier] = body.split(':');
    const relative = `${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
    const bytes = `inert ${name}`; put(`libraries/${relative}`, bytes);
    return { name, downloads: { artifact: { path: relative, size: bytes.length, sha1: crypto.createHash('sha1').update(bytes).digest('hex'), url: 'https://example.invalid/library' } } };
  };
  let core = lib(`org.lwjgl:lwjgl:3.3.1${coreForm === 'explicit-jar' ? '@jar' : coreForm === 'classified' || coreForm === 'legacy-native' ? ':natives-windows' : coreForm === 'nonjar' ? '@zip' : ''}`);
  if (coreForm === 'legacy-native') core = { name: 'org.lwjgl:lwjgl:3.3.1', natives: { windows: 'natives-windows' }, downloads: { classifiers: { 'natives-windows': core.downloads.artifact } } };
  put('versions/1.20.1/1.20.1.json', { id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', javaVersion: { majorVersion: 17 },
    time: '2023-06-12T13:25:51+00:00', releaseTime: '2023-06-12T13:25:51+00:00', arguments: { game: [], jvm: [] }, libraries: [core], assetIndex: { id: '5' } });
  put('versions/1.20.1/1.20.1.jar', 'inert client'); put('assets/indexes/5.json', '{"objects":{}}');
  put('versions/forge/forge.json', { id: 'forge', inheritsFrom: '1.20.1', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    arguments: { game: [], jvm: [] }, libraries: [lib('net.minecraftforge:fmlloader:1.20.1-47.4.13')] });
  put('java/java-17/jdk/release', 'JAVA_VERSION="17.0.16"\nOS_NAME="Windows"\nOS_ARCH="amd64"\n');
  put('java/java-17/jdk/bin/javaw.exe', 'inert never launched'); put('java/java-17/jdk/bin/server/jvm.dll', 'inert jvm');
  put('.minecraft-core-client-pack.json', { schemaVersion: 2, descriptor, entries: [], optionalFileIds: [], contentFormat: 'multimc', runtimeConstraints: { lwjglVersion: '3.3.1' } });
  const stateStore = new ClientPackStateStore({ durableFs: { readFileBoundedAsync: file => fs.promises.readFile(file) } });
  const forbidden = () => { throw Error('unexpected fixture mutation/acquisition'); };
  const transaction = Object.fromEntries(['stage', 'seal', 'publish', 'abandon', 'recover', 'cleanup', 'candidatePathFor'].map(key => [key, forbidden])); transaction.status = async () => null;
  const managementClient = { async readRequirement() { return { descriptor, binding: f.state.binding }; }, async getLaunchConnection() { return { serverIp: 'saved.example', serverPort: 25575 }; } };
  const service = new ClientPackService({ resolveClient: async () => f.target, managementClient, stateStore, transaction, listServerPaths: () => [],
    processGuard: { withMutation: forbidden }, runtimeInstaller: new ClientRuntimeInstaller(), candidatePreparer: Object.fromEntries(['inspect', 'prepare', 'release', 'forgetInspection'].map(key => [key, forbidden])),
    sourceResolver: { resolveArtifactSetPlan: forbidden }, artifactAcquisition: { downloadSet: forbidden },
    archiveInspector: { inspectArchive: forbidden, materializer: { workspaceRegistry: { releaseOwner: forbidden } } }, reparseInspector: { async isReparsePoint() { return false; } } });
  t.after(() => service.dispose());
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: { async beginLaunch() { f.state.held = true; return f.reservation; } }, transaction, stateStore, managementClient, clientPackService: service });
  return { ...f, integration };
}

for (const coreForm of ['implicit-jar', 'explicit-jar', 'classified', 'legacy-native', 'nonjar']) {
  test(`managed launch uses real parsed persisted LWJGL evidence for ${coreForm}`, async t => {
    const f = realManagedFixture(t, coreForm);
    if (['implicit-jar', 'explicit-jar'].includes(coreForm)) {
      const launch = await f.integration.beginManagedLaunch({ clientPath: f.target.clientPath });
      assert.equal(launch.authority.profileId, 'forge'); await launch.abortBeforeSpawn();
    } else await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'RUNTIME_INCOMPLETE' });
    assert.equal(f.state.held, false);
  });
}

for (const status of ['ready', 'unpaired']) test(`legacy content writer refuses authenticated ${status} even with no local manifest`, async t => {
  const f = fixture(t); f.state.requirement = { status };
  await assert.rejects(f.integration.runLegacyMutation({ clientId: 'client-a' }, f.write), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.state.writes, 0); assert.equal(f.state.held, false);
});
test('unknown management response and pending journal never authorize legacy writes', async t => {
  const f = fixture(t); f.state.error = new Error('unavailable');
  await assert.rejects(f.integration.runLegacyMutation({ clientId: 'client-a' }, f.write));
  f.state.error = null; f.state.journal = { phase: 'preparing' };
  await assert.rejects(f.integration.runLegacyMutation({ clientId: 'client-a' }, f.write), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.state.writes, 0);
});
test('a persisted managed manifest still refuses legacy mutation when the server becomes unmanaged', async t => {
  const f = fixture(t); f.state.manifest = { descriptor: {} };
  await assert.rejects(f.integration.runLegacyMutation({ clientId: 'client-a' }, f.write), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.state.writes, 0);
});
test('confirmed unmanaged client retains legacy writer behavior under reservation', async t => {
  const f = fixture(t);
  assert.equal(await f.integration.runLegacyMutation({ clientId: 'client-a' }, () => { assert.equal(f.state.held, true); return f.write(); }), 1);
  assert.deepEqual(f.state.proofs, ['none']);
});
test('unmanaged launch retains process ownership without selecting managed runtime', async t => {
  const f = fixture(t);
  const result = await f.integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.equal(result, f.reservation);
  assert.equal(result.authority, undefined);
  assert.equal(f.state.held, true);
  assert.deepEqual(f.state.proofs, ['none']);
  await result.abortBeforeSpawn();
  assert.equal(f.state.held, false);
});

function guardFixture(t, target, { rows = [] } = {}) {
  const records = new Map(); const leases = [];
  const owner = { pid: process.pid, parentPid: process.ppid, name: 'node.exe', creationTime: 'owner-start', executablePath: process.execPath, commandLine: 'node fixture' };
  const state = { processes: [owner, ...rows], inspections: 0, held: false };
  const makeGuard = () => new ClientProcessGuard({ root: target.clientPath,
    durableFs: { async readFileBoundedAsync(file) { return records.get(file) || null; },
      async writeJsonAtomicAsync(file, value) { records.set(file, Buffer.from(JSON.stringify(value))); } },
    inspectProcesses: async () => { state.inspections++; return { complete: true, processes: state.processes }; },
    async acquireEndpointLease() {
      assert.equal(state.held, false); state.held = true;
      const lease = { assertHeld() { assert.equal(state.held, true); }, async close() { state.held = false; } };
      leases.push(lease); return lease;
    }
  });
  return { owner, records, leases, state, makeGuard };
}

test('running unmanaged client blocks first managed import before and after application restart', async t => {
  const f = fixture(t); const g = guardFixture(t, f.target);
  const guard = g.makeGuard();
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: guard, transaction: { status: async () => null }, stateStore: { read: async () => null },
    managementClient: { readRequirement: async () => ({ descriptor: f.state.requirement, binding: f.state.binding }) },
    clientPackService: { getLaunchAuthority: () => assert.fail('unmanaged launch requested managed runtime') }
  });
  const reservation = await integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.ok(reservation, 'unmanaged launch must retain in-process ownership');
  const child = new EventEmitter(); child.pid = 8723;
  // Both launchers always pass the game directory, which is what a strict proof finds after a restart.
  g.state.processes = [g.owner, { ...g.owner, pid: child.pid, name: 'java.exe', creationTime: 'child-start',
    commandLine: `java ${reservation.jvmArgument} net.minecraft.client.main.Main --gameDir "${f.target.clientPath}"` }];
  await reservation.attach(child);
  assert.equal(g.state.inspections, 0, 'an unmanaged game is launched without a process scan');
  assert.equal(g.records.size, 0, 'an unmanaged game writes no durable launch record');
  f.state.requirement = { status: 'ready' }; // An allowed connection/preferences edit, not game shutdown.
  await assert.rejects(guard.withMutation(f.target, () => assert.fail('published under running unmanaged game')), { code: 'CLIENT_RUNNING' });
  await g.leases[0].close(); // Model the old application's OS lease disappearing, not its child closing.
  g.state.processes = g.state.processes.filter(item => item.pid === child.pid);
  const restarted = g.makeGuard();
  await assert.rejects(restarted.withMutation(f.target, () => assert.fail('restart lost the running game')), { code: 'CLIENT_RUNNING' });
  g.state.processes = [];
  assert.equal(await restarted.withMutation(f.target, () => 'closed process proven absent'), 'closed process proven absent');
});

test('an unmanaged launch makes no process scan while a managed launch still refuses an uncertain row', async t => {
  const f = fixture(t);
  const g = guardFixture(t, f.target, { rows: [{ pid: 9991, parentPid: 4, name: 'java.exe', creationTime: 'forge-start', executablePath: 'C:\\Java\\java.exe',
    commandLine: 'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.12/win_args.txt nogui' }] });
  const local = { manifest: null };
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: g.makeGuard(), transaction: { status: async () => null }, stateStore: { read: async () => local.manifest },
    managementClient: { readRequirement: async () => ({ descriptor: local.manifest ? { status: 'ready' } : null, binding: f.state.binding }) },
    clientPackService: { getLaunchAuthority: () => assert.fail('an uncertain row reached managed authority') } });
  const launch = await integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.equal(g.state.inspections, 0);
  await launch.abortBeforeSpawn();
  local.manifest = { descriptor: {} };
  await assert.rejects(integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'RECOVERY_REQUIRED' });
  assert.ok(g.state.inspections > 0, 'a client with a matching pack keeps the strict proof');
  assert.equal(g.state.held, false);
});

test('check-mods, sign-in refresh and launch can overlap on an unmanaged client', async t => {
  const f = fixture(t); const g = guardFixture(t, f.target);
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: g.makeGuard(), transaction: { status: async () => null }, stateStore: { read: async () => null },
    managementClient: { readRequirement: async () => ({ descriptor: null, binding: f.state.binding }) }, clientPackService: {} });
  const gate = deferred(); const entered = [deferred(), deferred()];
  const checkMods = integration.runLegacyMutation({ clientId: 'client-a', clientPath: f.target.clientPath },
    async () => { entered[0].resolve(); await gate.promise; return 'check-mods'; });
  const refresh = integration.runPersonalMutation({ clientId: 'client-a', clientPath: f.target.clientPath },
    async () => { entered[1].resolve(); await gate.promise; return 'refresh-auth'; });
  await Promise.all(entered.map(item => item.promise));
  const launch = await integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  gate.resolve();
  assert.deepEqual(await Promise.all([checkMods, refresh]), ['check-mods', 'refresh-auth']);
  const child = new EventEmitter(); child.pid = 8724; await launch.attach(child);
  assert.equal(await integration.runPersonalMutation({ clientId: 'client-a', clientPath: f.target.clientPath }, () => 'during play'), 'during play');
  child.emit('close', 0); await launch.close();
  assert.equal(g.state.inspections, 0); assert.equal(g.state.held, false);
});

test('a null launch reservation keeps the original refusal', async t => {
  for (const manifest of [null, { descriptor: {} }]) {
    const f = fixture(t); const failure = new ModpackError('PLAN_STALE', 'The requirement changed');
    const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
      processGuard: { beginLaunch: async () => null }, transaction: { status: async () => null }, stateStore: { read: async () => manifest },
      managementClient: { readRequirement: async () => { throw failure; } }, clientPackService: {} });
    await assert.rejects(integration.beginManagedLaunch({ clientPath: f.target.clientPath }), error => error === failure);
  }
});

test('a v26.6.1 host leaves legacy work and launch available (A33)', async t => {
  const f = fixture(t); const g = guardFixture(t, f.target);
  const managementClient = new ManagementPackClient({ sessionBroker: {
    async readServerInfo() { return { response: structuredClone(v2661Info), binding: f.state.binding }; },
    async acquire() { assert.fail('legacy work never acquires a launch connection'); } } });
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: g.makeGuard(), transaction: { status: async () => null }, stateStore: { read: async () => null }, managementClient, clientPackService: {} });
  assert.equal(await integration.runLegacyMutation({ clientId: 'client-a' }, f.write), 1);
  const launch = await integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.equal(launch.authority, undefined); await launch.abortBeforeSpawn();
});

test('a matching pack still refuses legacy work and launch against a v26.6.1 host', async t => {
  const f = fixture(t); f.state.manifest = { descriptor: {} };
  const managementClient = new ManagementPackClient({ sessionBroker: {
    async readServerInfo() { return { response: structuredClone(v2661Info), binding: f.state.binding }; }, async acquire() { assert.fail('no launch connection'); } } });
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: { withMutation: async (_target, work) => work(), beginLaunch: async () => f.reservation },
    transaction: { status: async () => null }, stateStore: { read: async () => f.state.manifest }, managementClient, clientPackService: {} });
  await assert.rejects(integration.runLegacyMutation({ clientId: 'client-a' }, f.write), { code: 'CLIENT_PACK_UNAVAILABLE' });
  await assert.rejects(integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.state.writes, 0);
});

test('local client content changes only when the host never answered', async t => {
  const f = fixture(t); let now = 5000; let outcome;
  const reads = [];
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: { withMutation: async (_target, work, options) => { f.state.proofs.push(options?.proof); return work(); } },
    transaction: { status: async () => f.state.journal }, stateStore: { read: async () => f.state.manifest },
    managementClient: { async readRequirement(id, options) { reads.push({ id, options }); return outcome(); } }, clientPackService: {}, clock: () => now });
  const run = () => integration.runLocalMutation({ clientId: 'client-a', clientPath: f.target.clientPath }, f.write);
  outcome = () => { throw unreachable(); };
  assert.equal(await run(), 1);
  assert.deepEqual(reads, [{ id: 'client-a', options: { deadline: 8000 } }]);
  now = 9000; assert.equal(await run(), 2); assert.equal(reads.at(-1).options.deadline, 12000);
  assert.deepEqual(f.state.proofs, ['none', 'none']);
  outcome = () => ({ descriptor: null, binding: f.state.binding });
  assert.equal(await run(), 3, 'an authenticated unmanaged host allows local edits');
  for (const failure of [
    new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The matching client requirement could not be read'),
    Object.assign(new Error('forged reason'), { code: 'CLIENT_PACK_UNAVAILABLE', reason: 'host-unreachable' }),
    new ModpackError('CLIENT_PACK_SERVER_CHANGED', 'The server changed'), new ModpackError('PLAN_STALE', 'The connection changed'),
    new ModpackError('CANCELLED', 'Cancelled')
  ]) {
    outcome = () => { throw failure; };
    await assert.rejects(run(), error => error === failure);
  }
  for (const descriptor of [{ status: 'ready' }, { status: 'unpaired' }]) {
    outcome = () => ({ descriptor, binding: f.state.binding });
    await assert.rejects(run(), { code: 'CLIENT_PACK_UNAVAILABLE' });
  }
  outcome = () => { throw unreachable(); };
  f.state.manifest = { descriptor: {} };
  await assert.rejects(run(), { code: 'CLIENT_PACK_UNAVAILABLE' });
  f.state.manifest = null; f.state.journal = { phase: 'ready' };
  await assert.rejects(run(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.state.writes, 3);
});

async function closedPort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}
async function realHostFixture(t, handler, { clock } = {}) {
  let port;
  if (handler) {
    const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); }); port = server.address().port;
  } else port = await closedPort();
  const f = fixture(t);
  const broker = new ManagementSessionBroker({ resolveClient: async id => id === f.target.clientId ? f.target : null,
    readClientConfig: async () => ({ serverProtocol: 'http', serverIp: '127.0.0.1', serverPort: String(port), sessionToken: 'a'.repeat(64),
      clientId: 'remote', clientName: 'Synthetic client', inviteSecret: 'synthetic-invite' }) });
  t.after(() => broker.dispose());
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: { withMutation: async (_target, work) => work(), beginLaunch: async () => f.reservation },
    transaction: { status: async () => null }, stateStore: { read: async () => null },
    managementClient: new ManagementPackClient({ sessionBroker: broker }), clientPackService: {}, ...(clock ? { clock } : {}) });
  return { ...f, integration, deleteAsset: () => integration.runLocalMutation({ clientId: 'client-a', clientPath: f.target.clientPath }, f.write) };
}

test('a real unreachable host lets a local asset delete run', async t => {
  const f = await realHostFixture(t);
  assert.equal(await f.deleteAsset(), 1);
});

test('server info listing about 1000 client mods keeps legacy sync and an unmanaged launch available (A34)', async t => {
  const mods = Array.from({ length: 1000 }, (_, index) => ({ fileName: `synthetic-forge-mod-${String(index).padStart(4, '0')}-1.20.1-47.3.12.jar`,
    checksum: 'f'.repeat(32), size: 123456, required: true, downloadUrl: `/api/mods/download/client/synthetic-forge-mod-${index}.jar`,
    name: `Synthetic mod ${index}`, versionNumber: '1.0.0', projectId: `project${index}` }));
  for (const info of [{ ...v2661Info, requiredMods: mods, allClientMods: mods }, { ...v2661Info, clientModpack: null, requiredMods: mods, allClientMods: mods }]) {
    const body = JSON.stringify(info);
    assert.ok(Buffer.byteLength(body) > 512 * 1024);
    const f = await realHostFixture(t, (_req, res) => res.end(body));
    assert.equal(await f.integration.runLegacyMutation({ clientId: 'client-a' }, f.write), 1);
    assert.equal(await f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), f.reservation);
  }
});

test('a reachable host that reports a pack error, fails or stays silent refuses a local asset delete', async t => {
  for (const handler of [
    (_req, res) => res.end(JSON.stringify({ success: true, clientModpack: null, clientModpackError: { code: 'CLIENT_PACK_UNAVAILABLE', message: 'Unavailable' } })),
    (_req, res) => { res.statusCode = 500; res.end('{}'); },
    (_req, res) => res.end(JSON.stringify({ success: true, clientModpack: { status: 'ready' } }))
  ]) {
    const f = await realHostFixture(t, handler);
    await assert.rejects(f.deleteAsset(), error => error.code === 'CLIENT_PACK_UNAVAILABLE' && error.reason === undefined);
    assert.equal(f.state.writes, 0);
  }
  // Connected but slow: the 3 s requirement budget (here two thirds spent by the injected clock) expires well after the connection.
  const silent = await realHostFixture(t, () => {}, { clock: () => Date.now() - 2000 });
  await assert.rejects(silent.deleteAsset(), error => error.code === 'CLIENT_PACK_UNAVAILABLE' && error.reason === undefined);
  assert.equal(silent.state.writes, 0);
});

test('client registry edits need no network and tolerate a missing folder', async t => {
  const f = fixture(t); const g = guardFixture(t, f.target);
  const networkFree = { readRequirement: () => assert.fail('registry edits never read the host'), getLaunchConnection: () => assert.fail('no network') };
  const local = { journal: null };
  const make = (target, processGuard) => createClientPackIntegration({ resolveClient: async id => id === target.clientId ? target : null,
    resolveClientByPath: async () => target, processGuard,
    transaction: { status: () => assert.fail('registry edits check only the journal phase'), async assertNoUnsettledAtPath(value) {
      assert.equal(value, target.clientPath);
      if (local.journal && !['committed', 'abandoned'].includes(local.journal.phase)) throw new ModpackError('RECOVERY_REQUIRED', 'Unsettled');
    } },
    stateStore: { read: () => assert.fail('registry edits never classify pack content') }, managementClient: networkFree, clientPackService: {} });
  const guard = g.makeGuard(); const integration = make(f.target, guard);
  assert.equal(await integration.runRegistryMutation({ clientId: 'client-a', clientPath: f.target.clientPath }, () => 'renamed'), 'renamed');
  assert.equal(await integration.runRegistryMutation({ clientId: 'client-a' }, () => 'renamed again'), 'renamed again');
  assert.equal(g.state.inspections, 0);
  for (const missing of [path.join(f.target.clientPath, 'gone'), path.join(f.target.clientPath, 'gone', 'client')]) {
    const stale = { clientId: 'stale', clientPath: missing };
    const staleIntegration = make(stale, { withMutation: () => assert.fail('a missing folder has nothing to hold') });
    assert.equal(await staleIntegration.runRegistryMutation({ clientId: 'stale', clientPath: missing }, () => 'deleted'), 'deleted');
  }
  local.journal = { phase: 'preparing' };
  await assert.rejects(integration.runRegistryMutation({ clientId: 'client-a' }, () => assert.fail('deleted during a pending transaction')), { code: 'RECOVERY_REQUIRED' });
  local.journal = null;
  const gate = deferred(); const entered = deferred();
  const transaction = guard.withMutation(f.target, async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  await assert.rejects(integration.runRegistryMutation({ clientId: 'client-a' }, () => assert.fail('deleted during a pack transaction')), { code: 'CLIENT_RUNNING' });
  gate.resolve(); await transaction;
  await assert.rejects(integration.runRegistryMutation({ clientId: 'other' }, () => assert.fail('unregistered')), { code: 'INVALID_REQUEST' });
  await assert.rejects(integration.runRegistryMutation({ clientId: 'client-a', clientPath: path.join(f.target.clientPath, 'other') }, () => assert.fail('other path')),
    { code: 'INVALID_REQUEST' });
});

const journalFiles = () => ({ async readFileBoundedAsync(file) {
  try { return await fs.promises.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
} });
const journalTransaction = journalRoot => new ClientPackTransaction({ journalRoot, durableFs: journalFiles(), stateStore: { async read() { return null; } },
  reparseInspector: { async isReparsePoint() { return false; } } });
// A well-formed journal whose recorded folder identities belong to no folder on this disk.
const journalRecord = (transaction, target, phase) => ({ schemaVersion: 1, operationId: '99999999-9999-4999-8999-999999999999', clientId: target.clientId,
  clientPath: transaction._paths(target).clientPath, parentIdentity: { volumeSerial: 'a1', fileId: 'b2' },
  oldTree: { directoryIdentity: { volumeSerial: 'a1', fileId: 'c3' }, fingerprint: 'd'.repeat(64) },
  candidateIdentity: { volumeSerial: 'a1', fileId: 'e4' }, candidateTree: { directoryIdentity: { volumeSerial: 'a1', fileId: 'e4' }, fingerprint: 'f'.repeat(64) }, phase });

// C1 critique #4: publication renames the live folder away before moving the
// candidate in, so a crash between the two leaves the folder missing with the
// journal still 'ready'. Recovery needs the registration to finish the swap.
test('a registry edit of a client whose folder is missing still refuses an unsettled journal', async t => {
  const f = fixture(t);
  const journalRoot = path.join(f.target.clientPath, 'journal'); fs.mkdirSync(journalRoot);
  const transaction = journalTransaction(journalRoot);
  const games = path.join(f.target.clientPath, 'Games'); fs.mkdirSync(games);
  const target = { clientId: 'client-gone', clientPath: path.join(games, 'Client') };
  fs.mkdirSync(path.join(games, '.minecraft-core-client-99999999-9999-4999-8999-999999999999-previous'));
  const integration = createClientPackIntegration({ resolveClient: async id => id === target.clientId ? target : null, resolveClientByPath: async () => target,
    processGuard: { withMutation: () => assert.fail('a missing folder has nothing to hold') }, transaction,
    stateStore: { read: () => assert.fail('registry edits never classify pack content') },
    managementClient: { readRequirement: () => assert.fail('registry edits never read the host') }, clientPackService: {} });
  const journalPath = transaction._paths(target).journalPath; let ran = 0;
  for (const phase of ['preparing', 'ready']) {
    fs.writeFileSync(journalPath, JSON.stringify(journalRecord(transaction, target, phase)));
    await assert.rejects(integration.runRegistryMutation(target, () => { ran++; }), { code: 'RECOVERY_REQUIRED' }, phase);
  }
  fs.writeFileSync(journalPath, '{damaged');
  await assert.rejects(integration.runRegistryMutation(target, () => { ran++; }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(ran, 0, 'the client entry that recovery needs was never removed');
  for (const phase of ['committed', 'abandoned']) {
    fs.writeFileSync(journalPath, JSON.stringify(journalRecord(transaction, target, phase)));
    assert.equal(await integration.runRegistryMutation(target, () => 'deleted'), 'deleted', phase);
  }
});

test('a registry edit checks only the journal phase, so a settled pack does not pin a replaced folder', async t => {
  const f = fixture(t); const g = guardFixture(t, f.target);
  const journalRoot = path.join(f.target.clientPath, 'journal'); fs.mkdirSync(journalRoot);
  const transaction = journalTransaction(journalRoot);
  const integration = createClientPackIntegration({ resolveClient: async id => id === f.target.clientId ? f.target : null, resolveClientByPath: async () => f.target,
    processGuard: g.makeGuard(), transaction, stateStore: { read: () => assert.fail('registry edits never classify pack content') },
    managementClient: { readRequirement: () => assert.fail('registry edits never read the host') }, clientPackService: {} });
  const journalPath = transaction._paths(f.target).journalPath;
  fs.writeFileSync(journalPath, JSON.stringify(journalRecord(transaction, f.target, 'committed')));
  await assert.rejects(transaction.status(f.target), { code: 'RECOVERY_REQUIRED' }, 'the folder is no longer the one the pack published');
  assert.equal(await integration.runRegistryMutation(f.target, () => 'renamed'), 'renamed');
  fs.writeFileSync(journalPath, JSON.stringify(journalRecord(transaction, f.target, 'ready')));
  await assert.rejects(integration.runRegistryMutation(f.target, () => assert.fail('renamed beside an unsettled transaction')), { code: 'RECOVERY_REQUIRED' });
  assert.equal(g.state.inspections, 0); assert.equal(g.state.held, false);
});

// A47: an offline network share, a folder Windows denies, or a RAM disk that
// cannot be canonicalised still gets every v26.6.1 channel and its registry edits.
test('a client folder the guard cannot inspect or canonicalise keeps its edits and launch', async t => {
  const f = fixture(t); const g = guardFixture(t, f.target);
  const target = { clientId: 'client-offline', clientPath: path.join(f.target.clientPath, 'Offline Client') }; fs.mkdirSync(target.clientPath);
  const integration = createClientPackIntegration({ resolveClient: async id => id === target.clientId ? target : null, resolveClientByPath: async () => target,
    processGuard: g.makeGuard(), transaction: { status: async () => null, async assertNoUnsettledAtPath() {} }, stateStore: { read: async () => null },
    managementClient: { readRequirement: async () => ({ descriptor: null, binding: f.state.binding }) }, clientPackService: {} });
  const { stat } = fs.promises; const { statSync } = fs; const realpathNative = fs.realpathSync.native;
  for (const [operation, code] of [['stat', 'UNKNOWN'], ['stat', 'EPERM'], ['realpath', 'EISDIR']]) {
    const fault = () => { throw Object.assign(new Error(`${code}: injected ${operation} failure`), { code }); };
    if (operation === 'stat') {
      t.mock.method(fs.promises, 'stat', async (value, ...rest) => value === target.clientPath ? fault() : stat(value, ...rest));
      t.mock.method(fs, 'statSync', (value, ...rest) => value === target.clientPath ? fault() : statSync(value, ...rest));
    } else t.mock.method(fs.realpathSync, 'native', (value, ...rest) => value === target.clientPath ? fault() : realpathNative(value, ...rest));
    const request = { clientId: target.clientId, clientPath: target.clientPath };
    for (const method of ['runRegistryMutation', 'runPersonalMutation', 'runLegacyMutation', 'runLocalMutation']) {
      assert.equal(await integration[method](request, () => method), method, `${method} with ${code}`);
    }
    const launch = await integration.beginManagedLaunch({ clientPath: target.clientPath });
    assert.equal(launch.authority, undefined); await launch.abortBeforeSpawn();
    t.mock.restoreAll();
  }
  assert.equal(g.state.inspections, 0); assert.equal(g.state.held, false);
});
test('a client folder named in another Unicode form keeps every v26.6.1 channel and its launch', async t => {
  const f = fixture(t);
  const clientPath = path.join(f.target.clientPath, 'Cafe\u0301 Client'); fs.mkdirSync(clientPath);
  const target = { clientId: 'client-nfd', clientPath };
  const journalRoot = path.join(f.target.clientPath, 'journal'); fs.mkdirSync(journalRoot);
  const durableFs = { async readFileBoundedAsync(file) {
    try { return await fs.promises.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  } };
  const { ClientPackStateStore } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
  const stateStore = new ClientPackStateStore({ durableFs });
  const transaction = new ClientPackTransaction({ journalRoot, durableFs, stateStore });
  const g = guardFixture(t, target);
  const integration = createClientPackIntegration({ resolveClient: async id => id === target.clientId ? target : null, resolveClientByPath: async () => target,
    processGuard: g.makeGuard(), transaction, stateStore, managementClient: { readRequirement: async () => ({ descriptor: null, binding: f.state.binding }) },
    clientPackService: {} });
  const request = { clientId: 'client-nfd', clientPath };
  for (const method of ['runLegacyMutation', 'runPersonalMutation', 'runLocalMutation', 'runRegistryMutation']) {
    assert.equal(await integration[method](request, () => method), method);
  }
  const launch = await integration.beginManagedLaunch({ clientPath }); await launch.abortBeforeSpawn();
  // A transaction is only ever recorded under the NFC spelling; an unsettled one there still refuses.
  const nfcPath = clientPath.normalize('NFC');
  fs.writeFileSync(transaction._paths({ clientId: 'client-nfd', clientPath: nfcPath }).journalPath, JSON.stringify({ schemaVersion: 1,
    operationId: '99999999-9999-4999-8999-999999999999', clientId: 'client-nfd', clientPath: nfcPath, parentIdentity: { volumeSerial: 'a1', fileId: 'b2' },
    oldTree: { directoryIdentity: { volumeSerial: 'a1', fileId: 'c3' }, fingerprint: 'd'.repeat(64) }, candidateIdentity: null, candidateTree: null, phase: 'preparing' }));
  await assert.rejects(integration.runLegacyMutation(request, () => assert.fail('ran beside an unsettled transaction')), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(integration.beginManagedLaunch({ clientPath }), { code: 'RECOVERY_REQUIRED' });
});
test('managed launch carries fresh main authority and saved endpoint inside process lease', async t => {
  const f = fixture(t); f.state.requirement = { status: 'ready' }; f.state.manifest = { descriptor: {} };
  const result = await f.integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.equal(result.authority.profileId, '1.20.1-forge-47.4.13');
  assert.equal(result.authority.serverIp, 'saved.example'); assert.equal(result.authority.serverPort, 25575);
  assert.equal(result.jvmArgument, '-Dmain=marker'); assert.equal(f.state.held, true);
  assert.deepEqual(f.state.proofs, ['strict']);
  await result.abortBeforeSpawn();
});
test('managed launch retains its first binding through verification and connection reads', async t => {
  const f = fixture(t); f.state.requirement = { status: 'ready' }; f.state.manifest = { descriptor: {} };
  await f.integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.equal(f.state.reads.length, 3);
  assert.equal(f.state.reads[1].expectedBinding, f.state.binding); assert.equal(f.state.reads[2].expectedBinding, f.state.binding);
});
test('managed launch fails closed when verification and connection disagree on retained binding', async t => {
  const f = fixture(t); f.state.requirement = { status: 'ready' }; f.state.manifest = { descriptor: {} }; f.state.changed = true;
  f.state.beforeAuthorityReturn = () => { f.state.binding = Object.freeze({ generation: 'replacement-binding' }); };
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'PLAN_STALE' });
  assert.equal(f.state.held, false);
});
test('stale or unpaired managed launch settles pre-spawn reservation without launch authority', async t => {
  const f = fixture(t); f.state.requirement = { status: 'unpaired' };
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.state.held, false);
  f.state.manifest = { descriptor: {} };
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.state.held, false);
  f.state.requirement = { status: 'ready' }; f.state.launchError = Object.assign(new Error('stale'), { code: 'PLAN_STALE' });
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'PLAN_STALE' });
  assert.equal(f.state.held, false);
  assert.deepEqual(f.state.proofs, ['none', 'strict', 'strict']);
});
test('a host requirement without a local pack refuses launch before any managed authority', async t => {
  const f = fixture(t); f.state.requirement = { status: 'ready' };
  f.state.launchError = new Error('managed authority must not be requested without a local pack');
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.state.held, false); assert.deepEqual(f.state.proofs, ['none']);
  f.state.requirement = null; f.state.journal = { phase: 'preparing' };
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.state.held, false); assert.deepEqual(f.state.proofs, ['none', 'strict'], 'an unsettled journal keeps the strict path');
});
test('unregistered paths cannot launch or reach content mutation', async t => {
  const f = fixture(t);
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: path.dirname(f.target.clientPath) }), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.integration.runLegacyMutation({ clientId: 'forged' }, f.write), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.integration.runLocalMutation({ clientId: 'forged' }, f.write), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.integration.runLocalMutation({ clientId: 'client-a', clientPath: path.dirname(f.target.clientPath) }, f.write), { code: 'INVALID_REQUEST' });
  assert.equal(f.state.writes, 0);
});

test('server destination checks refuse persisted client ownership without registration', async t => {
  const f = fixture(t); const marker = path.join(f.target.clientPath, '.minecraft-core-client-pack.json');
  await f.integration.assertServerDestination(f.target.clientPath);
  fs.writeFileSync(marker, '{malformed but owned');
  await assert.rejects(f.integration.assertServerDestination(f.target.clientPath), { code: 'CLIENT_PACK_UNAVAILABLE' });
  await assert.rejects(f.integration.assertServerDestination(path.join(f.target.clientPath, 'nested')), { code: 'CLIENT_PACK_UNAVAILABLE' });
  fs.unlinkSync(marker);
  f.state.ownershipError = Object.assign(new Error('unsettled persisted transaction'), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(f.integration.assertServerDestination(f.target.clientPath), { code: 'RECOVERY_REQUIRED' });
  f.state.ownershipError = null;
  await f.integration.assertServerDestination(f.target.clientPath);
});

test('server destination accepts a drive root and checks the root itself (A22)', { skip: process.platform !== 'win32' && 'Windows drive roots' }, async t => {
  const f = fixture(t); const checked = [];
  const journalRoot = path.join(f.target.clientPath, 'journal'); fs.mkdirSync(journalRoot);
  const transaction = new ClientPackTransaction({ journalRoot, durableFs: { async readFileBoundedAsync() { return null; } }, stateStore: { async read() { return null; } } });
  const integration = createClientPackIntegration({ resolveClient: async () => null, resolveClientByPath: async () => null, stateStore: {}, managementClient: {},
    processGuard: {}, clientPackService: {}, transaction: { async assertNoUnsettledAtPath(value) { checked.push(value); return transaction.assertNoUnsettledAtPath(value); } } });
  // A real, existing drive root (like E:\ given to a whole drive): only reads happen there.
  const driveRoot = path.parse(os.tmpdir()).root;
  await integration.assertServerDestination(driveRoot);
  assert.deepEqual(checked, [driveRoot]);
  checked.length = 0;
  const childOfRoot = path.join(driveRoot, 'MinecraftServer-g2b-never-created');
  await integration.assertServerDestination(childOfRoot);
  assert.deepEqual(checked, [childOfRoot], 'below a root the walk still stops before the root');
});
