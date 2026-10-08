const crypto = require('node:crypto');
const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { normalizeRuntimeTuple } = require('../modpacks/contracts.cjs');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;
function failure(code = 'INVALID_REQUEST', cause) {
  return new ModpackError(code, code === 'CLIENT_PACK_UNAVAILABLE' ? 'The matching client pack is unavailable' : 'The matching client pack request is invalid', { cause });
}
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || Object.entries(descriptors).some(([key, d]) => !keys.includes(key) || !d.enumerable || !Object.hasOwn(d, 'value'))) throw failure();
}
function identifier(value, decimal = false) {
  if (typeof value !== 'string' || !(decimal ? /^[1-9][0-9]*$/ : ID).test(value) || value.length > 192) throw failure();
  return value;
}
function digest(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw failure();
  return value;
}
function version(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[\\/\u0000-\u001f\u007f]/u.test(value) || /https?:/iu.test(value)) throw failure();
  return value;
}
function normalizeCompanionRuntime(value) {
  const runtime = normalizeRuntimeTuple(value);
  // Loader versions are exact identifiers, never locations or display text.
  // Preserve legitimate release/build punctuation without decoding or trimming.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(runtime.loaderVersion)) throw failure();
  return runtime;
}
function normalizeSource(value) {
  if (value?.provider === 'github') {
    exact(value, ['provider', 'repositoryId', 'githubOwner', 'githubRepo', 'releaseId', 'assetId']);
    if (typeof value.githubOwner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.githubOwner) ||
        typeof value.githubRepo !== 'string' || !/^(?!\.)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/i.test(value.githubRepo)) throw failure();
    return { provider: 'github', repositoryId: identifier(value.repositoryId, true), githubOwner: value.githubOwner,
      githubRepo: value.githubRepo, releaseId: identifier(value.releaseId, true), assetId: identifier(value.assetId, true) };
  }
  if (value?.provider === 'modrinth') {
    exact(value, ['provider', 'projectId', 'versionId']);
    return { provider: 'modrinth', projectId: identifier(value.projectId), versionId: identifier(value.versionId) };
  }
  throw failure();
}
function normalizeCompanionDescriptor(value) {
  exact(value, ['schemaVersion', 'status', 'serverFingerprint', 'serverVersion', 'source', 'runtime', 'artifactSha256']);
  if (value.schemaVersion !== 1 || !['unpaired', 'ready'].includes(value.status)) throw failure();
  const common = { schemaVersion: 1, status: value.status, serverFingerprint: digest(value.serverFingerprint), serverVersion: version(value.serverVersion) };
  if (value.status === 'unpaired') {
    if (value.source !== null || value.runtime !== null || value.artifactSha256 !== null) throw failure();
    return deepFreeze({ ...common, source: null, runtime: null, artifactSha256: null });
  }
  return deepFreeze({ ...common, source: normalizeSource(value.source), runtime: normalizeCompanionRuntime(value.runtime), artifactSha256: digest(value.artifactSha256) });
}
function choices(value, decimal = false) {
  if (!Array.isArray(value) || value.length > 10000) throw failure();
  const result = value.map(item => identifier(item, decimal));
  if (new Set(result).size !== result.length) throw failure();
  return result.sort();
}
function serverPackFingerprint(state) {
  try {
    // The adapter supplies validated raw state; ignored manifest/publication data is not identity.
    const value = strictJsonClone({ modpackManaged: state.modpackManaged, source: state.source,
      runtime: state.runtime, selectedOptionalFiles: state.selectedOptionalFiles }, { maxDepth: 16, maxCollection: 10000, maxStringBytes: 256 * 1024 });
    if (value.modpackManaged !== true) throw failure();
    const installed = value.source;
    let source;
    if (installed?.provider === 'github') {
      const ids = choices(installed.selectedAssetIds, true);
      if (!ids.length) throw failure();
      const normalized = normalizeSource({ provider: 'github', repositoryId: installed.repositoryId, githubOwner: installed.githubOwner, githubRepo: installed.githubRepo, releaseId: installed.releaseId, assetId: ids[0] });
      const { assetId, ...identity } = normalized;
      source = { ...identity, selectedAssetIds: ids, artifactSetDigest: digest(installed.artifactSetDigest) };
    } else if (installed?.provider === 'modrinth') {
      source = { ...normalizeSource({ provider: 'modrinth', projectId: installed.projectId, versionId: installed.versionId }), artifactSetDigest: digest(installed.artifactSetDigest) };
    } else if (installed?.provider === 'local') {
      source = { provider: 'local', importId: identifier(installed.importId), artifactSha256: digest(installed.artifactSha256) };
    } else throw failure();
    const canonical = { schemaVersion: 1, source, runtime: normalizeCompanionRuntime(value.runtime), selectedOptionalFiles: choices(value.selectedOptionalFiles) };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  } catch (cause) { throw failure('CLIENT_PACK_UNAVAILABLE', cause); }
}
function normalizeCompanionRecord(value) {
  exact(value, ['serverId', 'descriptor']);
  const descriptor = normalizeCompanionDescriptor(value.descriptor);
  if (descriptor.status !== 'ready') throw failure();
  return deepFreeze({ serverId: identifier(value.serverId), descriptor });
}
module.exports = { serverPackFingerprint, normalizeCompanionDescriptor, normalizeCompanionRecord };
