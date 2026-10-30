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
const largeManifest = schemaVersion => ({
  ...(schemaVersion === 2 ? multiManifest() : { schemaVersion: 1, descriptor: readyDescriptor, optionalFileIds: [] }),
  entries: Array.from({ length: 12926 }, (_, index) => entry(`mods/pack-${String(index).padStart(5, '0')}.jar`))
});

for (const schemaVersion of [1, 2]) test(`schema${schemaVersion} normalizes a 12926-entry ownership manifest without losing entries`, () => {
  const value = largeManifest(schemaVersion);
  const actual = normalizeClientPackManifest(value);
  assert.deepEqual(actual, value);
  assert.equal(actual.entries.length, 12926);
  assert.equal(actual.entries[0].path, 'mods/pack-00000.jar');
  assert.equal(actual.entries.at(-1).path, 'mods/pack-12925.jar');
});

for (const schemaVersion of [1, 2]) test(`schema${schemaVersion} state store atomically round trips a 12926-entry ownership manifest`, async t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
  const { ClientPackStateStore, MANIFEST_NAME } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-state-large-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^client-state-large-[A-Za-z0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: { moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync,
    flushDirectory() {}, moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {} } });
  const value = largeManifest(schemaVersion);
  assert.deepEqual(await new ClientPackStateStore({ durableFs }).write(root, value), value);
  assert.deepEqual(await new ClientPackStateStore({ durableFs }).read(root), value);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), 'utf8')), value);
  assert.deepEqual(fs.readdirSync(root), [MANIFEST_NAME]);

  const before = fs.readFileSync(path.join(root, MANIFEST_NAME));
  const invalid = largeManifest(schemaVersion); invalid.entries[12925] = entry('saves/world.dat');
  await assert.rejects(new ClientPackStateStore({ durableFs }).write(root, invalid), { code: schemaVersion === 2 ? 'RECOVERY_REQUIRED' : 'UNSAFE_ARCHIVE_ENTRY' });
  assert.deepEqual(fs.readFileSync(path.join(root, MANIFEST_NAME)), before);
});

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

const WINDOWS_PATHS = { skip: process.platform !== 'win32' && 'Windows drive-letter paths' };
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const SUBFOLDER_MESSAGE = 'Matching client packs need the client folder inside another normal folder. Move this client into a subfolder, then retry.';
const LOCAL_FOLDER_MESSAGE = 'Matching client packs need the client in a normal folder on this computer, not on a network share, a mapped or SUBST drive, or a linked folder. Move this client to a normal local folder, then retry.';
const NAME_MESSAGE = 'Matching client packs need folder names without spaces at the start or end, and not copied from a Mac. Move this client to a folder with a plain name, then retry.';

function enoent(candidate) {
  return Object.assign(new Error(`ENOENT: ${candidate}`), { code: 'ENOENT' });
}

