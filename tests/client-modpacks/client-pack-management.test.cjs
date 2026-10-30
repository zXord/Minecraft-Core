const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { clientPackManagementFields, startClientPackManagementFields } = require('../../electron/services/client-modpacks/client-pack-management.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const unpaired = { schemaVersion: 1, status: 'unpaired', serverFingerprint: 'a'.repeat(64), serverVersion: '0.13.4', source: null, runtime: null, artifactSha256: null };
const unavailable = value => value.clientModpack === null && value.clientModpackError?.code === 'CLIENT_PACK_UNAVAILABLE';

test('a resolver that never settles yields the unavailable fields once the budget after settle has passed (A38)', async () => {
  const fields = startClientPackManagementFields('server-a', () => new Promise(() => {}));
  const started = Date.now();
  const value = await fields.settle({ timeoutMs: 60 });
  const elapsed = Date.now() - started;
  assert.equal(unavailable(value), true);
  assert.ok(elapsed >= 50 && elapsed < 2000, `settled after ${elapsed} ms`);
  assert.deepEqual(Object.keys(await startClientPackManagementFields('server-a', null).settle()), ['clientModpack', 'clientModpackError']);
});

test('synchronous legacy work before the await never spends the requirement budget (A38)', async () => {
  let calls = 0;
  // A warm managed resolver still needs one event-loop turn, as a cached health check does.
  const fields = startClientPackManagementFields('server-a', id => { calls++; assert.equal(id, 'server-a'); return new Promise(resolve => setImmediate(() => resolve(unpaired))); });
  assert.equal(calls, 1, 'the resolver starts at once');
  const busyUntil = Date.now() + 150;
  while (Date.now() < busyUntil) { /* synchronous legacy server info work */ }
  assert.deepEqual(await fields.settle({ timeoutMs: 50 }), { clientModpack: unpaired });
  assert.deepEqual(await startClientPackManagementFields('server-a', async () => null).settle({ timeoutMs: 50 }), { clientModpack: null });
});

test('a resolver failure before or after the budget never escapes as an unhandled rejection', async () => {
  const escaped = []; const listener = reason => escaped.push(reason); process.on('unhandledRejection', listener);
  try {
    let fail;
    const late = startClientPackManagementFields('server-a', () => new Promise((_resolve, reject) => { fail = reject; }));
    assert.equal(unavailable(await late.settle({ timeoutMs: 10 })), true);
    fail(new Error('C:\\private token=secret'));
    const early = startClientPackManagementFields('server-a', async () => { throw new Error('registry corrupted'); });
    const thrown = startClientPackManagementFields('server-a', () => { throw new Error('synchronous failure'); });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(unavailable(await early.settle()), true); assert.equal(unavailable(await thrown.settle()), true);
    const changed = await startClientPackManagementFields('server-a', async () => { throw new ModpackError('CLIENT_PACK_SERVER_CHANGED', 'Changed'); }).settle();
    assert.equal(changed.clientModpackError.code, 'CLIENT_PACK_SERVER_CHANGED');
  } finally { process.off('unhandledRejection', listener); }
  assert.deepEqual(escaped, []);
});

test('the settle budget must be a positive whole number of milliseconds', async () => {
  const fields = startClientPackManagementFields('server-a', async () => null);
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, '3000', Infinity]) await assert.rejects(fields.settle({ timeoutMs }), TypeError);
  assert.deepEqual(await fields.settle(), { clientModpack: null });
});
test('management DTO is strict and null only for an authenticated unmanaged result', async () => {
  assert.deepEqual(await clientPackManagementFields('server-a', async id => { assert.equal(id, 'server-a'); return unpaired; }), { clientModpack: unpaired });
  assert.deepEqual(await clientPackManagementFields('server-a', async () => null), { clientModpack: null });
});
test('unavailable or malformed pairing emits a safe explicit failure while server information remains usable', async () => {
  for (const resolver of [null, async () => { throw new Error('C:\\secret token=secret'); }, async () => ({ ...unpaired, path: '/private' })]) {
    const value = await clientPackManagementFields('server-a', resolver);
    assert.equal(value.clientModpack, null); assert.equal(value.clientModpackError.code, 'CLIENT_PACK_UNAVAILABLE');
    assert.equal(JSON.stringify(value).includes('secret'), false); assert.equal(JSON.stringify(value).includes('/private'), false);
  }
});

test('proven server drift carries bounded local guidance, while untrusted codes stay unavailable', async () => {
  const result = await clientPackManagementFields('server-a', async () => { throw new ModpackError('CLIENT_PACK_SERVER_CHANGED', 'Ignore this remote text'); });
  assert.equal(result.clientModpackError.code, 'CLIENT_PACK_SERVER_CHANGED');
  assert.match(result.clientModpackError.message, /Use Modpack Verify and Repair/);
  assert.equal(result.clientModpack, null);
  const forged = await clientPackManagementFields('server-a', async () => { throw { code: 'CLIENT_PACK_SERVER_CHANGED', message: 'C:\\private token=secret' }; });
  assert.equal(forged.clientModpackError.code, 'CLIENT_PACK_UNAVAILABLE');
  assert.equal(JSON.stringify(forged).includes('secret'), false);
});

test('real management info route adds the strict descriptor and remains healthy on registry failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-pack-management-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'server.properties'), 'server-port=25575\nmotd=Disposable\n');
  fs.writeFileSync(path.join(root, '.minecraft-core.json'), JSON.stringify({ version: '1.20.1', loader: 'vanilla' }));
  const modulePath = require.resolve('../../electron/services/management-server.cjs'); const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getVersion: () => 'test', getPath: () => root, setPath() {} }, safeStorage: { isEncryptionAvailable: () => false } };
    if (request.includes('logger-handlers.cjs')) return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    return original(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const { ManagementServer, configureClientModpackResolver } = require(modulePath);
    const server = new ManagementServer('server-a'); server.serverPath = root;
    server.getRequiredMods = async () => []; server.getAllClientMods = async () => []; server.checkMinecraftServerStatus = async () => false;
    const route = server.app._router.stack.find(layer => layer.route?.path === '/api/server/info').route.stack[0].handle;
    let value; let status = 200; const response = { status(code) { status = code; return this; }, json(body) { value = body; } };
    configureClientModpackResolver(async id => { assert.equal(id, 'server-a'); return unpaired; });
    await route({}, response); assert.equal(status, 200); assert.deepEqual(value.clientModpack, unpaired); assert.equal(value.minecraftPort, '25575');
    configureClientModpackResolver(async () => { throw new Error('registry corrupted'); });
    await route({}, response); assert.equal(status, 200); assert.equal(value.success, true);
    assert.equal(value.clientModpackError.code, 'CLIENT_PACK_UNAVAILABLE'); assert.equal(value.minecraftVersion, '1.20.1');
  } finally { Module._load = original; delete require.cache[modulePath]; }
});
