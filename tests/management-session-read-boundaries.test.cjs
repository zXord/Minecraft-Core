const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { ManagementSessionBroker } = require('../electron/services/management-session-broker.cjs');
const { createManagementSessionHandlers } = require('../electron/ipc/management-session-handlers.cjs');
const helper = () => import(pathToFileURL(path.resolve('src/utils/managementAuth.js')).href);
async function fixture(t, { seeded = false } = {}) {
  const config = { serverProtocol: 'http', serverIp: 'saved.example', serverPort: '8080', clientId: 'remote', clientName: 'Client', inviteSecret: 'private', ...(seeded ? { sessionToken: 'a'.repeat(64) } : {}) };
  const instance = { id: 'local', path: path.resolve('synthetic-client'), serverProtocol: 'http', serverIp: 'saved.example', serverPort: '8080', sessionToken: 'stale-mounted-token' };
  let registrations = 0;
  const broker = new ManagementSessionBroker({ resolveClient: async () => ({ clientId: 'local', clientPath: instance.path }), readClientConfig: async () => ({ ...config }), requestJson: async () => { registrations++; return { statusCode: 200, body: { success: true, token: 'b'.repeat(64) } }; } });
  const sender = new EventEmitter(); sender.mainFrame = {};
  const ipc = createManagementSessionHandlers({ win: { webContents: sender }, broker, resolveClientByPath: async () => ({ clientId: 'local' }) });
  const old = { window: global.window, fetch: global.fetch };
  global.window = { electron: { invoke: (channel, payload) => { assert.equal(channel, 'management-session:acquire'); return ipc.handlers[channel]({ sender, senderFrame: sender.mainFrame }, payload); } } };
  t.after(async () => { await ipc.dispose(); broker.dispose(); Object.assign(global, old); });
  return { instance, broker, config, registrations: () => registrations, ...(await helper()) };
}
for (const forceRegistration of [false, true]) test(`missing saved token spends registration allowance before ${forceRegistration ? 'explicit reconnect' : 'first 401'}`, async t => {
  const f = await fixture(t); let reads = 0;
  const response = await f.requestWithSessionRecovery(f.instance, async () => { reads++; return { status: 401 }; }, { forceRegistration });
  assert.equal(response.status, 401); assert.equal(f.registrations(), 1); assert.equal(reads, 1);
  assert.equal(f.instance.sessionToken, 'stale-mounted-token'); assert.equal(f.config.sessionToken, undefined);
});
test('seeded first 401 still rotates once and retries once', async t => {
  const f = await fixture(t, { seeded: true }); let reads = 0;
  assert.equal((await f.requestWithSessionRecovery(f.instance, async () => ({ status: ++reads === 1 ? 401 : 200 }))).status, 200);
  assert.equal(f.registrations(), 1); assert.equal(reads, 2);
});
test('force ensure with no saved token does not rotate its newly registered token', async t => {
  const f = await fixture(t); assert.equal(await f.ensureSessionToken(f.instance, true), 'b'.repeat(64)); assert.equal(f.registrations(), 1);
});
test('joining pending initial registration carries provenance without changing ordinary snapshots', async t => {
  const f = await fixture(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.broker.requestJson = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { statusCode: 200, body: { success: true, token: 'b'.repeat(64) } }; };
  const first = f.broker.acquireWithProvenance('local'); await ready;
  const joined = f.broker.acquireWithProvenance('local'); await new Promise(resolve => setImmediate(resolve)); release();
  assert.equal((await first).registrationAttempted, true); assert.equal((await joined).registrationAttempted, true);
  assert.equal((await f.broker.acquireWithProvenance('local')).registrationAttempted, false);
  assert.deepEqual(Object.keys(await f.broker.acquire('local')).sort(), ['baseOrigin', 'binding', 'bindingGeneration', 'revision', 'token']);
});
test('missing or malformed privileged registration provenance refuses dispatch', async t => {
  const f = await fixture(t, { seeded: true });
  for (const registrationAttempted of [undefined, 0, 'false', null]) {
    global.window.electron.invoke = async () => ({ ok: true, value: { sessionToken: 'a'.repeat(64), baseOrigin: 'http://saved.example:8080', bindingGeneration: 'g', revision: 0, registrationAttempted } });
    let reads = 0; await assert.rejects(f.requestWithSessionRecovery(f.instance, () => { reads++; return { status: 200 }; })); assert.equal(reads, 0);
  }
});
for (const timeoutKind of ['attempt', 'overall', 'abort']) test(`protected JSON keeps ${timeoutKind} cancellation active after headers`, async t => {
  const f = await fixture(t, { seeded: true }); let cancelled = false; let signal;
  global.fetch = async (_url, options) => { signal = options.signal; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); };
  const controller = new AbortController();
  const pending = f.readManagementJson(f.instance, '/api/server/info', { timeoutMs: timeoutKind === 'attempt' ? 20 : 10000, deadline: Date.now() + (timeoutKind === 'overall' ? 20 : 1000), signal: controller.signal });
  if (timeoutKind === 'abort') setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending); assert.equal(signal.aborted, true); assert.equal(cancelled, true); assert.equal(f.registrations(), 0);
});
test('selection retirement after headers discards parsed JSON', async t => {
  const f = await fixture(t, { seeded: true }); let finish, started, current = true;
  const ready = new Promise(resolve => { started = resolve; });
  global.fetch = async () => new Response(new ReadableStream({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }; started(); } }));
  const pending = f.readManagementJson(f.instance, '/api/server/info', { isCurrent: () => current }); await ready; current = false; finish();
  await assert.rejects(pending, error => error.stale === true); assert.equal(f.registrations(), 0);
});
for (const bytes of [262144, 262145]) test(`chunked info byte limit ${bytes}`, async t => {
  const f = await fixture(t, { seeded: true }); let cancelled = false;
  const body = Buffer.from('"' + 'é'.repeat(131071) + (bytes === 262145 ? 'x' : '') + '"'); assert.equal(body.length, bytes);
  global.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(body.subarray(0, 100)); controller.enqueue(body.subarray(100)); if (bytes === 262144) controller.close(); }, cancel() { cancelled = true; } }));
  if (bytes === 262144) assert.equal((await f.readManagementJson(f.instance, '/api/server/info')).data.length, 131071);
  else { await assert.rejects(f.readManagementJson(f.instance, '/api/server/info')); assert.equal(cancelled, true); }
  assert.equal(f.registrations(), 0);
});
test('malformed JSON and advertised oversized info fail without recovery', async t => {
  const f = await fixture(t, { seeded: true });
  for (const response of [new Response('{broken'), new Response('{}', { headers: { 'Content-Length': '262145' } })]) {
    global.fetch = async () => response; await assert.rejects(f.readManagementJson(f.instance, '/api/server/info'));
  }
  assert.equal(f.registrations(), 0);
});
test('retry body uses the original overall deadline', async t => {
  const f = await fixture(t, { seeded: true }); let calls = 0, signal;
  global.fetch = async (_url, options) => { if (++calls === 1) { await new Promise(resolve => setTimeout(resolve, 35)); return new Response('', { status: 401 }); } signal = options.signal; return new Response(new ReadableStream()); };
  const start = Date.now(); await assert.rejects(f.readManagementJson(f.instance, '/api/server/info', { deadline: start + 65 }));
  assert.equal(calls, 2); assert.equal(f.registrations(), 1); assert.equal(signal.aborted, true); assert.ok(Date.now() - start < 180);
});

