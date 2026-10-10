const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ClientProcessGuard } = require('../../electron/services/client-modpacks/client-process-guard.cjs');
const { createClientPackIntegration } = require('../../electron/services/client-modpacks/client-pack-integration.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-pack-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { journal: null, manifest: null, requirement: null, held: false, writes: 0, binding: Object.freeze({ generation: 'launch-binding' }), reads: [] };
  const target = { clientId: 'client-a', clientPath: root };
  const reservation = { jvmArgument: '-Dmain=marker', abortBeforeSpawn: async () => { state.held = false; }, attach() {}, close() {} };
  const integration = createClientPackIntegration({ resolveClient: async id => id === target.clientId ? target : null,
    resolveClientByPath: async value => value === root ? target : null,
    readClientConfig: async () => ({ serverIp: 'saved.example', serverPort: '8080', minecraftPort: '25575' }),
    processGuard: { withMutation: async (actual, work) => { assert.deepEqual(actual, target); state.held = true; try { return await work(); } finally { state.held = false; } },
      beginLaunch: async actual => { assert.deepEqual(actual, target); state.held = true; return reservation; } },
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
  const service = new ClientPackService({ resolveClient: async () => f.target, managementClient, stateStore, transaction,
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
});
test('unmanaged launch retains process ownership without selecting managed runtime', async t => {
  const f = fixture(t);
  const result = await f.integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.equal(result, f.reservation);
  assert.equal(result.authority, undefined);
  assert.equal(f.state.held, true);
  await result.abortBeforeSpawn();
  assert.equal(f.state.held, false);
});

test('running unmanaged client blocks first managed import before and after application restart', async t => {
  const f = fixture(t);
  const records = new Map(); const leases = [];
  const owner = { pid: process.pid, parentPid: process.ppid, name: 'node.exe', creationTime: 'owner-start', executablePath: process.execPath, commandLine: 'node fixture' };
  let processes = [owner]; let held = false;
  const makeGuard = () => new ClientProcessGuard({ root: f.target.clientPath,
    durableFs: { async readFileBoundedAsync(file) { return records.get(file) || null; },
      async writeJsonAtomicAsync(file, value) { records.set(file, Buffer.from(JSON.stringify(value))); } },
    inspectProcesses: async () => ({ complete: true, processes }),
    async acquireEndpointLease() {
      assert.equal(held, false); held = true;
      const lease = { assertHeld() { assert.equal(held, true); }, async close() { held = false; } };
      leases.push(lease); return lease;
    }
  });
  const guard = makeGuard();
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: guard, transaction: { status: async () => null }, stateStore: { read: async () => null },
    managementClient: { readRequirement: async () => ({ descriptor: f.state.requirement, binding: f.state.binding }) },
    clientPackService: { getLaunchAuthority: () => assert.fail('unmanaged launch requested managed runtime') }
  });
  const reservation = await integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.ok(reservation, 'unmanaged launch must retain durable ownership');
  const child = new EventEmitter(); child.pid = 8723;
  processes = [owner, { ...owner, pid: child.pid, name: 'java.exe', creationTime: 'child-start', commandLine: `java ${reservation.jvmArgument} fixture.Main` }];
  await reservation.attach(child);
  f.state.requirement = { status: 'ready' }; // An allowed connection/preferences edit, not game shutdown.
  await assert.rejects(guard.withMutation(f.target, () => assert.fail('published under running unmanaged game')), { code: 'CLIENT_RUNNING' });
  assert.equal(JSON.parse([...records.values()][0]).phase, 'running');
  await leases[0].close(); // Model the old application's OS lease disappearing, not its child closing.
  processes = processes.filter(item => item.pid === child.pid);
  const restarted = makeGuard();
  await assert.rejects(restarted.withMutation(f.target, () => assert.fail('restart lost live child authority')), { code: 'CLIENT_RUNNING' });
  processes = [];
  assert.equal(await restarted.withMutation(f.target, () => 'closed process proven absent'), 'closed process proven absent');
});
test('managed launch carries fresh main authority and saved endpoint inside process lease', async t => {
  const f = fixture(t); f.state.requirement = { status: 'ready' };
  const result = await f.integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.equal(result.authority.profileId, '1.20.1-forge-47.4.13');
  assert.equal(result.authority.serverIp, 'saved.example'); assert.equal(result.authority.serverPort, 25575);
  assert.equal(result.jvmArgument, '-Dmain=marker'); assert.equal(f.state.held, true);
  await result.abortBeforeSpawn();
});
test('managed launch retains its first binding through verification and connection reads', async t => {
  const f = fixture(t); f.state.requirement = { status: 'ready' };
  await f.integration.beginManagedLaunch({ clientPath: f.target.clientPath });
  assert.equal(f.state.reads.length, 3);
  assert.equal(f.state.reads[1].expectedBinding, f.state.binding); assert.equal(f.state.reads[2].expectedBinding, f.state.binding);
});
test('managed launch fails closed when verification and connection disagree on retained binding', async t => {
  const f = fixture(t); f.state.requirement = { status: 'ready' }; f.state.changed = true;
  f.state.beforeAuthorityReturn = () => { f.state.binding = Object.freeze({ generation: 'replacement-binding' }); };
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'PLAN_STALE' });
  assert.equal(f.state.held, false);
});
test('stale or unpaired managed launch settles pre-spawn reservation without launch authority', async t => {
  const f = fixture(t); f.state.requirement = { status: 'unpaired' };
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.state.held, false);
  f.state.requirement = { status: 'ready' }; f.state.launchError = Object.assign(new Error('stale'), { code: 'PLAN_STALE' });
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: f.target.clientPath }), { code: 'PLAN_STALE' });
  assert.equal(f.state.held, false);
});
test('unregistered paths cannot launch or reach content mutation', async t => {
  const f = fixture(t);
  await assert.rejects(f.integration.beginManagedLaunch({ clientPath: path.dirname(f.target.clientPath) }), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.integration.runLegacyMutation({ clientId: 'forged' }, f.write), { code: 'INVALID_REQUEST' });
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
