const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const githubHarness = require('./e2e/fixtures/real-github-releases-harness.cjs');
const continuation = require('./e2e/fixtures/preserved-real-github-releases-harness.cjs');

async function createFixture({
  identity = continuation.GITHUB_CONTINUATION_IDENTITY,
  source = null,
  runtime = null,
  prefix = continuation.GITHUB_CONTINUATION_SCRATCH_PREFIX
} = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const userDataPath = path.join(root, 'user-data');
  const serverPath = path.join(root, 'server');
  const clientPath = path.join(root, 'client');
  const evidencePath = path.join(root, 'evidence');
  const stateDirectory = path.join(serverPath, '.minecraft-core-state');
  const configDirectory = path.join(userDataPath, 'config');
  const expectedRelease = githubHarness.REAL_GITHUB_RELEASE_MONITOR;
  const expectedRuntime = githubHarness.REAL_GITHUB_SERVER_PACK.runtimeChoice;
  await Promise.all([
    fsp.mkdir(stateDirectory, { recursive: true }),
    fsp.mkdir(configDirectory, { recursive: true }),
    fsp.mkdir(clientPath, { recursive: true }),
    fsp.mkdir(evidencePath, { recursive: true })
  ]);
  await Promise.all([
    fsp.writeFile(path.join(root, 'real-lifecycle-identity.json'), JSON.stringify(identity), 'utf8'),
    fsp.writeFile(path.join(stateDirectory, 'modpack.json'), JSON.stringify({
      schemaVersion: 1,
      modpackManaged: true,
      contentRevision: 5,
      source: source ?? {
        provider: 'github',
        repositoryId: expectedRelease.repositoryId,
        releaseId: expectedRelease.olderReleaseId,
        version: expectedRelease.olderTagName
      },
      runtime: runtime ?? expectedRuntime
    }), 'utf8'),
    fsp.writeFile(path.join(configDirectory, 'minecraft-core-config.json'), JSON.stringify({
      lastServerPath: serverPath,
      instances: [{ id: 'disposable-github-server', name: 'server', type: 'server', path: serverPath }]
    }), 'utf8')
  ]);
  githubHarness.createUnmanagedSentinel({ serverPath });
  return { root, serverPath };
}

async function removeFixture(root) {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved).toLocaleLowerCase('en-US'), path.resolve(os.tmpdir()).toLocaleLowerCase('en-US'));
  await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}

test('GitHub continuation is enabled only by both explicit opt-in variables', () => {
  assert.equal(continuation.isPreservedGitHubLifecycleEnabled({}), false);
  assert.equal(continuation.isPreservedGitHubLifecycleEnabled({
    [githubHarness.REAL_GITHUB_RELEASES_ENV]: '1'
  }), false);
  assert.equal(continuation.isPreservedGitHubLifecycleEnabled({
    [githubHarness.REAL_GITHUB_RELEASES_ENV]: '1',
    [continuation.REAL_GITHUB_CONTINUATION_ROOT_ENV]: ' C:\\temp\\minecraft-core-real-github-releases-e2e-exact '
  }), true);
  assert.equal(continuation.getPreservedGitHubLifecycleRoot({
    [continuation.REAL_GITHUB_CONTINUATION_ROOT_ENV]: ' C:\\temp\\exact '
  }), 'C:\\temp\\exact');
});

test('GitHub continuation adopts only the exact downgraded disposable lifecycle and preserves it by default', async () => {
  const fixture = await createFixture();
  try {
    const lifecycle = await continuation.loadPreservedGitHubLifecycle(fixture.root);
    assert.equal(lifecycle.root, path.resolve(fixture.root));
    assert.equal(lifecycle.serverPath, fixture.serverPath);
    assert.equal(lifecycle.instanceId, 'disposable-github-server');
    assert.equal(lifecycle.scratchLabel, 'github-releases');
    assert.equal(githubHarness.assertUnmanagedSentinel(lifecycle).relativePath, githubHarness.UNMANAGED_SENTINEL_RELATIVE_PATH);
    await lifecycle.dispose();
    await fsp.access(fixture.root);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('GitHub continuation rejects the wrong prefix, identity, release, runtime, or missing sentinel', async () => {
  const wrongPrefix = await createFixture({ prefix: 'minecraft-core-real-modrinth-e2e-' });
  const wrongIdentity = await createFixture({ identity: { provider: 'github-releases', harness: 'wrong' } });
  const wrongRelease = await createFixture({
    source: { provider: 'github', repositoryId: '451038871', releaseId: '274141765', version: '1.7.7' }
  });
  const wrongRuntime = await createFixture({
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.16.0' }
  });
  const missingSentinel = await createFixture();
  await fsp.rm(path.join(missingSentinel.serverPath, ...githubHarness.UNMANAGED_SENTINEL_RELATIVE_PATH.split('/')));
  try {
    await assert.rejects(continuation.loadPreservedGitHubLifecycle(wrongPrefix.root), /exact GitHub Releases continuation prefix/iu);
    await assert.rejects(continuation.loadPreservedGitHubLifecycle(wrongIdentity.root), /identity does not match/iu);
    await assert.rejects(continuation.loadPreservedGitHubLifecycle(wrongRelease.root), /approved exact downgraded GitHub release/iu);
    await assert.rejects(continuation.loadPreservedGitHubLifecycle(wrongRuntime.root), /runtime does not match/iu);
    await assert.rejects(continuation.loadPreservedGitHubLifecycle(missingSentinel.root), /sentinel is missing/iu);
  } finally {
    await Promise.all([wrongPrefix, wrongIdentity, wrongRelease, wrongRuntime, missingSentinel].map(fixture => removeFixture(fixture.root)));
  }
});
