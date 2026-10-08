const test = require('node:test');
const assert = require('node:assert/strict');
const { serverPackFingerprint, normalizeCompanionDescriptor, normalizeCompanionRecord } = require('../../electron/services/client-modpacks/companion-contracts.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');

const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' };
const source = { provider: 'github', repositoryId: '123', githubOwner: 'Pack-Team', githubRepo: 'Pack', releaseId: '456', selectedAssetIds: ['12', '11'], artifactSetDigest: 'a'.repeat(64), version: 'v1', title: 'Title' };
const state = () => ({ modpackManaged: true, source: { ...source }, runtime: { ...runtime }, selectedOptionalFiles: ['z', 'a'], installedAt: 'today', contentRevision: '1', manifest: { id: 'one' } });

// Including mutable presentation/publication data loses historical pairings after rollback.
test('fingerprint ignores presentation and publication metadata and canonicalizes choices', () => {
  const first = state();
  const second = { ...state(), installedAt: 'tomorrow', contentRevision: '100', manifest: { id: 'two' }, source: { ...source, title: 'Renamed', version: 'renamed', selectedAssetIds: ['11', '12'] }, selectedOptionalFiles: ['a', 'z'] };
  assert.match(serverPackFingerprint(first), /^[a-f0-9]{64}$/);
  assert.equal(serverPackFingerprint(first), serverPackFingerprint(second));
});
test('release, artifact digest, runtime, and optional choices independently change identity', () => {
  const baseline = serverPackFingerprint(state());
  for (const changed of [
    { ...state(), source: { ...source, releaseId: '457' } },
    { ...state(), source: { ...source, artifactSetDigest: 'b'.repeat(64) } },
    { ...state(), runtime: { ...runtime, loaderVersion: '47.3.13' } },
    { ...state(), selectedOptionalFiles: ['a'] }
  ]) assert.notEqual(serverPackFingerprint(changed), baseline);
});
test('irrelevant large manifest content never changes canonical identity availability', () => {
  const large = { ...state(), manifest: { entries: Array.from({ length: 10001 }, () => ({ path: 'ignored' })) } };
  assert.equal(serverPackFingerprint(large), serverPackFingerprint(state()));
});
test('missing canonical identity and untrusted sources are unavailable', () => {
  for (const changed of [ { ...state(), source: { ...source, artifactSetDigest: undefined } }, { ...state(), source: { ...source, provider: 'https://evil.test' } }, { ...state(), runtime: null } ]) {
    assert.throws(() => serverPackFingerprint(changed), { code: 'CLIENT_PACK_UNAVAILABLE' });
  }
});
test('descriptor accepts only exact source identifiers and a complete ready binding', () => {
  const value = { schemaVersion: 1, status: 'ready', serverFingerprint: 'a'.repeat(64), serverVersion: 'v1', source: { provider: 'github', repositoryId: '123', githubOwner: 'Pack-Team', githubRepo: 'Pack', releaseId: '456', assetId: '20' }, runtime, artifactSha256: 'b'.repeat(64) };
  assert.deepEqual(normalizeCompanionDescriptor(value), value);
  for (const bad of [{ ...value, url: 'https://evil.test' }, { ...value, source: { ...value.source, downloadUrl: 'https://evil.test' } }, { ...value, source: { ...value.source, provider: 'local' } }, { ...value, artifactSha256: null }, { ...value, status: 'unpaired' }]) {
    assert.throws(() => normalizeCompanionDescriptor(bad), { code: 'INVALID_REQUEST' });
  }
});
test('unavailable failures serialize without unsafe details', () => {
  const result = new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The matching client pack is unavailable', { details: { path: 'secret' } }).toPublicResult();
  assert.equal(result.error.code, 'CLIENT_PACK_UNAVAILABLE');
  assert.deepEqual(result.error.details, {});
});

const ready = runtimeValue => ({ schemaVersion: 1, status: 'ready', serverFingerprint: 'a'.repeat(64), serverVersion: 'v1', source: { provider: 'modrinth', projectId: 'project', versionId: 'version' }, runtime: runtimeValue, artifactSha256: 'b'.repeat(64) });
const unsafeLoaderVersions = [
  'https://example.invalid/private?token=secret', 'file:///C:/private', 'C:\\private\\loader', 'C:loader',
  '/private/loader', '..\\loader', '../loader', '.', '..', '47.3.12/loader', '47.3.12:secret',
  '47.3.12?token=secret', '47.3.12#fragment', '47.3.12%2fprivate', '47.3.12\n', '47.3.12\u007f',
  '47.3.12\u0085', '47.3.12\u202e', '47.3.12\u200b', ' 47.3.12', '47.3.12 ', '47.3.12 build'
];
// Removing companion runtime validation must reopen all three public/canonical boundaries.
for (const loaderVersion of unsafeLoaderVersions) {
  test(`companion descriptors reject unsafe loader identity ${JSON.stringify(loaderVersion)}`, () => {
    assert.throws(() => normalizeCompanionDescriptor(ready({ ...runtime, loaderVersion })), { code: 'INVALID_REQUEST' });
  });
  test(`companion records reject unsafe loader identity ${JSON.stringify(loaderVersion)}`, () => {
    assert.throws(() => normalizeCompanionRecord({ serverId: 'server-one', descriptor: ready({ ...runtime, loaderVersion }) }), { code: 'INVALID_REQUEST' });
  });
  test(`server fingerprints reject unsafe loader identity ${JSON.stringify(loaderVersion)}`, () => {
    assert.throws(() => serverPackFingerprint({ ...state(), runtime: { ...runtime, loaderVersion } }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  });
}
test('supported loader identities preserve exact legitimate punctuation across companion boundaries', () => {
  for (const [loaderFamily, loaderVersion] of [
    ['vanilla', '1.20.1'], ['forge', '1.20.1-47.3.12'], ['neoforge', '21.1.0-beta'],
    ['fabric', '0.16.10+build.1'], ['quilt', '0.28.0-beta.1'], ['fabric', '0.16.10_build-1']
  ]) {
    const selected = { ...runtime, loaderFamily, loaderVersion };
    assert.deepEqual(normalizeCompanionDescriptor(ready(selected)).runtime, selected);
    assert.deepEqual(normalizeCompanionRecord({ serverId: 'server-one', descriptor: ready(selected) }).descriptor.runtime, selected);
    assert.match(serverPackFingerprint({ ...state(), runtime: selected }), /^[a-f0-9]{64}$/);
  }
});
module.exports = { runtime, source, state };
