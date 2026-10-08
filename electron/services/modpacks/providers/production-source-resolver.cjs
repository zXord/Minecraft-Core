const { ModpackError, deepFreeze } = require('../errors.cjs');
const { isSafeWindowsBasename } = require('../windows-basename.cjs');
const { acceptTrustedUpstreamMapping } = require('./provider-source-mapping.cjs');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const DECIMAL = /^[1-9][0-9]*$/;

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The modpack source request is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The selected modpack source changed', { cause });
}

function identifier(value, decimal = false) {
  if (typeof value !== 'string' || !(decimal ? DECIMAL : ID).test(value)) throw invalid();
  return value;
}

function versionIdentifier(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw invalid();
  return value;
}

function requireMethod(value, method) {
  if (!value || typeof value[method] !== 'function') throw invalid();
}

function safeTitle(value, fallback) {
  const selected = typeof value === 'string' ? value.trim() : '';
  return selected && selected.length <= 128 && !/[\\/\u0000-\u001f]/u.test(selected) ? selected : fallback;
}

function assertSignal(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') throw invalid();
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new ModpackError('CANCELLED', 'Modpack source resolution was cancelled');
}

function githubReleaseMetadata(release) {
  if (typeof release?.prerelease !== 'boolean' || !['release', 'prerelease'].includes(release.channel) ||
      release.channel !== (release.prerelease ? 'prerelease' : 'release') ||
      typeof release.publishedAt !== 'string' || release.publishedAt.length > 64) throw invalid();
  let publishedAt;
  try { publishedAt = new Date(release.publishedAt).toISOString(); } catch { throw invalid(); }
  if (publishedAt !== release.publishedAt) throw invalid();
  return { channel: release.channel, prerelease: release.prerelease, publishedAt };
}

function modrinthReleaseMetadata(version) {
  if (!['release', 'beta', 'alpha'].includes(version?.channel) ||
      typeof version.publishedAt !== 'string' || version.publishedAt.length > 64) throw invalid();
  let publishedAt;
  try { publishedAt = new Date(version.publishedAt).toISOString(); } catch { throw invalid(); }
  if (publishedAt !== version.publishedAt) throw invalid();
  return {
    channel: version.channel,
    prerelease: version.channel !== 'release',
    publishedAt
  };
}

function reviewedAssetPatternSeed(plan, selectedAssetIds) {
  const artifactSet = plan?.artifactSet;
  if (!artifactSet || typeof artifactSet !== 'object' || Array.isArray(artifactSet) ||
      !['single', 'multipart'].includes(artifactSet.kind) ||
      !['single', 'part-number', 'rar-rxx', 'numbered-volume'].includes(artifactSet.groupingScheme) ||
      !Array.isArray(artifactSet.parts) || artifactSet.parts.length < 1 || artifactSet.parts.length > 1000) throw invalid();
  const parts = artifactSet.parts.map(part => {
    if (!part || typeof part !== 'object' || Array.isArray(part) ||
        typeof part.partId !== 'string' || typeof part.providerAssetId !== 'string' || !DECIMAL.test(part.providerAssetId) ||
        typeof part.fileName !== 'string' || !isSafeWindowsBasename(part.fileName)) throw invalid();
    return { partId: part.partId, providerAssetId: part.providerAssetId, fileName: part.fileName };
  });
  if (new Set(parts.map(part => part.providerAssetId)).size !== parts.length ||
      parts.length !== selectedAssetIds.length || selectedAssetIds.some(id => !parts.some(part => part.providerAssetId === id))) throw invalid();
  const primaryIndex = parts.findIndex(part => part.partId === artifactSet.primaryPartId);
  if (primaryIndex < 0 || (artifactSet.kind === 'single' &&
      (parts.length !== 1 || artifactSet.groupingScheme !== 'single' || primaryIndex !== 0)) ||
      (artifactSet.kind === 'multipart' && (parts.length < 2 || artifactSet.groupingScheme === 'single'))) throw invalid();
  return {
    fileNames: parts.map(part => part.fileName),
    multipartStructure: {
      kind: artifactSet.kind,
      groupingScheme: artifactSet.groupingScheme,
      partCount: parts.length,
      primaryIndex
    }
  };
}

class ProductionModpackSourceResolver {
  constructor({ providers, localArtifactSource } = {}) {
    if (!providers || typeof providers !== 'object') throw invalid();
    for (const method of ['getVersion', 'resolveArtifactSetPlan']) requireMethod(providers.modrinth, method);
    for (const method of ['repository', 'getRelease', 'buildArtifactSetPlan']) requireMethod(providers.github, method);
    requireMethod(localArtifactSource, 'ingestSelection');
    this.providers = providers;
    this.localArtifactSource = localArtifactSource;
  }

