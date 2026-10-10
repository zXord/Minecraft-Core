const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { requestManagementJson } = require('../electron/services/management-session-transport.cjs');
const { ManagementSessionBroker } = require('../electron/services/management-session-broker.cjs');
async function fixture(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return new URL(`http://127.0.0.1:${server.address().port}/api/server/info`);
}
const options = { method: 'GET', timeoutMs: 200, maxBytes: 1024 };
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
  await assert.rejects(requestManagementJson(url, { ...options, headers: { 'X-Session-Token': 'synthetic-secret' } }), e => e.code === 'CLIENT_PACK_UNAVAILABLE' && !JSON.stringify(e).includes('synthetic-secret'));
  assert.equal(forwarded, 0);
});
for (const statusCode of [401, 403, 429, 500]) test(`HTTP ${statusCode} exposes status but never arbitrary remote text`, async t => {
  const url = await fixture(t, (_req, res) => { res.statusCode = statusCode; res.end('private-invite'); });
  assert.deepEqual(await requestManagementJson(url, options), { statusCode, body: null });
});
for (const body of ['not JSON private-invite', 'x'.repeat(1025)]) test('malformed or oversized body refuses with a sanitized error', async t => {
  const url = await fixture(t, (_req, res) => res.end(body));
  await assert.rejects(requestManagementJson(url, options), e => e.code === 'CLIENT_PACK_UNAVAILABLE' && !e.cause && !JSON.stringify(e).includes('private-invite'));
});
test('whole-response timeout includes slowly streaming body', async t => {
  const url = await fixture(t, (_req, res) => { res.write('{'); });
  await assert.rejects(requestManagementJson(url, { ...options, timeoutMs: 30 }), { code: 'CLIENT_PACK_UNAVAILABLE' });
});
test('abort settles promptly and never exposes abort reason', async t => {
  const arrived = new Promise(resolve => { t.arrived = resolve; });
  const url = await fixture(t, () => t.arrived()); const controller = new AbortController();
  const pending = requestManagementJson(url, { ...options, signal: controller.signal }); await arrived; controller.abort(new Error('private-invite'));
  await assert.rejects(pending, e => e.code === 'CANCELLED' && !JSON.stringify(e).includes('private-invite'));
});
test('invalid transport protocol, method, budget and excessive request body never dispatch', async () => {
  for (const [url, changes] of [['file:///secret', {}], ['http://user:secret@127.0.0.1', {}], ['http://127.0.0.1', { method: 'DELETE' }],
    ['http://127.0.0.1', { timeoutMs: 0 }], ['http://127.0.0.1', { maxBytes: 0 }], ['http://127.0.0.1', { method: 'POST', body: 'x'.repeat(16385) }]]) {
    await assert.rejects(requestManagementJson(url, { ...options, ...changes }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  }
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
