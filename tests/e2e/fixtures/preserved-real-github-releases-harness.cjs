const path = require('node:path');

const githubHarness = require('./real-github-releases-harness.cjs');
const preservedHarness = require('./preserved-real-modrinth-harness.cjs');

const REAL_GITHUB_CONTINUATION_ROOT_ENV = 'MINECRAFT_CORE_REAL_GITHUB_RELEASES_CONTINUATION_ROOT';
const GITHUB_CONTINUATION_SCRATCH_PREFIX = 'minecraft-core-real-github-releases-e2e-';
const GITHUB_CONTINUATION_IDENTITY = Object.freeze({
  provider: 'github-releases',
  harness: 'real-github-releases'
});

function getPreservedGitHubLifecycleRoot(environment = process.env) {
  const value = environment?.[REAL_GITHUB_CONTINUATION_ROOT_ENV];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

function isPreservedGitHubLifecycleEnabled(environment = process.env) {
  return githubHarness.isRealGitHubReleasesEnabled(environment) &&
    getPreservedGitHubLifecycleRoot(environment) !== null;
}

function validateApprovedGitHubManagedState(state) {
  const source = state?.source;
  const expectedRelease = githubHarness.REAL_GITHUB_RELEASE_MONITOR;
  const expectedRuntime = githubHarness.REAL_GITHUB_SERVER_PACK.runtimeChoice;
  if (state?.modpackManaged !== true || source?.provider !== 'github' ||
      source?.repositoryId !== expectedRelease.repositoryId ||
      source?.releaseId !== expectedRelease.olderReleaseId ||
      source?.version !== expectedRelease.olderTagName) {
    throw new Error('The preserved lifecycle is not the approved exact downgraded GitHub release');
  }
  if (state.runtime?.minecraftVersion !== expectedRuntime.minecraftVersion ||
      state.runtime?.loaderFamily !== expectedRuntime.loaderFamily ||
      state.runtime?.loaderVersion !== expectedRuntime.loaderVersion) {
    throw new Error('The preserved lifecycle runtime does not match the approved exact GitHub release');
  }
  if (!Number.isSafeInteger(state.contentRevision) || state.contentRevision < 1) {
    throw new Error('The preserved lifecycle content revision is invalid');
  }
}

async function loadPreservedGitHubLifecycle(root) {
  const lifecycle = await preservedHarness.loadPreservedRealLifecycle(root, {
    expectedIdentity: GITHUB_CONTINUATION_IDENTITY,
    scratchPrefix: GITHUB_CONTINUATION_SCRATCH_PREFIX,
    providerLabel: 'GitHub Releases',
    scratchLabel: 'github-releases',
    validateManagedState: validateApprovedGitHubManagedState
  });
  const expectedServerPath = path.join(lifecycle.root, 'server');
  if (path.resolve(lifecycle.serverPath) !== path.resolve(expectedServerPath)) {
    throw new Error('The preserved GitHub lifecycle server path is invalid');
  }
  githubHarness.assertUnmanagedSentinel(lifecycle);
  return lifecycle;
}

module.exports = {
  GITHUB_CONTINUATION_IDENTITY,
  GITHUB_CONTINUATION_SCRATCH_PREFIX,
  REAL_GITHUB_CONTINUATION_ROOT_ENV,
  getPreservedGitHubLifecycleRoot,
  isPreservedGitHubLifecycleEnabled,
  loadPreservedGitHubLifecycle,
  startPreservedServer: preservedHarness.startPreservedServer,
  validateApprovedGitHubManagedState
};
