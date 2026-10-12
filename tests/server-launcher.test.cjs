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

const { resolveLaunchPlan } = require('../electron/services/server-launcher.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
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
