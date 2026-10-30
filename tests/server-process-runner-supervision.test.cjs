'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { ACK_TIMEOUT_MS, createAppWatchdogSupervisor } = require('../electron/watchdog/app-watchdog-supervisor.cjs');
const { createServerProcessRunner } = require('../electron/services/server-process-runner.cjs');

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CIM_MODULE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\CimCmdlets\\CimCmdlets.psd1';
const DEGRADED_EVENT = 'server-process-supervision-degraded';
const SERVER_PATH = path.resolve('/minecraft-core-fixture/servers/one');
const CLIENT_PATH = path.resolve('/minecraft-core-fixture/clients/one');
const JAVA_PATH = path.resolve('/minecraft-core-fixture/java/bin/java.exe');
const OWNERSHIP = Object.freeze({ instanceId: 'server-one', operationId: 'server-operation-1', pid: 9101 });
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakePipe extends PassThrough {
  unref() {}
}

class FakeWatchdog extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdin = new FakePipe();
    this.stdout = new FakePipe();
    this.killCalls = [];
  }

  kill(signal) { this.killCalls.push(signal); return true; }
  unref() {}
}

class FakeJava extends EventEmitter {
  constructor(pid = OWNERSHIP.pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = { write() { return true; } };
    this.killCalls = [];
  }

  kill(signal) { this.killed = true; this.killCalls.push(signal); return true; }

