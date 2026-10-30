const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const AdmZip = require('adm-zip');

const {
  resolveLaunchPlan,
  syncServerPort,
  writeServerProperties
} = require('../electron/services/server-launcher.cjs');
const {
  isNeoForgeDowngradeGuardJar,
  __testUtils: { neoForgeDowngradeGuardJarBytes, publishForgeRuntimeMetadata, quiltLauncherJarBytes }
} = require('../electron/services/loader-install-service.cjs');
const { v26_6_1LaunchDecision } = require('./fixtures/v26.6.1-launch-decision.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const {
  runWithServerMutationLease,
  sharedServerMutationContext
} = require('../electron/services/server-mutation-context.cjs');
const { resolveServerLoader } = require('../electron/utils/server-loader.cjs');
const {
  createServerProcessRunner,
  parseNetstatListeningEndpoints,
  parseNetstatListeningPids
} = require('../electron/services/server-process-runner.cjs');
const {
  issueForgeCandidateHealthAuthorization
} = require('../electron/services/forge-candidate-health-authorization.cjs');

function makeTempForgeServer() {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-forge-'));
  const forgeDir = path.join(
    serverPath,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    '1.20.1-47.4.18'
  );

  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'user_jvm_args.txt'), '# test\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'win_args.txt'), '-p libraries/a.jar;libraries/b.jar\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'unix_args.txt'), '-p libraries/a.jar:libraries/b.jar\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'run.bat'), '@echo off\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'run.sh'), '#!/bin/sh\n', 'utf8');

  return serverPath;
}

function makeRuntimeTuple(loaderFamily, loaderVersion, minecraftVersion = '1.20.1', javaMajor = 17) {
  return {
    minecraftVersion,
    loaderFamily,
    loaderVersion,
    javaMajor,
    os: 'win32',
    architecture: 'x64'
  };
}

function runtimeArtifact(root, relativePath) {
  const filePath = path.join(root, ...relativePath.split('/'));
  const bytes = fs.readFileSync(filePath);
  return {
    relativePath,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sha512: crypto.createHash('sha512').update(bytes).digest('hex')
  };
}

function writeMinimalJar(filePath, manifestLines = ['Manifest-Version: 1.0', '', '']) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const archive = new AdmZip();
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from(manifestLines.join('\r\n'), 'utf8'));
  archive.addFile('fixture.class', Buffer.from('fixture'));
  archive.writeZip(filePath);
}

function writeLegacyForgeRuntimeMarker(serverPath) {
  const runtime = makeRuntimeTuple('forge', '14.23.5.2860', '1.12.2', 8);
  const launchJar = 'forge-1.12.2-14.23.5.2860.jar';
  const serverJar = 'minecraft_server.1.12.2.jar';
  const libraries = ['libraries/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar'];
  writeMinimalJar(path.join(serverPath, ...libraries[0].split('/')));
  writeMinimalJar(path.join(serverPath, serverJar));
  writeMinimalJar(path.join(serverPath, launchJar), [
    'Manifest-Version: 1.0',
    'Main-Class: net.minecraftforge.fml.relauncher.ServerLaunchWrapper',
    `Class-Path: ${libraries[0]} ${serverJar}`,
    '',
    ''
  ]);
  const statePath = path.join(serverPath, '.minecraft-core-state');
  fs.mkdirSync(statePath, { recursive: true });
  fs.writeFileSync(path.join(statePath, 'runtime.json'), JSON.stringify({
    formatVersion: 1,
    runtime,
    loader: { family: 'forge', launchJar, serverJar, libraries },
    artifacts: [launchJar, serverJar, ...libraries]
      .map(relativePath => runtimeArtifact(serverPath, relativePath))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))
  }));
  return { runtime, launchJar, serverJar, libraries };
}

const V26_FORGE_ARGS = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt';

// The unmanaged tuple server-manager builds for every start (server-manager.cjs startMinecraftServer).
function v26ForgeTuple(loaderVersion = '47.2.0') {
  return makeRuntimeTuple('forge', loaderVersion, '1.20.1', 17);
}

// A Forge 1.20.1 server as v26.6.1 installed it: args files and a root server.jar, no app runtime metadata.
function makeV26ForgeServer() {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-forge-v26-'));
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({
    version: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.2.0',
    fabric: null,
    port: 25565,
    maxRam: 4
  }, null, 2));
  fs.writeFileSync(path.join(serverPath, 'user_jvm_args.txt'), '# Xmx and Xms set the maximum and minimum RAM usage.\n');
  const argsPath = path.join(serverPath, ...V26_FORGE_ARGS.split('/'));
  fs.mkdirSync(path.dirname(argsPath), { recursive: true });
  fs.writeFileSync(argsPath, '-DlibraryDirectory=libraries\n--launchTarget forgeserver\n--fml.forgeVersion 47.2.0\n--fml.mcVersion 1.20.1\n');
  fs.writeFileSync(path.join(serverPath, 'run.bat'), `java @user_jvm_args.txt @${V26_FORGE_ARGS} %*\r\n`);
  writeMinimalJar(path.join(serverPath, 'server.jar'));
  return serverPath;
}

function v26ForgeLaunchArgs(maxRam = 4) {
  return ['@user_jvm_args.txt', `-Xmx${maxRam}G`, '-Xms1G', `@${path.join(...V26_FORGE_ARGS.split('/'))}`, 'nogui'];
}

// Servers v26.6.1 labelled NeoForge or Quilt. v26.6.1 could install neither loader: its config
// enrichment persisted the loader it detected from file names (the NeoForge installer jar, the Quilt
// launcher), it ran such servers like every label other than Fabric and Forge, and it never wrote
// .minecraft-core-state. The other files are what the official installers leave in the folder.
const V26_PLAIN_LOADERS = Object.freeze({
  neoforge: Object.freeze({ minecraftVersion: '1.21.1', loaderVersion: '21.1.77', javaMajor: 21 }),
  quilt: Object.freeze({ minecraftVersion: '1.20.1', loaderVersion: null, javaMajor: 17 })
});
const QUILT_LOADER_LIBRARY = 'libraries/org/quiltmc/quilt-loader/0.26.4/quilt-loader-0.26.4.jar';

function makeV26PlainLoaderServer(t, loader, { serverJar = true } = {}) {
  const { minecraftVersion, loaderVersion } = V26_PLAIN_LOADERS[loader];
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), `mc-core-${loader}-v26-`));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({
    version: minecraftVersion,
    loader,
    loaderVersion,
    fabric: null,
    port: 25565,
    maxRam: 4
  }, null, 2));
  if (loader === 'neoforge') {
    const argsFile = `libraries/net/neoforged/neoforge/${loaderVersion}/win_args.txt`;
    const argsPath = path.join(serverPath, ...argsFile.split('/'));
    fs.mkdirSync(path.dirname(argsPath), { recursive: true });
    fs.writeFileSync(argsPath, `--launchTarget forgeserver\n--fml.neoForgeVersion ${loaderVersion}\n--fml.mcVersion ${minecraftVersion}\n`);
    fs.writeFileSync(path.join(serverPath, 'user_jvm_args.txt'), '# Xmx and Xms set the maximum and minimum RAM usage.\n');
    fs.writeFileSync(path.join(serverPath, 'run.bat'), `java @user_jvm_args.txt @${argsFile} %*\r\n`);
    writeMinimalJar(path.join(serverPath, `neoforge-${loaderVersion}-installer.jar`));
  } else {
    writeMinimalJar(path.join(serverPath, 'quilt-server-launch.jar'), [
      'Manifest-Version: 1.0',
      'Main-Class: org.quiltmc.loader.impl.launch.server.QuiltServerLauncher',
      '',
      ''
    ]);
    fs.writeFileSync(path.join(serverPath, 'quilt-server-launcher.properties'), 'serverJar=server.jar\n');
    writeMinimalJar(path.join(serverPath, ...QUILT_LOADER_LIBRARY.split('/')));
  }
  if (serverJar) writeMinimalJar(path.join(serverPath, 'server.jar'));
  return serverPath;
}

// The unmanaged tuple server-manager builds for such a server; a missing loader version falls back
// to the game version.
function v26PlainLoaderTuple(loader) {
  const { minecraftVersion, loaderVersion, javaMajor } = V26_PLAIN_LOADERS[loader];
  return makeRuntimeTuple(loader, loaderVersion || minecraftVersion, minecraftVersion, javaMajor);
}

