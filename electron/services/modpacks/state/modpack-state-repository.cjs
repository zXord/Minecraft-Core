const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { strictJsonClone } = require('../../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { normalizeRuntimeTuple } = require('../contracts.cjs');
const { matchAssetPattern } = require('../providers/github-asset-pattern.cjs');
const { normalizeOwnershipManifest } = require('../planning/ownership-planner.cjs');
const { isSafeWindowsBasename } = require('../windows-basename.cjs');

const STATE_DIRECTORY = '.minecraft-core-state';
const CURRENT_STATE = 'modpack.json';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HISTORY_INDEX = /^\.history-index-v1-([0-9]{16})-([a-f0-9]{64})\.idx$/u;
const HISTORY_KINDS = new Set([
  'install', 'upgrade', 'downgrade', 'switch', 'repair', 'detach', 'uninstall', 'rollback', 'import-files-only'
]);
const HISTORY_OUTCOMES = new Set(['completed', 'rolled-back', 'failed', 'recovery-required']);
const INACTIVE_MODES = new Set(['files-only', 'uninstalled']);
const MAX_STATE_JSON_BYTES = 8 * 1024 * 1024;
const MAX_STATE_MANIFEST_ENTRIES = Math.min(10_000, ARCHIVE_LIMITS.maxArchiveEntries);
const MAX_STATE_MANIFEST_VALUES_PER_ENTRY = 11;
const MAX_STATE_NON_MANIFEST_VALUES = 25_000;
const MAX_STATE_JSON_VALUES = MAX_STATE_NON_MANIFEST_VALUES +
  (MAX_STATE_MANIFEST_ENTRIES * MAX_STATE_MANIFEST_VALUES_PER_ENTRY);
const VERIFICATION_READ_BYTES = 64 * 1024;

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Managed modpack state is invalid', {
    details: field ? { field } : undefined
  });
}

function clone(value, field, options) {
  try { return strictJsonClone(value, options); }
  catch { invalid(field); }
}

function stateClone(value, field) {
  return clone(value, field, { maxCollection: MAX_STATE_JSON_VALUES });
}

function normalizeStateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.entries) || value.entries.length > MAX_STATE_MANIFEST_ENTRIES) {
    invalid('state.manifest');
  }
  return normalizeOwnershipManifest(value);
}

function serializeStateManifest(value) {
  let serialized;
  try { serialized = `${JSON.stringify(value, null, 2)}\n`; }
  catch { invalid('state.manifest'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_JSON_BYTES) invalid('state.manifest');
  return serialized;
}

function exactObject(value, keys, field, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) invalid(field);
  const names = Object.keys(value);
  if (names.some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid(field);
  return value;
}

function identifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid(field);
  return value;
}

function storageIdentifier(value, field) {
  const normalized = identifier(value, field);
  if (!isSafeWindowsBasename(`${normalized}.json`)) invalid(field);
  return normalized;
}

function decimalId(value, field, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !DECIMAL.test(value) || (!allowZero && value === '0') || value.length > 30) invalid(field);
  try { BigInt(value); } catch { invalid(field); }
  return value;
}

function text(value, field, { pattern = VERSION, maximum = 128 } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || !pattern.test(value) ||
      /https?:|[\\/]/i.test(value) || [...value].some(character => character.charCodeAt(0) <= 0x1f)) invalid(field);
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) invalid(field);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) invalid(field);
  return value;
}

function revision(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

function hash(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(field);
  return value;
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000) invalid(field);
  const result = value.map((item, index) => identifier(item, `${field}.${index}`)).sort((a, b) => a.localeCompare(b, 'en-US'));
  if (new Set(result).size !== result.length) invalid(field);
  return result;
}

function normalizeDecimalArray(value, field) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 10_000) invalid(field);
  const result = value.map((item, index) => decimalId(item, `${field}.${index}`))
    .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  if (new Set(result).size !== result.length) invalid(field);
  return result;
}

function normalizeAcceptedMapping(value, field) {
  if (value === undefined || value === null) return null;
  exactObject(value, ['type', 'version', 'modrinthProjectId', 'githubRepositoryId', 'githubOwner', 'githubRepo'], field);
  if (value.type !== 'provider-source-mapping' || value.version !== 1) invalid(field);
  const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const repoPattern = /^(?!\.)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/i;
  if (!ownerPattern.test(value.githubOwner) || !repoPattern.test(value.githubRepo)) invalid(field);
  return {
    type: value.type,
    version: value.version,
    modrinthProjectId: identifier(value.modrinthProjectId, `${field}.modrinthProjectId`),
    githubRepositoryId: decimalId(value.githubRepositoryId, `${field}.githubRepositoryId`),
    githubOwner: value.githubOwner,
    githubRepo: value.githubRepo
  };
}

function normalizeAssetPattern(value, field) {
  if (value === undefined || value === null) return null;
  const pattern = clone(value, field);
  try { matchAssetPattern(pattern, []); }
  catch { invalid(field); }
  return pattern;
}

function normalizeGitHubReleaseMetadata(value) {
  const supplied = [value.channel, value.prerelease, value.publishedAt].filter(item => item !== undefined).length;
  if (supplied === 0) return null;
  if (supplied !== 3 || !['release', 'prerelease'].includes(value.channel) || typeof value.prerelease !== 'boolean' ||
      value.channel !== (value.prerelease ? 'prerelease' : 'release')) invalid('state.source');
  return {
    channel: value.channel,
    prerelease: value.prerelease,
    publishedAt: timestamp(value.publishedAt, 'state.source.publishedAt')
  };
}

function normalizeModrinthReleaseMetadata(value) {
  const supplied = [value.channel, value.prerelease, value.publishedAt].filter(item => item !== undefined).length;
  if (supplied === 0) return null;
  if (supplied !== 3 || !['release', 'beta', 'alpha'].includes(value.channel) ||
      typeof value.prerelease !== 'boolean' || value.prerelease !== (value.channel !== 'release')) {
    invalid('state.source');
  }
  return {
    channel: value.channel,
    prerelease: value.prerelease,
    publishedAt: timestamp(value.publishedAt, 'state.source.publishedAt')
  };
}

