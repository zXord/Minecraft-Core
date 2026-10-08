const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  FORGE_FINALIZER_TOKEN_ENV,
  createForgeFinalizerRequest,
  verifyForgeFinalizerResponse
} = require('../electron/services/forge-runtime-finalizer-worker-protocol.cjs');

let workerModule = null;
try {
  workerModule = require('../electron/services/forge-runtime-finalizer-worker.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions below without the module.
}

const token = '5'.repeat(64);
const requestId = '6'.repeat(32);
const targetPath = path.resolve('forge-finalizer-worker', 'server');
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

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.env = { [FORGE_FINALIZER_TOKEN_ENV]: token };
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

function request() {
  return createForgeFinalizerRequest({ token, requestId, payload: { targetPath, runtime } });
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

test('Forge finalization keeps the full fifteen-minute lifecycle watchdog instead of a hidden 30-second cutoff', () => {
  assert.equal(typeof workerModule?.startForgeRuntimeFinalizerWorker, 'function');
  const processRef = new FakeProcess();
  const timers = createFakeTimers();
  workerModule.startForgeRuntimeFinalizerWorker({ processRef, ...timers });

  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 15 * 60 * 1000);
  assert.deepEqual(processRef.exitCodes, []);
  timers.scheduled[0].callback();
  assert.deepEqual(processRef.exitCodes, [64]);
});

test('one-shot finalizer deletes its auth secret and returns only authenticated validation', async () => {
  assert.equal(typeof workerModule?.startForgeRuntimeFinalizerWorker, 'function');
  const processRef = new FakeProcess();
  const calls = [];
  workerModule.startForgeRuntimeFinalizerWorker({
    processRef,
    requestTimeoutMs: 1000,
    finalizeForgeRuntimeImpl(...args) {
      assert.equal(Object.hasOwn(processRef.env, FORGE_FINALIZER_TOKEN_ENV), false);
      calls.push(args);
      return validation;
    }
  });
  processRef.emit('message', request());
  await flushWorker();

  assert.deepEqual(calls, [[targetPath, runtime]]);
  assert.deepEqual(
    verifyForgeFinalizerResponse(processRef.responses[0], token, requestId, runtime),
    { ok: true, validation }
  );
  assert.deepEqual(processRef.exitCodes, [0]);
});

test('finalizer accepts at most one authenticated request', async () => {
  assert.equal(typeof workerModule?.startForgeRuntimeFinalizerWorker, 'function');
  const processRef = new FakeProcess();
  let resolveFinalizer;
  const gate = new Promise(resolve => { resolveFinalizer = resolve; });
  let calls = 0;
  workerModule.startForgeRuntimeFinalizerWorker({
    processRef,
    requestTimeoutMs: 1000,
    async finalizeForgeRuntimeImpl() {
      calls += 1;
      await gate;
      return validation;
    }
  });
  processRef.emit('message', request());
  await new Promise(resolve => setImmediate(resolve));
  processRef.emit('message', request());
  await new Promise(resolve => setImmediate(resolve));
  resolveFinalizer();
  await flushWorker();

  assert.equal(calls, 1);
  assert.deepEqual(processRef.responses, []);
  assert.deepEqual(processRef.exitCodes, [64]);
});

test('finalizer failures return only a bounded stage with no raw child or path data', async () => {
  assert.equal(typeof workerModule?.startForgeRuntimeFinalizerWorker, 'function');
  const processRef = new FakeProcess();
  workerModule.startForgeRuntimeFinalizerWorker({
    processRef,
    requestTimeoutMs: 1000,
    finalizeForgeRuntimeImpl() {
      throw new Error(`private failure at ${targetPath} using ${token}`);
    }
  });
  processRef.emit('message', request());
  await flushWorker();

  assert.deepEqual(
    verifyForgeFinalizerResponse(processRef.responses[0], token, requestId, runtime),
    { ok: false, validation: null, runtimeDiagnostic: { stage: 'finalizer-layout', reason: 'unknown' } }
  );
  const serialized = JSON.stringify(processRef.responses[0]);
  assert.equal(serialized.includes(targetPath), false);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('private failure'), false);
  assert.deepEqual(processRef.exitCodes, [1]);
});

test('unauthenticated finalizer requests exit without running or returning data', async () => {
  assert.equal(typeof workerModule?.startForgeRuntimeFinalizerWorker, 'function');
  const processRef = new FakeProcess();
  let called = false;
  workerModule.startForgeRuntimeFinalizerWorker({
    processRef,
    requestTimeoutMs: 1000,
    finalizeForgeRuntimeImpl() { called = true; }
  });
  processRef.emit('message', { ...request(), auth: '0'.repeat(64) });
  await flushWorker();

  assert.equal(called, false);
  assert.deepEqual(processRef.responses, []);
  assert.deepEqual(processRef.exitCodes, [64]);
});
