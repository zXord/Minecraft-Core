'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { acquireProcessBoundLocalEndpointLease } = require('../../electron/utils/process-bound-local-endpoint-lease.cjs');
const location = '../../electron/services/client-modpacks/client-runtime-ownership.cjs';
const operationId = 'd784ab5e-4719-44dd-aa13-be27b2e1177c';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-owner-')));
  const ownershipRoot = path.join(root, 'authority'); fs.mkdirSync(ownershipRoot);
  const clientPath = path.join(root, `.minecraft-core-client-${operationId}-candidate`);
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {}
  } });
  let sequence = 100; const leases = [];
  const workerDurableConfig = { workerPath: path.join(root, 'ArchiveWorker.exe'), workerManifestPath: path.join(root, 'manifest.json'), appOwnedRoot: path.join(root, 'durable-state') };
  const make = overrides => new (require(location).ClientRuntimeOwnership)({ root: ownershipRoot, durableFs, workerDurableConfig,
    getBootSequence: async () => { if (sequence instanceof Error) throw sequence; return sequence; },
    acquireLease: async request => { const lease = await acquireProcessBoundLocalEndpointLease(request); leases.push(lease); return lease; }, ...overrides });
  t.after(async () => { await Promise.all(leases.map(lease => lease.close())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, ownershipRoot, clientPath, make, leases, durableFs, workerDurableConfig, sequence(value) { sequence = value; },
    async crashMain() { await Promise.all(leases.map(lease => lease.close())); },
    record() { return JSON.parse(fs.readFileSync(path.join(ownershipRoot, `${operationId}.json`), 'utf8')); } };
}
test('durable runtime ownership boundary exists', () => assert.equal(fs.existsSync(path.resolve(__dirname, location)), true));
test('reservation is durable before candidate exists and ordinary failure explicitly releases it', async t => {
  const f = fixture(t); const owner = f.make(); await owner.reserve({ operationId, clientPath: f.clientPath });
  assert.equal(fs.existsSync(f.clientPath), false); assert.equal(f.record().phase, 'reserved');
  assert.deepEqual(await f.make().getRecoveryState(operationId), { quiescent: false, status: 'running' });
  assert.equal(await owner.releaseReserved(operationId), true);
  assert.deepEqual(await f.make().getRecoveryState(operationId), { quiescent: true, status: 'quiescent' });
});
test('unclean reserved stage may own surviving native helper and requires newer boot without explicit release', async t => {
  const f = fixture(t); await f.make().reserve({ operationId, clientPath: f.clientPath }); await f.crashMain();
  assert.deepEqual(await f.make().getRecoveryState(operationId), { quiescent: false, status: 'restart-required' });
  assert.equal(f.record().phase, 'reserved');
  f.sequence(101); assert.equal((await f.make().getRecoveryState(operationId)).quiescent, true); assert.equal(f.record().phase, 'settled');
});
test('worker independently persists settlement after main is gone and holds lease through proof write', async t => {
  const f = fixture(t); const parent = f.make(); await parent.reserve({ operationId, clientPath: f.clientPath });
  const context = await parent.activate(operationId); const mainLease = f.leases[0];
  const worker = await f.make().claimWorker(context); await mainLease.close();
  assert.equal((await f.make().getRecoveryState(operationId)).status, 'running');
  await worker.settle(); assert.equal(f.record().phase, 'settled');
  assert.equal((await f.make().getRecoveryState(operationId)).status, 'running');
  await worker.release(); assert.equal((await f.make().getRecoveryState(operationId)).quiescent, true);
});

test('Windows authority root casing cannot bypass a live worker lease', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); const parent = f.make(); await parent.reserve({ operationId, clientPath: f.clientPath });
  const worker = await f.make().claimWorker(await parent.activate(operationId));
  await parent.releaseMain(operationId); await worker.settle();
  assert.deepEqual(await f.make({ root: f.ownershipRoot.toUpperCase() }).getRecoveryState(operationId), { quiescent: false, status: 'running' });
  await worker.release();
});
test('abrupt worker death with potentially surviving descendants remains blocked on same boot', async t => {
  const f = fixture(t); const parent = f.make(); await parent.reserve({ operationId, clientPath: f.clientPath });
  const context = await parent.activate(operationId); const worker = await f.make().claimWorker(context);
  await f.leases[0].close(); await worker.release();
  assert.deepEqual(await f.make().getRecoveryState(operationId), { quiescent: false, status: 'restart-required' });
  assert.deepEqual(await f.make().getRecoveryState(operationId), { quiescent: false, status: 'restart-required' });
  f.sequence(101); assert.equal((await f.make().getRecoveryState(operationId)).quiescent, true);
});
for (const boot of [99, 0, -1, null, Error('boot unavailable')]) {
  test(`reset or unavailable boot counter cannot prove abrupt writer absence: ${String(boot)}`, async t => {
    const f = fixture(t); const parent = f.make(); await parent.reserve({ operationId, clientPath: f.clientPath }); await parent.activate(operationId); await f.crashMain();
    f.sequence(boot); assert.equal((await f.make().getRecoveryState(operationId)).quiescent, false);
  });
}
test('worker cannot write before durable preparing or with mismatched authority', async t => {
  const f = fixture(t); const parent = f.make(); await parent.reserve({ operationId, clientPath: f.clientPath });
  const reserved = f.record();
  await assert.rejects(f.make().claimWorker({ root: f.ownershipRoot, operationId, markerId: reserved.markerId, clientPath: f.clientPath, workerDurableConfig: f.workerDurableConfig }), { code: 'RECOVERY_REQUIRED' });
  const context = await parent.activate(operationId);
  await assert.rejects(f.make().claimWorker({ ...context, clientPath: `${f.clientPath}-other` }), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(f.make().claimWorker({ ...context, workerDurableConfig: { ...context.workerDurableConfig, workerPath: path.join(f.root, 'untrusted.exe') } }), { code: 'RECOVERY_REQUIRED' });
});
test('unknown operation never becomes success and CAS failure never manufactures durable proof', async t => {
  const f = fixture(t); assert.equal((await f.make().getRecoveryState(operationId)).quiescent, false);
  const parent = f.make(); await parent.reserve({ operationId, clientPath: f.clientPath }); const context = await parent.activate(operationId);
  const badFs = { ...f.durableFs, async writeJsonAtomicAsync() { throw Error('CAS fixture'); } };
  const worker = await f.make({ durableFs: badFs }).claimWorker(context);
  await assert.rejects(worker.settle()); assert.equal(f.record().phase, 'preparing'); await worker.release(); await f.leases[0].close();
  assert.equal((await f.make().getRecoveryState(operationId)).status, 'restart-required');
});

test('accepted disconnected worker writes durable proof after descendant closes and restart reads it only after worker exit', async t => {
  const f = fixture(t); const parent = f.make(); await parent.reserve({ operationId, clientPath: f.clientPath });
  const ownership = await parent.activate(operationId);
  const processRef = new EventEmitter(); const token = 'a'.repeat(64); const id = 'b'.repeat(32);
  processRef.argv = [`--minecraft-core-client-runtime-id=${ownership.markerId}`];
  processRef.env = { MINECRAFT_CORE_CLIENT_RUNTIME_TOKEN: token }; processRef.connected = true;
  const child = new EventEmitter(); const api = { fork: () => child };
  let claim; let didExit; let release; let finishStage;
  const stage = new Promise(resolve => { finishStage = resolve; });
  const exited = new Promise(resolve => { didExit = resolve; });
  processRef.exit = code => { release = claim.release(); didExit(code); };
  processRef.send = () => assert.fail('disconnected worker cannot send');
  const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'vanilla', loaderVersion: '1.20.1', javaMajor: 17, os: 'win32', architecture: 'x64' };
  require('../../electron/services/client-modpacks/client-runtime-worker.cjs').startClientRuntimeWorker({ processRef, childProcessApi: api,
    ownershipFactory: async context => { claim = await f.make().claimWorker(context); return claim; },
    prepareImpl: async () => { api.fork(); await stage; } });
  processRef.emit('message', require('../../electron/services/client-modpacks/client-runtime-worker-protocol.cjs').createFrame(token, id, 'request', { clientPath: f.clientPath, runtime, ownership }));
  while (!claim) await new Promise(resolve => setImmediate(resolve));
  await parent.releaseMain(operationId); processRef.connected = false; processRef.emit('disconnect'); finishStage();
  child.emit('exit', 0); child.emit('error', Error('fixture'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.record().phase, 'preparing'); assert.equal((await f.make().getRecoveryState(operationId)).status, 'running');
  child.emit('close', 0, null);
  assert.equal(await exited, 65); await release;
  assert.equal(f.record().phase, 'settled'); assert.equal((await f.make().getRecoveryState(operationId)).quiescent, true);
});

test('worker proof CAS failure exits uncertain and never permits same-boot cleanup', async t => {
  const f = fixture(t); const parent = f.make(); await parent.reserve({ operationId, clientPath: f.clientPath });
  const ownership = await parent.activate(operationId);
  const processRef = new EventEmitter(); const token = 'a'.repeat(64); const id = 'b'.repeat(32);
  processRef.argv = [`--minecraft-core-client-runtime-id=${ownership.markerId}`];
  processRef.env = { MINECRAFT_CORE_CLIENT_RUNTIME_TOKEN: token }; processRef.connected = true;
  let claim; let release; let didExit; const exited = new Promise(resolve => { didExit = resolve; });
  processRef.exit = code => { release = claim.release(); didExit(code); };
  processRef.send = () => assert.fail('uncertain worker cannot send');
  const badFs = { ...f.durableFs, async writeJsonAtomicAsync() { throw Error('CAS fixture'); } };
  const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'vanilla', loaderVersion: '1.20.1', javaMajor: 17, os: 'win32', architecture: 'x64' };
  require('../../electron/services/client-modpacks/client-runtime-worker.cjs').startClientRuntimeWorker({ processRef, childProcessApi: {},
    ownershipFactory: async context => { claim = await f.make({ durableFs: badFs }).claimWorker(context); return claim; }, prepareImpl: async () => {} });
  processRef.emit('message', require('../../electron/services/client-modpacks/client-runtime-worker-protocol.cjs').createFrame(token, id, 'request', { clientPath: f.clientPath, runtime, ownership }));
  assert.equal(await exited, 66); await release; await parent.releaseMain(operationId);
  assert.equal(f.record().phase, 'preparing'); assert.equal((await f.make().getRecoveryState(operationId)).status, 'restart-required');
});
test('boot provider validates supported stable readonly counter output without clock-derived fallback', async () => {
  const { createWindowsBootSequenceProvider } = require(location);
  const runtime = { executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', systemRoot: 'C:\\Windows', modulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' };
  let output = { version: 1, major: 10, build: 26100, architecture: 9, sequenceA: 42, sequenceB: 42 };
  const provider = createWindowsBootSequenceProvider({ platform: 'win32', architecture: 'x64', resolveRuntime: () => runtime,
    execFileFn: (_file, _args, options, callback) => { assert.equal(options.timeout, 10000); assert.equal(options.windowsHide, true); assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false); callback(null, JSON.stringify(output)); } });
  assert.equal(await provider(), 42);
  output = { ...output, build: 26300 }; assert.equal(await provider(), 42);
  for (const change of [{ sequenceB: 43 }, { build: 99999 }, { architecture: 12 }, { sequenceA: -1, sequenceB: -1 }]) { const before = output; output = { ...output, ...change }; await assert.rejects(provider(), { code: 'RECOVERY_REQUIRED' }); output = before; }
});

