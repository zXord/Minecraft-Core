const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  MANAGED_RUNTIME_PREPARE_OPERATION,
  MANAGED_RUNTIME_VERIFY_OPERATION,
  createManagedRuntimeResponse,
  verifyManagedRuntimeRequest
} = require('../electron/services/managed-runtime-worker-protocol.cjs');

let clientModule = null;
try {
  clientModule = require('../electron/services/managed-runtime-worker-client.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions below without the module.
}

const token = '3'.repeat(64);
const requestId = '4'.repeat(32);
const runtime = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});
const validation = Object.freeze({
  valid: true,
  runtime,
  loader: { family: 'fabric', launcherJar: 'fabric-server-launch.jar' },
  artifacts: [{
    relativePath: 'fabric-server-launch.jar',
    size: 7,
    sha256: 'a'.repeat(64),
    sha512: 'b'.repeat(128)
  }, {
    relativePath: 'server.jar',
    size: 8,
    sha256: 'c'.repeat(64),
    sha512: 'd'.repeat(128)
  }]
});

class FakeChild extends EventEmitter {
  constructor(pid = 7373, closeOnKill = true, closeOnDisconnect = true) {
    super();
    this.pid = pid;
    this.closeOnKill = closeOnKill;
    this.closeOnDisconnect = closeOnDisconnect;
    this.connected = true;
    this.sent = [];
    this.killSignals = [];
    this.disconnectCalls = 0;
  }

  send(message, callback) {
    this.sent.push(message);
    queueMicrotask(() => callback?.(null));
    return true;
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
    if (this.closeOnDisconnect) queueMicrotask(() => this.emit('close', 65, null));
  }
}

function fixtureOptions(overrides = {}) {
  return {
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    targetPath: path.resolve('managed-runtime-client', 'server'),
    runtime,
    javaPath: path.resolve('managed-runtime-client', 'java', 'bin', 'java.exe'),
    timeoutMs: 1000,
    ...overrides
  };
}

