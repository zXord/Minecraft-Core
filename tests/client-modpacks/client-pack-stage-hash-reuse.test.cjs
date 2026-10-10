const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { captureServerDirectoryCopySource } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const { ClientPackStateStore, MANIFEST_NAME } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
const { ClientPackTransaction } = require('../../electron/services/client-modpacks/client-pack-transaction.cjs');
const { PersistentCandidateHashService } = require('../../electron/services/modpacks/planning/candidate-hash-service.cjs');

const reparseInspector = { async isReparsePoint() { return false; } };
const descriptor = { schemaVersion: 1, status: 'ready', serverFingerprint: 'a'.repeat(64), serverVersion: 'v1',
  source: { provider: 'modrinth', projectId: 'p', versionId: 'v' }, artifactSha256: 'b'.repeat(64),
  runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' } };
const payload = { 'config/one.cfg': 'one', 'config/two.cfg': 'two', 'config/three.cfg': 'three' };
const oldFiles = { 'saves/world.dat': 'save', 'client-config.json': 'auth', 'options.txt': 'mine', 'mods/user.jar': 'user' };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestEntry = (file, bytes, policy = 'managed') => ({ path: file, pathKey: file, sha256: hash(bytes), size: String(Buffer.byteLength(bytes)), policy });
function write(root, relative, bytes) {
  const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
}
function fixture(t, hashServiceFactory) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-client-stage-hash-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^mc-client-stage-hash-[A-Za-z0-9]+$/);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const live = path.join(root, 'client'), staged = path.join(root, 'pack'), journalRoot = path.join(root, 'journal');
  for (const directory of [live, staged, journalRoot]) fs.mkdirSync(directory);
  for (const [file, bytes] of Object.entries(oldFiles)) write(live, file, bytes);
  for (const [file, bytes] of Object.entries(payload)) write(staged, file, bytes);
  write(staged, 'options.txt', 'pack');
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {}
  } });
  const stateStore = new ClientPackStateStore({ durableFs });
  const dependencies = { journalRoot, durableFs, stateStore, reparseInspector, ...(hashServiceFactory === undefined ? {} : { hashServiceFactory }) };
  const tx = new ClientPackTransaction(dependencies);
  const target = { clientId: 'client-one', clientPath: live };
  const prepared = { path: staged, manifest: { entries: [
    ...Object.entries(payload).map(([file, bytes]) => manifestEntry(file, bytes)), manifestEntry('options.txt', 'pack', 'preserve-after-seed')
  ] } };
  return { root, live, staged, journalRoot, durableFs, stateStore, dependencies, tx, target, prepared };
}
async function stage(f, overrides = {}) {
  return f.tx.stage({ target: f.target, baseline: await captureServerDirectoryCopySource(f.live, { reparseInspector }),
    oldManifest: await f.stateStore.read(f.live), prepared: f.prepared, descriptor, optionalFileIds: [], conflictChoices: {}, ...overrides });
}
function assertOldLive(f) {
  for (const [file, bytes] of Object.entries(oldFiles)) assert.equal(fs.readFileSync(path.join(f.live, file), 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(f.live, 'config')), false);
  assert.equal(fs.existsSync(path.join(f.live, MANIFEST_NAME)), false);
}
async function assertCandidate(f, context) {
  for (const [file, bytes] of Object.entries(payload)) assert.equal(fs.readFileSync(path.join(context.candidatePath, file), 'utf8'), bytes);
  assert.equal(fs.readFileSync(path.join(context.candidatePath, 'options.txt'), 'utf8'), 'mine');
  const manifest = await f.stateStore.read(context.candidatePath);
  assert.deepEqual(manifest.entries.filter(entry => entry.policy === 'managed'), [
    manifestEntry('config/one.cfg', 'one'), manifestEntry('config/three.cfg', 'three'), manifestEntry('config/two.cfg', 'two')
  ]);
  assert.equal(manifest.entries.find(entry => entry.path === 'options.txt').preserved, true);
  assertOldLive(f);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function bounded(promise, label) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10000); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
function ownedHashFactory(t, { beforeHash, beforeDispose, afterDispose } = {}) {
  const records = [];
  const factory = () => {
    const record = { starts: 0, exits: 0, hashes: [], disposals: 0, disposed: false };
    const real = new PersistentCandidateHashService({ workerFactory(filename, options) {
      record.starts++;
      const worker = new Worker(filename, options); worker.once('exit', () => { record.exits++; }); return worker;
    } });
    record.real = real; records.push(record); t.after(() => real.dispose());
    return {
      async hashFile(file, options) {
        record.hashes.push(file);
        if (beforeHash) await beforeHash(file, options, record);
        return real.hashFile(file, options);
      },
      async dispose() {
        record.disposals++;
        if (beforeDispose) await beforeDispose(record);
        await real.dispose();
        if (afterDispose) await afterDispose(record);
        record.disposed = true;
      }
    };
  };
  return { factory, records };
}

