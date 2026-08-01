const assert = require('node:assert/strict');
const test = require('node:test');

const {
  acceptTrustedUpstreamMapping,
  artifactsAreEquivalent
} = require('../../electron/services/modpacks/providers/provider-source-mapping.cjs');

const SHA256 = '1'.repeat(64);
const SHA512 = '2'.repeat(128);

function verified(provider, sourceId, sha256 = SHA256, sha512 = SHA512) {
  return {
    type: 'verified-artifact-set', provider,
    project: { id: sourceId },
    artifactSet: {
      kind: 'single', groupingScheme: 'single', primaryPartId: 'part-1',
      parts: [{
        partId: 'part-1', measuredSize: '10',
        calculatedDigests: { sha256, sha512 }
      }]
    }
  };
}

test('accepts an explicit exact repository mapping keyed only by permanent provider IDs', () => {
  const mapping = acceptTrustedUpstreamMapping({
    modrinthProjectId: 'modrinth-project-1', githubRepositoryId: '123456789',
    url: 'https://github.com/Example-Org/Server-Pack'
  });
  assert.deepEqual(mapping, {
    type: 'provider-source-mapping', version: 1, modrinthProjectId: 'modrinth-project-1',
    githubRepositoryId: '123456789', githubOwner: 'Example-Org', githubRepo: 'Server-Pack'
  });
  assert.equal(Object.isFrozen(mapping), true);
  assert.equal(Object.hasOwn(mapping, 'url'), false);
});

test('rejects release asset lookalike and malformed mapping candidates', () => {
  for (const input of [
    { modrinthProjectId: 'm1', githubRepositoryId: '1', url: 'https://github.com/o/r/releases/tag/v1' },
    { modrinthProjectId: 'm1', githubRepositoryId: '1', url: 'https://github.com/o/r?token=secret' },
    { modrinthProjectId: 'm1', githubRepositoryId: '1', url: 'https://github.com.evil/o/r' },
    { modrinthProjectId: '../m1', githubRepositoryId: '1', url: 'https://github.com/o/r' },
    { modrinthProjectId: 'm1', githubRepositoryId: '01', url: 'https://github.com/o/r' },
    { modrinthProjectId: 'm1', githubRepositoryId: String(Number.MAX_SAFE_INTEGER + 1), url: 'https://github.com/o/r' }
  ]) {
    assert.throws(() => acceptTrustedUpstreamMapping(input), error =>
      (error.code === 'INVALID_REQUEST' || error.code === 'INVALID_RELEASE_URL') && !String(error.message).includes('secret'));
  }
});

test('equal application-calculated trusted bytes establish equivalence without a source mapping', () => {
  assert.equal(artifactsAreEquivalent(
    verified('modrinth', 'm1'), verified('github', '9001'), []
  ), true);
});

test('multipart byte equivalence requires the same ordered measured part digests', () => {
  const left = verified('modrinth', 'm1');
  left.artifactSet.kind = 'multipart';
  left.artifactSet.groupingScheme = 'part-number';
  left.artifactSet.parts.push({
    partId: 'part-2', measuredSize: '5', calculatedDigests: { sha256: '3'.repeat(64), sha512: '4'.repeat(128) }
  });
  const right = structuredClone(left);
  right.provider = 'github';
  right.project.id = '9001';
  assert.equal(artifactsAreEquivalent(left, right, []), true);
  right.artifactSet.parts.reverse();
  assert.equal(artifactsAreEquivalent(left, right, []), false);
});

test('an explicit permanent-ID mapping establishes cross-provider equivalence', () => {
  const mapping = acceptTrustedUpstreamMapping({
    modrinthProjectId: 'm1', githubRepositoryId: '9001', url: 'https://github.com/owner/repo'
  });
  const left = { provider: 'modrinth', project: { id: 'm1' }, displayName: 'unrelated' };
  const right = { provider: 'github', project: { id: '9001' }, displayName: 'different' };
  assert.equal(artifactsAreEquivalent(left, right, [mapping]), true);
  assert.equal(artifactsAreEquivalent(right, left, [mapping]), true);
});

test('names slugs tags filenames provider digests and coincident cross-provider IDs never establish equivalence', () => {
  const left = {
    provider: 'modrinth', project: { id: 'same', slug: 'pack' }, release: { version: 'v1' },
    artifactSet: { parts: [{ fileName: 'server.zip', providerDigest: { algorithm: 'sha256', value: SHA256 } }] }
  };
  const right = {
    provider: 'github', project: { id: 'same', slug: 'pack' }, release: { version: 'v1' },
    artifactSet: { parts: [{ fileName: 'server.zip', providerDigest: { algorithm: 'sha256', value: SHA256 } }] }
  };
  assert.equal(artifactsAreEquivalent(left, right, []), false);
});

test('malformed mappings and incomplete calculated digest evidence fail closed as non-equivalent', () => {
  const malformed = {
    type: 'provider-source-mapping', version: 1, modrinthProjectId: 'other',
    githubRepositoryId: '9001', githubOwner: 'owner', githubRepo: 'repo', url: 'https://evil.example'
  };
  const left = verified('modrinth', 'm1');
  const right = verified('github', '9001');
  right.artifactSet.parts[0].calculatedDigests.sha512 = 'bad';
  assert.equal(artifactsAreEquivalent(left, right, [malformed]), false);
  assert.equal(artifactsAreEquivalent(null, right, []), false);
  assert.equal(artifactsAreEquivalent(
    { ...left, provider: 'untrusted', project: { id: 'spoof' } },
    { ...left, provider: 'untrusted', project: { id: 'spoof' } },
    []
  ), false);
});
