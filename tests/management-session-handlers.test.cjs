const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ManagementSessionBroker } = require('../electron/services/management-session-broker.cjs');
function fixture(t) {
  const { createManagementSessionHandlers } = require('../electron/ipc/management-session-handlers.cjs');
  const sender = new EventEmitter(); sender.id = 1; sender.mainFrame = {}; sender.isDestroyed = () => !!sender.dead;
  const win = { webContents: sender, isDestroyed: () => false };
  const calls = []; const configs = new Map(['one', 'two'].map((id, index) => [id, { serverProtocol: 'http', serverIp: `saved-${id}.example`, serverPort: 25566,
    clientId: `remote-${id}`, clientName: id, inviteSecret: 'private-invite', sessionToken: (index ? 'c' : 'a').repeat(64) }]));
  const broker = new ManagementSessionBroker({ resolveClient: async id => configs.has(id) ? { clientId: id, clientPath: path.resolve(`synthetic-${id}`) } : null,
    readClientConfig: async clientPath => configs.get(path.basename(clientPath).replace('synthetic-', '')),
    requestJson: async (_url, options) => { calls.push(options); if (f.wait) await f.wait(options); return { statusCode: 200, body: { success: true, token: 'b'.repeat(64) } }; } });
  const ipc = createManagementSessionHandlers({ win, broker, resolveClientByPath: async clientPath => {
    if (f.pathWait) await f.pathWait();
    const id = ['one', 'two'].find(value => clientPath === path.resolve(`synthetic-${value}`));
    if (!id) throw new Error('private path'); return { clientId: id, clientPath };
  } });
  const f = { broker, sender, calls, configs, ipc, call: (input, event = { sender, senderFrame: sender.mainFrame }) => ipc.handlers['management-session:acquire'](event, input) };
  t.after(async () => { await ipc.dispose(); broker.dispose(); }); return f;
}
test('session IPC projects only four scoped privileged fields for registered ID and path', async t => {
  const f = fixture(t); const one = await f.call({ clientInstanceId: 'one', reason: 'reuse' });
  assert.equal(one.ok, true); assert.deepEqual(Object.keys(one.value).sort(), ['baseOrigin', 'bindingGeneration', 'revision', 'sessionToken']);
  assert.equal(one.value.sessionToken, 'a'.repeat(64)); assert.equal(one.value.baseOrigin, 'http://saved-one.example:25566');
  const two = await f.call({ clientPath: path.resolve('synthetic-two'), reason: 'reuse' });
  assert.equal(two.value.sessionToken, 'c'.repeat(64)); assert.equal(two.value.baseOrigin, 'http://saved-two.example:25566');
  assert.equal((await f.call({ clientPath: path.resolve('unregistered'), reason: 'reuse' })).ok, false);
});
for (const kind of ['other-sender', 'subframe', 'no-frame', 'no-sender', 'destroyed']) test(`privileged session refuses ${kind}`, async t => {
  const f = fixture(t); const event = { sender: f.sender, senderFrame: f.sender.mainFrame };
  if (kind === 'other-sender') event.sender = { id: 1 };
  if (kind === 'subframe') event.senderFrame = {};
  if (kind === 'no-frame') delete event.senderFrame;
  if (kind === 'no-sender') delete event.sender;
  if (kind === 'destroyed') f.sender.dead = true;
  assert.equal((await f.call({ clientInstanceId: 'one', reason: 'reuse' }, event)).ok, false); assert.equal(f.broker.entries.size, 0);
});
const malformed = [null, {}, { clientInstanceId: 'one' }, { clientInstanceId: 'one', clientPath: 'anything', reason: 'reuse' },
  { clientInstanceId: 'one', reason: 'reuse', token: 'secret' }, { clientInstanceId: 'one', reason: 'reuse', observedBindingGeneration: 'generation', observedRevision: 0 },
  { clientInstanceId: 'one', reason: 'authorization-rejected' }, { clientInstanceId: 'one', reason: 'explicit-reconnect', observedBindingGeneration: 'generation' },
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(observedRevision => ({ clientInstanceId: 'one', reason: 'authorization-rejected', observedBindingGeneration: 'generation', observedRevision })),
  { clientInstanceId: 'one', reason: 'authorization-rejected', observedBindingGeneration: 'a'.repeat(129), observedRevision: 0 },
  { clientInstanceId: 'one', reason: 'authorization-rejected', observedBindingGeneration: 'https://secret', observedRevision: 0 }];
