const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const AdmZip = require('adm-zip');

const {
  validatePreparedRuntime,
  __testUtils: { finalizeForgeRuntimeMetadata, prepareManagedServerRuntimeInProcess }
} = require('../electron/services/loader-install-service.cjs');
const {
  MANAGED_RUNTIME_VERIFY_OPERATION,
  MANAGED_RUNTIME_WORKER_TOKEN_ENV,
  createManagedRuntimeRequest,
  createManagedRuntimeResponse,
  verifyManagedRuntimeResponse
} = require('../electron/services/managed-runtime-worker-protocol.cjs');
const { startManagedRuntimeWorker } = require('../electron/services/managed-runtime-worker.cjs');
const { resolveLaunchPlan, resolvePrevalidatedLaunchPlan } = require('../electron/services/server-launcher.cjs');
const { createServerProcessRunner } = require('../electron/services/server-process-runner.cjs');
const { resolveServerLoader } = require('../electron/utils/server-loader.cjs');

const USER_JVM_ARGS = 'user_jvm_args.txt';
const EDITED_USER_JVM_ARGS = '-Xmx6G\n-XX:+UseG1GC\n';
const LAUNCH_UUID = 'b09956c1-1daa-4fb9-a8fe-bf6d401c04bc';

const FORGE_RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'forge',
  loaderVersion: '47.2.0',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});
const FORGE_ARGS = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt';
// The Forge installer's own copy of the file, which @xmcl unpacks next to the args files.
const FORGE_INSTALLER_USER_JVM_ARGS = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/user_jvm_args.txt';
const FORGE_PACK_USER_JVM_ARGS = '# JVM arguments shipped with the server pack\n-Xmx4G\n';