function normalizeSource(value) {
  exactObject(value, [
    'provider', 'projectId', 'versionId', 'repositoryId', 'releaseId', 'importId', 'artifactSha256',
    'githubOwner', 'githubRepo', 'version', 'title', 'channel', 'prerelease', 'publishedAt', 'assetPattern', 'acceptedMapping',
    'selectedAssetIds', 'artifactSetDigest'
  ], 'state.source', ['provider', 'version', 'title']);
  const common = {
    provider: value.provider,
    version: text(value.version, 'state.source.version'),
    title: text(value.title, 'state.source.title', { pattern: /^[^\\/]{1,128}$/, maximum: 128 })
  };
  const acceptedMapping = normalizeAcceptedMapping(value.acceptedMapping, 'state.source.acceptedMapping');
  if (value.provider === 'github') {
    if (value.projectId !== undefined || value.versionId !== undefined || value.importId !== undefined || value.artifactSha256 !== undefined) invalid('state.source');
    const repositoryId = decimalId(value.repositoryId, 'state.source.repositoryId');
    if (acceptedMapping && acceptedMapping.githubRepositoryId !== repositoryId) invalid('state.source.acceptedMapping');
    const releaseMetadata = normalizeGitHubReleaseMetadata(value);
    return {
      ...common,
      repositoryId,
      releaseId: decimalId(value.releaseId, 'state.source.releaseId'),
      githubOwner: text(value.githubOwner, 'state.source.githubOwner', {
        pattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u,
        maximum: 39
      }),
      githubRepo: text(value.githubRepo, 'state.source.githubRepo', {
        pattern: /^(?!\.)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/iu,
        maximum: 100
      }),
      ...(releaseMetadata || {}),
      ...(value.selectedAssetIds === undefined ? {} : {
        selectedAssetIds: normalizeDecimalArray(value.selectedAssetIds, 'state.source.selectedAssetIds')
      }),
      ...(value.artifactSetDigest === undefined ? {} : {
        artifactSetDigest: hash(value.artifactSetDigest, 'state.source.artifactSetDigest')
      }),
      ...(value.assetPattern === undefined ? {} : { assetPattern: normalizeAssetPattern(value.assetPattern, 'state.source.assetPattern') }),
      ...(acceptedMapping ? { acceptedMapping } : {})
    };
  }
  if (value.provider === 'modrinth') {
    if (value.repositoryId !== undefined || value.releaseId !== undefined || value.githubOwner !== undefined ||
        value.githubRepo !== undefined || value.importId !== undefined ||
        value.artifactSha256 !== undefined || value.assetPattern !== undefined || value.selectedAssetIds !== undefined) invalid('state.source');
    const projectId = identifier(value.projectId, 'state.source.projectId');
    if (acceptedMapping && acceptedMapping.modrinthProjectId !== projectId) invalid('state.source.acceptedMapping');
    const releaseMetadata = normalizeModrinthReleaseMetadata(value);
    return {
      ...common,
      projectId,
      versionId: identifier(value.versionId, 'state.source.versionId'),
      ...(releaseMetadata || {}),
      ...(value.artifactSetDigest === undefined ? {} : {
        artifactSetDigest: hash(value.artifactSetDigest, 'state.source.artifactSetDigest')
      }),
      ...(acceptedMapping ? { acceptedMapping } : {})
    };
  }
  if (value.provider === 'local') {
    if (value.projectId !== undefined || value.versionId !== undefined || value.repositoryId !== undefined || value.releaseId !== undefined ||
        value.githubOwner !== undefined || value.githubRepo !== undefined ||
        value.channel !== undefined || value.prerelease !== undefined || value.publishedAt !== undefined ||
        value.assetPattern !== undefined || value.selectedAssetIds !== undefined || value.artifactSetDigest !== undefined || acceptedMapping) invalid('state.source');
    return {
      ...common,
      importId: identifier(value.importId, 'state.source.importId'),
      artifactSha256: hash(value.artifactSha256, 'state.source.artifactSha256')
    };
  }
  invalid('state.source.provider');
}

function normalizeStateInput(value) {
  const source = stateClone(value, 'state');
  exactObject(source, [
    'schemaVersion', 'modpackManaged', 'source', 'runtime', 'selectedOptionalFiles', 'installedAt', 'contentRevision', 'manifest'
  ], 'state');
  if (source.schemaVersion !== 1 || typeof source.modpackManaged !== 'boolean') invalid('state');
  let runtime;
  try { runtime = normalizeRuntimeTuple(source.runtime); }
  catch { invalid('state.runtime'); }
  let manifest;
  try { manifest = normalizeStateManifest(source.manifest); }
  catch { invalid('state.manifest'); }
  storageIdentifier(manifest.installationId, 'state.manifest.installationId');
  return deepFreeze({
    state: {
      schemaVersion: 1,
      modpackManaged: source.modpackManaged,
      source: normalizeSource(source.source),
      runtime: { ...runtime },
      selectedOptionalFiles: normalizeStringArray(source.selectedOptionalFiles, 'state.selectedOptionalFiles'),
      installedAt: timestamp(source.installedAt, 'state.installedAt'),
      contentRevision: revision(source.contentRevision, 'state.contentRevision'),
      manifestId: manifest.installationId
    },
    manifest
  });
}

function normalizePersistedState(stateValue, manifestValue) {
  const state = clone(stateValue, 'state');
  exactObject(state, [
    'schemaVersion', 'modpackManaged', 'source', 'runtime', 'selectedOptionalFiles', 'installedAt', 'contentRevision', 'manifestId'
  ], 'state');
  if (state.schemaVersion !== 1 || typeof state.modpackManaged !== 'boolean') invalid('state');
  let runtime;
  try { runtime = normalizeRuntimeTuple(state.runtime); }
  catch { invalid('state.runtime'); }
  let manifest;
  try { manifest = normalizeStateManifest(manifestValue); }
  catch { invalid('state.manifest'); }
  const manifestId = storageIdentifier(state.manifestId, 'state.manifestId');
  if (manifest.installationId !== manifestId) invalid('state.manifestId');
  return deepFreeze({
    state: {
      schemaVersion: 1,
      modpackManaged: state.modpackManaged,
      source: normalizeSource(state.source),
      runtime: { ...runtime },
      selectedOptionalFiles: normalizeStringArray(state.selectedOptionalFiles, 'state.selectedOptionalFiles'),
      installedAt: timestamp(state.installedAt, 'state.installedAt'),
      contentRevision: revision(state.contentRevision, 'state.contentRevision'),
      manifestId
    },
    manifest
  });
}

function normalizeInactiveProvenance(value, field = 'state.provenance') {
  exactObject(value, ['classification', 'inspectionFingerprint'], field);
  if (!['files-only', 'uninstalled'].includes(value.classification)) invalid(field);
  return {
    classification: value.classification,
    inspectionFingerprint: hash(value.inspectionFingerprint, `${field}.inspectionFingerprint`)
  };
}

function normalizeInactivePersistedState(stateValue) {
  const state = clone(stateValue, 'state');
  exactObject(state, [
    'schemaVersion', 'modpackManaged', 'lifecycleMode', 'source', 'runtime', 'selectedOptionalFiles', 'installedAt',
    'contentRevision', 'manifestId', 'provenance'
  ], 'state');
  if (state.schemaVersion !== 1 || state.modpackManaged !== false || !INACTIVE_MODES.has(state.lifecycleMode) ||
      state.manifestId !== null) invalid('state');
  let normalizedRuntime = null;
  if (state.runtime !== null) {
    try { normalizedRuntime = { ...normalizeRuntimeTuple(state.runtime) }; }
    catch { invalid('state.runtime'); }
  }
  return deepFreeze({
    state: {
      schemaVersion: 1,
      modpackManaged: false,
      lifecycleMode: state.lifecycleMode,
      source: normalizeSource(state.source),
      runtime: normalizedRuntime,
      selectedOptionalFiles: normalizeStringArray(state.selectedOptionalFiles, 'state.selectedOptionalFiles'),
      installedAt: timestamp(state.installedAt, 'state.installedAt'),
      contentRevision: revision(state.contentRevision, 'state.contentRevision'),
      manifestId: null,
      provenance: normalizeInactiveProvenance(state.provenance)
    },
    manifest: null
  });
}

