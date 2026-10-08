const assert = require('node:assert/strict');
const test = require('node:test');

const { ProductionModpackSourceResolver } = require('../../electron/services/modpacks/providers/production-source-resolver.cjs');

const verifiedLocal = {
  type: 'verified-artifact-set', provider: 'local',
  artifactSet: { setDigest: 'a'.repeat(64) }
};

function fixture() {
  const githubPlan = {
    type: 'github-plan',
    artifactSet: {
      kind: 'single', groupingScheme: 'single', primaryPartId: 'asset-301',
      parts: [{ partId: 'asset-301', providerAssetId: '301', fileName: 'server-pack-v2.0.0.zip' }]
    }
  };
  const modrinthPlan = { type: 'modrinth-plan' };
  const calls = [];
  const github = {
    repository(id) {
      assert.equal(id, '101');
      return { repositoryId: '101', owner: 'Owner', repo: 'Pack', fullName: 'Owner/Pack', visibility: 'public' };
    },
    async getRelease(value) {
      calls.push(['getRelease', value]);
      return {
        releaseId: '201',
        tagName: 'v2.0.0-beta.1',
        channel: 'prerelease',
        prerelease: true,
        publishedAt: '2026-07-31T20:15:00.000Z'
      };
    },
    async buildArtifactSetPlan(value) {
      calls.push(['buildArtifactSetPlan', value]);
      return githubPlan;
    },
    async getRepositoryIdentity(url) {
      calls.push(['getRepositoryIdentity', url]);
      return { repositoryId: '101', owner: 'Owner', repo: 'Pack', visibility: 'public' };
    }
  };
  const modrinth = {
    async getVersion(id) {
      calls.push(['getVersion', id]);
      return {
        versionId: 'version-one', projectId: 'project-one', version: '2.0.0-beta.1',
        channel: 'beta', publishedAt: '2026-07-30T10:15:00.000Z'
      };
    },
    async resolveArtifactSetPlan(id) { calls.push(['resolveArtifactSetPlan', id]); return modrinthPlan; },
    async getProject(id) {
      calls.push(['getProject', id]);
      return {
        projectId: id, title: 'Mapped Pack',
        upstreamLinkCandidates: [{ kind: 'source', urlCandidate: 'https://github.com/Owner/Pack' }]
      };
    }
  };
  const localArtifactSource = {
    async ingestSelection(id) { calls.push(['ingestSelection', id]); return verifiedLocal; }
  };
  return {
    calls, githubPlan, modrinthPlan,
    modrinth,
    resolver: new ProductionModpackSourceResolver({ providers: { github, modrinth }, localArtifactSource })
  };
}

test('resolves exact provider identities and preserves GitHub review intent internally', async () => {
  const f = fixture();
  assert.deepEqual(await f.resolver.resolveArtifactSetPlan({ provider: 'modrinth', projectId: 'project-one', versionId: 'version-one' }), {
    artifactSetPlan: f.modrinthPlan,
    source: {
      provider: 'modrinth', projectId: 'project-one', versionId: 'version-one',
      version: '2.0.0-beta.1', title: 'Mapped Pack', channel: 'beta', prerelease: true,
      publishedAt: '2026-07-30T10:15:00.000Z'
    }
  });

  const github = await f.resolver.resolveArtifactSetPlan({
    provider: 'github', repositoryId: '101', releaseId: '201', assetIds: ['301'],
    rememberAssetPattern: true, linkedModrinthProjectId: 'project-one'
  });
  assert.equal(github.artifactSetPlan, f.githubPlan);
  assert.deepEqual(github.source, {
    provider: 'github', repositoryId: '101', releaseId: '201', githubOwner: 'Owner', githubRepo: 'Pack',
    version: 'v2.0.0-beta.1', title: 'Pack', channel: 'prerelease', prerelease: true,
    publishedAt: '2026-07-31T20:15:00.000Z', rememberAssetPattern: true, selectedAssetIds: ['301'],
    assetPatternSeed: {
      fileNames: ['server-pack-v2.0.0.zip'],
      multipartStructure: { kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 }
    },
    acceptedMapping: {
      type: 'provider-source-mapping', version: 1, modrinthProjectId: 'project-one',
      githubRepositoryId: '101', githubOwner: 'Owner', githubRepo: 'Pack'
    }
  });
  assert.deepEqual(f.calls.filter(call => call[0] === 'buildArtifactSetPlan'), [[
    'buildArtifactSetPlan', { repositoryId: '101', releaseId: '201', selectedAssetIds: ['301'] }
  ]]);
});

test('remembered GitHub review intent rejects a provider plan whose exact selected structure cannot be bound', async () => {
  const f = fixture();
  f.githubPlan.artifactSet.parts[0].providerAssetId = '999';
  await assert.rejects(f.resolver.resolveArtifactSetPlan({
    provider: 'github', repositoryId: '101', releaseId: '201', assetIds: ['301'], rememberAssetPattern: true
  }), error => error.code === 'INVALID_REQUEST');
});

test('local imports carry only the app-issued verified set and its complete-set digest', async () => {
  const f = fixture();
  assert.deepEqual(await f.resolver.resolveArtifactSetPlan({ provider: 'local', selectionId: 'selection-one' }), {
    artifactSetPlan: verifiedLocal,
    source: {
      provider: 'local', importId: 'selection-one', artifactSha256: 'a'.repeat(64),
      version: 'local-import', title: 'Local archive'
    }
  });
});

test('local source resolution forwards the exact cancellation signal and progress callback', async () => {
  const f = fixture();
  const controller = new AbortController();
  const progress = () => {};
  let received;
  f.resolver.localArtifactSource.ingestSelection = async (selectionId, options) => {
    received = { selectionId, options };
    return verifiedLocal;
  };

  await f.resolver.resolveArtifactSetPlan({ provider: 'local', selectionId: 'selection-one' }, {
    signal: controller.signal,
    onProgress: progress
  });

  assert.equal(received.selectionId, 'selection-one');
  assert.equal(received.options.signal, controller.signal);
  assert.equal(received.options.onProgress, progress);
});

test('provider identity mismatches fail closed before an artifact is accepted', async () => {
  const f = fixture();
  await assert.rejects(
    f.resolver.resolveArtifactSetPlan({ provider: 'modrinth', projectId: 'wrong-project', versionId: 'version-one' }),
    error => error.code === 'PLAN_STALE'
  );
});

test('Modrinth source resolution falls back to the reviewed version title when the optional project lookup is unavailable', async () => {
  for (const projectLookup of ['missing', 'null']) {
    const f = fixture();
    if (projectLookup === 'missing') delete f.modrinth.getProject;
    else f.modrinth.getProject = async () => null;

    const result = await f.resolver.resolveArtifactSetPlan({
      provider: 'modrinth', projectId: 'project-one', versionId: 'version-one'
    });

    assert.equal(result.source.title, 'project-one', projectLookup);
    assert.equal(result.source.version, '2.0.0-beta.1', projectLookup);
  }
});