// Break caught: per-file or transaction-global services instead of one distinct stage-owned service.
test('three real selected copies reuse one real worker per stage and independent stages do not share it', async t => {
  const owned = ownedHashFactory(t); const f = fixture(t, owned.factory);
  const first = await stage(f); await assertCandidate(f, first);
  assert.equal(owned.records.length, 1);
  assert.equal(owned.records[0].starts, 1); assert.equal(owned.records[0].exits, 1);
  assert.equal(owned.records[0].disposals, 1); assert.equal(owned.records[0].disposed, true);
  assert.deepEqual(new Set(owned.records[0].hashes), new Set(Object.keys(payload).flatMap(file => [path.join(f.staged, file), path.join(first.candidatePath, file)])));
  assert.equal(owned.records[0].hashes.length, 6);
  await f.tx.abandon(first, { quiescent: true });
  const second = await stage(f); await assertCandidate(f, second);
  assert.equal(owned.records.length, 2); assert.notEqual(owned.records[0].real, owned.records[1].real);
  assert.equal(owned.records[1].starts, 1); assert.equal(owned.records[1].exits, 1);
  assert.equal(owned.records[1].hashes.length, 6); assert.equal(owned.records[1].disposals, 1);
});

test('omitted factory reuses and disposes the same real default service for all selected hashes', async t => {
  const f = fixture(t); const operationId = '44444444-4444-4444-8444-444444444444';
  const candidatePath = f.tx.candidatePathFor(f.target, operationId);
  const selectedPaths = new Set(Object.keys(payload).flatMap(file => [path.join(f.staged, file), path.join(candidatePath, file)]));
  const records = new Map();
  const originalHash = PersistentCandidateHashService.prototype.hashFile;
  const originalDispose = PersistentCandidateHashService.prototype.dispose;
  t.mock.method(PersistentCandidateHashService.prototype, 'hashFile', function (file, ...args) {
    if (selectedPaths.has(file)) {
      if (!records.has(this)) records.set(this, { hashes: [], disposals: 0, disposed: false });
      records.get(this).hashes.push(file);
    }
    return originalHash.call(this, file, ...args);
  });
  t.mock.method(PersistentCandidateHashService.prototype, 'dispose', async function (...args) {
    const record = records.get(this); if (record) record.disposals++;
    const result = await originalDispose.call(this, ...args);
    if (record) record.disposed = true;
    return result;
  });
  const context = await stage(f, { operationId }); await assertCandidate(f, context);
  assert.equal(records.size, 1, 'selected copies must share one actual default hash service');
  const record = [...records.values()][0];
  assert.equal(record.hashes.length, 6); assert.deepEqual(new Set(record.hashes), selectedPaths);
  assert.equal(record.disposals, 1); assert.equal(record.disposed, true);
});

for (const selection of ['empty', 'preserved-only']) test(`${selection} selection stages valid ownership without constructing a hash service`, async t => {
  let creations = 0;
  const f = fixture(t, () => { creations++; throw new Error('No copy should need hashing'); });
  f.prepared.manifest.entries = selection === 'empty' ? [] : [manifestEntry('options.txt', 'pack', 'preserve-after-seed')];
  const context = await stage(f); const manifest = await f.stateStore.read(context.candidatePath);
  assert.equal(creations, 0); assert.equal(manifest.entries.length, selection === 'empty' ? 0 : 1);
  assert.equal(fs.existsSync(path.join(context.candidatePath, 'config')), false);
  assert.equal(fs.readFileSync(path.join(context.candidatePath, 'options.txt'), 'utf8'), 'mine');
  if (selection === 'preserved-only') assert.equal(manifest.entries[0].preserved, true);
  assertOldLive(f);
});

