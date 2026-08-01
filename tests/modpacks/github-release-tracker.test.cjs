const assert = require('node:assert/strict');
const test = require('node:test');

const { compareReleaseSnapshot } = require('../../electron/services/modpacks/providers/github-release-tracker.cjs');

const SHA = 'a'.repeat(64);
const previous = Object.freeze({
  repositoryId: '101', releaseId: '201', tagName: 'v1.0.0', prerelease: false,
  publishedAt: '2026-07-01T00:00:00.000Z', assetId: '301', size: 100,
  providerDigest: { algorithm: 'sha256', value: SHA }, updatedAt: '2026-07-01T00:01:00.000Z'
});

test('a republished asset is never classified as a normal update', () => {
  assert.equal(compareReleaseSnapshot(previous, { ...previous, size: previous.size + 1 }).type, 'ASSET_CHANGED');
});

test('identical complete snapshots produce an immutable no-change result', () => {
  const result = compareReleaseSnapshot(previous, { ...previous, providerDigest: { ...previous.providerDigest } });
  assert.deepEqual(result, { type: 'NO_CHANGE' });
  assert.equal(Object.isFrozen(result), true);
});

test('same-tag release asset digest size and update-time mutations all produce ASSET_CHANGED', () => {
  const variants = [
    { ...previous, releaseId: '202' },
    { ...previous, assetId: '302' },
    { ...previous, providerDigest: { algorithm: 'sha256', value: 'b'.repeat(64) } },
    { ...previous, providerDigest: null },
    { ...previous, size: 101 },
    { ...previous, updatedAt: '2026-07-01T00:02:00.000Z' }
  ];
  for (const current of variants) {
    assert.equal(compareReleaseSnapshot(previous, current).type, 'ASSET_CHANGED');
  }
});

test('multipart snapshots compare the exact selected asset ID set and every part evidence field', () => {
  const base = {
    repositoryId: '101', releaseId: '210', tagName: 'v2', prerelease: false,
    publishedAt: '2026-07-02T00:00:00.000Z', assets: [
      { assetId: '401', size: '10', providerDigest: { algorithm: 'sha256', value: '1'.repeat(64) }, updatedAt: '2026-07-02T00:01:00.000Z' },
      { assetId: '402', size: '20', providerDigest: null, updatedAt: '2026-07-02T00:02:00.000Z' }
    ]
  };
  assert.equal(compareReleaseSnapshot(base, structuredClone(base)).type, 'NO_CHANGE');
  assert.equal(compareReleaseSnapshot(base, { ...structuredClone(base), assets: [base.assets[0]] }).type, 'ASSET_CHANGED');
  assert.equal(compareReleaseSnapshot(base, {
    ...structuredClone(base), assets: [base.assets[0], { ...base.assets[1], updatedAt: '2026-07-02T00:03:00.000Z' }]
  }).type, 'ASSET_CHANGED');
});

test('newer tags distinguish stable and prerelease channels without treating older releases as updates', () => {
  assert.deepEqual(compareReleaseSnapshot(previous, {
    ...previous, releaseId: '211', assetId: '311', tagName: 'v2.0.0',
    publishedAt: '2026-07-03T00:00:00.000Z', updatedAt: '2026-07-03T00:01:00.000Z'
  }), { type: 'NEWER_STABLE', releaseId: '211', tagName: 'v2.0.0' });
  assert.deepEqual(compareReleaseSnapshot(previous, {
    ...previous, releaseId: '212', assetId: '312', tagName: 'v2.1.0-beta', prerelease: true,
    publishedAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:01:00.000Z'
  }), { type: 'NEWER_PRERELEASE', releaseId: '212', tagName: 'v2.1.0-beta' });
  assert.equal(compareReleaseSnapshot(previous, {
    ...previous, releaseId: '190', assetId: '290', tagName: 'v0.9.0',
    publishedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:01:00.000Z'
  }).type, 'NO_CHANGE');
});

test('same permanent release ID under a different tag is a source mutation', () => {
  assert.equal(compareReleaseSnapshot(previous, { ...previous, tagName: 'retagged' }).type, 'ASSET_CHANGED');
});

test('invalid incomplete cross-repository and unsafe snapshots fail closed without leaking values', () => {
  for (const [left, right] of [
    [{ ...previous, size: -1 }, previous],
    [previous, { ...previous, repositoryId: '102' }],
    [previous, { ...previous, updatedAt: 'not-a-time?token=secret' }],
    [previous, { ...previous, updatedAt: '2026-02-30T00:00:00.000Z' }],
    [previous, { ...previous, providerDigest: { algorithm: 'md5', value: 'x' } }],
    [{ ...previous, assetId: undefined }, previous]
  ]) {
    assert.throws(() => compareReleaseSnapshot(left, right), error =>
      error.code === 'INVALID_REQUEST' && !String(error.message).includes('secret'));
  }
});
