const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { ManagementPackClient } = require('../../electron/services/client-modpacks/management-pack-client.cjs');
const { ManagementSessionBroker } = require('../../electron/services/management-session-broker.cjs');
const { MANAGEMENT_INFO_MAX_BYTES } = require('../../electron/services/management-session-transport.cjs');
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' };
const descriptor = { schemaVersion: 1, status: 'ready', serverFingerprint: 'a'.repeat(64), serverVersion: 'v1', source: { provider: 'modrinth', projectId: 'p', versionId: 'v' }, artifactSha256: 'b'.repeat(64), runtime };
async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { serverProtocol: 'http', serverIp: '127.0.0.1', serverPort: server.address().port, sessionToken: 'secret-token', clientId: 'remote', clientName: 'Synthetic client', inviteSecret: 'synthetic-invite' };
  const broker = new ManagementSessionBroker({ resolveClient: async id => id === 'registered' ? { clientId: id, clientPath: 'private-path' } : null, readClientConfig: async () => config, timeoutMs: 60 });
  t.after(() => broker.dispose()); const client = new ManagementPackClient({ sessionBroker: broker });
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
  const padding = 'x'.repeat(MANAGEMENT_INFO_MAX_BYTES - '{"clientModpack":null,"padding":""}'.length + 1);
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ clientModpack: null, padding })));
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
  const broker = new ManagementSessionBroker({ resolveClient: async id => ({ clientId: id, clientPath: 'registered' }),
    readClientConfig: async () => ({ serverProtocol: 'https', serverIp: 'saved.example', serverPort: 25566, sessionToken: 'secret', managementCertFingerprint: 'a'.repeat(64), clientId: 'remote', clientName: 'Synthetic', inviteSecret: 'synthetic' }),
    getPinnedHttpsAgent: async (host, port, fingerprint) => { assert.equal(host, 'saved.example'); assert.equal(port, 25566); assert.equal(fingerprint, 'a'.repeat(64)); throw new Error('pin mismatch'); },
    requestJson: async () => { requests++; return { statusCode: 200, body: { clientModpack: descriptor } }; }
  });
  const client = new ManagementPackClient({ sessionBroker: broker });
  await assert.rejects(client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' }); assert.equal(requests, 0);
});
test('explicit companion failure cannot be interpreted as an unmanaged server', async t => {
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ clientModpack: null,
    clientModpackError: { code: 'CLIENT_PACK_UNAVAILABLE', message: 'Unavailable' } })));
  await assert.rejects(f.client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' });
});

test('known drift error refuses requirement and launch using local guidance, never remote message', async t => {
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ clientModpack: null,
    clientModpackError: { code: 'CLIENT_PACK_SERVER_CHANGED', message: 'C:\\private token=secret run-command' } })));
  for (const read of [() => f.client.getRequirement('registered'), () => f.client.getLaunchConnection('registered')]) {
    await assert.rejects(read(), error => error.code === 'CLIENT_PACK_SERVER_CHANGED' && /Use Modpack Verify and Repair/.test(error.message) && !error.message.includes('secret'));
  }
});

