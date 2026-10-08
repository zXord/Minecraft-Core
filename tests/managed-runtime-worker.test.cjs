const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  MANAGED_RUNTIME_PREPARE_OPERATION,
  MANAGED_RUNTIME_VERIFY_OPERATION,
  MANAGED_RUNTIME_WORKER_TOKEN_ENV,
  createManagedRuntimeRequest,
  verifyManagedRuntimeResponse
} = require('../electron/services/managed-runtime-worker-protocol.cjs');

let workerModule = null;
try {
  workerModule = require('../electron/services/managed-runtime-worker.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions below without the module.
}

const token = '5'.repeat(64);
const requestId = '6'.repeat(32);
const runtime = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.env = { [MANAGED_RUNTIME_WORKER_TOKEN_ENV]: token };
    this.connected = true;
    this.responses = [];
    this.exitCodes = [];
  }

  send(message, callback) {
    this.responses.push(message);
    queueMicrotask(() => callback?.(null));
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

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-managed-runtime-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'server');
  const javaPath = path.join(root, 'java', 'bin', 'java.exe');
  fs.mkdirSync(targetPath, { recursive: true });
  fs.mkdirSync(path.dirname(javaPath), { recursive: true });
  fs.writeFileSync(javaPath, 'java fixture');
  return {
    targetPath: fs.realpathSync.native(targetPath),
    javaPath: fs.realpathSync.native(javaPath)
  };
}

function createRequest(operation, fixture, overrides = {}) {
  return createManagedRuntimeRequest({
    token,
    requestId,
    operation,
    payload: operation === MANAGED_RUNTIME_PREPARE_OPERATION
      ? { targetPath: fixture.targetPath, runtime, javaPath: fixture.javaPath, ...overrides }
      : { targetPath: fixture.targetPath, runtime, ...overrides }
  });
}

function validation() {
  return {
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
  };
}

async function flushWorker() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function createFakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutImpl() {}
  };
}

test('runtime preparation keeps the full one-hour lifecycle watchdog instead of a hidden 30-second cutoff', () => {
  assert.equal(typeof workerModule?.startManagedRuntimeWorker, 'function');
  const processRef = new FakeProcess();
  const timers = createFakeTimers();
  workerModule.startManagedRuntimeWorker({ processRef, ...timers });

  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 60 * 60 * 1000);
  assert.deepEqual(processRef.exitCodes, []);
  timers.scheduled[0].callback();
  assert.deepEqual(processRef.exitCodes, [64]);
});

test('one-shot preparation deletes the secret and invokes only the production in-process seam', async t => {
  assert.equal(typeof workerModule?.startManagedRuntimeWorker, 'function');
  const fixture = createFixture(t);
  const processRef = new FakeProcess();
  const calls = [];
  workerModule.startManagedRuntimeWorker({
    processRef,
    requestTimeoutMs: 1000,
    prepareRuntimeImpl: async options => {
      assert.equal(Object.hasOwn(processRef.env, MANAGED_RUNTIME_WORKER_TOKEN_ENV), false);
      assert.equal(options.signal?.aborted, false);
      calls.push(options);
      return validation();
    }
  });
  assert.equal(Object.hasOwn(processRef.env, MANAGED_RUNTIME_WORKER_TOKEN_ENV), false);
  processRef.emit('message', createRequest(MANAGED_RUNTIME_PREPARE_OPERATION, fixture));
  await flushWorker();

  assert.deepEqual(calls, [{
    targetPath: fixture.targetPath,
    runtime,
    javaPath: fixture.javaPath,
    skipMutationMark: true,
    signal: calls[0].signal
  }]);
  assert.deepEqual(verifyManagedRuntimeResponse(
    processRef.responses[0],
    token,
    requestId,
    MANAGED_RUNTIME_PREPARE_OPERATION,
    runtime
  ), { ok: true, code: null, result: { valid: true, runtime } });
  assert.deepEqual(processRef.exitCodes, [0]);
});