for (const elapsed of [9, 10, 40]) test(`protected JSON ${elapsed < 10 ? 'accepts within-budget' : 'rejects late'} body completion before timer delivery (${elapsed}ms)`, async t => {
  const f = await fixture(t, { seeded: true });
  const realNow = Date.now; let now = realNow(); let signal, reads = 0, timerDelivered = false;
  Date.now = () => now; t.after(() => { Date.now = realNow; });
  const timer = setTimeout(() => { timerDelivered = true; }, 0); t.after(() => clearTimeout(timer));
  global.fetch = async (_url, options) => {
    signal = options.signal; reads++;
    return new Response(new ReadableStream({ pull(controller) {
      now += elapsed;
      controller.enqueue(new TextEncoder().encode('{"accepted":true}')); controller.close();
    } }));
  };
  const pending = f.readManagementJson(f.instance, '/api/server/info', { timeoutMs: 10, deadline: now + 1000 });
  if (elapsed < 10) assert.deepEqual((await pending).data, { accepted: true });
  else await assert.rejects(pending);
  assert.equal(timerDelivered, false); assert.equal(signal.aborted, true);
  assert.equal(reads, 1); assert.equal(f.registrations(), 0);
});

test('late 401 before timer delivery cannot register or replay', async t => {
  const f = await fixture(t, { seeded: true });
  const realNow = Date.now; let now = realNow(); let reads = 0, signal, timerDelivered = false;
  Date.now = () => now; t.after(() => { Date.now = realNow; });
  const timer = setTimeout(() => { timerDelivered = true; }, 0); t.after(() => clearTimeout(timer));
  global.fetch = async (_url, options) => { reads++; signal = options.signal; now += 40; return new Response('', { status: 401 }); };
  await assert.rejects(f.readManagementJson(f.instance, '/api/server/info', { timeoutMs: 10, deadline: now + 1000 }));
  assert.equal(timerDelivered, false); assert.equal(signal.aborted, true);
  assert.equal(reads, 1); assert.equal(f.registrations(), 0);
});

test('late body chunk cancels before requesting another chunk without timer delivery', async t => {
  const f = await fixture(t, { seeded: true });
  const realNow = Date.now; let now = realNow(); let pulls = 0, cancelled = false;
  Date.now = () => now; t.after(() => { Date.now = realNow; });
  global.fetch = async () => new Response(new ReadableStream({ pull(controller) {
    pulls++; now += 40; controller.enqueue(new TextEncoder().encode('{}'));
    if (pulls === 2) controller.close();
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  await assert.rejects(f.readManagementJson(f.instance, '/api/server/info', { timeoutMs: 10, deadline: now + 1000 }));
  assert.equal(pulls, 1); assert.equal(cancelled, true); assert.equal(f.registrations(), 0);
});