function normalizeHistoryEntry(value) {
  const entry = clone(value, 'history');
  exactObject(entry, [
    'schemaVersion', 'operationId', 'sequence', 'kind', 'outcome', 'timestamp', 'sourceRevision', 'targetRevision',
    'restorePointId', 'restorePointSha256', 'restorePointTotalBytes', 'sourceRuntime', 'targetRuntime'
  ], 'history', ['schemaVersion', 'operationId', 'sequence', 'kind', 'outcome', 'timestamp', 'sourceRevision', 'targetRevision']);
  if (entry.schemaVersion !== 1 || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 ||
      !HISTORY_KINDS.has(entry.kind) || !HISTORY_OUTCOMES.has(entry.outcome)) invalid('history');
  const result = {
    schemaVersion: 1,
    operationId: storageIdentifier(entry.operationId, 'history.operationId'),
    sequence: entry.sequence,
    kind: entry.kind,
    outcome: entry.outcome,
    timestamp: timestamp(entry.timestamp, 'history.timestamp'),
    sourceRevision: revision(entry.sourceRevision, 'history.sourceRevision'),
    targetRevision: revision(entry.targetRevision, 'history.targetRevision')
  };
  if (entry.restorePointId !== undefined) result.restorePointId = identifier(entry.restorePointId, 'history.restorePointId');
  if (entry.restorePointSha256 !== undefined) result.restorePointSha256 = hash(entry.restorePointSha256, 'history.restorePointSha256');
  if (entry.restorePointTotalBytes !== undefined) {
    if (entry.restorePointId === undefined || entry.restorePointSha256 === undefined) invalid('history.restorePointTotalBytes');
    result.restorePointTotalBytes = decimalId(entry.restorePointTotalBytes, 'history.restorePointTotalBytes', { allowZero: true });
  }
  for (const key of ['sourceRuntime', 'targetRuntime']) {
    if (entry[key] !== undefined) {
      try { result[key] = { ...normalizeRuntimeTuple(entry[key]) }; }
      catch { invalid(`history.${key}`); }
    }
  }
  return deepFreeze(result);
}

function historyOperationDigest(operationId) {
  return crypto.createHash('sha256')
    .update('minecraft-core-history-index-v1\0', 'utf8')
    .update(operationId, 'utf8')
    .digest('hex');
}

function historyIndexName(sequence, operationId) {
  return `.history-index-v1-${String(sequence).padStart(16, '0')}-${historyOperationDigest(operationId)}.idx`;
}

function cursorFor(entry) {
  const payload = Buffer.from(JSON.stringify({ v: 1, sequence: entry.sequence, operationId: entry.operationId }), 'utf8').toString('base64url');
  const digest = crypto.createHash('sha256').update(`minecraft-core-history-v1\0${payload}`, 'utf8').digest('base64url');
  return `${payload}.${digest}`;
}

function parseCursor(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) invalid('cursor');
  const [payload, received] = value.split('.');
  const expected = crypto.createHash('sha256').update(`minecraft-core-history-v1\0${payload}`, 'utf8').digest('base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) invalid('cursor');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { invalid('cursor'); }
  exactObject(decoded, ['v', 'sequence', 'operationId'], 'cursor');
  if (decoded.v !== 1 || !Number.isSafeInteger(decoded.sequence) || decoded.sequence < 1) invalid('cursor');
  return { sequence: decoded.sequence, operationId: storageIdentifier(decoded.operationId, 'cursor.operationId') };
}

function fileIdentity(value) {
  return {
    dev: String(value.dev),
    ino: String(value.ino),
    size: String(value.size),
    mtime: String(value.mtimeNs ?? value.mtimeMs),
    ctime: String(value.ctimeNs ?? value.ctimeMs)
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtime === right.mtime;
}

function defaultYieldControl() {
  return new Promise(resolve => setImmediate(resolve));
}

function verificationOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) invalid('verification.options');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => key !== 'signal') ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    invalid('verification.options');
  }
  const signal = descriptors.signal?.value ?? null;
  if (signal !== null && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    invalid('verification.signal');
  }
  return { signal };
}

function throwIfVerificationCancelled(signal) {
  if (signal?.aborted) throw new ModpackError('CANCELLED', 'Managed file verification was cancelled');
}

function verificationChanged(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('PLAN_STALE', 'A managed file changed during verification', { cause });
}

class ModpackStateRepository {
  constructor({ fsApi = fs, fsPromises = fsApi?.promises, durableFs, clock = () => new Date(), yieldControl = defaultYieldControl } = {}) {
    if (!fsApi || typeof fsApi !== 'object' || !durableFs || typeof durableFs.writeJsonAtomic !== 'function' ||
        typeof durableFs.writeFileAtomic !== 'function' || typeof durableFs.readFileBounded !== 'function' ||
        typeof durableFs.flushDirectory !== 'function' || !fsPromises || typeof fsPromises.open !== 'function' ||
        typeof clock !== 'function' || typeof yieldControl !== 'function') invalid('repository');
    this.fs = fsApi;
    this.fsPromises = fsPromises;
    this.durableFs = durableFs;
    this.clock = clock;
    this.yieldControl = yieldControl;
  }

