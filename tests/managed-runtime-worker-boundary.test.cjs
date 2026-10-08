const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const AdmZip = require('adm-zip');
const {
  MANAGED_RUNTIME_PREPARE_OPERATION
} = require('../electron/services/managed-runtime-worker-protocol.cjs');
const {
  createManagedRuntimeWorkerClient
} = require('../electron/services/managed-runtime-worker-client.cjs');

const runtime = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});

function writeMinimalJar(filePath, marker = 'fixture') {
  const archive = new AdmZip();
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n\n', 'utf8'));
  archive.addFile('marker.txt', Buffer.from(marker, 'utf8'));
  archive.writeZip(filePath);
}

async function withManagedWorkerMock(runManagedRuntimeWorker, work) {
  const servicePath = require.resolve('../electron/services/loader-install-service.cjs');
  const originalLoad = Module._load;
  Module._load = function managedRuntimeBoundaryLoad(request, parent, isMain) {
    if (request === './managed-runtime-worker-client.cjs' && parent?.filename === servicePath) {
      return { runManagedRuntimeWorker };
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

test('production-default managed runtime preparation delegates one exact child request', async () => {
  const calls = [];
  const targetPath = path.resolve('managed-runtime-boundary', 'server');
  const javaPath = path.resolve('managed-runtime-boundary', 'java', 'bin', 'java.exe');
  const signal = new AbortController().signal;
  const expected = { valid: true, runtime };

  await withManagedWorkerMock(async request => {
    calls.push(request);
    return expected;
  }, async service => {
    assert.deepEqual(await service.prepareManagedServerRuntime({
      targetPath,
      runtime,
      javaPath,
      skipMutationMark: true,
      signal,
      timeoutMs: 12345,
      terminationGraceMs: 321
    }), expected);
  });

  assert.deepEqual(calls, [{
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    targetPath,
    runtime,
    javaPath,
    signal,
    timeoutMs: 12345,
    terminationGraceMs: 321
  }]);
});

test('injected unit-test seams remain in process and never reach the child client', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-managed-runtime-in-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMinimalJar(path.join(root, 'server.jar'), 'server');
  const javaPath = path.join(root, 'java', 'bin', 'java.exe');
  const workerCalls = [];
  const installerCalls = [];

  await withManagedWorkerMock(async request => {
    workerCalls.push(request);
    throw new Error('injected preparation must not spawn the worker');
  }, async service => {
    const result = await service.prepareManagedServerRuntime({
      targetPath: root,
      runtime,
      javaPath,
      validateJava: async () => 17,
      installServerLoaderImpl: async options => {
        installerCalls.push(options);
        writeMinimalJar(path.join(root, 'fabric-server-launch.jar'), 'fabric');
      }
    });
    assert.equal(result.valid, true);
  });

  assert.equal(workerCalls.length, 0);
  assert.equal(installerCalls.length, 1);
  assert.equal(installerCalls[0].targetPath, root);
});

test('main-process timers progress while a real managed-runtime child is synchronously busy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-managed-runtime-liveness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'server');
  const javaPath = path.join(root, 'java', 'bin', 'java.exe');
  fs.mkdirSync(targetPath);
  fs.mkdirSync(path.dirname(javaPath), { recursive: true });
  fs.writeFileSync(javaPath, 'java fixture');
  const startedPath = path.join(targetPath, '.managed-runtime-started');
  const runManagedRuntime = createManagedRuntimeWorkerClient({
    workerPath: path.join(__dirname, 'fixtures', 'slow-managed-runtime-worker.cjs')
  });
  let settled = false;
  const pending = runManagedRuntime({
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    targetPath: fs.realpathSync.native(targetPath),
    runtime,
    javaPath: fs.realpathSync.native(javaPath),
    timeoutMs: 5000
  }).finally(() => { settled = true; });
  const startedDeadline = Date.now() + 3000;
  while (!fs.existsSync(startedPath) && Date.now() < startedDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(startedPath), true, 'the managed-runtime child did not start');

  const timerStartedAt = Date.now();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false);
  assert.ok(Date.now() - timerStartedAt < 500, 'the parent event loop was blocked by runtime preparation');
  assert.deepEqual(await pending, { valid: true, runtime });
});
