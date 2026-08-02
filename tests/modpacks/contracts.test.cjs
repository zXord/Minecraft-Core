const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertArtifactSetUnchanged,
  computeArtifactSetDigest,
  createArtifactSetPlan,
  finalizeVerifiedArtifactSet,
  isAppIssuedVerifiedArtifactSet,
  normalizeRuntimeTuple
} = require('../../electron/services/modpacks/contracts.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { ARCHIVE_LIMITS, computePreflightReserve } = require('../../electron/services/modpacks/limits.cjs');
const { createModpackPaths } = require('../../electron/services/modpacks/paths.cjs');

const artifactInput = Object.freeze({
  provider: 'github',
  project: { id: '101', slug: 'example-pack', title: 'Example Pack' },
  release: { id: '202', version: '1.2.3', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' },
  artifactSet: {
    kind: 'single',
    primaryPartId: 'asset-303',
    groupingScheme: 'single',
    parts: [{
      partId: 'asset-303',
      providerAssetId: '303',
      fileName: 'example-server.zip',
      size: '9007199254740992',
      updatedAt: '2026-08-01T00:00:00.000Z',
      providerDigest: { algorithm: 'sha256', value: 'a'.repeat(64) }
    }],
    providerImmutable: false,
    attestationStatus: 'unavailable'
  }
});

test('artifact plans preserve reviewed identity with immutable decimal byte fields', () => {
  const plan = createArtifactSetPlan(artifactInput);

  assert.equal(plan.type, 'artifact-set-plan');
  assert.equal(plan.artifactSet.parts[0].size, '9007199254740992');
  assert.equal(plan.artifactSet.setDigest, '5aee0c3fd428e878d884f5d1e0ab1331338cb6b45c1acfb4eafe5e52cec39d73');
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.artifactSet.parts[0]), true);
  assert.throws(() => createArtifactSetPlan({ ...artifactInput, unexpected: true }), error => error.code === 'INVALID_REQUEST');
});

test('artifact digest hashes canonical ordered part identities instead of object insertion order', () => {
  const digest = computeArtifactSetDigest([{
    updatedAt: '2026-08-01T00:00:00.000Z',
    fileName: 'example-server.zip',
    size: '9007199254740992',
    providerDigest: { value: 'a'.repeat(64), algorithm: 'sha256' },
    providerAssetId: '303',
    partId: 'asset-303'
  }]);

  assert.equal(digest, '5aee0c3fd428e878d884f5d1e0ab1331338cb6b45c1acfb4eafe5e52cec39d73');
});

