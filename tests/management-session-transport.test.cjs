const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const selfsigned = require('selfsigned');
const { requestManagementJson, MANAGEMENT_INFO_MAX_BYTES, HOST_UNREACHABLE_REASON } = require('../electron/services/management-session-transport.cjs');
const { ManagementSessionBroker } = require('../electron/services/management-session-broker.cjs');
async function fixture(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return new URL(`http://127.0.0.1:${server.address().port}/api/server/info`);
}
const options = { method: 'GET', timeoutMs: 200, maxBytes: 1024 };
// The reachability reason is internal: never enumerable, serialized or public.
const unreachable = e => e.code === 'CLIENT_PACK_UNAVAILABLE' && e.reason === 'host-unreachable' && !Object.keys(e).includes('reason') &&
  !JSON.stringify(e).includes('host-unreachable') && !JSON.stringify(e.toPublicResult()).includes('host-unreachable');
const reached = (code = 'CLIENT_PACK_UNAVAILABLE') => e => e.code === code && e.reason === undefined;
const lookupAgent = (lookup, Agent = http.Agent) => new Agent({ lookup });
const lookupFailure = code => (_hostname, _options, callback) => callback(Object.assign(new Error('synthetic lookup failure'), { code }));
async function closedPort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}
let certificate;
const localCertificate = () => (certificate ??= selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048, algorithm: 'sha256' }));
async function tlsFixture(t, handler) {
  const generated = await localCertificate(); const server = https.createServer({ key: generated.private, cert: generated.cert }, handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  return `https://127.0.0.1:${server.address().port}/api/server/info`;
}
async function rawFixture(t, onConnection) {
  const server = net.createServer(onConnection); const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return server.address().port;
}
test('real HTTP transmits exact safe GET and registration POST bytes and headers', async t => {
  const seen = []; const url = await fixture(t, (req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, token: req.headers['x-session-token'], type: req.headers['content-type'], body: Buffer.concat(chunks).toString() });
      res.end('{"success":true}');
    });
  });
  assert.deepEqual(await requestManagementJson(url, { ...options, headers: { 'X-Session-Token': 'synthetic-token' } }), { statusCode: 200, body: { success: true } });
  await requestManagementJson(new URL('/api/client/register', url), { ...options, method: 'POST', body: '{"clientId":"synthetic","secret":"synthetic-invite"}', headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(seen, [{ method: 'GET', url: '/api/server/info', token: 'synthetic-token', type: undefined, body: '' },
    { method: 'POST', url: '/api/client/register', token: undefined, type: 'application/json', body: '{"clientId":"synthetic","secret":"synthetic-invite"}' }]);
});
test('redirect refusal never follows location or forwards credentials', async t => {
  let forwarded = 0; const receiver = await fixture(t, (_req, res) => { forwarded++; res.end('{}'); });
  const url = await fixture(t, (_req, res) => { res.writeHead(302, { Location: String(receiver) }); res.end('synthetic-secret'); });
  await assert.rejects(requestManagementJson(url, { ...options, headers: { 'X-Session-Token': 'synthetic-secret' } }), e => reached()(e) && !JSON.stringify(e).includes('synthetic-secret'));
  assert.equal(forwarded, 0);
});
for (const statusCode of [401, 403, 429, 500]) test(`HTTP ${statusCode} exposes status but never arbitrary remote text`, async t => {
  const url = await fixture(t, (_req, res) => { res.statusCode = statusCode; res.end('private-invite'); });
  assert.deepEqual(await requestManagementJson(url, options), { statusCode, body: null });
});
for (const body of ['not JSON private-invite', 'x'.repeat(1025)]) test('malformed or oversized body refuses with a sanitized error', async t => {
  const url = await fixture(t, (_req, res) => res.end(body));
  await assert.rejects(requestManagementJson(url, options), e => reached()(e) && !e.cause && !JSON.stringify(e).includes('private-invite'));
});
test('whole-response timeout includes slowly streaming body', async t => {
  const url = await fixture(t, (_req, res) => { res.write('{'); });
  await assert.rejects(requestManagementJson(url, { ...options, timeoutMs: 30 }), reached());
});
test('abort settles promptly and never exposes abort reason', async t => {
  const arrived = new Promise(resolve => { t.arrived = resolve; });
  const url = await fixture(t, () => t.arrived()); const controller = new AbortController();
  const pending = requestManagementJson(url, { ...options, signal: controller.signal }); await arrived; controller.abort(new Error('private-invite'));
  await assert.rejects(pending, e => reached('CANCELLED')(e) && !JSON.stringify(e).includes('private-invite'));
});
test('invalid transport protocol, method, budget, observer and excessive request body never dispatch', async t => {
  let requests = 0; const url = await fixture(t, (_req, res) => { requests++; res.end('{}'); });
  for (const [target, changes] of [['file:///secret', {}], ['http://user:secret@127.0.0.1', {}], [url, { method: 'DELETE' }],
    [url, { timeoutMs: 0 }], [url, { maxBytes: 0 }], [url, { maxBytes: MANAGEMENT_INFO_MAX_BYTES + 1 }], [url, { onProgress: 'connected' }],
    [url, { method: 'POST', body: 'x'.repeat(16385) }]]) {
    await assert.rejects(requestManagementJson(target, { ...options, ...changes }), reached());
  }
  assert.equal(requests, 0);
});
test('server info ceiling is 8 MiB while the default and registration body limits are unchanged', async t => {
  assert.equal(MANAGEMENT_INFO_MAX_BYTES, 8 * 1024 * 1024); assert.equal(HOST_UNREACHABLE_REASON, 'host-unreachable');
  const size = { value: 0 }; const url = await fixture(t, (_req, res) => res.end(`"${'x'.repeat(size.value - 2)}"`));
  for (const [maxBytes, bytes, accepted] of [[MANAGEMENT_INFO_MAX_BYTES, MANAGEMENT_INFO_MAX_BYTES, true], [MANAGEMENT_INFO_MAX_BYTES, MANAGEMENT_INFO_MAX_BYTES + 1, false],
    [undefined, 262144, true], [undefined, 262145, false]]) {
    size.value = bytes; const pending = requestManagementJson(url, { method: 'GET', timeoutMs: 5000, ...(maxBytes ? { maxBytes } : {}) });
    if (accepted) assert.equal((await pending).body.length, bytes - 2); else await assert.rejects(pending, reached());
  }
  const posted = []; const registration = await fixture(t, (req, res) => { let length = 0; req.on('data', chunk => { length += chunk.length; }); req.on('end', () => { posted.push(length); res.end('{}'); }); });
  await requestManagementJson(registration, { ...options, method: 'POST', body: 'x'.repeat(16384) }); assert.deepEqual(posted, [16384]);
});
test('a refused connection reports the internal host-unreachable reason', async () => {
  const port = await closedPort(); const stages = [];
  await assert.rejects(requestManagementJson(`http://127.0.0.1:${port}/api/server/info`, { ...options, onProgress: stage => stages.push(stage) }), unreachable);
  assert.equal(stages.includes('responded'), false);
});
for (const code of ['ENOTFOUND', 'EAI_AGAIN']) test(`DNS failure ${code} reports the internal host-unreachable reason`, async () => {
  await assert.rejects(requestManagementJson('http://synthetic.invalid:8080/api/server/info', { ...options, agent: lookupAgent(lookupFailure(code)) }), unreachable);
  await assert.rejects(requestManagementJson('https://synthetic.invalid:8443/api/server/info', { ...options, agent: lookupAgent(lookupFailure(code), https.Agent) }), unreachable);
});
test('a connect timeout before any status reports the internal host-unreachable reason', async () => {
  const stages = [];
  await assert.rejects(requestManagementJson('http://synthetic.invalid:8080/api/server/info', { ...options, timeoutMs: 40,
    agent: lookupAgent(() => {}), onProgress: stage => stages.push(stage) }), unreachable);
  assert.deepEqual(stages, ['connecting']);
});
test('a TLS handshake that never completes reports the internal host-unreachable reason', async t => {
  let connections = 0; const port = await rawFixture(t, () => { connections++; }); const stages = [];
  await assert.rejects(requestManagementJson(`https://127.0.0.1:${port}/api/server/info`, { ...options, timeoutMs: 300,
    agent: new https.Agent({ rejectUnauthorized: false }), onProgress: stage => stages.push(stage) }), unreachable);
  assert.equal(connections, 1); assert.deepEqual(stages, ['connecting']);
});
test('a reset before any status reports the internal host-unreachable reason', async t => {
  const url = await fixture(t, req => req.socket.destroy()); const stages = [];
  await assert.rejects(requestManagementJson(url, { ...options, timeoutMs: 5000, onProgress: stage => stages.push(stage) }), unreachable);
  assert.deepEqual(stages, ['connecting', 'connected']);
});
test('a connected host that stays silent never reports host-unreachable', async t => {
  const url = await fixture(t, () => {}); const stages = [];
  await assert.rejects(requestManagementJson(url, { ...options, timeoutMs: 300, onProgress: stage => stages.push(stage) }), reached());
  assert.deepEqual(stages, ['connecting', 'connected']);
  const secure = await tlsFixture(t, () => {}); const secureStages = [];
  await assert.rejects(requestManagementJson(secure, { ...options, timeoutMs: 1000,
    agent: new https.Agent({ rejectUnauthorized: false }), onProgress: stage => secureStages.push(stage) }), reached());
  assert.deepEqual(secureStages, ['connecting', 'connected']);
});
test('a certificate the client refuses is not reported as unreachable', async t => {
  const secure = await tlsFixture(t, (_req, res) => res.end('{}'));
  await assert.rejects(requestManagementJson(secure, { ...options, timeoutMs: 5000, agent: new https.Agent({ rejectUnauthorized: true }) }), reached());
});
test('progress is observed once per stage, reused sockets start connected and observers cannot break the exchange', async t => {
  const url = await fixture(t, (_req, res) => res.end('{"success":true}')); const agent = new http.Agent({ keepAlive: true }); t.after(() => agent.destroy());
  const first = [], second = [];
  assert.deepEqual((await requestManagementJson(url, { ...options, agent, onProgress: stage => first.push(stage) })).body, { success: true });
  assert.deepEqual((await requestManagementJson(url, { ...options, agent, onProgress: stage => second.push(stage) })).body, { success: true });
  assert.deepEqual(first, ['connecting', 'connected', 'responded']); assert.deepEqual(second, ['connected', 'responded']);
  assert.deepEqual((await requestManagementJson(url, { ...options, onProgress: () => { throw new Error('observer failure'); } })).body, { success: true });
});
test('real broker and default HTTP transport recover while exact saved config bytes stay unchanged', async t => {
  const methods = [], seed = 'a'.repeat(64), token = 'b'.repeat(64);
  const url = await fixture(t, (req, res) => {
    methods.push(req.method);
    if (req.method === 'POST') {
      assert.equal(req.url, '/api/client/register'); assert.equal(req.headers['x-session-token'], undefined);
      const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { clientId: 'remote', name: 'Synthetic', secret: 'synthetic-invite' });
        res.end(JSON.stringify({ success: true, token }));
      }); return;
    }
    assert.equal(req.url, '/api/server/info');
    if (req.headers['x-session-token'] === seed) { res.writeHead(401); res.end('private-invite'); return; }
    assert.equal(req.headers['x-session-token'], token); res.end('{"clientModpack":null,"minecraftPort":25565}');
  });
  const configBytes = Buffer.from(JSON.stringify({ serverProtocol: 'http', serverIp: '127.0.0.1', serverPort: url.port,
    clientId: 'remote', clientName: 'Synthetic', inviteSecret: 'synthetic-invite', sessionToken: seed }, null, 2));
  const original = Buffer.from(configBytes); let writes = 0;
  const broker = new ManagementSessionBroker({ resolveClient: async id => ({ clientId: id, clientPath: path.resolve('synthetic-loopback-client') }),
    readClientConfig: async () => JSON.parse(configBytes), writeClientConfig: () => { writes++; }, timeoutMs: 500 });
  t.after(() => broker.dispose());
  const initial = await broker.acquire('local'); const result = await broker.readServerInfo('local', { expectedBinding: initial.binding });
  assert.deepEqual(result.response, { clientModpack: null, minecraftPort: 25565 }); assert.equal(result.binding, initial.binding);
  assert.equal((await broker.acquire('local')).token, token); assert.deepEqual(methods, ['GET', 'POST', 'GET']);
  assert.deepEqual(configBytes, original); assert.equal(writes, 0);
});
