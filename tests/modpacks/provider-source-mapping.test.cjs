const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createArtifactSetPlan,
  finalizeVerifiedArtifactSet
} = require('../../electron/services/modpacks/contracts.cjs');
const {
  acceptTrustedUpstreamMapping,
  artifactsAreEquivalent
} = require('../../electron/services/modpacks/providers/provider-source-mapping.cjs');

const SHA256 = '1'.repeat(64);
const SHA512 = '2'.repeat(128);

function verified(provider, sourceId, digests = [{ size: '10', sha256: SHA256, sha512: SHA512 }]) {
  const parts = digests.map((item, index) => ({
    partId: `part-${index + 1}`,
    fileName: digests.length === 1 ? 'server-pack.zip' : `server-pack.part${index + 1}.rar`,
    size: item.size
  }));
  const plan = createArtifactSetPlan({
    provider,
    project: { id: sourceId, slug: 'server-pack', title: 'Server Pack' },
    release: { id: 'release-1', version: '1.0.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' },
    artifactSet: {
      kind: parts.length === 1 ? 'single' : 'multipart',
      groupingScheme: parts.length === 1 ? 'single' : 'part-number',
      primaryPartId: parts[0].partId,
      parts,
      providerImmutable: false,
      attestationStatus: 'unverified'
    }
  });
  return finalizeVerifiedArtifactSet(plan, digests.map((item, index) => ({
    partId: `part-${index + 1}`,
    measuredSize: item.size,
    sha256: item.sha256,
    sha512: item.sha512
  })));
}

function exactResolver(overrides = {}, calls = []) {
  return async (url) => {
    calls.push(url);
    return {
      repositoryId: '123456789', owner: 'Example-Org', repo: 'Server-Pack',
      visibility: 'public', archived: false, disabled: false,
      ...overrides
    };
  };
}

test('accepts a mapping only after the exact public repository URL resolves to every supplied identity field', async () => {
  const calls = [];
  const mapping = await acceptTrustedUpstreamMapping({
    modrinthProjectId: 'modrinth-project-1', githubRepositoryId: '123456789',
    url: 'https://github.com/example-org/server-pack'
  }, { resolveRepositoryIdentity: exactResolver({}, calls) });
  assert.deepEqual(calls, ['https://github.com/example-org/server-pack']);
  assert.deepEqual(mapping, {
    type: 'provider-source-mapping', version: 1, modrinthProjectId: 'modrinth-project-1',
    githubRepositoryId: '123456789', githubOwner: 'Example-Org', githubRepo: 'Server-Pack'
  });
  assert.equal(Object.isFrozen(mapping), true);
  assert.equal(Object.hasOwn(mapping, 'url'), false);
});

test('rejects unverified and mismatched repository identities instead of trusting the caller-supplied ID or URL names', async () => {
  const input = {
    modrinthProjectId: 'm1', githubRepositoryId: '123456789',
    url: 'https://github.com/Example-Org/Server-Pack'
  };
  await assert.rejects(acceptTrustedUpstreamMapping(input), error => error.code === 'INVALID_REQUEST');
  for (const resolved of [
    { repositoryId: '999' },
    { owner: 'Other-Org' },
    { repo: 'Other-Pack' },
    { visibility: 'private' }
  ]) {
    await assert.rejects(
      acceptTrustedUpstreamMapping(input, { resolveRepositoryIdentity: exactResolver(resolved) }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('rejects release asset lookalike and malformed mapping candidates before repository resolution', async () => {
  for (const input of [
    { modrinthProjectId: 'm1', githubRepositoryId: '1', url: 'https://github.com/o/r/releases/tag/v1' },
    { modrinthProjectId: 'm1', githubRepositoryId: '1', url: 'https://github.com/o/r?token=secret' },
    { modrinthProjectId: 'm1', githubRepositoryId: '1', url: 'https://github.com.evil/o/r' },
    { modrinthProjectId: '../m1', githubRepositoryId: '1', url: 'https://github.com/o/r' },
    { modrinthProjectId: 'm1', githubRepositoryId: '01', url: 'https://github.com/o/r' },
    { modrinthProjectId: 'm1', githubRepositoryId: String(Number.MAX_SAFE_INTEGER + 1), url: 'https://github.com/o/r' }
  ]) {
    let resolverCalled = false;
    await assert.rejects(
      acceptTrustedUpstreamMapping(input, { resolveRepositoryIdentity: async () => { resolverCalled = true; } }),
      error => (error.code === 'INVALID_REQUEST' || error.code === 'INVALID_RELEASE_URL') && !String(error.message).includes('secret')
    );
    assert.equal(resolverCalled, false);
  }
});

test('equal app-issued measured bytes establish equivalence without a source mapping', () => {
  assert.equal(artifactsAreEquivalent(
    verified('modrinth', 'm1'), verified('github', '9001'), []
  ), true);
});

test('cloned persisted or forged verified DTOs cannot self-assert trusted byte equivalence', () => {
  const left = verified('modrinth', 'm1');
  const right = verified('github', '9001');
  assert.equal(artifactsAreEquivalent(structuredClone(left), right, []), false);
  assert.equal(artifactsAreEquivalent(left, JSON.parse(JSON.stringify(right)), []), false);
  assert.equal(artifactsAreEquivalent({ ...structuredClone(left), type: 'verified-artifact-set' }, {
    ...structuredClone(right), type: 'verified-artifact-set'
  }, []), false);
});

test('multipart byte equivalence requires the same ordered measured part digests', () => {
  const ordered = [
    { size: '10', sha256: SHA256, sha512: SHA512 },
    { size: '5', sha256: '3'.repeat(64), sha512: '4'.repeat(128) }
  ];
  const left = verified('modrinth', 'm1', ordered);
  const right = verified('github', '9001', ordered);
  assert.equal(artifactsAreEquivalent(left, right, []), true);
  assert.equal(artifactsAreEquivalent(left, verified('github', '9001', ordered.slice().reverse()), []), false);
});

test('an explicit permanent-ID mapping establishes cross-provider equivalence', async () => {
  const mapping = await acceptTrustedUpstreamMapping({
    modrinthProjectId: 'm1', githubRepositoryId: '123456789', url: 'https://github.com/Example-Org/Server-Pack'
  }, { resolveRepositoryIdentity: exactResolver() });
  const left = { provider: 'modrinth', project: { id: 'm1' }, displayName: 'unrelated' };
  const right = { provider: 'github', project: { id: '123456789' }, displayName: 'different' };
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
  const right = structuredClone(verified('github', '9001'));
  right.artifactSet.parts[0].calculatedDigests.sha512 = 'bad';
  assert.equal(artifactsAreEquivalent(left, right, [malformed]), false);
  assert.equal(artifactsAreEquivalent(null, right, []), false);
  assert.equal(artifactsAreEquivalent(
    { ...left, provider: 'untrusted', project: { id: 'spoof' } },
    { ...left, provider: 'untrusted', project: { id: 'spoof' } },
    []
  ), false);
});