test('verify-only dispatch reuses the boundary and returns bounded validation evidence', async t => {
  assert.equal(typeof workerModule?.startManagedRuntimeWorker, 'function');
  const fixture = createFixture(t);
  const processRef = new FakeProcess();
  const calls = [];
  workerModule.startManagedRuntimeWorker({
    processRef,
    requestTimeoutMs: 1000,
    verifyRuntimeImpl: (...args) => {
      calls.push(args);
      return validation();
    }
  });
  processRef.emit('message', createRequest(MANAGED_RUNTIME_VERIFY_OPERATION, fixture));
  await flushWorker();

  assert.deepEqual(calls, [[fixture.targetPath, runtime]]);
  assert.deepEqual(verifyManagedRuntimeResponse(
    processRef.responses[0],
    token,
    requestId,
    MANAGED_RUNTIME_VERIFY_OPERATION,
    runtime
  ), { ok: true, code: null, result: validation() });
  assert.deepEqual(processRef.exitCodes, [0]);
});

test('filesystem preflight rejects a missing Java executable before calling preparation', async t => {
  assert.equal(typeof workerModule?.startManagedRuntimeWorker, 'function');
  const fixture = createFixture(t);
  fixture.javaPath = path.join(path.dirname(fixture.javaPath), 'missing-java.exe');
  const processRef = new FakeProcess();
  let called = false;
  workerModule.startManagedRuntimeWorker({
    processRef,
    requestTimeoutMs: 1000,
    prepareRuntimeImpl: async () => {
      called = true;
      return validation();
    }
  });
  processRef.emit('message', createRequest(MANAGED_RUNTIME_PREPARE_OPERATION, fixture));
  await flushWorker();

  assert.equal(called, false);
  assert.deepEqual(verifyManagedRuntimeResponse(
    processRef.responses[0],
    token,
    requestId,
    MANAGED_RUNTIME_PREPARE_OPERATION,
    runtime
  ), { ok: false, code: 'RUNTIME_INCOMPLETE', result: null,
    runtimeDiagnostic: { stage: 'managed-java', reason: 'io', osCode: 'ENOENT' } });
  assert.deepEqual(processRef.exitCodes, [1]);
});

test('the worker accepts at most one authenticated request', async t => {
  assert.equal(typeof workerModule?.startManagedRuntimeWorker, 'function');
  const fixture = createFixture(t);
  const processRef = new FakeProcess();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  workerModule.startManagedRuntimeWorker({
    processRef,
    requestTimeoutMs: 1000,
    async prepareRuntimeImpl() {
      calls += 1;
      await gate;
      return validation();
    }
  });
  const request = createRequest(MANAGED_RUNTIME_PREPARE_OPERATION, fixture);
  processRef.emit('message', request);
  await new Promise(resolve => setImmediate(resolve));
  processRef.emit('message', request);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await flushWorker();

  assert.equal(calls, 1);
  assert.deepEqual(processRef.responses, []);
  assert.deepEqual(processRef.exitCodes, [64]);
});

test('dependency failures return only an authenticated code and bounded stage with no raw details', async t => {
  assert.equal(typeof workerModule?.startManagedRuntimeWorker, 'function');
  const fixture = createFixture(t);
  const processRef = new FakeProcess();
  workerModule.startManagedRuntimeWorker({
    processRef,
    requestTimeoutMs: 1000,
    prepareRuntimeImpl: async () => {
      const error = new Error(`private failure at ${fixture.targetPath} using ${token}`);
      error.code = 'LOADER_VERSION_UNAVAILABLE';
      throw error;
    }
  });
  processRef.emit('message', createRequest(MANAGED_RUNTIME_PREPARE_OPERATION, fixture));
  await flushWorker();

  assert.deepEqual(verifyManagedRuntimeResponse(
    processRef.responses[0],
    token,
    requestId,
    MANAGED_RUNTIME_PREPARE_OPERATION,
    runtime
  ), { ok: false, code: 'LOADER_VERSION_UNAVAILABLE', result: null,
    runtimeDiagnostic: { stage: 'managed-prepare', reason: 'unknown' } });
  const serialized = JSON.stringify(processRef.responses[0]);
  assert.equal(serialized.includes(fixture.targetPath), false);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('private failure'), false);
  assert.deepEqual(processRef.exitCodes, [1]);
});

