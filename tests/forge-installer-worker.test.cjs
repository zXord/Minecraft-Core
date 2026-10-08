const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  FORGE_WORKER_TOKEN_ENV,
  createForgeInstallRequest,
  verifyForgeInstallResponse
} = require('../electron/services/forge-installer-worker-protocol.cjs');

let workerModule = null;
try {
  workerModule = require('../electron/services/forge-installer-worker.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions below without the module.
}

const token = 'e'.repeat(64);
const requestId = 'f'.repeat(32);
const payload = Object.freeze({
  targetPath: path.resolve('worker-runtime-fixture', 'server'),
  minecraftVersion: '1.12.2',
  loaderVersion: '14.23.5.2860',
  javaPath: path.resolve('worker-runtime-fixture', 'java', 'bin', 'java.exe')
});

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.env = { [FORGE_WORKER_TOKEN_ENV]: token };
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

function request(overrides = {}) {
  return createForgeInstallRequest({
    token,
    requestId,
    payload: { ...payload, ...overrides }
  });
}

async function flushWorker() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('the one-shot worker deletes its auth secret before preserving the full legacy installForge call', async () => {
  assert.equal(typeof workerModule?.startForgeInstallerWorker, 'function');
  const processRef = new FakeProcess();
  const calls = [];
  workerModule.startForgeInstallerWorker({
    processRef,
    requestTimeoutMs: 1000,
    installForgeImpl: async (...args) => {
      assert.equal(Object.hasOwn(processRef.env, FORGE_WORKER_TOKEN_ENV), false);
      calls.push(args);
      return '1.12.2-forge-14.23.5.2860';
    }
  });
  assert.equal(Object.hasOwn(processRef.env, FORGE_WORKER_TOKEN_ENV), false);
  processRef.emit('message', request());
  await flushWorker();

  assert.deepEqual(calls, [[
    { version: '14.23.5.2860', mcversion: '1.12.2' },
    payload.targetPath,
    { side: 'server', java: payload.javaPath }
  ]]);
  assert.deepEqual(verifyForgeInstallResponse(processRef.responses[0], token, requestId), { ok: true });
  assert.deepEqual(processRef.exitCodes, [0]);
});

test('the worker accepts at most one authenticated request', async () => {
  assert.equal(typeof workerModule?.startForgeInstallerWorker, 'function');
  const processRef = new FakeProcess();
  let resolveInstall;
  const installGate = new Promise(resolve => { resolveInstall = resolve; });
  let calls = 0;
  workerModule.startForgeInstallerWorker({
    processRef,
    requestTimeoutMs: 1000,
    installForgeImpl: async () => {
      calls += 1;
      await installGate;
    }
  });
  processRef.emit('message', request());
  await new Promise(resolve => setImmediate(resolve));
  processRef.emit('message', request());
  await new Promise(resolve => setImmediate(resolve));
  resolveInstall();
  await flushWorker();

  assert.equal(calls, 1);
  assert.deepEqual(processRef.responses, []);
  assert.deepEqual(processRef.exitCodes, [64]);
});

test('worker dependency failures return only an authenticated bounded stage', async () => {
  assert.equal(typeof workerModule?.startForgeInstallerWorker, 'function');
  const processRef = new FakeProcess();
  workerModule.startForgeInstallerWorker({
    processRef,
    requestTimeoutMs: 1000,
    installForgeImpl: async () => {
      throw new Error(`private failure at ${payload.targetPath} using ${token}`);
    }
  });
  processRef.emit('message', request());
  await flushWorker();

  assert.deepEqual(verifyForgeInstallResponse(processRef.responses[0], token, requestId), { ok: false, runtimeDiagnostic: { stage: 'forge-installer', reason: 'unknown' } });
  const serialized = JSON.stringify(processRef.responses[0]);
  assert.equal(serialized.includes(payload.targetPath), false);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('private failure'), false);
  assert.deepEqual(processRef.exitCodes, [1]);
});

test('an unauthenticated request exits without invoking the installer or returning data', async () => {
  assert.equal(typeof workerModule?.startForgeInstallerWorker, 'function');
  const processRef = new FakeProcess();
  let called = false;
  workerModule.startForgeInstallerWorker({
    processRef,
    requestTimeoutMs: 1000,
    installForgeImpl: async () => { called = true; }
  });
  processRef.emit('message', { ...request(), auth: '0'.repeat(64) });
  await flushWorker();

  assert.equal(called, false);
  assert.deepEqual(processRef.responses, []);
  assert.deepEqual(processRef.exitCodes, [64]);
});

test('IPC disconnect keeps the worker alive until its owned installer operation settles', async () => {
  assert.equal(typeof workerModule?.startForgeInstallerWorker, 'function');
  const processRef = new FakeProcess();
  let releaseInstall;
  const installGate = new Promise(resolve => { releaseInstall = resolve; });
  workerModule.startForgeInstallerWorker({
    processRef,
    requestTimeoutMs: 1000,
    installForgeImpl: async () => installGate
  });
  processRef.emit('message', request());
  await new Promise(resolve => setImmediate(resolve));

  processRef.disconnect();
  await flushWorker();
  assert.deepEqual(processRef.exitCodes, []);
  assert.deepEqual(processRef.responses, []);

  releaseInstall('installed');
  await flushWorker();
  assert.deepEqual(processRef.exitCodes, [65]);
  assert.deepEqual(processRef.responses, []);
});

test('disconnect cancels Forge and waits for each exact Java child close before exiting', async () => {
  const processRef = new FakeProcess();
  const child = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; return true; };
  let rejectInstall;
  const installGate = new Promise((_resolve, reject) => { rejectInstall = reject; });
  let started = false;
  workerModule.startForgeInstallerWorker({
    processRef,
    installForgeImpl: async () => {}, // Keeps the pre-fix run offline.
    spawnImpl: () => child,
    installForgeTaskImpl: (_version, _target, options) => ({
      startAndWait() {
        started = true;
        options.spawn(payload.javaPath, []);
        return installGate;
      },
      async cancel() { rejectInstall(new Error('cancelled')); }
    })
  });
  processRef.emit('message', request());
  await flushWorker();
  assert.equal(started, true);
  processRef.disconnect();
  await flushWorker();
  assert.equal(killed, true);
  assert.deepEqual(processRef.exitCodes, [], 'task cancellation is not evidence of child close');
  child.emit('exit', null, 'SIGKILL');
  await flushWorker();
  assert.deepEqual(processRef.exitCodes, [], 'exit is not close');
  child.emit('close', null, 'SIGKILL');
  await flushWorker();
  assert.deepEqual(processRef.exitCodes, [65]);
});
