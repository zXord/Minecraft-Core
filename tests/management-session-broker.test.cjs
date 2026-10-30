const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { ManagementSessionBroker } = require('../electron/services/management-session-broker.cjs');
const { MANAGEMENT_INFO_MAX_BYTES } = require('../electron/services/management-session-transport.cjs');

const SEED = 'a'.repeat(64), ROTATED = 'b'.repeat(64);
const info = { minecraftPort: 25565, clientModpack: null };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, overrides = {}) {
  const config = { serverProtocol: 'http', serverIp: 'saved.example', serverPort: '25566', clientId: 'remote',
    clientName: 'Synthetic client', inviteSecret: 'private-invite', sessionToken: SEED };
  const target = { clientId: 'local', clientPath: path.resolve('synthetic-client') };
  const calls = []; let writes = 0; let uuid = 0;
  const broker = new ManagementSessionBroker({ resolveClient: async id => id === target.clientId ? { ...target } : null,
    readClientConfig: async () => ({ ...config }), randomUUID: () => `generation-${++uuid}`,
    requestJson: async (url, options) => { calls.push({ url: String(url), ...options });
      return options.method === 'POST' ? { statusCode: 200, body: { success: true, token: ROTATED } } : { statusCode: 200, body: info }; },
    writeClientConfig: () => { writes++; }, ...overrides });
  t.after(() => broker.dispose());
  return { broker, config, target, calls, writes: () => writes };
}
const rotate = snapshot => ({ reason: 'authorization-rejected', observedBindingGeneration: snapshot.bindingGeneration, observedRevision: snapshot.revision });

