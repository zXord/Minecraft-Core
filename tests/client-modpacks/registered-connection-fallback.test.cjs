const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ManagementSessionBroker } = require('../../electron/services/management-session-broker.cjs');
const { withRegisteredConnectionFallback } = require('../../electron/services/client-modpacks/registered-connection-fallback.cjs');

const PIN = 'ab'.repeat(32), OTHER = 'cd'.repeat(32), TOKEN = 'e'.repeat(64);
const COLON_PIN = Array(32).fill('AB').join(':');
const clientPath = path.resolve('synthetic-fallback-client');
const folder = (overrides = {}) => ({ serverProtocol: 'https', serverIp: 'saved.example', serverPort: '25566', clientId: 'remote',
  clientName: 'Synthetic client', inviteSecret: 'folder-invite', sessionToken: 'a'.repeat(64), ...overrides });
const instance = (overrides = {}) => ({ id: 'local', type: 'client', name: 'Synthetic client', path: clientPath,
  serverIp: 'saved.example', serverPort: '25566', serverProtocol: 'https', ...overrides });
const peer = (name, overrides = {}) => instance({ id: name, name, path: path.resolve(`synthetic-${name}-client`), ...overrides });

function fixture(t, { config = folder(), instances = [instance()], fallback = true, unpackSecret } = {}) {
  const pins = [], calls = [], reads = [];
  const read = async value => { reads.push(value); return config === null ? null : structuredClone(config); };
  const readClientConfig = fallback ? withRegisteredConnectionFallback(read, () => instances, unpackSecret ? { unpackSecret } : undefined) : read;
  const broker = new ManagementSessionBroker({ resolveClient: async id => ({ clientId: id, clientPath }), readClientConfig,
    getPinnedHttpsAgent: async (_host, _port, pin) => { pins.push(pin); return { pinned: pin }; },
    requestJson: async (url, options) => {
      calls.push({ url: String(url), method: options.method, body: options.body, pin: options.agent?.pinned });
      return options.method === 'POST' ? { statusCode: 200, body: { success: true, token: TOKEN } } : { statusCode: 200, body: { clientModpack: null } };
    } });
  t.after(() => broker.dispose());
  return { broker, pins, calls, reads, readClientConfig, read: () => broker.readServerInfo('local') };
}
async function refused(f) {
  await assert.rejects(f.read(), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.calls.length, 0); assert.equal(f.pins.length, 0);
}