const NEOFORGE_VERSION = '21.1.172-beta';
const NEOFORGE_RUNTIME = Object.freeze({
  minecraftVersion: '1.21.1',
  loaderFamily: 'neoforge',
  loaderVersion: NEOFORGE_VERSION,
  javaMajor: 21,
  os: 'win32',
  architecture: 'x64'
});
const NEOFORGE_ARGS = `libraries/net/neoforged/neoforge/${NEOFORGE_VERSION}/win_args.txt`;
const NEOFORGE_UNIVERSAL = `libraries/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-universal.jar`;
const NEOFORGE_VANILLA = 'libraries/net/minecraft/server/1.21.1/server-1.21.1.jar';
const NEOFORGE_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const NEOFORGE_INSTALLER_URL = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-installer.jar`;
const NEOFORGE_DEFAULT_USER_JVM_ARGS = '# JVM arguments written by the NeoForge installer\n# -Xmx4G\n';

function nativePath(relativePath) {
  return path.join(...relativePath.split('/'));
}

function tempRoot(t, label) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `mc-core-user-jvm-${label}-`)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, nativePath(relativePath));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function readUserJvmArgs(root) {
  return fs.readFileSync(path.join(root, USER_JVM_ARGS), 'utf8');
}

function runtimeRecord(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.minecraft-core-state', 'runtime.json'), 'utf8'));
}

function recordedPaths(root) {
  return runtimeRecord(root).artifacts.map(artifact => artifact.relativePath);
}

function artifactFor(root, relativePath) {
  const bytes = fs.readFileSync(path.join(root, nativePath(relativePath)));
  return {
    relativePath,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sha512: crypto.createHash('sha512').update(bytes).digest('hex')
  };
}

// Runtime records written by earlier builds also hashed the root user_jvm_args.txt.
function recordUserJvmArgsLikeEarlierBuilds(root) {
  const record = runtimeRecord(root);
  record.artifacts = [
    ...record.artifacts.filter(artifact => artifact.relativePath !== USER_JVM_ARGS),
    artifactFor(root, USER_JVM_ARGS)
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  fs.writeFileSync(
    path.join(root, '.minecraft-core-state', 'runtime.json'),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

// A modern Forge server as managed runtime preparation leaves it: the exact args file under
// libraries, the installer's copy of user_jvm_args.txt next to it and, as server packs ship it,
// a root user_jvm_args.txt.
function writeForgeServer(root, { rootUserJvmArgs = FORGE_PACK_USER_JVM_ARGS } = {}) {
  writeFile(root, FORGE_ARGS, '-DlibraryDirectory=libraries\n--launchTarget forgeserver\n--fml.forgeVersion 47.2.0\n--fml.mcVersion 1.20.1\n');
  writeFile(root, FORGE_INSTALLER_USER_JVM_ARGS, '# Forge installer default\n');
  if (rootUserJvmArgs !== null) writeFile(root, USER_JVM_ARGS, rootUserJvmArgs);
}

function launchOptions(runtime, maxRam = 4) {
  return {
    loader: runtime.loaderFamily,
    loaderVersion: runtime.loaderVersion,
    minecraftVersion: runtime.minecraftVersion,
    javaMajor: runtime.javaMajor,
    maxRam
  };
}

function jarBytes(label) {
  const zip = new AdmZip();
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(`Manifest-Version: 1.0\r\nX-Fixture: ${label}\r\n\r\n`));
  return zip.toBuffer();
}

function neoForgeInstallerJar() {
  const zip = new AdmZip();
  zip.addFile('install_profile.json', Buffer.from(JSON.stringify({
    spec: 1,
    profile: 'NeoForge',
    version: `neoforge-${NEOFORGE_VERSION}`,
    minecraft: '1.21.1',
    json: '/version.json',
    data: {},
    processors: [],
    libraries: [],
    serverJarPath: '{LIBRARY_DIR}/net/minecraft/server/{MINECRAFT_VERSION}/server-{MINECRAFT_VERSION}.jar'
  })));
  return zip.toBuffer();
}

function neoForgeMetadataXml() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <groupId>net.neoforged</groupId>\n' +
    '  <artifactId>neoforge</artifactId>\n  <versioning>\n' +
    `    <latest>${NEOFORGE_VERSION}</latest>\n    <release>${NEOFORGE_VERSION}</release>\n` +
    `    <versions><version>${NEOFORGE_VERSION}</version></versions>\n` +
    '    <lastUpdated>20260801010101</lastUpdated>\n  </versioning>\n</metadata>';
}

function fakeTransport(routes) {
  return {
    async request(url) {
      const body = routes.get(String(url));
      if (!body) throw new Error(`unexpected URL ${url}`);
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const stream = Readable.from([bytes]);
      stream.statusCode = 200;
      stream.headers = { 'content-length': String(bytes.length) };
      return stream;
    }
  };
}

// Managed runtime preparation of NeoForge, as install, update and the runtime Repair run it. The
// stand-in for the official installer writes what it leaves in its working folder, including its
// default user_jvm_args.txt.
async function prepareNeoForge(root) {
  const installer = neoForgeInstallerJar();
  return prepareManagedServerRuntimeInProcess({
    targetPath: root,
    runtime: { ...NEOFORGE_RUNTIME },
    javaPath: path.join(path.dirname(root), 'managed-java', 'bin', 'java.exe'),
    validateJava: async ({ expectedMajor }) => expectedMajor,
    transport: fakeTransport(new Map([
      [NEOFORGE_METADATA_URL, neoForgeMetadataXml()],
      [`${NEOFORGE_INSTALLER_URL}.sha512`, crypto.createHash('sha512').update(installer).digest('hex')],
      [NEOFORGE_INSTALLER_URL, installer]
    ])),
    processRunner: async request => {
      writeFile(request.cwd, NEOFORGE_VANILLA, jarBytes('vanilla-1.21.1'));
      writeFile(request.cwd, NEOFORGE_UNIVERSAL, jarBytes('neoforge'));
      writeFile(request.cwd, NEOFORGE_ARGS, `--module-path ${NEOFORGE_UNIVERSAL}\n`);
      writeFile(request.cwd, USER_JVM_ARGS, NEOFORGE_DEFAULT_USER_JVM_ARGS);
      writeFile(request.cwd, 'run.bat', `java @user_jvm_args.txt @${NEOFORGE_ARGS} %*\r\n`);
      return { code: 0, stdout: '', stderr: '' };
    }
  });
}

class FakeWorkerProcess extends EventEmitter {
  constructor(token) {
    super();
    this.env = { [MANAGED_RUNTIME_WORKER_TOKEN_ENV]: token };
    this.connected = true;
    this.responses = [];
    this.exitCodes = [];
    this.responded = new Promise(resolve => { this.resolveResponse = resolve; });
  }

  send(message, callback) {
    this.responses.push(message);
    queueMicrotask(() => {
      callback?.(null);
      this.resolveResponse();
    });
    return true;
  }

  disconnect() {
    this.connected = false;
    this.emit('disconnect');
  }

  exit(code) {
    this.exitCodes.push(code);
  }
}

// The managed start's verify step: the real worker runs the real runtime validation and answers
// through the real authenticated protocol.
async function verifyThroughWorker(targetPath, runtime) {
  const token = crypto.randomBytes(32).toString('hex');
  const requestId = crypto.randomBytes(16).toString('hex');
  const processRef = new FakeWorkerProcess(token);
  startManagedRuntimeWorker({ processRef, requestTimeoutMs: 60_000 });
  processRef.emit('message', createManagedRuntimeRequest({
    token,
    requestId,
    operation: MANAGED_RUNTIME_VERIFY_OPERATION,
    payload: { targetPath, runtime: { ...runtime } }
  }));
  await processRef.responded;
  assert.equal(processRef.responses.length, 1);
  return verifyManagedRuntimeResponse(
    processRef.responses[0], token, requestId, MANAGED_RUNTIME_VERIFY_OPERATION, { ...runtime }
  );
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = { destroyed: false, write: () => true };
  }

  finish(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  kill(signal = 'SIGKILL') {
    this.finish(null, signal);
    return true;
  }
}

// Launches through the real shared process runner and returns the Java arguments after the two
// app markers. A runtime validation selects the prevalidated (modpack-managed) launch plan.
async function spawnedLaunchArguments(serverPath, runtime, runtimeValidation = undefined) {
  const child = new FakeChild(4700);
  const spawnCalls = [];
  const runner = createServerProcessRunner({
    eventBus: new EventEmitter(),
    getListeningEndpoints: async () => [],
    randomUUID: () => LAUNCH_UUID,
    ...(runtimeValidation === undefined
      ? {}
      : { isManagedRuntimeValidation: value => value === runtimeValidation }),
    spawnProcess(file, args, options) {
      spawnCalls.push({ file, args, options });
      return child;
    }
  });
  const handle = runner.launchServerProcess({
    serverPath,
    instanceId: 'managed-user-jvm-args',
    runtime: { ...runtime },
    javaPath: path.join(path.dirname(serverPath), 'managed-java', 'bin', 'java.exe'),
    maxRam: 4,
    operationId: 'managed-user-jvm-args-start',
    publishEvents: false,
    onLine() {},
    ...(runtimeValidation === undefined ? {} : { runtimeValidation })
  });
  try {
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].options.cwd, serverPath);
    assert.deepEqual(spawnCalls[0].args.slice(0, 2), [
      '-Dminecraft.core.server.id=managed-user-jvm-args-start',
      `-Dminecraft.core.server.launch=${LAUNCH_UUID}`
    ]);
    return spawnCalls[0].args.slice(2);
  } finally {
    child.finish(0, null);
    await handle.closed;
  }
}

test('new runtime records never hash the root user_jvm_args.txt', async t => {
  const forgeRoot = tempRoot(t, 'forge-record');
  writeForgeServer(forgeRoot);
  assert.equal(finalizeForgeRuntimeMetadata(forgeRoot, FORGE_RUNTIME).valid, true);
  assert.equal(recordedPaths(forgeRoot).includes(USER_JVM_ARGS), false);
  assert.equal(recordedPaths(forgeRoot).includes(FORGE_ARGS), true);
  // The installer's own copy under libraries is runtime content and stays recorded.
  assert.equal(recordedPaths(forgeRoot).includes(FORGE_INSTALLER_USER_JVM_ARGS), true);

  const neoForgeRoot = tempRoot(t, 'neoforge-record');
  assert.equal((await prepareNeoForge(neoForgeRoot)).valid, true);
  assert.equal(recordedPaths(neoForgeRoot).includes(USER_JVM_ARGS), false);
  assert.equal(recordedPaths(neoForgeRoot).includes(NEOFORGE_ARGS), true);
  assert.equal(readUserJvmArgs(neoForgeRoot), NEOFORGE_DEFAULT_USER_JVM_ARGS);
});

test('a managed Forge server with an edited user_jvm_args.txt starts and passes the file first', async t => {
  const root = tempRoot(t, 'forge-edited');
  writeForgeServer(root);
  finalizeForgeRuntimeMetadata(root, FORGE_RUNTIME);
  fs.writeFileSync(path.join(root, USER_JVM_ARGS), EDITED_USER_JVM_ARGS);
  const expectedArguments = maxRam => [
    '@user_jvm_args.txt', `-Xmx${maxRam}G`, '-Xms1G', `@${nativePath(FORGE_ARGS)}`, 'nogui'
  ];

  assert.equal(validatePreparedRuntime(root, FORGE_RUNTIME).valid, true);
  const plan = resolveLaunchPlan(root, launchOptions(FORGE_RUNTIME, 6), { runtimeTuple: { ...FORGE_RUNTIME } });
  assert.deepEqual(plan.args, expectedArguments(6));
  assert.equal(plan.assets.userJvmArgs, path.join(root, USER_JVM_ARGS));
  assert.equal(plan.assets.forgeArgs, path.join(root, nativePath(FORGE_ARGS)));

  const verified = await verifyThroughWorker(root, FORGE_RUNTIME);
  assert.equal(verified.ok, true, `managed verification failed with ${verified.code}`);
  assert.equal(verified.result.artifacts.some(artifact => artifact.relativePath === USER_JVM_ARGS), false);
  assert.deepEqual(await spawnedLaunchArguments(root, FORGE_RUNTIME, verified.result), expectedArguments(4));
  assert.deepEqual(await spawnedLaunchArguments(root, FORGE_RUNTIME), expectedArguments(4));
  assert.equal(readUserJvmArgs(root), EDITED_USER_JVM_ARGS);
});

test('a managed Forge launch leaves user_jvm_args.txt out when the file is absent', async t => {
  const root = tempRoot(t, 'forge-absent');
  writeForgeServer(root);
  finalizeForgeRuntimeMetadata(root, FORGE_RUNTIME);
  fs.rmSync(path.join(root, USER_JVM_ARGS));
  const expectedArguments = ['-Xmx4G', '-Xms1G', `@${nativePath(FORGE_ARGS)}`, 'nogui'];

  const validation = validatePreparedRuntime(root, FORGE_RUNTIME);
  assert.equal(validation.valid, true);
  assert.deepEqual(resolveLaunchPlan(root, launchOptions(FORGE_RUNTIME), { runtimeTuple: { ...FORGE_RUNTIME } }).args,
    expectedArguments);
  const prevalidated = resolvePrevalidatedLaunchPlan(root, launchOptions(FORGE_RUNTIME), validation);
  assert.deepEqual(prevalidated.args, expectedArguments);
  assert.equal(prevalidated.assets.userJvmArgs, null);
});

test('a managed launch passes user_jvm_args.txt whenever it is present, recorded or not', async t => {
  const root = tempRoot(t, 'forge-added');
  writeForgeServer(root, { rootUserJvmArgs: null });
  finalizeForgeRuntimeMetadata(root, FORGE_RUNTIME);
  const validation = validatePreparedRuntime(root, FORGE_RUNTIME);
  // The server owner adds the file after the runtime was recorded, as the Forge documentation says.
  writeFile(root, USER_JVM_ARGS, EDITED_USER_JVM_ARGS);

  assert.equal(validation.artifacts.some(artifact => artifact.relativePath === USER_JVM_ARGS), false);
  assert.deepEqual(resolvePrevalidatedLaunchPlan(root, launchOptions(FORGE_RUNTIME), validation).args, [
    '@user_jvm_args.txt', '-Xmx4G', '-Xms1G', `@${nativePath(FORGE_ARGS)}`, 'nogui'
  ]);
  assert.deepEqual(await spawnedLaunchArguments(root, FORGE_RUNTIME), [
    '@user_jvm_args.txt', '-Xmx4G', '-Xms1G', `@${nativePath(FORGE_ARGS)}`, 'nogui'
  ]);
});

test('an earlier Forge runtime record that hashed user_jvm_args.txt validates after an edit but still requires the file', async t => {
  const root = tempRoot(t, 'forge-earlier-record');
  writeForgeServer(root);
  finalizeForgeRuntimeMetadata(root, FORGE_RUNTIME);
  recordUserJvmArgsLikeEarlierBuilds(root);
  assert.equal(recordedPaths(root).includes(USER_JVM_ARGS), true);
  fs.writeFileSync(path.join(root, USER_JVM_ARGS), EDITED_USER_JVM_ARGS);

  const validation = validatePreparedRuntime(root, FORGE_RUNTIME);
  assert.equal(validation.valid, true);
  assert.deepEqual(resolveServerLoader(root), { loader: 'forge', loaderVersion: '47.2.0', source: 'runtime-metadata' });
  assert.deepEqual(resolvePrevalidatedLaunchPlan(root, launchOptions(FORGE_RUNTIME), validation).args, [
    '@user_jvm_args.txt', '-Xmx4G', '-Xms1G', `@${nativePath(FORGE_ARGS)}`, 'nogui'
  ]);
  const verified = await verifyThroughWorker(root, FORGE_RUNTIME);
  assert.equal(verified.ok, true, `managed verification failed with ${verified.code}`);
  assert.equal(readUserJvmArgs(root), EDITED_USER_JVM_ARGS);

  // The record still lists the file, so its presence is still checked.
  fs.rmSync(path.join(root, USER_JVM_ARGS));
  assert.throws(() => validatePreparedRuntime(root, FORGE_RUNTIME), error => error.code === 'RUNTIME_INCOMPLETE');
  // Every other recorded artifact keeps its exact hash check.
  writeFile(root, USER_JVM_ARGS, EDITED_USER_JVM_ARGS);
  fs.appendFileSync(path.join(root, nativePath(FORGE_ARGS)), '--changed\n');
  assert.throws(() => validatePreparedRuntime(root, FORGE_RUNTIME), error => error.code === 'RUNTIME_INCOMPLETE');
});

test('a managed NeoForge server with an edited user_jvm_args.txt starts and passes the file first', async t => {
  const root = tempRoot(t, 'neoforge-edited');
  await prepareNeoForge(root);
  fs.writeFileSync(path.join(root, USER_JVM_ARGS), EDITED_USER_JVM_ARGS);
  const expectedArguments = maxRam => [
    '@user_jvm_args.txt', `-Xmx${maxRam}G`, '-Xms1G', `@${nativePath(NEOFORGE_ARGS)}`, 'nogui'
  ];

  assert.equal(validatePreparedRuntime(root, NEOFORGE_RUNTIME).valid, true);
  const plan = resolveLaunchPlan(root, launchOptions(NEOFORGE_RUNTIME, 6), { runtimeTuple: { ...NEOFORGE_RUNTIME } });
  assert.equal(plan.type, 'neoforge');
  assert.deepEqual(plan.args, expectedArguments(6));

  const verified = await verifyThroughWorker(root, NEOFORGE_RUNTIME);
  assert.equal(verified.ok, true, `managed verification failed with ${verified.code}`);
  assert.equal(verified.result.artifacts.some(artifact => artifact.relativePath === USER_JVM_ARGS), false);
  assert.deepEqual(await spawnedLaunchArguments(root, NEOFORGE_RUNTIME, verified.result), expectedArguments(4));
  assert.equal(readUserJvmArgs(root), EDITED_USER_JVM_ARGS);
});

test('an earlier NeoForge runtime record that hashed user_jvm_args.txt validates after an edit', async t => {
  const root = tempRoot(t, 'neoforge-earlier-record');
  await prepareNeoForge(root);
  recordUserJvmArgsLikeEarlierBuilds(root);
  fs.writeFileSync(path.join(root, USER_JVM_ARGS), EDITED_USER_JVM_ARGS);

  assert.equal(validatePreparedRuntime(root, NEOFORGE_RUNTIME).valid, true);
  const verified = await verifyThroughWorker(root, NEOFORGE_RUNTIME);
  assert.equal(verified.ok, true, `managed verification failed with ${verified.code}`);
  assert.equal(verified.result.artifacts.some(artifact => artifact.relativePath === USER_JVM_ARGS), true);
  assert.deepEqual(await spawnedLaunchArguments(root, NEOFORGE_RUNTIME, verified.result), [
    '@user_jvm_args.txt', '-Xmx4G', '-Xms1G', `@${nativePath(NEOFORGE_ARGS)}`, 'nogui'
  ]);
});

test('runtime preparation keeps an edited user_jvm_args.txt and recreates a missing one with the loader default', async t => {
  const root = tempRoot(t, 'neoforge-prepare');
  await prepareNeoForge(root);
  assert.equal(readUserJvmArgs(root), NEOFORGE_DEFAULT_USER_JVM_ARGS);

  // An update or runtime Repair prepares the runtime again: the owner's edit is never overwritten.
  fs.writeFileSync(path.join(root, USER_JVM_ARGS), EDITED_USER_JVM_ARGS);
  assert.equal((await prepareNeoForge(root)).valid, true);
  assert.equal(readUserJvmArgs(root), EDITED_USER_JVM_ARGS);
  assert.equal(validatePreparedRuntime(root, NEOFORGE_RUNTIME).valid, true);

  // NeoForge needs the file to exist; preparation recreates a missing one with the loader default.
  fs.rmSync(path.join(root, USER_JVM_ARGS));
  assert.throws(() => validatePreparedRuntime(root, NEOFORGE_RUNTIME), error => error.code === 'RUNTIME_INCOMPLETE');
  assert.equal((await prepareNeoForge(root)).valid, true);
  assert.equal(readUserJvmArgs(root), NEOFORGE_DEFAULT_USER_JVM_ARGS);
  assert.equal(recordedPaths(root).includes(USER_JVM_ARGS), false);
});

test('the managed runtime protocol needs no user_jvm_args.txt record for NeoForge but keeps the loader files required', () => {
  const token = 'c'.repeat(64);
  const requestId = 'd'.repeat(32);
  const loader = { family: 'neoforge', argsFile: NEOFORGE_ARGS, universalJar: NEOFORGE_UNIVERSAL };
  const artifact = relativePath => ({ relativePath, size: 7, sha256: 'e'.repeat(64), sha512: 'f'.repeat(128) });
  const verify = artifacts => {
    const result = { valid: true, runtime: { ...NEOFORGE_RUNTIME }, loader, artifacts: artifacts.map(artifact) };
    const response = createManagedRuntimeResponse({
      token, requestId, operation: MANAGED_RUNTIME_VERIFY_OPERATION, ok: true, result
    });
    return verifyManagedRuntimeResponse(response, token, requestId, MANAGED_RUNTIME_VERIFY_OPERATION, { ...NEOFORGE_RUNTIME });
  };

  assert.equal(verify([NEOFORGE_ARGS, NEOFORGE_UNIVERSAL, 'server.jar']).ok, true);
  assert.equal(verify([NEOFORGE_ARGS, NEOFORGE_UNIVERSAL, 'server.jar', USER_JVM_ARGS]).ok, true);
  for (const missing of [NEOFORGE_ARGS, NEOFORGE_UNIVERSAL, 'server.jar']) {
    assert.throws(
      () => verify([NEOFORGE_ARGS, NEOFORGE_UNIVERSAL, 'server.jar'].filter(value => value !== missing)),
      error => error.code === 'MANAGED_RUNTIME_WORKER_PROTOCOL',
      missing
    );
  }
});

test('a user_jvm_args.txt that is not a regular file fails a managed launch closed', async t => {
  const root = tempRoot(t, 'forge-not-file');
  writeForgeServer(root, { rootUserJvmArgs: null });
  finalizeForgeRuntimeMetadata(root, FORGE_RUNTIME);
  const validation = validatePreparedRuntime(root, FORGE_RUNTIME);
  fs.mkdirSync(path.join(root, USER_JVM_ARGS));

  assert.throws(
    () => resolveLaunchPlan(root, launchOptions(FORGE_RUNTIME), { runtimeTuple: { ...FORGE_RUNTIME } }),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  assert.throws(
    () => resolvePrevalidatedLaunchPlan(root, launchOptions(FORGE_RUNTIME), validation),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
});

test('unmanaged v26.6.1 Forge servers keep the v26.6.1 launch arguments', async t => {
  const root = tempRoot(t, 'forge-v26');
  writeFile(root, '.minecraft-core.json', JSON.stringify({
    version: '1.20.1', loader: 'forge', loaderVersion: '47.2.0', fabric: null, port: 25565, maxRam: 4
  }, null, 2));
  writeForgeServer(root, { rootUserJvmArgs: EDITED_USER_JVM_ARGS });
  const unmanagedTuple = { ...FORGE_RUNTIME };

  assert.deepEqual(await spawnedLaunchArguments(root, unmanagedTuple), [
    '@user_jvm_args.txt', '-Xmx4G', '-Xms1G', `@${nativePath(FORGE_ARGS)}`, 'nogui'
  ]);
  // Without a root file, v26.6.1 discovery uses the installer's copy under libraries.
  fs.rmSync(path.join(root, USER_JVM_ARGS));
  assert.deepEqual(await spawnedLaunchArguments(root, unmanagedTuple), [
    `@${nativePath(FORGE_INSTALLER_USER_JVM_ARGS)}`, '-Xmx4G', '-Xms1G', `@${nativePath(FORGE_ARGS)}`, 'nogui'
  ]);
  assert.equal(fs.existsSync(path.join(root, '.minecraft-core-state')), false);
});