function plainJarLaunchArgs(jar, maxRam = 4) {
  return [`-Xmx${maxRam}G`, '-Xms1G', '-jar', jar, 'nogui'];
}

function writeRuntimeRecord(serverPath, runtime, loader, relativePaths) {
  const statePath = path.join(serverPath, '.minecraft-core-state');
  fs.mkdirSync(statePath, { recursive: true });
  fs.writeFileSync(path.join(statePath, 'runtime.json'), JSON.stringify({
    formatVersion: 1,
    runtime,
    loader,
    artifacts: relativePaths
      .map(relativePath => runtimeArtifact(serverPath, relativePath))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))
  }));
}

// A NeoForge runtime as the current installer records it. New layouts carry the downgrade guard as
// the root server.jar; layouts published by pre-release builds kept a vanilla root jar.
function writeRecordedNeoForgeRuntime(serverPath, { rootServerJar = 'guard' } = {}) {
  const runtime = makeRuntimeTuple('neoforge', '21.1.77', '1.21.1', 21);
  const argsFile = 'libraries/net/neoforged/neoforge/21.1.77/win_args.txt';
  const universalJar = 'libraries/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-universal.jar';
  const minecraftServerJar = 'libraries/net/minecraft/server/1.21.1/server-1.21.1.jar';
  const argsPath = path.join(serverPath, ...argsFile.split('/'));
  fs.mkdirSync(path.dirname(argsPath), { recursive: true });
  fs.writeFileSync(argsPath, '--launchTarget forgeserver\n--fml.neoForgeVersion 21.1.77\n--fml.mcVersion 1.21.1\n');
  writeMinimalJar(path.join(serverPath, ...universalJar.split('/')));
  writeMinimalJar(path.join(serverPath, ...minecraftServerJar.split('/')));
  if (rootServerJar === 'guard') {
    fs.writeFileSync(path.join(serverPath, 'server.jar'), neoForgeDowngradeGuardJarBytes());
  } else {
    writeMinimalJar(path.join(serverPath, 'server.jar'));
  }
  fs.writeFileSync(path.join(serverPath, 'user_jvm_args.txt'), '# user arguments\n');
  writeRuntimeRecord(serverPath, runtime, { family: 'neoforge', argsFile, universalJar },
    [argsFile, universalJar, 'server.jar', minecraftServerJar]);
  return { runtime, argsFile };
}

// A Quilt runtime as the current installer records it: the app-built launcher, its properties naming
// the vanilla jar under libraries, and a root server.jar that is a copy of the launcher.
function writeRecordedQuiltRuntime(serverPath) {
  const runtime = makeRuntimeTuple('quilt', '0.26.4', '1.20.1', 17);
  const minecraftServerJar = 'libraries/net/minecraft/server/1.20.1/server-1.20.1.jar';
  const libraries = [{
    coordinate: 'org.quiltmc:quilt-loader:0.26.4',
    repository: 'https://maven.quiltmc.org/repository/release/',
    relativePath: QUILT_LOADER_LIBRARY
  }];
  writeMinimalJar(path.join(serverPath, ...QUILT_LOADER_LIBRARY.split('/')));
  writeMinimalJar(path.join(serverPath, ...minecraftServerJar.split('/')));
  const launcherBytes = quiltLauncherJarBytes(libraries);
  fs.writeFileSync(path.join(serverPath, 'quilt-server-launch.jar'), launcherBytes);
  fs.writeFileSync(path.join(serverPath, 'server.jar'), launcherBytes);
  fs.writeFileSync(path.join(serverPath, 'quilt-server-launcher.properties'), `serverJar=${minecraftServerJar}\n`);
  writeRuntimeRecord(serverPath, runtime, {
    family: 'quilt',
    launcherJar: 'quilt-server-launch.jar',
    properties: 'quilt-server-launcher.properties',
    libraries
  }, ['quilt-server-launch.jar', 'quilt-server-launcher.properties', 'server.jar', minecraftServerJar, QUILT_LOADER_LIBRARY]);
  return { runtime };
}

function startLeaseFixture(root, operationId, initialRevision = 9) {
  let revision = initialRevision;
  const bumps = [];
  const coordinator = new ServerMutationCoordinator({
    context: sharedServerMutationContext,
    readContentRevision: () => revision,
    bumpContentRevision(_serverPath, options) {
      bumps.push({ ...options });
      assert.equal(options.expectedRevision, revision);
      revision += 1;
      return revision;
    }
  });
  coordinator.completeStartupRecovery([]);
  return {
    bumps,
    revision: () => revision,
    acquire: () => coordinator.acquireStart(
      { instanceId: `launcher-${operationId}`, serverPath: root },
      { operation: 'server-start', operationId, parentMutationLease: null }
    )
  };
}

function minecraftShapedProperties(port = 25565) {
  return [
    '#Minecraft server properties',
    '#Thu Oct 29 21:14:03 AST 2026',
    'allow-flight=false',
    'level-name=world',
    'motd=A Minecraft Server',
    'server-ip=',
    `server-port=${port}`,
    'view-distance=10'
  ].join('\n') + '\n';
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = {
      destroyed: false,
      writes: [],
      write: value => {
        this.stdin.writes.push(value);
        if (this.onStdinWrite) this.onStdinWrite(value);
        return true;
      }
    };
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
    this.killed = true;
    this.finish(null, signal);
    return true;
  }
}

function runnerFixture({ loader = 'vanilla', listenerEndpoints, pid = 4200, planOverrides = {} } = {}) {
  const child = new FakeChild(pid);
  const eventBus = new EventEmitter();
  const spawnCalls = [];
  const plan = {
    type: loader === 'forge' ? 'forge' : 'jar',
    loader,
    jar: loader === 'forge' ? null : `C:\\Minecraft\\server-${loader}.jar`,
    args: [`-Xmx4G`, '-jar', `server-${loader}.jar`, 'nogui'],
    cwd: 'C:\\Minecraft\\Runner',
    readyMarkers: [`READY-${loader}`],
    fatalMarkers: [`FATAL-${loader}`],
    runtime: makeRuntimeTuple(loader, loader === 'vanilla' ? '1.20.1' : 'test-loader'),
    ...planOverrides
  };
  const runner = createServerProcessRunner({
    eventBus,
    randomUUID: () => 'b09956c1-1daa-4fb9-a8fe-bf6d401c04bc',
    getListeningEndpoints: async () => listenerEndpoints || [{ host: '127.0.0.1', port: 25565, pid }],
    resolveLaunchPlan() {
      return plan;
    },
    spawnProcess(file, args, options) {
      spawnCalls.push({ file, args, options });
      return child;
    }
  });
  return { child, eventBus, plan, runner, spawnCalls };
}

function launchRequest(loader = 'vanilla', overrides = {}) {
  return {
    serverPath: 'C:\\Minecraft\\Runner',
    instanceId: 'runner-instance',
    runtime: makeRuntimeTuple(loader, loader === 'vanilla' ? '1.20.1' : 'test-loader'),
    javaPath: 'C:\\Java\\bin\\java.exe',
    maxRam: 4,
    operationId: `health-${loader}`,
    publishEvents: false,
    onLine() {},
    ...overrides
  };
}

function protectedCandidateAuthorization(jobId = 'job-forge') {
  return issueForgeCandidateHealthAuthorization({
    candidatePath: 'C:\\Minecraft\\Runner',
    instanceId: 'runner-instance',
    jobId,
    operationKind: 'upgrade',
    restorePointId: 'restore-one',
    restorePointSha256: 'a'.repeat(64),
    runtime: makeRuntimeTuple('forge', 'test-loader'),
    serverPath: 'C:\\Minecraft\\Live',
    sourceRevision: 5
  });
}

function candidateHealthOperationId(jobId) {
  return `health-${crypto.createHash('sha256').update(`candidate:${jobId}`).digest('hex').slice(0, 32)}`;
}