test('legacy context projects saved pin with current memory token and has read-only binding assertion', async t => {
  const f = fixture(t, { getPinnedHttpsAgent: async () => ({}) }); f.config.serverProtocol = 'https'; f.config.managementCertFingerprint = 'AA:'.repeat(31) + 'AA';
  const first = await f.broker.acquire('local');
  const context = await f.broker.acquireLegacyContext('local');
  assert.equal(Object.isFrozen(context), true); assert.equal(context.sessionToken, SEED);
  assert.equal(context.baseOrigin, 'https://saved.example:25566'); assert.equal(context.managementCertFingerprint, 'a'.repeat(64));
  assert.equal(context.binding, first.binding); assert.equal(typeof context.assertCurrent, 'function');
  assert.deepEqual(Object.keys(first).sort(), ['baseOrigin', 'binding', 'bindingGeneration', 'revision', 'token']);
  const later = await f.broker.acquire('local', rotate(first));
  await context.assertCurrent();
  assert.equal(context.sessionToken, SEED); assert.equal(later.token, ROTATED); assert.equal(f.calls.length, 1);
  assert.equal(f.writes(), 0);
});
for (const change of ['pin', 'origin', 'path', 'invalidation', 'disposal']) test(`legacy retained context refuses ${change} without registration`, async t => {
  const f = fixture(t); f.config.serverProtocol = 'https'; f.config.managementCertFingerprint = 'a'.repeat(64);
  const context = await f.broker.acquireLegacyContext('local');
  if (change === 'pin') f.config.managementCertFingerprint = 'b'.repeat(64);
  if (change === 'origin') f.config.serverIp = 'replacement.example';
  if (change === 'path') f.target.clientPath = path.resolve('replacement-client');
  if (change === 'invalidation') f.broker.invalidate('local');
  if (change === 'disposal') f.broker.dispose();
  await assert.rejects(context.assertCurrent(), { code: change === 'disposal' ? 'CANCELLED' : 'PLAN_STALE' });
  assert.equal(f.calls.length, 0);
});
test('legacy context refuses saved pin drift during acquisition without projecting a mixed pair', async t => {
  let reads = 0;
  const f = fixture(t, { readClientConfig: async () => {
    if (++reads === 3) f.config.managementCertFingerprint = 'b'.repeat(64);
    return { ...f.config };
  } });
  f.config.serverProtocol = 'https'; f.config.managementCertFingerprint = 'a'.repeat(64);
  await assert.rejects(f.broker.acquireLegacyContext('local'), { code: 'PLAN_STALE' });
  assert.equal(f.calls.length, 0);
});
test('legacy assertion is bounded and cancellation does not rotate its token', async t => {
  const f = fixture(t); const context = await f.broker.acquireLegacyContext('local');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(context.assertCurrent({ signal: controller.signal }), { code: 'CANCELLED' });
  await assert.rejects(context.assertCurrent({ deadline: Date.now() - 1 }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});

test('saved token is seeded once; recovery advances revision without changing binding or config', async t => {
  const f = fixture(t); const before = JSON.stringify(f.config); const first = await f.broker.acquire('local');
  assert.equal(first.token, SEED); assert.equal(first.baseOrigin, 'http://saved.example:25566');
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.binding));
  assert.equal(JSON.stringify(first.binding).includes(SEED), false);
  const next = await f.broker.acquire('local', rotate(first));
  assert.equal(next.token, ROTATED); assert.equal(next.binding, first.binding); assert.equal(next.revision, first.revision + 1);
  f.config.sessionToken = 'c'.repeat(64);
  assert.equal((await f.broker.acquire('local')).token, ROTATED);
  f.config.sessionToken = SEED;
  assert.equal(JSON.stringify(f.config), before); assert.equal(f.writes(), 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'http://saved.example:25566/api/client/register');
  assert.equal(f.calls[0].body, '{"clientId":"remote","name":"Synthetic client","secret":"private-invite"}');
  assert.deepEqual(f.calls[0].headers, { 'Content-Type': 'application/json' });
});
test('missing saved token registers once and then reuses memory', async t => {
  const f = fixture(t); delete f.config.sessionToken;
  assert.equal((await f.broker.acquire('local')).token, ROTATED);
  await f.broker.acquire('local'); assert.equal(f.calls.length, 1); assert.equal(f.writes(), 0);
});
test('safe info read recovers first 401 exactly once with GET POST GET', async t => {
  const calls = []; const f = fixture(t, { requestJson: async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (options.method === 'POST') return { statusCode: 200, body: { success: true, token: ROTATED } };
    return options.headers['X-Session-Token'] === SEED ? { statusCode: 401, body: {} } : { statusCode: 200, body: info };
  } });
  const result = await f.broker.readServerInfo('local'); assert.deepEqual(result.response, info);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST', 'GET']);
  assert.equal(calls[0].maxBytes, MANAGEMENT_INFO_MAX_BYTES); assert.equal(calls[1].maxBytes, 16384);
  assert.equal(calls[2].headers['X-Session-Token'], ROTATED); assert.equal(f.writes(), 0);
});
test('main and renderer join one registration; cancelling one waiter preserves peer', async t => {
  const registration = deferred(), started = deferred(); let posts = 0;
  const f = fixture(t, { requestJson: async (_url, options) => {
    if (options.method === 'GET') return { statusCode: 401, body: {} };
    posts++; started.resolve(); return registration.promise;
  } });
  const snapshot = await f.broker.acquire('local'); const controller = new AbortController();
  const cancelled = f.broker.acquire('local', { ...rotate(snapshot), signal: controller.signal });
  await started.promise;
  const peer = f.broker.acquire('local', rotate(snapshot));
  controller.abort(new Error('private-invite'));
  await assert.rejects(cancelled, { code: 'CANCELLED' });
  registration.resolve({ statusCode: 200, body: { success: true, token: ROTATED } });
  assert.equal((await peer).token, ROTATED); assert.equal(posts, 1);
  assert.equal((await f.broker.acquire('local', rotate(snapshot))).token, ROTATED); assert.equal(posts, 1);
});
test('concurrent main safe read and renderer recovery share one rotation', async t => {
  const entered = deferred(), release = deferred(); let posts = 0;
  const f = fixture(t, { requestJson: async (_url, options) => {
    if (options.method === 'POST') { posts++; entered.resolve(); await release.promise; return { statusCode: 200, body: { success: true, token: ROTATED } }; }
    return { statusCode: options.headers['X-Session-Token'] === SEED ? 401 : 200, body: info };
  } });
  const seed = await f.broker.acquire('local'); const main = f.broker.readServerInfo('local'); await entered.promise;
  const renderer = f.broker.acquire('local', rotate(seed)); release.resolve();
  assert.deepEqual((await main).response, info); assert.equal((await renderer).token, ROTATED); assert.equal(posts, 1);
});
for (const statusCode of [401, 403, 429, 500]) test(`status ${statusCode} stops without unauthorized extra rotation`, async t => {
  let posts = 0, gets = 0;
  const f = fixture(t, { requestJson: async (_url, options) => {
    if (options.method === 'POST') { posts++; return { statusCode: 200, body: { success: true, token: ROTATED } }; }
    gets++; return { statusCode, body: { error: 'private-invite' } };
  } });
  await assert.rejects(f.broker.readServerInfo('local'), e => e.code === 'CLIENT_PACK_UNAVAILABLE' && !JSON.stringify(e).includes('private-invite'));
  assert.equal(posts, statusCode === 401 ? 1 : 0); assert.equal(gets, statusCode === 401 ? 2 : 1);
});
for (const mutate of [c => { c.serverIp = 'replacement.example'; }, c => { c.serverPort = 25567; },
  c => { c.clientId = 'replacement'; }, c => { c.clientName = 'Renamed'; }, c => { c.inviteSecret = 'replacement'; }]) {
  test('saved authority edit rejects retained binding and old observation before dispatch', async t => {
    const f = fixture(t); const seed = await f.broker.acquire('local'); mutate(f.config);
    await assert.rejects(f.broker.acquire('local', rotate(seed)), { code: 'PLAN_STALE' });
    await assert.rejects(f.broker.readServerInfo('local', { expectedBinding: seed.binding }), { code: 'PLAN_STALE' });
    assert.equal(f.calls.length, 0);
    assert.notEqual((await f.broker.acquire('local')).bindingGeneration, seed.bindingGeneration);
  });
}
test('changed registered path and explicit invalidation reject retained generation', async t => {
  const f = fixture(t); let seed = await f.broker.acquire('local'); f.target.clientPath = path.resolve('different-synthetic-client');
  await assert.rejects(f.broker.acquire('local', rotate(seed)), { code: 'PLAN_STALE' });
  seed = await f.broker.acquire('local'); f.broker.invalidate('local');
  await assert.rejects(f.broker.acquire('local', rotate(seed)), { code: 'PLAN_STALE' }); assert.equal(f.calls.length, 0);
});
test('different local bindings cannot claim same canonical origin and remote identity', async t => {
  const f = fixture(t, { resolveClient: async id => ({ clientId: id, clientPath: path.resolve(`synthetic-${id}`) }) });
  await f.broker.acquire('one'); await assert.rejects(f.broker.acquire('two'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});
for (const bad of [null, {}, { serverProtocol: 'https' }, { inviteSecret: '' }, { sessionToken: { encrypted: 'private-invite' } }]) {
  test('missing or undecryptable required authority fails without requests', async t => {
    const f = fixture(t, { readClientConfig: async () => bad === null ? null : ({ ...f.config, ...bad }) });
    if (bad && Object.keys(bad).length === 0) delete f.config.clientId;
    await assert.rejects(f.broker.acquire('local'), { code: 'CLIENT_PACK_UNAVAILABLE' }); assert.equal(f.calls.length, 0);
  });
}
test('dependency failures surface no raw secret or cause', async t => {
  const f = fixture(t, { readClientConfig: async () => { throw new Error('private-invite '+ SEED); } });
  await assert.rejects(f.broker.acquire('local'), e => e.code === 'CLIENT_PACK_UNAVAILABLE' && !e.cause && !JSON.stringify(e).includes(SEED));
});
test('authority changes during registration refuse stale completion without committing token', async t => {
  const entered = deferred(), release = deferred(); const f = fixture(t, { requestJson: async () => {
    entered.resolve(); await release.promise; return { statusCode: 200, body: { success: true, token: ROTATED } };
  } });
  const seed = await f.broker.acquire('local'); const pending = f.broker.acquire('local', rotate(seed)); await entered.promise;
  f.config.serverIp = 'replacement.example'; release.resolve(); await assert.rejects(pending, { code: 'PLAN_STALE' });
  assert.equal((await f.broker.acquire('local')).token, SEED);
});
test('late old-generation 401 cannot register with replacement saved authority', async t => {
  const entered = deferred(), release = deferred(); let requests = 0;
  const f = fixture(t, { requestJson: async () => { requests++; entered.resolve(); await release.promise; return { statusCode: 401, body: {} }; } });
  const pending = f.broker.readServerInfo('local'); await entered.promise; f.config.serverIp = 'replacement.example';
  await f.broker.acquire('local'); release.resolve(); await assert.rejects(pending, { code: 'PLAN_STALE' }); assert.equal(requests, 1);
});
for (const body of [{ token: ROTATED }, { success: true, token: 'B'.repeat(64) }, { success: true, token: 'x' }, { success: true, token: ROTATED, padding: 'x'.repeat(16384) }]) {
  test('invalid registration response never becomes an authenticated session', async t => {
    const f = fixture(t, { requestJson: async () => ({ statusCode: 200, body }) }); const seed = await f.broker.acquire('local');
    await assert.rejects(f.broker.acquire('local', rotate(seed)), { code: 'CLIENT_PACK_UNAVAILABLE' });
    assert.equal((await f.broker.acquire('local')).token, SEED);
  });
}
test('registration request body is bounded before sending invite', async t => {
  const f = fixture(t); f.config.inviteSecret = 'x'.repeat(16384); delete f.config.sessionToken;
  await assert.rejects(f.broker.acquire('local'), { code: 'CLIENT_PACK_UNAVAILABLE' }); assert.equal(f.calls.length, 0);
});
test('HTTPS dispatch uses normalized saved pin; pin edits stale the binding', async t => {
  const agent = {}; const f = fixture(t, { getPinnedHttpsAgent: async (host, port, pin) => {
    assert.equal(host, 'saved.example'); assert.equal(port, 25566); assert.equal(pin, 'a'.repeat(64)); return agent;
  } });
  f.config.serverProtocol = 'https'; f.config.managementCertFingerprint = Array(32).fill('AA').join(':');
  const seed = await f.broker.acquire('local'); await f.broker.readServerInfo('local'); assert.equal(f.calls[0].agent, agent);
  f.config.managementCertFingerprint = 'b'.repeat(64);
  await assert.rejects(f.broker.readServerInfo('local', { expectedBinding: seed.binding }), { code: 'PLAN_STALE' });
});
test('logical deadline includes slow pinned agent preparation', async t => {
  const f = fixture(t, { getPinnedHttpsAgent: () => new Promise(() => {}) });
  f.config.serverProtocol = 'https'; f.config.managementCertFingerprint = 'a'.repeat(64);
  await assert.rejects(f.broker.readServerInfo('local', { deadline: Date.now() + 30 }), e => e.code === 'CLIENT_PACK_UNAVAILABLE' && e.reason === undefined);
  assert.equal(f.calls.length, 0);
});
test('short shared waiter deadline detaches without cancelling registration peer', async t => {
  const entered = deferred(), release = deferred(); let sharedSignal;
  const f = fixture(t, { requestJson: async (_url, options) => { sharedSignal = options.signal; entered.resolve(); return release.promise; } });
  const seed = await f.broker.acquire('local'); const peer = f.broker.acquire('local', rotate(seed)); await entered.promise;
  await assert.rejects(f.broker.acquire('local', { ...rotate(seed), deadline: Date.now() + 30 }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(sharedSignal.aborted, false); release.resolve({ statusCode: 200, body: { success: true, token: ROTATED } });
  assert.equal((await peer).token, ROTATED);
});
for (const action of ['invalidate', 'dispose']) test(`${action} aborts registration and settles owned waiters`, async t => {
  const entered = deferred(); let sharedSignal; const f = fixture(t, { requestJson: async (_url, options) => {
    sharedSignal = options.signal; entered.resolve(); return new Promise(() => {});
  } });
  const seed = await f.broker.acquire('local'); const pending = f.broker.acquire('local', rotate(seed)); await entered.promise;
  f.broker[action]('local'); await assert.rejects(pending, { code: action === 'dispose' ? 'CANCELLED' : 'PLAN_STALE' });
  assert.equal(sharedSignal.aborted, true);
  if (action === 'dispose') await assert.rejects(f.broker.acquire('local'), { code: 'CANCELLED' });
});
test('conditional rotation requires complete valid generation and revision pair', async t => {
  const f = fixture(t); const seed = await f.broker.acquire('local');
  for (const options of [{ reason: 'explicit-reconnect' }, { ...rotate(seed), observedRevision: -1 },
    { ...rotate(seed), observedRevision: seed.revision + 1 }, { reason: 'unsupported' }]) {
    await assert.rejects(f.broker.acquire('local', options), { code: 'INVALID_REQUEST' });
  }
  assert.equal(f.calls.length, 0);
});
test('cancellation during authority read cannot drop a peer shared registration', async t => {
  const entered = deferred(), release = deferred(), resolving = deferred(); let pauseRead = false, sharedSignal;
  const f = fixture(t, { resolveClient: async id => { if (pauseRead) { resolving.resolve(); return new Promise(() => {}); }
    return { clientId: id, clientPath: path.resolve('synthetic-client') }; },
    requestJson: async (_url, options) => { sharedSignal = options.signal; entered.resolve(); return release.promise; } });
  const seed = await f.broker.acquire('local'); const peer = f.broker.acquire('local', rotate(seed)); await entered.promise;
  pauseRead = true; const controller = new AbortController(); const cancelled = f.broker.acquire('local', { signal: controller.signal });
  await resolving.promise; controller.abort(); await assert.rejects(cancelled, { code: 'CANCELLED' });
  assert.equal(sharedSignal.aborted, false); pauseRead = false;
  release.resolve({ statusCode: 200, body: { success: true, token: ROTATED } }); assert.equal((await peer).token, ROTATED);
});
test('a missing-token registration is the only rotation allowed in one logical safe read', async t => {
  let posts = 0, gets = 0;
  const f = fixture(t, { requestJson: async (_url, options) => {
    if (options.method === 'POST') { posts++; return { statusCode: 200, body: { success: true, token: ROTATED } }; }
    gets++; return { statusCode: 401, body: null };
  } }); delete f.config.sessionToken;
  await assert.rejects(f.broker.readServerInfo('local'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(posts, 1); assert.equal(gets, 1);
});
test('a concurrent replacement binding never receives a token acquired for the old origin', async t => {
  for (let ticks = 0; ticks < 24; ticks++) {
    let reads = 0, replacement = Promise.resolve(); const requests = [];
    const f = fixture(t, { readClientConfig: async () => {
      const saved = { ...f.config };
      if (++reads === 2) {
        let count = ticks;
        const change = () => { if (count-- > 0) { queueMicrotask(change); return; }
          f.config.serverIp = 'replacement.example'; f.config.sessionToken = 'c'.repeat(64);
          f.broker.invalidate('local'); replacement = f.broker.acquire('local').catch(() => {});
        }; queueMicrotask(change);
      }
      return saved;
    }, requestJson: async (url, options) => { requests.push({ url: String(url), token: options.headers['X-Session-Token'] });
      return { statusCode: 200, body: info }; } });
    await f.broker.readServerInfo('local').catch(error => assert.ok(['PLAN_STALE', 'CANCELLED', 'CLIENT_PACK_UNAVAILABLE'].includes(error.code), `timing ${ticks}: ${error.stack}`));
    await replacement;
    assert.equal(requests.some(r => r.url.includes('replacement.example') && r.token === SEED), false, `unsafe dispatch at timing ${ticks}`);
    f.broker.dispose();
  }
});
for (const statusCode of [401, 403, 429, 500]) test(`registration refusal ${statusCode} never retries info or persists auth`, async t => {
  const methods = []; const f = fixture(t, { requestJson: async (_url, options) => {
    methods.push(options.method); return { statusCode: options.method === 'GET' ? 401 : statusCode, body: { error: 'private-invite' } };
  } });
  await assert.rejects(f.broker.readServerInfo('local'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.deepEqual(methods, ['GET', 'POST']); assert.equal(f.writes(), 0);
});
for (const body of ['private-invite', [], null, { padding: 'x'.repeat(MANAGEMENT_INFO_MAX_BYTES) }]) test('invalid or excessive info object cannot trigger registration', async t => {
  let requests = 0; const f = fixture(t, { requestJson: async () => { requests++; return { statusCode: 200, body }; } });
  await assert.rejects(f.broker.readServerInfo('local'), e => e.code === 'CLIENT_PACK_UNAVAILABLE' && e.reason === undefined); assert.equal(requests, 1);
});
for (const extra of [0, 1]) test(`info object boundary at MANAGEMENT_INFO_MAX_BYTES${extra ? ' + 1' : ''}`, async t => {
  const body = { padding: 'x'.repeat(MANAGEMENT_INFO_MAX_BYTES - '{"padding":""}'.length + extra) };
  assert.equal(Buffer.byteLength(JSON.stringify(body)), MANAGEMENT_INFO_MAX_BYTES + extra);
  let requests = 0; const f = fixture(t, { requestJson: async () => { requests++; return { statusCode: 200, body }; } });
  if (extra) await assert.rejects(f.broker.readServerInfo('local'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  else assert.equal((await f.broker.readServerInfo('local')).response, body);
  assert.equal(requests, 1);
});
test('network and pin failures never authorize registration or disclose dependency errors', async t => {
  let requests = 0; const f = fixture(t, { requestJson: async () => { requests++; throw new Error(SEED + 'private-invite'); },
    getPinnedHttpsAgent: async () => { throw new Error(SEED + 'private-invite'); } });
  await assert.rejects(f.broker.readServerInfo('local'), e => e.code === 'CLIENT_PACK_UNAVAILABLE' && !e.cause && !JSON.stringify(e).includes(SEED));
  assert.equal(requests, 1); f.config.serverProtocol = 'https'; f.config.managementCertFingerprint = 'a'.repeat(64);
  await assert.rejects(f.broker.readServerInfo('local'), e => e.code === 'CLIENT_PACK_UNAVAILABLE' && !e.cause && !JSON.stringify(e).includes(SEED));
  assert.equal(requests, 1);
});
test('authority edited while pin agent is preparing refuses dispatch to the old or replacement origin', async t => {
  const entered = deferred(), release = deferred(); const f = fixture(t, { getPinnedHttpsAgent: async () => { entered.resolve(); await release.promise; return {}; } });
  f.config.serverProtocol = 'https'; f.config.managementCertFingerprint = 'a'.repeat(64);
  const pending = f.broker.readServerInfo('local'); await entered.promise; f.config.serverIp = 'replacement.example'; release.resolve();
  await assert.rejects(pending, { code: 'PLAN_STALE' }); assert.equal(f.calls.length, 0);
});
test('injected clock bounds the entire read, including initial saved-config resolution', async t => {
  let now = 1000, reads = 0; const methods = [];
  const f = fixture(t, { clock: () => now, readClientConfig: async () => { if (++reads === 1) now += 20000; return { ...f.config }; },
    requestJson: async (_url, options) => { methods.push(options.method); now += 6000;
      return options.method === 'GET' ? { statusCode: 401, body: null } : { statusCode: 200, body: { success: true, token: ROTATED } }; } });
  await assert.rejects(f.broker.readServerInfo('local'), { code: 'CLIENT_PACK_UNAVAILABLE' }); assert.deepEqual(methods, ['GET', 'POST']);
});
test('canonical equivalent origin and saved seed do not create a new binding', async t => {
  const f = fixture(t); f.config.serverIp = 'SAVED.EXAMPLE'; const seed = await f.broker.acquire('local');
  f.config.serverIp = 'saved.example'; f.config.serverPort = 25566;
  assert.equal((await f.broker.acquire('local', { expectedBinding: seed.binding })).binding, seed.binding);
});
test('pre-aborted callers never dispatch registration or safe reads', async t => {
  const f = fixture(t); delete f.config.sessionToken; const controller = new AbortController(); controller.abort(new Error('private-invite'));
  for (const operation of ['acquire', 'readServerInfo']) await assert.rejects(f.broker[operation]('local', { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(f.calls.length, 0);
});
for (const completion of ['snapshot', 'reject', 'invalid']) {
  test(`late A authority ${completion} cannot evict accepted and renewed B binding`, async t => {
    const entered = deferred(), release = deferred(); let delayNext = false;
    const f = fixture(t, {
      resolveClient: async id => ({ clientId: id, clientPath: path.resolve(`synthetic-${id}`) }),
      readClientConfig: async () => {
        const saved = { ...f.config };
        if (delayNext) {
          delayNext = false; entered.resolve(); await release.promise;
          if (completion === 'reject') throw new Error('private-invite');
          if (completion === 'invalid') delete saved.inviteSecret;
        }
        return saved;
      }
    });
    const a = await f.broker.acquire('local'); delayNext = true;
    const old = f.broker.acquire('local').then(value => ({ value }), error => ({ error })); await entered.promise;
    f.config.serverIp = 'replacement.example'; f.config.sessionToken = 'c'.repeat(64);
    const b = await f.broker.acquire('local'); const renewed = await f.broker.acquire('local', rotate(b));
    release.resolve(); assert.equal((await old).error?.code, 'PLAN_STALE');
    const current = await f.broker.acquire('local', { expectedBinding: b.binding });
    assert.equal(current.binding, b.binding); assert.equal(current.token, ROTATED); assert.equal(current.revision, renewed.revision);
    await assert.rejects(f.broker.acquire('alias'), { code: 'CLIENT_PACK_UNAVAILABLE' });
    await assert.rejects(f.broker.acquire('local', rotate(a)), { code: 'PLAN_STALE' });
    assert.deepEqual(f.calls.map(call => [call.method, call.url]), [['POST', 'http://replacement.example:25566/api/client/register']]);
    assert.equal((await f.broker.acquire('local')).binding, b.binding);
  });
  test(`late A authority ${completion} cannot abort B peer registration`, async t => {
    const entered = deferred(), release = deferred(), registered = deferred(), finishRegistration = deferred();
    let delayNext = false, registrationSignal; const calls = [];
    const f = fixture(t, {
      readClientConfig: async () => {
        const saved = { ...f.config };
        if (delayNext) {
          delayNext = false; entered.resolve(); await release.promise;
          if (completion === 'reject') throw new Error('private-invite');
          if (completion === 'invalid') delete saved.inviteSecret;
        }
        return saved;
      },
      requestJson: async (url, options) => {
        calls.push([options.method, String(url)]); registrationSignal = options.signal; registered.resolve();
        return finishRegistration.promise;
      }
    });
    await f.broker.acquire('local'); delayNext = true;
    const old = f.broker.acquire('local').then(value => ({ value }), error => ({ error })); await entered.promise;
    f.config.serverIp = 'replacement.example'; f.config.sessionToken = 'c'.repeat(64);
    const b = await f.broker.acquire('local');
    const peer = f.broker.acquire('local', rotate(b)).then(value => ({ value }), error => ({ error })); await registered.promise;
    release.resolve(); assert.equal((await old).error?.code, 'PLAN_STALE'); assert.equal(registrationSignal.aborted, false);
    finishRegistration.resolve({ statusCode: 200, body: { success: true, token: ROTATED } });
    const outcome = await peer; assert.equal(outcome.error, undefined); assert.equal(outcome.value.binding, b.binding);
    assert.equal(outcome.value.token, ROTATED); assert.equal(outcome.value.revision, b.revision + 1);
    assert.equal((await f.broker.acquire('local', { expectedBinding: b.binding })).binding, b.binding);
    assert.deepEqual(calls, [['POST', 'http://replacement.example:25566/api/client/register']]);
  });
}
test('simultaneous first acquisitions adopt the same accepted authority and registration', async t => {
  const entered = deferred(), release = deferred(); let posts = 0;
  const f = fixture(t, { requestJson: async () => { posts++; entered.resolve(); await release.promise;
    return { statusCode: 200, body: { success: true, token: ROTATED } }; } }); delete f.config.sessionToken;
  const first = f.broker.acquire('local'); const second = f.broker.acquire('local'); await entered.promise; release.resolve();
  const [a, b] = await Promise.all([first, second]); assert.equal(a.binding, b.binding); assert.equal(a.token, ROTATED);
  assert.equal(b.token, ROTATED); assert.equal(a.revision, b.revision); assert.equal(posts, 1);
});

// Reachability: only an exchange that never received an HTTP status may carry the internal reason.
const unreachable = e => e.code === 'CLIENT_PACK_UNAVAILABLE' && e.reason === 'host-unreachable' && !Object.keys(e).includes('reason') &&
  !JSON.stringify(e).includes('host-unreachable') && !JSON.stringify(e.toPublicResult()).includes('host-unreachable');
const reached = (code = 'CLIENT_PACK_UNAVAILABLE') => e => e.code === code && e.reason === undefined;
const lookupFailure = code => (_hostname, _options, callback) => callback(Object.assign(new Error('synthetic lookup failure'), { code }));
const pinnedAgent = lookup => async () => new https.Agent({ lookup });
async function closedPort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}
function pinnedHttps(f) { f.config.serverProtocol = 'https'; f.config.managementCertFingerprint = 'a'.repeat(64); return f; }
test('refused connections report the internal host-unreachable reason for info reads and registrations', async t => {
  const port = await closedPort();
  for (const seeded of [true, false]) {
    const f = fixture(t, { requestJson: undefined }); f.config.serverIp = '127.0.0.1'; f.config.serverPort = String(port);
    if (!seeded) delete f.config.sessionToken;
    await assert.rejects(f.broker.readServerInfo('local'), unreachable);
  }
});
for (const code of ['ENOTFOUND', 'EAI_AGAIN']) test(`DNS failure ${code} reports the internal host-unreachable reason`, async t => {
  const f = pinnedHttps(fixture(t, { requestJson: undefined, getPinnedHttpsAgent: pinnedAgent(lookupFailure(code)) }));
  await assert.rejects(f.broker.readServerInfo('local'), unreachable);
});
for (const bound of ['attempt', 'caller']) test(`a connect timeout at the ${bound} deadline reports the internal host-unreachable reason`, async t => {
  const f = pinnedHttps(fixture(t, { requestJson: undefined, getPinnedHttpsAgent: pinnedAgent(() => {}), ...(bound === 'attempt' ? { timeoutMs: 40 } : {}) }));
  await assert.rejects(f.broker.readServerInfo('local', bound === 'caller' ? { deadline: Date.now() + 40 } : {}), unreachable);
});
test('a caller deadline while a joined registration is still connecting reports the internal host-unreachable reason', async t => {
  const f = pinnedHttps(fixture(t, { requestJson: undefined, getPinnedHttpsAgent: pinnedAgent(() => {}), timeoutMs: 400 }));
  delete f.config.sessionToken;
  await assert.rejects(f.broker.readServerInfo('local', { deadline: Date.now() + 40 }), unreachable);
});
test('replies with any status and connected but silent hosts never report host-unreachable', async t => {
  const reply = { status: 200, body: '{"clientModpack":null,"clientModpackError":{"code":"CLIENT_PACK_UNAVAILABLE"}}', delay: 0, silent: false };
  const server = http.createServer((_req, res) => {
    if (!reply.silent) setTimeout(() => { res.statusCode = reply.status; res.end(reply.body); }, reply.delay);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const f = fixture(t, { requestJson: undefined, timeoutMs: 400 }); f.config.serverIp = '127.0.0.1'; f.config.serverPort = String(server.address().port);
  // A 200 whose body reports an error is still a reply; classifying it belongs to the pack reader.
  assert.deepEqual((await f.broker.readServerInfo('local')).response, { clientModpack: null, clientModpackError: { code: 'CLIENT_PACK_UNAVAILABLE' } });
  reply.body = 'private-invite'; await assert.rejects(f.broker.readServerInfo('local'), reached());
  Object.assign(reply, { status: 500, body: '{}' }); await assert.rejects(f.broker.readServerInfo('local'), reached());
  Object.assign(reply, { status: 200, body: '{"clientModpack":null}', delay: 100 });
  assert.deepEqual((await f.broker.readServerInfo('local')).response, { clientModpack: null });
  reply.silent = true;
  await assert.rejects(f.broker.readServerInfo('local'), reached());
  await assert.rejects(f.broker.readServerInfo('local', { deadline: Date.now() + 300 }), reached());
});
for (const action of ['abort', 'invalidate']) test(`${action} while connecting never reports host-unreachable`, async t => {
  let connecting; const started = new Promise(resolve => { connecting = resolve; });
  const f = pinnedHttps(fixture(t, { requestJson: undefined, getPinnedHttpsAgent: pinnedAgent(() => connecting()) }));
  const controller = new AbortController(); const pending = f.broker.readServerInfo('local', { signal: controller.signal });
  await started; if (action === 'abort') controller.abort(); else f.broker.invalidate('local');
  await assert.rejects(pending, reached(action === 'abort' ? 'CANCELLED' : 'PLAN_STALE'));
});
test('a deadline is classified only from the progress the transport reported', async t => {
  for (const [stages, expected] of [[[], reached()], [['connecting'], unreachable], [['connecting', 'connected'], reached()]]) {
    const f = fixture(t, { timeoutMs: 30, requestJson: async (_url, options) => { for (const stage of stages) options.onProgress(stage); return new Promise(() => {}); } });
    await assert.rejects(f.broker.readServerInfo('local'), expected);
  }
});