test('verified artifact sets require measured SHA-256 and SHA-512 results', () => {
  const plan = createArtifactSetPlan(artifactInput);
  const verified = finalizeVerifiedArtifactSet(plan, [{
    partId: 'asset-303',
    measuredSize: '9007199254740992',
    sha256: 'b'.repeat(64),
    sha512: 'c'.repeat(128)
  }]);

  assert.equal(verified.type, 'verified-artifact-set');
  assert.deepEqual(verified.artifactSet.parts[0].calculatedDigests, {
    sha256: 'b'.repeat(64),
    sha512: 'c'.repeat(128)
  });
  assert.equal(verified.artifactSet.parts[0].measuredSize, '9007199254740992');
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(isAppIssuedVerifiedArtifactSet(verified), true);
  assert.equal(isAppIssuedVerifiedArtifactSet(structuredClone(verified)), false);
  assert.equal(isAppIssuedVerifiedArtifactSet(JSON.parse(JSON.stringify(verified))), false);
  assert.equal(Object.keys(verified).some(key => /brand|trusted/i.test(key)), false);
  assert.throws(
    () => finalizeVerifiedArtifactSet(plan, [{ partId: 'asset-303', measuredSize: '1', sha256: 'b'.repeat(64) }]),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('verified artifact sets reconstruct only allowlisted reviewed-plan fields', () => {
  const plan = createArtifactSetPlan(artifactInput);
  const forgedPlan = JSON.parse(JSON.stringify(plan));
  forgedPlan.sourceUrl = 'https://provider.example/release?token=secret';
  forgedPlan.artifactSet.cachePath = 'C:\\secret-cache';
  forgedPlan.artifactSet.parts[0].sourceUrl = 'https://provider.example/asset?token=secret';
  forgedPlan.artifactSet.parts[0].extra = 'forged';
  const verified = finalizeVerifiedArtifactSet(forgedPlan, [{
    partId: 'asset-303', measuredSize: '9007199254740992', sha256: 'b'.repeat(64), sha512: 'c'.repeat(128)
  }]);

  assert.equal(Object.hasOwn(verified, 'sourceUrl'), false);
  assert.equal(Object.hasOwn(verified.artifactSet, 'cachePath'), false);
  assert.equal(Object.hasOwn(verified.artifactSet.parts[0], 'sourceUrl'), false);
  assert.equal(Object.hasOwn(verified.artifactSet.parts[0], 'extra'), false);
});

test('artifact plans reject a reviewed-set mutation with PLAN_STALE', () => {
  const expected = createArtifactSetPlan(artifactInput);
  const actual = createArtifactSetPlan({
    ...artifactInput,
    artifactSet: { ...artifactInput.artifactSet, parts: [{ ...artifactInput.artifactSet.parts[0], size: '2' }] }
  });

  assert.throws(() => assertArtifactSetUnchanged(expected, actual), error => error instanceof ModpackError && error.code === 'PLAN_STALE');
  assert.equal(assertArtifactSetUnchanged(expected, expected), expected);
});

test('artifact plans reject primary-part and grouping metadata mutations with PLAN_STALE', () => {
  const multipartInput = {
    ...artifactInput,
    artifactSet: {
      ...artifactInput.artifactSet,
      kind: 'multipart',
      groupingScheme: 'part-number',
      parts: [
        { ...artifactInput.artifactSet.parts[0], partId: 'asset-303', fileName: 'example.part1.rar' },
        { ...artifactInput.artifactSet.parts[0], partId: 'asset-304', providerAssetId: '304', fileName: 'example.part2.rar' }
      ]
    }
  };
  const expected = createArtifactSetPlan(multipartInput);
  const primaryChanged = createArtifactSetPlan({
    ...multipartInput,
    artifactSet: { ...multipartInput.artifactSet, primaryPartId: 'asset-304' }
  });
  const groupingChanged = createArtifactSetPlan({
    ...multipartInput,
    artifactSet: { ...multipartInput.artifactSet, groupingScheme: 'numbered-volume' }
  });

  assert.throws(() => assertArtifactSetUnchanged(expected, primaryChanged), error => error.code === 'PLAN_STALE');
  assert.throws(() => assertArtifactSetUnchanged(expected, groupingChanged), error => error.code === 'PLAN_STALE');
});

test('artifact comparisons recompute digests and include provider trust metadata', () => {
  const expected = createArtifactSetPlan(artifactInput);
  const staleSerialized = JSON.parse(JSON.stringify(expected));
  staleSerialized.artifactSet.parts[0].size = '1';
  const providerImmutableChanged = JSON.parse(JSON.stringify(expected));
  providerImmutableChanged.artifactSet.providerImmutable = true;
  const attestationChanged = JSON.parse(JSON.stringify(expected));
  attestationChanged.artifactSet.attestationStatus = 'verified';

  assert.throws(() => assertArtifactSetUnchanged(expected, staleSerialized), error => error.code === 'PLAN_STALE');
  assert.throws(() => assertArtifactSetUnchanged(expected, providerImmutableChanged), error => error.code === 'PLAN_STALE');
  assert.throws(() => assertArtifactSetUnchanged(expected, attestationChanged), error => error.code === 'PLAN_STALE');
  assert.equal(assertArtifactSetUnchanged(expected, expected), expected);
});

test('artifact plans enforce inverse single and multipart grouping invariants', () => {
  assert.throws(
    () => createArtifactSetPlan({ ...artifactInput, artifactSet: { ...artifactInput.artifactSet, kind: 'multipart', groupingScheme: 'single' } }),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.throws(
    () => createArtifactSetPlan({ ...artifactInput, artifactSet: { ...artifactInput.artifactSet, kind: 'single', groupingScheme: 'part-number' } }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('artifact plans reject ADS, Windows devices, and invalid Windows basename aliases', () => {
  for (const fileName of ['part:1.rar', 'CON.zip', 'aux .rar', 'LPT1', 'bad?.zip']) {
    assert.throws(
      () => createArtifactSetPlan({ ...artifactInput, artifactSet: { ...artifactInput.artifactSet, parts: [{ ...artifactInput.artifactSet.parts[0], fileName }] } }),
      error => error.code === 'INVALID_REQUEST',
      fileName
    );
  }
});

test('runtime tuples accept only exact supported loader identity', () => {
  const runtime = normalizeRuntimeTuple({
    minecraftVersion: '1.21.1', loaderFamily: 'neoforge', loaderVersion: '21.1.99', javaMajor: 21, os: 'win32', architecture: 'x64'
  });

  assert.deepEqual(runtime, {
    minecraftVersion: '1.21.1', loaderFamily: 'neoforge', loaderVersion: '21.1.99', javaMajor: 21, os: 'win32', architecture: 'x64'
  });
  assert.equal(Object.isFrozen(runtime), true);
  assert.throws(
    () => normalizeRuntimeTuple({ ...runtime, loaderFamily: 'latest' }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('central archive limits use decimal public bytes and bigint-safe reserve arithmetic', () => {
  assert.equal(ARCHIVE_LIMITS.version, 1);
  assert.equal(ARCHIVE_LIMITS.maxArtifactSetBytes, '17179869184');
  assert.equal(ARCHIVE_LIMITS.maxExpandedBytes, '68719476736');
  assert.equal(computePreflightReserve('90071992547409920'), '9007199254740992');
  assert.equal(computePreflightReserve('1'), '2147483648');
});

test('modpack path roots stay below the application userData lifecycle root', () => {
  const roots = createModpackPaths('C:\\app-data');

  assert.deepEqual(roots, {
    root: 'C:\\app-data\\modpack-lifecycle',
    cache: 'C:\\app-data\\modpack-lifecycle\\cache',
    selections: 'C:\\app-data\\modpack-lifecycle\\selections',
    notifications: 'C:\\app-data\\modpack-lifecycle\\notifications',
    recoveryActive: 'C:\\app-data\\modpack-lifecycle\\active',
    recoveryHistory: 'C:\\app-data\\modpack-lifecycle\\history',
    operations: 'C:\\app-data\\modpack-lifecycle\\operations',
    plans: 'C:\\app-data\\modpack-lifecycle\\plans',
    workspaces: 'C:\\app-data\\modpack-lifecycle\\workspaces'
  });
  assert.equal(Object.isFrozen(roots), true);
});
