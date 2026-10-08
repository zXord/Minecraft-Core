const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  createForgeFinalizerResponse,
  verifyForgeFinalizerRequest
} = require('../electron/services/forge-runtime-finalizer-worker-protocol.cjs');

let clientModule = null;
try {
  clientModule = require('../electron/services/forge-runtime-finalizer-worker-client.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions below without the module.
}

const token = '3'.repeat(64);
const requestId = '4'.repeat(32);
const runtime = Object.freeze({
  minecraftVersion: '1.12.2',
  loaderFamily: 'forge',
  loaderVersion: '14.23.5.2860',
  javaMajor: 8,
  os: 'win32',
  architecture: 'x64'
});
const validation = Object.freeze({
  valid: true,
  runtime,
  loader: { family: 'forge', argsFile: 'libraries/net/minecraftforge/forge/1.12.2-14.23.5.2860/win_args.txt' },
  artifacts: [
    {
      relativePath: 'libraries/net/minecraftforge/forge/1.12.2-14.23.5.2860/win_args.txt',
      size: 5,
      sha256: 'c'.repeat(64),
      sha512: 'd'.repeat(128)
    },
    {
      relativePath: 'server.jar',
      size: 7,
      sha256: 'a'.repeat(64),
      sha512: 'b'.repeat(128)
    }
  ]
});

class FakeChild extends EventEmitter {
  constructor(pid = 5252, closeOnKill = true) {
    super();
    this.pid = pid;
    this.closeOnKill = closeOnKill;
    this.connected = true;
    this.sent = [];
    this.killSignals = [];
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
}

function fixtureOptions(overrides = {}) {
  return {
    targetPath: path.resolve('forge-finalizer-client', 'server'),
    runtime,
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
      child.emit('close', null, 'SIGKILL');
    });
  });
  const run = clientModule.createForgeRuntimeFinalizerWorkerClient({
    forkImpl,
    execFileImpl: runExecFile,
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'forge-runtime-finalizer-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  return { child, forks, taskkills, run };
}

test('authenticated finalizer success returns validation only after a clean worker close', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const harness = createHarness();
  const options = fixtureOptions();
  const pending = harness.run(options);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.forks.length, 1);
  assert.deepEqual(harness.forks[0].options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.deepEqual(harness.forks[0].options.execArgv, []);
  assert.equal(harness.forks[0].options.windowsHide, true);
  assert.equal(JSON.stringify(harness.forks[0]).includes(options.targetPath), false);
  assert.deepEqual(verifyForgeFinalizerRequest(harness.child.sent[0], token), {
    requestId,
    payload: { targetPath: options.targetPath, runtime }
  });

  let settled = false;
  pending.finally(() => { settled = true; });
  harness.child.emit('message', createForgeFinalizerResponse({ token, requestId, ok: true, validation }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  harness.child.emit('close', 0, null);
  assert.deepEqual(await pending, validation);
});

test('pre-aborted and mid-flight cancellation stay CANCELLED and terminate the retained worker handle', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const preAbortedHarness = createHarness();
  await assert.rejects(
    preAbortedHarness.run(fixtureOptions({ signal: AbortSignal.abort() })),
    error => error.code === 'CANCELLED'
  );
  assert.equal(preAbortedHarness.forks.length, 0);

  const harness = createHarness();
  const controller = new AbortController();
  const pending = harness.run(fixtureOptions({ signal: controller.signal, terminationGraceMs: 100 }));
  controller.abort();
  await assert.rejects(
    pending,
    error => error.code === 'CANCELLED' && error.preserveWorkspace === true
  );
  assert.equal(harness.taskkills.length, 0);
  assert.deepEqual(harness.child.killSignals, ['SIGKILL']);
});

test('malformed cancellation signals and caller seams are rejected before a worker can be spawned', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const harness = createHarness();

  await assert.rejects(
    harness.run(fixtureOptions({ signal: { aborted: false } })),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  await assert.rejects(
    harness.run(fixtureOptions({
      signal: {
        aborted: false,
        addEventListener() {},
        removeEventListener() {},
        throwIfAborted() {}
      }
    })),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  await assert.rejects(
    harness.run(fixtureOptions({ finalizeForgeRuntimeImpl() {} })),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  await assert.rejects(
    harness.run(null),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  assert.equal(harness.forks.length, 0);
});

test('AbortSignal listener failures after fork terminate and preserve the worker target', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const harness = createHarness();
  const signal = new AbortController().signal;
  Object.defineProperty(signal, 'addEventListener', {
    value() { throw new Error('listener trap'); }
  });

  await assert.rejects(
    harness.run(fixtureOptions({ signal, terminationGraceMs: 100 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true &&
      !error.message.includes('listener trap')
  );
  assert.equal(harness.forks.length, 1);
  assert.equal(harness.taskkills.length, 0);
  assert.deepEqual(harness.child.killSignals, ['SIGKILL']);
});

test('AbortSignal cleanup failures cannot strand a completed worker promise', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const harness = createHarness();
  const signal = new AbortController().signal;
  Object.defineProperty(signal, 'removeEventListener', {
    value() { throw new Error('cleanup trap'); }
  });
  const pending = harness.run(fixtureOptions({ signal }));
  await new Promise(resolve => setImmediate(resolve));
  harness.child.emit('message', createForgeFinalizerResponse({ token, requestId, ok: true, validation }));

  assert.doesNotThrow(() => harness.child.emit('close', 0, null));
  assert.deepEqual(await pending, validation);
});

test('a partially valid fork result is terminated and preserved before rejection', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const killSignals = [];
  const run = clientModule.createForgeRuntimeFinalizerWorkerClient({
    forkImpl: () => ({
      pid: 6262,
      kill(signal) { killSignals.push(signal); }
    }),
    platform: 'linux',
    processKillImpl(pid, signal) {
      assert.equal(pid, -6262);
      assert.equal(signal, 'SIGKILL');
    },
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });

  await assert.rejects(
    run(fixtureOptions()),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.deepEqual(killSignals, ['SIGKILL']);
});

test('a partial Windows child is terminated through its retained handle', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const killSignals = [];
  const run = clientModule.createForgeRuntimeFinalizerWorkerClient({
    forkImpl: () => ({
      pid: 6363,
      kill(signal) { killSignals.push(signal); }
    }),
    execFileImpl() { throw new Error('must not be called'); },
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

test('listener registration failure after fork still kills the retained handle and preserves the target', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const killSignals = [];
  const child = {
    pid: 6464,
    on() { throw new Error('listener registration trap'); },
    once() {},
    send() {},
    kill(signal) { killSignals.push(signal); }
  };
  const run = clientModule.createForgeRuntimeFinalizerWorkerClient({
    forkImpl: () => child,
    platform: 'linux',
    processKillImpl() { throw new Error('must not be called'); },
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });

  await assert.rejects(
    run(fixtureOptions({ terminationGraceMs: 100 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true &&
      !error.message.includes('listener registration trap')
  );
  assert.deepEqual(killSignals, ['SIGKILL']);
});

test('child shape accessors cannot bypass retained-handle termination after fork', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const killSignals = [];
  const child = {
    pid: 6565,
    get on() { throw new Error('shape trap'); },
    kill(signal) { killSignals.push(signal); }
  };
  const run = clientModule.createForgeRuntimeFinalizerWorkerClient({
    forkImpl: () => child,
    platform: 'linux',
    processKillImpl() { throw new Error('must not be called'); },
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });

  await assert.rejects(
    run(fixtureOptions()),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true &&
      !error.message.includes('shape trap')
  );
  assert.deepEqual(killSignals, ['SIGKILL']);
});

test('an unreadable child pid falls back to the child handle before rejection', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const killSignals = [];
  const child = {
    get pid() { throw new Error('pid trap'); },
    get on() { throw new Error('shape trap'); },
    kill(signal) { killSignals.push(signal); }
  };
  const run = clientModule.createForgeRuntimeFinalizerWorkerClient({
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

test('timeout settles boundedly and marks the workspace for preservation when the child cannot close', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const child = new FakeChild(5252, false);
  const harness = createHarness({
    child,
    execFileImpl(file, args, options, callback) {
      harness.taskkills.push({ file, args, options });
      queueMicrotask(() => callback?.(new Error('termination failed')));
    }
  });

  await assert.rejects(
    harness.run(fixtureOptions({ timeoutMs: 5, terminationGraceMs: 15 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});

test('tampered authenticated-looking output fails closed and terminates the worker', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const harness = createHarness();
  const pending = harness.run(fixtureOptions({ terminationGraceMs: 100 }));
  await new Promise(resolve => setImmediate(resolve));
  const response = createForgeFinalizerResponse({ token, requestId, ok: true, validation });
  harness.child.emit('message', {
    ...response,
    validation: { ...response.validation, artifacts: [{ ...response.validation.artifacts[0], size: 8 }] }
  });

  await assert.rejects(
    pending,
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.equal(harness.taskkills.length, 0);
  assert.deepEqual(harness.child.killSignals, ['SIGKILL']);
});

test('duplicate authenticated output fails closed instead of accepting the first result', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const harness = createHarness();
  const pending = harness.run(fixtureOptions({ terminationGraceMs: 100 }));
  await new Promise(resolve => setImmediate(resolve));
  const response = createForgeFinalizerResponse({ token, requestId, ok: true, validation });
  harness.child.emit('message', response);
  harness.child.emit('message', response);

  await assert.rejects(
    pending,
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.equal(harness.taskkills.length, 0);
  assert.deepEqual(harness.child.killSignals, ['SIGKILL']);
});

test('authenticated finalizer failure preserves the possibly mutated target', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const harness = createHarness();
  const pending = harness.run(fixtureOptions({ terminationGraceMs: 100 }));
  await new Promise(resolve => setImmediate(resolve));
  harness.child.emit('message', createForgeFinalizerResponse({
    token,
    requestId,
    ok: false,
    validation: null
  }));

  await assert.rejects(
    pending,
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
});

test('an unexplained worker exit preserves the possibly mutated target', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const harness = createHarness();
  const pending = harness.run(fixtureOptions());
  await new Promise(resolve => setImmediate(resolve));
  harness.child.emit('close', 1, null);

  await assert.rejects(
    pending,
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
});

test('termination uses only the retained finalizer handle and never a reusable numeric pid', async () => {
  assert.equal(typeof clientModule?.createForgeRuntimeFinalizerWorkerClient, 'function');
  const child = new FakeChild(5252);
  const originalKill = child.kill.bind(child);
  child.kill = signal => {
    const result = originalKill(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return result;
  };
  let pidTerminationCalls = 0;
  const run = clientModule.createForgeRuntimeFinalizerWorkerClient({
    forkImpl: () => child,
    execFileImpl() {
      pidTerminationCalls += 1;
      throw new Error('numeric pid termination must not be used');
    },
    processKillImpl() {
      pidTerminationCalls += 1;
      throw new Error('numeric process-group termination must not be used');
    },
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'forge-runtime-finalizer-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });

  await assert.rejects(
    run(fixtureOptions({ timeoutMs: 5, terminationGraceMs: 100 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true
  );
  assert.equal(pidTerminationCalls, 0);
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});
