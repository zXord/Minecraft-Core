const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { CompanionStore } = require('../../electron/services/client-modpacks/companion-store.cjs');
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-companion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'companions.json');
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: { moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {} } });
  return { root, filePath, durableFs, store: new CompanionStore({ filePath, durableFs }) };
}
const record = (fingerprint = 'a'.repeat(64)) => ({ serverId: 'server-one', descriptor: { schemaVersion: 1, status: 'ready', serverFingerprint: fingerprint, serverVersion: 'v1', source: { provider: 'modrinth', projectId: 'project', versionId: 'version' }, runtime, artifactSha256: 'b'.repeat(64) } });
test('durable pairing history survives reopening and rollback', async t => {
  const f = fixture(t); await f.store.initialize();
  await f.store.put(record(), { expectedSequence: 0 });
  await f.store.put(record('c'.repeat(64)), { expectedSequence: 1 });
  const reopened = new CompanionStore(f); await reopened.initialize();
  assert.equal(reopened.sequence, 2);
  assert.deepEqual(await reopened.get('server-one', 'a'.repeat(64)), record());
  assert.deepEqual(await reopened.get('server-one', 'c'.repeat(64)), record('c'.repeat(64)));
});
test('CAS rejects stale writers without changing committed state', async t => {
  const f = fixture(t); await f.store.initialize();
  const other = new CompanionStore(f); await other.initialize();
  await f.store.put(record(), { expectedSequence: 0 });
  const bytes = fs.readFileSync(f.filePath);
  await assert.rejects(other.put(record('c'.repeat(64)), { expectedSequence: 0 }), { code: 'COMMIT_FAILED' });
  await assert.rejects(f.store.put(record(), { expectedSequence: 0 }), { code: 'PLAN_STALE' });
  assert.deepEqual(fs.readFileSync(f.filePath), bytes);
  assert.equal(other.sequence, 0);
});
test('corruption cannot return ready or silently replace registry', async t => {
  const f = fixture(t); await f.store.initialize(); await f.store.put(record(), { expectedSequence: 0 });
  const corrupted = JSON.parse(fs.readFileSync(f.filePath)); corrupted.records[0].descriptor.artifactSha256 = 'c'.repeat(64);
  fs.writeFileSync(f.filePath, JSON.stringify(corrupted));
  const bytes = fs.readFileSync(f.filePath);
  await assert.rejects(f.store.get('server-one', 'a'.repeat(64)), { code: 'CLIENT_PACK_UNAVAILABLE' });
  await assert.rejects(new CompanionStore(f).initialize(), { code: 'CLIENT_PACK_UNAVAILABLE' });
  await assert.rejects(f.store.put(record(), { expectedSequence: 1 }));
  assert.deepEqual(fs.readFileSync(f.filePath), bytes);
});
test('strict records and byte bounds fail closed', async t => {
  const f = fixture(t); await f.store.initialize();
  await assert.rejects(f.store.put({ ...record(), path: 'unsafe' }, { expectedSequence: 0 }), { code: 'INVALID_REQUEST' });
  fs.writeFileSync(f.filePath, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(new CompanionStore(f).initialize(), { code: 'CLIENT_PACK_UNAVAILABLE' });
});
test('failed durable publication leaves the in-memory sequence unchanged', async t => {
  const f = fixture(t);
  const store = new CompanionStore({ ...f, durableFs: { ...f.durableFs, writeJsonAtomic() { throw new Error('disk failure'); } } });
  await store.initialize();
  await assert.rejects(store.put(record(), { expectedSequence: 0 }), { code: 'COMMIT_FAILED' });
  assert.equal(store.sequence, 0);
  assert.equal(await store.get('server-one', 'a'.repeat(64)), null);
});

test('registry rejects a 1001st history record without discarding historical pairings', async t => {
  const f = fixture(t);
  const records = Array.from({ length: 1000 }, (_, index) => record(index.toString(16).padStart(64, '0')));
  const value = { type: 'minecraft-core-client-companions', schemaVersion: 1, sequence: 1000, records };
  value.checksum = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  fs.writeFileSync(f.filePath, JSON.stringify(value));
  await f.store.initialize(); const bytes = fs.readFileSync(f.filePath);
  await assert.rejects(f.store.put(record('f'.repeat(64)), { expectedSequence: 1000 }), { code: 'COMMIT_FAILED' });
  assert.equal(f.store.sequence, 1000); assert.deepEqual(fs.readFileSync(f.filePath), bytes);
  assert.equal((await f.store.get('server-one', '0'.repeat(64))).descriptor.status, 'ready');
});