test('resolveLaunchPlan prefers platform-specific Forge args files', () => {
  const serverPath = makeTempForgeServer();

  try {
    const plan = resolveLaunchPlan(serverPath, {
      loader: 'forge',
      maxRam: 4,
      minecraftVersion: '1.20.1',
      loaderVersion: '47.4.18'
    });

    const expectedArgsFile = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';

    assert.equal(plan.type, 'forge');
    assert.equal(plan.loader, 'forge');
    assert.equal(plan.cwd, serverPath);
    assert.ok(plan.readyMarkers.some(marker => marker.includes('Done (')));
    assert.ok(plan.fatalMarkers.includes('UnsupportedClassVersionError'));
    assert.equal(path.basename(plan.assets.forgeArgs), expectedArgsFile);
    assert.match(
      plan.args.find((arg) => typeof arg === 'string' && arg.startsWith('@libraries')),
      new RegExp(`${expectedArgsFile.replace('.', '\\.')}$`)
    );
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});

test('Vanilla and Fabric launch plans keep jar and args while exposing the closed runtime shape', () => {
  const vanillaPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-vanilla-'));
  const fabricPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-fabric-'));
  try {
    fs.writeFileSync(path.join(vanillaPath, 'server.jar'), 'vanilla');
    const vanillaRuntime = makeRuntimeTuple('vanilla', '1.20.1');
    const vanilla = resolveLaunchPlan(vanillaPath, { loader: 'vanilla', maxRam: 3 }, { runtimeTuple: vanillaRuntime });
    assert.deepEqual(Object.keys(vanilla).sort(), ['args', 'cwd', 'fatalMarkers', 'jar', 'loader', 'readyMarkers', 'runtime', 'type']);
    assert.equal(vanilla.jar, path.join(vanillaPath, 'server.jar'));
    assert.deepEqual(vanilla.args, ['-Xmx3G', '-Xms1G', '-jar', vanilla.jar, 'nogui']);
    assert.deepEqual(vanilla.runtime, vanillaRuntime);

    const fabricJar = new AdmZip();
    fabricJar.addFile('net/fabricmc/loader/impl/launch/server/FabricServerLauncher.class', Buffer.from('fixture'));
    fabricJar.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.loader.impl.launch.server.FabricServerLauncher\r\n\r\n'));
    fabricJar.writeZip(path.join(fabricPath, 'fabric-server-launch.jar'));
    fs.writeFileSync(path.join(fabricPath, 'server.jar'), 'server');
    const fabricRuntime = makeRuntimeTuple('fabric', '0.16.14');
    const fabric = resolveLaunchPlan(fabricPath, { loader: 'fabric', maxRam: 4 }, { runtimeTuple: fabricRuntime });
    assert.equal(fabric.loader, 'fabric');
    assert.equal(fabric.jar, path.join(fabricPath, 'fabric-server-launch.jar'));
    assert.equal(fabric.cwd, fabricPath);
  } finally {
    fs.rmSync(vanillaPath, { recursive: true, force: true });
    fs.rmSync(fabricPath, { recursive: true, force: true });
  }
});

test('manual Forge launch rejects an overlong discovered user JVM response file before mutation', t => {
  if (process.platform !== 'win32') {
    t.skip('Windows response-file path behavior');
    return;
  }
  const serverPath = makeTempForgeServer();

  try {
    fs.rmSync(path.join(serverPath, 'user_jvm_args.txt'));
    const nestedUserJvmArgs = path.join(serverPath, 'x'.repeat(200), 'user_jvm_args.txt');
    fs.mkdirSync(path.dirname(nestedUserJvmArgs), { recursive: true });
    fs.writeFileSync(nestedUserJvmArgs, '# test\n', 'utf8');
    const forgeArgs = path.join(
      serverPath,
      'libraries',
      'net',
      'minecraftforge',
      'forge',
      '1.20.1-47.4.18',
      'win_args.txt'
    );
    assert.ok(forgeArgs.length < 260);
    assert.ok(nestedUserJvmArgs.length >= 260);

    assert.throws(
      () => resolveLaunchPlan(serverPath, {
        loader: 'forge',
        maxRam: 4,
        minecraftVersion: '1.20.1',
        loaderVersion: '47.4.18'
      }),
      error => error.code === 'SERVER_PATH_TOO_LONG' && error.retryable === true &&
        error.details?.field === 'serverPath' && !String(error.message).includes(serverPath)
    );
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});

test('managed legacy Forge launch uses only the exact immutable tuple-derived jar', () => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-forge-legacy-launch-'));
  try {
    const fixture = writeLegacyForgeRuntimeMarker(serverPath);
    writeMinimalJar(path.join(serverPath, 'forge-1.12.2-14.23.5.9999.jar'));
    fs.writeFileSync(path.join(serverPath, 'launch.bat'), 'java -jar forge-1.12.2-14.23.5.9999.jar');
    const distractorArgs = path.join(serverPath, '1.12.2-14.23.5.2860', 'win_args.txt');
    fs.mkdirSync(path.dirname(distractorArgs), { recursive: true });
    fs.writeFileSync(distractorArgs, '-jar forge-1.12.2-14.23.5.9999.jar');

    const plan = resolveLaunchPlan(serverPath, {
      loader: 'forge',
      maxRam: 6,
      minecraftVersion: '1.12.2',
      loaderVersion: '14.23.5.2860'
    }, { runtimeTuple: fixture.runtime });

    const exactLaunchJar = path.join(serverPath, fixture.launchJar);
    assert.equal(plan.type, 'jar');
    assert.equal(plan.loader, 'forge');
    assert.equal(plan.jar, exactLaunchJar);
    assert.deepEqual(plan.args, ['-Xmx6G', '-Xms1G', '-jar', exactLaunchJar, 'nogui']);
    assert.deepEqual(plan.runtime, fixture.runtime);
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});

test('managed modern Forge launch uses the exact recorded args file instead of filesystem scoring', () => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-forge-modern-exact-'));
  try {
    const runtime = makeRuntimeTuple('forge', '47.4.18');
    const argsRelative = 'libraries/net/minecraftforge/forge/1.20.1-47.4.18/win_args.txt';
    const argsPath = path.join(serverPath, ...argsRelative.split('/'));
    fs.mkdirSync(path.dirname(argsPath), { recursive: true });
    fs.writeFileSync(argsPath, '--launchTarget forgeserver\n');
    const distractor = path.join(serverPath, '1.20.1-47.4.18', 'win_args.txt');
    fs.mkdirSync(path.dirname(distractor), { recursive: true });
    fs.writeFileSync(distractor, '-jar wrong.jar\n');
    fs.mkdirSync(path.join(serverPath, '.minecraft-core-state'));
    fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'runtime.json'), JSON.stringify({
      formatVersion: 1,
      runtime,
      loader: { family: 'forge', argsFile: argsRelative },
      artifacts: [runtimeArtifact(serverPath, argsRelative)]
    }));

    const plan = resolveLaunchPlan(serverPath, {
      loader: 'forge',
      maxRam: 4,
      minecraftVersion: '1.20.1',
      loaderVersion: '47.4.18'
    }, { runtimeTuple: runtime });
    assert.equal(plan.assets.forgeArgs, argsPath);
    assert.equal(plan.args.includes(`@${argsRelative.split('/').join(path.sep)}`), true);
    assert.equal(plan.args.includes(`@${path.relative(serverPath, distractor)}`), false);
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});

test('a valid app-owned Fabric runtime marker remains launchable', () => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-fabric-runtime-marker-'));
  try {
    const launcher = new AdmZip();
    launcher.addFile('net/fabricmc/loader/impl/launch/server/FabricServerLauncher.class', Buffer.from('fixture'));
    launcher.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.loader.impl.launch.server.FabricServerLauncher\r\n\r\n'));
    launcher.writeZip(path.join(serverPath, 'fabric-server-launch.jar'));

    const vanilla = new AdmZip();
    vanilla.addFile('net/minecraft/server/Main.class', Buffer.from('fixture'));
    vanilla.writeZip(path.join(serverPath, 'server.jar'));

    const runtime = makeRuntimeTuple('fabric', '0.15.10');
    const statePath = path.join(serverPath, '.minecraft-core-state');
    fs.mkdirSync(statePath, { recursive: true });
    fs.writeFileSync(path.join(statePath, 'runtime.json'), JSON.stringify({
      formatVersion: 1,
      runtime,
      loader: { family: 'fabric', launcherJar: 'fabric-server-launch.jar' },
      artifacts: [
        runtimeArtifact(serverPath, 'fabric-server-launch.jar'),
        runtimeArtifact(serverPath, 'server.jar')
      ]
    }));

    assert.deepEqual(resolveServerLoader(serverPath), {
      loader: 'fabric',
      loaderVersion: '0.15.10',
      source: 'runtime-metadata'
    });
    const plan = resolveLaunchPlan(serverPath, { maxRam: 2 }, { runtimeTuple: runtime });
    assert.equal(plan.loader, 'fabric');
    assert.equal(plan.jar, path.join(serverPath, 'fabric-server-launch.jar'));
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});

