'use strict';

// Inert managed-runtime handoff tests: real verifier, resolver, launcher, and guard.
// Java/JAR bytes are text fixtures; spawn/process inspection and repair are isolated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { ClientProcessGuard } = require('../../electron/services/client-modpacks/client-process-guard.cjs');
const { verifyClientRuntime } = require('../../electron/services/client-modpacks/client-runtime-installer.cjs');
const { ProperMinecraftLauncher } = require('../../electron/services/minecraft-launcher/proper-launcher.cjs');
const { Version } = require('@xmcl/core');

const runtime = Object.freeze({ minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13',
  javaMajor: 17, os: 'win32', architecture: 'x64' });
const profileId = '1.20.1-forge-47.4.13';
const constraints = Object.freeze({ lwjglVersion: '3.3.1' });
const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');
const CORE_331 = 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar';
const CORE_332 = 'org/lwjgl/lwjgl/3.3.2/lwjgl-3.3.2.jar';
const GLFW_331 = 'org/lwjgl/lwjgl-glfw/3.3.1/lwjgl-glfw-3.3.1.jar';
const GLFW_332 = 'org/lwjgl/lwjgl-glfw/3.3.2/lwjgl-glfw-3.3.2.jar';
const FORGE = 'net/minecraftforge/forge/1.20.1-47.4.13/forge-1.20.1-47.4.13-client.jar';
const expectedLibraries = [CORE_331, GLFW_331, FORGE];
const BASE_JAR = 'versions/1.20.1/1.20.1.jar';
const CORE_NATIVE = 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows-64.jar';
const GLFW_NATIVE = 'org/lwjgl/lwjgl-glfw/3.3.1/lwjgl-glfw-3.3.1-natives-windows.jar';
const blocked = error => ['CLIENT_RUNNING', 'RECOVERY_REQUIRED'].includes(error.code);

