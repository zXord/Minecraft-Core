const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const {
  createForgeRuntimeFinalizerWorkerClient
} = require('../electron/services/forge-runtime-finalizer-worker-client.cjs');

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

async function withFinalizerClient(runForgeRuntimeFinalizerWorker, work) {
  const servicePath = require.resolve('../electron/services/loader-install-service.cjs');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './forge-runtime-finalizer-worker-client.cjs' && parent?.filename === servicePath) {
      return { runForgeRuntimeFinalizerWorker };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[servicePath];
  try {
    return await work(require(servicePath));
  } finally {
    delete require.cache[servicePath];
    Module._load = originalLoad;
  }
}

test('Forge finalizer boundary forwards the exact target, tuple, signal, and independent timeout', async () => {
  const calls = [];
  await withFinalizerClient(async request => {
    calls.push(request);
    return validation;
  }, async service => {
    assert.equal(typeof service.__testUtils.runForgeRuntimeFinalizerWorkerBoundary, 'function');
    const signal = new AbortController().signal;
    const targetPath = path.resolve('forge-finalizer-boundary', 'server');
    const result = await service.__testUtils.runForgeRuntimeFinalizerWorkerBoundary({
      targetPath,
      runtime,
      signal,
      installTimeoutMs: 111,
      finalizationTimeoutMs: 222
    });

    assert.deepEqual(result, validation);
    assert.deepEqual(calls, [{ targetPath, runtime, signal, timeoutMs: 222 }]);
  });
});

test('managed Forge preparation returns worker validation without main-thread publication or revalidation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-finalizer-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const finalizerCalls = [];
  const installCalls = [];
  const signal = new AbortController().signal;

  await withFinalizerClient(async request => {
    finalizerCalls.push(request);
    return validation;
  }, async service => {
    const result = await service.prepareManagedServerRuntime({
      targetPath: root,
      runtime,
      javaPath: path.join(root, 'java', 'bin', 'java.exe'),
      validateJava: async () => 8,
      installServerLoaderImpl: async request => { installCalls.push(request); },
      signal,
      finalizationTimeoutMs: 333
    });

    assert.deepEqual(result, validation);
  });

  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0].targetPath, root);
  assert.equal(installCalls[0].loader, 'forge');
  assert.deepEqual(finalizerCalls, [{ targetPath: root, runtime, signal, timeoutMs: 333 }]);
  assert.equal(fs.existsSync(path.join(root, '.minecraft-core-state', 'runtime.json')), false);
});

test('main-process timers progress while a real finalizer child is synchronously busy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-finalizer-liveness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const startedPath = path.join(root, '.finalizer-started');
  const runFinalizer = createForgeRuntimeFinalizerWorkerClient({
    workerPath: path.join(__dirname, 'fixtures', 'slow-forge-runtime-finalizer-worker.cjs')
  });
  let settled = false;
  const pending = runFinalizer({ targetPath: root, runtime, timeoutMs: 5000 })
    .finally(() => { settled = true; });
  const startedDeadline = Date.now() + 3000;
  while (!fs.existsSync(startedPath) && Date.now() < startedDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(startedPath), true, 'the child finalizer did not start');

  const timerStartedAt = Date.now();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false);
  assert.ok(Date.now() - timerStartedAt < 500, 'the parent event loop was blocked by finalization');
  assert.deepEqual(await pending, {
    valid: true,
    runtime,
    loader: { family: 'forge', argsFile: 'libraries/net/minecraftforge/forge/1.12.2-14.23.5.2860/win_args.txt' },
    artifacts: [
      {
        relativePath: '.finalizer-started',
        size: 7,
        sha256: 'a'.repeat(64),
        sha512: 'b'.repeat(128)
      },
      {
        relativePath: 'libraries/net/minecraftforge/forge/1.12.2-14.23.5.2860/win_args.txt',
        size: 5,
        sha256: 'c'.repeat(64),
        sha512: 'd'.repeat(128)
      }
    ]
  });
});
