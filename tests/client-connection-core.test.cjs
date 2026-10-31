const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createClientConnectionCore } = require('../electron/bootstrap/create-client-connection-core.cjs');

// Client folders are only named here: the core reads each one's connection through
// the injected readClientConfig, never from disk.
const root = path.join(os.tmpdir(), `client-connection-core-${crypto.randomUUID()}`);

// A management host on loopback. It registers a remote client on every POST
// /api/client/register and answers GET /api/server/info only for a token it issued.
async function startHost(t) {
  const host = { port: 0, registrations: [], infoTokens: [] };
  const tokens = new Set();
  const server = http.createServer((request, response) => {
    const reply = (statusCode, body) => {
      response.writeHead(statusCode, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'POST' && request.url === '/api/client/register') {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const token = crypto.randomBytes(32).toString('hex');
        host.registrations.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).clientId);
        tokens.add(token);
        reply(200, { success: true, token });
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/api/server/info') {
      const token = request.headers['x-session-token'];
      host.infoTokens.push(token);
      if (tokens.has(token)) reply(200, { success: true, clientModpack: null, minecraftPort: 25565 });
      else reply(401, { success: false });
      return;
    }
    reply(404, { success: false });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  host.port = server.address().port;
  return host;
}

// A client registration as v26.6.1 saved it.
function client(id, folder) {
  return { id, clientId: id, name: id, clientName: id, type: 'client', path: folder };
}

// remoteIds maps each folder to the remote client id its client-config.json holds.
// No folder has a saved session token, so every new session registers with the host.
function connectionCore(t, host, instances, remoteIds) {
  let storeReads = 0;
  const core = createClientConnectionCore({
    store: { get(key) { storeReads += 1; return key === 'instances' ? instances : undefined; } },
    readClientConfig: async clientPath => ({ serverProtocol: 'http', serverIp: '127.0.0.1', serverPort: String(host.port),
      clientId: remoteIds.get(path.resolve(clientPath)), clientName: 'Friend', inviteSecret: 'synthetic-invite' }),
    clock: { now: () => Date.now() },
    randomUUID: crypto.randomUUID
  });
  t.after(() => core.dispose());
  assert.equal(storeReads, 0, 'construction reads nothing');
  return core;
}

for (const order of ['b-client listed first', 'a-client listed first']) {
  test(`every registration of one client folder shares one host session (${order}, v26.6.1 parity)`, async t => {
    const host = await startHost(t);
    const folder = path.join(root, 'Client');
    const registrations = [client('b-client', folder), client('a-client', folder)];
    const core = connectionCore(t, host, order === 'b-client listed first' ? registrations : registrations.reverse(),
      new Map([[folder, 'remote-friend']]));

    // The renderer acquires the session of the registration it shows.
    const renderer = await core.managementSessionBroker.acquireWithProvenance('b-client');
    assert.equal(renderer.registrationAttempted, true);
    // Launch and the legacy reads resolve the folder to its lowest id and share that session.
    const legacy = await core.acquireLegacyManagementContext(folder);
    assert.equal(legacy.sessionToken, renderer.snapshot.token);
    assert.equal(legacy.bindingGeneration, renderer.snapshot.bindingGeneration);
    const info = await core.managementSessionBroker.readServerInfo('a-client');
    assert.equal(info.response.success, true);
    assert.equal(info.binding, renderer.snapshot.binding);

    assert.deepEqual(host.registrations, ['remote-friend']);
    assert.deepEqual(host.infoTokens, [renderer.snapshot.token]);
  });
}

test('different client folders keep separate sessions, nested folders included', async t => {
  const host = await startHost(t);
  const outer = path.join(root, 'Client');
  const inner = path.join(outer, 'Second');
  const core = connectionCore(t, host, [client('client-outer', outer), client('client-inner', inner)],
    new Map([[outer, 'remote-outer'], [inner, 'remote-inner']]));
  const broker = core.managementSessionBroker;

  const first = await broker.acquire('client-outer');
  const second = await broker.acquire('client-inner');
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.bindingGeneration, second.bindingGeneration);
  assert.equal((await core.acquireLegacyManagementContext(inner)).sessionToken, second.token);
  assert.equal((await core.acquireLegacyManagementContext(outer)).sessionToken, first.token);

  broker.invalidate('client-outer');
  assert.equal((await broker.acquire('client-inner')).token, second.token, 'invalidating one folder keeps the other');
  assert.deepEqual(host.registrations, ['remote-outer', 'remote-inner']);
});

