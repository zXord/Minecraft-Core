const test = require('node:test');
const assert = require('node:assert/strict');
const { planOwnership, normalizeClientPackManifest } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
const sha = c => c.repeat(64);
const entry = (path, hash = 'a', policy = 'managed') => ({ path, pathKey: path.toLowerCase(), sha256: sha(hash), size: '3', policy });
const current = (...entries) => ({ entries: entries.map(e => ({ ...e, type: 'file' })) });
test('ownership removes only unchanged previous content and never unowned additions', () => {
  const result = planOwnership(current(entry('mods/old.jar'), entry('mods/user.jar')), { entries: [entry('mods/old.jar')] }, [entry('mods/new.jar')]);
  assert.deepEqual(result.removals, ['mods/old.jar']);
  assert.deepEqual(result.additions, ['mods/new.jar']);
  assert.deepEqual(result.conflicts, []);
});
test('modified owned and unowned collisions require explicit decisions', () => {
  const result = planOwnership(current(entry('config/a.txt', 'b'), entry('mods/user.jar')), { entries: [entry('config/a.txt')] }, [entry('config/a.txt', 'c'), entry('mods/user.jar', 'c')]);
  assert.deepEqual(result.conflicts.map(c => c.path), ['config/a.txt', 'mods/user.jar']);
});
test('settings already present cannot be replacement conflicts', () => {
  const result = planOwnership(current(entry('options.txt', 'b')), null, [entry('options.txt', 'c', 'preserve-after-seed')]);
  assert.deepEqual(result.preserved, ['options.txt']); assert.deepEqual(result.conflicts, []);
});
test('corrupt manifest cannot authorize protected deletion', () => {
  const descriptor = { schemaVersion: 1, status: 'ready', serverFingerprint: sha('a'), serverVersion: 'v1', artifactSha256: sha('b'),
    source: { provider: 'modrinth', projectId: 'p', versionId: 'v' },
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' } };
  assert.throws(() => normalizeClientPackManifest({ schemaVersion: 1, descriptor, optionalFileIds: [], entries: [entry('saves/world.dat')] }), { code: 'UNSAFE_ARCHIVE_ENTRY' });
});

const readyDescriptor = { schemaVersion: 1, status: 'ready', serverFingerprint: sha('a'), serverVersion: 'v1', artifactSha256: sha('b'),
  source: { provider: 'github', repositoryId: '1', githubOwner: 'Example', githubRepo: 'Pack', releaseId: '2', assetId: '3' },
  runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' } };
const multiManifest = () => ({ schemaVersion: 2, descriptor: readyDescriptor, optionalFileIds: [], entries: [entry('mods/pack.jar')],
  contentFormat: 'multimc', runtimeConstraints: { lwjglVersion: '3.3.1' } });

test('schema2 retains exact GitHub-bound constraints and schema1 remains unchanged', () => {
  const value = multiManifest(); const actual = normalizeClientPackManifest(value);
  assert.deepEqual(actual, value); assert.ok(Object.isFrozen(actual.runtimeConstraints));
  assert.equal(actual.descriptor.schemaVersion, 1);
  const legacy = { schemaVersion: 1, descriptor: readyDescriptor, optionalFileIds: ['z', 'a'], entries: value.entries };
  assert.deepEqual(normalizeClientPackManifest(legacy), { ...legacy, optionalFileIds: ['a', 'z'] });
  assert.equal(Object.hasOwn(normalizeClientPackManifest(legacy), 'runtimeConstraints'), false);
  assert.deepEqual(normalizeClientPackManifest({ ...value, runtimeConstraints: { lwjglVersion: null } }).runtimeConstraints, { lwjglVersion: null });
});

for (const [label, patch] of [
  ['missing constraints', value => { delete value.runtimeConstraints; }],
  ['missing format', value => { delete value.contentFormat; }],
  ['extra field', value => { value.extra = true; }],
  ['other format', value => { value.contentFormat = 'mrpack'; }],
  ['other provider', value => { value.descriptor = { ...readyDescriptor, source: { provider: 'modrinth', projectId: 'p', versionId: 'v' } }; }],
  ['unpaired descriptor', value => { value.descriptor = { ...readyDescriptor, status: 'unpaired', source: null, runtime: null, artifactSha256: null }; }],
  ['invalid descriptor', value => { value.descriptor = { ...readyDescriptor, artifactSha256: 'invalid' }; }],
  ['nonempty choices', value => { value.optionalFileIds = ['optional-one']; }],
  ['null constraints', value => { value.runtimeConstraints = null; }],
  ['empty constraints', value => { value.runtimeConstraints = {}; }],
  ['extra constraint', value => { value.runtimeConstraints = { lwjglVersion: null, extra: 1 }; }],
  ['alias version', value => { value.runtimeConstraints = { lwjglVersion: 'latest' }; }],
  ['path version', value => { value.runtimeConstraints = { lwjglVersion: '../3.3.1' }; }],
  ['protected entry', value => { value.entries = [entry('saves/world.dat')]; }]
]) test(`schema2 ${label} requires recovery without losing evidence`, () => {
  const value = multiManifest(); patch(value);
  assert.throws(() => normalizeClientPackManifest(value), { code: 'RECOVERY_REQUIRED' });
});

test('schema2 branch selection does not invoke unsafe getters or change strict-clone refusal', () => {
  let reads = 0;
  const value = { ...multiManifest(), get schemaVersion() { reads++; return 2; } };
  assert.throws(() => normalizeClientPackManifest(value), TypeError); assert.equal(reads, 0);
  const nested = { ...multiManifest(), runtimeConstraints: { get lwjglVersion() { reads++; return null; } } };
  assert.throws(() => normalizeClientPackManifest(nested), TypeError); assert.equal(reads, 0);
});

test('state store atomically round trips both manifest schemas and refuses corrupt schema2 reads/writes', async t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
  const { ClientPackStateStore, MANIFEST_NAME } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-state-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: { moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {}, moveWriteThroughAsync: fs.promises.rename,
    replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {} } });
  const store = new ClientPackStateStore({ durableFs });
  for (const value of [multiManifest(), { ...multiManifest(), runtimeConstraints: { lwjglVersion: null } },
    { schemaVersion: 1, descriptor: readyDescriptor, optionalFileIds: [], entries: multiManifest().entries }]) {
    assert.deepEqual(await store.write(root, value), value);
    assert.deepEqual(await new ClientPackStateStore({ durableFs }).read(root), value);
  }
  const invalid = { ...multiManifest(), runtimeConstraints: {} };
  const before = fs.readFileSync(path.join(root, MANIFEST_NAME));
  await assert.rejects(store.write(root, invalid), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(fs.readFileSync(path.join(root, MANIFEST_NAME)), before);
  for (const value of [invalid, { ...multiManifest(), runtimeConstraints: undefined }]) {
    fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(value));
    await assert.rejects(store.read(root), { code: 'RECOVERY_REQUIRED' });
  }
});