test('an explicit unsupported loader can never fall through to a generic server jar', () => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-unknown-'));
  try {
    fs.writeFileSync(path.join(serverPath, 'server.jar'), 'not a fallback');
    assert.throws(
      () => resolveLaunchPlan(serverPath, { loader: 'unknown-loader' }),
      error => error.code === 'UNSUPPORTED_LOADER'
    );
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});

test('NeoForge and Quilt filenames alone are not treated as installed runtimes', () => {
  const neoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neo-name-'));
  const quiltPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-name-'));
  try {
    fs.writeFileSync(path.join(neoPath, 'neoforge-21.1.172.jar'), 'name only');
    fs.writeFileSync(path.join(quiltPath, 'quilt-server-launch.jar'), 'name only');
    assert.equal(resolveServerLoader(neoPath).loader, null);
    assert.equal(resolveServerLoader(quiltPath).loader, null);
  } finally {
    fs.rmSync(neoPath, { recursive: true, force: true });
    fs.rmSync(quiltPath, { recursive: true, force: true });
  }
});

test('a corrupt app-owned runtime marker can never fall through to Vanilla', () => {
  for (const [family, marker] of [
    ['neoforge', '{"formatVersion":1,"runtime":'],
    ['quilt', JSON.stringify({
      formatVersion: 1,
      runtime: makeRuntimeTuple('quilt', '0.26.4'),
      loader: { family: 'quilt' },
      artifacts: []
    })]
  ]) {
    const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), `mc-core-${family}-corrupt-marker-`));
    try {
      fs.writeFileSync(path.join(serverPath, 'server.jar'), 'vanilla-looking fallback');
      fs.mkdirSync(path.join(serverPath, '.minecraft-core-state'), { recursive: true });
      fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'runtime.json'), marker);
      assert.throws(
        () => resolveLaunchPlan(serverPath, { maxRam: 4 }),
        error => error.code === 'RUNTIME_INCOMPLETE',
        family
      );
    } finally {
      fs.rmSync(serverPath, { recursive: true, force: true });
    }
  }
});

test('shared process runner binds every loader marker and emits only operation-scoped complete lines', async () => {
  for (const loader of ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']) {
    const lines = [];
    const { child, plan, runner, spawnCalls } = runnerFixture({ loader, pid: 4300 + lines.length });
    child.onStdinWrite = value => {
      if (value === 'stop\n') setImmediate(() => child.finish(0, null));
    };
    const handle = runner.launchServerProcess(launchRequest(loader, {
      onLine: value => lines.push(value)
    }));

    assert.equal(handle.pid, child.pid);
    assert.equal(handle.isLive(), true);
    assert.equal(handle.publishEvents, false);
    assert.deepEqual(handle.readyMarkers, plan.readyMarkers);
    assert.deepEqual(handle.fatalMarkers, plan.fatalMarkers);
    assert.deepEqual(spawnCalls, [{
      file: 'C:\\Java\\bin\\java.exe',
      args: [`-Dminecraft.core.server.id=health-${loader}`, '-Dminecraft.core.server.launch=b09956c1-1daa-4fb9-a8fe-bf6d401c04bc', ...plan.args],
      options: {
        cwd: plan.cwd,
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    }]);

    child.stdout.write(`prefix READY-${loader.slice(0, 2)}`);
    child.stdout.write(`${loader.slice(2)} suffix\r`);
    child.stdout.write('\nsecond line\n');
    const ready = await handle.waitForReady({ timeoutMs: 500 });
    assert.deepEqual(ready, { marker: `READY-${loader}`, pid: child.pid });
    assert.deepEqual(lines, [
      { line: `prefix READY-${loader} suffix`, operationId: `health-${loader}`, pid: child.pid, stream: 'stdout' },
      { line: 'second line', operationId: `health-${loader}`, pid: child.pid, stream: 'stdout' }
    ]);
    assert.equal(await handle.ownsEndpoint({ host: '127.0.0.1', port: 25565, timeoutMs: 500 }), true);

    const stopped = await handle.stopFully({ gracefulTimeoutMs: 100, killTimeoutMs: 100 });
    assert.deepEqual(stopped, {
      clean: true,
      closed: true,
      exitCode: 0,
      forced: false,
      signal: null
    });
    assert.equal(handle.isLive(), false);
    assert.deepEqual(child.stdin.writes, ['stop\n']);
  }
});

test('runner stop absorbs asynchronous stdin EPIPE before lifecycle adoption', async () => {
  const { child, runner } = runnerFixture({ pid: 4388 });
  const writes = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      const pipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      setImmediate(() => callback(pipeError));
    }
  });

  const handle = runner.launchServerProcess(launchRequest());
  const stopped = await handle.stopFully({ gracefulTimeoutMs: 20, killTimeoutMs: 20 });

  assert.deepEqual(writes, ['stop\n']);
  assert.deepEqual(stopped, {
    clean: false,
    closed: true,
    exitCode: null,
    forced: true,
    signal: 'SIGKILL'
  });
});