for (const batch of [false, true]) for (const mode of ['timeout', 'error']) {
  test(`scoped strict durable ${batch ? 'batch' : 'single'} flush retains ${mode} rejection until exact helper close`, async t => {
    const f = fixture(t); const child = new EventEmitter(); let spawned = false; let kills = 0; let settled = false;
    Object.assign(child, { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { kills++; return true; } });
    const client = new (require('../../electron/utils/windows-durable-fs-client.cjs').WindowsDurableFsClient)({ ...f.workerDurableConfig, allowedRoots: [f.root],
      requireConfirmedClose: true, timeoutMs: 10, terminationGraceMs: 5, verifyWorker() {}, async verifyWorkerAsync() {}, spawn() { spawned = true; return child; } });
    const pending = (batch ? client.flushDirectoriesAsync([f.root]) : client.flushDirectoryAsync(f.root)).then(() => { settled = true; return null; }, error => { settled = true; return error; });
    while (!spawned) await new Promise(resolve => setImmediate(resolve));
    if (mode === 'error') child.emit('error', Error('fixture helper error'));
    try {
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.equal(kills, 1); assert.equal(settled, false);
      child.emit('exit', 1); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    } finally { child.emit('close', 1, null); }
    assert.equal((await pending).code, 'COMMIT_FAILED');
  });
}

