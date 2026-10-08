'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { waitForRuntimeWorkerQuiescence } = require('../electron/services/runtime-worker-quiescence.cjs');
const managed = require('../electron/services/managed-runtime-worker-protocol.cjs');
const forge = require('../electron/services/forge-installer-worker-protocol.cjs');
const { createManagedRuntimeWorkerClient } = require('../electron/services/managed-runtime-worker-client.cjs');
const { createForgeInstallerWorkerClient } = require('../electron/services/forge-installer-worker-client.cjs');

const token = 'a'.repeat(64);
const requestId = 'b'.repeat(32);
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13',
  javaMajor: 17, os: 'win32', architecture: 'x64' };
const targetPath = path.join(os.tmpdir(), 'runtime-close-protocol-only-not-created');
const variants = [
  { name: 'managed', factory: createManagedRuntimeWorkerClient,
    options: { operation: managed.MANAGED_RUNTIME_VERIFY_OPERATION, targetPath, runtime },
    failure: () => managed.createManagedRuntimeResponse({ token, requestId,
      operation: managed.MANAGED_RUNTIME_VERIFY_OPERATION, ok: false, code: 'RUNTIME_INCOMPLETE' }) },
  { name: 'forge', factory: createForgeInstallerWorkerClient,
    options: { targetPath, minecraftVersion: '1.20.1', loaderVersion: '47.4.13', javaPath: path.join(targetPath, 'java.exe') },
    failure: () => forge.createForgeInstallResponse({ token, requestId, ok: false }) }
];

function doubled(variant) {
  const child = new EventEmitter();
  let disconnects = 0;
  let kills = 0;
  child.send = (_request, callback) => callback?.(null);
  child.disconnect = () => { disconnects += 1; };
  child.kill = () => { kills += 1; return true; };
  const run = variant.factory({ forkImpl: () => child, tokenFactory: () => token, requestIdFactory: () => requestId });
  return { child, run, disconnects: () => disconnects, kills: () => kills };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const variant of variants) {
  test(`${variant.name}: authenticated failure waits for self-close without parent disconnect or kill`, async t => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const harness = doubled(variant);
    let outcome;
    const pending = harness.run({ ...variant.options, terminationGraceMs: 100 }).catch(error => { outcome = error; return error; });
    harness.child.emit('message', variant.failure());
    await tick();
    assert.equal(harness.disconnects(), 0);
    assert.equal(harness.kills(), 0);
    assert.equal(outcome, undefined);
    harness.child.emit('exit', 1, null);
    await tick();
    assert.equal(outcome, undefined, 'exit is not exact close');
    harness.child.emit('close', 1, null);
    const error = await pending;
    assert.equal(error.code, 'RUNTIME_INCOMPLETE');
    assert.equal(error.preserveWorkspace, true);
    await waitForRuntimeWorkerQuiescence(error);
  });

  test(`${variant.name}: response grace bounds rejection but retains proof until late exact close`, async t => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const harness = doubled(variant);
    const pending = harness.run({ ...variant.options, terminationGraceMs: 10 }).catch(error => error);
    harness.child.emit('message', variant.failure());
    const error = await pending;
    assert.equal(error.code, 'RUNTIME_INCOMPLETE');
    assert.equal(harness.disconnects(), 0);
    assert.equal(harness.kills(), 0);
    let settled = false;
    const proof = waitForRuntimeWorkerQuiescence(error).then(() => { settled = true; });
    harness.child.emit('exit', 1, null);
    await tick();
    assert.equal(settled, false);
    harness.child.emit('close', 1, null);
    await proof;
    assert.equal(settled, true);
  });

  test(`${variant.name}: late crash after authenticated failure does not prove descendant settlement`, async t => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const harness = doubled(variant);
    const pending = harness.run({ ...variant.options, terminationGraceMs: 10 }).catch(error => error);
    harness.child.emit('message', variant.failure());
    const error = await pending;
    harness.child.emit('close', null, 'SIGKILL');
    await assert.rejects(waitForRuntimeWorkerQuiescence(error), failure => failure.code === 'RECOVERY_REQUIRED');
  });
}