test('one id registered for two different folders is still refused', async t => {
  const host = await startHost(t);
  const original = path.join(root, 'Client');
  const copy = path.join(root, 'Client copy');
  const core = connectionCore(t, host, [client('copied-client', original), client('copied-client', copy)],
    new Map([[original, 'remote-friend'], [copy, 'remote-friend']]));
  const broker = core.managementSessionBroker;

  for (const [name, attempt] of [
    ['acquire', () => broker.acquire('copied-client')],
    ['acquireWithProvenance', () => broker.acquireWithProvenance('copied-client')],
    ['acquireLegacyContext', () => broker.acquireLegacyContext('copied-client')],
    ['readServerInfo', () => broker.readServerInfo('copied-client')],
    ['acquireLegacyManagementContext', () => core.acquireLegacyManagementContext(original)]
  ]) {
    await assert.rejects(attempt(), { code: 'INVALID_REQUEST' }, name);
  }
  assert.deepEqual(host.registrations, []);
});

test('a registry edit resolves the registration at the folder it names, even for an id registered for two folders', async t => {
  const host = await startHost(t);
  const original = path.join(root, 'Client');
  const copy = path.join(root, 'Client copy');
  const core = connectionCore(t, host, [client('copied-client', original), client('copied-client', copy)],
    new Map([[original, 'remote-friend'], [copy, 'remote-friend']]));

  assert.deepEqual(await core.resolveClient('copied-client', original), { clientId: 'copied-client', clientPath: original });
  assert.deepEqual(await core.resolveClient('copied-client', `${copy}${path.sep}`), { clientId: 'copied-client', clientPath: copy });
  for (const [name, attempt] of [
    ['the id alone', () => core.resolveClient('copied-client')],
    ['a folder the id is not registered for', () => core.resolveClient('copied-client', path.join(root, 'Elsewhere'))],
    ['a relative folder', () => core.resolveClient('copied-client', 'Client')],
    ['another id at that folder', () => core.resolveClient('other-client', original)],
    ['a launch by folder', () => core.resolveClientByPath(original)]
  ]) {
    await assert.rejects(attempt(), { code: 'INVALID_REQUEST' }, name);
  }
  assert.deepEqual(host.registrations, []);
});

test('the shared session moves with the folder when its lowest id changes', async t => {
  const host = await startHost(t);
  const folder = path.join(root, 'Client');
  const instances = [client('b-client', folder), client('a-client', folder)];
  const core = connectionCore(t, host, instances, new Map([[folder, 'remote-friend']]));
  const broker = core.managementSessionBroker;

  const shared = await broker.acquire('a-client');
  // The 'a-client' registration is removed: 'b-client' now owns the folder's session.
  instances.splice(instances.findIndex(instance => instance.id === 'a-client'), 1);
  const moved = await broker.acquire('b-client');
  assert.notEqual(moved.bindingGeneration, shared.bindingGeneration);
  assert.equal((await core.acquireLegacyManagementContext(folder)).sessionToken, moved.token);

  // A lower id registered for the folder again takes the session back.
  instances.push(client('a-client', folder));
  const back = await broker.acquire('b-client');
  assert.notEqual(back.bindingGeneration, moved.bindingGeneration);
  assert.equal((await core.acquireLegacyManagementContext(folder)).sessionToken, back.token);
  assert.equal((await broker.readServerInfo('b-client')).response.success, true);

  assert.deepEqual(host.registrations, ['remote-friend', 'remote-friend', 'remote-friend']);
  assert.deepEqual(host.infoTokens, [back.token]);
});

test('invalidating any registration of a folder drops its shared session', async t => {
  const host = await startHost(t);
  const folder = path.join(root, 'Client');
  const core = connectionCore(t, host, [client('b-client', folder), client('a-client', folder)], new Map([[folder, 'remote-friend']]));
  const broker = core.managementSessionBroker;

  const shared = await broker.acquire('a-client');
  broker.invalidate('b-client');
  const renewed = await broker.acquire('a-client');
  assert.notEqual(renewed.bindingGeneration, shared.bindingGeneration);
  assert.notEqual(renewed.token, shared.token);

  // An acquisition still in flight under one registration is cancelled through the other.
  const pending = broker.acquire('b-client');
  broker.invalidate('a-client');
  await assert.rejects(pending, { code: 'PLAN_STALE' });

  assert.deepEqual(host.registrations, ['remote-friend', 'remote-friend']);
});