test('a pinless folder config binds with the normalized pin of its registered instance', async t => {
  const instances = [instance({ managementCertFingerprint: COLON_PIN })];
  // Before the fallback: the folder config alone fails with no request at all.
  await refused(fixture(t, { instances, fallback: false }));
  const f = fixture(t, { instances });
  assert.deepEqual((await f.read()).response, { clientModpack: null });
  assert.deepEqual(f.pins, [PIN]); assert.deepEqual(f.calls.map(call => [call.method, call.pin]), [['GET', PIN]]);
  assert.equal((await f.readClientConfig(clientPath)).managementCertFingerprint, PIN);
});
test('an invalid folder pin is replaced by the registered instance pin', async t => {
  const f = fixture(t, { config: folder({ managementCertFingerprint: 'not-a-fingerprint' }), instances: [instance({ managementCertFingerprint: PIN })] });
  await f.read(); assert.deepEqual(f.pins, [PIN]);
});
test('a second client of the same host and port binds with the pin the first client holds', async t => {
  const f = fixture(t, { instances: [peer('first', { managementCertFingerprint: PIN }), instance()] });
  await f.read(); assert.deepEqual(f.pins, [PIN]); assert.deepEqual(f.calls.map(call => call.pin), [PIN]);
});
test('host and port match without case, IPv6 brackets or port spelling differences', async t => {
  const named = fixture(t, { instances: [peer('first', { serverIp: 'SAVED.EXAMPLE', serverPort: 25566, managementCertFingerprint: PIN }), instance()] });
  await named.read(); assert.deepEqual(named.pins, [PIN]);
  const ipv6 = fixture(t, { config: folder({ serverIp: 'fd00::1' }), instances: [peer('first', { serverIp: '[FD00::1]', managementCertFingerprint: PIN }), instance({ serverIp: 'fd00::1' })] });
  await ipv6.read(); assert.deepEqual(ipv6.pins, [PIN]); assert.equal(ipv6.calls[0].url, 'https://[fd00::1]:25566/api/server/info');
});
test('disagreeing pins of the same host and port are refused', async t => {
  const instances = [peer('first', { managementCertFingerprint: PIN }), peer('second', { managementCertFingerprint: OTHER }), instance()];
  await refused(fixture(t, { instances }));
  // One pin in two spellings is agreement, and the client's own pin still wins over disagreeing peers.
  const agreeing = fixture(t, { instances: [peer('first', { managementCertFingerprint: PIN }), peer('second', { managementCertFingerprint: COLON_PIN }), instance()] });
  await agreeing.read(); assert.deepEqual(agreeing.pins, [PIN]);
  const own = fixture(t, { instances: [...instances.slice(0, 2), instance({ managementCertFingerprint: OTHER })] });
  await own.read(); assert.deepEqual(own.pins, [OTHER]);
});
test('a pin registered for a different host or port is never used', async t => {
  await refused(fixture(t, { instances: [instance({ serverIp: 'replacement.example', managementCertFingerprint: PIN }),
    peer('other-host', { serverIp: 'other.example', managementCertFingerprint: PIN }), peer('other-port', { serverPort: '25567', managementCertFingerprint: PIN })] }));
  await refused(fixture(t, { instances: [{ ...peer('server'), type: 'server', managementCertFingerprint: PIN }, instance()] }));
});
test('no valid pin anywhere still fails before any request', async t => {
  await refused(fixture(t, { instances: [instance(), peer('first', { managementCertFingerprint: 'zz'.repeat(32) }), peer('second', { managementCertFingerprint: '' })] }));
  await refused(fixture(t, { instances: [] }));
});
test('a valid folder pin always wins and the registry is not consulted', async t => {
  let consulted = 0; const read = async () => folder({ managementCertFingerprint: Array(32).fill('CD').join(':') });
  const readClientConfig = withRegisteredConnectionFallback(read, () => { consulted++; return [instance({ managementCertFingerprint: PIN })]; });
  assert.equal((await readClientConfig(clientPath)).managementCertFingerprint, Array(32).fill('CD').join(':')); assert.equal(consulted, 0);
  const f = fixture(t, { config: folder({ managementCertFingerprint: OTHER }), instances: [instance({ managementCertFingerprint: PIN })] });
  await f.read(); assert.deepEqual(f.pins, [OTHER]);
});
test('a missing folder secret is filled from the registered instance', async t => {
  const config = folder({ managementCertFingerprint: PIN, inviteSecret: undefined, sessionToken: undefined });
  await refused(fixture(t, { config, instances: [instance({ inviteSecret: 'instance-invite' })], fallback: false }));
  const plain = fixture(t, { config, instances: [instance({ inviteSecret: ' instance-invite ' })] });
  await plain.read();
  assert.deepEqual(plain.calls.map(call => call.method), ['POST', 'GET']);
  assert.equal(JSON.parse(plain.calls[0].body).secret, 'instance-invite');
  const sealed = fixture(t, { config, instances: [instance({ inviteSecret: 'enc:sealed' })],
    unpackSecret: value => { assert.equal(value, 'enc:sealed'); return 'unsealed-invite'; } });
  await sealed.read(); assert.equal(JSON.parse(sealed.calls[0].body).secret, 'unsealed-invite');
});
test('an unreadable, foreign or ambiguous instance secret is never used', async t => {
  const config = folder({ managementCertFingerprint: PIN, inviteSecret: '', sessionToken: undefined });
  await refused(fixture(t, { config, instances: [instance({ inviteSecret: 'enc:sealed' })], unpackSecret: () => { throw new Error('safeStorage unavailable'); } }));
  await refused(fixture(t, { config, instances: [instance({ serverIp: 'replacement.example', inviteSecret: 'instance-invite' })] }));
  await refused(fixture(t, { config, instances: [instance({ inviteSecret: 'instance-invite' }), instance({ id: 'duplicate', inviteSecret: 'instance-invite' })] }));
  await refused(fixture(t, { config, instances: [peer('first', { inviteSecret: 'peer-invite' })] }));
});
test('a folder secret wins over the instance secret', async t => {
  const f = fixture(t, { config: folder({ managementCertFingerprint: PIN, sessionToken: undefined }), instances: [instance({ inviteSecret: 'instance-invite' })] });
  await f.read(); assert.equal(JSON.parse(f.calls[0].body).secret, 'folder-invite');
});
test('plain HTTP configs never take a pin, and the registry is only read when something is missing', async () => {
  let consulted = 0; const instances = [instance({ managementCertFingerprint: PIN, inviteSecret: 'instance-invite' })];
  const readClientConfig = withRegisteredConnectionFallback(async () => folder({ serverProtocol: 'http' }), () => { consulted++; return instances; });
  assert.deepEqual(await readClientConfig(clientPath), folder({ serverProtocol: 'http' })); assert.equal(consulted, 0);
  const missing = withRegisteredConnectionFallback(async () => folder({ serverProtocol: 'http', inviteSecret: undefined }), () => { consulted++; return instances; });
  assert.deepEqual(await missing(clientPath), folder({ serverProtocol: 'http', inviteSecret: 'instance-invite' })); assert.equal(consulted, 1);
});
test('the fallback never writes, mutates or invents values', async () => {
  const config = folder({ inviteSecret: undefined }); const instances = [instance({ managementCertFingerprint: COLON_PIN, inviteSecret: 'instance-invite' })];
  const configBefore = structuredClone(config), instancesBefore = structuredClone(instances);
  const readClientConfig = withRegisteredConnectionFallback(async () => config, () => instances);
  const completed = await readClientConfig(clientPath);
  assert.notEqual(completed, config); assert.deepEqual(config, configBefore); assert.deepEqual(instances, instancesBefore);
  assert.deepEqual(completed, { ...configBefore, managementCertFingerprint: PIN, inviteSecret: 'instance-invite' });
  assert.equal(await withRegisteredConnectionFallback(async () => null, () => instances)(clientPath), null);
  const failure = new Error('folder unreadable');
  await assert.rejects(withRegisteredConnectionFallback(async () => { throw failure; }, () => instances)(clientPath), error => error === failure);
  const unchanged = folder({ inviteSecret: undefined });
  assert.equal(await withRegisteredConnectionFallback(async () => unchanged, () => { throw new Error('store unavailable'); })(clientPath), unchanged);
  assert.equal(await withRegisteredConnectionFallback(async () => unchanged, () => ({ instances }))(clientPath), unchanged);
});
test('the reader receives the registered path and both inputs must be functions', async t => {
  const f = fixture(t, { instances: [instance({ managementCertFingerprint: PIN })] });
  await f.read(); assert.equal(f.reads.every(value => value === clientPath), true);
  for (const args of [[null, () => []], [async () => null, null], [async () => null, () => [], { unpackSecret: 'plain' }]]) {
    assert.throws(() => withRegisteredConnectionFallback(...args), { code: 'INVALID_REQUEST' });
  }
});