for (const [index, input] of malformed.entries()) test(`exact session request rejects malformed shape ${index}`, async t => {
  const f = fixture(t); assert.equal((await f.call(input)).error.code, 'INVALID_REQUEST'); assert.equal(f.broker.entries.size, 0);
});
for (const reason of ['authorization-rejected', 'explicit-reconnect']) test(`${reason} preserves generation and advances only revision without saving config`, async t => {
  const f = fixture(t); const first = (await f.call({ clientInstanceId: 'one', reason: 'reuse' })).value;
  const recovered = (await f.call({ clientInstanceId: 'one', reason, observedBindingGeneration: first.bindingGeneration, observedRevision: first.revision })).value;
  assert.equal(recovered.sessionToken, 'b'.repeat(64)); assert.equal(recovered.bindingGeneration, first.bindingGeneration); assert.equal(recovered.revision, 1);
  assert.equal(f.configs.get('one').sessionToken, 'a'.repeat(64)); assert.equal(f.calls.length, 1);
});
test('destroying IPC owner cancels its waiter without cancelling main shared registration', async t => {
  const f = fixture(t); const first = await f.broker.acquire('one'); let enter; let release;
  const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; }); f.wait = () => { enter(); return gate; };
  const rotate = { reason: 'authorization-rejected', observedBindingGeneration: first.bindingGeneration, observedRevision: 0 };
  const main = f.broker.acquire('one', rotate); const renderer = f.call({ clientInstanceId: 'one', ...rotate });
  await entered; await new Promise(resolve => setImmediate(resolve)); f.sender.dead = true; f.sender.emit('destroyed');
  assert.equal((await renderer).error.code, 'CANCELLED'); release(); assert.equal((await main).token, 'b'.repeat(64)); assert.equal(f.calls.length, 1);
  await f.ipc.dispose(); assert.equal(f.sender.listenerCount('destroyed'), 0);
});
test('IPC sanitizes arbitrary broker failure and invalid session response', async t => {
  const f = fixture(t); f.broker.acquire = async () => { throw new Error('private token=secret'); };
  const failure = await f.call({ clientInstanceId: 'one', reason: 'reuse' }); assert.equal(failure.ok, false); assert.equal(JSON.stringify(failure).includes('secret'), false);
  f.broker.acquire = async () => ({ token: 'secret', baseOrigin: 'http://saved.example', binding: { generation: 'other' }, bindingGeneration: 'g', revision: 0 });
  assert.equal((await f.call({ clientInstanceId: 'one', reason: 'reuse' })).ok, false);
});
test('session IPC refuses symbols, accessors, inherited shapes and excess arguments before acquisition', async t => {
  const f = fixture(t); const ordinary = { clientInstanceId: 'one', reason: 'reuse' };
  for (const input of [{ ...ordinary, [Symbol('hidden')]: true }, Object.create(ordinary), Object.defineProperty({ clientInstanceId: 'one' }, 'reason', { enumerable: true, get() { assert.fail('must not invoke accessor'); } })]) {
    assert.equal((await f.call(input)).error.code, 'INVALID_REQUEST');
  }
  assert.equal((await f.ipc.handlers['management-session:acquire']({ sender: f.sender, senderFrame: f.sender.mainFrame }, ordinary, {})).error.code, 'INVALID_REQUEST');
  assert.equal(f.broker.entries.size, 0);
});
test('a frame replacement while acquiring discards privileged completion', async t => {
  const f = fixture(t); let finish; const gate = new Promise(resolve => { finish = resolve; });
  const acquire = f.broker.acquire.bind(f.broker); f.broker.acquire = async (...args) => { const result = await acquire(...args); await gate; return result; };
  const pending = f.call({ clientInstanceId: 'one', reason: 'reuse' }); await new Promise(resolve => setImmediate(resolve));
  f.sender.mainFrame = {}; finish(); assert.equal((await pending).error.code, 'CANCELLED');
});
test('session disposal aborts its acquired waiter and is idempotent', async t => {
  const f = fixture(t); let enter; const ready = new Promise(resolve => { enter = resolve; });
  f.broker.acquire = (_id, { signal }) => new Promise((_resolve, reject) => { enter(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const pending = f.call({ clientInstanceId: 'one', reason: 'reuse' }); await ready;
  const disposal = f.ipc.dispose(); assert.equal(f.ipc.dispose(), disposal); await disposal;
  assert.equal((await pending).error.code, 'CANCELLED'); assert.equal(f.sender.listenerCount('destroyed'), 0);
});
test('out-of-order concurrent client acquisitions cannot swap privileged responses', async t => {
  const f = fixture(t); let enter; let finish; const ready = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { finish = resolve; });
  const read = f.broker.readClientConfig.bind(f.broker);
  let delayed = false; f.broker.readClientConfig = async clientPath => { if (clientPath === path.resolve('synthetic-one') && !delayed) { delayed = true; enter(); await gate; } return read(clientPath); };
  const one = f.call({ clientInstanceId: 'one', reason: 'reuse' }); await ready;
  const two = await f.call({ clientInstanceId: 'two', reason: 'reuse' }); finish(); const first = await one;
  assert.equal(first.value.sessionToken, 'a'.repeat(64)); assert.equal(first.value.baseOrigin, 'http://saved-one.example:25566');
  assert.equal(two.value.sessionToken, 'c'.repeat(64)); assert.equal(two.value.baseOrigin, 'http://saved-two.example:25566');
});
test('owner disposal detaches promptly even while registered-path resolution is delayed', async t => {
  const f = fixture(t); let enter; let finish; const ready = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { finish = resolve; });
  f.pathWait = () => { enter(); return gate; };
  const pending = f.call({ clientPath: path.resolve('synthetic-one'), reason: 'reuse' }); await ready;
  let settled = false; const disposal = f.ipc.dispose().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); const detachedBeforeResolution = settled; finish(); await disposal;
  assert.equal(detachedBeforeResolution, true); assert.equal((await pending).error.code, 'CANCELLED'); assert.equal(f.broker.entries.size, 0);
});