  read(serverPathValue) {
    const serverPath = this.#server(serverPathValue);
    const paths = this.#paths(serverPath);
    if (!this.#exists(paths.modpack)) return null;
    const current = this.#readJson(paths.modpack);
    if (current.manifestId === null) return normalizeInactivePersistedState(current);
    const manifestId = storageIdentifier(current.manifestId, 'state.manifestId');
    const manifest = this.#readJson(path.join(paths.manifests, `${manifestId}.json`));
    return normalizePersistedState(current, manifest);
  }

  writeCandidate(serverPathValue, value) {
    const serverPath = this.#server(serverPathValue);
    const normalized = normalizeStateInput(value);
    const serializedManifest = serializeStateManifest(normalized.manifest);
    const paths = this.#ensureLayout(serverPath);
    const summary = this.#readSummary(paths.summary);
    const persistedRevision = this.#exists(paths.modpack) ? this.#readJson(paths.modpack).contentRevision : null;
    for (const priorRevision of [summary.contentRevision, persistedRevision]) {
      if (priorRevision !== undefined && priorRevision !== null &&
          (!Number.isSafeInteger(priorRevision) || priorRevision < 0 || normalized.state.contentRevision < priorRevision)) {
        throw new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale');
      }
    }
    const manifestPath = path.join(paths.manifests, `${normalized.manifest.installationId}.json`);
    if (this.#exists(manifestPath)) {
      let existing;
      try { existing = normalizeStateManifest(this.#readJson(manifestPath)); }
      catch { invalid('state.manifest'); }
      if (JSON.stringify(existing) !== JSON.stringify(normalized.manifest)) {
        throw new ModpackError('TARGET_EXISTS', 'The target already exists');
      }
    } else {
      this.durableFs.writeFileAtomic(manifestPath, serializedManifest, { expectedTargetSha256: null });
    }
    this.durableFs.writeJsonAtomic(paths.modpack, normalized.state);
    const nextSummary = { ...summary };
    for (const key of [
      'modpackProvider', 'modpackVersion', 'modpackRepositoryId', 'modpackReleaseId',
      'modpackProjectId', 'modpackVersionId', 'modpackImportId'
    ]) delete nextSummary[key];
    for (const key of ['fabric', 'forge', 'neoforge', 'neoForge', 'quilt']) delete nextSummary[key];
    const legacyLoaderVersionKey = {
      fabric: 'fabric',
      forge: 'forge',
      neoforge: 'neoforge',
      quilt: 'quilt'
    }[normalized.state.runtime.loaderFamily];
    Object.assign(nextSummary, {
      contentRevision: normalized.state.contentRevision,
      modpackManaged: normalized.state.modpackManaged,
      modpackProvider: normalized.state.source.provider,
      modpackVersion: normalized.state.source.version,
      version: normalized.state.runtime.minecraftVersion,
      loader: normalized.state.runtime.loaderFamily,
      loaderVersion: normalized.state.runtime.loaderVersion,
      javaVersion: normalized.state.runtime.javaMajor,
      ...(legacyLoaderVersionKey
        ? { [legacyLoaderVersionKey]: normalized.state.runtime.loaderVersion }
        : {}),
      ...this.#sourceSummary(normalized.state.source),
      runtime: normalized.state.runtime
    });
    this.durableFs.writeJsonAtomic(paths.summary, nextSummary);
    return normalizePersistedState(normalized.state, normalized.manifest);
  }

  async writeCandidateAsync(serverPathValue, value) {
    if (typeof this.durableFs.writeFileAtomicAsync !== 'function' ||
        typeof this.durableFs.writeJsonAtomicAsync !== 'function' ||
        typeof this.durableFs.flushDirectoryAsync !== 'function') invalid('repository');
    const serverPath = this.#server(serverPathValue);
    const normalized = normalizeStateInput(value);
    const serializedManifest = serializeStateManifest(normalized.manifest);
    const paths = await this.#ensureLayoutAsync(serverPath);
    const summary = this.#readSummary(paths.summary);
    const persistedRevision = this.#exists(paths.modpack) ? this.#readJson(paths.modpack).contentRevision : null;
    for (const priorRevision of [summary.contentRevision, persistedRevision]) {
      if (priorRevision !== undefined && priorRevision !== null &&
          (!Number.isSafeInteger(priorRevision) || priorRevision < 0 || normalized.state.contentRevision < priorRevision)) {
        throw new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale');
      }
    }
    const manifestPath = path.join(paths.manifests, `${normalized.manifest.installationId}.json`);
    if (this.#exists(manifestPath)) {
      let existing;
      try { existing = normalizeStateManifest(this.#readJson(manifestPath)); }
      catch { invalid('state.manifest'); }
      if (JSON.stringify(existing) !== JSON.stringify(normalized.manifest)) {
        throw new ModpackError('TARGET_EXISTS', 'The target already exists');
      }
    } else {
      await this.durableFs.writeFileAtomicAsync(manifestPath, serializedManifest, { expectedTargetSha256: null });
    }
    await this.durableFs.writeJsonAtomicAsync(paths.modpack, normalized.state);
    const nextSummary = { ...summary };
    for (const key of [
      'modpackProvider', 'modpackVersion', 'modpackRepositoryId', 'modpackReleaseId',
      'modpackProjectId', 'modpackVersionId', 'modpackImportId'
    ]) delete nextSummary[key];
    for (const key of ['fabric', 'forge', 'neoforge', 'neoForge', 'quilt']) delete nextSummary[key];
    const legacyLoaderVersionKey = {
      fabric: 'fabric',
      forge: 'forge',
      neoforge: 'neoforge',
      quilt: 'quilt'
    }[normalized.state.runtime.loaderFamily];
    Object.assign(nextSummary, {
      contentRevision: normalized.state.contentRevision,
      modpackManaged: normalized.state.modpackManaged,
      modpackProvider: normalized.state.source.provider,
      modpackVersion: normalized.state.source.version,
      version: normalized.state.runtime.minecraftVersion,
      loader: normalized.state.runtime.loaderFamily,
      loaderVersion: normalized.state.runtime.loaderVersion,
      javaVersion: normalized.state.runtime.javaMajor,
      ...(legacyLoaderVersionKey
        ? { [legacyLoaderVersionKey]: normalized.state.runtime.loaderVersion }
        : {}),
      ...this.#sourceSummary(normalized.state.source),
      runtime: normalized.state.runtime
    });
    await this.durableFs.writeJsonAtomicAsync(paths.summary, nextSummary);
    return normalizePersistedState(normalized.state, normalized.manifest);
  }

  appendHistory(serverPathValue, value) {
    const serverPath = this.#server(serverPathValue);
    const entry = normalizeHistoryEntry(value);
    const paths = this.#ensureLayout(serverPath);
    const target = path.join(paths.history, `${entry.operationId}.json`);
    if (this.#exists(target)) throw new ModpackError('TARGET_EXISTS', 'The target already exists');
    const indexed = this.#prepareHistoryIndex(paths);
    if (indexed.ordered.length > 0) {
      const latest = this.#readIndexedHistory(indexed, indexed.ordered[0]);
      if (latest.sequence >= Number.MAX_SAFE_INTEGER) invalid('history.sequence');
      if (entry.sequence <= latest.sequence) {
        throw new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale');
      }
    }
    try {
      this.durableFs.writeJsonAtomic(target, entry, { expectedTargetSha256: null });
    } catch (error) {
      if (this.#exists(target)) throw new ModpackError('TARGET_EXISTS', 'The target already exists', { cause: error });
      throw error;
    }
    try {
      this.#createHistoryIndexMarker(
        path.join(paths.history, historyIndexName(entry.sequence, entry.operationId)),
        { allowExisting: true }
      );
    } catch {
      // The immutable JSON record is authoritative. Validate a read-only virtual
      // index before reporting success when the optional marker cannot publish.
      this.#prepareHistoryIndex(paths, { persistMissing: false });
    }
    return entry;
  }

  async appendHistoryAsync(serverPathValue, value) {
    if (typeof this.durableFs.writeJsonAtomicAsync !== 'function' ||
        typeof this.durableFs.flushDirectoryAsync !== 'function') invalid('repository');
    const serverPath = this.#server(serverPathValue);
    const entry = normalizeHistoryEntry(value);
    const paths = await this.#ensureLayoutAsync(serverPath);
    const target = path.join(paths.history, `${entry.operationId}.json`);
    if (this.#exists(target)) throw new ModpackError('TARGET_EXISTS', 'The target already exists');
    const indexed = this.#prepareHistoryIndex(paths);
    if (indexed.ordered.length > 0) {
      const latest = this.#readIndexedHistory(indexed, indexed.ordered[0]);
      if (latest.sequence >= Number.MAX_SAFE_INTEGER) invalid('history.sequence');
      if (entry.sequence <= latest.sequence) {
        throw new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale');
      }
    }
    try {
      await this.durableFs.writeJsonAtomicAsync(target, entry, { expectedTargetSha256: null });
    } catch (error) {
      if (this.#exists(target)) throw new ModpackError('TARGET_EXISTS', 'The target already exists', { cause: error });
      throw error;
    }
    try {
      this.#createHistoryIndexMarker(
        path.join(paths.history, historyIndexName(entry.sequence, entry.operationId)),
        { allowExisting: true }
      );
    } catch {
      // The immutable JSON record is authoritative. Validate a read-only virtual
      // index before reporting success when the optional marker cannot publish.
      this.#prepareHistoryIndex(paths, { persistMissing: false });
    }
    return entry;
  }

  listHistory(serverPathValue, { cursor = null, limit = 50 } = {}) {
    const serverPath = this.#server(serverPathValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid('limit');
    const paths = this.#readHistoryLayout(serverPath);
    if (!paths) {
      if (cursor !== null) invalid('cursor');
      return deepFreeze({ items: [], nextCursor: null });
    }
    const indexed = this.#prepareHistoryIndex(paths, { persistMissing: false });
    let start = 0;
    if (cursor !== null) {
      const decoded = parseCursor(cursor);
      const index = indexed.ordered.findIndex(item => item.sequence === decoded.sequence &&
        item.operationDigest === historyOperationDigest(decoded.operationId));
      if (index < 0) invalid('cursor');
      const cursorEntry = this.#readIndexedHistory(indexed, indexed.ordered[index]);
      if (cursorEntry.operationId !== decoded.operationId) invalid('cursor');
      start = index + 1;
    }
    const items = indexed.ordered.slice(start, start + limit)
      .map(item => this.#readIndexedHistory(indexed, item));
    const nextCursor = start + items.length < indexed.ordered.length ? cursorFor(items.at(-1)) : null;
    return deepFreeze({ items, nextCursor });
  }

  async verifyManagedFiles(serverPathValue, optionsValue = {}) {
    const { signal } = verificationOptions(optionsValue);
    throwIfVerificationCancelled(signal);
    const serverPath = this.#server(serverPathValue);
    const before = this.read(serverPath);
    if (!before || before.state.modpackManaged !== true) invalid('state');
    const entries = before.manifest.entries.filter(entry =>
      ['pack', 'runtime'].includes(entry.origin) && entry.managementPolicy === 'replaceable-managed');
    const mismatches = [];
    const statuses = [];
    for (const entry of entries) {
      throwIfVerificationCancelled(signal);
      const status = await this.#verifyManifestEntryAsync(serverPath, entry, signal);
      statuses.push(status);
      if (status !== 'matched') {
        mismatches.push({ entryName: entry.path, origin: entry.origin, role: entry.role, status });
      }
      await this.yieldControl();
      throwIfVerificationCancelled(signal);
    }
    for (let index = 0; index < entries.length; index += 1) {
      throwIfVerificationCancelled(signal);
      if (await this.#verifyManifestEntryAsync(serverPath, entries[index], signal) !== statuses[index]) {
        throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
      }
      await this.yieldControl();
      throwIfVerificationCancelled(signal);
    }
    const after = this.read(serverPath);
    if (!after || after.state.modpackManaged !== true || after.state.contentRevision !== before.state.contentRevision ||
        after.state.manifestId !== before.state.manifestId || JSON.stringify(after.manifest) !== JSON.stringify(before.manifest)) {
      throw new ModpackError('PLAN_STALE', 'The managed state changed during verification');
    }
    const verifiedAt = this.clock();
    if (!(verifiedAt instanceof Date) || Number.isNaN(verifiedAt.getTime())) invalid('repository.clock');
    return deepFreeze({
      type: 'modpack-verification-result',
      contentRevision: before.state.contentRevision,
      checkedFiles: String(entries.length),
      mismatchCount: String(mismatches.length),
      healthy: mismatches.length === 0,
      repairAvailable: mismatches.length > 0,
      repair: mismatches.length > 0 ? { operationKind: 'repair', mismatchCount: String(mismatches.length) } : null,
      mismatches,
      verifiedAt: verifiedAt.toISOString()
    });
  }

  recordFilesOnlyCandidate(serverPathValue, operationValue) {
    const serverPath = this.#server(serverPathValue);
    const operation = clone(operationValue, 'operation');
    exactObject(operation, ['operationId', 'timestamp', 'contentRevision', 'source', 'provenance'], 'operation');
    const operationId = storageIdentifier(operation.operationId, 'operation.operationId');
    const importedAt = timestamp(operation.timestamp, 'operation.timestamp');
    const contentRevision = revision(operation.contentRevision, 'operation.contentRevision');
    const source = normalizeSource(operation.source);
    const provenance = normalizeInactiveProvenance(operation.provenance, 'operation.provenance');
    if (provenance.classification !== 'files-only') invalid('operation.provenance.classification');
    const paths = this.#ensureLayout(serverPath);
    if (this.#exists(paths.modpack) || this.#exists(path.join(paths.history, `${operationId}.json`))) {
      throw new ModpackError('TARGET_EXISTS', 'The target already exists');
    }
    const summary = this.#readSummary(paths.summary);
    const priorRevision = summary.contentRevision ?? 0;
    if (!Number.isSafeInteger(priorRevision) || priorRevision < 0 || contentRevision <= priorRevision) {
      throw new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale');
    }
    const state = normalizeInactivePersistedState({
      schemaVersion: 1,
      modpackManaged: false,
      lifecycleMode: 'files-only',
      source,
      runtime: null,
      selectedOptionalFiles: [],
      installedAt: importedAt,
      contentRevision,
      manifestId: null,
      provenance
    });
    this.#writeInactiveState(paths, summary, state.state);
    this.appendHistory(serverPath, {
      schemaVersion: 1,
      operationId,
      sequence: this.#nextHistorySequence(paths),
      kind: 'import-files-only',
      outcome: 'completed',
      timestamp: importedAt,
      sourceRevision: priorRevision,
      targetRevision: contentRevision
    });
    return state;
  }

  detachCandidate(serverPathValue, operationValue) {
    const serverPath = this.#server(serverPathValue);
    const current = this.read(serverPath);
    if (!current) invalid('state');
    const operation = clone(operationValue, 'operation');
    exactObject(operation, [
      'operationId', 'timestamp', 'contentRevision', 'restorePointId', 'restorePointSha256', 'restorePointTotalBytes'
    ], 'operation', ['operationId', 'timestamp', 'contentRevision']);
    const operationId = storageIdentifier(operation.operationId, 'operation.operationId');
    const detachedAt = timestamp(operation.timestamp, 'operation.timestamp');
    const contentRevision = revision(operation.contentRevision, 'operation.contentRevision');
    const hasRestorePointId = operation.restorePointId !== undefined;
    const hasRestorePointSha256 = operation.restorePointSha256 !== undefined;
    if (hasRestorePointId !== hasRestorePointSha256) invalid('operation.restorePoint');
    const restorePointId = hasRestorePointId ? identifier(operation.restorePointId, 'operation.restorePointId') : null;
    const restorePointSha256 = hasRestorePointSha256 ? hash(operation.restorePointSha256, 'operation.restorePointSha256') : null;
    const restorePointTotalBytes = operation.restorePointTotalBytes === undefined
      ? null
      : decimalId(operation.restorePointTotalBytes, 'operation.restorePointTotalBytes', { allowZero: true });
    if (restorePointTotalBytes !== null && restorePointId === null) invalid('operation.restorePointTotalBytes');
    if (contentRevision <= current.state.contentRevision) invalid('operation.contentRevision');
    const paths = this.#ensureLayout(serverPath);
    const historyTarget = path.join(paths.history, `${operationId}.json`);
    if (this.#exists(historyTarget)) throw new ModpackError('TARGET_EXISTS', 'The target already exists');
    const historySequence = this.#nextHistorySequence(paths);
    const stateWithoutManifestId = {
      schemaVersion: current.state.schemaVersion,
      modpackManaged: current.state.modpackManaged,
      source: current.state.source,
      runtime: current.state.runtime,
      selectedOptionalFiles: current.state.selectedOptionalFiles,
      installedAt: current.state.installedAt,
      contentRevision: current.state.contentRevision
    };
    const written = this.writeCandidate(serverPath, {
      ...stateWithoutManifestId,
      manifest: current.manifest,
      modpackManaged: false,
      contentRevision
    });
    this.appendHistory(serverPath, {
      schemaVersion: 1,
      operationId,
      sequence: historySequence,
      kind: 'detach',
      outcome: 'completed',
      timestamp: detachedAt,
      sourceRevision: current.state.contentRevision,
      targetRevision: contentRevision,
      sourceRuntime: current.state.runtime,
      targetRuntime: current.state.runtime,
      ...(restorePointId === null ? {} : {
        restorePointId,
        restorePointSha256,
        ...(restorePointTotalBytes === null ? {} : { restorePointTotalBytes })
      })
    });
    return deepFreeze({
      ...written.state,
      confirmation: {
        filesRemoved: '0',
        instanceRetained: true,
        worldsRetained: true,
        possibleNonRunnable: false
      }
    });
  }

  uninstallCandidate(serverPathValue, operationValue) {
    const serverPath = this.#server(serverPathValue);
    const current = this.read(serverPath);
    if (!current || current.state.modpackManaged !== true || !current.manifest) invalid('state');
    const operation = clone(operationValue, 'operation');
    exactObject(operation, [
      'operationId', 'timestamp', 'contentRevision', 'confirmation', 'restorePointId', 'restorePointSha256',
      'restorePointTotalBytes'
    ], 'operation', ['operationId', 'timestamp', 'contentRevision', 'confirmation']);
    const operationId = storageIdentifier(operation.operationId, 'operation.operationId');
    const uninstalledAt = timestamp(operation.timestamp, 'operation.timestamp');
    const contentRevision = revision(operation.contentRevision, 'operation.contentRevision');
    const hasRestorePointId = operation.restorePointId !== undefined;
    const hasRestorePointSha256 = operation.restorePointSha256 !== undefined;
    if (hasRestorePointId !== hasRestorePointSha256) invalid('operation.restorePoint');
    const restorePointId = hasRestorePointId ? identifier(operation.restorePointId, 'operation.restorePointId') : null;
    const restorePointSha256 = hasRestorePointSha256 ? hash(operation.restorePointSha256, 'operation.restorePointSha256') : null;
    const restorePointTotalBytes = operation.restorePointTotalBytes === undefined
      ? null
      : decimalId(operation.restorePointTotalBytes, 'operation.restorePointTotalBytes', { allowZero: true });
    if (restorePointTotalBytes !== null && restorePointId === null) invalid('operation.restorePointTotalBytes');
    if (contentRevision <= current.state.contentRevision) invalid('operation.contentRevision');
    const confirmation = clone(operation.confirmation, 'operation.confirmation');
    exactObject(confirmation, [
      'unchangedManagedRemovalCount', 'preservedCategories', 'possibleNonRunnable', 'instanceRetained', 'worldsRetained'
    ], 'operation.confirmation');
    const unchangedManagedRemovalCount = decimalId(
      confirmation.unchangedManagedRemovalCount,
      'operation.confirmation.unchangedManagedRemovalCount',
      { allowZero: true }
    );
    normalizeStringArray(confirmation.preservedCategories, 'operation.confirmation.preservedCategories');
    if (typeof confirmation.possibleNonRunnable !== 'boolean' || confirmation.instanceRetained !== true ||
        confirmation.worldsRetained !== true) invalid('operation.confirmation');

    const paths = this.#ensureLayout(serverPath);
    if (this.#exists(path.join(paths.history, `${operationId}.json`))) {
      throw new ModpackError('TARGET_EXISTS', 'The target already exists');
    }
    const historySequence = this.#nextHistorySequence(paths);
    const removableEntries = [];
    let preservedModifiedManagedFiles = 0;
    for (const entry of current.manifest.entries) {
      if (!this.#isUninstallableManagedEntry(entry)) continue;
      const status = this.#verifyManifestEntry(serverPath, entry);
      if (status === 'matched') removableEntries.push(entry);
      else if (status === 'modified' || status === 'unsafe') preservedModifiedManagedFiles += 1;
    }
    if (String(removableEntries.length) !== unchangedManagedRemovalCount) {
      throw new ModpackError('PLAN_STALE', 'The reviewed uninstall plan is stale');
    }

    for (const entry of removableEntries) {
      if (this.#verifyManifestEntry(serverPath, entry) !== 'matched') {
        throw new ModpackError('PLAN_STALE', 'A managed file changed during uninstall');
      }
    }
    for (const entry of removableEntries) {
      const target = path.resolve(serverPath, ...entry.path.split('/'));
      this.fs.unlinkSync(target);
      this.durableFs.flushDirectory(path.dirname(target));
    }

    const provenanceFingerprint = crypto.createHash('sha256')
      .update(JSON.stringify(current.manifest), 'utf8')
      .digest('hex');
    const state = normalizeInactivePersistedState({
      schemaVersion: 1,
      modpackManaged: false,
      lifecycleMode: confirmation.possibleNonRunnable ? 'files-only' : 'uninstalled',
      source: current.state.source,
      runtime: null,
      selectedOptionalFiles: [],
      installedAt: current.state.installedAt,
      contentRevision,
      manifestId: null,
      provenance: {
        classification: 'uninstalled',
        inspectionFingerprint: provenanceFingerprint
      }
    });
    const summary = this.#readSummary(paths.summary);
    this.#writeInactiveState(paths, summary, state.state);
    this.appendHistory(serverPath, {
      schemaVersion: 1,
      operationId,
      sequence: historySequence,
      kind: 'uninstall',
      outcome: 'completed',
      timestamp: uninstalledAt,
      sourceRevision: current.state.contentRevision,
      targetRevision: contentRevision,
      sourceRuntime: current.state.runtime,
      ...(restorePointId === null ? {} : {
        restorePointId,
        restorePointSha256,
        ...(restorePointTotalBytes === null ? {} : { restorePointTotalBytes })
      })
    });
    return deepFreeze({
      ...state,
      confirmation: {
        filesRemoved: String(removableEntries.length),
        preservedModifiedManagedFiles: String(preservedModifiedManagedFiles),
        possibleNonRunnable: confirmation.possibleNonRunnable,
        instanceRetained: true,
        worldsRetained: true
      }
    });
  }

  #sourceSummary(source) {
    if (source.provider === 'github') return { modpackRepositoryId: source.repositoryId, modpackReleaseId: source.releaseId };
    if (source.provider === 'modrinth') return { modpackProjectId: source.projectId, modpackVersionId: source.versionId };
    return { modpackImportId: source.importId };
  }

  #isUninstallableManagedEntry(entry) {
    if (!['pack', 'runtime'].includes(entry.origin) || entry.managementPolicy !== 'replaceable-managed' ||
        ['world', 'secret', 'application'].includes(entry.role)) return false;
    const pathKey = entry.pathKey.toLocaleLowerCase('en-US');
    return pathKey !== '.minecraft-core.json' && pathKey !== '.minecraft-core-state' &&
      !pathKey.startsWith('.minecraft-core-state/');
  }

  #nextHistorySequence(paths) {
    const indexed = this.#prepareHistoryIndex(paths);
    if (indexed.ordered.length === 0) return 1;
    const latest = this.#readIndexedHistory(indexed, indexed.ordered[0]);
    if (latest.sequence >= Number.MAX_SAFE_INTEGER) invalid('history.sequence');
    return latest.sequence + 1;
  }

  #prepareHistoryIndex(paths, { persistMissing = true } = {}) {
    let inventory = this.#historyInventory(paths);
    if (inventory.indexes.size > inventory.records.size) invalid('history.index');
    for (const item of inventory.indexes.values()) {
      if (!inventory.recordsByDigest.has(item.operationDigest)) invalid('history.index');
    }
    if (inventory.indexes.size < inventory.records.size) {
      if (persistMissing) {
        try {
          this.#rebuildHistoryIndex(paths, inventory);
          inventory = this.#historyInventory(paths);
        } catch {
          // Index markers are an optimization. Re-inventory after a partial
          // publication and validate the authoritative immutable records.
          inventory = this.#virtualHistoryIndex(this.#historyInventory(paths));
        }
      } else {
        inventory = this.#virtualHistoryIndex(inventory);
      }
    }
    if (inventory.indexes.size !== inventory.records.size) invalid('history.index');
    for (const record of inventory.records.values()) {
      if (!inventory.indexesByDigest.has(record.operationDigest)) invalid('history.index');
    }
    const ordered = [...inventory.indexes.values()].sort((left, right) => right.sequence - left.sequence);
    return { ...inventory, ordered };
  }

  #historyInventory(paths) {
    const records = new Map();
    const recordsByDigest = new Map();
    const indexes = new Map();
    const indexesByDigest = new Map();
    for (const item of this.fs.readdirSync(paths.history, { withFileTypes: true })) {
      if (!item.isFile() || item.isSymbolicLink()) invalid('history');
      if (item.name.endsWith('.json')) {
        const operationId = storageIdentifier(item.name.slice(0, -5), 'history.operationId');
        if (`${operationId}.json` !== item.name || records.has(operationId)) invalid('history');
        const operationDigest = historyOperationDigest(operationId);
        if (recordsByDigest.has(operationDigest)) invalid('history.operationId');
        const record = {
          operationId,
          operationDigest,
          filePath: path.join(paths.history, item.name)
        };
        records.set(operationId, record);
        recordsByDigest.set(operationDigest, record);
        continue;
      }
      const match = HISTORY_INDEX.exec(item.name);
      if (!match) invalid('history');
      const sequence = Number(match[1]);
      const operationDigest = match[2];
      if (!Number.isSafeInteger(sequence) || sequence < 1 || String(sequence).padStart(16, '0') !== match[1] ||
          indexes.has(sequence) || indexesByDigest.has(operationDigest)) invalid('history.index');
      const index = { sequence, operationDigest, filePath: path.join(paths.history, item.name) };
      indexes.set(sequence, index);
      indexesByDigest.set(operationDigest, index);
    }
    return { indexes, indexesByDigest, records, recordsByDigest };
  }

  #rebuildHistoryIndex(paths, inventory) {
    const entries = [...inventory.records.values()].map(record => {
      const entry = normalizeHistoryEntry(this.#readJson(record.filePath));
      if (entry.operationId !== record.operationId || `${entry.operationId}.json` !== path.basename(record.filePath)) {
        invalid('history');
      }
      return entry;
    });
    if (new Set(entries.map(entry => entry.sequence)).size !== entries.length) invalid('history.sequence');
    for (const entry of entries) {
      const operationDigest = historyOperationDigest(entry.operationId);
      const existing = inventory.indexesByDigest.get(operationDigest);
      if (existing && existing.sequence !== entry.sequence) invalid('history.index');
      if (!existing) {
        this.#createHistoryIndexMarker(
          path.join(paths.history, historyIndexName(entry.sequence, entry.operationId)),
          { allowExisting: true }
        );
      }
    }
  }

  #virtualHistoryIndex(inventory) {
    const indexes = new Map(inventory.indexes);
    const indexesByDigest = new Map(inventory.indexesByDigest);
    const entries = [...inventory.records.values()].map(record => {
      const entry = normalizeHistoryEntry(this.#readJson(record.filePath));
      if (entry.operationId !== record.operationId || `${entry.operationId}.json` !== path.basename(record.filePath)) {
        invalid('history');
      }
      return entry;
    });
    if (new Set(entries.map(entry => entry.sequence)).size !== entries.length) invalid('history.sequence');
    for (const entry of entries) {
      const operationDigest = historyOperationDigest(entry.operationId);
      const existing = indexesByDigest.get(operationDigest);
      if (existing && existing.sequence !== entry.sequence) invalid('history.index');
      if (!existing) {
        if (indexes.has(entry.sequence)) invalid('history.index');
        const index = { sequence: entry.sequence, operationDigest, filePath: null };
        indexes.set(entry.sequence, index);
        indexesByDigest.set(operationDigest, index);
      }
    }
    return { ...inventory, indexes, indexesByDigest };
  }

  #readIndexedHistory(indexed, index) {
    const record = indexed.recordsByDigest.get(index.operationDigest);
    if (!record) invalid('history.index');
    const entry = normalizeHistoryEntry(this.#readJson(record.filePath));
    if (entry.operationId !== record.operationId || entry.sequence !== index.sequence ||
        historyOperationDigest(entry.operationId) !== index.operationDigest ||
        `${entry.operationId}.json` !== path.basename(record.filePath)) invalid('history.index');
    return entry;
  }

  #createHistoryIndexMarker(markerPath, { allowExisting }) {
    let descriptor = null;
    try {
      descriptor = this.fs.openSync(markerPath, 'wx', 0o600);
      this.fs.closeSync(descriptor);
      descriptor = null;
    } catch (error) {
      if (descriptor !== null) {
        try { this.fs.closeSync(descriptor); } catch { /* retain the primary failure */ }
      }
      if (allowExisting && error?.code === 'EEXIST') {
        const stat = this.fs.lstatSync(markerPath, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || !this.#samePath(this.fs.realpathSync.native(markerPath), markerPath)) {
          invalid('history.index');
        }
        return;
      }
      if (error?.code === 'EEXIST') {
        throw new ModpackError('TARGET_EXISTS', 'The target already exists', { cause: error });
      }
      throw error;
    }
  }

  #writeInactiveState(paths, summary, state) {
    this.durableFs.writeJsonAtomic(paths.modpack, state);
    const nextSummary = { ...summary };
    for (const key of [
      'modpackProvider', 'modpackVersion', 'modpackRepositoryId', 'modpackReleaseId', 'modpackProjectId',
      'modpackVersionId', 'modpackImportId', 'runtime'
    ]) delete nextSummary[key];
    Object.assign(nextSummary, {
      contentRevision: state.contentRevision,
      modpackManaged: false,
      modpackLifecycleMode: state.lifecycleMode
    });
    this.durableFs.writeJsonAtomic(paths.summary, nextSummary);
  }

  async #verifyManifestEntryAsync(serverPath, entry, signal) {
    throwIfVerificationCancelled(signal);
    const segments = entry.path.split('/');
    const candidate = path.resolve(serverPath, ...segments);
    const relative = path.relative(serverPath, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalid('state.manifest.path');
    let current = serverPath;
    let stat;
    for (let index = 0; index < segments.length; index += 1) {
      throwIfVerificationCancelled(signal);
      current = path.join(current, segments[index]);
      try { stat = this.fs.lstatSync(current, { bigint: true }); }
      catch (error) {
        if (error?.code === 'ENOENT') return 'missing';
        throw verificationChanged(error);
      }
      const last = index === segments.length - 1;
      if (stat.isSymbolicLink() || (!last && !stat.isDirectory()) || (last && (!stat.isFile() || BigInt(stat.nlink) !== 1n))) {
        return 'unsafe';
      }
    }
    if (!this.#samePath(this.fs.realpathSync.native(candidate), candidate)) return 'unsafe';
    const beforeIdentity = fileIdentity(stat);
    if (String(stat.size) !== entry.size) return 'modified';
    const expectedBytes = BigInt(entry.size);
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(VERIFICATION_READ_BYTES);
    let handle;
    try {
      handle = await this.fsPromises.open(candidate, 'r');
    } catch (error) {
      throwIfVerificationCancelled(signal);
      throw verificationChanged(error);
    }

    let failure = null;
    let handleAfterIdentity = null;
    try {
      throwIfVerificationCancelled(signal);
      const openedStat = await handle.stat({ bigint: true });
      if (!openedStat.isFile() || BigInt(openedStat.nlink) !== 1n ||
          !sameFileIdentity(beforeIdentity, fileIdentity(openedStat))) {
        throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
      }
      let measuredBytes = 0n;
      for (;;) {
        throwIfVerificationCancelled(signal);
        const remaining = expectedBytes - measuredBytes;
        const readLength = remaining >= BigInt(buffer.length)
          ? buffer.length
          : Number(remaining) + 1;
        let result;
        try { result = await handle.read(buffer, 0, readLength, null); }
        catch (error) {
          throwIfVerificationCancelled(signal);
          throw verificationChanged(error);
        }
        throwIfVerificationCancelled(signal);
        const bytesRead = result?.bytesRead;
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > readLength) {
          throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
        }
        if (bytesRead === 0) break;
        measuredBytes += BigInt(bytesRead);
        if (measuredBytes > expectedBytes) {
          throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
        }
        digest.update(buffer.subarray(0, bytesRead));
        await this.yieldControl();
        throwIfVerificationCancelled(signal);
      }
      if (measuredBytes !== expectedBytes) {
        throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
      }
      handleAfterIdentity = fileIdentity(await handle.stat({ bigint: true }));
      throwIfVerificationCancelled(signal);
    } catch (error) {
      failure = error;
      throw verificationChanged(error);
    } finally {
      try { await handle.close(); }
      catch (error) {
        if (failure === null) throw verificationChanged(error);
      }
    }

    let afterStat;
    try { afterStat = this.fs.lstatSync(candidate, { bigint: true }); }
    catch (error) { throw verificationChanged(error); }
    const afterIdentity = fileIdentity(afterStat);
    if (!afterStat.isFile() || BigInt(afterStat.nlink) !== 1n ||
        !sameFileIdentity(beforeIdentity, handleAfterIdentity) ||
        !sameFileIdentity(beforeIdentity, afterIdentity) ||
        !this.#samePath(this.fs.realpathSync.native(candidate), candidate)) {
      throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
    }
    return digest.digest('hex') === entry.installedHash ? 'matched' : 'modified';
  }

  #verifyManifestEntry(serverPath, entry) {
    const segments = entry.path.split('/');
    const candidate = path.resolve(serverPath, ...segments);
    const relative = path.relative(serverPath, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalid('state.manifest.path');
    let current = serverPath;
    let stat;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      try { stat = this.fs.lstatSync(current, { bigint: true }); }
      catch (error) {
        if (error?.code === 'ENOENT') return 'missing';
        throw new ModpackError('PLAN_STALE', 'A managed file changed during verification', { cause: error });
      }
      const last = index === segments.length - 1;
      if (stat.isSymbolicLink() || (!last && !stat.isDirectory()) || (last && (!stat.isFile() || BigInt(stat.nlink) !== 1n))) {
        return 'unsafe';
      }
    }
    if (!this.#samePath(this.fs.realpathSync.native(candidate), candidate)) return 'unsafe';
    const beforeIdentity = fileIdentity(stat);
    if (String(stat.size) !== entry.size) return 'modified';
    const digest = crypto.createHash('sha256');
    const handle = this.fs.openSync(candidate, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      for (;;) {
        const bytesRead = this.fs.readSync(handle, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        digest.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      this.fs.closeSync(handle);
    }
    let afterStat;
    try { afterStat = this.fs.lstatSync(candidate, { bigint: true }); }
    catch (error) {
      throw new ModpackError('PLAN_STALE', 'A managed file changed during verification', { cause: error });
    }
    if (!sameFileIdentity(beforeIdentity, fileIdentity(afterStat))) {
      throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
    }
    return digest.digest('hex') === entry.installedHash ? 'matched' : 'modified';
  }

  #paths(serverPath) {
    const stateRoot = path.join(serverPath, STATE_DIRECTORY);
    return {
      stateRoot,
      modpack: path.join(stateRoot, CURRENT_STATE),
      manifests: path.join(stateRoot, 'manifests'),
      operations: path.join(stateRoot, 'operations'),
      history: path.join(stateRoot, 'history'),
      summary: path.join(serverPath, '.minecraft-core.json')
    };
  }

  #readHistoryLayout(serverPath) {
    const paths = this.#paths(serverPath);
    if (!this.#exists(paths.stateRoot)) return null;
    this.#assertDirectory(paths.stateRoot);
    if (!this.#exists(paths.history)) return null;
    this.#assertDirectory(paths.history);
    return paths;
  }

  #assertDirectory(directory) {
    const stat = this.fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !this.#samePath(this.fs.realpathSync.native(directory), directory)) {
      invalid('state');
    }
  }

  #ensureLayout(serverPath) {
    const paths = this.#paths(serverPath);
    let parent = serverPath;
    for (const directory of [paths.stateRoot, paths.manifests, paths.operations, paths.history]) {
      if (!this.#exists(directory)) {
        this.fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
        this.durableFs.flushDirectory(parent);
      }
      this.#assertDirectory(directory);
      parent = directory === paths.stateRoot ? paths.stateRoot : parent;
    }
    return paths;
  }

  async #ensureLayoutAsync(serverPath) {
    const paths = this.#paths(serverPath);
    let parent = serverPath;
    for (const directory of [paths.stateRoot, paths.manifests, paths.operations, paths.history]) {
      if (!this.#exists(directory)) {
        this.fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
        await this.durableFs.flushDirectoryAsync(parent);
      }
      this.#assertDirectory(directory);
      parent = directory === paths.stateRoot ? paths.stateRoot : parent;
    }
    return paths;
  }