test('Forge registry confirmation is injected only for an explicitly transaction-protected launch', () => {
  const jobId = 'job-forge';
  const authorization = protectedCandidateAuthorization(jobId);
  const protectedForge = runnerFixture({ loader: 'forge', pid: 4391 });
  protectedForge.runner.launchServerProcess(launchRequest('forge', {
    forgeCandidateHealthAuthorization: authorization,
    operationId: candidateHealthOperationId(jobId)
  }));
  assert.deepEqual(protectedForge.spawnCalls[0].args, [
    `-Dminecraft.core.server.id=${candidateHealthOperationId(jobId)}`,
    '-Dminecraft.core.server.launch=b09956c1-1daa-4fb9-a8fe-bf6d401c04bc',
    '-Xmx4G',
    '-Dfml.queryResult=confirm',
    '-jar',
    'server-forge.jar',
    'nogui'
  ]);
  protectedForge.child.finish(0, null);

  const ordinaryForge = runnerFixture({ loader: 'forge', pid: 4392 });
  ordinaryForge.runner.launchServerProcess(launchRequest('forge'));
  assert.equal(ordinaryForge.spawnCalls[0].args.includes('-Dfml.queryResult=confirm'), false);
  ordinaryForge.child.finish(0, null);

  const fabric = runnerFixture({ loader: 'fabric', pid: 4393 });
  assert.throws(
    () => fabric.runner.launchServerProcess(launchRequest('fabric', {
      forgeCandidateHealthAuthorization: authorization,
      operationId: candidateHealthOperationId(jobId)
    })),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.equal(fabric.spawnCalls.length, 0);
});

test('protected modern Forge launch places confirmation after user JVM arguments and before the launch response file', () => {
  const jobId = 'job-forge-modern';
  const userJvmArgs = 'C:\\Minecraft\\Runner\\user_jvm_args.txt';
  const forgeArgs = 'C:\\Minecraft\\Runner\\libraries\\net\\minecraftforge\\forge\\1.20.1-47.4.18\\win_args.txt';
  const value = runnerFixture({
    loader: 'forge',
    pid: 4394,
    planOverrides: {
      args: [
        '@user_jvm_args.txt',
        '-Dfml.queryResult=cancel',
        '-Xmx4G',
        '-Xms1G',
        '@libraries\\net\\minecraftforge\\forge\\1.20.1-47.4.18\\win_args.txt',
        'nogui'
      ],
      assets: { userJvmArgs, forgeArgs, runScript: null }
    }
  });

  value.runner.launchServerProcess(launchRequest('forge', {
    forgeCandidateHealthAuthorization: protectedCandidateAuthorization(jobId),
    operationId: candidateHealthOperationId(jobId)
  }));

  const spawned = value.spawnCalls[0].args;
  assert.ok(spawned.indexOf('-Dfml.queryResult=confirm') > spawned.indexOf('@user_jvm_args.txt'));
  assert.ok(spawned.indexOf('-Dfml.queryResult=confirm') > spawned.indexOf('-Dfml.queryResult=cancel'));
  assert.ok(spawned.indexOf('-Dfml.queryResult=confirm') < spawned.indexOf(
    '@libraries\\net\\minecraftforge\\forge\\1.20.1-47.4.18\\win_args.txt'
  ));
  value.child.finish(0, null);
});

test('shared process runner rejects fatal output and premature child exit without leaking lines', async () => {
  const fatalFixture = runnerFixture({ loader: 'fabric', pid: 4401 });
  const fatalHandle = fatalFixture.runner.launchServerProcess(launchRequest('fabric'));
  fatalFixture.child.stderr.write('sensitive C:\\server FATAL-fabric signed-url?token=x\n');
  await assert.rejects(
    fatalHandle.waitForReady({ timeoutMs: 500 }),
    error => {
      assert.equal(error.code, 'HEALTH_CHECK_FAILED');
      assert.equal(error.message.includes('sensitive'), false);
      assert.equal(error.message.includes('token'), false);
      return true;
    }
  );
  fatalFixture.child.finish(1, null);

  const exitFixture = runnerFixture({ loader: 'quilt', pid: 4402 });
  const exitHandle = exitFixture.runner.launchServerProcess(launchRequest('quilt'));
  exitFixture.child.finish(1, null);
  await assert.rejects(exitHandle.waitForReady({ timeoutMs: 500 }), error => error.code === 'HEALTH_CHECK_FAILED');

  const errorFixture = runnerFixture({ loader: 'vanilla', pid: 4403 });
  const errorHandle = errorFixture.runner.launchServerProcess(launchRequest('vanilla'));
  errorFixture.child.emit('error', new Error('spawn stream failed'));
  assert.equal(errorHandle.isLive(), false);
  await assert.rejects(errorHandle.waitForReady({ timeoutMs: 500 }), error => error.code === 'HEALTH_CHECK_FAILED');
  errorFixture.child.finish(1, null);
});

test('shared process runner enforces ready deadlines, abort cleanup, listener ownership, and forced close', async () => {
  const wrongOwner = runnerFixture({
    loader: 'vanilla',
    listenerEndpoints: [{ host: '127.0.0.1', port: 25565, pid: 9999 }],
    pid: 4501
  });
  const wrongHandle = wrongOwner.runner.launchServerProcess(launchRequest('vanilla'));
  assert.equal(await wrongHandle.ownsEndpoint({ host: '127.0.0.1', port: 25565, timeoutMs: 100 }), false);

  await assert.rejects(
    wrongHandle.waitForReady({ timeoutMs: 20 }),
    error => error.code === 'HEALTH_CHECK_FAILED'
  );
  const abort = new AbortController();
  const waiting = wrongHandle.waitForReady({ timeoutMs: 500, signal: abort.signal });
  abort.abort();
  await assert.rejects(waiting, error => error.code === 'CANCELLED');

  const stopped = await wrongHandle.stopFully({ gracefulTimeoutMs: 10, killTimeoutMs: 100 });
  assert.equal(stopped.forced, true);
  assert.equal(stopped.closed, true);
  assert.equal(wrongOwner.child.killed, true);
  assert.equal(wrongOwner.child.stdout.listenerCount('data'), 0);
  assert.equal(wrongOwner.child.stderr.listenerCount('data'), 0);
  assert.equal(wrongOwner.child.listenerCount('error'), 0);
  assert.equal(wrongOwner.child.listenerCount('close'), 0);
});

test('netstat listener ownership accepts an explicitly allowed wildcard for a loopback probe', async () => {
  const output = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:25565        0.0.0.0:0              LISTENING       4321',
    '  TCP    0.0.0.0:25565          0.0.0.0:0              LISTENING       4321',
    '  TCP    [::]:25565             [::]:0                 LISTENING       8765',
    '  TCP    127.0.0.1:25566        0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:25565        127.0.0.1:50000        ESTABLISHED     1111',
    '  UDP    0.0.0.0:25565          *:*                                    2222'
  ].join('\r\n');
  assert.deepEqual(parseNetstatListeningEndpoints(output), [
    { host: '127.0.0.1', port: 25565, pid: 4321 },
    { host: '0.0.0.0', port: 25565, pid: 4321 },
    { host: '::', port: 25565, pid: 8765 },
    { host: '127.0.0.1', port: 25566, pid: 9999 }
  ]);
  assert.deepEqual(parseNetstatListeningPids(output, 25565), [4321, 8765]);
  assert.deepEqual(parseNetstatListeningPids(output, 25566), [9999]);
  assert.deepEqual(parseNetstatListeningPids('not netstat output', 25565), []);

  const exact = runnerFixture({
    pid: 4321,
    listenerEndpoints: parseNetstatListeningEndpoints(output)
  });
  const exactHandle = exact.runner.launchServerProcess(launchRequest());
  assert.equal(await exactHandle.ownsEndpoint({ host: '127.0.0.1', port: 25565, timeoutMs: 100 }), true);
  assert.equal(await exactHandle.ownsEndpoint({ host: '192.168.1.20', port: 25565, timeoutMs: 100 }), false);
  exact.child.finish(0, null);

  const wildcard = runnerFixture({
    pid: 8765,
    listenerEndpoints: parseNetstatListeningEndpoints(output)
  });
  const wildcardHandle = wildcard.runner.launchServerProcess(launchRequest());
  assert.equal(await wildcardHandle.ownsEndpoint({ host: '127.0.0.1', port: 25565, timeoutMs: 100 }), false);
  assert.equal(await wildcardHandle.ownsEndpoint({ host: '::1', port: 25565, timeoutMs: 100 }), false);
  assert.equal(await wildcardHandle.ownsEndpoint({
    allowWildcard: true,
    host: '127.0.0.1',
    port: 25565,
    timeoutMs: 100
  }), true);
  assert.equal(await wildcardHandle.ownsEndpoint({
    allowWildcard: true,
    host: '::1',
    port: 25565,
    timeoutMs: 100
  }), true);
  for (const host of ['0.0.0.0', '::']) {
    await assert.rejects(
      wildcardHandle.ownsEndpoint({ host, port: 25565, timeoutMs: 100 }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  wildcard.child.finish(0, null);
});

test('Windows netstat proves explicit wildcard ownership for the exact live PID and port', {
  skip: process.platform !== 'win32' ? 'Windows netstat ownership behavior' : false,
  timeout: 15_000
}, async t => {
  const listener = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '0.0.0.0', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');

  const children = [];
  t.after(async () => {
    for (const child of children) child.finish(0, null);
    if (listener.listening) {
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  });

  const makeHandle = pid => {
    const child = new FakeChild(pid);
    children.push(child);
    const runner = createServerProcessRunner({
      eventBus: new EventEmitter(),
      resolveLaunchPlan() {
        return {
          type: 'jar',
          loader: 'vanilla',
          jar: 'C:\\Minecraft\\server-vanilla.jar',
          args: ['-Xmx4G', '-jar', 'server-vanilla.jar', 'nogui'],
          cwd: 'C:\\Minecraft\\Runner',
          readyMarkers: ['READY-vanilla'],
          fatalMarkers: ['FATAL-vanilla'],
          runtime: makeRuntimeTuple('vanilla', '1.20.1')
        };
      },
      spawnProcess() {
        return child;
      },
      supervisionRequired() {
        return false;
      }
    });
    return runner.launchServerProcess(launchRequest());
  };

  const exactHandle = makeHandle(process.pid);
  assert.equal(await exactHandle.ownsEndpoint({
    allowWildcard: true,
    host: '127.0.0.1',
    port: address.port,
    timeoutMs: 5_000
  }), true);
  assert.equal(await exactHandle.ownsEndpoint({
    host: '127.0.0.1',
    port: address.port,
    timeoutMs: 5_000
  }), false);

  const wrongPidHandle = makeHandle(process.pid + 1);
  assert.equal(await wrongPidHandle.ownsEndpoint({
    allowWildcard: true,
    host: '127.0.0.1',
    port: address.port,
    timeoutMs: 5_000
  }), false);
});

test('listener ownership resolves a configured hostname before comparing the PID-owned socket', async () => {
  const value = runnerFixture({
    pid: 8770,
    listenerEndpoints: [{ host: '127.0.0.1', port: 25565, pid: 8770 }]
  });
  const handle = value.runner.launchServerProcess(launchRequest());

  assert.equal(await handle.ownsEndpoint({ host: 'localhost', port: 25565, timeoutMs: 500 }), true);
  value.child.finish(0, null);
});

test('hostname ownership reuses one in-flight DNS resolution across bounded probe timeouts', async () => {
  const child = new FakeChild(8771);
  let lookupCalls = 0;
  let finishLookup;
  const lookupGate = new Promise(resolve => { finishLookup = resolve; });
  const runner = createServerProcessRunner({
    eventBus: new EventEmitter(),
    getListeningEndpoints: async () => [{ host: '127.0.0.1', port: 25565, pid: 8771 }],
    lookupHost() {
      lookupCalls += 1;
      return lookupGate;
    },
    resolveLaunchPlan() {
      return {
        type: 'jar', loader: 'vanilla', jar: 'C:\\Minecraft\\server-vanilla.jar',
        args: ['-Xmx4G', '-jar', 'server-vanilla.jar', 'nogui'], cwd: 'C:\\Minecraft\\Runner',
        readyMarkers: ['READY-vanilla'], fatalMarkers: ['FATAL-vanilla'],
        runtime: makeRuntimeTuple('vanilla', '1.20.1')
      };
    },
    spawnProcess() { return child; },
    supervisionRequired() { return false; }
  });
  const handle = runner.launchServerProcess(launchRequest());

  assert.equal(await handle.ownsEndpoint({ host: 'pack-host.test', port: 25565, timeoutMs: 10 }), false);
  assert.equal(await handle.ownsEndpoint({ host: 'pack-host.test', port: 25565, timeoutMs: 10 }), false);
  assert.equal(lookupCalls, 1);
  finishLookup([{ address: '127.0.0.1', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await handle.ownsEndpoint({ host: 'pack-host.test', port: 25565, timeoutMs: 100 }), true);
  assert.equal(lookupCalls, 1);
  child.finish(0, null);
});

test('publishEvents false launches are internally owned immediately and exactly released on close', () => {
  const { child, eventBus, runner } = runnerFixture({ loader: 'fabric', pid: 4399 });
  const events = [];
  eventBus.on('server-process-owned', value => events.push(['owned', value]));
  eventBus.on('server-process-released', value => events.push(['released', value]));

  const handle = runner.launchServerProcess(launchRequest('fabric', { publishEvents: false }));

  assert.equal(handle.pid, 4399);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'owned');
  assert.equal(events[0][1].instanceId, 'runner-instance');
  assert.equal(events[0][1].operationId, 'health-fabric');
  assert.equal(events[0][1].pid, 4399);
  assert.equal(typeof events[0][1].acknowledge, 'function');
  assert.equal(typeof events[0][1].onSupervisionFailure, 'function');
  child.finish(0, null);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], [
    'released',
    { instanceId: 'runner-instance', operationId: 'health-fabric', pid: 4399 }
  ]);
});

test('required supervision failure returns the exact spawned child for fail-closed shutdown proof', async () => {
  const child = new FakeChild(4409);
  child.kill = () => {
    child.killed = true;
    return true;
  };
  const runner = createServerProcessRunner({
    eventBus: new EventEmitter(),
    getListeningEndpoints: async () => [],
    resolveLaunchPlan() {
      return {
        type: 'jar',
        loader: 'vanilla',
        jar: 'C:\\Minecraft\\server-vanilla.jar',
        args: ['-Xmx4G', '-jar', 'server-vanilla.jar', 'nogui'],
        cwd: 'C:\\Minecraft\\Runner',
        readyMarkers: ['READY-vanilla'],
        fatalMarkers: ['FATAL-vanilla'],
        runtime: makeRuntimeTuple('vanilla', '1.20.1')
      };
    },
    spawnProcess() {
      return child;
    },
    supervisionRequired() {
      return true;
    }
  });

  const handle = runner.launchServerProcess(launchRequest());
  await assert.rejects(handle.supervisionReady, error => error.code === 'HEALTH_CHECK_FAILED');
  const stopped = await handle.stopFully({ gracefulTimeoutMs: 10, killTimeoutMs: 10 });

  assert.equal(stopped.closed, false);
  assert.equal(handle.child, child);
});

test('process runner accepts only issued runtime evidence and never re-enters legacy launch resolution', () => {
  const child = new FakeChild(5454);
  const exactRuntime = makeRuntimeTuple('fabric', 'test-loader');
  const validation = Object.freeze({ valid: true, runtime: exactRuntime });
  const plan = {
    type: 'jar',
    loader: 'fabric',
    jar: 'C:\\Minecraft\\Runner\\fabric-server-launch.jar',
    args: ['-Xmx4G', '-jar', 'fabric-server-launch.jar', 'nogui'],
    cwd: 'C:\\Minecraft\\Runner',
    readyMarkers: ['READY-fabric'],
    fatalMarkers: ['FATAL-fabric'],
    runtime: exactRuntime
  };
  let legacyResolutions = 0;
  let prevalidatedResolutions = 0;
  let spawns = 0;
  const brandChecks = [];
  const runner = createServerProcessRunner({
    getListeningEndpoints: async () => [],
    isManagedRuntimeValidation(value, serverPath) {
      brandChecks.push({ value, serverPath });
      return value === validation && serverPath === 'C:\\Minecraft\\Runner';
    },
    resolveLaunchPlan() {
      legacyResolutions += 1;
      throw new Error('legacy resolution must not run');
    },
    resolvePrevalidatedLaunchPlan(serverPath, options, value) {
      prevalidatedResolutions += 1;
      assert.equal(serverPath, 'C:\\Minecraft\\Runner');
      assert.equal(options.loader, 'fabric');
      assert.equal(value, validation);
      return plan;
    },
    spawnProcess() {
      spawns += 1;
      return child;
    }
  });

  const handle = runner.launchServerProcess(launchRequest('fabric', { runtimeValidation: validation }));
  assert.equal(handle.launchPlan, plan);
  assert.equal(legacyResolutions, 0);
  assert.equal(prevalidatedResolutions, 1);
  assert.equal(spawns, 1);
  assert.deepEqual(brandChecks, [{ value: validation, serverPath: 'C:\\Minecraft\\Runner' }]);

  assert.throws(
    () => runner.launchServerProcess(launchRequest('fabric', { runtimeValidation: { ...validation } })),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.equal(spawns, 1);
  assert.deepEqual(brandChecks, [
    { value: validation, serverPath: 'C:\\Minecraft\\Runner' },
    { value: { ...validation }, serverPath: 'C:\\Minecraft\\Runner' }
  ]);
  child.finish(0, null);
});

test('process runner preserves destination path failures and never spawns Java', () => {
  const validation = Object.freeze({ valid: true });
  const expected = new ModpackError(
    'SERVER_PATH_TOO_LONG',
    'This server location is too deeply nested for the selected loader on Windows. Choose a shorter folder.',
    { details: { field: 'serverPath' }, retryable: true }
  );
  let spawns = 0;
  const runner = createServerProcessRunner({
    getListeningEndpoints: async () => [],
    isManagedRuntimeValidation(value) {
      return value === validation;
    },
    resolvePrevalidatedLaunchPlan() {
      throw expected;
    },
    spawnProcess() {
      spawns += 1;
      throw new Error('spawn must not run');
    }
  });

  assert.throws(
    () => runner.launchServerProcess(launchRequest('forge', { runtimeValidation: validation })),
    error => error === expected && error.code === 'SERVER_PATH_TOO_LONG' &&
      error.retryable === true && error.details?.field === 'serverPath'
  );
  assert.equal(spawns, 0);
});

test('shared process runner validates its closed request before spawn', () => {
  const { runner, spawnCalls } = runnerFixture();
  const invalid = [
    { serverPath: 'relative' },
    { instanceId: '' },
    { maxRam: 0 },
    { javaPath: 'java.exe' },
    { operationId: '../unsafe' },
    { publishEvents: 'false' },
    { onLine: true },
    { forgeCandidateHealthAuthorization: false },
    { forgeCandidateHealthAuthorization: {} },
    { runtime: { ...makeRuntimeTuple('vanilla', '1.20.1'), extra: true } },
    { extra: true }
  ];
  for (const change of invalid) {
    assert.throws(
      () => runner.launchServerProcess({ ...launchRequest(), ...change }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  assert.equal(spawnCalls.length, 0);
});

test('a v26.6.1 Forge server without runtime metadata starts through the real runner with v26.6.1 discovery', async t => {
  const serverPath = makeV26ForgeServer();
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const child = new FakeChild(4610);
  const spawnCalls = [];
  const runner = createServerProcessRunner({
    eventBus: new EventEmitter(),
    getListeningEndpoints: async () => [],
    randomUUID: () => 'b09956c1-1daa-4fb9-a8fe-bf6d401c04bc',
    spawnProcess(file, args, options) {
      spawnCalls.push({ file, args, options });
      return child;
    }
  });

  const handle = runner.launchServerProcess({
    serverPath,
    instanceId: 'legacy-forge-server',
    runtime: v26ForgeTuple(),
    javaPath: 'C:\\Java\\bin\\java.exe',
    maxRam: 4,
    operationId: 'legacy-forge-start',
    publishEvents: false,
    onLine() {}
  });

  assert.equal(spawnCalls.length, 1);
  const spawnArgs = spawnCalls[0].args;
  const firstLaunchArgument = spawnArgs.findIndex(arg => !arg.startsWith('-Dminecraft.core.server.'));
  assert.deepEqual(spawnArgs.slice(0, firstLaunchArgument), [
    '-Dminecraft.core.server.id=legacy-forge-start',
    '-Dminecraft.core.server.launch=b09956c1-1daa-4fb9-a8fe-bf6d401c04bc'
  ]);
  assert.deepEqual(spawnArgs.slice(firstLaunchArgument), v26ForgeLaunchArgs(4));
  assert.equal(spawnCalls[0].options.cwd, serverPath);
  assert.equal(handle.launchPlan.loader, 'forge');
  assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state')), false);
  child.finish(0, null);
  await handle.closed;
});

test('Forge launch uses recorded runtime metadata only when it exists and still fails closed when it is damaged', t => {
  const distractorArgs = '1.20.1-47.2.0/win_args.txt';
  const recorded = makeV26ForgeServer();
  t.after(() => fs.rmSync(recorded, { recursive: true, force: true }));
  const distractor = path.join(recorded, ...distractorArgs.split('/'));
  fs.mkdirSync(path.dirname(distractor), { recursive: true });
  fs.writeFileSync(distractor, '-jar wrong.jar\n');
  const discovered = resolveLaunchPlan(recorded, { loader: 'forge', maxRam: 4 });
  assert.equal(discovered.assets.forgeArgs, distractor, 'filesystem discovery would score the distractor first');
  assert.equal(publishForgeRuntimeMetadata(recorded, v26ForgeTuple()).valid, true);
  const plan = resolveLaunchPlan(recorded, { loader: 'forge', maxRam: 4 }, { runtimeTuple: v26ForgeTuple() });
  assert.deepEqual(plan.args, v26ForgeLaunchArgs(4));
  assert.equal(plan.assets.forgeArgs, path.join(recorded, ...V26_FORGE_ARGS.split('/')));
  assert.deepEqual(plan.runtime, v26ForgeTuple());
  assert.throws(
    () => resolveLaunchPlan(recorded, { loader: 'forge', maxRam: 4 }, { runtimeTuple: v26ForgeTuple('47.2.1') }),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );

  const corrupt = makeV26ForgeServer();
  t.after(() => fs.rmSync(corrupt, { recursive: true, force: true }));
  fs.mkdirSync(path.join(corrupt, '.minecraft-core-state'));
  fs.writeFileSync(path.join(corrupt, '.minecraft-core-state', 'runtime.json'), '{"formatVersion":1,"runtime":');
  const directoryShaped = makeV26ForgeServer();
  t.after(() => fs.rmSync(directoryShaped, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directoryShaped, '.minecraft-core-state', 'runtime.json'), { recursive: true });
  for (const serverPath of [corrupt, directoryShaped]) {
    assert.throws(
      () => resolveLaunchPlan(serverPath, { loader: 'forge', maxRam: 4 }, { runtimeTuple: v26ForgeTuple() }),
      error => error.code === 'RUNTIME_INCOMPLETE',
      serverPath
    );
  }
});

test('v26.6.1 NeoForge and Quilt servers without runtime metadata launch the plain jar v26.6.1 launched', t => {
  for (const loader of ['neoforge', 'quilt']) {
    const serverPath = makeV26PlainLoaderServer(t, loader);
    const serverJar = path.join(serverPath, 'server.jar');
    const v26 = v26_6_1LaunchDecision(serverPath);
    assert.equal(v26.jar, serverJar, loader);

    for (const runtimeTuple of [null, v26PlainLoaderTuple(loader)]) {
      const plan = resolveLaunchPlan(serverPath, { loader, maxRam: 4 }, { runtimeTuple });
      assert.equal(plan.type, 'jar', loader);
      assert.equal(plan.loader, loader);
      assert.equal(plan.jar, serverJar);
      assert.deepEqual(plan.args, plainJarLaunchArgs(serverJar));
      // The jar and arguments v26.6.1 used; -Xms1G is what every plain-jar launch adds today.
      assert.deepEqual(plan.args.filter(arg => arg !== '-Xms1G'), v26.args);
      assert.equal(plan.cwd, serverPath);
      assert.deepEqual(plan.runtime, runtimeTuple);
      assert.ok(plan.readyMarkers.some(marker => marker.includes('Done (')));
    }
    // The loader named only by the server config, as v26.6.1 resolved it.
    assert.equal(resolveLaunchPlan(serverPath, { maxRam: 4 }).jar, serverJar, loader);
    assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state')), false, loader);
  }
});

test('a v26.6.1 NeoForge or Quilt server starts through the real runner with its unmanaged tuple', async t => {
  for (const loader of ['neoforge', 'quilt']) {
    const serverPath = makeV26PlainLoaderServer(t, loader);
    const serverJar = path.join(serverPath, 'server.jar');
    const serverJarBytes = fs.readFileSync(serverJar);
    const child = new FakeChild(4620);
    const spawnCalls = [];
    const runner = createServerProcessRunner({
      eventBus: new EventEmitter(),
      getListeningEndpoints: async () => [],
      randomUUID: () => 'b09956c1-1daa-4fb9-a8fe-bf6d401c04bc',
      spawnProcess(file, args, options) {
        spawnCalls.push({ file, args, options });
        return child;
      }
    });

    // The request server-manager sends for a server that is not modpack managed.
    const handle = runner.launchServerProcess({
      serverPath,
      instanceId: `legacy-${loader}-server`,
      runtime: v26PlainLoaderTuple(loader),
      javaPath: 'C:\\Java\\bin\\java.exe',
      maxRam: 4,
      operationId: `legacy-${loader}-start`,
      publishEvents: false,
      onLine() {},
      supervision: 'best-effort',
      runtimeContract: 'legacy'
    });

    assert.equal(spawnCalls.length, 1, loader);
    assert.deepEqual(spawnCalls[0].args, [
      `-Dminecraft.core.server.id=legacy-${loader}-start`,
      '-Dminecraft.core.server.launch=b09956c1-1daa-4fb9-a8fe-bf6d401c04bc',
      ...plainJarLaunchArgs(serverJar)
    ], loader);
    assert.equal(spawnCalls[0].options.cwd, serverPath);
    assert.equal(handle.launchPlan.loader, loader);
    child.finish(0, null);
    await handle.closed;
    assert.deepEqual(fs.readFileSync(serverJar), serverJarBytes, loader);
    assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state')), false, loader);
  }
});

test('without server.jar the v26.6.1 rule runs the Quilt launcher and finds no NeoForge server jar', t => {
  const quilt = makeV26PlainLoaderServer(t, 'quilt', { serverJar: false });
  const launcher = path.join(quilt, 'quilt-server-launch.jar');
  assert.equal(v26_6_1LaunchDecision(quilt).jar, launcher);
  for (const runtimeTuple of [null, v26PlainLoaderTuple('quilt')]) {
    const plan = resolveLaunchPlan(quilt, { loader: 'quilt', maxRam: 4 }, { runtimeTuple });
    assert.equal(plan.type, 'jar');
    assert.equal(plan.loader, 'quilt');
    assert.equal(plan.jar, launcher);
    assert.deepEqual(plan.args, plainJarLaunchArgs(launcher));
  }

  // Only the NeoForge installer jar is left at the root, as the official installer leaves it.
  const neoForge = makeV26PlainLoaderServer(t, 'neoforge', { serverJar: false });
  const serverJarMissing = error => error.code === 'SERVER_JAR_MISSING' &&
    error.message === 'No valid server jar was found in the selected server folder.';
  assert.throws(() => v26_6_1LaunchDecision(neoForge), serverJarMissing);
  for (const runtimeTuple of [null, v26PlainLoaderTuple('neoforge')]) {
    assert.throws(
      () => resolveLaunchPlan(neoForge, { loader: 'neoforge', maxRam: 4 }, { runtimeTuple }),
      serverJarMissing
    );
  }
});

test('a NeoForge guard jar that lost its runtime record and every present runtime record keep the strict launch', t => {
  // A current NeoForge layout whose .minecraft-core-state was lost: its root jar is the guard.
  const lostRecord = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-lost-record-'));
  t.after(() => fs.rmSync(lostRecord, { recursive: true, force: true }));
  const { runtime } = writeRecordedNeoForgeRuntime(lostRecord);
  fs.rmSync(path.join(lostRecord, '.minecraft-core-state'), { recursive: true });
  for (const runtimeTuple of [null, runtime]) {
    assert.throws(
      () => resolveLaunchPlan(lostRecord, { loader: 'neoforge', maxRam: 4 }, { runtimeTuple }),
      error => error.code === 'RUNTIME_INCOMPLETE'
    );
  }

  for (const loader of ['neoforge', 'quilt']) {
    const corrupt = makeV26PlainLoaderServer(t, loader);
    fs.mkdirSync(path.join(corrupt, '.minecraft-core-state'));
    fs.writeFileSync(path.join(corrupt, '.minecraft-core-state', 'runtime.json'), '{"formatVersion":1,"runtime":');
    const directoryShaped = makeV26PlainLoaderServer(t, loader);
    fs.mkdirSync(path.join(directoryShaped, '.minecraft-core-state', 'runtime.json'), { recursive: true });
    for (const serverPath of [corrupt, directoryShaped]) {
      for (const runtimeTuple of [null, v26PlainLoaderTuple(loader)]) {
        assert.throws(
          () => resolveLaunchPlan(serverPath, { loader, maxRam: 4 }, { runtimeTuple }),
          error => error.code === 'RUNTIME_INCOMPLETE',
          `${loader} ${serverPath}`
        );
      }
    }
  }
});

test('recorded NeoForge and Quilt runtimes keep their recorded launch beside a root server.jar', t => {
  // A pre-release NeoForge layout: the record, not the root jar, selects the recorded launch.
  const neoForge = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-recorded-'));
  t.after(() => fs.rmSync(neoForge, { recursive: true, force: true }));
  const neoForgeRecord = writeRecordedNeoForgeRuntime(neoForge, { rootServerJar: 'vanilla' });
  const neoForgePlan = resolveLaunchPlan(neoForge, { loader: 'neoforge', maxRam: 6 }, { runtimeTuple: neoForgeRecord.runtime });
  assert.equal(neoForgePlan.type, 'neoforge');
  assert.equal(neoForgePlan.loader, 'neoforge');
  assert.equal(neoForgePlan.jar, null);
  assert.deepEqual(neoForgePlan.args, [
    '@user_jvm_args.txt',
    '-Xmx6G',
    '-Xms1G',
    `@${path.join(...neoForgeRecord.argsFile.split('/'))}`,
    'nogui'
  ]);
  assert.deepEqual(neoForgePlan.runtime, neoForgeRecord.runtime);

  const quilt = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-recorded-'));
  t.after(() => fs.rmSync(quilt, { recursive: true, force: true }));
  const quiltRecord = writeRecordedQuiltRuntime(quilt);
  const quiltPlan = resolveLaunchPlan(quilt, { loader: 'quilt', maxRam: 5 }, { runtimeTuple: quiltRecord.runtime });
  const launcher = path.join(quilt, 'quilt-server-launch.jar');
  assert.equal(quiltPlan.type, 'jar');
  assert.equal(quiltPlan.loader, 'quilt');
  assert.equal(quiltPlan.jar, launcher);
  assert.deepEqual(quiltPlan.args, ['-Xmx5G', '-Xms1G', '-jar', launcher, 'nogui']);
  assert.deepEqual(quiltPlan.runtime, quiltRecord.runtime);

  // A recorded runtime that does not match the request still fails closed.
  assert.throws(
    () => resolveLaunchPlan(quilt, { loader: 'quilt', maxRam: 5 }, {
      runtimeTuple: makeRuntimeTuple('quilt', '0.26.5', '1.20.1', 17)
    }),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
});

test('isNeoForgeDowngradeGuardJar accepts only the exact regular guard file, reads at most 64 KiB and writes nothing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-guard-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const guardBytes = neoForgeDowngradeGuardJarBytes();
  const guard = path.join(root, 'server.jar');
  fs.writeFileSync(guard, guardBytes);
  const changedBytes = Buffer.from(guardBytes);
  changedBytes[changedBytes.length - 1] ^= 0xff;
  fs.writeFileSync(path.join(root, 'same-size.jar'), changedBytes);
  fs.writeFileSync(path.join(root, 'longer.jar'), Buffer.concat([guardBytes, Buffer.from('x')]));
  fs.writeFileSync(path.join(root, 'large.jar'), Buffer.concat([guardBytes, Buffer.alloc(256 * 1024)]));
  writeMinimalJar(path.join(root, 'vanilla.jar'));
  fs.mkdirSync(path.join(root, 'directory.jar'));
  let link = path.join(root, 'link.jar');
  try {
    fs.symlinkSync(guard, link, 'file');
  } catch {
    // Creating a symbolic link needs Developer Mode or elevation on Windows.
    link = null;
  }
  const entriesBefore = fs.readdirSync(root).sort();
  const guardBefore = fs.statSync(guard, { bigint: true });
  const opens = t.mock.method(fs, 'openSync');
  const reads = t.mock.method(fs, 'readSync');

  assert.equal(isNeoForgeDowngradeGuardJar(guard), true);
  for (const name of ['same-size.jar', 'longer.jar', 'large.jar', 'vanilla.jar', 'directory.jar', 'missing.jar']) {
    assert.equal(isNeoForgeDowngradeGuardJar(path.join(root, name)), false, name);
  }
  if (link) assert.equal(isNeoForgeDowngradeGuardJar(link), false, 'symbolic link');

  const writeFlags = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT |
    fs.constants.O_TRUNC | fs.constants.O_APPEND;
  for (const call of opens.mock.calls) {
    const flags = call.arguments[1];
    assert.ok(typeof flags === 'number' ? (flags & writeFlags) === 0 : flags === 'r', String(flags));
  }
  // Only same-sized candidates are opened, and never more than the guard's own length is read.
  const requestedBytes = reads.mock.calls.reduce((total, call) => total + call.arguments[3], 0);
  assert.ok(reads.mock.calls.length > 0);
  assert.ok(requestedBytes <= 64 * 1024, String(requestedBytes));
  assert.ok(reads.mock.calls.every(call => call.arguments[3] <= guardBytes.length));
  opens.mock.restore();
  reads.mock.restore();
  assert.deepEqual(fs.readdirSync(root).sort(), entriesBefore);
  assert.equal(fs.statSync(guard, { bigint: true }).mtimeNs, guardBefore.mtimeNs);
  assert.deepEqual(fs.readFileSync(guard), guardBytes);
});

test('an unchanged server.properties write is skipped and leaves the start lease clean', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-properties-unchanged-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const propertiesPath = path.join(root, 'server.properties');
  fs.writeFileSync(propertiesPath, minecraftShapedProperties(25565), 'utf8');
  const before = fs.statSync(propertiesPath, { bigint: true });
  const leases = startLeaseFixture(root, 'unchanged-properties-start');
  const lease = await leases.acquire();

  let written;
  await runWithServerMutationLease(lease, async () => {
    written = writeServerProperties(root, { 'server-port': '25565' });
    syncServerPort(root, 25565);
  });
  lease.markRunning({ pid: 56 });
  lease.release();

  assert.equal(leases.revision(), 9);
  assert.deepEqual(leases.bumps, []);
  assert.equal(fs.readFileSync(propertiesPath, 'utf8'), minecraftShapedProperties(25565));
  assert.equal(fs.statSync(propertiesPath, { bigint: true }).mtimeNs, before.mtimeNs);
  assert.equal(written, false);
});

test('a changed server port is replaced in place and bumps the start revision once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-properties-changed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const propertiesPath = path.join(root, 'server.properties');
  fs.writeFileSync(propertiesPath, minecraftShapedProperties(25565), 'utf8');
  const leases = startLeaseFixture(root, 'changed-properties-start');
  const lease = await leases.acquire();

  let written;
  await runWithServerMutationLease(lease, async () => {
    written = writeServerProperties(root, { 'server-port': '25570' });
  });
  lease.markRunning({ pid: 57 });
  lease.release();

  assert.equal(written, true);
  assert.equal(fs.readFileSync(propertiesPath, 'utf8'), minecraftShapedProperties(25570));
  assert.equal(leases.revision(), 10);
  assert.equal(leases.bumps.length, 1);
  assert.equal(leases.bumps[0].operationId, 'changed-properties-start');
});