function createHarness({ child = new FakeChild(), execFileImpl } = {}) {
  const forks = [];
  const taskkills = [];
  const forkImpl = (modulePath, args, options) => {
    forks.push({ modulePath, args, options });
    return child;
  };
  const runExecFile = execFileImpl || ((file, args, options, callback) => {
    taskkills.push({ file, args, options });
    queueMicrotask(() => {
      callback?.(null, '', '');
      child.emit?.('close', null, 'SIGKILL');
    });
  });
  const run = clientModule.createManagedRuntimeWorkerClient({
    forkImpl,
    execFileImpl: runExecFile,
    execPath: path.resolve('managed-runtime-client', 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'managed-runtime-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  return { child, forks, taskkills, run };
}

test('authenticated preparation sends only the exact request and resolves after clean close', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const harness = createHarness();
  const options = fixtureOptions();
  const pending = harness.run(options);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.forks.length, 1);
  const fork = harness.forks[0];
  assert.deepEqual(fork.args, []);
  assert.deepEqual(fork.options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(fork.options.windowsHide, true);
  assert.equal(fork.options.detached, false);
  assert.equal(fork.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(fork.options.execPath, path.resolve('managed-runtime-client', 'electron.exe'));
  assert.equal(fork.options.cwd, path.dirname(path.resolve('managed-runtime-client', 'electron.exe')));
  assert.equal(JSON.stringify(fork).includes(options.targetPath), false);
  assert.equal(JSON.stringify(fork).includes(options.javaPath), false);
  assert.deepEqual(verifyManagedRuntimeRequest(harness.child.sent[0], token), {
    requestId,
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    payload: { targetPath: options.targetPath, runtime, javaPath: options.javaPath }
  });

  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  harness.child.emit('message', createManagedRuntimeResponse({
    token,
    requestId,
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    ok: true,
    result: { valid: true, runtime }
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  harness.child.emit('close', 0, null);
  assert.deepEqual(await pending, { valid: true, runtime });
});

test('the same lifecycle supports a bounded verify-only operation without a Java payload', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const harness = createHarness();
  const options = fixtureOptions({
    operation: MANAGED_RUNTIME_VERIFY_OPERATION
  });
  delete options.javaPath;
  const pending = harness.run(options);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(verifyManagedRuntimeRequest(harness.child.sent[0], token), {
    requestId,
    operation: MANAGED_RUNTIME_VERIFY_OPERATION,
    payload: { targetPath: options.targetPath, runtime }
  });
  harness.child.emit('message', createManagedRuntimeResponse({
    token,
    requestId,
    operation: MANAGED_RUNTIME_VERIFY_OPERATION,
    ok: true,
    result: validation
  }));
  harness.child.emit('close', 0, null);
  const result = await pending;
  assert.deepEqual(result, validation);
  assert.equal(clientModule.isAppIssuedManagedRuntimeValidation(result, options.targetPath), true);
  assert.equal(clientModule.isAppIssuedManagedRuntimeValidation(result), false);
  assert.equal(clientModule.isAppIssuedManagedRuntimeValidation(
    result,
    path.resolve('managed-runtime-client', 'other-server')
  ), false);
  assert.equal(clientModule.isAppIssuedManagedRuntimeValidation({ ...result }, options.targetPath), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.runtime), true);
  assert.equal(Object.isFrozen(result.loader), true);
  assert.equal(Object.isFrozen(result.artifacts), true);
});

test('malformed AbortSignals and caller function seams are rejected before fork', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const harness = createHarness();

  await assert.rejects(
    harness.run(fixtureOptions({ signal: { aborted: false } })),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  await assert.rejects(
    harness.run(fixtureOptions({ validateJava: async () => 17 })),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  assert.equal(harness.forks.length, 0);
});

test('validated signal and runtime accessors are captured once before fork', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const harness = createHarness();
  const options = fixtureOptions();
  const signal = new AbortController().signal;
  let signalReads = 0;
  let runtimeReads = 0;
  Object.defineProperty(options, 'signal', {
    configurable: true,
    enumerable: true,
    get() {
      signalReads += 1;
      if (signalReads > 1) throw new Error('signal accessor was read after validation');
      return signal;
    }
  });
  Object.defineProperty(options, 'runtime', {
    configurable: true,
    enumerable: true,
    get() {
      runtimeReads += 1;
      if (runtimeReads > 1) throw new Error('runtime accessor was read after request creation');
      return runtime;
    }
  });

  const pending = harness.run(options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.forks.length, 1);
  harness.child.emit('message', createManagedRuntimeResponse({
    token,
    requestId,
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    ok: true,
    result: { valid: true, runtime }
  }));
  harness.child.emit('close', 0, null);
  assert.deepEqual(await pending, { valid: true, runtime });
  assert.equal(signalReads, 1);
  assert.equal(runtimeReads, 1);
});

test('AbortSignal state is read through the branded getter instead of caller accessors', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const harness = createHarness();
  const signal = new AbortController().signal;
  let reads = 0;
  Object.defineProperty(signal, 'aborted', {
    get() {
      reads += 1;
      throw new Error('abort state trap');
    }
  });

  const pending = harness.run(fixtureOptions({ signal }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.forks.length, 1);
  harness.child.emit('message', createManagedRuntimeResponse({
    token,
    requestId,
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    ok: true,
    result: { valid: true, runtime }
  }));
  harness.child.emit('close', 0, null);
  assert.deepEqual(await pending, { valid: true, runtime });
  assert.equal(reads, 0);
});

test('AbortSignal listener and cleanup traps cannot leak or strand the worker', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const listenerHarness = createHarness();
  const listenerSignal = new AbortController().signal;
  Object.defineProperty(listenerSignal, 'addEventListener', {
    value() { throw new Error('listener trap'); }
  });
  await assert.rejects(
    listenerHarness.run(fixtureOptions({ signal: listenerSignal, terminationGraceMs: 100 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true &&
      !error.message.includes('listener trap')
  );
  assert.equal(listenerHarness.taskkills.length, 0);
  assert.deepEqual(listenerHarness.child.killSignals, ['SIGKILL']);
  assert.equal(listenerHarness.child.disconnectCalls, 0);

  const cleanupHarness = createHarness();
  const cleanupSignal = new AbortController().signal;
  Object.defineProperty(cleanupSignal, 'removeEventListener', {
    value() { throw new Error('cleanup trap'); }
  });
  const pending = cleanupHarness.run(fixtureOptions({ signal: cleanupSignal }));
  await new Promise(resolve => setImmediate(resolve));
  cleanupHarness.child.emit('message', createManagedRuntimeResponse({
    token,
    requestId,
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    ok: true,
    result: { valid: true, runtime }
  }));
  assert.doesNotThrow(() => cleanupHarness.child.emit('close', 0, null));
  assert.deepEqual(await pending, { valid: true, runtime });
});

test('a partially valid child returned by fork is killed through its retained handle before rejection', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const killSignals = [];
  const partialChild = { pid: 8484, kill(signal) { killSignals.push(signal); } };
  const harness = createHarness({
    child: partialChild,
    execFileImpl() { throw new Error('must not be called'); }
  });

  await assert.rejects(
    harness.run(fixtureOptions()),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.equal(harness.taskkills.length, 0);
  assert.deepEqual(killSignals, ['SIGKILL']);
});

test('child shape and listener accessors cannot strand a spawned worker', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const killSignals = [];
  const shapeChild = {
    pid: 8585,
    get on() { throw new Error('shape trap'); },
    kill(signal) { killSignals.push({ child: 'shape', signal }); }
  };
  const shapeRun = clientModule.createManagedRuntimeWorkerClient({
    forkImpl: () => shapeChild,
    platform: 'linux',
    processKillImpl() { throw new Error('must not be called'); },
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  await assert.rejects(
    shapeRun(fixtureOptions()),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true &&
      !error.message.includes('shape trap')
  );

  const listenerChild = {
    pid: 8686,
    on() { throw new Error('listener trap'); },
    once() {},
    send() {},
    kill(signal) { killSignals.push({ child: 'listener', signal }); }
  };
  const listenerRun = clientModule.createManagedRuntimeWorkerClient({
    forkImpl: () => listenerChild,
    platform: 'linux',
    processKillImpl() { throw new Error('must not be called'); },
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  await assert.rejects(
    listenerRun(fixtureOptions({ terminationGraceMs: 5 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true &&
      !error.message.includes('listener trap')
  );
  assert.deepEqual(killSignals, [
    { child: 'shape', signal: 'SIGKILL' },
    { child: 'listener', signal: 'SIGKILL' }
  ]);
});

test('an unreadable child pid falls back to its process handle', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const killSignals = [];
  const child = {
    get pid() { throw new Error('pid trap'); },
    get on() { throw new Error('shape trap'); },
    kill(signal) { killSignals.push(signal); }
  };
  const run = clientModule.createManagedRuntimeWorkerClient({
    forkImpl: () => child,
    platform: 'win32',
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });

  await assert.rejects(
    run(fixtureOptions()),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.deepEqual(killSignals, ['SIGKILL']);
});

test('worker failure preserves the possibly mutated target and exposes only the closed code', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const harness = createHarness();
  const options = fixtureOptions({ terminationGraceMs: 100 });
  const pending = harness.run(options);
  await new Promise(resolve => setImmediate(resolve));
  harness.child.emit('message', createManagedRuntimeResponse({
    token,
    requestId,
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    ok: false,
    code: 'LOADER_VERSION_UNAVAILABLE'
  }));

  harness.child.emit('close', 1, null);

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'LOADER_VERSION_UNAVAILABLE');
    assert.equal(error.preserveWorkspace, true);
    assert.equal(error.message.includes(options.targetPath), false);
    assert.equal(error.message.includes(options.javaPath), false);
    return true;
  });
  assert.equal(harness.taskkills.length, 0);
  assert.deepEqual(harness.child.killSignals, []);
  assert.equal(harness.child.disconnectCalls, 0);
});

test('timeout and mid-flight cancellation disconnect descendant-capable workers and preserve their targets', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const timeoutHarness = createHarness();
  await assert.rejects(
    timeoutHarness.run(fixtureOptions({ timeoutMs: 5, terminationGraceMs: 100 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.equal(timeoutHarness.taskkills.length, 0);
  assert.deepEqual(timeoutHarness.child.killSignals, []);
  assert.equal(timeoutHarness.child.disconnectCalls, 1);

  const cancelHarness = createHarness();
  const controller = new AbortController();
  const pending = cancelHarness.run(fixtureOptions({ signal: controller.signal, terminationGraceMs: 100 }));
  controller.abort();
  await assert.rejects(
    pending,
    error => error.code === 'CANCELLED' && error.preserveWorkspace === true
  );
  assert.equal(cancelHarness.taskkills.length, 0);
  assert.deepEqual(cancelHarness.child.killSignals, []);
  assert.equal(cancelHarness.child.disconnectCalls, 1);
});

test('tampered or duplicate worker output fails closed and terminates the worker', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const harness = createHarness();
  const pending = harness.run(fixtureOptions({ terminationGraceMs: 100 }));
  await new Promise(resolve => setImmediate(resolve));
  const response = createManagedRuntimeResponse({
    token,
    requestId,
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    ok: true,
    result: { valid: true, runtime }
  });
  harness.child.emit('message', { ...response, result: { valid: true, runtime: { ...runtime, javaMajor: 21 } } });
  harness.child.emit('message', response);

  await assert.rejects(
    pending,
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.equal(harness.taskkills.length, 0);
  assert.deepEqual(harness.child.killSignals, []);
  assert.equal(harness.child.disconnectCalls, 1);
});

test('duplicate authenticated success and unexplained exit both preserve and fail closed', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const duplicateHarness = createHarness();
  const duplicatePending = duplicateHarness.run(fixtureOptions({ terminationGraceMs: 100 }));
  await new Promise(resolve => setImmediate(resolve));
  const response = createManagedRuntimeResponse({
    token,
    requestId,
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    ok: true,
    result: { valid: true, runtime }
  });
  duplicateHarness.child.emit('message', response);
  duplicateHarness.child.emit('message', response);
  await assert.rejects(
    duplicatePending,
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );

  const exitHarness = createHarness();
  const exitPending = exitHarness.run(fixtureOptions());
  await new Promise(resolve => setImmediate(resolve));
  exitHarness.child.emit('close', 1, null);
  await assert.rejects(
    exitPending,
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
});

test('termination never authorizes a reusable numeric pid or kills a descendant-capable runtime worker', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const child = new FakeChild(7373);
  const originalKill = child.kill.bind(child);
  child.kill = signal => {
    const result = originalKill(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return result;
  };
  let pidTerminationCalls = 0;
  const run = clientModule.createManagedRuntimeWorkerClient({
    forkImpl: () => child,
    execFileImpl() {
      pidTerminationCalls += 1;
      throw new Error('numeric pid termination must not be used');
    },
    processKillImpl() {
      pidTerminationCalls += 1;
      throw new Error('numeric process-group termination must not be used');
    },
    execPath: path.resolve('managed-runtime-client', 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'managed-runtime-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });

  await assert.rejects(
    run(fixtureOptions({ timeoutMs: 5, terminationGraceMs: 100 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.equal(pidTerminationCalls, 0);
  assert.deepEqual(child.killSignals, []);
  assert.equal(child.disconnectCalls, 1);
});

test('an unclosable descendant-capable runtime worker is retained after bounded rejection until actual close', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');
  const child = new FakeChild(7373, false, false);
  const harness = createHarness({ child });

  await assert.rejects(
    harness.run(fixtureOptions({ timeoutMs: 5, terminationGraceMs: 15 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.deepEqual(child.killSignals, []);
  assert.equal(child.disconnectCalls, 1);
  child.emit('close', 0, null);
});

test('pre-send listener failures kill the exact runtime worker while send-call ambiguity only disconnects', async () => {
  assert.equal(typeof clientModule?.createManagedRuntimeWorkerClient, 'function');

  for (const [name, mutate] of [
    ['message-listener', child => { child.on = () => { throw new Error('on trap'); }; }],
    ['close-listener', child => { child.once = () => { throw new Error('once trap'); }; }]
  ]) {
    const child = new FakeChild();
    mutate(child);
    let pidTerminationCalls = 0;
    const run = clientModule.createManagedRuntimeWorkerClient({
      forkImpl: () => child,
      execFileImpl() { pidTerminationCalls += 1; },
      processKillImpl() { pidTerminationCalls += 1; },
      platform: 'win32',
      tokenFactory: () => token,
      requestIdFactory: () => requestId
    });
    await assert.rejects(
      run(fixtureOptions({ terminationGraceMs: 10 })),
      error => error.code === 'RUNTIME_INCOMPLETE' && !error.message.includes('trap'),
      name
    );
    assert.deepEqual(child.killSignals, ['SIGKILL'], name);
    assert.equal(child.disconnectCalls, 0, name);
    assert.equal(pidTerminationCalls, 0, name);
  }

  const getterChild = new FakeChild();
  Object.defineProperty(getterChild, 'send', {
    get() { throw new Error('send getter trap'); }
  });
  const getterRun = clientModule.createManagedRuntimeWorkerClient({
    forkImpl: () => getterChild,
    platform: 'win32',
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  await assert.rejects(
    getterRun(fixtureOptions({ terminationGraceMs: 10 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && !error.message.includes('trap')
  );
  assert.deepEqual(getterChild.killSignals, ['SIGKILL']);
  assert.equal(getterChild.disconnectCalls, 0);

  const callChild = new FakeChild();
  callChild.send = () => { throw new Error('send call trap'); };
  const callRun = clientModule.createManagedRuntimeWorkerClient({
    forkImpl: () => callChild,
    platform: 'win32',
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  await assert.rejects(
    callRun(fixtureOptions({ terminationGraceMs: 10 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true &&
      !error.message.includes('trap')
  );
  assert.deepEqual(callChild.killSignals, []);
  assert.equal(callChild.disconnectCalls, 1);
});