// Break caught: not awaiting disposal, or placing it after manifest write/abandon.
for (const mode of ['success', 'hash-failure', 'abort']) test(`stage waits for held disposal before ${mode === 'success' ? 'manifest publication and return' : `${mode} abandonment`}`, async t => {
  const entered = deferred(), release = deferred(); const controller = new AbortController();
  let f, mutated = false; const events = [];
  const owned = ownedHashFactory(t, {
    beforeHash(file) {
      if (!file.endsWith(path.join('config', 'three.cfg'))) return;
      if (mode === 'hash-failure' && file.startsWith(f.staged + path.sep) && !mutated) {
        mutated = true; fs.writeFileSync(file, 'changed after capture');
      }
      if (mode === 'abort' && !file.startsWith(f.staged + path.sep)) controller.abort();
    },
    async beforeDispose() { events.push('dispose-enter'); entered.resolve(); await release.promise; },
    afterDispose() { events.push('dispose-complete'); }
  });
  f = fixture(t, owned.factory);
  const originalWrite = f.stateStore.write.bind(f.stateStore), originalAbandon = f.tx.abandon.bind(f.tx);
  t.mock.method(f.stateStore, 'write', async (...args) => { events.push('manifest-write'); return originalWrite(...args); });
  t.mock.method(f.tx, 'abandon', async (...args) => { events.push('abandon'); return originalAbandon(...args); });
  const operationId = '11111111-1111-4111-8111-111111111111';
  const candidatePath = f.tx.candidatePathFor(f.target, operationId);
  const outcome = stage(f, { operationId, signal: controller.signal }).then(context => ({ context }), error => ({ error }));
  let settled = false; void outcome.then(() => { settled = true; });
  try {
    const boundary = await bounded(Promise.race([entered.promise.then(() => 'dispose'), outcome.then(() => 'settled')]), 'stage disposal boundary');
    assert.equal(boundary, 'dispose', 'stage must use and await its operation-owned hash service');
    assert.equal(settled, false); assert.equal(events.includes('manifest-write'), false); assert.equal(events.includes('abandon'), false);
    assert.equal((await f.tx.status(f.target)).phase, 'preparing');
    assert.equal(await f.stateStore.read(candidatePath), null); assertOldLive(f);
    assert.equal(fs.readFileSync(path.join(candidatePath, 'config/one.cfg'), 'utf8'), 'one');
    release.resolve();
    const result = await bounded(outcome, 'stage result after disposal');
    assert.equal(owned.records.length, 1); assert.equal(owned.records[0].disposed, true);
    if (mode === 'success') {
      assert.equal(result.error, undefined); await assertCandidate(f, result.context);
      assert.deepEqual(events, ['dispose-enter', 'dispose-complete', 'manifest-write']);
    } else {
      assert.ok(result.error);
      if (mode === 'abort') assert.equal(result.error.code, 'CANCELLED');
      else assert.equal(result.error.code, 'UNSAFE_ARCHIVE_ENTRY');
      assert.deepEqual(events, ['dispose-enter', 'dispose-complete', 'abandon']);
      assert.equal((await f.tx.status(f.target)).phase, 'abandoned');
      assert.equal(await f.stateStore.read(candidatePath), null);
      assert.ok(fs.readdirSync(f.journalRoot).some(name => name.endsWith(`.retained-proof-${operationId}-candidate.json`)));
    }
    assertOldLive(f);
  } finally { release.resolve(); await bounded(outcome, 'stage cleanup'); }
});

// Break caught: treating a rejected disposal as quiescent and publishing or abandoning anyway.
for (const mode of ['success', 'hash-failure', 'abort']) test(`${mode} plus disposal rejection retains preparing evidence without claiming quiescent abandonment`, async t => {
  let f, mutated = false; const controller = new AbortController();
  const owned = ownedHashFactory(t, {
    beforeHash(file) {
      if (!file.endsWith(path.join('config', 'three.cfg'))) return;
      if (mode === 'hash-failure' && file.startsWith(f.staged + path.sep) && !mutated) {
        mutated = true; fs.writeFileSync(file, 'changed after capture');
      }
      if (mode === 'abort' && !file.startsWith(f.staged + path.sep)) controller.abort();
    },
    afterDispose() { throw new Error('injected disposal failure'); }
  });
  f = fixture(t, owned.factory); const events = [];
  const originalWrite = f.stateStore.write.bind(f.stateStore), originalAbandon = f.tx.abandon.bind(f.tx);
  t.mock.method(f.stateStore, 'write', async (...args) => { events.push('manifest-write'); return originalWrite(...args); });
  t.mock.method(f.tx, 'abandon', async (...args) => { events.push('abandon'); return originalAbandon(...args); });
  const operationId = '22222222-2222-4222-8222-222222222222';
  await assert.rejects(stage(f, { operationId, signal: controller.signal }), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(events, []); assert.equal((await f.tx.status(f.target)).phase, 'preparing');
  const candidatePath = f.tx.candidatePathFor(f.target, operationId);
  assert.equal(await f.stateStore.read(candidatePath), null);
  if (mode === 'success') {
    for (const [file, bytes] of Object.entries(payload)) assert.equal(fs.readFileSync(path.join(candidatePath, file), 'utf8'), bytes);
  } else {
    assert.equal(fs.readFileSync(path.join(candidatePath, 'config/one.cfg'), 'utf8'), 'one');
    assert.equal(fs.existsSync(path.join(candidatePath, 'config/two.cfg')), false);
  }
  assert.equal(fs.readdirSync(f.journalRoot).some(name => name.endsWith(`.retained-proof-${operationId}-candidate.json`)), false);
  assertOldLive(f);
});

test('nonfunction hash service factory is rejected before staging can create authority', t => {
  const f = fixture(t, () => { throw new Error('unused'); });
  for (const value of [null, {}, true]) assert.throws(() => new ClientPackTransaction({ ...f.dependencies, hashServiceFactory: value }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(fs.readdirSync(f.journalRoot), []); assertOldLive(f);
});

for (const [label, invalidService] of [['null', null], ['empty', {}], ['hash-only', { hashFile() {} }], ['dispose-only', { async dispose() {} }]]) {
  test(`${label} factory result fails closed before selected content or ownership publication`, async t => {
    const f = fixture(t, () => invalidService);
    const operationId = '33333333-3333-4333-8333-333333333333';
    await assert.rejects(stage(f, { operationId }), { code: 'INVALID_REQUEST' });
    const candidatePath = f.tx.candidatePathFor(f.target, operationId);
    assert.equal(fs.existsSync(path.join(candidatePath, 'config')), false);
    assert.equal(await f.stateStore.read(candidatePath), null); assertOldLive(f);
  });
}
