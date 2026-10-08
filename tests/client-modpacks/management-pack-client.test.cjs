const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ManagementPackClient } = require('../../electron/services/client-modpacks/management-pack-client.cjs');
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' };
const descriptor = { schemaVersion: 1, status: 'ready', serverFingerprint: 'a'.repeat(64), serverVersion: 'v1', source: { provider: 'modrinth', projectId: 'p', versionId: 'v' }, artifactSha256: 'b'.repeat(64), runtime };
async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { serverProtocol: 'http', serverIp: '127.0.0.1', serverPort: server.address().port, sessionToken: 'secret-token' };
  const client = new ManagementPackClient({ resolveClient: async id => id === 'registered' ? { clientId: id, clientPath: 'private-path' } : null, readClientConfig: async () => config, timeoutMs: 60 });
  return { client, config };
}
test('saved exact origin receives authentication and returns validated descriptor', async t => {
  const f = await fixture(t, (req, res) => {
    assert.equal(req.url, '/api/server/info'); assert.equal(req.headers['x-session-token'], 'secret-token');
    res.end(JSON.stringify({ clientModpack: descriptor }));
  });
  assert.deepEqual(await f.client.getRequirement('registered'), descriptor);
  await assert.rejects(f.client.getRequirement({ clientId: 'registered', source: descriptor.source }), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.client.getRequirement('unknown'), { code: 'INVALID_REQUEST' });
});
test('redirect is never followed or sent credentials', async t => {
  let forwarded = 0;
  const f = await fixture(t, (req, res) => { if (req.url !== '/api/server/info') forwarded++; res.writeHead(302, { Location: '/steal' }); res.end(); });
  await assert.rejects(f.client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(forwarded, 0);
});
test('oversized response and hanging response fail boundedly', async t => {
  const f = await fixture(t, (_req, res) => res.end('x'.repeat(256 * 1024 + 1)));
  await assert.rejects(f.client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  const hanging = await fixture(t, () => {});
  await assert.rejects(hanging.client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' });
});
test('HTTPS without saved TLS pin never dispatches request', async t => {
  const f = await fixture(t, () => assert.fail('must not request'));
  f.config.serverProtocol = 'https';
  await assert.rejects(f.client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' });
});
for (const mutation of [d => { d.serverFingerprint = 'bad'; }, d => { d.artifactSha256 = 'bad'; }, d => { d.runtime.javaMajor = 0; }, d => { d.source.url = 'https://evil'; }]) {
  test('malformed management authority is rejected', async t => {
    const broken = structuredClone(descriptor); mutation(broken);
    const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ clientModpack: broken })));
    await assert.rejects(f.client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  });
}
test('HTTPS pin failure cannot fall back to an unpinned transport', async () => {
  let requests = 0;
  const client = new ManagementPackClient({ resolveClient: async id => ({ clientId: id, clientPath: 'registered' }),
    readClientConfig: async () => ({ serverProtocol: 'https', serverIp: 'saved.example', serverPort: 25566, sessionToken: 'secret', managementCertFingerprint: 'a'.repeat(64) }),
    getPinnedHttpsAgent: async (host, port, fingerprint) => { assert.equal(host, 'saved.example'); assert.equal(port, 25566); assert.equal(fingerprint, 'a'.repeat(64)); throw new Error('pin mismatch'); },
    fetchJson: async () => { requests++; return { clientModpack: descriptor }; }
  });
  await assert.rejects(client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' }); assert.equal(requests, 0);
});
test('explicit companion failure cannot be interpreted as an unmanaged server', async t => {
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ clientModpack: null,
    clientModpackError: { code: 'CLIENT_PACK_UNAVAILABLE', message: 'Unavailable' } })));
  await assert.rejects(f.client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' });
});
test('launch connection uses saved host and authenticated game port bound to exact companion', async t => {
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ clientModpack: descriptor, minecraftPort: '25575' })));
  assert.deepEqual(await f.client.getLaunchConnection('registered', { serverFingerprint: descriptor.serverFingerprint,
    artifactSha256: descriptor.artifactSha256 }), { serverIp: '127.0.0.1', serverPort: 25575 });
  await assert.rejects(f.client.getLaunchConnection('registered', { serverFingerprint: 'c'.repeat(64), artifactSha256: descriptor.artifactSha256 }), { code: 'PLAN_STALE' });
});
test('aborted request returns cancellation without disclosing saved connection details', async t => {
  const f = await fixture(t, () => {}); const controller = new AbortController();
  const operation = f.client.getRequirement('registered', { signal: controller.signal }); controller.abort();
  await assert.rejects(operation, error => error.code === 'CANCELLED' && !error.message.includes('secret-token') && !error.message.includes('127.0.0.1'));
});
