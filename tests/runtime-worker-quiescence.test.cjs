const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { waitForRuntimeWorkerQuiescence } = require('../electron/services/runtime-worker-quiescence.cjs');

const runtime = {
  minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13',
  javaMajor: 17, os: 'win32', architecture: 'x64'
};

for (const kind of ['forge-finalizer', 'java-extraction', 'bounded-java-process']) {
  test(`${kind} retains cleanup authority until exact close after bounded cancellation`, async t => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.send = (_message, callback) => callback?.(null);
    child.kill = () => true;
    const controller = new AbortController();
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const root = path.resolve('runtime-quiescence-fixture');
    const dependencies = { forkImpl: () => child, removeImpl: async () => {} };
    let operation;
    if (kind === 'forge-finalizer') {
      const { createForgeRuntimeFinalizerWorkerClient } = require('../electron/services/forge-runtime-finalizer-worker-client.cjs');
      operation = createForgeRuntimeFinalizerWorkerClient(dependencies)({
        targetPath: root, runtime, signal: controller.signal, terminationGraceMs: 5
      });
    } else if (kind === 'java-extraction') {
      const { createJavaArchiveWorkerClient } = require('../electron/services/java-archive-worker-client.cjs');
      operation = createJavaArchiveWorkerClient(dependencies)({
        rootPath: root, archivePath: path.join(root, 'temp', 'runtime.zip'), destinationPath: path.join(root, 'java-17'),
        maxArchiveBytes: 100, expectedArchiveSize: 5, expectedSha256: '1'.repeat(64),
        signal: controller.signal, terminationGraceMs: 5
      });
    } else {
      const { runBoundedProcess } = require('../electron/services/loader-install-service.cjs').__testUtils;
      operation = runBoundedProcess({
        command: path.join(root, 'java.exe'), args: ['-version'], cwd: root,
        signal: controller.signal, terminationGraceMs: 5, spawnImpl: () => child
      });
    }
    const failure = operation.catch(error => error);
    controller.abort();
    const error = await failure;
    assert.equal(error.preserveWorkspace, true);
    let outcome = null;
    const safeToClean = waitForRuntimeWorkerQuiescence(error).then(
      () => { outcome = 'closed'; }, () => { outcome = 'unproven'; }
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outcome, null);
    child.emit('exit', null, 'SIGKILL');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outcome, null);
    child.emit('close', null, 'SIGKILL');
    await safeToClean;
    assert.equal(outcome, 'closed');
  });
}

test('an unobservable managed worker reports unproven shutdown instead of waiting on nonexistent evidence', async () => {
  const { createManagedRuntimeWorkerClient } = require('../electron/services/managed-runtime-worker-client.cjs');
  const child = { kill() {} };
  const root = path.resolve('runtime-quiescence-fixture');
  const error = await createManagedRuntimeWorkerClient({ forkImpl: () => child })({
    operation: 'prepare-managed-server-runtime', targetPath: root, runtime,
    javaPath: path.join(root, 'java.exe')
  }).catch(failure => failure);
  let outcome = null;
  const checked = waitForRuntimeWorkerQuiescence(error).then(
    () => { outcome = 'closed'; }, () => { outcome = 'unproven'; }
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(outcome, 'unproven');
  await checked;
});

test('an unexpectedly killed managed worker does not prove descendant quiescence', async () => {
  const { createManagedRuntimeWorkerClient } = require('../electron/services/managed-runtime-worker-client.cjs');
  const child = new EventEmitter();
  child.send = (_message, callback) => callback?.(null);
  child.disconnect = () => {};
  child.kill = () => true;
  const root = path.resolve('runtime-quiescence-fixture');
  const pending = createManagedRuntimeWorkerClient({ forkImpl: () => child })({
    operation: 'prepare-managed-server-runtime', targetPath: root, runtime,
    javaPath: path.join(root, 'java.exe')
  }).catch(error => error);
  child.emit('close', null, 'SIGKILL');
  const error = await pending;
  await assert.rejects(waitForRuntimeWorkerQuiescence(error), failure => failure.code === 'RECOVERY_REQUIRED');
});