test('default durable flush keeps existing bounded unconfirmed-close rejection policy', async t => {
  const f = fixture(t); const child = new EventEmitter();
  Object.assign(child, { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
  const client = new (require('../../electron/utils/windows-durable-fs-client.cjs').WindowsDurableFsClient)({ ...f.workerDurableConfig, allowedRoots: [f.root],
    timeoutMs: 10, terminationGraceMs: 5, verifyWorker() {}, async verifyWorkerAsync() {}, spawn() { return child; } });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(client.flushDirectoryAsync(f.root), { code: 'COMMIT_FAILED' }); }
  finally { child.emit('close', 1, null); clearTimeout(keepAlive); }
});

test('durable strict-close constructor rejects nonboolean policy values', t => {
  const f = fixture(t); const { WindowsDurableFsClient } = require('../../electron/utils/windows-durable-fs-client.cjs');
  for (const requireConfirmedClose of [1, 'true', null, {}]) assert.throws(() => new WindowsDurableFsClient({ ...f.workerDurableConfig, allowedRoots: [f.root], requireConfirmedClose }), { code: 'COMMIT_FAILED' });
});

test('worker reconstructs a dedicated authority-only strict-close durable client', async t => {
  const f = fixture(t); const parent = f.make(); await parent.reserve({ operationId, clientPath: f.clientPath }); const context = await parent.activate(operationId);
  const Module = require('node:module'); const original = Module._load; let nativeOptions; let durableOptions; let worker;
  Module._load = function(name, ...args) {
    if (name === '../../utils/windows-durable-fs-client.cjs') return { WindowsDurableFsClient: class { constructor(options) { nativeOptions = options; } } };
    if (name === '../../utils/durable-fs.cjs') return { createDurableFs(options) { durableOptions = options; return f.durableFs; } };
    return original.call(this, name, ...args);
  };
  try { worker = await require(location).createWorkerRuntimeOwnership(context, { getBootSequence: async () => 100 }); }
  finally { Module._load = original; }
  try { assert.equal(nativeOptions.requireConfirmedClose, true); assert.deepEqual(nativeOptions.allowedRoots, [f.ownershipRoot]); assert.deepEqual(durableOptions.allowedRoots, [f.ownershipRoot]); }
  finally { await worker.release(); }
});
