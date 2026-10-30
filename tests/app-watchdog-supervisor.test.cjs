const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { ACK_TIMEOUT_MS, createAppWatchdogSupervisor, MAX_ACK_BYTES } = require('../electron/watchdog/app-watchdog-supervisor.cjs');
const { getSupervisionAvailability } = require('../electron/watchdog/server-process-supervision-policy.cjs');
const { createServerProcessRunner } = require('../electron/services/server-process-runner.cjs');

class FakePipe extends PassThrough {
  constructor() { super(); this.unrefCalls = 0; }
  unref() { this.unrefCalls += 1; }
}
class FakeWatchdog extends EventEmitter {
  constructor(pid = 7001) {
    super(); this.pid = pid; this.stdin = new FakePipe(); this.stdout = new FakePipe();
    this.killCalls = []; this.unrefCalls = 0;
  }
  kill(signal) { this.killCalls.push(signal); return true; }
  unref() { this.unrefCalls += 1; }
}
class FakeJava extends EventEmitter {
  constructor(pid = 9101) {
    super(); this.pid = pid; this.exitCode = null; this.signalCode = null; this.killed = false;
    this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdin = { write() { return true; } };
    this.killCalls = [];
  }
  kill(signal) { this.killed = true; this.killCalls.push(signal); return true; }
  close(code = 0, signal = null) {
    this.exitCode = code; this.signalCode = signal; this.emit('close', code, signal);
  }
}
function owned(instanceId, pid, operationId) {
  const acknowledgements = []; const failures = [];
  return { acknowledgements, failures, event: {
    acknowledge(value) { acknowledgements.push(value); }, instanceId,
    onSupervisionFailure(value) { failures.push(value); }, operationId, pid
  } };
}
function fixture({ spawnError = null, watchdogPid = 7001, powerShell = true, warnings = [] } = {}) {
  const eventBus = new EventEmitter(); const spawned = []; let nonceIndex = 0;
  const timerCallbacks = new Set();
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cimModule = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\CimCmdlets\\CimCmdlets.psd1';
  const fsApi = {
    lstatSync(value) { assert.ok([powershell, cimModule].includes(value)); return { isFile: () => true, isSymbolicLink: () => false }; },
    realpathSync: { native(value) { return value; } }
  };
  const supervisor = createAppWatchdogSupervisor({
    cryptoApi: { randomBytes() { nonceIndex += 1; return Buffer.alloc(32, nonceIndex); } },
    env: {
      ...(powerShell ? { SystemRoot: 'C:\\Windows' } : {}),
      PSModulePath: 'C:\\Users\\attacker\\Documents\\WindowsPowerShell\\Modules',
      PATH: 'C:\\hostile-bin',
      HOSTILE_JUNK: 'must-not-cross-boundary'
    }, eventBus, fsApi,
    spawnImpl(file, args, options) {
      if (spawnError) throw spawnError;
      const child = new FakeWatchdog(watchdogPid); spawned.push({ args, child, file, options }); return child;
    },
    timers: {
      clearTimeout(timer) { timerCallbacks.delete(timer?.callback); },
      setTimeout(callback, delay) {
        assert.equal(delay, ACK_TIMEOUT_MS); timerCallbacks.add(callback);
        return { callback, unref() {} };
      }
    },
    warn(message) { warnings.push(message); }
  });
  const ack = index => {
    const item = spawned[index];
    const env = item.options.env;
    item.child.stdout.write(`MCWD1|${env.MC_CORE_WATCHDOG_NONCE}|${env.MC_CORE_WATCHDOG_INSTANCE}|${env.MC_CORE_WATCHDOG_PID}|${env.MC_CORE_WATCHDOG_OPERATION}\n`);
  };
  return { ack, eventBus, fireTimers() { for (const callback of [...timerCallbacks]) callback(); }, spawned, supervisor };
}
function runnerFixture(options = {}) {
  const f = fixture(options); f.supervisor.start(); const child = new FakeJava();
  const runtime = Object.freeze({ architecture: 'x64', javaMajor: 17, loaderFamily: 'vanilla', loaderVersion: '1.20.1', minecraftVersion: '1.20.1', os: 'win32' });
  const runner = createServerProcessRunner({ eventBus: f.eventBus, getListeningEndpoints: async () => [],
    resolveLaunchPlan: () => ({ args: ['-jar', 'server.jar'], cwd: 'C:\\server', fatalMarkers: ['fatal'], loader: 'vanilla', readyMarkers: ['Done ('], runtime, type: 'jar' }),
    spawnProcess: () => child, supervisionRequired: () => true });
  const request = { instanceId: 'runner-instance', javaPath: 'C:\\Java\\bin\\java.exe', maxRam: 4, onLine() {}, operationId: 'server-operation-1', publishEvents: false, runtime, serverPath: 'C:\\server' };
  return { ...f, child, request, runner };
}