test('unknown remote error codes remain generic refusal and authenticated unmanaged stays null', async t => {
  let failure = { code: 'REMOTE_COMMAND', message: 'run secret' };
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ clientModpack: null, ...(failure ? { clientModpackError: failure } : {}) })));
  await assert.rejects(f.client.getRequirement('registered'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  failure = null; assert.equal(await f.client.getRequirement('registered'), null);
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
test('launch uses only broker contract and one deadline across info and origin acquisition', async () => {
  const binding = Object.freeze({ generation: 'launch' }); const seen = []; let now = 1000;
  const sessionBroker = {
    async readServerInfo(_id, options) { seen.push(options); now += 25000; return { response: { clientModpack: descriptor, minecraftPort: 25575 }, binding }; },
    async acquire(_id, options) { seen.push(options); return { baseOrigin: 'https://saved.example:25566', binding }; }
  };
  const client = new ManagementPackClient({ sessionBroker, clock: () => now });
  assert.deepEqual(await client.getLaunchConnection('registered', descriptor, { expectedBinding: binding }), { serverIp: 'saved.example', serverPort: 25575 });
  assert.equal(seen[0].deadline, 31000); assert.equal(seen[1].deadline, 31000); assert.equal(seen[1].expectedBinding, binding);
  now = 1000; seen.length = 0;
  await client.getLaunchConnection('registered', descriptor, { expectedBinding: binding, deadline: 2000 });
  assert.equal(seen[0].deadline, 2000); assert.equal(seen[1].deadline, 2000);
  now = 1000; seen.length = 0;
  await client.getLaunchConnection('registered', descriptor);
  assert.equal(seen[0].expectedBinding, undefined);
  assert.equal(seen[1].expectedBinding, binding, 'the origin is pinned to the read that verified the pack and its port');
});

test('a launch connection without a caller binding refuses a saved connection that changed after the pack was verified', async t => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ clientModpack: descriptor, minecraftPort: '25575' })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { serverProtocol: 'http', serverIp: '127.0.0.1', serverPort: server.address().port, sessionToken: 'secret-token', clientId: 'remote', clientName: 'Synthetic client', inviteSecret: 'synthetic-invite' };
  const broker = new ManagementSessionBroker({ resolveClient: async id => ({ clientId: id, clientPath: 'private-path' }), readClientConfig: async () => ({ ...config }) });
  t.after(() => broker.dispose());
  const sessionBroker = {
    async readServerInfo(id, options) {
      const result = await broker.readServerInfo(id, options);
      config.serverIp = 'replacement.example'; // The user saves a different host between the read and the acquire.
      return result;
    },
    acquire: (id, options) => broker.acquire(id, options)
  };
  const client = new ManagementPackClient({ sessionBroker });
  await assert.rejects(client.getLaunchConnection('registered', { serverFingerprint: descriptor.serverFingerprint, artifactSha256: descriptor.artifactSha256 }),
    { code: 'PLAN_STALE' });
  config.serverIp = '127.0.0.1';
  assert.deepEqual(await new ManagementPackClient({ sessionBroker: broker }).getLaunchConnection('registered',
    { serverFingerprint: descriptor.serverFingerprint, artifactSha256: descriptor.artifactSha256 }), { serverIp: '127.0.0.1', serverPort: 25575 });
});

// The exact /api/server/info key set a v26.6.1 host sends: it predates matching client packs.
const v2661Info = () => ({ success: true, instanceId: 'server-one', serverPath: 'C:\\Servers\\One', serverProperties: { 'server-port': '25565' },
  minecraftPort: '25565', minecraftServerStatus: 'running', minecraftVersion: '1.20.1', loaderType: 'forge', loaderVersion: '47.3.12',
  requiredMods: [], allClientMods: [], appVersion: '26.6.1', serverInfo: { name: 'Server', maxPlayers: 20, gamemode: 'survival', difficulty: 'normal' } });
const brokerReplying = response => ({ async readServerInfo() { return { response, binding: Object.freeze({ generation: 'info' }) }; }, async acquire() { assert.fail('no session'); } });

test('a host that predates matching client packs publishes no requirement (A33)', async () => {
  const client = new ManagementPackClient({ sessionBroker: brokerReplying(v2661Info()) });
  const read = await client.readRequirement('registered');
  assert.equal(read.descriptor, null); assert.equal(read.legacyHost, true); assert.equal(read.binding.generation, 'info');
  assert.equal(await client.getRequirement('registered'), null);
  await assert.rejects(client.getLaunchConnection('registered', descriptor), { code: 'PLAN_STALE' });
  const current = await new ManagementPackClient({ sessionBroker: brokerReplying({ ...v2661Info(), clientModpack: null }) }).readRequirement('registered');
  assert.equal(current.descriptor, null); assert.equal(current.legacyHost, undefined, 'a current host answering null is not a legacy host');
});