function strictRouterFixture(t, clientPaths) {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
  const { clientDurableRouter } = require('../../electron/bootstrap/create-client-pack-composition.cjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'client-state-shape-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const appRoot = path.join(base, 'client-packs');
  fs.mkdirSync(appRoot);
  const factoryCalls = [];
  const instances = [];
  const router = clientDurableRouter({
    root: appRoot,
    getInstances: () => instances,
    durableFsFactory(roots) {
      factoryCalls.push(roots);
      return createDurableFs({ allowedRoots: roots, durableClient: { moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync,
        flushDirectory() {}, moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {} } });
    }
  });
  const register = clientPath => instances.push({ id: `client-${instances.length + 1}`, type: 'client', path: clientPath });
  for (const clientPath of clientPaths) register(clientPath);
  return { appRoot, base, factoryCalls, register, router };
}

test('a client directly under a drive root without a manifest reads as unmanaged without durable authority', WINDOWS_PATHS, async t => {
  const { ClientPackStateStore } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
  const { factoryCalls, router } = strictRouterFixture(t, ['X:\\MinecraftClient']);
  const routerCalls = [];
  const durableFs = Object.fromEntries(Object.entries(router).map(([name, method]) => [name, (...args) => {
    routerCalls.push(name);
    return method(...args);
  }]));
  const fsPromises = {
    async stat(candidate) {
      if (candidate === 'X:\\MinecraftClient') return { isDirectory: () => true };
      throw enoent(candidate);
    },
    async lstat(candidate) { throw enoent(candidate); },
    async realpath(candidate) { return candidate; }
  };

  assert.equal(await new ClientPackStateStore({ durableFs, fsPromises }).read('X:\\MinecraftClient'), null);
  assert.deepEqual(routerCalls, []);
  assert.deepEqual(factoryCalls, []);
  await assert.rejects(async () => router.readFileBoundedAsync('X:\\MinecraftClient\\.minecraft-core-client-pack.json', { allowMissing: true }),
    { code: 'CLIENT_PACK_UNAVAILABLE' }, 'the strict router itself still refuses the drive-root parent');
});

test('a client reached through a junction reads as unmanaged; a manifest behind it or a corrupt one still needs recovery', async t => {
  const fs = require('node:fs'); const path = require('node:path');
  const { ClientPackStateStore, MANIFEST_NAME } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
  const { base, register, router } = strictRouterFixture(t, []);
  const realClient = path.join(base, 'real', 'Games', 'Client');
  fs.mkdirSync(realClient, { recursive: true });
  const parentLink = path.join(base, 'linked-games');
  fs.symlinkSync(path.dirname(realClient), parentLink, LINK_TYPE);
  const aliasedClient = path.join(parentLink, 'Client');
  register(aliasedClient);
  const normalClient = path.join(base, 'Normal', 'Client');
  fs.mkdirSync(normalClient, { recursive: true });
  register(normalClient);
  const store = new ClientPackStateStore({ durableFs: router });

  assert.equal(await store.read(aliasedClient), null);
  assert.equal(await store.read(normalClient), null);
  fs.writeFileSync(path.join(realClient, MANIFEST_NAME), '{}');
  await assert.rejects(store.read(aliasedClient), { code: 'RECOVERY_REQUIRED' });
  fs.writeFileSync(path.join(normalClient, MANIFEST_NAME), '{bad');
  await assert.rejects(store.read(normalClient), { code: 'RECOVERY_REQUIRED' });
});

test('publishing a matching pack asks for a subfolder or a local folder only when the folder shape is the cause', async t => {
  const fs = require('node:fs'); const path = require('node:path');
  const { ClientPackStateStore } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
  const { base, factoryCalls, register, router } = strictRouterFixture(t, []);
  const realClient = path.join(base, 'real', 'Games', 'Client');
  fs.mkdirSync(realClient, { recursive: true });
  const parentLink = path.join(base, 'linked-games');
  const leafLink = path.join(base, 'linked-client');
  fs.symlinkSync(path.dirname(realClient), parentLink, LINK_TYPE);
  fs.symlinkSync(realClient, leafLink, LINK_TYPE);
  const normalClient = path.join(base, 'Normal', 'Client');
  fs.mkdirSync(normalClient, { recursive: true });
  for (const clientPath of [path.join(parentLink, 'Client'), leafLink, normalClient]) register(clientPath);
  const store = new ClientPackStateStore({ durableFs: router });
  const rootShapes = process.platform === 'win32' ? ['X:\\MinecraftClient', 'X:\\'] : ['/MinecraftClient', '/'];
  const networkShare = process.platform === 'win32' ? '\\\\nas\\share\\MinecraftClient' : '//nas/share/MinecraftClient';

  for (const clientPath of rootShapes) {
    await assert.rejects(store.assertPublishable(clientPath), error =>
      error.code === 'CLIENT_PACK_UNAVAILABLE' && error.safeMessage === SUBFOLDER_MESSAGE, clientPath);
  }
  // A subfolder of a network share, a mapped or SUBST drive or a linked folder is still not local.
  for (const clientPath of [networkShare, path.join(parentLink, 'Client'), leafLink]) {
    await assert.rejects(store.assertPublishable(clientPath), error =>
      error.code === 'CLIENT_PACK_UNAVAILABLE' && error.safeMessage === LOCAL_FOLDER_MESSAGE, clientPath);
  }
  assert.deepEqual(factoryCalls, [], 'a refused shape never reaches the durable layer');

  assert.equal(await store.assertPublishable(normalClient), undefined);
  assert.equal(factoryCalls.length, 1);

  const unavailable = new ClientPackStateStore({ durableFs: { async readFileBoundedAsync() {
    throw Object.assign(new Error('injected durable failure'), { code: 'COMMIT_FAILED' });
  } } });
  for (const clientPath of [normalClient, path.join(base, 'Missing', 'Client')]) {
    await assert.rejects(unavailable.assertPublishable(clientPath), error =>
      error.code === 'CLIENT_PACK_UNAVAILABLE' && error.safeMessage === 'Matching client pack services are unavailable', clientPath);
  }
});

// Q4 release notes: a folder name copied from a Mac (NFD) or one with leading or
// trailing spaces is refused up front with advice, from the spelling alone.
test('publishing a matching pack asks for a plain folder name when a name is the cause, before any filesystem access', async () => {
  const path = require('node:path');
  const { ClientPackStateStore } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
  const untouched = () => assert.fail('a refused name is never inspected');
  const store = new ClientPackStateStore({ durableFs: { readFileBoundedAsync: untouched }, fsPromises: { stat: untouched, lstat: untouched, realpath: untouched } });
  const games = process.platform === 'win32' ? 'C:\\Games' : '/games';
  for (const clientPath of [path.join(games, 'Cafe\u0301 Client'), path.join(games, ' Client'), path.join(games, 'Client '), path.join(games, 'Client.'),
    path.join(games, 'Cafe\u0301', 'Client'), path.join(games, ' Minecraft', 'Client')]) {
    await assert.rejects(store.assertPublishable(clientPath), error =>
      error.code === 'CLIENT_PACK_UNAVAILABLE' && error.safeMessage === NAME_MESSAGE, JSON.stringify(clientPath));
  }
  const plain = new ClientPackStateStore({ durableFs: { async readFileBoundedAsync() { return null; } },
    fsPromises: { stat: untouched, lstat: untouched, async realpath(value) { return value; } } });
  for (const clientPath of [path.join(games, 'Caf\u00e9 Client'), path.join(games, 'My Client'), path.join(games, 'Client.v2')]) {
    assert.equal(await plain.assertPublishable(clientPath), undefined, JSON.stringify(clientPath));
  }
});

test('the state store requires a durable layer and a readable filesystem', () => {
  const { ClientPackStateStore } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
  const durableFs = { async readFileBoundedAsync() { return null; } };
  for (const options of [undefined, {}, { durableFs, fsPromises: {} }, { durableFs, fsPromises: { stat() {}, lstat() {} } }]) {
    assert.throws(() => new ClientPackStateStore(options), { code: 'RECOVERY_REQUIRED' });
  }
  assert.ok(new ClientPackStateStore({ durableFs }));
});