  close(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

function runtime(overrides = {}) {
  return {
    minecraftVersion: '1.20.1',
    loaderFamily: 'vanilla',
    loaderVersion: '1.20.1',
    javaMajor: 17,
    os: 'win32',
    architecture: 'x64',
    ...overrides
  };
}

function harness({ powerShell = true, supervisor = true, spawnError = null, supervisionRequired = true, evidence = false } = {}) {
  const eventBus = new EventEmitter();
  const watchers = [];
  const timers = new Set();
  const degraded = [];
  const plans = [];
  const rows = [];
  let nonce = 0;
  eventBus.on(DEGRADED_EVENT, event => degraded.push(event));
  if (supervisor) {
    createAppWatchdogSupervisor({
      cryptoApi: { randomBytes() { nonce += 1; return Buffer.alloc(32, nonce); } },
      env: powerShell ? { SystemRoot: 'C:\\Windows' } : {},
      eventBus,
      fsApi: {
        lstatSync(value) {
          assert.ok([POWERSHELL, CIM_MODULE].includes(value));
          return { isFile: () => true, isSymbolicLink: () => false };
        },
        realpathSync: { native(value) { return value; } }
      },
      spawnImpl(file, args, options) {
        if (spawnError) throw spawnError;
        const child = new FakeWatchdog(7001 + watchers.length);
        watchers.push({ args, child, file, options });
        return child;
      },
      timers: {
        clearTimeout(timer) { timers.delete(timer); },
        setTimeout(callback, delay) {
          assert.equal(delay, ACK_TIMEOUT_MS);
          const timer = { callback, delay, unref() {} };
          timers.add(timer);
          return timer;
        }
      },
      warn() {}
    }).start();
  }
  const child = new FakeJava();
  let launchCount = 0;
  const dependencies = {
    eventBus,
    getListeningEndpoints: async () => [],
    resolveLaunchPlan(serverPath, options, extra) {
      plans.push({ extra, options, serverPath });
      return {
        type: 'jar',
        loader: options.loader,
        jar: path.join(SERVER_PATH, 'server.jar'),
        args: ['-Xmx4G', '-jar', 'server.jar', 'nogui'],
        cwd: SERVER_PATH,
        readyMarkers: ['Done ('],
        fatalMarkers: ['FATAL-MARKER'],
        runtime: extra.runtimeTuple
      };
    },
    spawnProcess(file, args) {
      launchCount += 1;
      rows.push({ pid: child.pid, parentPid: process.pid, name: 'java.exe', creationTime: `server-start-${launchCount}`,
        executablePath: file, commandLine: `"${file}" ${args.join(' ')}` });
      return child;
    },
    supervisionRequired: () => supervisionRequired
  };
  if (evidence) {
    Object.assign(dependencies, {
      randomUUID: () => `b09956c1-1daa-4fb9-a8fe-${String(launchCount + 1).padStart(12, '0')}`,
      captureLaunchRoot: value => Object.freeze({ canonicalPath: value, identity: 'fixture-server-object' }),
      inspectProcesses: async () => ({ complete: true, processes: [rows.at(-1)] })
    });
  }
  const runner = createServerProcessRunner(dependencies);
  const request = overrides => ({
    instanceId: OWNERSHIP.instanceId,
    javaPath: JAVA_PATH,
    maxRam: 4,
    onLine() {},
    operationId: OWNERSHIP.operationId,
    publishEvents: true,
    runtime: runtime(),
    serverPath: SERVER_PATH,
    supervision: 'best-effort',
    ...overrides
  });
  return {
    child,
    degraded,
    eventBus,
    plans,
    request,
    runner,
    timers,
    watchers,
    ack(index = 0) {
      const env = watchers[index].options.env;
      watchers[index].child.stdout.write(
        `MCWD1|${env.MC_CORE_WATCHDOG_NONCE}|${env.MC_CORE_WATCHDOG_INSTANCE}|${env.MC_CORE_WATCHDOG_PID}|${env.MC_CORE_WATCHDOG_OPERATION}\n`
      );
    },
    fireDeadline() {
      for (const timer of [...timers]) {
        timers.delete(timer);
        timer.callback();
      }
    },
    launch(overrides = {}) {
      return runner.launchServerProcess(request(overrides));
    },
    proof() {
      return runner.isCurrentUnrelatedServer({ process: rows.at(-1), clientPath: CLIENT_PATH });
    }
  };
}

async function withProcessKillSpy(work) {
  const calls = [];
  const original = process.kill;
  process.kill = (...args) => { calls.push(args); return true; };
  try {
    await work();
  } finally {
    process.kill = original;
  }
  return calls;
}

function degradedEvent(state, reason) {
  return { ...OWNERSHIP, state, reason };
}

test('best-effort ACK deadline reports unsupervised once, keeps the watcher alive and never kills Java', async () => {
  const processKills = await withProcessKillSpy(async () => {
    const h = harness();
    const handle = h.launch();
    assert.equal(handle.supervision.state(), 'pending');
    assert.equal(h.watchers.length, 1);
    h.fireDeadline();
    await tick();

    assert.equal(handle.supervision.state(), 'unsupervised');
    assert.equal(await handle.supervision.settled, 'unsupervised');
    assert.deepEqual(await handle.supervisionReady, OWNERSHIP);
    assert.equal(handle.isLive(), true);
    assert.deepEqual(h.child.killCalls, []);
    assert.deepEqual(h.watchers[0].child.killCalls, [], 'the deadline only reports; the watcher stays alive');
    assert.deepEqual(h.degraded, [degradedEvent('unsupervised', 'Watchdog ACK deadline exceeded')]);
  });
  assert.deepEqual(processKills, []);
});

for (const variant of ['powershell-unavailable', 'watchdog-spawn-failure', 'no-supervisor']) {
  test(`best-effort ${variant} leaves Java running unsupervised with one degraded event`, async () => {
    const processKills = await withProcessKillSpy(async () => {
      const h = harness({
        powerShell: variant !== 'powershell-unavailable',
        spawnError: variant === 'watchdog-spawn-failure' ? new Error('blocked by policy') : null,
        supervisor: variant !== 'no-supervisor'
      });
      const handle = h.launch();
      await tick();

      assert.equal(h.watchers.length, 0);
      assert.equal(handle.supervision.state(), 'unsupervised');
      assert.equal(await handle.supervision.settled, 'unsupervised');
      assert.deepEqual(await handle.supervisionReady, OWNERSHIP);
      assert.equal(handle.isLive(), true);
      assert.deepEqual(h.child.killCalls, []);
      assert.deepEqual(h.degraded, [degradedEvent('unsupervised', 'Server process supervision was not acknowledged')]);
    });
    assert.deepEqual(processKills, []);
  });
}

test('best-effort watcher exit after ACK reports lost once and never kills Java', async () => {
  const processKills = await withProcessKillSpy(async () => {
    const h = harness();
    const handle = h.launch();
    h.ack();
    assert.equal(await handle.supervision.settled, 'armed');
    assert.equal(handle.supervision.state(), 'armed');
    assert.deepEqual(h.degraded, [], 'a normal arm is not a degraded transition');

    h.watchers[0].child.emit('exit', 1, null);
    await tick();
    assert.equal(handle.supervision.state(), 'lost');
    assert.equal(handle.isLive(), true);
    assert.deepEqual(h.child.killCalls, []);
    assert.deepEqual(h.degraded, [degradedEvent('lost', 'watchdog exited unexpectedly (1/null)')]);

    h.watchers[0].child.emit('error', new Error('late watcher error'));
    await tick();
    assert.equal(h.degraded.length, 1, 'a later fault on a lost watcher is not reported twice');
  });
  assert.deepEqual(processKills, []);
});

test('best-effort malformed ACK degrades instead of killing Java', async () => {
  const h = harness();
  const handle = h.launch();
  h.watchers[0].child.stdout.write('not-an-ack\n');
  await tick();
  assert.equal(handle.supervision.state(), 'unsupervised');
  assert.equal(await handle.supervision.settled, 'unsupervised');
  assert.equal(handle.isLive(), true);
  assert.deepEqual(h.child.killCalls, []);
  assert.deepEqual(h.watchers[0].child.killCalls, [undefined], 'a misbehaving watcher is stopped');
  assert.deepEqual(h.degraded, [degradedEvent('unsupervised', 'Watchdog ACK was malformed or duplicated')]);
});

test('a late ACK after the deadline upgrades to armed and keeps app-death protection', async () => {
  const h = harness({ evidence: true });
  const handle = h.launch();
  await tick();
  h.fireDeadline();
  await tick();
  assert.equal(handle.supervision.state(), 'unsupervised');
  assert.equal(await h.proof(), false);

  h.ack();
  await tick();
  assert.equal(handle.supervision.state(), 'armed');
  assert.equal(await handle.supervision.settled, 'unsupervised', 'settled reports the first outcome only');
  assert.equal(await h.proof(), true, 'an armed late watcher restores the strict client exemption');
  assert.deepEqual(h.degraded, [
    degradedEvent('unsupervised', 'Watchdog ACK deadline exceeded'),
    degradedEvent('armed', 'Watchdog acknowledged after the deadline')
  ]);
  assert.deepEqual(h.watchers[0].child.killCalls, []);
  assert.equal(h.watchers[0].child.stdin.destroyed, false, 'the watcher still holds its app-lifetime pipe');

  h.eventBus.emit('server-process-released', OWNERSHIP);
  assert.deepEqual(h.watchers[0].child.killCalls, [undefined], 'the supervisor still tracks the armed watcher');
  assert.deepEqual(h.child.killCalls, []);
});

test('best-effort readiness resolves at the ready marker before any ACK', async () => {
  const h = harness();
  const handle = h.launch();
  const ready = handle.waitForReady({ timeoutMs: 1000 });
  h.child.stdout.write('[12:00:00] [Server thread/INFO]: Done (1.234s)! For help, type "help"\n');
  assert.deepEqual(await ready, { marker: 'Done (', pid: OWNERSHIP.pid });
  assert.equal(handle.supervision.state(), 'pending');
  assert.deepEqual(await handle.waitForReady({ timeoutMs: 1000 }), { marker: 'Done (', pid: OWNERSHIP.pid });
});

test('required mode keeps waiting for the ACK and settles armed', async () => {
  const h = harness();
  const handle = h.launch({ supervision: 'required' });
  const ready = handle.waitForReady({ timeoutMs: 1000 });
  let settled = false;
  ready.finally(() => { settled = true; });
  h.child.stdout.write('Done (1s)\n');
  await tick();
  assert.equal(settled, false);
  h.ack();
  assert.deepEqual(await ready, { marker: 'Done (', pid: OWNERSHIP.pid });
  assert.equal(await handle.supervision.settled, 'armed');
  assert.deepEqual(h.degraded, []);
});

test('relaxSupervision on a required handle stops later watchdog kills', async () => {
  const control = harness();
  const strict = control.launch({ supervision: 'required' });
  control.ack();
  await strict.supervisionReady;
  control.watchers[0].child.emit('exit', 1, null);
  assert.deepEqual(control.child.killCalls, ['SIGKILL'], 'control: required mode still kills');
  assert.deepEqual(control.degraded, []);

  const processKills = await withProcessKillSpy(async () => {
    const h = harness();
    const handle = h.launch({ supervision: 'required' });
    h.ack();
    await handle.supervisionReady;
    assert.equal(handle.relaxSupervision(), true);
    assert.equal(handle.relaxSupervision(), false, 'relaxing twice is a no-op');
    h.watchers[0].child.emit('exit', 1, null);
    await tick();
    assert.deepEqual(h.child.killCalls, []);
    assert.equal(handle.isLive(), true);
    assert.equal(handle.supervision.state(), 'lost');
    assert.deepEqual(h.degraded, [degradedEvent('lost', 'watchdog exited unexpectedly (1/null)')]);
  });
  assert.deepEqual(processKills, []);
});

test('relaxSupervision before arm turns a required deadline failure into a degraded state', async () => {
  const h = harness();
  const handle = h.launch({ supervision: 'required' });
  const ready = handle.waitForReady({ timeoutMs: 1000 });
  h.child.stdout.write('Done (1s)\n');
  handle.relaxSupervision();
  assert.deepEqual(await ready, { marker: 'Done (', pid: OWNERSHIP.pid }, 'relaxed readiness no longer waits for the ACK');
  h.fireDeadline();
  await tick();
  assert.deepEqual(h.child.killCalls, []);
  assert.equal(handle.isLive(), true);
  assert.equal(handle.supervision.state(), 'unsupervised');
  assert.deepEqual(await handle.supervisionReady, OWNERSHIP);
  assert.deepEqual(h.degraded, [degradedEvent('unsupervised', 'Watchdog ACK deadline exceeded')]);
});

test('a best-effort process that closes before arming settles unsupervised without a degraded event', async () => {
  const h = harness();
  const handle = h.launch();
  h.child.close(0, null);
  await tick();
  assert.equal(await handle.supervision.settled, 'unsupervised');
  assert.equal(handle.supervision.state(), 'unsupervised');
  assert.deepEqual(h.degraded, []);
  assert.deepEqual(h.watchers[0].child.killCalls, [undefined], 'the released watcher is stopped as expected');
});

test('isCurrentUnrelatedServer grants the strict client exemption only while armed', async () => {
  const armed = harness({ evidence: true });
  const armedHandle = armed.launch();
  armed.ack();
  await tick();
  assert.equal(armedHandle.supervision.state(), 'armed');
  assert.equal(await armed.proof(), true);

  const unsupervised = harness({ evidence: true, powerShell: false });
  const unsupervisedHandle = unsupervised.launch();
  await tick();
  assert.equal(unsupervisedHandle.supervision.state(), 'unsupervised');
  assert.equal(unsupervisedHandle.isLive(), true);
  assert.equal(await unsupervised.proof(), false);

  const lost = harness({ evidence: true });
  const lostHandle = lost.launch();
  lost.ack();
  await tick();
  assert.equal(await lost.proof(), true);
  lost.watchers[0].child.emit('exit', 1, null);
  await tick();
  assert.equal(lostHandle.supervision.state(), 'lost');
  assert.equal(lostHandle.isLive(), true);
  assert.equal(await lost.proof(), false);
});

test('an unacknowledged required launch without an installed supervisor is never exempt', async () => {
  const h = harness({ evidence: true, supervisor: false, supervisionRequired: false });
  const handle = h.launch({ supervision: 'required' });
  await tick();
  assert.deepEqual(await handle.supervisionReady, OWNERSHIP, 'readiness keeps its required-mode semantics');
  assert.equal(handle.supervision.state(), 'unsupervised');
  assert.equal(await handle.supervision.settled, 'unsupervised');
  assert.equal(await h.proof(), false);
  assert.deepEqual(h.degraded, [], 'required mode does not publish degraded events');
});

test('unknown supervision modes and runtime contracts are invalid requests', () => {
  for (const change of [
    { supervision: 'optional' },
    { supervision: null },
    { supervision: true },
    { runtimeContract: 'v26' },
    { runtimeContract: null }
  ]) {
    const h = harness({ supervisor: false });
    assert.throws(() => h.launch(change), error => error.code === 'INVALID_REQUEST', JSON.stringify(change));
    assert.equal(h.plans.length, 0);
  }
});

test('the legacy runtime contract accepts v26.6.1 version labels the managed contract rejects', async () => {
  for (const minecraftVersion of ['24w14a', '1.14 Pre-Release 5', 'b1.7.3', '1.20.1', 'x'.repeat(64)]) {
    const h = harness({ supervisor: false });
    const legacyRuntime = runtime({ minecraftVersion, loaderVersion: minecraftVersion });
    const handle = h.launch({ runtimeContract: 'legacy', runtime: legacyRuntime });
    assert.equal(h.plans.length, 1, minecraftVersion);
    assert.equal(h.plans[0].options.minecraftVersion, minecraftVersion);
    assert.deepEqual(h.plans[0].extra.runtimeTuple, legacyRuntime);
    assert.equal(Object.isFrozen(h.plans[0].extra.runtimeTuple), true);
    assert.equal(handle.isLive(), true);
    h.child.close(0, null);

    if (minecraftVersion !== '1.20.1') {
      const managed = harness({ supervisor: false });
      assert.throws(() => managed.launch({ runtime: legacyRuntime }), error => error.code === 'INVALID_REQUEST', minecraftVersion);
      assert.throws(() => managed.launch({ runtimeContract: 'managed', runtime: legacyRuntime }),
        error => error.code === 'INVALID_REQUEST', minecraftVersion);
    }
  }
});

test('the legacy runtime contract is refused next to runtime validation or Forge candidate authority', () => {
  let validationChecks = 0;
  for (const change of [
    { runtimeValidation: Object.freeze({ valid: true }) },
    { forgeCandidateHealthAuthorization: Object.freeze({}) }
  ]) {
    const h = harness({ supervisor: false });
    const runner = createServerProcessRunner({
      eventBus: h.eventBus,
      isManagedRuntimeValidation() { validationChecks += 1; return true; },
      resolveLaunchPlan() { assert.fail('legacy launch with lifecycle authority must not resolve a plan'); },
      resolvePrevalidatedLaunchPlan() { assert.fail('legacy launch with lifecycle authority must not resolve a plan'); },
      spawnProcess() { assert.fail('legacy launch with lifecycle authority must not spawn'); }
    });
    assert.throws(() => runner.launchServerProcess(h.request({
      runtimeContract: 'legacy',
      runtime: runtime({ minecraftVersion: '24w14a' }),
      ...change
    })), error => error.code === 'INVALID_REQUEST');
  }
  assert.equal(validationChecks, 0);
});

test('the legacy runtime contract still rejects malformed tuples', () => {
  const invalid = [
    { minecraftVersion: '' },
    { minecraftVersion: '   ' },
    { minecraftVersion: 'x'.repeat(65) },
    { minecraftVersion: '1.20\n1' },
    { minecraftVersion: '1.20\u00851' },
    { minecraftVersion: 120 },
    { loaderFamily: 'paper' },
    { loaderVersion: '' },
    { loaderVersion: 'x'.repeat(129) },
    { javaMajor: 7 },
    { javaMajor: 100 },
    { javaMajor: 17.5 },
    { os: 'linux' },
    { architecture: 'arm64' },
    { extra: true }
  ];
  for (const change of invalid) {
    const h = harness({ supervisor: false });
    assert.throws(() => h.launch({ runtimeContract: 'legacy', runtime: runtime(change) }),
      error => error.code === 'INVALID_REQUEST', JSON.stringify(change));
    assert.equal(h.plans.length, 0, JSON.stringify(change));
  }
});

test('real Windows best-effort watchdog: ending PowerShell never kills the server, app death still does', {
  skip: process.platform !== 'win32' && 'the exact-PID watchdog is Windows PowerShell',
  timeout: 90000
}, async t => {
  const eventBus = new EventEmitter();
  const watchers = [];
  const targets = [];
  const supervisor = createAppWatchdogSupervisor({
    eventBus,
    spawnImpl(file, args, options) {
      const child = spawn(file, args, options);
      watchers.push(child);
      return child;
    },
    warn() {}
  });
  supervisor.start();
  t.after(() => {
    supervisor.dispose();
    for (const child of [...targets, ...watchers]) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
  const runner = createServerProcessRunner({
    eventBus,
    getListeningEndpoints: async () => [],
    resolveLaunchPlan: (serverPath, options, extra) => ({
      type: 'jar', loader: options.loader, jar: null, args: [], cwd: serverPath,
      readyMarkers: ['READY'], fatalMarkers: ['FATAL'], runtime: extra.runtimeTuple
    }),
    // A harmless stand-in server whose command line carries the exact launch markers.
    spawnProcess(file, args, options) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args], options);
      targets.push(child);
      return child;
    }
  });
  const launch = operationId => runner.launchServerProcess({
    instanceId: 'watchdog-best-effort', javaPath: process.execPath, maxRam: 1, onLine() {}, operationId,
    publishEvents: false, runtime: runtime(), serverPath: os.tmpdir(), supervision: 'best-effort'
  });
  const exited = child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });

