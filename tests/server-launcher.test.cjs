const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const AdmZip = require('adm-zip');

const { resolveLaunchPlan } = require('../electron/services/server-launcher.cjs');
const { resolveServerLoader } = require('../electron/utils/server-loader.cjs');
const {
  createServerProcessRunner,
  parseNetstatListeningEndpoints,
  parseNetstatListeningPids
} = require('../electron/services/server-process-runner.cjs');

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

function runnerFixture({ loader = 'vanilla', listenerEndpoints, pid = 4200 } = {}) {
  const child = new FakeChild(pid);
  const spawnCalls = [];
  const plan = {
    type: loader === 'forge' ? 'forge' : 'jar',
    loader,
    jar: loader === 'forge' ? null : `C:\\Minecraft\\server-${loader}.jar`,
    args: [`-Xmx4G`, '-jar', `server-${loader}.jar`, 'nogui'],
    cwd: 'C:\\Minecraft\\Runner',
    readyMarkers: [`READY-${loader}`],
    fatalMarkers: [`FATAL-${loader}`],
    runtime: makeRuntimeTuple(loader, loader === 'vanilla' ? '1.20.1' : 'test-loader')
  };
  const runner = createServerProcessRunner({
    getListeningEndpoints: async () => listenerEndpoints || [{ host: '127.0.0.1', port: 25565, pid }],
    resolveLaunchPlan() {
      return plan;
    },
    spawnProcess(file, args, options) {
      spawnCalls.push({ file, args, options });
      return child;
    }
  });
  return { child, plan, runner, spawnCalls };
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
      args: [`-Dminecraft.core.server.id=health-${loader}`, ...plan.args],
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

test('netstat listener parsing preserves local addresses so wildcard listeners cannot prove loopback ownership', async () => {
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
  for (const host of ['0.0.0.0', '::']) {
    await assert.rejects(
      wildcardHandle.ownsEndpoint({ host, port: 25565, timeoutMs: 100 }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  await assert.rejects(
    wildcardHandle.ownsEndpoint({
      allowWildcard: true,
      host: '::1',
      port: 25565,
      timeoutMs: 100
    }),
    error => error.code === 'INVALID_REQUEST'
  );
  wildcard.child.finish(0, null);
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