test('replies that are neither a legacy host nor a valid requirement are refused', async () => {
  const { success, ...withoutSuccess } = v2661Info(); assert.equal(success, true);
  for (const response of [{ appVersion: '26.6.1' }, withoutSuccess, { ...v2661Info(), success: false }, { ...v2661Info(), success: 'true' },
    { success: true, clientModpackError: { code: 'CLIENT_PACK_UNAVAILABLE', message: 'Unavailable' } },
    { success: true, clientModpackError: { code: 'CLIENT_PACK_SERVER_CHANGED', message: 'Changed' } },
    { ...v2661Info(), clientModpack: { status: 'ready' } }]) {
    await assert.rejects(new ManagementPackClient({ sessionBroker: brokerReplying(response) }).readRequirement('registered'),
      error => ['CLIENT_PACK_UNAVAILABLE', 'CLIENT_PACK_SERVER_CHANGED'].includes(error.code), JSON.stringify(response).slice(0, 80));
  }
});

test('the requirement reader accepts the full server info budget and refuses one byte more (A34)', async () => {
  for (const extra of [0, 1]) {
    const response = { success: true, clientModpack: null, padding: '' };
    response.padding = 'x'.repeat(MANAGEMENT_INFO_MAX_BYTES - Buffer.byteLength(JSON.stringify(response)) + extra);
    assert.equal(Buffer.byteLength(JSON.stringify(response)), MANAGEMENT_INFO_MAX_BYTES + extra);
    const read = new ManagementPackClient({ sessionBroker: brokerReplying(response) }).readRequirement('registered');
    if (extra) await assert.rejects(read, { code: 'CLIENT_PACK_UNAVAILABLE' }); else assert.equal((await read).descriptor, null);
  }
});

test('server info listing about 1000 client mods passes the real broker, transport and requirement reader (A34)', async t => {
  const mods = Array.from({ length: 1000 }, (_, index) => ({ fileName: `synthetic-forge-mod-${String(index).padStart(4, '0')}-1.20.1-47.3.12.jar`,
    checksum: 'f'.repeat(32), size: 123456, required: true, downloadUrl: `/api/mods/download/client/synthetic-forge-mod-${index}.jar`,
    name: `Synthetic mod ${index}`, versionNumber: '1.0.0', projectId: `project${index}` }));
  const body = JSON.stringify({ ...v2661Info(), requiredMods: mods, allClientMods: mods });
  assert.ok(Buffer.byteLength(body) > 512 * 1024, 'well above the old 256 KiB cap');
  const legacy = await fixture(t, (_req, res) => res.end(body));
  const read = await legacy.client.readRequirement('registered');
  assert.equal(read.descriptor, null); assert.equal(read.legacyHost, true);
  const managedBody = JSON.stringify({ ...JSON.parse(body), clientModpack: descriptor });
  const managed = await fixture(t, (_req, res) => res.end(managedBody));
  assert.deepEqual(await managed.client.getRequirement('registered'), descriptor);
});

test('only an unreachable host reason crosses the requirement reader, and never into public results', async () => {
  const unreachable = Object.defineProperty(new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The management session is unavailable'), 'reason', { value: 'host-unreachable' });
  const failing = cause => new ManagementPackClient({ sessionBroker: { async readServerInfo() { throw cause; }, async acquire() { throw cause; } } });
  await assert.rejects(failing(unreachable).readRequirement('registered'), error => {
    assert.equal(error.code, 'CLIENT_PACK_UNAVAILABLE'); assert.equal(error.reason, 'host-unreachable'); assert.notEqual(error, unreachable);
    assert.equal(Object.keys(error).includes('reason'), false);
    assert.equal(JSON.stringify(error.toPublicResult()).includes('host-unreachable'), false);
    return true;
  });
  await assert.rejects(failing(new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The management session is unavailable')).readRequirement('registered'),
    error => error.code === 'CLIENT_PACK_UNAVAILABLE' && error.reason === undefined);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(failing(unreachable).readRequirement('registered', { signal: controller.signal }), error => error.code === 'CANCELLED' && error.reason === undefined);
  await assert.rejects(new ManagementPackClient({ sessionBroker: brokerReplying({ success: true, clientModpack: null, clientModpackError: { code: 'X' } }) })
    .readRequirement('registered'), error => error.code === 'CLIENT_PACK_UNAVAILABLE' && error.reason === undefined);
});