  const survivor = launch(`watchdog-best-effort-${process.pid}-a`);
  assert.equal(await survivor.supervision.settled, 'armed');
  watchers[0].kill();
  await exited(watchers[0]);
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(survivor.supervision.state(), 'lost');
  assert.equal(survivor.isLive(), true);
  assert.equal(targets[0].exitCode, null, 'losing the watchdog must not terminate the server');

  const protectedServer = launch(`watchdog-best-effort-${process.pid}-b`);
  assert.equal(await protectedServer.supervision.settled, 'armed');
  watchers[1].stdin.end(); // What the operating system does to the pipe when the app dies.
  await Promise.race([
    exited(targets[1]),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('app-death protection did not stop the server')), 20000))
  ]);
  assert.equal(targets[0].exitCode, null, 'only the exact pinned process is terminated');
});

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf('{', start + signature.length - 1);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unterminated ${signature}`);
}

test('static check: no best-effort watchdog path can terminate Java', () => {
  const root = path.resolve(__dirname, '..');
  const runnerSource = fs.readFileSync(path.join(root, 'electron', 'services', 'server-process-runner.cjs'), 'utf8');
  const supervisorSource = fs.readFileSync(path.join(root, 'electron', 'watchdog', 'app-watchdog-supervisor.cjs'), 'utf8');
  const supervisionSource = fs.readFileSync(path.join(root, 'electron', 'watchdog', 'server-process-supervision.cjs'), 'utf8');
  for (const [name, source] of [['runner', runnerSource], ['supervisor', supervisorSource], ['supervision', supervisionSource]]) {
    assert.doesNotMatch(source, /process\.kill\s*\(/u, name);
  }
  assert.doesNotMatch(supervisionSource, /\.kill\s*\(/u);

  for (const signature of [
    'const degradeSupervision = reason => {',
    'const markSupervisionArmed = () => {',
    'const reportSupervision = (state, reason) => {'
  ]) {
    assert.doesNotMatch(functionBody(runnerSource, signature), /\bkill\b|\bfatal\s*=/u, signature);
  }
  const failure = functionBody(runnerSource, 'const supervisionFailure = reason => {');
  const bestEffortReturn = failure.indexOf("if (supervisionMode === 'best-effort') return degradeSupervision(reason);");
  assert.ok(bestEffortReturn > 0 && bestEffortReturn < failure.indexOf('.kill('),
    'best-effort faults return before the required-mode termination path');
  assert.doesNotMatch(functionBody(supervisorSource, 'const reportDeadline = error => {'), /\bkill\b|\bfail\(/u);
});