test('supervisor spawns absolute PowerShell with encoded command, strict env identity, and pipe ACK', async () => {
  const { ack, eventBus, spawned, supervisor } = fixture(); supervisor.start();
  const owner = owned('server-a', 8101, 'operation-a'); eventBus.emit('server-process-owned', owner.event);
  assert.equal(spawned[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(spawned[0].options.shell, false); assert.deepEqual(spawned[0].options.stdio, ['pipe', 'pipe', 'ignore']);
  assert.deepEqual(Object.keys(spawned[0].options.env).sort(), [
    'MC_CORE_WATCHDOG_CIM_MODULE', 'MC_CORE_WATCHDOG_INSTANCE', 'MC_CORE_WATCHDOG_NONCE',
    'MC_CORE_WATCHDOG_OPERATION', 'MC_CORE_WATCHDOG_PID', 'PSModulePath', 'SystemRoot', 'WINDIR'
  ]);
  assert.equal(spawned[0].options.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.equal(spawned[0].options.env.MC_CORE_WATCHDOG_CIM_MODULE,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\CimCmdlets\\CimCmdlets.psd1');
  assert.ok(spawned[0].args.includes('-EncodedCommand')); assert.equal(spawned[0].args.includes('-Command'), false);
  assert.equal(owner.acknowledgements.length, 1); assert.equal(typeof owner.acknowledgements[0].ready.then, 'function');
  let armed = false; owner.acknowledgements[0].ready.then(() => { armed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(armed, false);
  ack(0); await owner.acknowledgements[0].ready; assert.equal(armed, true);
});

test('Java ready before watchdog ACK stays pending until supervision is pinned', async () => {
  const { ack, child, request, runner } = runnerFixture(); const handle = runner.launchServerProcess(request);
  const ready = handle.waitForReady({ timeoutMs: 1000 }); let settled = false; ready.finally(() => { settled = true; });
  child.stdout.write('Done (1s)\n'); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  ack(0); assert.deepEqual(await ready, { marker: 'Done (', pid: 9101 });
});

test('missing, malformed, extra, wrong, oversized, and late ACKs fail closed', async () => {
  for (const mode of ['malformed', 'extra', 'wrong', 'oversized', 'late']) {
    const f = runnerFixture(); const handle = f.runner.launchServerProcess(f.request);
    const ready = handle.waitForReady({ timeoutMs: 6000 }); f.child.stdout.write('Done (1s)\n');
    if (mode === 'malformed') f.spawned[0].child.stdout.write('bad\n');
    if (mode === 'extra') f.spawned[0].child.stdout.write('bad\nextra');
    if (mode === 'wrong') f.spawned[0].child.stdout.write('MCWD1|wrong|runner-instance|9101|server-operation-1\n');
    if (mode === 'oversized') f.spawned[0].child.stdout.write('x'.repeat(MAX_ACK_BYTES + 1));
    if (mode === 'late') { f.fireTimers(); f.ack(0); }
    await assert.rejects(ready, error => error?.code === 'HEALTH_CHECK_FAILED', mode);
    assert.deepEqual(f.child.killCalls, ['SIGKILL'], mode);
  }
});

test('duplicate ACK after arm is rejected and terminates the exact Java handle', async () => {
  const f = runnerFixture(); const handle = f.runner.launchServerProcess(f.request);
  f.ack(0); await handle.supervisionReady; f.spawned[0].child.stdout.write('unexpected-extra-byte');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.child.killCalls, ['SIGKILL']);
});

test('spawn failure and natural-exit, creation-mismatch, or token-mismatch arm failures kill only the exact Java handle', async () => {
  const failed = runnerFixture({ spawnError: new Error('denied') });
  const failedHandle = failed.runner.launchServerProcess(failed.request);
  await assert.rejects(failedHandle.supervisionReady, error => error?.code === 'HEALTH_CHECK_FAILED');
  assert.equal(failedHandle.child, failed.child);
  assert.deepEqual(failed.child.killCalls, ['SIGKILL']);
  for (const exitCode of [23, 25, 26]) {
    const armFailure = runnerFixture(); const handle = armFailure.runner.launchServerProcess(armFailure.request);
    armFailure.spawned[0].child.emit('exit', exitCode, null);
    await assert.rejects(handle.supervisionReady, error => error?.code === 'HEALTH_CHECK_FAILED');
    assert.deepEqual(armFailure.child.killCalls, ['SIGKILL']);
  }
});

test('exact triple isolates PID reuse and release disarms only matching retained watcher', async () => {
  const { ack, eventBus, spawned, supervisor } = fixture(); supervisor.start();
  const oldOwner = owned('same', 8201, 'old'); const newOwner = owned('same', 8201, 'new');
  eventBus.emit('server-process-owned', oldOwner.event); eventBus.emit('server-process-owned', newOwner.event);
  ack(0); ack(1); await Promise.all([oldOwner.acknowledgements[0].ready, newOwner.acknowledgements[0].ready]);
  eventBus.emit('server-process-released', { instanceId: 'same', pid: 8201, operationId: 'new' });
  assert.deepEqual(spawned.map(value => value.child.killCalls), [[], [undefined]]);
});

test('watcher failure after ACK notifies once and orderly dispose retains live watcher pipes', async () => {
  const { ack, eventBus, spawned, supervisor } = fixture(); supervisor.start(); const owner = owned('server-a', 8301, 'operation-a');
  eventBus.emit('server-process-owned', owner.event); ack(0); await owner.acknowledgements[0].ready; supervisor.dispose();
  assert.deepEqual(spawned[0].child.killCalls, []); assert.equal(spawned[0].child.stdin.unrefCalls, 1);
  spawned[0].child.emit('error', new Error('lost')); spawned[0].child.emit('exit', 1, null);
  assert.deepEqual(owner.failures, [{ instanceId: 'server-a', pid: 8301, operationId: 'operation-a' }]);
});

test('watchdog loss after a Java fatal marker still kills the exact child exactly once', async () => {
  const f = runnerFixture(); const handle = f.runner.launchServerProcess(f.request);
  f.ack(0); await handle.supervisionReady;
  f.child.stderr.write('fatal startup marker\n');
  await assert.rejects(handle.waitForReady({ timeoutMs: 1000 }), error => error?.code === 'HEALTH_CHECK_FAILED');
  assert.deepEqual(f.child.killCalls, []);
  f.spawned[0].child.emit('error', new Error('watchdog lost'));
  f.spawned[0].child.emit('exit', 1, null);
  assert.deepEqual(f.child.killCalls, ['SIGKILL']);
});

test('watchdog loss after a Java stream error kills once, but never after confirmed close', async () => {
  const streamFailure = runnerFixture(); const first = streamFailure.runner.launchServerProcess(streamFailure.request);
  streamFailure.ack(0); await first.supervisionReady;
  streamFailure.child.stdout.emit('error', new Error('stream failed'));
  streamFailure.spawned[0].child.emit('error', new Error('watchdog lost'));
  streamFailure.spawned[0].child.emit('exit', 1, null);
  assert.deepEqual(streamFailure.child.killCalls, ['SIGKILL']);

  const closed = runnerFixture(); const second = closed.runner.launchServerProcess(closed.request);
  closed.ack(0); await second.supervisionReady;
  closed.child.close(0, null);
  closed.spawned[0].child.emit('error', new Error('late watcher error'));
  assert.deepEqual(closed.child.killCalls, []);
});

test('an exit event without a matching watcher is harmless and does not block later listeners', () => {
  const { eventBus, supervisor } = fixture();
  supervisor.start();
  let laterListenerCalls = 0;
  eventBus.on('server-normal-exit', () => { laterListenerCalls += 1; });

  assert.doesNotThrow(() => eventBus.emit('server-normal-exit', {
    instanceId: 'server-without-watchdog',
    operationId: 'operation-without-watchdog',
    pid: 9901
  }));
  assert.equal(laterListenerCalls, 1);
});

test('the required ACK deadline allows a cold PowerShell 30 seconds', () => {
  assert.equal(ACK_TIMEOUT_MS, 30000);
});

test('watcher failure passes its reason to the exact supervision failure callback', async () => {
  const { ack, eventBus, spawned, supervisor } = fixture(); supervisor.start();
  const reasons = [];
  const owner = owned('server-a', 8401, 'operation-a');
  owner.event.onSupervisionFailure = (value, error) => { owner.failures.push(value); reasons.push(error); };
  eventBus.emit('server-process-owned', owner.event); ack(0); await owner.acknowledgements[0].ready;
  spawned[0].child.emit('exit', 1, null);
  assert.deepEqual(owner.failures, [{ instanceId: 'server-a', pid: 8401, operationId: 'operation-a' }]);
  assert.equal(reasons.length, 1);
  assert.ok(reasons[0] instanceof Error);
  assert.equal(reasons[0].message, 'watchdog exited unexpectedly (1/null)');
});

test('a best-effort deadline only reports, keeps the watcher alive, and a late ACK still arms', async () => {
  const warnings = [];
  const { ack, eventBus, fireTimers, spawned, supervisor } = fixture({ warnings }); supervisor.start();
  const owner = owned('server-a', 8501, 'operation-a');
  const deadlines = [];
  owner.event.onSupervisionDeadline = (value, error) => { deadlines.push([value, error]); };
  eventBus.emit('server-process-owned', owner.event);
  let armed = false;
  owner.acknowledgements[0].ready.then(() => { armed = true; });

  fireTimers();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deadlines.length, 1);
  assert.deepEqual(deadlines[0][0], { instanceId: 'server-a', pid: 8501, operationId: 'operation-a' });
  assert.equal(deadlines[0][1].message, 'Watchdog ACK deadline exceeded');
  assert.deepEqual(owner.failures, []);
  assert.deepEqual(spawned[0].child.killCalls, []);
  assert.equal(armed, false);
  assert.equal(warnings.length, 1);

  ack(0);
  await owner.acknowledgements[0].ready;
  assert.equal(armed, true);
  assert.deepEqual(owner.failures, []);
  eventBus.emit('server-process-released', { instanceId: 'server-a', pid: 8501, operationId: 'operation-a' });
  assert.deepEqual(spawned[0].child.killCalls, [undefined], 'the late-armed watcher remains tracked for an orderly release');
});

test('a best-effort watcher that dies after the deadline reports failure once and is not reported again', async () => {
  const { eventBus, fireTimers, spawned, supervisor } = fixture(); supervisor.start();
  const owner = owned('server-a', 8601, 'operation-a');
  const deadlines = [];
  owner.event.onSupervisionDeadline = value => { deadlines.push(value); };
  eventBus.emit('server-process-owned', owner.event);
  fireTimers();
  spawned[0].child.emit('exit', 29, null);
  spawned[0].child.emit('error', new Error('late'));
  await assert.rejects(owner.acknowledgements[0].ready, /watchdog exited unexpectedly \(29\/null\)/u);
  assert.equal(deadlines.length, 1);
  assert.deepEqual(owner.failures, [{ instanceId: 'server-a', pid: 8601, operationId: 'operation-a' }]);
});

test('start publishes whether the watchdog can arm on this PC', () => {
  const available = fixture(); available.supervisor.start();
  assert.deepEqual(getSupervisionAvailability(), { available: true, reason: null });

  const unavailable = fixture({ powerShell: false }); unavailable.supervisor.start();
  assert.deepEqual(getSupervisionAvailability(), { available: false, reason: 'powershell-unavailable' });
  const owner = owned('server-a', 8701, 'operation-a');
  unavailable.eventBus.emit('server-process-owned', owner.event);
  assert.equal(unavailable.spawned.length, 0);
  assert.deepEqual(owner.acknowledgements, []);

  available.supervisor.dispose(); unavailable.supervisor.dispose();
});

test('without an installed supervisor, availability does not refuse anything', () => {
  const policyPath = require.resolve('../electron/watchdog/server-process-supervision-policy.cjs');
  const original = require.cache[policyPath];
  delete require.cache[policyPath];
  try {
    const fresh = require(policyPath);
    assert.equal(fresh.isServerProcessSupervisionRequired(), false);
    assert.deepEqual(fresh.getSupervisionAvailability(), { available: true, reason: 'not-required' });
    assert.equal(Object.isFrozen(fresh.getSupervisionAvailability()), true);
  } finally {
    require.cache[policyPath] = original;
  }
});
