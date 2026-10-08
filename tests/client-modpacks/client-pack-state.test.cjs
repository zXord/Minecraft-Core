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
