const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { ClientPackStateStore } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
const { ClientPackTransaction } = require('../../electron/services/client-modpacks/client-pack-transaction.cjs');
const { ClientProcessGuard } = require('../../electron/services/client-modpacks/client-process-guard.cjs');
const { ClientPackService } = require('../../electron/services/client-modpacks/client-pack-service.cjs');
const { ManagementSessionBroker } = require('../../electron/services/management-session-broker.cjs');
const { ManagementPackClient } = require('../../electron/services/client-modpacks/management-pack-client.cjs');
const { createClientPackIntegration } = require('../../electron/services/client-modpacks/client-pack-integration.cjs');
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' };
const descriptor = { schemaVersion: 1, status: 'ready', serverFingerprint: 'a'.repeat(64), serverVersion: 'v1', source: { provider: 'modrinth', projectId: 'p', versionId: 'v' }, artifactSha256: 'b'.repeat(64), runtime };
const reparseInspector = { async isReparsePoint() { return false; } };
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-client-service-'));
  const live = path.join(root, 'client'), staged = path.join(root, 'staged'), journalRoot = path.join(root, 'journal'), guardRoot = path.join(root, 'guard');
  for (const p of [live, staged, journalRoot, guardRoot]) fs.mkdirSync(p);
  fs.mkdirSync(path.join(staged, 'mods')); fs.writeFileSync(path.join(staged, 'mods', 'pack.jar'), 'pack');
  fs.writeFileSync(path.join(live, 'options.txt'), 'settings');
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: { moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {}, moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {} } });
  const owner = { pid: process.pid, parentPid: process.ppid, creationTime: '2026-10-08', executablePath: process.execPath, commandLine: 'node test' };
  const guard = new ClientProcessGuard({ root: guardRoot, durableFs, inspectProcesses: async () => ({ complete: true, processes: [owner] }) });
  const stateStore = new ClientPackStateStore({ durableFs });
  const transaction = new ClientPackTransaction({ journalRoot, durableFs, stateStore, reparseInspector });
  const target = { clientId: 'one', clientPath: live };
  const external = { requirement: descriptor, digest: descriptor.artifactSha256, runtimeResult: { runtime, quiescent: true }, quiescent: true };
  const entry = { path: 'mods/pack.jar', pathKey: 'mods/pack.jar', sha256: sha('pack'), size: '4', policy: 'managed' };
  const part = { fileName: 'pack.mrpack', size: '4', calculatedDigests: { sha256: descriptor.artifactSha256 } };
  const runtimeOperations = new Map(); const forgottenOperations = [];
  const dependencies = {
    resolveClient: async id => id === 'one' ? target : null,
    managementClient: { async readRequirement() { return { descriptor: external.requirement, binding: Object.freeze({ generation: 'fixture-binding' }) }; } },
    sourceResolver: { async resolveArtifactSetPlan() { return { artifactSetPlan: { artifactSet: { kind: 'single', parts: [part] } } }; } },
    artifactAcquisition: { async downloadSet(plan) { return { artifactSet: { ...plan.artifactSet, parts: [{ ...part, calculatedDigests: { sha256: external.digest } }] } }; } },
    archiveInspector: { async inspectArchive() { return { inspectionId: 'inspection-1' }; }, materializer: { workspaceRegistry: { async releaseOwner() {} } } },
    candidatePreparer: { async inspect() { return { runtime, optionalFiles: [{ id: 'optional-one', label: 'mods/optional.jar', defaultSelected: true }], downloadBytes: '4', name: 'Pack', version: 'v1' }; },
      async prepare({ optionalFileIds }) { return { ownerId: 'prepared-one', outputId: 'output-one', path: staged, runtime, manifest: { entries: [entry] }, optionalFileIds, totalBytes: '4' }; }, async release() {}, forgetInspection() {} },
    runtimeInstaller: {
      async reserveOperation({ operationId, clientPath }) { if (runtimeOperations.has(operationId)) throw new Error('duplicate reservation'); runtimeOperations.set(operationId, { clientPath, started: false, released: false }); },
      async releaseReservedOperation(operationId) { const op = runtimeOperations.get(operationId); if (!op || op.started) return false; op.released = true; return true; },
      async prepare({ operationId, clientPath }) { const op = runtimeOperations.get(operationId); if (!op || op.clientPath !== clientPath || op.released) throw new Error('missing exact candidate reservation'); op.started = true; if (external.prepare) return external.prepare(); return external.runtimeResult; },
      async verify() { return { verified: true, runtime, profileId: '1.20.1-forge-47.3.12' }; },
      async awaitQuiescence(operationId) { const op = runtimeOperations.get(operationId); return !!op && (op.released || (op.started && external.quiescent)); },
      async forgetOperation(operationId) { if (await this.awaitQuiescence(operationId) !== true) return false; forgottenOperations.push(operationId); runtimeOperations.delete(operationId); return true; }
    },
    stateStore, transaction, processGuard: guard, reparseInspector
  };
  const service = new ClientPackService(dependencies);
  t.after(async () => {
    await service.dispose?.();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^mc-client-service-[A-Za-z0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { service, dependencies, external, live, target, guard, transaction, runtimeOperations, forgottenOperations };
}
function writeInertRuntime(root, lwjglVersion = '3.3.1') {
  const put = (name, data) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
  const sha1 = text => crypto.createHash('sha1').update(text).digest('hex');
  const lib = name => {
    const [group, artifact, version] = name.split(':'); const relative = `${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
    const bytes = `inert ${name}`; put(`libraries/${relative}`, bytes);
    return { name, downloads: { artifact: { path: relative, size: bytes.length, sha1: sha1(bytes), url: 'https://example.invalid/library' } } };
  };
  put('versions/1.20.1/1.20.1.json', { id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    time: '2023-06-12T13:25:51+00:00', releaseTime: '2023-06-12T13:25:51+00:00', minimumLauncherVersion: 21,
    javaVersion: { majorVersion: 17 }, arguments: { game: [], jvm: [] }, libraries: [lib(`org.lwjgl:lwjgl:${lwjglVersion}`), lib(`org.lwjgl:lwjgl-glfw:${lwjglVersion}`)],
    downloads: { client: { size: 6, sha1: sha1('client'), url: 'https://example.invalid/client' } },
    assetIndex: { id: '5', size: 14, sha1: sha1('{"objects":{}}'), url: 'https://example.invalid/index' } });
  put('versions/1.20.1/1.20.1.jar', 'client');
  put('versions/1.20.1-forge-47.3.12/1.20.1-forge-47.3.12.json', { id: '1.20.1-forge-47.3.12', inheritsFrom: '1.20.1',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', arguments: { game: [], jvm: [] }, libraries: [lib('net.minecraftforge:fmlloader:1.20.1-47.3.12')] });
  put('assets/indexes/5.json', '{"objects":{}}');
  put('java/java-17/jdk/release', 'JAVA_VERSION="17.0.16"\nOS_NAME="Windows"\nOS_ARCH="amd64"\n');
  put('java/java-17/jdk/bin/javaw.exe', 'inert executable never launched'); put('java/java-17/jdk/bin/server/jvm.dll', 'inert jvm');
}
function multimcServiceFixture(t) {
  const f = fixture(t); const evidence = { contentFormat: 'multimc', runtimeConstraints: { lwjglVersion: '3.3.1' } };
  f.external.requirement = { ...descriptor, source: { provider: 'github', repositoryId: '1', githubOwner: 'Example', githubRepo: 'Pack', releaseId: '2', assetId: '3' } };
  // Task3 owns the filename gate. Synthetic inspected MultiMC bytes use the existing permitted acquisition-name seam here.
  const part = { fileName: 'inspected.mrpack', providerAssetId: '3', size: '4', calculatedDigests: { sha256: descriptor.artifactSha256 } };
  f.dependencies.sourceResolver.providers = { github: { async getRepositoryIdentity() { return { repositoryId: '1' }; } } };
  f.dependencies.sourceResolver.resolveArtifactSetPlan = async () => ({ artifactSetPlan: { artifactSet: { kind: 'single', parts: [part] } } });
  f.dependencies.artifactAcquisition.downloadSet = async plan => ({ artifactSet: plan.artifactSet });
  const inspect = f.dependencies.candidatePreparer.inspect.bind(f.dependencies.candidatePreparer);
  const prepare = f.dependencies.candidatePreparer.prepare.bind(f.dependencies.candidatePreparer);
  f.dependencies.candidatePreparer.inspect = async request => ({ ...await inspect(request), ...evidence, optionalFiles: [], downloadBytes: '0' });
  f.dependencies.candidatePreparer.prepare = async request => ({ ...await prepare(request), ...evidence });
  const prepareRuntime = f.dependencies.runtimeInstaller.prepare.bind(f.dependencies.runtimeInstaller);
  f.dependencies.runtimeInstaller.prepare = async request => { const result = await prepareRuntime(request); writeInertRuntime(request.clientPath); return result; };
  const verifiedRequests = [];
  f.dependencies.runtimeInstaller.verify = async request => {
    verifiedRequests.push({ clientPath: request.clientPath, runtimeConstraints: request.runtimeConstraints });
    return require('../../electron/services/client-modpacks/client-runtime-installer.cjs').verifyClientRuntime(request);
  };
  const reopen = () => {
    const stateStore = new ClientPackStateStore({ durableFs: f.transaction.durableFs });
    const transaction = new ClientPackTransaction({ journalRoot: f.transaction.journalRoot, durableFs: f.transaction.durableFs, stateStore, reparseInspector });
    const service = new ClientPackService({ ...f.dependencies, transaction, stateStore,
      runtimeInstaller: { ...f.dependencies.runtimeInstaller, verify: request => require('../../electron/services/client-modpacks/client-runtime-installer.cjs').verifyClientRuntime(request) } });
    t.after(() => service.dispose()); return service;
  };
  return { ...f, evidence, verifiedRequests, reopen };
}

test('MultiMC private evidence enforces pre-seal and published runtime, without entering public DTOs', async t => {
  const f = multimcServiceFixture(t); const preview = await f.service.preview({ clientId: 'one' });
  assert.equal(Object.hasOwn(preview, 'runtimeConstraints'), false); assert.equal(Object.hasOwn(preview, 'contentFormat'), false);
  const result = await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
  assert.equal(result.verified, true); assert.equal(f.verifiedRequests.length, 2);
  assert.notEqual(f.verifiedRequests[0].clientPath, f.live); assert.equal(f.verifiedRequests[1].clientPath, f.live);
  assert.deepEqual(f.verifiedRequests.map(request => request.runtimeConstraints), [{ lwjglVersion: '3.3.1' }, { lwjglVersion: '3.3.1' }]);
  const manifest = await f.dependencies.stateStore.read(f.live);
  assert.equal(manifest.schemaVersion, 2); assert.deepEqual(manifest.runtimeConstraints, { lwjglVersion: '3.3.1' });
  assert.equal(Object.hasOwn(result, 'runtimeConstraints'), false);
});

test('MultiMC mismatch in real prepared runtime refuses before sealing or publication', async t => {
  const f = multimcServiceFixture(t); const prepare = f.dependencies.runtimeInstaller.prepare.bind(f.dependencies.runtimeInstaller);
  f.dependencies.runtimeInstaller.prepare = async request => { const result = await prepare(request); writeInertRuntime(request.clientPath, '3.3.2'); return result; };
  const preview = await f.service.preview({ clientId: 'one' }); let sealed = false;
  const seal = f.transaction.seal.bind(f.transaction); f.transaction.seal = async context => { sealed = true; return seal(context); };
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RUNTIME_INCOMPLETE' });
  assert.equal(sealed, false); assert.equal(await f.dependencies.stateStore.read(f.live), null);
  assert.equal(fs.existsSync(path.join(f.live, 'mods/pack.jar')), false);
});

test('persisted null LWJGL evidence imposes no stale Forge constraint after service restart', async t => {
  const f = multimcServiceFixture(t); f.evidence.runtimeConstraints = { lwjglVersion: null };
  const preview = await f.service.preview({ clientId: 'one' }); await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
  const manifest = await f.dependencies.stateStore.read(f.live); assert.equal(manifest.schemaVersion, 2); assert.deepEqual(manifest.runtimeConstraints, { lwjglVersion: null });
  await f.service.dispose(); const fresh = f.reopen(); writeInertRuntime(f.live, '3.3.2');
  assert.equal((await fresh.verify({ clientId: 'one' })).verified, true);
  assert.equal((await fresh.getLaunchAuthority({ clientId: 'one' })).profileId, '1.20.1-forge-47.3.12');
});

test('fresh MultiMC service Verify and launch enforce persisted constraints after hash-valid library replacement', async t => {
  const f = multimcServiceFixture(t); const preview = await f.service.preview({ clientId: 'one' });
  await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }); await f.service.dispose();
  const fresh = f.reopen(); assert.equal(fresh.plans.size, 0);
  assert.equal((await fresh.verify({ clientId: 'one' })).verified, true);
  assert.equal((await fresh.getLaunchAuthority({ clientId: 'one' })).profileId, '1.20.1-forge-47.3.12');
  writeInertRuntime(f.live, '3.3.2');
  assert.equal((await fresh.verify({ clientId: 'one' })).status, 'runtime-incomplete');
  await assert.rejects(fresh.getLaunchAuthority({ clientId: 'one' }), { code: 'RUNTIME_INCOMPLETE' });
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'settings');
});

for (const mutation of ['missing', 'malformed']) test(`fresh MultiMC service refuses ${mutation} schema2 evidence for Verify and launch`, async t => {
  const f = multimcServiceFixture(t); const preview = await f.service.preview({ clientId: 'one' });
  await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
  const file = path.join(f.live, '.minecraft-core-client-pack.json'); const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.schemaVersion = 2; value.contentFormat = 'multimc';
  if (mutation === 'missing') delete value.runtimeConstraints; else value.runtimeConstraints = {};
  fs.writeFileSync(file, JSON.stringify(value)); const fresh = f.reopen();
  assert.equal((await fresh.verify({ clientId: 'one' })).status, 'recovery-required');
  await assert.rejects(fresh.getLaunchAuthority({ clientId: 'one' }), { code: 'RECOVERY_REQUIRED' });
});

for (const boundary of ['ready', 'first-rename', 'second-rename']) test(`fresh service recovery retains MultiMC requirements after interrupted ${boundary}`, async t => {
  const f = multimcServiceFixture(t); const preview = await f.service.preview({ clientId: 'one' });
  const durableFs = f.transaction.durableFs; let moves = 0;
  f.transaction.durableFs = { ...durableFs, async renameDurableAsync(a, b) {
    if (boundary === 'ready' && moves === 0) throw Error('inert ready interruption');
    await durableFs.renameDurableAsync(a, b); moves++;
    if (moves === (boundary === 'first-rename' ? 1 : 2)) throw Error('inert publication interruption');
  } };
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RECOVERY_REQUIRED' });
  f.transaction.durableFs = durableFs; await f.service.dispose(); const fresh = f.reopen();
  assert.equal((await fresh.recover({ clientId: 'one' })).phase, 'committed');
  assert.equal((await fresh.verify({ clientId: 'one' })).verified, true);
  writeInertRuntime(f.live, '3.3.2');
  assert.equal((await fresh.verify({ clientId: 'one' })).status, 'runtime-incomplete');
  await assert.rejects(fresh.getLaunchAuthority({ clientId: 'one' }), { code: 'RUNTIME_INCOMPLETE' });
});

test('changing MultiMC companion artifact invalidates retained review before stage', async t => {
  const f = multimcServiceFixture(t); const preview = await f.service.preview({ clientId: 'one' });
  f.external.requirement = { ...f.external.requirement, artifactSha256: 'c'.repeat(64), source: { ...f.external.requirement.source, assetId: '4' } };
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal(await f.transaction.status(f.target), null); assert.equal(await f.dependencies.stateStore.read(f.live), null);
});
function sessionFixture(t) {
  const f = fixture(t);
  const configFile = path.join(f.live, 'client-config.json');
  const config = { serverProtocol: 'https', serverIp: 'saved.example', serverPort: '25566', clientId: 'remote-one',
    clientName: 'Synthetic client', inviteSecret: 'synthetic-invite', sessionToken: 'a'.repeat(64), managementCertFingerprint: 'd'.repeat(64) };
  const bytes = Buffer.from(JSON.stringify(config, null, 2)); fs.writeFileSync(configFile, bytes);
  const state = { token: config.sessionToken, registrations: 0, requests: [], sealed: false, now: 1000 };
  const broker = new ManagementSessionBroker({ resolveClient: f.dependencies.resolveClient,
    readClientConfig: async () => ({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...state.authorityPatch }), clock: () => state.now,
    getPinnedHttpsAgent: async () => ({}), requestJson: async (url, options) => {
      assert.equal(state.sealed, false, 'no management network after seal');
      state.requests.push({ origin: url.origin, method: options.method, token: options.headers['X-Session-Token'] });
      if (state.wait) await state.wait(options);
      if (options.method === 'POST') { state.registrations++; state.token = 'b'.repeat(64); return { statusCode: 200, body: { success: true, token: state.token } }; }
      return { statusCode: options.headers['X-Session-Token'] === state.token ? 200 : 401,
        body: { clientModpack: f.external.requirement, minecraftPort: 25575 } };
    } });
  t.after(() => broker.dispose());
  f.service.managementClient = new ManagementPackClient({ sessionBroker: broker, clock: () => state.now });
  const seal = f.transaction.seal.bind(f.transaction);
  f.transaction.seal = async context => { state.sealed = true; return seal(context); };
  return { ...f, broker, state, configFile, bytes, edit: patch => fs.writeFileSync(configFile, JSON.stringify({ ...config, ...patch }, null, 2)) };
}
for (const boundary of ['before-install', 'runtime-preparation', 'server-restart']) test(`memory recovery at ${boundary} preserves exact config through real publication`, async t => {
  const f = sessionFixture(t); const first = await f.broker.acquire('one');
  const preview = await f.service.preview({ clientId: 'one' });
  assert.equal(JSON.stringify(preview).includes(first.bindingGeneration), false);
  const expire = () => { f.state.token = 'c'.repeat(64); f.state.now += 150001; };
  if (boundary === 'before-install') expire();
  else f.external.prepare = async () => { expire(); return f.external.runtimeResult; };
  const result = await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
  assert.equal(result.status, 'ready'); assert.equal(f.state.registrations, 1);
  assert.deepEqual(fs.readFileSync(f.configFile), f.bytes); assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'settings');
  assert.equal((await f.broker.acquire('one')).binding, first.binding);
});
for (const patch of [{ serverIp: 'replacement.example' }, { managementCertFingerprint: 'e'.repeat(64) }, { clientId: 'remote-two' }, { clientName: 'Renamed client' }, { inviteSecret: 'changed-invite' }]) {
  test(`identical descriptor from changed saved ${Object.keys(patch)[0]} cannot replace preview binding`, async t => {
    const f = sessionFixture(t); const preview = await f.service.preview({ clientId: 'one' }); const before = f.state.requests.length;
    f.edit(patch);
    await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
    assert.equal(f.state.requests.length, before); assert.equal(f.state.registrations, 0); assert.equal(f.state.sealed, false);
    assert.equal(fs.existsSync(path.join(f.live, 'mods/pack.jar')), false);
  });
}
test('same descriptor authority change during runtime refuses before seal without publication', async t => {
  const f = sessionFixture(t); const preview = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { f.edit({ serverIp: 'replacement.example' }); return f.external.runtimeResult; };
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.state.sealed, false); assert.equal(f.state.requests.some(r => r.origin.includes('replacement')), false);
});
test('changed registered client path cannot reuse a retained review', async t => {
  const f = sessionFixture(t); const preview = await f.service.preview({ clientId: 'one' }); const before = f.state.requests.length;
  f.target.clientPath = path.join(path.dirname(f.live), 'replacement-client');
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal(f.state.requests.length, before); assert.equal(f.state.sealed, false); assert.deepEqual(fs.readFileSync(f.configFile), f.bytes);
});
for (const phase of ['preview', 'install']) test(`caller cancellation reaches a pending ${phase} requirement`, async t => {
  const f = sessionFixture(t); const preview = phase === 'install' ? await f.service.preview({ clientId: 'one' }) : null;
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  let observed;
  f.state.wait = options => new Promise((_resolve, reject) => { observed = options.signal; entered(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
  const controller = new AbortController(); const request = phase === 'install' ? { clientId: 'one', planId: preview.planId, conflictChoices: {} } : { clientId: 'one' };
  const pending = f.service[phase](request, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(observed.aborted, true);
  assert.equal(f.state.sealed, false);
});
test('an explicit shorter preview read deadline stops dispatch rather than being discarded', async t => {
  const f = sessionFixture(t);
  await assert.rejects(f.service.preview({ clientId: 'one' }, { deadline: f.state.now - 1 }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.state.requests.length, 0);
});
test('peer recovery during runtime preparation adopts current revision without changing reviewed bytes or binding', async t => {
  const f = sessionFixture(t); const preview = await f.service.preview({ clientId: 'one' }); const first = await f.broker.acquire('one');
  f.external.prepare = async () => {
    await f.broker.acquire('one', { reason: 'authorization-rejected', observedBindingGeneration: first.bindingGeneration, observedRevision: first.revision });
    return f.external.runtimeResult;
  };
  assert.equal((await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} })).verified, true);
  assert.equal(f.state.registrations, 1); assert.deepEqual(fs.readFileSync(f.configFile), f.bytes);
  assert.equal(f.state.requests.at(-1).token, 'b'.repeat(64)); assert.equal((await f.broker.acquire('one')).binding, first.binding);
});
test('synthetic authority drift without live-byte edits during runtime fails plan-stale', async t => {
  const f = sessionFixture(t); const preview = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { f.state.authorityPatch = { serverIp: 'replacement.example' }; return f.external.runtimeResult; };
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal(f.state.sealed, false); assert.deepEqual(fs.readFileSync(f.configFile), f.bytes);
});
for (const drift of [false, true]) test(`full managed launch retains binding through real file/runtime verification (drift ${drift})`, async t => {
  const f = sessionFixture(t); const preview = await f.service.preview({ clientId: 'one' });
  await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }); f.state.sealed = false;
  const first = await f.broker.acquire('one'); const reads = [];
  const read = f.broker.readServerInfo.bind(f.broker);
  f.broker.readServerInfo = async (id, options) => { reads.push(options); return read(id, options); };
  const verify = f.dependencies.runtimeInstaller.verify.bind(f.dependencies.runtimeInstaller);
  f.dependencies.runtimeInstaller.verify = async (...args) => { const result = await verify(...args); if (drift) f.state.authorityPatch = { serverIp: 'replacement.example' }; return result; };
  const integration = createClientPackIntegration({ resolveClient: f.dependencies.resolveClient,
    resolveClientByPath: async value => value === f.live ? f.target : null, processGuard: f.guard, transaction: f.transaction,
    stateStore: f.dependencies.stateStore, managementClient: f.service.managementClient, clientPackService: f.service });
  if (drift) {
    await assert.rejects(integration.beginManagedLaunch({ clientPath: f.live }), { code: 'PLAN_STALE' });
    await f.guard.withMutation(f.target, async () => 'reservation settled');
  } else {
    const launch = await integration.beginManagedLaunch({ clientPath: f.live }); assert.equal(launch.authority.serverIp, 'saved.example');
    assert.equal(launch.authority.serverPort, 25575); assert.equal(launch.authority.binding, undefined); await launch.abortBeforeSpawn();
  }
  assert.equal(reads.length, 3); assert.equal(reads[1].expectedBinding, first.binding); assert.equal(reads[2].expectedBinding, first.binding);
  assert.equal(f.state.requests.some(request => request.origin.includes('replacement')), false); assert.deepEqual(fs.readFileSync(f.configFile), f.bytes);
});
test('preview and install publish verified main-owned plan with path-free DTOs', async t => {
  const f = fixture(t); const preview = await f.service.preview({ clientId: 'one' });
  assert.deepEqual(preview.additions, ['mods/pack.jar']);
  assert.equal(JSON.stringify(preview).includes(f.live), false);
  const result = await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
  assert.equal(result.status, 'ready');
  assert.equal(fs.readFileSync(path.join(f.live, 'mods/pack.jar'), 'utf8'), 'pack');
  assert.equal((await f.service.getLaunchAuthority({ clientId: 'one' })).profileId, '1.20.1-forge-47.3.12');
  assert.equal((await f.service.verify({ clientId: 'one' })).verified, true);
});
for (const slowBoundary of ['candidate preparation', 'final state read']) {
  test(`slow ${slowBoundary} does not consume the completed preview review window`, async t => {
    const f = fixture(t);
    let now = 1000;
    f.service.clock = () => now;
    const dependency = slowBoundary === 'candidate preparation' ? f.dependencies.candidatePreparer : f.dependencies.stateStore;
    const method = slowBoundary === 'candidate preparation' ? 'prepare' : 'read';
    const original = dependency[method].bind(dependency);
    let delayed = false;
    dependency[method] = async (...args) => {
      const result = await original(...args);
      if (!delayed) { now += 900001; delayed = true; }
      return result;
    };
    const preview = await f.service.preview({ clientId: 'one' });
    assert.equal(delayed, true);
    const result = await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
    assert.equal(result.status, 'ready');
    assert.equal(result.verified, true);
    assert.equal(fs.readFileSync(path.join(f.live, 'mods/pack.jar'), 'utf8'), 'pack');
    assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'settings');
  });
}
test('completed preview still expires without staging after its review window', async t => {
  const f = fixture(t);
  let now = 1000;
  f.service.clock = () => now;
  const prepare = f.dependencies.candidatePreparer.prepare.bind(f.dependencies.candidatePreparer);
  f.dependencies.candidatePreparer.prepare = async options => {
    const result = await prepare(options);
    now += 900001;
    return result;
  };
  const preview = await f.service.preview({ clientId: 'one' });
  now += 900001;
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal(await f.transaction.status(f.target), null);
  assert.equal(f.runtimeOperations.size, 0);
  assert.equal(fs.existsSync(path.join(f.live, 'mods')), false);
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'settings');
});
test('renderer source or unknown optional IDs cannot authorize preparation', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.preview({ clientId: 'one', source: descriptor.source }), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.service.preview({ clientId: 'one', optionalFileIds: ['unknown'] }), { code: 'INVALID_REQUEST' });
});
test('installation reports measured client copy progress before runtime preparation', async t => {
  const f = fixture(t);
  const preview = await f.service.preview({ clientId: 'one' });
  const events = [];
  let eventsBeforeRuntime;
  f.external.prepare = async () => {
    eventsBeforeRuntime = [...events];
    return f.external.runtimeResult;
  };
  const result = await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }, {
    onProgress: event => events.push(event)
  });
  assert.equal(result.status, 'ready');
  const copies = eventsBeforeRuntime.filter(event => event.phase === 'copying-client-files');
  assert.ok(copies.length >= 2, 'copy start and measured completion must reach the caller');
  assert.deepEqual(copies.map(({ completedItems, totalItems, completedBytes, totalBytes }) =>
    ({ completedItems, totalItems, completedBytes, totalBytes })), [
    { completedItems: '0', totalItems: '1', completedBytes: '0', totalBytes: '8' },
    { completedItems: '1', totalItems: '1', completedBytes: '8', totalBytes: '8' }
  ]);
  assert.ok(eventsBeforeRuntime.some(event => event.phase === 'flushing-client-files'));
  assert.ok(eventsBeforeRuntime.some(event => event.phase === 'checking-client-copy'));
  assert.ok(copies.every(event => event.clientId === 'one' && typeof event.operationId === 'string'));
  assert.equal(JSON.stringify(events).includes(f.live), false);
});
test('changed management fingerprint after preview prevents live publication', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  f.external.requirement = { ...descriptor, serverFingerprint: 'c'.repeat(64) };
  await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal(fs.existsSync(path.join(f.live, 'mods')), false);
});
test('official re-resolution digest mismatch prevents publication', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' }); f.external.digest = 'c'.repeat(64);
  await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal(fs.existsSync(path.join(f.live, 'mods')), false);
});
test('client launch reservation blocks install and recovery', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' }); const launch = await f.guard.beginLaunch(f.target);
  try {
    await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }), { code: 'CLIENT_RUNNING' });
    await assert.rejects(f.service.recover({ clientId: 'one' }), { code: 'CLIENT_RUNNING' });
  } finally { await launch.abortBeforeSpawn(); }
});
test('modified managed JAR cannot become launch authority', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' }); await f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} });
  fs.writeFileSync(path.join(f.live, 'mods/pack.jar'), 'modified');
  assert.equal((await f.service.verify({ clientId: 'one' })).verified, false);
  await assert.rejects(f.service.getLaunchAuthority({ clientId: 'one' }), { code: 'RUNTIME_INCOMPLETE' });
});
test('runtime rejection with uncertain workers keeps recoverable candidate and old live', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { throw new Error('worker uncertain'); }; f.external.quiescent = false;
  await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }), { code: 'RECOVERY_REQUIRED' });
  assert.equal((await f.transaction.status(f.target)).phase, 'preparing');
  assert.equal(fs.existsSync(path.join(f.live, 'mods')), false);
  await assert.rejects(f.service.recover({ clientId: 'one' }), { code: 'RECOVERY_REQUIRED' });
});
test('recovery state explains a proven restart requirement without exposing ownership metadata', async t => {
  const f = fixture(t);
  f.transaction.status = async () => ({ phase: 'preparing', operationId: 'interrupted-operation' });
  f.dependencies.runtimeInstaller.getRecoveryState = async operationId => {
    assert.equal(operationId, 'interrupted-operation');
    return { status: 'restart-required', quiescent: false, clientPath: f.live, bootId: 'private' };
  };
  const result = await f.service.getState({ clientId: 'one' });
  assert.deepEqual(result, { clientId: 'one', status: 'recovery-required', verified: false, descriptor: null, recoveryReason: 'restart-required' });
  await assert.rejects(f.service.getLaunchAuthority({ clientId: 'one' }), { code: 'RECOVERY_REQUIRED' });
});
test('unknown or running recovery writers never invent a Windows restart requirement', async t => {
  const f = fixture(t);
  f.transaction.status = async () => ({ phase: 'preparing', operationId: 'interrupted-operation' });
  for (const status of ['unknown', 'running', 'uncertain', 'quiescent']) {
    f.dependencies.runtimeInstaller.getRecoveryState = async () => ({ status, quiescent: status === 'quiescent' });
    const result = await f.service.getState({ clientId: 'one' });
    assert.equal(result.status, 'recovery-required'); assert.equal(result.verified, false);
    assert.equal(Object.hasOwn(result, 'recoveryReason'), false);
  }
  f.dependencies.runtimeInstaller.getRecoveryState = async () => { throw new Error('private ownership failure'); };
  assert.equal((await f.service.getState({ clientId: 'one' })).status, 'recovery-required');
});
test('cancel waits for actual runtime completion before reporting cancellation', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  let finish; let entered; const ready = new Promise(resolve => { entered = resolve; });
  f.external.prepare = () => { entered(); return new Promise(resolve => { finish = () => resolve({ runtime, quiescent: true }); }); };
  let operationId;
  const install = f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }, { onProgress: event => { operationId = event.operationId; } });
  const outcome = assert.rejects(install, { code: 'CANCELLED' }); await ready;
  let cancelled = false; const cancelling = f.service.cancel({ clientId: 'one', operationId }).then(() => { cancelled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, false);
  finish(); await outcome; await cancelling; assert.equal(cancelled, true);
  assert.equal(fs.existsSync(path.join(f.live, 'mods')), false);
});
test('cancel after publication boundary does not claim a committed install was cancelled', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  let entered; let release; const ready = new Promise(resolve => { entered = resolve; });
  const publish = f.transaction.publish.bind(f.transaction);
  f.transaction.publish = async context => { entered(); await new Promise(resolve => { release = resolve; }); return publish(context); };
  let operationId;
  const install = f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }, { onProgress: e => { operationId = e.operationId; } });
  await ready; const cancelling = f.service.cancel({ clientId: 'one', operationId }); release();
  assert.equal((await install).status, 'ready');
  assert.equal((await cancelling).cancelled, false);
});
test('runtime failure with proven quiescence leaves old client usable', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { throw Object.assign(new Error('runtime incomplete'), { code: 'RUNTIME_INCOMPLETE' }); };
  await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }), { code: 'RUNTIME_INCOMPLETE' });
  assert.equal((await f.transaction.status(f.target)).phase, 'abandoned');
  assert.equal((await f.service.recover({ clientId: 'one' })).phase, 'abandoned');
});
test('getState provides actionable recovery state without path authority', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { throw new Error('unknown worker'); }; f.external.quiescent = false;
  await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }));
  const state = await f.service.getState({ clientId: 'one' });
  assert.equal(state.status, 'recovery-required'); assert.equal(state.verified, false);
  assert.equal(JSON.stringify(state).includes(f.live), false);
});
test('wrong runtime profile cannot produce a committed installation', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  f.dependencies.runtimeInstaller.verify = async () => ({ verified: true, runtime: { ...runtime, loaderVersion: '47.0.0' }, profileId: 'wrong-loader' });
  await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }), { code: 'RUNTIME_INCOMPLETE' });
  assert.equal(fs.existsSync(path.join(f.live, 'mods')), false);
});
test('descriptor changed while runtime prepares rejects just before publication', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { f.external.requirement = { ...descriptor, artifactSha256: 'c'.repeat(64) }; return { runtime, quiescent: true }; };
  await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal(fs.existsSync(path.join(f.live, 'mods')), false);
});
test('runtime preparation cannot alter copied user data or pack files', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  const prepare = f.dependencies.runtimeInstaller.prepare.bind(f.dependencies.runtimeInstaller);
  f.dependencies.runtimeInstaller.prepare = async (options) => {
    const result = await prepare(options);
    fs.writeFileSync(path.join(options.clientPath, 'options.txt'), 'overwritten');
    return result;
  };
  await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'settings');
});
test('retry recovery settles retained preparation only after exact runtime operation proves quiescence', async t => {
  const f = fixture(t); const p = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { throw new Error('uncertain worker'); }; f.external.quiescent = false;
  await assert.rejects(f.service.install({ clientId: 'one', planId: p.planId, conflictChoices: {} }), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(f.service.recover({ clientId: 'one' }), { code: 'RECOVERY_REQUIRED' });
  f.external.quiescent = true;
  assert.equal((await f.service.recover({ clientId: 'one' })).phase, 'abandoned');
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'settings');
});
test('managed server without installed companion never reports unmanaged fallback', async t => {
  const f = fixture(t);
  assert.equal((await f.service.getState({ clientId: 'one' })).status, 'install-required');
  f.external.requirement = { ...descriptor, status: 'unpaired', source: null, runtime: null, artifactSha256: null };
  assert.equal((await f.service.getState({ clientId: 'one' })).status, 'unpaired');
});
test('four in-flight previews reserve retention slots before a fifth can inspect', async t => {
  const f = fixture(t); f.service.resolveClient = async id => ({ clientId: id, clientPath: f.live });
  let release; let entered = 0; let allEntered; const ready = new Promise(resolve => { allEntered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.dependencies.archiveInspector.inspectArchive = async () => { if (++entered === 4) allEntered(); await gate; return { inspectionId: `inspection-${entered}` }; };
  const pending = [1, 2, 3, 4].map(n => f.service.preview({ clientId: `client-${n}` }));
  await ready; let rejection;
  const fifth = f.service.preview({ clientId: 'client-5' }).catch(error => { rejection = error; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(rejection?.code, 'OPERATION_IN_PROGRESS'); }
  finally { release(); await Promise.allSettled([...pending, fifth]); }
});
test('removed previously-preserved JAR cannot verify new pack even when bytes equal its old digest', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.live, 'mods')); fs.writeFileSync(path.join(f.live, 'mods/pack.jar'), 'user');
  let preview = await f.service.preview({ clientId: 'one' });
  assert.equal((await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: { 'mods/pack.jar': 'preserve' } })).status, 'modified');
  // The previously retained JAR now matches the OLD pack, but the new pack no
  // longer contains that path. Old digest equality is not new-pack ownership.
  fs.writeFileSync(path.join(f.live, 'mods/pack.jar'), 'pack');
  f.external.requirement = { ...descriptor, serverVersion: 'v2', artifactSha256: 'c'.repeat(64) };
  f.external.digest = 'c'.repeat(64);
  const prepare = f.dependencies.candidatePreparer.prepare;
  f.dependencies.candidatePreparer.prepare = async options => ({ ...await prepare(options), manifest: { entries: [] }, totalBytes: '0' });
  preview = await f.service.preview({ clientId: 'one' });
  assert.equal(preview.conflicts.find(conflict => conflict.path === 'mods/pack.jar').action, 'remove');
  const result = await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: { 'mods/pack.jar': 'preserve' } });
  assert.equal(result.status, 'modified'); assert.equal(result.verified, false);
  assert.equal(fs.readFileSync(path.join(f.live, 'mods/pack.jar'), 'utf8'), 'pack');
  assert.equal((await f.service.verify({ clientId: 'one' })).verified, false);
  await assert.rejects(f.service.getLaunchAuthority({ clientId: 'one' }), { code: 'RUNTIME_INCOMPLETE' });
  f.dependencies.candidatePreparer.prepare = prepare;
  f.external.requirement = { ...descriptor, serverVersion: 'v3', artifactSha256: 'd'.repeat(64) };
  f.external.digest = 'd'.repeat(64);
  preview = await f.service.preview({ clientId: 'one' });
  assert.equal((await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} })).status, 'ready');
  assert.equal((await f.dependencies.stateStore.read(f.live)).entries.find(entry => entry.path === 'mods/pack.jar').preserved, undefined);
  assert.equal((await f.service.verify({ clientId: 'one' })).verified, true);
});
for (const uncertainAbandonment of [false, true]) test(`stage cancellation ${uncertainAbandonment ? 'retains recovery failure when abandonment is uncertain' : 'returns CANCELLED after proven abandonment'}`, async t => {
  const f = fixture(t); let preview = await f.service.preview({ clientId: 'one' });
  await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
  const originalPrepare = f.dependencies.candidatePreparer.prepare;
  f.dependencies.candidatePreparer.prepare = async options => {
    const prepared = await originalPrepare(options);
    fs.writeFileSync(path.join(prepared.path, 'mods/next.jar'), 'next');
    return { ...prepared, manifest: { entries: [{ path: 'mods/next.jar', pathKey: 'mods/next.jar', sha256: sha('next'), size: '4', policy: 'managed' }] } };
  };
  preview = await f.service.preview({ clientId: 'one' });
  assert.deepEqual(preview.removals, ['mods/pack.jar']);
  const originalUnlink = fs.promises.unlink;
  const durable = f.transaction.durableFs;
  if (uncertainAbandonment) f.transaction.durableFs = { ...durable, async writeJsonAtomicAsync(file, record, options) {
    if (record.phase === 'abandoned') throw new Error('injected abandonment flush failure');
    return durable.writeJsonAtomicAsync(file, record, options);
  } };
  let removed; const removalReached = new Promise(resolve => { removed = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  fs.promises.unlink = async file => {
    await originalUnlink(file);
    if (path.basename(file) === 'pack.jar' && file !== path.join(f.live, 'mods/pack.jar')) { removed(); await gate; }
  };
  let operationId;
  const installation = f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }, { onProgress: event => { operationId = event.operationId; } })
    .then(value => ({ value }), error => ({ error }));
  let cancellation;
  try {
    await removalReached;
    cancellation = f.service.cancel({ clientId: 'one', operationId }).then(value => ({ value }), error => ({ error }));
    // cancel resolves the registered target asynchronously before aborting.
    await new Promise(resolve => setImmediate(resolve)); release();
    const installResult = await installation; const cancelResult = await cancellation;
    assert.equal(installResult.error?.code, uncertainAbandonment ? 'RECOVERY_REQUIRED' : 'CANCELLED');
    if (uncertainAbandonment) assert.equal(cancelResult.error?.code, 'RECOVERY_REQUIRED');
    else assert.equal(cancelResult.value?.cancelled, true);
    assert.equal((await f.transaction.status(f.target)).phase, uncertainAbandonment ? 'preparing' : 'abandoned');
    assert.equal(fs.readFileSync(path.join(f.live, 'mods/pack.jar'), 'utf8'), 'pack');
    assert.equal(fs.existsSync(path.join(f.live, 'mods/next.jar')), false);
  } finally { release(); await installation; if (cancellation) await cancellation; fs.promises.unlink = originalUnlink; f.transaction.durableFs = durable; }
});
test('settled abandoned recovery allows later settings and save edits without losing candidate cleanup evidence', async t => {
  const f = fixture(t); let preview = await f.service.preview({ clientId: 'one' });
  await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
  preview = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { throw Object.assign(new Error('runtime incomplete'), { code: 'RUNTIME_INCOMPLETE' }); };
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RUNTIME_INCOMPLETE' });
  const journalPath = f.transaction._paths(f.target).journalPath;
  const recorded = fs.readFileSync(journalPath);
  fs.writeFileSync(path.join(f.live, 'options.txt'), 'later settings');
  fs.mkdirSync(path.join(f.live, 'saves')); fs.writeFileSync(path.join(f.live, 'saves/world.dat'), 'later save');
  assert.equal((await f.service.getState({ clientId: 'one' })).verified, true);
  assert.equal((await f.service.recover({ clientId: 'one' })).phase, 'abandoned');
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'later settings');
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'later save');
  assert.deepEqual(fs.readFileSync(journalPath), recorded);
});
test('settled abandoned recovery still rejects substituted live directory', async t => {
  const f = fixture(t); const preview = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { throw Object.assign(new Error('runtime incomplete'), { code: 'RUNTIME_INCOMPLETE' }); };
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RUNTIME_INCOMPLETE' });
  fs.renameSync(f.live, f.live + '-retained'); fs.mkdirSync(f.live); fs.writeFileSync(path.join(f.live, 'options.txt'), 'settings');
  await assert.rejects(f.service.recover({ clientId: 'one' }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(f.live + '-retained', 'options.txt'), 'utf8'), 'settings');
});
test('preparing recovery still rejects changed live content after writer quiescence is proven', async t => {
  const f = fixture(t); const preview = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { throw new Error('uncertain writer'); }; f.external.quiescent = false;
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RECOVERY_REQUIRED' });
  fs.writeFileSync(path.join(f.live, 'options.txt'), 'unreviewed change'); f.external.quiescent = true;
  await assert.rejects(f.service.recover({ clientId: 'one' }), { code: 'RECOVERY_REQUIRED' });
  assert.equal((await f.transaction.status(f.target)).phase, 'preparing');
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'unreviewed change');
});
test('runtime reservation exists before candidate assembly and completed cleanup forgets proof', async t => {
  const f = fixture(t); const preview = await f.service.preview({ clientId: 'one' });
  const stage = f.transaction.stage.bind(f.transaction); let operationId;
  f.transaction.stage = async input => {
    operationId = input.operationId;
    assert.equal(f.runtimeOperations.get(operationId)?.clientPath, f.transaction.candidatePathFor(f.target, operationId));
    return stage(input);
  };
  const result = await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
  assert.equal(result.status, 'ready'); assert.equal(result.cleanup.status, 'complete');
  assert.deepEqual(f.forgottenOperations, [operationId]); assert.equal(f.runtimeOperations.size, 0);
  assert.equal(fs.existsSync(f.transaction._paths(f.target, operationId).previousPath), false);
  assert.equal((await f.service.cleanup({ clientId: 'one' })).status, 'complete');
  assert.equal((await f.service.getState({ clientId: 'one' })).verified, true);
});
test('noncritical cleanup failure retains previous and runtime proof without revoking ready live', async t => {
  const f = fixture(t); const preview = await f.service.preview({ clientId: 'one' });
  const publish = f.transaction.publish.bind(f.transaction); let operationId;
  f.transaction.publish = async context => {
    operationId = context.operationId; const result = await publish(context);
    fs.writeFileSync(path.join(context.previousPath, 'options.txt'), 'changed after settlement'); return result;
  };
  const result = await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} });
  assert.equal(result.status, 'ready'); assert.equal(result.cleanup.status, 'retained');
  assert.deepEqual(f.forgottenOperations, []); assert.equal(f.runtimeOperations.has(operationId), true);
  assert.equal((await f.service.getState({ clientId: 'one' })).verified, true);
});
test('explicit cleanup is excluded by active client launch reservation', async t => {
  const f = fixture(t); const launch = await f.guard.beginLaunch(f.target);
  try { await assert.rejects(f.service.cleanup({ clientId: 'one' }), { code: 'CLIENT_RUNNING' }); }
  finally { await launch.abortBeforeSpawn(); }
});
test('ordinary pre-stage failure releases reservation and forgets only unstarted writer proof', async t => {
  const f = fixture(t); const preview = await f.service.preview({ clientId: 'one' });
  fs.writeFileSync(path.join(f.live, 'options.txt'), 'later settings');
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal(f.forgottenOperations.length, 1); assert.equal(f.runtimeOperations.size, 0);
  assert.equal(await f.transaction.status(f.target), null);
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'later settings');
});
test('uncertain reservation release remains recovery-required and is never forgotten', async t => {
  const f = fixture(t); const preview = await f.service.preview({ clientId: 'one' });
  fs.writeFileSync(path.join(f.live, 'options.txt'), 'later settings');
  f.dependencies.runtimeInstaller.releaseReservedOperation = async () => false;
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.forgottenOperations.length, 0); assert.equal(f.runtimeOperations.size, 1);
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'later settings');
});
test('unknown runtime writer is not cleaned or forgotten until positive recovery proof', async t => {
  const f = fixture(t); const preview = await f.service.preview({ clientId: 'one' });
  f.external.prepare = async () => { throw new Error('unknown worker'); }; f.external.quiescent = false;
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RECOVERY_REQUIRED' });
  const operationId = (await f.transaction.status(f.target)).operationId;
  const candidate = path.join(path.dirname(f.live), `.minecraft-core-client-${operationId}-candidate`);
  assert.equal(fs.existsSync(candidate), true); assert.equal(f.forgottenOperations.length, 0);
  assert.equal((await f.service.cleanup({ clientId: 'one' })).status, 'retained');
  f.external.quiescent = true;
  assert.equal((await f.service.recover({ clientId: 'one' })).phase, 'abandoned');
  assert.equal(fs.existsSync(candidate), false); assert.deepEqual(f.forgottenOperations, [operationId]);
});
test('real producer progress shapes become bounded path-free service progress', async t => {
  const f = fixture(t); const events = [];
  const download = f.dependencies.artifactAcquisition.downloadSet;
  f.dependencies.artifactAcquisition.downloadSet = async (plan, options) => {
    options.onProgress({ setBytes: 4, totalBytes: '12', path: f.live, token: 'secret' });
    options.onProgress({ phase: 'downloading-archive', completedBytes: -1, totalBytes: '9'.repeat(31), completedItems: Infinity, totalItems: 1.5 });
    options.onProgress({ phase: 'downloading-archive', completedBytes: Number.MAX_SAFE_INTEGER + 1, totalBytes: {}, completedItems: '00' });
    return download(plan, options);
  };
  const prepare = f.dependencies.candidatePreparer.prepare;
  f.dependencies.candidatePreparer.prepare = async options => {
    options.onProgress({ activity: 'extracting-pack', processedBytes: '10', totalBytes: 12, filePath: f.live });
    return prepare(options);
  };
  await f.service.preview({ clientId: 'one' }, { onProgress: event => events.push(event) });
  assert.deepEqual(events.slice(1).map(({ clientId, operationId, ...event }) => event), [
    { phase: 'downloading-archive', completedBytes: '4', totalBytes: '12' },
    { phase: 'downloading-archive' }, { phase: 'downloading-archive' },
    { phase: 'extracting-pack', completedBytes: '10', totalBytes: '12' }
  ]);
  assert.equal(JSON.stringify(events).includes(f.live), false); assert.equal(JSON.stringify(events).includes('secret'), false);
});
test('runtime worker byte and file counters reach scoped install progress', async t => {
  const f = fixture(t); const events = [];
  const preview = await f.service.preview({ clientId: 'one' });
  const prepare = f.dependencies.runtimeInstaller.prepare.bind(f.dependencies.runtimeInstaller);
  f.dependencies.runtimeInstaller.prepare = async options => {
    options.onProgress({ phase: 'minecraft', bytes: 0, totalBytes: 8192, path: f.live, token: 'private-runtime-token' });
    options.onProgress({ phase: 'minecraft', bytes: 4096, totalBytes: 8192 });
    options.onProgress({ phase: 'minecraft', files: 3, totalFiles: 5 });
    options.onProgress({ phase: 'minecraft', files: 5, totalFiles: 5 });
    options.onProgress({ phase: 'minecraft', bytes: -1, files: Infinity, totalFiles: 1.5 });
    return prepare(options);
  };
  assert.equal((await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }, {
    onProgress: event => events.push(event)
  })).status, 'ready');
  const runtimeEvents = events.filter(event => event.phase === 'minecraft');
  assert.deepEqual(runtimeEvents.map(({ clientId, operationId, ...event }) => event), [
    { phase: 'minecraft', completedBytes: '0', totalBytes: '8192' },
    { phase: 'minecraft', completedBytes: '4096', totalBytes: '8192' },
    { phase: 'minecraft', completedItems: '3', totalItems: '5' },
    { phase: 'minecraft', completedItems: '5', totalItems: '5' },
    { phase: 'minecraft' }
  ]);
  assert.ok(runtimeEvents.every(event => event.clientId === 'one' && event.operationId === runtimeEvents[0].operationId));
  assert.equal(JSON.stringify(events).includes(f.live), false);
  assert.equal(JSON.stringify(events).includes('private-runtime-token'), false);
});
for (const boundary of ['candidate-manifest', 'runtime-preparation']) test(`concurrent preferences and authentication edit during ${boundary} cannot be overwritten by publication`, async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.live, 'client-config.json'), 'old authentication');
  const preview = await f.service.preview({ clientId: 'one' });
  const editPreferences = () => {
    fs.writeFileSync(path.join(f.live, 'options.txt'), 'new user preferences');
    fs.writeFileSync(path.join(f.live, 'client-config.json'), 'new authentication');
  };
  if (boundary === 'candidate-manifest') {
    const writeManifest = f.dependencies.stateStore.write.bind(f.dependencies.stateStore);
    f.dependencies.stateStore.write = async (...args) => { await writeManifest(...args); editPreferences(); };
  } else f.external.prepare = async () => { editPreferences(); return { runtime, quiescent: true }; };
  await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'new user preferences');
  assert.equal(fs.readFileSync(path.join(f.live, 'client-config.json'), 'utf8'), 'new authentication');
  assert.equal(fs.existsSync(path.join(f.live, 'mods/pack.jar')), false);
  assert.equal((await f.transaction.status(f.target)).phase, 'ready');
  assert.equal(f.forgottenOperations.length, 0);
});
test('optional re-preview replaces inactive same-client plans and invalidates old IDs', async t => {
  const f = fixture(t); const first = await f.service.preview({ clientId: 'one', optionalFileIds: [] });
  let latest;
  for (let index = 0; index < 6; index++) latest = await f.service.preview({ clientId: 'one', optionalFileIds: index % 2 ? [] : ['optional-one'] });
  await assert.rejects(f.service.install({ clientId: 'one', planId: first.planId, conflictChoices: {} }), { code: 'PLAN_STALE' });
  assert.equal((await f.service.install({ clientId: 'one', planId: latest.planId, conflictChoices: {} })).status, 'ready');
});
test('re-preview does not retire another registered clients inactive plan', async t => {
  const f = fixture(t); f.service.resolveClient = async clientId => ({ clientId, clientPath: f.live });
  const other = await f.service.preview({ clientId: 'two' });
  await f.service.preview({ clientId: 'one' }); await f.service.preview({ clientId: 'one', optionalFileIds: [] });
  assert.equal((await f.service.install({ clientId: 'two', planId: other.planId, conflictChoices: {} })).status, 'ready');
});
for (const existingJournal of [false, true]) for (const released of [false, true]) test(`cancel during reservation with ${existingJournal ? 'settled' : 'no'} journal and ${released ? 'positive' : 'unknown'} release`, async t => {
  const f = fixture(t);
  if (existingJournal) { const first = await f.service.preview({ clientId: 'one' }); await f.service.install({ clientId: 'one', planId: first.planId, conflictChoices: {} }); }
  const originalStatus = await f.transaction.status(f.target); const forgottenBefore = f.forgottenOperations.length;
  const preview = await f.service.preview({ clientId: 'one' });
  const reserve = f.dependencies.runtimeInstaller.reserveOperation.bind(f.dependencies.runtimeInstaller);
  let enter; let finish; const ready = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { finish = resolve; });
  f.dependencies.runtimeInstaller.reserveOperation = async options => { await reserve(options); enter(); await gate; };
  if (!released) f.dependencies.runtimeInstaller.releaseReservedOperation = async () => false;
  let operationId;
  const install = f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }, { onProgress: event => { operationId = event.operationId; } })
    .then(value => ({ value }), error => ({ error }));
  await ready;
  const cancel = f.service.cancel({ clientId: 'one', operationId }).then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve)); finish();
  const installResult = await install; const cancelResult = await cancel;
  assert.equal(installResult.error?.code, released ? 'CANCELLED' : 'RECOVERY_REQUIRED');
  if (released) assert.equal(cancelResult.value?.cancelled, true); else assert.equal(cancelResult.error?.code, 'RECOVERY_REQUIRED');
  assert.deepEqual(await f.transaction.status(f.target), originalStatus);
  assert.equal(f.forgottenOperations.length - forgottenBefore, released ? 1 : 0); assert.equal(f.runtimeOperations.size, released ? 0 : 1);
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'settings');
});
for (const role of ['previous', 'candidate']) test(`service forgets runtime proof after ${role} final-cursor cleanup recovery`, async t => {
  const f = fixture(t); const preview = await f.service.preview({ clientId: 'one' }); const durableFs = f.transaction.durableFs;
  f.transaction.durableFs = { ...durableFs, async writeJsonAtomicAsync(file, record, options) {
    if (file.includes('.cleanup-') && record.phase === 'complete') throw new Error('complete marker failure');
    return durableFs.writeJsonAtomicAsync(file, record, options);
  } };
  if (role === 'candidate') {
    f.external.prepare = async () => { throw Object.assign(new Error('known stopped'), { code: 'RUNTIME_INCOMPLETE' }); };
    await assert.rejects(f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }), { code: 'RUNTIME_INCOMPLETE' });
  } else assert.equal((await f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} })).cleanup.status, 'retained');
  const operationId = (await f.transaction.status(f.target)).operationId;
  assert.equal(f.forgottenOperations.length, 0); assert.equal(f.runtimeOperations.size, 1);
  f.transaction.durableFs = durableFs;
  assert.equal((await f.service.cleanup({ clientId: 'one' })).status, 'complete');
  assert.deepEqual(f.forgottenOperations, [operationId]); assert.equal(f.runtimeOperations.size, 0);
  assert.equal((await f.service.cleanup({ clientId: 'one' })).status, 'complete');
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'settings');
});
for (const fault of ['non-abort-error', 'unknown-journal']) test(`cancel during reservation does not normalize ${fault}`, async t => {
  const f = fixture(t);
  if (fault === 'unknown-journal') { const first = await f.service.preview({ clientId: 'one' }); await f.service.install({ clientId: 'one', planId: first.planId, conflictChoices: {} }); }
  const forgottenBefore = f.forgottenOperations.length; const preview = await f.service.preview({ clientId: 'one' });
  const reserve = f.dependencies.runtimeInstaller.reserveOperation.bind(f.dependencies.runtimeInstaller);
  const failure = new Error('reservation disk failure');
  let enter; let finish; const ready = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { finish = resolve; });
  f.dependencies.runtimeInstaller.reserveOperation = async options => {
    await reserve(options); enter(); await gate;
    if (fault === 'non-abort-error') throw failure;
    const activeName = fs.readdirSync(f.transaction.journalRoot).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    fs.writeFileSync(path.join(f.transaction.journalRoot, activeName), '{invalid');
  };
  let operationId;
  const install = f.service.install({ clientId: 'one', planId: preview.planId, conflictChoices: {} }, { onProgress: event => { operationId = event.operationId; } }).catch(error => error);
  await ready;
  const cancel = f.service.cancel({ clientId: 'one', operationId }).catch(error => error);
  await new Promise(resolve => setImmediate(resolve)); finish();
  const installError = await install; const cancelError = await cancel;
  if (fault === 'non-abort-error') { assert.equal(installError, failure); assert.equal(cancelError, failure); }
  else { assert.equal(installError.code, 'RECOVERY_REQUIRED'); assert.equal(cancelError.code, 'RECOVERY_REQUIRED'); }
  assert.equal(f.forgottenOperations.length - forgottenBefore, fault === 'unknown-journal' ? 0 : 1);
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'settings');
});