  async resolveArtifactSetPlan(request, options = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid();
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.getPrototypeOf(options) !== Object.prototype ||
        Object.keys(options).some(key => !['onProgress', 'signal'].includes(key))) throw invalid();
    const { onProgress, signal } = options;
    if (onProgress !== undefined && typeof onProgress !== 'function') throw invalid();
    assertSignal(signal);
    throwIfCancelled(signal);
    if (request.provider === 'modrinth') return this.#modrinth(request, signal);
    if (request.provider === 'github') return this.#github(request, signal);
    if (request.provider === 'local') return this.#local(request, { onProgress, signal });
    throw invalid();
  }

  async #modrinth(request, signal) {
    const projectId = identifier(request.projectId);
    const versionId = identifier(request.versionId);
    const projectPromise = typeof this.providers.modrinth.getProject === 'function'
      ? this.providers.modrinth.getProject(projectId)
      : Promise.resolve(null);
    const [version, project, artifactSetPlan] = await Promise.all([
      this.providers.modrinth.getVersion(versionId),
      projectPromise,
      this.providers.modrinth.resolveArtifactSetPlan(versionId)
    ]);
    throwIfCancelled(signal);
    if (!version || version.versionId !== versionId || version.projectId !== projectId ||
        (project && project.projectId !== projectId)) throw stale();
    const releaseMetadata = modrinthReleaseMetadata(version);
    return deepFreeze({
      artifactSetPlan,
      source: {
        provider: 'modrinth', projectId, versionId,
        version: versionIdentifier(version.version), title: safeTitle(project?.title, safeTitle(version.projectTitle, projectId)),
        ...releaseMetadata
      }
    });
  }

  async #github(request, signal) {
    const repositoryId = identifier(request.repositoryId, true);
    const releaseId = identifier(request.releaseId, true);
    if (!Array.isArray(request.assetIds) || request.assetIds.length < 1 || request.assetIds.length > 256) throw invalid();
    const selectedAssetIds = request.assetIds.map(value => identifier(value, true));
    if (new Set(selectedAssetIds).size !== selectedAssetIds.length) throw invalid();
    let repository;
    try { repository = this.providers.github.repository(repositoryId); }
    catch (error) { throw stale(error); }
    if (!repository || repository.repositoryId !== repositoryId || repository.visibility !== 'public' ||
        typeof repository.owner !== 'string' || typeof repository.repo !== 'string') throw stale();
    const release = await this.providers.github.getRelease({ repositoryId, releaseId });
    throwIfCancelled(signal);
    if (!release || release.releaseId !== releaseId) throw stale();
    const releaseMetadata = githubReleaseMetadata(release);
    const artifactSetPlan = await this.providers.github.buildArtifactSetPlan({
      repositoryId, releaseId, selectedAssetIds
    });
    throwIfCancelled(signal);
    let acceptedMapping;
    if (request.linkedModrinthProjectId !== undefined) {
      requireMethod(this.providers.modrinth, 'getProject');
      requireMethod(this.providers.github, 'getRepositoryIdentity');
      const modrinthProjectId = identifier(request.linkedModrinthProjectId);
      const project = await this.providers.modrinth.getProject(modrinthProjectId);
      throwIfCancelled(signal);
      if (!project || project.projectId !== modrinthProjectId || !Array.isArray(project.upstreamLinkCandidates)) throw stale();
      const candidates = project.upstreamLinkCandidates.filter(item => item?.kind === 'source' &&
        typeof item.urlCandidate === 'string' && /^https:\/\/github\.com\//u.test(item.urlCandidate));
      if (candidates.length !== 1) throw invalid();
      acceptedMapping = await acceptTrustedUpstreamMapping({
        modrinthProjectId,
        githubRepositoryId: repositoryId,
        url: candidates[0].urlCandidate
      }, {
        resolveRepositoryIdentity: value => this.providers.github.getRepositoryIdentity(value)
      });
      throwIfCancelled(signal);
    }
    const rememberAssetPattern = request.rememberAssetPattern === true;
    const assetPatternSeed = rememberAssetPattern
      ? reviewedAssetPatternSeed(artifactSetPlan, selectedAssetIds)
      : null;
    return deepFreeze({
      artifactSetPlan,
      source: {
        provider: 'github', repositoryId, releaseId,
        githubOwner: repository.owner,
        githubRepo: repository.repo,
        version: versionIdentifier(release.tagName),
        title: safeTitle(repository.repo, `GitHub ${repositoryId}`),
        ...releaseMetadata,
        ...(rememberAssetPattern ? { rememberAssetPattern: true } : {}),
        selectedAssetIds,
        ...(assetPatternSeed ? { assetPatternSeed } : {}),
        ...(acceptedMapping ? { acceptedMapping } : {})
      }
    });
  }

  async #local(request, { onProgress, signal } = {}) {
    const selectionId = identifier(request.selectionId);
    const verified = await this.localArtifactSource.ingestSelection(selectionId, {
      ...(onProgress ? { onProgress } : {}),
      ...(signal ? { signal } : {})
    });
    throwIfCancelled(signal);
    const setDigest = verified?.artifactSet?.setDigest;
    if (verified?.type !== 'verified-artifact-set' || verified.provider !== 'local' ||
        typeof setDigest !== 'string' || !/^[a-f0-9]{64}$/.test(setDigest)) throw stale();
    return deepFreeze({
      artifactSetPlan: verified,
      source: {
        provider: 'local', importId: selectionId, artifactSha256: setDigest,
        version: 'local-import', title: 'Local archive'
      }
    });
  }
}

module.exports = { ProductionModpackSourceResolver };
