const assert = require('node:assert/strict');
const test = require('node:test');

const { createArtifactSetPlan } = require('../../electron/services/modpacks/contracts.cjs');
const { validateCompleteArtifactSet } = require('../../electron/services/modpacks/artifacts/artifact-set.cjs');
const { canonicalPartIdentity, computePlanFingerprint } = require('../../electron/services/modpacks/artifacts/artifact-fingerprint.cjs');
const { finalizeVerifiedArtifactSet } = require('../../electron/services/modpacks/contracts.cjs');

function plan(parts = [{ partId: 'asset-1', providerAssetId: '1', fileName: 'server.zip', size: '10' }]) {
  return createArtifactSetPlan({
    provider: 'github',
    project: { id: 'repo-1', slug: 'repo', title: 'Repo' },
    release: { id: 'release-1', version: '1.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' },
    artifactSet: { kind: parts.length === 1 ? 'single' : 'multipart', groupingScheme: parts.length === 1 ? 'single' : 'part-number', primaryPartId: parts[0].partId, parts, providerImmutable: false, attestationStatus: 'unverified' }
  });
}

test('validates a reviewed set without promoting provisional names to verified completeness', () => {
  const result = validateCompleteArtifactSet(plan());
  assert.equal(result.type, 'provisional-artifact-set');
  assert.equal(result.verificationState, 'provisional');
  assert.equal(result.plan.artifactSet.parts[0].fileName, 'server.zip');
});

test('rejects set mutation after the reviewed digest was created', () => {
  const reviewed = JSON.parse(JSON.stringify(plan()));
  reviewed.artifactSet.parts[0].size = '11';
  assert.throws(() => validateCompleteArtifactSet(reviewed), error => error.code === 'PLAN_STALE');
});

test('rejects case and Unicode-equivalent part basenames in one reviewed set', () => {
  const multipart = plan([
    { partId: 'asset-1', providerAssetId: '1', fileName: 'caf\u00e9.part1.rar', size: '10' },
    { partId: 'asset-2', providerAssetId: '2', fileName: 'cafe\u0301.PART1.RAR', size: '10' }
  ]);
  assert.throws(() => validateCompleteArtifactSet(multipart), error => error.code === 'INVALID_REQUEST');
});

test('fingerprints canonical reviewed identity and changes when the plan changes', () => {
  const first = plan();
  const changed = plan([{ partId: 'asset-1', providerAssetId: '1', fileName: 'server.zip', size: '11' }]);
  assert.match(computePlanFingerprint(first), /^[a-f0-9]{64}$/);
  assert.notEqual(computePlanFingerprint(first), computePlanFingerprint(changed));
  assert.deepEqual(canonicalPartIdentity(first.artifactSet.parts[0]), {
    partId: 'asset-1', providerAssetId: '1', fileName: 'server.zip', size: '10', updatedAt: null, providerDigest: null
  });
});

test('fingerprints verified byte identity even when provider metadata is unchanged', () => {
  const reviewed = plan();
  const first = finalizeVerifiedArtifactSet(reviewed, [{ partId: 'asset-1', measuredSize: '10', sha256: 'a'.repeat(64), sha512: 'b'.repeat(128) }]);
  const changedBytes = finalizeVerifiedArtifactSet(reviewed, [{ partId: 'asset-1', measuredSize: '10', sha256: 'c'.repeat(64), sha512: 'd'.repeat(128) }]);
  assert.notEqual(computePlanFingerprint(first), computePlanFingerprint(changedBytes));
});