  #readSummary(summaryPath) {
    if (!this.#exists(summaryPath)) return {};
    const value = this.#readJson(summaryPath);
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('summary');
    return value;
  }

  #readJson(filePath) {
    try {
      const bytes = this.durableFs.readFileBounded(filePath, { allowMissing: false, maxBytes: MAX_STATE_JSON_BYTES });
      return stateClone(JSON.parse(bytes.toString('utf8')), 'state');
    } catch (error) {
      if (error instanceof ModpackError && error.code === 'INVALID_REQUEST') throw error;
      invalid('state');
    }
  }

  #server(value) {
    try {
      if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') ||
          value.split(/[\\/]/u).some(part => part === '.' || part === '..')) invalid('serverPath');
      const resolved = path.resolve(value);
      if (resolved === path.parse(resolved).root) invalid('serverPath');
      const stat = this.fs.lstatSync(resolved, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !this.#samePath(this.fs.realpathSync.native(resolved), resolved)) invalid('serverPath');
      return resolved;
    } catch (error) {
      if (error instanceof ModpackError) throw error;
      invalid('serverPath');
    }
  }

  #exists(candidate) {
    try { this.fs.lstatSync(candidate, { bigint: true }); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  }

  #samePath(left, right) {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
  }
}

module.exports = {
  ModpackStateRepository,
  normalizeAcceptedMapping,
  normalizeStateInput
};