test('unauthenticated requests exit without invoking dependencies or returning data', async t => {
  assert.equal(typeof workerModule?.startManagedRuntimeWorker, 'function');
  const fixture = createFixture(t);
  const processRef = new FakeProcess();
  let called = false;
  workerModule.startManagedRuntimeWorker({
    processRef,
    requestTimeoutMs: 1000,
    prepareRuntimeImpl: async () => {
      called = true;
      return validation();
    }
  });
  processRef.emit('message', {
    ...createRequest(MANAGED_RUNTIME_PREPARE_OPERATION, fixture),
    auth: '0'.repeat(64)
  });
  await flushWorker();

  assert.equal(called, false);
  assert.deepEqual(processRef.responses, []);
  assert.deepEqual(processRef.exitCodes, [64]);
});

test('IPC disconnect keeps the worker alive until its owned runtime operation settles', async t => {
  assert.equal(typeof workerModule?.startManagedRuntimeWorker, 'function');
  const fixture = createFixture(t);
  const processRef = new FakeProcess();
  let releasePreparation;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  workerModule.startManagedRuntimeWorker({
    processRef,
    requestTimeoutMs: 1000,
    prepareRuntimeImpl: async () => preparationGate
  });
  processRef.emit('message', createRequest(MANAGED_RUNTIME_PREPARE_OPERATION, fixture));
  await new Promise(resolve => setImmediate(resolve));

  processRef.disconnect();
  await flushWorker();
  assert.deepEqual(processRef.exitCodes, []);
  assert.deepEqual(processRef.responses, []);

  releasePreparation(validation());
  await flushWorker();
  assert.deepEqual(processRef.exitCodes, [65]);
  assert.deepEqual(processRef.responses, []);
});

test('IPC disconnect aborts managed runtime preparation before awaiting its shutdown', async t => {
  const fixture = createFixture(t);
  const processRef = new FakeProcess();
  let preparationSignal;
  let releasePreparation;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  workerModule.startManagedRuntimeWorker({
    processRef,
    prepareRuntimeImpl: async ({ signal }) => {
      preparationSignal = signal;
      await preparationGate;
      return validation();
    }
  });
  processRef.emit('message', createRequest(MANAGED_RUNTIME_PREPARE_OPERATION, fixture));
  await flushWorker();
  processRef.disconnect();
  assert.equal(preparationSignal?.aborted, true);
  assert.deepEqual(processRef.exitCodes, []);
  releasePreparation();
  await flushWorker();
  assert.deepEqual(processRef.exitCodes, [65]);
});

test('managed worker does not exit while failed nested runtime work still owns its files', async t => {
  const { retainRuntimeWorkerQuiescence } = require('../electron/services/runtime-worker-quiescence.cjs');
  const fixture = createFixture(t);
  const processRef = new FakeProcess();
  let closeNested;
  const closed = new Promise(resolve => { closeNested = resolve; });
  workerModule.startManagedRuntimeWorker({
    processRef,
    prepareRuntimeImpl: async () => {
      throw retainRuntimeWorkerQuiescence(new Error('cancelled nested installer'), closed);
    }
  });
  processRef.emit('message', createRequest(MANAGED_RUNTIME_PREPARE_OPERATION, fixture));
  await flushWorker();
  processRef.disconnect();
  await flushWorker();
  assert.deepEqual(processRef.exitCodes, []);
  closeNested(true);
  await flushWorker();
  assert.deepEqual(processRef.exitCodes, [65]);
});
