const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/utils/managementAuth.js')).href;
const snapshot = (overrides = {}) => ({ sessionToken: 'memory-current', baseOrigin: 'https://server.test:8080', bindingGeneration: 'binding-a', revision: 4, ...overrides });
const client = (overrides = {}) => ({ id: 'registered-a', path: 'C:\\Temp\\isolated-client', serverIp: 'server.test', serverPort: '8080', serverProtocol: 'https',
  clientId: 'remote-a', clientName: 'Client', sessionToken: 'disk-old', inviteSecret: 'PRIVATE-invite', managementCertFingerprint: 'a'.repeat(64), ...overrides });
async function fixture(work, acquire = () => snapshot()) {
  const previous = { window: global.window, fetch: global.fetch };
  const calls = [];
  global.fetch = async () => assert.fail('registered auth must not register from renderer');
  global.window = { electron: { invoke: async (channel, payload) => {
    calls.push({ channel, payload });
    assert.equal(channel, 'management-session:acquire', 'auth must never persist or call another IPC');
    const value = await acquire(payload);
    return { ok: true, value: value && { registrationAttempted: false, ...value } };
  } } };
  try { await work(await import(moduleUrl), calls); }
  finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete global[key]; else global[key] = value; }
}

test('registered reads acquire current memory token without mutating mounted auth or persisting', async () => fixture(async ({ requestWithSessionRecovery }, calls) => {
  const instance = client(), before = JSON.stringify(instance);
  const response = await requestWithSessionRecovery(instance, async (headers, session) => {
    assert.deepEqual(headers, { 'X-Session-Token': 'memory-current' });
    assert.deepEqual(session, snapshot());
    assert.equal(Object.isFrozen(headers), true); assert.equal(Object.isFrozen(session), true);
    return { status: 200 };
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ channel: 'management-session:acquire', payload: { clientInstanceId: 'registered-a', reason: 'reuse' } }]);
  assert.equal(JSON.stringify(instance), before);
}));
test('ensure delegates to registered path when no app id exists, ignoring mounted token and remote id', async () => fixture(async ({ ensureSessionToken }, calls) => {
  const instance = client({ id: undefined });
  assert.equal(await ensureSessionToken(instance), 'memory-current');
  assert.deepEqual(calls[0].payload, { clientPath: instance.path, reason: 'reuse' });
  assert.equal(instance.sessionToken, 'disk-old');
}));
test('401 conditionally recovers its observed generation and revision once with paired origin/token', async () => fixture(async ({ requestWithSessionRecovery }, calls) => {
  const seen = [];
  const response = await requestWithSessionRecovery(client(), async (headers, session) => {
    seen.push([headers['X-Session-Token'], session.baseOrigin]);
    return { status: seen.length === 1 ? 401 : 200 };
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(call => call.payload), [
    { clientInstanceId: 'registered-a', reason: 'reuse' },
    { clientInstanceId: 'registered-a', reason: 'authorization-rejected', observedBindingGeneration: 'binding-a', observedRevision: 4 }
  ]);
  assert.deepEqual(seen, [['memory-current', 'https://server.test:8080'], ['memory-next', 'https://server.test:8080']]);
}, payload => snapshot(payload.reason === 'reuse' ? {} : { sessionToken: 'memory-next', revision: 5 })));
test('a repeated 401 stops after one retry', async () => fixture(async ({ requestWithSessionRecovery }, calls) => {
  let reads = 0;
  assert.equal((await requestWithSessionRecovery(client(), async () => { reads++; return { status: 401 }; })).status, 401);
  assert.equal(reads, 2); assert.equal(calls.length, 2);
}));
for (const status of [403, 429, 500, 503]) test(`${status} never rotates or retries a safe read`, async () => fixture(async ({ requestWithSessionRecovery }, calls) => {
  let reads = 0;
  assert.equal((await requestWithSessionRecovery(client(), async () => { reads++; return { status }; })).status, status);
  assert.equal(reads, 1); assert.equal(calls.length, 1);
}));
test('a failed request is not replayed', async () => fixture(async ({ requestWithSessionRecovery }, calls) => {
  let reads = 0;
  await assert.rejects(requestWithSessionRecovery(client(), async () => { reads++; throw new TypeError('Network refused'); }));
  assert.equal(reads, 1); assert.equal(calls.length, 1);
}));
test('explicit reconnect observes the current session before conditional rotation', async () => fixture(async ({ requestWithSessionRecovery }, calls) => {
  let reads = 0;
  await requestWithSessionRecovery(client(), async headers => { reads++; assert.equal(headers['X-Session-Token'], 'reconnected'); return { status: 401 }; }, { forceRegistration: true });
  assert.deepEqual(calls.map(call => call.payload), [{ clientInstanceId: 'registered-a', reason: 'reuse' },
    { clientInstanceId: 'registered-a', reason: 'explicit-reconnect', observedBindingGeneration: 'binding-a', observedRevision: 4 }]);
  assert.equal(reads, 1);
}, payload => snapshot(payload.reason === 'reuse' ? {} : { sessionToken: 'reconnected', revision: 5 })));
for (const change of ['origin', 'id', 'path', 'pin', 'selection']) test(`discard ${change} changes while acquire awaits`, async () => {
  let release;
  await fixture(async ({ requestWithSessionRecovery }) => {
    const instance = client(); let current = true; let reads = 0;
    const pending = requestWithSessionRecovery(instance, async () => { reads++; return { status: 200 }; }, { isCurrent: () => current });
    await Promise.resolve(); await Promise.resolve();
    if (change === 'origin') instance.serverIp = 'replacement.test';
    if (change === 'id') instance.id = 'registered-b';
    if (change === 'path') instance.path = 'C:\\Temp\\replacement';
    if (change === 'pin') instance.managementCertFingerprint = 'b'.repeat(64);
    if (change === 'selection') current = false;
    release?.(snapshot());
    await assert.rejects(pending, error => error.stale === true);
    assert.equal(reads, 0); assert.equal(instance.sessionToken, 'disk-old');
  }, () => new Promise(resolve => { release = resolve; }));
});
test('reject snapshot origin mismatch without dispatch or token persistence', async () => fixture(async ({ requestWithSessionRecovery }) => {
  let reads = 0;
  await assert.rejects(requestWithSessionRecovery(client(), async () => { reads++; }), error => error.stale === true);
  assert.equal(reads, 0);
}, () => snapshot({ baseOrigin: 'https://other.test:8080' })));
test('normalize default ports and IPv6 in mounted origin refusal checks', async () => fixture(async ({ requestWithSessionRecovery }) => {
  let reads = 0;
  await requestWithSessionRecovery(client({ serverIp: '::1', serverPort: '443' }), async (_headers, session) => {
    reads++; assert.equal(session.baseOrigin, 'https://[::1]'); return { status: 200 };
  });
  assert.equal(reads, 1);
}, () => snapshot({ baseOrigin: 'https://[::1]' })));
for (const bad of [null, {}, snapshot({ sessionToken: 'bad\r\nheader' }), snapshot({ revision: -1 }), snapshot({ baseOrigin: 'https://server.test:8080/path' }), snapshot({ bindingGeneration: '' })]) {
  test(`malformed privileged snapshot refuses dispatch (${JSON.stringify(bad)})`, async () => fixture(async ({ requestWithSessionRecovery }) => {
    let reads = 0;
    await assert.rejects(requestWithSessionRecovery(client(), async () => { reads++; }));
    assert.equal(reads, 0);
  }, () => bad));
}
test('untrusted IPC failure text is not exposed', async () => fixture(async ({ requestWithSessionRecovery }) => {
  global.window.electron.invoke = async () => ({ ok: false, error: { code: 'PLAN_STALE', message: 'PRIVATE-invite disk-old' } });
  await assert.rejects(requestWithSessionRecovery(client(), async () => assert.fail('dispatch')), error => !/PRIVATE|disk-old/.test(error.message));
}));
test('local deadline detaches a delayed acquire and never dispatches its later completion', async () => {
  let release;
  await fixture(async ({ requestWithSessionRecovery }) => {
    let reads = 0;
    await assert.rejects(requestWithSessionRecovery(client(), async () => { reads++; }, { deadline: Date.now() + 20 }));
    release?.(snapshot()); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0);
  }, () => new Promise(resolve => { release = resolve; }));
});
