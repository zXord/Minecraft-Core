const { ModpackError, deepFreeze } = require('../errors.cjs');
const { isAppIssuedVerifiedArtifactSet } = require('../contracts.cjs');
const { parsePublicGitHubUrl } = require('./github-url.cjs');

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL_ID = /^[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA512 = /^[a-f0-9]{128}$/;

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Provider source mapping is invalid', {
    details: field ? { field } : undefined
  });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function providerId(value, field) {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) invalid(field);
  return value;
}

function decimalId(value, field) {
  if (typeof value !== 'string' || !DECIMAL_ID.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) invalid(field);
  return value;
}

async function acceptTrustedUpstreamMapping({ modrinthProjectId, githubRepositoryId, url } = {}, { resolveRepositoryIdentity } = {}) {
  if (typeof resolveRepositoryIdentity !== 'function') invalid('resolveRepositoryIdentity');
  modrinthProjectId = providerId(modrinthProjectId, 'modrinthProjectId');
  githubRepositoryId = decimalId(githubRepositoryId, 'githubRepositoryId');
  const parsed = parsePublicGitHubUrl(url);
  if (parsed.kind !== 'repository') invalid('url');
  let resolved;
  try { resolved = await resolveRepositoryIdentity(url); }
  catch (error) {
    if (error instanceof ModpackError) throw error;
    invalid('url');
  }
  if (!plain(resolved) || resolved.visibility !== 'public') invalid('url');
  const resolvedRepositoryId = decimalId(resolved.repositoryId, 'githubRepositoryId');
  let resolvedUrl;
  try {
    resolvedUrl = parsePublicGitHubUrl(`https://github.com/${resolved.owner}/${resolved.repo}`);
  } catch { invalid('url'); }
  if (resolvedUrl.kind !== 'repository') invalid('url');
  if (resolvedRepositoryId !== githubRepositoryId) invalid('githubRepositoryId');
  const sameName = (left, right) => left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
  if (!sameName(parsed.owner, resolvedUrl.owner) || !sameName(parsed.repo, resolvedUrl.repo)) invalid('url');
  return deepFreeze({
    type: 'provider-source-mapping', version: 1,
    modrinthProjectId,
    githubRepositoryId: resolvedRepositoryId,
    githubOwner: resolvedUrl.owner,
    githubRepo: resolvedUrl.repo
  });
}

function trustedBytes(value) {
  if (!isAppIssuedVerifiedArtifactSet(value) || !plain(value) || value.type !== 'verified-artifact-set' || !plain(value.artifactSet) || !Array.isArray(value.artifactSet.parts) ||
    value.artifactSet.parts.length < 1 || value.artifactSet.parts.length > 1000) return null;
  const result = [];
  for (const part of value.artifactSet.parts) {
    if (!plain(part) || typeof part.measuredSize !== 'string' || !/^(0|[1-9][0-9]*)$/.test(part.measuredSize) || !plain(part.calculatedDigests) ||
      !SHA256.test(part.calculatedDigests.sha256 || '') || !SHA512.test(part.calculatedDigests.sha512 || '')) return null;
    result.push({
      measuredSize: part.measuredSize,
      sha256: part.calculatedDigests.sha256,
      sha512: part.calculatedDigests.sha512
    });
  }
  return JSON.stringify(result);
}

function sourceIdentity(value) {
  if (!plain(value) || !plain(value.project)) return null;
  if (value.provider === 'modrinth' && typeof value.project.id === 'string' && PROVIDER_ID.test(value.project.id)) {
    return { provider: 'modrinth', id: value.project.id };
  }
  if (value.provider === 'github' && typeof value.project.id === 'string' && DECIMAL_ID.test(value.project.id) && BigInt(value.project.id) <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return { provider: 'github', id: value.project.id };
  }
  return null;
}

function normalizedAcceptedMapping(value) {
  if (!plain(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 6 || !['type', 'version', 'modrinthProjectId', 'githubRepositoryId', 'githubOwner', 'githubRepo'].every(key => keys.includes(key))) return null;
  if (value.type !== 'provider-source-mapping' || value.version !== 1 || typeof value.modrinthProjectId !== 'string' || !PROVIDER_ID.test(value.modrinthProjectId) ||
    typeof value.githubRepositoryId !== 'string' || !DECIMAL_ID.test(value.githubRepositoryId) || BigInt(value.githubRepositoryId) > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof value.githubOwner !== 'string' || typeof value.githubRepo !== 'string') return null;
  try {
    const parsed = parsePublicGitHubUrl(`https://github.com/${value.githubOwner}/${value.githubRepo}`);
    if (parsed.kind !== 'repository') return null;
  } catch { return null; }
  return value;
}

function artifactsAreEquivalent(left, right, acceptedMappings) {
  const leftSource = sourceIdentity(left);
  const rightSource = sourceIdentity(right);
  if (!leftSource || !rightSource) return false;
  const leftBytes = trustedBytes(left);
  const rightBytes = trustedBytes(right);
  if (leftBytes !== null && rightBytes !== null && leftBytes === rightBytes) return true;

  if (leftSource.provider === rightSource.provider || !Array.isArray(acceptedMappings)) return false;
  const modrinthId = leftSource.provider === 'modrinth' ? leftSource.id : rightSource.id;
  const githubId = leftSource.provider === 'github' ? leftSource.id : rightSource.id;
  return acceptedMappings.some(candidate => {
    const mapping = normalizedAcceptedMapping(candidate);
    return mapping?.modrinthProjectId === modrinthId && mapping.githubRepositoryId === githubId;
  });
}

module.exports = { acceptTrustedUpstreamMapping, artifactsAreEquivalent };