function fixture(t, variant = 'aligned', options = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'task7-managed-classpath-')));
  const clientPath = path.join(root, 'client');
  const put = (relative, data) => {
    const file = path.join(clientPath, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const library = (name, relative, extra = {}) => {
    const bytes = `inert library ${name}`;
    put(`libraries/${relative}`, bytes);
    return { name, downloads: { artifact: { path: relative, size: Buffer.byteLength(bytes), sha1: sha1(bytes),
      url: 'https://example.invalid/never-requested-library' } }, ...extra };
  };
  const native = () => ({ name: 'org.lwjgl:lwjgl:3.3.1', natives: { windows: 'natives-windows-${arch}', linux: 'natives-linux' },
    downloads: { classifiers: {
      'natives-windows-64': library('org.lwjgl:lwjgl:3.3.1:natives-windows-64', CORE_NATIVE).downloads.artifact,
      'natives-linux': library('org.lwjgl:lwjgl:3.3.1:natives-linux', 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar').downloads.artifact
    } } });
  const base = {
    id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', minimumLauncherVersion: 21,
    time: '2023-06-12T13:25:51+00:00', releaseTime: '2023-06-12T13:25:51+00:00', javaVersion: { majorVersion: 17 },
    libraries: [library(`org.lwjgl:lwjgl:${variant === 'inherited-shadow' ? '3.3.2' : '3.3.1'}`,
      variant === 'inherited-shadow' ? CORE_332 : CORE_331), library('org.lwjgl:lwjgl-glfw:3.3.1', GLFW_331)],
    arguments: { jvm: [], game: ['--fixture-inherited', 'base'] },
    downloads: { client: { sha1: sha1('client'), size: 6, url: 'https://example.invalid/never-requested-client' } },
    assetIndex: { id: '5', sha1: sha1('{"objects":{}}'), size: 14, url: 'https://example.invalid/never-requested-assets' }
  };
  const profile = { id: profileId, inheritsFrom: '1.20.1', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [library('net.minecraftforge:forge:1.20.1-47.4.13:client', FORGE)],
    arguments: { jvm: [], game: ['--fixture-child', 'forge'] } };
  if (variant === 'inherited-shadow') profile.libraries.push(library('org.lwjgl:lwjgl:3.3.1', CORE_331));
  if (variant === 'os-excluded') profile.libraries.push(library('org.lwjgl:lwjgl-glfw:3.3.2', GLFW_332,
    { rules: [{ action: 'allow', os: { name: 'linux' } }] }));
  if (variant === 'os-excluded') profile.libraries.push(library('org.lwjgl:lwjgl-jemalloc:3.3.2',
    'org/lwjgl/lwjgl-jemalloc/3.3.2/lwjgl-jemalloc-3.3.2.jar', { rules: [{ action: 'allow', os: { name: 'windows', arch: 'x86' } }] }));
  options.configure?.({ root, clientPath, base, profile, put, library, native });
  put('versions/1.20.1/1.20.1.json', base); put('versions/1.20.1/1.20.1.jar', 'client');
  put(`versions/${profileId}/${profileId}.json`, profile); put('assets/indexes/5.json', '{"objects":{}}');
  put('java/java-17/jdk/release', 'JAVA_VERSION="17.0.16"\nOS_NAME="Windows"\nOS_ARCH="amd64"\n');
  put('java/java-17/jdk/bin/javaw.exe', 'INERT TEXT NOT AN EXECUTABLE');
  put('java/java-17/jdk/bin/server/jvm.dll', 'INERT TEXT NOT A DLL');

  const owner = { pid: process.pid, parentPid: process.ppid, creationTime: 'fixture-owner-start',
    executablePath: process.execPath, commandLine: 'node task7 inert fixture' };
  let processes = [owner], reservation, captured, verified, hookCalls = 0, spawnCalls = 0, repairCalls = 0;
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {}
  } });
  const guard = new ClientProcessGuard({ root, durableFs, inspectProcesses: async () => ({ complete: true, processes }) });
  const target = { clientId: 'task7-inert-client', clientPath };
  const child = new EventEmitter();
  Object.assign(child, { pid: 8722, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  const hook = async ({ clientPath: requested }) => {
    assert.equal(requested, clientPath); hookCalls++;
    reservation = await guard.beginLaunch(target);
    try {
      verified = await verifyClientRuntime({ clientPath, runtime, runtimeConstraints: constraints });
      assert.equal(verified.verified, true);
      assert.equal(verified.profileId, profileId);
      await options.afterVerify?.(f);
      return Object.freeze({ ...reservation, authority: Object.freeze({ ...target, runtime: verified.runtime,
        profileId: verified.profileId, javaPath: verified.javaPath, serverIp: 'managed.example.invalid', serverPort: 25575 }) });
    } catch (error) { await reservation.abortBeforeSpawn(); throw error; }
  };
  const spawn = (command, args, options) => {
    spawnCalls++;
    assert.equal(command, verified.javaPath, 'only the verified inert Java path may reach fake spawn');
    assert.equal(options.cwd, clientPath);
    captured = { command, args, options };
    const marker = args.find(arg => arg.startsWith('-Dminecraft.core.clientLaunchId='));
    processes = [owner, { ...owner, pid: child.pid, parentPid: process.pid, creationTime: 'fixture-child-start',
      commandLine: `java ${marker || ''} cpw.mods.bootstraplauncher.BootstrapLauncher` }];
    return child;
  };
  const noExternalWork = () => { repairCalls++; assert.fail('managed launch must not perform network, installation, or repair'); };
  t.mock.method(globalThis, 'fetch', noExternalWork);
  const launcher = new ProperMinecraftLauncher({ beginManagedLaunch: hook, spawn, isProcessAlive: () => true,
    installMinecraftAssets: noExternalWork, getLoaderVersions: noExternalWork, installClientLoader: noExternalWork,
    installLibrariesTask: noExternalWork });
  launcher.ensureMinecraftClient = noExternalWork;
  launcher.setAuthData({ name: 'InertFixture', uuid: 'inert-fixture', access_token: 'not-real-auth' });
  t.after(async () => {
    child.emit('close', 0); await reservation?.close();
    assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
    assert.match(path.basename(root), /^task7-managed-classpath-[A-Za-z0-9]+$/);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = { root, clientPath, launcher, target, guard, child, base, profile, put,
    get captured() { return captured; }, get verified() { return verified; }, get hookCalls() { return hookCalls; },
    get reservation() { return reservation; }, get spawnCalls() { return spawnCalls; }, get repairCalls() { return repairCalls; } };
  return f;
}

const launchOptions = f => ({ clientPath: f.clientPath, minecraftVersion: 'forged',
  loaderType: 'fabric', loaderVersion: 'latest', javaPath: 'forged-java', serverIp: 'forged.invalid', serverPort: 1,
  maxMemory: 6144, showDebugTerminal: false });

async function launchAndCapture(t, variant, options = {}, libraries = expectedLibraries) {
  const f = fixture(t, variant, options);
  // Independent literal expectation: real preflight resolves only core/glfw
  // 3.3.1 and the exact Forge artifact, even when other artifacts exist on disk.
  const resolved = await Version.parse(f.clientPath, profileId, { name: 'windows', arch: 'x64', version: '' });
  assert.deepEqual(resolved.libraries.map(item => item.path), libraries);
  const result = await f.launcher.launchMinecraft(launchOptions(f));
  assert.equal(result.success, true, result.error);
  assert.equal(f.hookCalls, 1); assert.equal(f.verified.verified, true);
  assert.deepEqual(f.verified.runtime, runtime);
  assert.equal(f.spawnCalls, 1); assert.equal(f.repairCalls, 0);
  const args = f.captured.args, cpFlag = args.indexOf('-cp');
  assert.ok(cpFlag >= 0 && typeof args[cpFlag + 1] === 'string');
  const classpath = args[cpFlag + 1].split(path.delimiter).map(file => path.relative(f.clientPath, file).split(path.sep).join('/'));
  assert.ok(args.includes('cpw.mods.bootstraplauncher.BootstrapLauncher'));
  assert.ok(args.includes('--fixture-inherited')); assert.ok(args.includes('--fixture-child'));
  assert.ok(args.includes('managed.example.invalid')); assert.ok(!args.includes('forged.invalid'));
  const marker = args.find(arg => arg.startsWith('-Dminecraft.core.clientLaunchId='));
  assert.match(marker, /^-Dminecraft\.core\.clientLaunchId=[a-f0-9-]{36}$/);
  assert.ok(args.indexOf(marker) < args.indexOf('cpw.mods.bootstraplauncher.BootstrapLauncher'));
  await assert.rejects(f.guard.withMutation(f.target, () => assert.fail('fake live child must retain its launch reservation')), blocked);
  t.diagnostic(JSON.stringify({ variant, verified: true, effectiveLibraries: libraries, capturedClasspath: classpath }));
  return { f, classpath };
}

test('control: aligned inert managed Forge preflight and captured classpath agree', { timeout: 20000 }, async t => {
  const { f, classpath } = await launchAndCapture(t, 'aligned', { configure({ profile }) {
    profile.arguments.jvm = ['-DignoreList=fixture-ignore.jar', '-p',
      '${library_directory}/' + FORGE + '${classpath_separator}${library_directory}/' + CORE_331, '-cp', '${classpath}'];
  } });
  assert.deepEqual(classpath, [BASE_JAR, ...expectedLibraries.map(file => `libraries/${file}`)]);
  const args = f.captured.args;
  assert.equal(args.filter(arg => arg === '-cp').length, 1);
  assert.equal(args[args.indexOf('-p') + 1], `${path.join(f.clientPath, 'libraries')}/${FORGE}${path.delimiter}${path.join(f.clientPath, 'libraries')}/${CORE_331}`);
  assert.ok(args.includes('-DignoreList=fixture-ignore.jar,1.20.1.jar'));
  assert.ok(args.includes('-Xmx6144M'));
  f.child.emit('error', new Error('not an exact close'));
  await assert.rejects(f.guard.withMutation(f.target, () => assert.fail('error released live child')), blocked);
  f.child.emit('close', 0); await f.reservation.close();
  assert.equal(await f.guard.withMutation(f.target, () => 'safe'), 'safe');
});

// Break caught: raw full-coordinate inheritance retains parent LWJGL 3.3.2
// before the child 3.3.1 artifact, although real verification correctly shadows it.
test('managed classpath excludes physically present inherited LWJGL shadow after real verification', { timeout: 20000 }, async t => {
  const { f, classpath } = await launchAndCapture(t, 'inherited-shadow');
  assert.equal(fs.existsSync(path.join(f.clientPath, 'libraries', CORE_332)), true);
  assert.equal(classpath.includes(`libraries/${CORE_332}`), false, 'shadowed parent LWJGL must not reach the managed JVM classpath');
  assert.deepEqual(classpath, ['versions/1.20.1/1.20.1.jar', ...expectedLibraries.map(file => `libraries/${file}`)]);
});

// Break caught: raw enumeration admits a Linux-only wrong-version artifact solely
// because its file exists, although the real Windows/x64 verifier excludes it.
test('managed classpath excludes physically present Linux-only LWJGL after real verification', { timeout: 20000 }, async t => {
  const { f, classpath } = await launchAndCapture(t, 'os-excluded');
  assert.equal(fs.existsSync(path.join(f.clientPath, 'libraries', GLFW_332)), true);
  assert.equal(classpath.includes(`libraries/${GLFW_332}`), false, 'rule-excluded LWJGL must not reach the managed JVM classpath');
  assert.deepEqual(classpath, ['versions/1.20.1/1.20.1.jar', ...expectedLibraries.map(file => `libraries/${file}`)]);
});

// Break caught: rebuilding Maven paths or skipping isNative loses verified classifiers.
test('managed classpath preserves explicit and Windows x64 legacy-native classifier paths', { timeout: 20000 }, async t => {
  const libraries = [...expectedLibraries, GLFW_NATIVE, CORE_NATIVE];
  const { classpath } = await launchAndCapture(t, 'native-classifiers', { configure({ profile, library, native }) {
    profile.libraries.push(library('org.lwjgl:lwjgl-glfw:3.3.1:natives-windows', GLFW_NATIVE), native());
  } }, libraries);
  assert.deepEqual(classpath, [BASE_JAR, ...libraries.map(file => `libraries/${file}`)]);
});

// Break caught: overriding by full name or not deduplicating effective paths admits extra native jars.
test('managed classpath shadows the same classifier independently and deduplicates resolved paths', { timeout: 20000 }, async t => {
  const oldNative = 'org/lwjgl/lwjgl/3.3.2/lwjgl-3.3.2-natives-windows-64.jar';
  const effective = [CORE_331, GLFW_331, CORE_NATIVE, FORGE, CORE_NATIVE];
  const { f, classpath } = await launchAndCapture(t, 'native-shadow-dedupe', { configure({ base, profile, library, native }) {
    base.libraries.push(library('org.lwjgl:lwjgl:3.3.2:natives-windows-64', oldNative));
    profile.libraries.push(library('org.lwjgl:lwjgl:3.3.1:natives-windows-64', CORE_NATIVE), native());
  } }, effective);
  assert.equal(fs.existsSync(path.join(f.clientPath, 'libraries', oldNative)), true);
  assert.deepEqual(classpath, [BASE_JAR, ...[CORE_331, GLFW_331, CORE_NATIVE, FORGE].map(file => `libraries/${file}`)]);
});

async function assertPreSpawnFailure(f, result) {
  assert.equal(f.verified?.verified, true, 'failure must occur after real verification');
  assert.equal(result.success, false, 'required managed classpath failure must prevent spawning');
  assert.equal(f.spawnCalls, 0); assert.equal(f.captured, undefined); assert.equal(f.repairCalls, 0);
  assert.equal(await f.guard.withMutation(f.target, () => 'safe'), 'safe', 'pre-spawn failure must release before teardown');
}

// Break caught: existsSync silently drops missing required files, or accepts unsafe existing targets.
for (const target of [BASE_JAR, `libraries/${FORGE}`]) {
  for (const mutation of ['missing', 'directory', 'hardlink']) {
    test(`managed required ${target === BASE_JAR ? 'base jar' : 'library'} rejects ${mutation} after verification`, { timeout: 20000 }, async t => {
      const f = fixture(t, 'aligned', { afterVerify(f) {
        const file = path.join(f.clientPath, target);
        if (mutation === 'hardlink') fs.linkSync(file, path.join(f.root, 'alias.jar'));
        else { fs.unlinkSync(file); if (mutation === 'directory') fs.mkdirSync(file); }
      } });
      await assertPreSpawnFailure(f, await f.launcher.launchMinecraft(launchOptions(f)));
    });
  }
}

test('managed required library rejects a replaced ancestor junction after verification', { timeout: 20000 }, async t => {
  let unavailable = false;
  const f = fixture(t, 'aligned', { afterVerify(f) {
    const libraries = path.join(f.clientPath, 'libraries'), moved = path.join(f.root, 'relocated-libraries');
    fs.renameSync(libraries, moved);
    try { fs.symlinkSync(moved, libraries, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      fs.renameSync(moved, libraries);
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      unavailable = true; throw new Error('fixture junction unavailable');
    }
  } });
  const result = await f.launcher.launchMinecraft(launchOptions(f));
  if (unavailable) { t.skip('OS does not permit fixture junctions'); return; }
  await assertPreSpawnFailure(f, result);
});

test('managed required legacy-native classifier cannot disappear after verification', { timeout: 20000 }, async t => {
  const f = fixture(t, 'aligned', {
    configure({ profile, native }) { profile.libraries.push(native()); },
    afterVerify(f) { fs.unlinkSync(path.join(f.clientPath, 'libraries', CORE_NATIVE)); }
  });
  await assertPreSpawnFailure(f, await f.launcher.launchMinecraft(launchOptions(f)));
});

test('managed classpath excludes an unverified child-profile jar while retaining the required base', { timeout: 20000 }, async t => {
  const childJar = `versions/${profileId}/${profileId}.jar`;
  const { f, classpath } = await launchAndCapture(t, 'child-jar', { configure({ put, profile }) {
    put(childJar, 'inert unverified child jar'); profile.arguments.jvm = ['-DignoreList=fixture-ignore.jar'];
  } });
  assert.equal(fs.existsSync(path.join(f.clientPath, childJar)), true);
  assert.deepEqual(classpath, [BASE_JAR, ...expectedLibraries.map(file => `libraries/${file}`)]);
  assert.ok(f.captured.args.includes('-DignoreList=fixture-ignore.jar,1.20.1.jar'));
});

test('managed classpath rejects a resolved download-path mismatch without coordinate fallback', { timeout: 20000 }, async t => {
  const f = fixture(t, 'aligned', { afterVerify(f) {
    f.put('libraries/alternate/existing.jar', 'inert alternate');
    f.profile.libraries[0].downloads.artifact.path = 'alternate/existing.jar';
    f.put(`versions/${profileId}/${profileId}.json`, f.profile);
  } });
  await assertPreSpawnFailure(f, await f.launcher.launchMinecraft(launchOptions(f)));
});

// Parser failures/results are injected only after the unmocked verifier has accepted real files.
for (const invalid of ['parse-rejection', 'wrong-minecraft', 'missing-library-array', 'too-many-libraries']) {
  test(`managed classpath rejects ${invalid} without raw-library fallback`, { timeout: 20000 }, async t => {
    const parse = Version.parse;
    const f = fixture(t, 'aligned', { afterVerify() {
      t.mock.method(Version, 'parse', async (...args) => {
        if (invalid === 'parse-rejection') throw new Error('fixture managed parse rejected');
        const resolved = await parse(...args);
        if (invalid === 'wrong-minecraft') return { ...resolved, minecraftVersion: '1.20.2' };
        if (invalid === 'missing-library-array') return { ...resolved, libraries: null };
        return { ...resolved, libraries: Array(10001).fill(resolved.libraries[0]) };
      });
    } });
    const result = await f.launcher.launchMinecraft(launchOptions(f));
    await assertPreSpawnFailure(f, result);
    if (invalid === 'parse-rejection') assert.match(result.error, /fixture managed parse rejected/);
  });
}

function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}

test('managed cancellation during classpath parsing holds ownership until parsing settles and never spawns', { timeout: 20000 }, async t => {
  const entered = deferred(), release = deferred(), parse = Version.parse;
  const f = fixture(t, 'aligned', { afterVerify() {
    t.mock.method(Version, 'parse', async (...args) => { entered.resolve(); await release.promise; return parse(...args); });
  } });
  const pending = f.launcher.launchMinecraft(launchOptions(f));
  try {
    assert.equal(await Promise.race([entered.promise.then(() => true), pending.then(() => false)]), true, 'managed classpath must resolve before spawn');
    await assert.rejects(f.guard.withMutation(f.target, () => assert.fail('pending parser released ownership')), blocked);
    const stopped = f.launcher.stopMinecraft();
    await assert.rejects(f.guard.withMutation(f.target, () => assert.fail('cancel request released pending parser')), blocked);
    release.resolve();
    const [result, stopResult] = await Promise.all([pending, stopped]);
    assert.match(result.error, /cancelled/); assert.equal(stopResult.success, true);
    await assertPreSpawnFailure(f, result);
  } finally { release.resolve(); await pending; }
});

test('managed cancellation before classpath parsing does not resolve or spawn after authority returns', { timeout: 20000 }, async t => {
  const entered = deferred(), release = deferred(), parse = Version.parse; let consumptionCalls = 0;
  const f = fixture(t, 'aligned', { async afterVerify() {
    t.mock.method(Version, 'parse', (...args) => { consumptionCalls++; return parse(...args); });
    entered.resolve(); await release.promise;
  } });
  const pending = f.launcher.launchMinecraft(launchOptions(f));
  try {
    await entered.promise;
    const stopped = f.launcher.stopMinecraft(); release.resolve();
    const [result, stopResult] = await Promise.all([pending, stopped]);
    assert.match(result.error, /cancelled/); assert.equal(stopResult.success, true); assert.equal(consumptionCalls, 0);
    await assertPreSpawnFailure(f, result);
  } finally { release.resolve(); await pending; }
});
