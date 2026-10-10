'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const modulePath = '../../electron/services/client-modpacks/client-runtime-installer.cjs';
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13', javaMajor: 17, os: 'win32', architecture: 'x64' };
const profileId = '1.20.1-forge-47.4.13';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'client-runtime-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); };
  const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');
  const base = { id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', minimumLauncherVersion: 21, time: '2023-06-12T13:25:51+00:00', releaseTime: '2023-06-12T13:25:51+00:00', javaVersion: { majorVersion: 17 }, libraries: [], arguments: { game: [], jvm: [] }, downloads: { client: { sha1: sha1('client'), size: 6, url: 'https://example.invalid/client' } }, assetIndex: { id: '5', sha1: sha1('{"objects":{}}'), size: 14, url: 'https://example.invalid/index' } };
  const profile = { id: profileId, inheritsFrom: '1.20.1', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.4.13:client', downloads: { artifact: { path: 'net/minecraftforge/forge/1.20.1-47.4.13/forge-1.20.1-47.4.13-client.jar', url: 'https://example.invalid/lib', size: 3, sha1: sha1('lib') } } }], arguments: { game: [], jvm: [] } };
  put('versions/1.20.1/1.20.1.json', base); put('versions/1.20.1/1.20.1.jar', 'client');
  put(`versions/${profileId}/${profileId}.json`, profile);
  put('libraries/net/minecraftforge/forge/1.20.1-47.4.13/forge-1.20.1-47.4.13-client.jar', 'lib');
  put('assets/indexes/5.json', '{"objects":{}}');
  put('java/java-17/jdk/bin/javaw.exe', 'fixture executable, never run'); put('java/java-17/jdk/bin/server/jvm.dll', 'jvm');
  put('java/java-17/jdk/release', 'JAVA_VERSION="17.0.16"\nOS_NAME="Windows"\nOS_ARCH="amd64"\n');
  return { root, put, profile, base };
}
function libraryFixture(f, name, extra = {}) {
  const [coordinate, extension = 'jar'] = name.split('@'); const [group, artifact, version, classifier] = coordinate.split(':');
  const location = `${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  const bytes = `inert ${name}`;
  f.put(`libraries/${location}`, bytes);
  return { name, downloads: { artifact: { path: location, url: 'https://example.invalid/library', size: Buffer.byteLength(bytes),
    sha1: crypto.createHash('sha1').update(bytes).digest('hex') } }, ...extra };
}
function nativeFixture(f, name) {
  const native = libraryFixture(f, `${name}:natives-windows`);
  return { name, natives: { windows: 'natives-windows' }, downloads: { classifiers: { 'natives-windows': native.downloads.artifact } } };
}
function saveProfiles(f) {
  f.put('versions/1.20.1/1.20.1.json', f.base); f.put(`versions/${profileId}/${profileId}.json`, f.profile);
}

for (const form of ['implicit-jar', 'explicit-jar', 'core-with-native', 'excluded-other-version']) {
  test(`MultiMC parsed effective LWJGL accepts ${form}`, async t => {
    const f = fixture(t);
    f.base.libraries = [libraryFixture(f, `org.lwjgl:lwjgl:3.3.1${form === 'explicit-jar' ? '@jar' : ''}`), libraryFixture(f, 'org.lwjgl:lwjgl-glfw:3.3.1')];
    if (form === 'core-with-native') f.base.libraries.push(nativeFixture(f, 'org.lwjgl:lwjgl:3.3.1'), libraryFixture(f, 'org.lwjgl:lwjgl-glfw:3.3.1:natives-windows'));
    if (form === 'excluded-other-version') f.profile.libraries.push(libraryFixture(f, 'org.lwjgl:lwjgl-glfw:3.3.2', { rules: [{ action: 'allow', os: { name: 'linux' } }] }));
    saveProfiles(f);
    assert.equal((await require(modulePath).verifyClientRuntime({ clientPath: f.root, runtime, runtimeConstraints: { lwjglVersion: '3.3.1' } })).verified, true);
  });
}
for (const mutation of ['missing-core', 'wrong-core', 'mixed-module', 'mixed-native', 'classified-core-only', 'legacy-native-core-only', 'nonjar-core-only', 'excluded-core', 'inherited-shadow']) {
  test(`MultiMC parsed effective LWJGL refuses ${mutation} despite valid file hashes`, async t => {
    const f = fixture(t); f.base.libraries = [libraryFixture(f, 'org.lwjgl:lwjgl:3.3.1'), libraryFixture(f, 'org.lwjgl:lwjgl-glfw:3.3.1')];
    if (mutation === 'missing-core') f.base.libraries.shift();
    if (mutation === 'wrong-core') f.base.libraries[0] = libraryFixture(f, 'org.lwjgl:lwjgl:3.3.2');
    if (mutation === 'mixed-module') f.base.libraries[1] = libraryFixture(f, 'org.lwjgl:lwjgl-glfw:3.3.2');
    if (mutation === 'mixed-native') f.base.libraries.push(nativeFixture(f, 'org.lwjgl:lwjgl:3.3.2'));
    if (mutation === 'classified-core-only') f.base.libraries[0] = libraryFixture(f, 'org.lwjgl:lwjgl:3.3.1:natives-windows');
    if (mutation === 'legacy-native-core-only') f.base.libraries[0] = nativeFixture(f, 'org.lwjgl:lwjgl:3.3.1');
    if (mutation === 'nonjar-core-only') f.base.libraries[0] = libraryFixture(f, 'org.lwjgl:lwjgl:3.3.1@zip');
    if (mutation === 'excluded-core') f.base.libraries[0].rules = [{ action: 'disallow', os: { name: 'windows' } }];
    if (mutation === 'inherited-shadow') f.profile.libraries.push(libraryFixture(f, 'org.lwjgl:lwjgl:3.3.2'));
    saveProfiles(f);
    await assert.rejects(require(modulePath).verifyClientRuntime({ clientPath: f.root, runtime, runtimeConstraints: { lwjglVersion: '3.3.1' } }), { code: 'RUNTIME_INCOMPLETE' });
  });
}
for (const form of ['implicit-jar', 'explicit-jar', 'missing', 'wrong-version', 'classified', 'legacy-native', 'nonjar', 'excluded', 'shadowed']) {
  test(`MultiMC Fabric parsed intermediary ${form}`, async t => {
    const f = fixture(t); const fabricRuntime = { ...runtime, loaderFamily: 'fabric', loaderVersion: '0.16.14' };
    f.profile.libraries = [libraryFixture(f, 'net.fabricmc:fabric-loader:0.16.14')];
    const name = form === 'wrong-version' || form === 'shadowed' ? 'net.fabricmc:intermediary:1.20.2' :
      `net.fabricmc:intermediary:1.20.1${form === 'explicit-jar' ? '@jar' : form === 'classified' ? ':natives-windows' : form === 'nonjar' ? '@zip' : ''}`;
    if (form !== 'missing') f.profile.libraries.push(form === 'legacy-native' ? nativeFixture(f, name) : libraryFixture(f, name,
      form === 'excluded' ? { rules: [{ action: 'disallow', os: { name: 'windows' } }] } : {}));
    if (form === 'shadowed') f.base.libraries = [libraryFixture(f, 'net.fabricmc:intermediary:1.20.1')];
    saveProfiles(f);
    const request = { clientPath: f.root, runtime: fabricRuntime, runtimeConstraints: { lwjglVersion: null } };
    if (['implicit-jar', 'explicit-jar'].includes(form)) assert.equal((await require(modulePath).verifyClientRuntime(request)).verified, true);
    else await assert.rejects(require(modulePath).verifyClientRuntime(request), { code: 'RUNTIME_INCOMPLETE' });
  });
}
test('undefined legacy and explicit null LWJGL add no Forge or vanilla constraints', async t => {
  for (const family of ['forge', 'vanilla']) {
    const f = fixture(t); const selectedRuntime = family === 'forge' ? runtime : { ...runtime, loaderFamily: 'vanilla', loaderVersion: '1.20.1' };
    for (const runtimeConstraints of [undefined, { lwjglVersion: null }]) {
      assert.equal((await require(modulePath).verifyClientRuntime({ clientPath: f.root, runtime: selectedRuntime, runtimeConstraints })).verified, true);
    }
  }
});
test('common verifier refuses every malformed supplied constraint instead of ignoring evidence', async t => {
  const f = fixture(t);
  for (const runtimeConstraints of [null, {}, [], { lwjglVersion: undefined }, { lwjglVersion: 'latest' }, { lwjglVersion: null, extra: 1 }]) {
    await assert.rejects(require(modulePath).verifyClientRuntime({ clientPath: f.root, runtime, runtimeConstraints }), { code: 'RUNTIME_INCOMPLETE' });
  }
});
test('runtime adapter is available without loading native or network runtime dependencies', () => {
  assert.equal(fs.existsSync(path.resolve(__dirname, modulePath)), true, 'runtime adapter must exist');
  assert.equal(typeof require(modulePath).ClientRuntimeInstaller, 'function');
});
test('verify resolves exact Forge profile and Java under current root without writing', async t => {
  const f = fixture(t); const before = fs.readdirSync(f.root, { recursive: true });
  const result = await new (require(modulePath).ClientRuntimeInstaller)().verify({ clientPath: f.root, runtime });
  assert.equal(result.verified, true); assert.deepEqual(result.runtime, runtime); assert.equal(result.profileId, profileId);
  assert.equal(result.javaPath, path.join(f.root, 'java/java-17/jdk/bin/javaw.exe')); assert.deepEqual(fs.readdirSync(f.root, { recursive: true }), before);
});
test('verify never falls back to another Forge version or vanilla', async t => {
  const f = fixture(t); const adapter = new (require(modulePath).ClientRuntimeInstaller)();
  await assert.rejects(adapter.verify({ clientPath: f.root, runtime: { ...runtime, loaderVersion: '47.4.1' } }), { code: 'RUNTIME_INCOMPLETE' });
});
for (const mutation of ['inheritance', 'missing-library', 'unsafe-library', 'java-major', 'missing-assets', 'profile-id']) {
  test(`verify rejects ${mutation}`, async t => {
    const f = fixture(t);
    if (mutation === 'inheritance') f.profile.inheritsFrom = '../outside';
    if (mutation === 'unsafe-library') f.profile.libraries[0].downloads.artifact.path = '../../../outside.jar';
    if (mutation === 'profile-id') f.profile.id = 'forged';
    f.put(`versions/${profileId}/${profileId}.json`, f.profile);
    if (mutation === 'missing-library') fs.unlinkSync(path.join(f.root, 'libraries/net/minecraftforge/forge/1.20.1-47.4.13/forge-1.20.1-47.4.13-client.jar'));
    if (mutation === 'java-major') f.put('java/java-17/jdk/release', 'JAVA_VERSION="21.0.1"\nOS_NAME="Windows"\nOS_ARCH="amd64"');
    if (mutation === 'missing-assets') fs.unlinkSync(path.join(f.root, 'assets/indexes/5.json'));
    await assert.rejects(new (require(modulePath).ClientRuntimeInstaller)().verify({ clientPath: f.root, runtime }), { code: 'RUNTIME_INCOMPLETE' });
  });
}
test('unsupported loaders and latest reject before starting any worker', async t => {
  const f = fixture(t); let calls = 0;
  const adapter = new (require(modulePath).ClientRuntimeInstaller)({ runWorker: () => { calls++; throw Error('must not run'); } });
  await assert.rejects(adapter.prepare({ clientPath: f.root, runtime: { ...runtime, loaderFamily: 'quilt' }, operationId: 'unsupported' }), { code: 'UNSUPPORTED_LOADER' });
  await assert.rejects(adapter.prepare({ clientPath: f.root, runtime: { ...runtime, loaderVersion: 'latest' }, operationId: 'latest' }), { code: 'RUNTIME_INCOMPLETE' });
  assert.equal(calls, 0);
});
test('prepare retains trusted late close proof and ignores forged quiescence flags', async t => {
  const f = fixture(t); const { retainRuntimeWorkerQuiescence } = require('../../electron/services/runtime-worker-quiescence.cjs');
  let close; const error = retainRuntimeWorkerQuiescence(Error('safe fixture'), new Promise(resolve => { close = resolve; }));
  const adapter = new (require(modulePath).ClientRuntimeInstaller)({ runWorker: async () => { throw error; } });
  await assert.rejects(adapter.prepare({ clientPath: f.root, runtime, operationId: 'late' }));
  let complete = false; const pending = adapter.awaitQuiescence('late').then(value => { complete = value; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false); close(true); assert.equal(await pending, true);
  const forged = new (require(modulePath).ClientRuntimeInstaller)({ runWorker: async () => { throw Object.assign(Error('forged'), { quiescent: true, preserveWorkspace: true }); } });
  await assert.rejects(forged.prepare({ clientPath: f.root, runtime, operationId: 'forged' })); assert.equal(await forged.awaitQuiescence('forged'), false);
});
test('preparation installs exact runtime stages and resolved profile libraries without game launch', async t => {
  const f = fixture(t); const Module = require('node:module'); const load = Module._load;
  const stages = []; const progressEvents = [];
  const doubles = {
    '../minecraft-launcher/java-manager.cjs': { JavaManager: class { constructor(root) { assert.equal(root, f.root); } async ensureJava(major, progress, options) { assert.equal(major, 17); assert.equal(options.signal.aborted, false); stages.push('java'); return { success: true, javaPath: path.join(f.root, 'java/java-17/jdk/bin/javaw.exe') }; } } },
    '../minecraft-launcher/proper-launcher.cjs': { ProperMinecraftLauncher: class extends require('node:events').EventEmitter { async ensureMinecraftClient(root, version) { assert.equal(root, f.root); assert.equal(version, '1.20.1'); stages.push('minecraft'); this.emit('launch-progress', { phase: 'assets', type: 'Downloading', current: 42, total: 100, task: 'https://secret.invalid/token' }); this.emit('launch-progress', { phase: 'assets', type: 'Complete', current: 2, total: 2 }); } } },
    '../loader-install-service.cjs': { installClientLoader: async options => { assert.equal(options.clientPath, f.root); assert.equal(options.loader, 'forge'); assert.equal(options.loaderVersion, '47.4.13'); assert.equal(options.minecraftVersion, '1.20.1'); stages.push('loader'); return { success: true, profileId }; } },
    '@xmcl/installer': { installLibraries: async resolved => { assert.equal(resolved.id, profileId); assert.equal(resolved.libraries.some(lib => lib.name === 'net.minecraftforge:forge:1.20.1-47.4.13:client'), true); stages.push('libraries'); } }
  };
  Module._load = function(name, ...args) { return Object.hasOwn(doubles, name) ? doubles[name] : load.call(this, name, ...args); };
  try { await require('../../electron/services/client-modpacks/client-runtime-worker.cjs').prepareClientRuntime({ clientPath: f.root, runtime, signal: new AbortController().signal, onProgress(event) { progressEvents.push(event); } }); }
  finally { Module._load = load; }
  assert.deepEqual(stages, ['java', 'minecraft', 'loader', 'libraries']);
  assert.deepEqual(progressEvents.filter(event => event.bytes !== undefined || event.files !== undefined), [{ phase: 'minecraft', bytes: 42, totalBytes: 100 }, { phase: 'minecraft', files: 2, totalFiles: 2 }]);
});
test('read-only verification supports exact Fabric and vanilla without fallback', async t => {
  const f = fixture(t); const { ClientRuntimeInstaller } = require(modulePath); const adapter = new ClientRuntimeInstaller();
  assert.equal((await adapter.verify({ clientPath: f.root, runtime: { ...runtime, loaderFamily: 'vanilla', loaderVersion: '1.20.1' } })).profileId, '1.20.1');
  const fabricId = 'fabric-loader-0.16.14-1.20.1';
  f.put(`versions/${fabricId}/${fabricId}.json`, { id: fabricId, inheritsFrom: '1.20.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.14' }] });
  f.put('libraries/net/fabricmc/fabric-loader/0.16.14/fabric-loader-0.16.14.jar', 'fabric');
  assert.equal((await adapter.verify({ clientPath: f.root, runtime: { ...runtime, loaderFamily: 'fabric', loaderVersion: '0.16.14' } })).profileId, fabricId);
  await assert.rejects(adapter.verify({ clientPath: f.root, runtime: { ...runtime, loaderFamily: 'fabric', loaderVersion: '0.16.1' } }), { code: 'RUNTIME_INCOMPLETE' });
});
test('verification rejects hardlinked runtime library and changed client hash', async t => {
  const f = fixture(t); const adapter = new (require(modulePath).ClientRuntimeInstaller)();
  const library = path.join(f.root, 'libraries/net/minecraftforge/forge/1.20.1-47.4.13/forge-1.20.1-47.4.13-client.jar');
  fs.linkSync(library, path.join(f.root, 'alias.jar'));
  await assert.rejects(adapter.verify({ clientPath: f.root, runtime }), { code: 'RUNTIME_INCOMPLETE' });
  fs.unlinkSync(path.join(f.root, 'alias.jar')); f.put('versions/1.20.1/1.20.1.jar', 'CLIENT');
  await assert.rejects(adapter.verify({ clientPath: f.root, runtime }), { code: 'RUNTIME_INCOMPLETE' });
});
test('verification derives a new Java path after candidate publication rename', async t => {
  const f = fixture(t); const published = `${f.root}-published`; t.after(() => fs.rmSync(published, { recursive: true, force: true }));
  const adapter = new (require(modulePath).ClientRuntimeInstaller)(); const before = await adapter.verify({ clientPath: f.root, runtime });
  fs.renameSync(f.root, published); const after = await adapter.verify({ clientPath: published, runtime });
  assert.notEqual(before.javaPath, after.javaPath); assert.equal(after.javaPath, path.join(published, 'java/java-17/jdk/bin/javaw.exe'));
});
test('operation registry only forgets proven-quiescent operations', async t => {
  const f = fixture(t); const adapter = new (require(modulePath).ClientRuntimeInstaller)({ runWorker: async () => ({ quiescent: true }) });
  assert.deepEqual(await adapter.prepare({ clientPath: f.root, runtime, operationId: 'successful' }), { runtime, quiescent: true });
  assert.equal(await adapter.awaitQuiescence('successful'), true); assert.equal(await adapter.forgetOperation('successful'), true); assert.equal(await adapter.awaitQuiescence('successful'), false);
});
test('preparation cannot manufacture quiescence from an unproven worker return', async t => {
  const f = fixture(t); const adapter = new (require(modulePath).ClientRuntimeInstaller)({ runWorker: async () => ({ success: true }) });
  await assert.rejects(adapter.prepare({ clientPath: f.root, runtime, operationId: 'unproven' }), { code: 'RUNTIME_INCOMPLETE' });
  assert.equal(await adapter.awaitQuiescence('unproven'), false); assert.equal(await adapter.forgetOperation('unproven'), false);
});
test('verification checks resolved download path instead of accepting a different coordinate file', async t => {
  const f = fixture(t); f.profile.libraries[0].downloads.artifact.path = 'alternate/missing.jar';
  f.put(`versions/${profileId}/${profileId}.json`, f.profile);
  await assert.rejects(new (require(modulePath).ClientRuntimeInstaller)().verify({ clientPath: f.root, runtime }), { code: 'RUNTIME_INCOMPLETE' });
});
test('vanilla tuple cannot declare a different loader version', async t => {
  const f = fixture(t);
  await assert.rejects(new (require(modulePath).ClientRuntimeInstaller)().verify({ clientPath: f.root, runtime: { ...runtime, loaderFamily: 'vanilla', loaderVersion: '1.21.1' } }), { code: 'RUNTIME_INCOMPLETE' });
});
for (const family of ['forge', 'fabric']) {
  for (const mutation of ['excluded', 'shadowed', 'mixed-family']) {
    test(`effective ${family} loader rejects ${mutation} declarations after real XMCL resolution`, async t => {
      const f = fixture(t);
      const selectedRuntime = { ...runtime, loaderFamily: family, loaderVersion: family === 'forge' ? '47.4.13' : '0.16.14' };
      const requested = family === 'forge' ? 'net.minecraftforge:fmlloader:1.20.1-47.4.13' : 'net.fabricmc:fabric-loader:0.16.14';
      const conflicting = family === 'forge' ? 'net.minecraftforge:fmlloader:1.20.1-47.4.1' : 'net.fabricmc:fabric-loader:0.16.1';
      f.profile.libraries = [{ name: requested }];
      f.put(family === 'forge' ? 'libraries/net/minecraftforge/fmlloader/1.20.1-47.4.13/fmlloader-1.20.1-47.4.13.jar' : 'libraries/net/fabricmc/fabric-loader/0.16.14/fabric-loader-0.16.14.jar', 'requested');
      if (mutation === 'excluded') f.profile.libraries[0].rules = [{ action: 'disallow', os: { name: 'windows' } }];
      if (mutation === 'shadowed') {
        f.profile.libraries.push({ name: conflicting });
        f.put(family === 'forge' ? 'libraries/net/minecraftforge/fmlloader/1.20.1-47.4.1/fmlloader-1.20.1-47.4.1.jar' : 'libraries/net/fabricmc/fabric-loader/0.16.1/fabric-loader-0.16.1.jar', 'different');
      }
      if (mutation === 'mixed-family') {
        f.profile.libraries.push({ name: family === 'forge' ? 'net.fabricmc:fabric-loader:0.16.14' : 'net.minecraftforge:fmlloader:1.20.1-47.4.13' });
        f.put(family === 'forge' ? 'libraries/net/fabricmc/fabric-loader/0.16.14/fabric-loader-0.16.14.jar' : 'libraries/net/minecraftforge/fmlloader/1.20.1-47.4.13/fmlloader-1.20.1-47.4.13.jar', 'other-family');
      }
      f.put(`versions/${profileId}/${profileId}.json`, f.profile);
      await assert.rejects(new (require(modulePath).ClientRuntimeInstaller)().verify({ clientPath: f.root, runtime: selectedRuntime }), { code: 'RUNTIME_INCOMPLETE' });
    });
  }
}
for (const file of ['java/java-17/jdk/bin/javaw.exe', 'java/java-17/jdk/bin/server/jvm.dll']) {
  test(`read-only verification rejects independently truncated ${path.basename(file)}`, async t => {
    const f = fixture(t); f.put(file, '');
    await assert.rejects(new (require(modulePath).ClientRuntimeInstaller)().verify({ clientPath: f.root, runtime }), { code: 'RUNTIME_INCOMPLETE' });
  });
}
test('durable adapter reserves before activation and persists exact-close proof before success', async t => {
  const f = fixture(t); const order = []; const context = { operationId: 'owned', clientPath: f.root };
  const ownership = {
    async reserve(request) { assert.deepEqual(request, context); order.push('reserve'); },
    async activate(id) { assert.equal(id, 'owned'); order.push('activate'); return context; },
    async completeFromExactClose(id) { assert.equal(id, 'owned'); order.push('settled'); return true; },
    async releaseReserved(id) { assert.equal(id, 'reserved-only'); return true; },
    async getRecoveryState() { return { quiescent: true, status: 'quiescent' }; }
  };
  const adapter = new (require(modulePath).ClientRuntimeInstaller)({ ownership, runWorker: async request => { assert.deepEqual(request.ownership, context); order.push('worker-close'); return { quiescent: true }; } });
  await adapter.reserveOperation(context); await adapter.prepare({ clientPath: f.root, runtime, operationId: 'owned' });
  assert.deepEqual(order, ['reserve', 'activate', 'worker-close', 'settled']);
  assert.equal(await adapter.releaseReservedOperation('reserved-only'), true);
  assert.equal(await adapter.awaitQuiescence('prior-process-operation'), true);
});
test('default production preparation fails closed without durable ownership configuration', async t => {
  const f = fixture(t); const Module = require('node:module'); const original = Module._load; let started = false;
  Module._load = function(name, ...args) {
    if (name === './client-runtime-worker-client.cjs') return { async runClientRuntimeWorker() { started = true; throw Object.assign(Error('blocked fixture boundary'), { code: 'RUNTIME_INCOMPLETE' }); } };
    return original.call(this, name, ...args);
  };
  try { await assert.rejects(new (require(modulePath).ClientRuntimeInstaller)().prepare({ clientPath: f.root, runtime, operationId: 'unconfigured' }), { code: 'RUNTIME_INCOMPLETE' }); }
  finally { Module._load = original; }
  assert.equal(started, false);
});