for (const firstCause of ['abort', 'deadline', 'protocol']) {
  test(`forge: ${firstCause} before authenticated failure preserves first cause and grace timer`, async t => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const schedules = t.mock.method(global, 'setTimeout');
    const harness = doubled(variants[1]);
    const controller = new AbortController();
    let requestedDisconnect;
    const disconnected = new Promise(resolve => { requestedDisconnect = resolve; });
    const disconnect = harness.child.disconnect;
    harness.child.disconnect = () => { disconnect(); requestedDisconnect(); };
    const pending = harness.run({ ...variants[1].options, signal: controller.signal,
      timeoutMs: firstCause === 'deadline' ? 5 : 1000, terminationGraceMs: 100 }).catch(error => error);
    if (firstCause === 'abort') controller.abort();
    if (firstCause === 'protocol') harness.child.emit('message', { malformed: true });
    await disconnected;
    const scheduledBeforeResponse = schedules.mock.callCount();
    harness.child.emit('message', variants[1].failure());
    const scheduledAfterResponse = schedules.mock.callCount();
    harness.child.emit('close', 1, null);
    const error = await pending;
    assert.equal(error.code, firstCause === 'abort' ? 'CANCELLED' : 'RUNTIME_INCOMPLETE');
    assert.equal(scheduledAfterResponse, scheduledBeforeResponse, 'late failure must not replace the active grace timer');
    assert.equal(harness.disconnects(), 1);
    assert.equal(harness.kills(), 0);
    assert.equal(error.preserveWorkspace, true);
    await waitForRuntimeWorkerQuiescence(error);
  });
}

test('forge: abort then failure retains cancellation after grace and waits for late exact close', async t => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const harness = doubled(variants[1]);
  const controller = new AbortController();
  const pending = harness.run({ ...variants[1].options, signal: controller.signal,
    terminationGraceMs: 10 }).catch(error => error);
  controller.abort();
  harness.child.emit('message', variants[1].failure());
  const error = await pending;
  assert.equal(error.code, 'CANCELLED');
  assert.equal(error.preserveWorkspace, true);
  let quiescent = false;
  const proof = waitForRuntimeWorkerQuiescence(error).then(() => { quiescent = true; });
  harness.child.emit('exit', 1, null);
  await tick();
  assert.equal(quiescent, false);
  harness.child.emit('close', 1, null);
  await proof;
  assert.equal(harness.disconnects(), 1);
  assert.equal(harness.kills(), 0);
});

test('forge: authenticated failure before abort preserves failure and its response grace timer', async t => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const schedules = t.mock.method(global, 'setTimeout');
  const harness = doubled(variants[1]);
  const controller = new AbortController();
  const pending = harness.run({ ...variants[1].options, signal: controller.signal,
    terminationGraceMs: 100 }).catch(error => error);
  harness.child.emit('message', variants[1].failure());
  const scheduledBeforeAbort = schedules.mock.callCount();
  controller.abort();
  const scheduledAfterAbort = schedules.mock.callCount();
  harness.child.emit('close', 1, null);
  const error = await pending;
  assert.equal(error.code, 'RUNTIME_INCOMPLETE');
  assert.equal(scheduledAfterAbort, scheduledBeforeAbort);
  assert.equal(harness.disconnects(), 0);
  assert.equal(harness.kills(), 0);
  await waitForRuntimeWorkerQuiescence(error);
});

const executables = [{ name: 'Node', path: process.execPath }];
if (process.env.MINECRAFT_CORE_TEST_ELECTRON_PATH) {
  executables.push({ name: 'isolated Electron', path: process.env.MINECRAFT_CORE_TEST_ELECTRON_PATH });
}
for (const executable of executables) for (const variant of variants) {
  test(`${executable.name} protocol-only ${variant.name} failure emits exact close and settles`, { timeout: 6000 }, async t => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const events = [];
    let kills = 0;
    let childExited;
    const exited = new Promise(resolve => { childExited = resolve; });
    const run = variant.factory({ execPath: executable.path,
      workerPath: path.join(__dirname, 'fixtures', 'authenticated-runtime-failure-worker.cjs'),
      tokenFactory: () => token, requestIdFactory: () => requestId,
      forkImpl: (...args) => {
        const child = fork(...args);
        const kill = child.kill.bind(child);
        child.kill = (...values) => { kills += 1; return kill(...values); };
        child.on('message', () => events.push('message'));
        child.on('disconnect', () => events.push('disconnect'));
        child.on('exit', code => { events.push(`exit:${code}`); childExited(); });
        child.on('close', code => events.push(`close:${code}`));
        return child;
      }
    });
    const error = await run({ ...variant.options, timeoutMs: 3000, terminationGraceMs: 200 }).catch(failure => failure);
    await exited;
    assert.equal(error?.code, 'RUNTIME_INCOMPLETE');
    assert.equal(kills, 0);
    assert.equal(events.includes('close:1'), true, JSON.stringify(events));
    await waitForRuntimeWorkerQuiescence(error);
  });
}
