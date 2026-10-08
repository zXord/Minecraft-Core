'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13', javaMajor: 17, os: 'win32', architecture: 'x64' };
const token = 'a'.repeat(64); const id = 'b'.repeat(32);
const workerModule = '../../electron/services/client-modpacks/client-runtime-worker.cjs';
const protocolModule = '../../electron/services/client-modpacks/client-runtime-worker-protocol.cjs';
const clientModule = '../../electron/services/client-modpacks/client-runtime-worker-client.cjs';
test('runtime worker boundaries exist', () => {
  for (const name of [workerModule, protocolModule, clientModule]) assert.equal(fs.existsSync(path.resolve(__dirname, name)), true);
});
test('protocol authenticates bounded progress and rejects secret-shaped payloads', () => {
  const protocol = require(protocolModule);
  const frame = protocol.createFrame(token, id, 'progress', { phase: 'java', bytes: 42, totalBytes: 100 });
  assert.deepEqual(protocol.verifyFrame(frame, token, id).payload, { phase: 'java', bytes: 42, totalBytes: 100 });
  assert.throws(() => protocol.verifyFrame({ ...frame, payload: { phase: 'java', bytes: 1000 } }, token, id));
  assert.throws(() => protocol.createFrame(token, id, 'progress', { phase: 'https://secret.invalid/token' }));
  assert.throws(() => protocol.createFrame(token, id, 'progress', { phase: 'java', bytes: -1 }));
});
test('exact child tracker waits for all closes, not exit or error', async () => {
  const { trackRuntimeChildren } = require(workerModule);
  const children = []; const api = { spawn: () => { const c = new EventEmitter(); children.push(c); return c; }, fork: () => { const c = new EventEmitter(); children.push(c); return c; } };
  const tracker = trackRuntimeChildren(api); api.spawn(); api.fork();
  let done = false; const settled = tracker.settle().then(() => { done = true; });
  children[0].emit('exit', 1); children[0].emit('error', Error('fixture'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  children[0].emit('close', 1, null); await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  children[1].emit('close', 0, null); await settled; assert.equal(done, true); tracker.restore();
});

test('exact child tracker retains exec and custom-promisified execFile children through error until close', async () => {
  const { promisify } = require('node:util');
  const children = [];
  const makeChild = () => { const child = new EventEmitter(); children.push(child); return child; };
  const execFile = () => makeChild();
  execFile[promisify.custom] = () => { const promise = Promise.reject(Error('fixture exec rejected')); promise.child = makeChild(); return promise; };
  const api = { exec: makeChild, execFile };
  const tracker = require(workerModule).trackRuntimeChildren(api);
  api.exec(); await assert.rejects(promisify(api.execFile)(), /fixture exec rejected/);
  assert.equal(children.length, 2);
  let done = false; const settled = tracker.settle().then(() => { done = true; });
  children[0].emit('exit', 1); children[1].emit('error', Error('fixture'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  children[0].emit('close', 1); await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  children[1].emit('close', 1); await settled; assert.equal(done, true);
  tracker.restore(); assert.equal(api.execFile, execFile);
});
test('parent disconnect does not exit accepted worker until stage and children settle', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-worker-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRef = new EventEmitter(); processRef.env = { MINECRAFT_CORE_CLIENT_RUNTIME_TOKEN: token }; processRef.connected = true;
  const exits = []; processRef.exit = code => exits.push(code); processRef.send = () => assert.fail('disconnected worker must not send');
  let finish; let signal; const operation = new Promise(resolve => { finish = resolve; });
  require(workerModule).startClientRuntimeWorker({ processRef, prepareImpl: async request => { signal = request.signal; await operation; }, childProcessApi: { spawn() {}, fork() {} } });
  processRef.emit('message', require(protocolModule).createFrame(token, id, 'request', { clientPath: root, runtime }));
  await new Promise(resolve => setImmediate(resolve)); processRef.connected = false; processRef.emit('disconnect');
  assert.equal(signal.aborted, true); assert.deepEqual(exits, []); finish();
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(exits, [65]);
});
test('worker client requires exact clean close after authenticated success', async () => {
  const child = new EventEmitter(); child.once = child.once.bind(child); child.send = request => { child.request = request; }; child.disconnect = () => {}; child.kill = () => assert.fail('must not kill accepted worker');
  const run = require(clientModule).createClientRuntimeWorkerClient({ forkImpl: () => child, tokenFactory: () => token, idFactory: () => id });
  let settled = false; const result = run({ clientPath: path.resolve(os.tmpdir()), runtime }).then(value => { settled = true; return value; });
  child.emit('message', require(protocolModule).createFrame(token, id, 'result', { ok: true, code: null }));
  child.emit('exit', 0); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  child.emit('close', 0, null); assert.deepEqual(await result, { quiescent: true });
});
test('cancel retains late clean-close proof but crash is uncertain', async () => {
  for (const crash of [false, true]) {
    const child = new EventEmitter(); child.send = () => {}; child.disconnect = () => {}; child.kill = () => assert.fail('must not kill accepted worker');
    const run = require(clientModule).createClientRuntimeWorkerClient({ forkImpl: () => child, tokenFactory: () => token, idFactory: () => id });
    const controller = new AbortController(); const keepAlive = setTimeout(() => {}, 1000);
    const pending = run({ clientPath: path.resolve(os.tmpdir()), runtime, signal: controller.signal, terminationGraceMs: 5 }); controller.abort();
    const error = await pending.catch(error => error); assert.equal(error.code, 'CANCELLED');
    const { waitForRuntimeWorkerQuiescence } = require('../../electron/services/runtime-worker-quiescence.cjs');
    const proof = waitForRuntimeWorkerQuiescence(error); child.emit('close', crash ? null : 65, crash ? 'SIGKILL' : null);
    if (crash) await assert.rejects(proof, { code: 'RECOVERY_REQUIRED' }); else await proof;
    clearTimeout(keepAlive);
  }
});
test('nested writer uncertainty cannot produce a clean worker-close proof', async () => {
  const processRef = new EventEmitter(); processRef.env = { MINECRAFT_CORE_CLIENT_RUNTIME_TOKEN: token }; processRef.connected = true;
  const exits = []; processRef.exit = code => exits.push(code); processRef.send = () => assert.fail('uncertain writer must not produce result');
  require(workerModule).startClientRuntimeWorker({ processRef, prepareImpl: async () => { throw Object.assign(Error('fixture'), { preserveWorkspace: true, quiescent: true }); }, childProcessApi: { spawn() {}, fork() {} } });
  processRef.emit('message', require(protocolModule).createFrame(token, id, 'request', { clientPath: path.resolve(os.tmpdir()), runtime }));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(exits, [66]);
});
test('pre-aborted operation proves no worker was started', async () => {
  const controller = new AbortController(); controller.abort(); let started = false;
  const run = require(clientModule).createClientRuntimeWorkerClient({ forkImpl: () => { started = true; } });
  const error = await run({ clientPath: path.resolve(os.tmpdir()), runtime, signal: controller.signal }).catch(error => error);
  assert.equal(error.code, 'CANCELLED'); assert.equal(started, false);
  await require('../../electron/services/runtime-worker-quiescence.cjs').waitForRuntimeWorkerQuiescence(error);
});
test('accepted worker persists proof after every child closes and retains lease through IPC send until process exit', async () => {
  const processRef = new EventEmitter(); processRef.env = { MINECRAFT_CORE_CLIENT_RUNTIME_TOKEN: token }; processRef.connected = true;
  let finishSend;
  const order = []; processRef.exit = code => order.push(`exit:${code}`); processRef.send = (_message, callback) => { finishSend = callback; };
  const child = new EventEmitter(); const api = { spawn: () => child, fork: () => child };
  const ownership = { root: path.resolve(os.tmpdir()), operationId: 'e0359071-fb1a-4cd0-ab3b-938b20e9a90f', markerId: 'c0359071-fb1a-4cd0-ab3b-938b20e9a90f', clientPath: path.resolve(os.tmpdir()), workerDurableConfig: { workerPath: path.resolve('helper.exe'), workerManifestPath: path.resolve('helper.json'), appOwnedRoot: path.resolve(os.tmpdir()) } };
  processRef.argv = [`--minecraft-core-client-runtime-id=${ownership.markerId}`];
  require(workerModule).startClientRuntimeWorker({ processRef, childProcessApi: api,
    ownershipFactory: async received => { assert.deepEqual(received, ownership); order.push('lease'); return { async settle() { order.push('persist-proof'); }, async release() { order.push('release'); } }; },
    prepareImpl: async () => { api.spawn(); order.push('prepare'); } });
  processRef.emit('message', require(protocolModule).createFrame(token, id, 'request', { clientPath: ownership.clientPath, runtime, ownership }));
  await new Promise(resolve => setImmediate(resolve)); child.emit('exit', 0); assert.deepEqual(order, ['lease', 'prepare']);
  child.emit('close', 0, null); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['lease', 'prepare', 'persist-proof']);
  finishSend(null);
  assert.deepEqual(order, ['lease', 'prepare', 'persist-proof', 'exit:0']);
});

test('worker rejects a mismatched main-issued argv marker before any candidate writer or proof', async () => {
  const processRef = new EventEmitter(); processRef.env = { MINECRAFT_CORE_CLIENT_RUNTIME_TOKEN: token }; processRef.connected = true; processRef.argv = [];
  const exits = []; processRef.exit = code => exits.push(code); processRef.send = () => assert.fail('invalid authority cannot send success');
  const ownership = { root: path.resolve(os.tmpdir()), operationId: 'e0359071-fb1a-4cd0-ab3b-938b20e9a90f', markerId: 'c0359071-fb1a-4cd0-ab3b-938b20e9a90f', clientPath: path.resolve(os.tmpdir()), workerDurableConfig: { workerPath: path.resolve('helper.exe'), workerManifestPath: path.resolve('helper.json'), appOwnedRoot: path.resolve(os.tmpdir()) } };
  let claimed = false; let wrote = false;
  require(workerModule).startClientRuntimeWorker({ processRef, childProcessApi: {}, ownershipFactory: async () => { claimed = true; return { async settle() {} }; }, prepareImpl: async () => { wrote = true; } });
  processRef.emit('message', require(protocolModule).createFrame(token, id, 'request', { clientPath: ownership.clientPath, runtime, ownership }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(claimed, false); assert.equal(wrote, false); assert.deepEqual(exits, [66]);
});
