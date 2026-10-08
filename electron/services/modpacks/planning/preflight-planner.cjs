const crypto = require('node:crypto');

const { strictJsonClone } = require('../../../utils/durable-fs.cjs');
const { isAppIssuedVerifiedArtifactSet, normalizeRuntimeTuple } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { computePreflightReserve, parseNonNegativeBytes } = require('../limits.cjs');
const { matchAssetPattern } = require('../providers/github-asset-pattern.cjs');
const { normalizeAcceptedMapping } = require('../state/modpack-state-repository.cjs');
const { canonicalPath, getAppIssuedOwnershipDecisions, isAppIssuedOwnershipPlan } = require('./ownership-planner.cjs');
const { PREFLIGHT_PLAN_JSON_LIMITS, computePreflightPlanFingerprint } = require('./plan-fingerprint.cjs');

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL_ID = /^[1-9][0-9]{0,29}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const OPERATIONS = new Set(['install', 'upgrade', 'downgrade', 'switch', 'repair', 'uninstall', 'detach', 'files-only']);
const INSPECTION_KINDS = new Set(['mrpack-server', 'prepared-server-pack', 'candidate-roots', 'files-only']);
const CONFLICT_CHOICES = new Set(['keep-mine', 'use-pack', 'keep-both', 'disable-addon', 'remove-addon']);
const OWNERSHIP_ROLES = new Set(['mod', 'configuration', 'world', 'runtime', 'library', 'server', 'resource', 'shader', 'application', 'secret', 'other']);
const APP_ISSUED_PREFLIGHT_PLANS = new WeakSet();

function fail(code = 'INVALID_REQUEST', field, details) {
  const messages = {
    INVALID_REQUEST: 'The preflight request is invalid',
    PLAN_STALE: 'The reviewed modpack plan is stale',
    INSUFFICIENT_DISK: 'There is not enough disk space for this operation',
    MISSING_PROVIDER_DIGEST: 'The provider did not publish an artifact digest'
  };
  throw new ModpackError(code, messages[code], {
    details: details || (field ? { field } : undefined)
  });
}

function clone(value, field) {
  try { return strictJsonClone(value, PREFLIGHT_PLAN_JSON_LIMITS); }
  catch { fail('INVALID_REQUEST', field); }
}

function exact(value, keys, field, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_REQUEST', field);
  if (Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_REQUEST', field);
  return value;
}

function id(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_REQUEST', field);
  return value;
}

function decimalId(value, field) {
  if (typeof value !== 'string' || !DECIMAL_ID.test(value)) fail('INVALID_REQUEST', field);
  try { BigInt(value); } catch { fail('INVALID_REQUEST', field); }
  return value;
}

function version(value, field) {
  if (typeof value !== 'string' || !VERSION.test(value) || /https?:|[\\/]/i.test(value) ||
      [...value].some(character => character.charCodeAt(0) <= 0x1f)) fail('INVALID_REQUEST', field);
  return value;
}

function githubOwner(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value)) {
    fail('INVALID_REQUEST', field);
  }
  return value;
}

function githubRepo(value, field) {
  if (typeof value !== 'string' || !/^(?!\.)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/iu.test(value)) {
    fail('INVALID_REQUEST', field);
  }
  return value;
}

function githubReleaseMetadata(value) {
  const supplied = [value.channel, value.prerelease, value.publishedAt].filter(item => item !== undefined).length;
  if (supplied === 0) return null;
  if (supplied !== 3 || !['release', 'prerelease'].includes(value.channel) || typeof value.prerelease !== 'boolean' ||
      value.channel !== (value.prerelease ? 'prerelease' : 'release') ||
      typeof value.publishedAt !== 'string' || value.publishedAt.length > 64) fail('INVALID_REQUEST', 'source');
  let publishedAt;
  try { publishedAt = new Date(value.publishedAt).toISOString(); } catch { fail('INVALID_REQUEST', 'source.publishedAt'); }
  if (publishedAt !== value.publishedAt) fail('INVALID_REQUEST', 'source.publishedAt');
  return { channel: value.channel, prerelease: value.prerelease, publishedAt };
}

function modrinthReleaseMetadata(value) {
  const supplied = [value.channel, value.prerelease, value.publishedAt].filter(item => item !== undefined).length;
  if (supplied === 0) return null;
  if (supplied !== 3 || !['release', 'beta', 'alpha'].includes(value.channel) ||
      typeof value.prerelease !== 'boolean' || value.prerelease !== (value.channel !== 'release') ||
      typeof value.publishedAt !== 'string' || value.publishedAt.length > 64) fail('INVALID_REQUEST', 'source');
  let publishedAt;
  try { publishedAt = new Date(value.publishedAt).toISOString(); } catch { fail('INVALID_REQUEST', 'source.publishedAt'); }
  if (publishedAt !== value.publishedAt) fail('INVALID_REQUEST', 'source.publishedAt');
  return { channel: value.channel, prerelease: value.prerelease, publishedAt };
}

function digest(value, field) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('INVALID_REQUEST', field);
  return value;
}

function bytes(value, field) {
  try {
    if (typeof value !== 'string' || value.length > 40) throw new TypeError();
    return parseNonNegativeBytes(value);
  } catch { fail('INVALID_REQUEST', field); }
}

function revision(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_REQUEST', field);
  return value;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, 'en-US'))
    .map(key => [key, canonical(value[key])]));
}

function runtime(value, field) {
  try { return { ...normalizeRuntimeTuple(value) }; }
  catch { fail('INVALID_REQUEST', field); }
}

function runtimeChoice(value) {
  if (value === null || value === undefined) return null;
  exact(value, ['minecraftVersion', 'loaderFamily', 'loaderVersion'], 'selections.runtimeChoice');
  if (typeof value.minecraftVersion !== 'string' ||
      !/^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/.test(value.minecraftVersion) ||
      !['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'].includes(value.loaderFamily) ||
      typeof value.loaderVersion !== 'string' || !VERSION.test(value.loaderVersion)) {
    fail('INVALID_REQUEST', 'selections.runtimeChoice');
  }
  return {
    minecraftVersion: value.minecraftVersion,
    loaderFamily: value.loaderFamily,
    loaderVersion: value.loaderVersion
  };
}

function maxRamChoice(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    fail('INVALID_REQUEST', 'selections.maxRam');
  }
  return value;
}

function serverPortChoice(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1025 || value > 65535) {
    fail('INVALID_REQUEST', 'selections.serverPort');
  }
  return value;
}

function networkAccessChoice(value) {
  if (value === null || value === undefined) return null;
  if (!['pack-default', 'loopback'].includes(value)) {
    fail('INVALID_REQUEST', 'selections.networkAccess');
  }
  return value;
}

function normalizeOperation(value) {
  exact(value, ['kind', 'serverKind', 'instanceId', 'expectedContentRevision', 'downgrade'], 'operation');
  if (!OPERATIONS.has(value.kind) || !['new', 'existing'].includes(value.serverKind) || typeof value.downgrade !== 'boolean') fail('INVALID_REQUEST', 'operation');
  if (value.kind === 'downgrade' && !value.downgrade) fail('INVALID_REQUEST', 'operation.downgrade');
  if (value.serverKind === 'new' && value.expectedContentRevision !== 0) fail('INVALID_REQUEST', 'operation.expectedContentRevision');
  return {
    kind: value.kind,
    serverKind: value.serverKind,
    instanceId: id(value.instanceId, 'operation.instanceId'),
    expectedContentRevision: revision(value.expectedContentRevision, 'operation.expectedContentRevision'),
    downgrade: value.downgrade
  };
}

function normalizeSource(value) {
  exact(value, [
    'provider', 'projectId', 'versionId', 'repositoryId', 'releaseId', 'importId', 'artifactSha256', 'version',
    'githubOwner', 'githubRepo', 'channel', 'prerelease', 'publishedAt', 'assetPattern', 'acceptedMapping'
  ], 'source', ['provider', 'version']);
  const common = { provider: value.provider, version: version(value.version, 'source.version') };
  if (value.provider === 'github') {
    if (value.projectId !== undefined || value.versionId !== undefined || value.importId !== undefined || value.artifactSha256 !== undefined) fail('INVALID_REQUEST', 'source');
    const repositoryId = decimalId(value.repositoryId, 'source.repositoryId');
    const releaseId = decimalId(value.releaseId, 'source.releaseId');
    let assetPattern;
    if (value.assetPattern !== undefined) {
      assetPattern = clone(value.assetPattern, 'source.assetPattern');
      try { matchAssetPattern(assetPattern, []); }
      catch { fail('INVALID_REQUEST', 'source.assetPattern'); }
    }
    const acceptedMapping = value.acceptedMapping === undefined ? undefined : normalizeAcceptedMapping(value.acceptedMapping, 'source.acceptedMapping');
    if (acceptedMapping && acceptedMapping.githubRepositoryId !== repositoryId) fail('INVALID_REQUEST', 'source.acceptedMapping');
    const releaseMetadata = githubReleaseMetadata(value);
    return {
      ...common,
      repositoryId,
      releaseId,
      githubOwner: githubOwner(value.githubOwner, 'source.githubOwner'),
      githubRepo: githubRepo(value.githubRepo, 'source.githubRepo'),
      ...(releaseMetadata || {}),
      ...(assetPattern === undefined ? {} : { assetPattern }),
      ...(acceptedMapping === undefined ? {} : { acceptedMapping })
    };
  }
  if (value.provider === 'modrinth') {
    if (value.repositoryId !== undefined || value.releaseId !== undefined || value.githubOwner !== undefined ||
        value.githubRepo !== undefined || value.importId !== undefined || value.artifactSha256 !== undefined ||
        value.assetPattern !== undefined) fail('INVALID_REQUEST', 'source');
    const projectId = id(value.projectId, 'source.projectId');
    const acceptedMapping = value.acceptedMapping === undefined ? undefined : normalizeAcceptedMapping(value.acceptedMapping, 'source.acceptedMapping');
    if (acceptedMapping && acceptedMapping.modrinthProjectId !== projectId) fail('INVALID_REQUEST', 'source.acceptedMapping');
    const releaseMetadata = modrinthReleaseMetadata(value);
    return {
      ...common,
      projectId,
      versionId: id(value.versionId, 'source.versionId'),
      ...(releaseMetadata || {}),
      ...(acceptedMapping === undefined ? {} : { acceptedMapping })
    };
  }
  if (value.provider === 'local') {
    if (value.projectId !== undefined || value.versionId !== undefined || value.repositoryId !== undefined || value.releaseId !== undefined ||
        value.githubOwner !== undefined || value.githubRepo !== undefined ||
        value.channel !== undefined || value.prerelease !== undefined || value.publishedAt !== undefined ||
        value.assetPattern !== undefined || value.acceptedMapping !== undefined) fail('INVALID_REQUEST', 'source');
    return { ...common, importId: id(value.importId, 'source.importId'), artifactSha256: digest(value.artifactSha256, 'source.artifactSha256') };
  }
  fail('INVALID_REQUEST', 'source.provider');
}

function normalizeArtifactSet(value, source) {
  if (!isAppIssuedVerifiedArtifactSet(value)) fail('INVALID_REQUEST', 'artifactSet');
  const verified = value;
  if (verified.provider !== source.provider || !verified.artifactSet || !Array.isArray(verified.artifactSet.parts)) fail('INVALID_REQUEST', 'artifactSet');
  if (source.provider !== 'local') {
    const expectedProject = source.provider === 'github' ? source.repositoryId : source.projectId;
    const expectedRelease = source.provider === 'github' ? source.releaseId : source.versionId;
    if (verified.project?.id !== expectedProject || verified.release?.id !== expectedRelease) fail('INVALID_REQUEST', 'artifactSet');
  }
  const parts = verified.artifactSet.parts.map((part, index) => {
    if (!part || typeof part !== 'object' || typeof part.measuredSize !== 'string' || !part.calculatedDigests) fail('INVALID_REQUEST', `artifactSet.parts.${index}`);
    return {
      partId: id(part.partId, `artifactSet.parts.${index}.partId`),
      measuredSize: bytes(part.measuredSize, `artifactSet.parts.${index}.measuredSize`).toString(),
      sha256: digest(part.calculatedDigests.sha256, `artifactSet.parts.${index}.sha256`),
      providerDigest: part.providerDigest ? {
        algorithm: part.providerDigest.algorithm,
        value: part.providerDigest.value
      } : null
    };
  }).sort((left, right) => left.partId.localeCompare(right.partId, 'en-US'));
  if (new Set(parts.map(part => part.partId)).size !== parts.length) fail('INVALID_REQUEST', 'artifactSet.parts');
  return {
    provider: verified.provider,
    projectId: verified.project?.id ?? null,
    releaseId: verified.release?.id ?? null,
    setDigest: digest(verified.artifactSet.setDigest, 'artifactSet.setDigest'),
    parts
  };
}

function normalizeInspection(value) {
  exact(value, ['kind', 'selectedRoot', 'expandedBytes', 'entryCount', 'fingerprint', 'filesOnlySafe'], 'inspection',
    ['kind', 'selectedRoot', 'expandedBytes', 'entryCount', 'fingerprint']);
  if (!INSPECTION_KINDS.has(value.kind) || !Number.isSafeInteger(value.entryCount) || value.entryCount < 0 || value.entryCount > 250_000) fail('INVALID_REQUEST', 'inspection');
  if (value.selectedRoot !== null && (typeof value.selectedRoot !== 'string' || value.selectedRoot.length > 1024)) fail('INVALID_REQUEST', 'inspection.selectedRoot');
  if (value.filesOnlySafe !== undefined && typeof value.filesOnlySafe !== 'boolean') fail('INVALID_REQUEST', 'inspection.filesOnlySafe');
  if (value.kind === 'files-only' && value.filesOnlySafe !== true) fail('INVALID_REQUEST', 'inspection.filesOnlySafe');
  return {
    kind: value.kind,
    expandedBytes: bytes(value.expandedBytes, 'inspection.expandedBytes').toString(),
    entryCount: value.entryCount,
    fingerprint: digest(value.fingerprint, 'inspection.fingerprint'),
    selectedRootFingerprint: fingerprint(value.selectedRoot)
  };
}

function normalizePathPreconditions(value) {
  if (!Array.isArray(value) || value.length > 250_000) fail('INVALID_REQUEST', 'serverSnapshot.pathPreconditions');
  const result = value.map((entry, index) => {
    const field = `serverSnapshot.pathPreconditions.${index}`;
    exact(entry, ['path', 'pathKey', 'exists', 'type', 'size', 'sha256', 'dev', 'ino', 'birthtime'], field);
    const normalized = canonicalPath(entry.path, `${field}.path`);
    if (entry.pathKey !== normalized.pathKey || typeof entry.exists !== 'boolean') fail('INVALID_REQUEST', field);
    if (!entry.exists) {
      if ([entry.type, entry.size, entry.sha256, entry.dev, entry.ino, entry.birthtime].some(item => item !== null)) fail('INVALID_REQUEST', field);
      return { ...normalized, exists: false, type: null, size: null, sha256: null, dev: null, ino: null, birthtime: null };
    }
    if (!['file', 'directory'].includes(entry.type)) fail('INVALID_REQUEST', `${field}.type`);
    const file = entry.type === 'file';
    if ((file && typeof entry.sha256 !== 'string') || (!file && entry.sha256 !== null)) fail('INVALID_REQUEST', field);
    return {
      ...normalized,
      exists: true,
      type: entry.type,
      size: bytes(entry.size, `${field}.size`).toString(),
      sha256: file ? digest(entry.sha256, `${field}.sha256`) : null,
      dev: id(entry.dev, `${field}.dev`),
      ino: id(entry.ino, `${field}.ino`),
      birthtime: id(entry.birthtime, `${field}.birthtime`)
    };
  }).sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  if (new Set(result.map(entry => entry.pathKey)).size !== result.length) fail('INVALID_REQUEST', 'serverSnapshot.pathPreconditions');
  return result;
}

function normalizeServerSnapshot(value, { allowNullRuntime = false } = {}) {
  exact(value, [
    'contentRevision', 'availableBytes', 'candidateBytes', 'restorePointBytes', 'rollbackBytes', 'journalBytes',
    'writeable', 'pathPreconditions', 'sourceRuntime'
  ], 'serverSnapshot');
  if (typeof value.writeable !== 'boolean') fail('INVALID_REQUEST', 'serverSnapshot.writeable');
  return {
    contentRevision: revision(value.contentRevision, 'serverSnapshot.contentRevision'),
    availableBytes: bytes(value.availableBytes, 'serverSnapshot.availableBytes'),
    candidateBytes: bytes(value.candidateBytes, 'serverSnapshot.candidateBytes'),
    restorePointBytes: bytes(value.restorePointBytes, 'serverSnapshot.restorePointBytes'),
    rollbackBytes: bytes(value.rollbackBytes, 'serverSnapshot.rollbackBytes'),
    journalBytes: bytes(value.journalBytes, 'serverSnapshot.journalBytes'),
    writeable: value.writeable,
    pathPreconditions: normalizePathPreconditions(value.pathPreconditions),
    sourceRuntime: allowNullRuntime && value.sourceRuntime === null
      ? null
      : runtime(value.sourceRuntime, 'serverSnapshot.sourceRuntime')
  };
}

function normalizeRestorePoints(value) {
  if (!Array.isArray(value) || value.length > 1024) fail('INVALID_REQUEST', 'restorePoints');
  const result = value.map((entry, index) => {
    const field = `restorePoints.${index}`;
    exact(
      entry,
      ['id', 'sha256', 'sourceRevision', 'runtime', 'worldIncluded', 'totalBytes'],
      field,
      ['id', 'sha256', 'sourceRevision', 'runtime', 'worldIncluded']
    );
    if (typeof entry.worldIncluded !== 'boolean') fail('INVALID_REQUEST', `${field}.worldIncluded`);
    return {
      id: id(entry.id, `${field}.id`),
      sha256: digest(entry.sha256, `${field}.sha256`),
      sourceRevision: revision(entry.sourceRevision, `${field}.sourceRevision`),
      runtime: runtime(entry.runtime, `${field}.runtime`),
      worldIncluded: entry.worldIncluded,
      ...(entry.totalBytes === undefined ? {} : { totalBytes: bytes(entry.totalBytes, `${field}.totalBytes`).toString() })
    };
  }).sort((left, right) => left.id.localeCompare(right.id, 'en-US'));
  if (new Set(result.map(entry => entry.id)).size !== result.length) fail('INVALID_REQUEST', 'restorePoints');
  return result;
}

function normalizeSelections(value) {
  exact(value, [
    'optionalFileIds', 'conflictChoices', 'acknowledgeMissingProviderDigest', 'acknowledgeDowngradeWorldRisk',
    'selectedRoot', 'runtimeChoice', 'maxRam', 'serverPort', 'networkAccess'
  ], 'selections', ['optionalFileIds', 'conflictChoices', 'acknowledgeMissingProviderDigest', 'acknowledgeDowngradeWorldRisk']);
  if (!Array.isArray(value.optionalFileIds) || typeof value.acknowledgeMissingProviderDigest !== 'boolean' ||
      typeof value.acknowledgeDowngradeWorldRisk !== 'boolean') fail('INVALID_REQUEST', 'selections');
  const optionalFileIds = value.optionalFileIds.map((item, index) => id(item, `selections.optionalFileIds.${index}`))
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  if (new Set(optionalFileIds).size !== optionalFileIds.length) fail('INVALID_REQUEST', 'selections.optionalFileIds');
  let selectedRoot = value.selectedRoot ?? null;
  if (selectedRoot !== null) {
    const normalized = canonicalPath(selectedRoot, 'selections.selectedRoot');
    if (normalized.path.includes('/')) fail('INVALID_REQUEST', 'selections.selectedRoot');
    selectedRoot = normalized.path;
  }
  return {
    optionalFileIds,
    conflictChoices: normalizeConflictChoices(value.conflictChoices),
    acknowledgeMissingProviderDigest: value.acknowledgeMissingProviderDigest,
    acknowledgeDowngradeWorldRisk: value.acknowledgeDowngradeWorldRisk,
    selectedRoot,
    runtimeChoice: runtimeChoice(value.runtimeChoice),
    maxRam: maxRamChoice(value.maxRam),
    serverPort: serverPortChoice(value.serverPort),
    networkAccess: networkAccessChoice(value.networkAccess)
  };
}

function normalizeConflictChoices(value) {
  exact(value, ['paths', 'categories'], 'selections.conflictChoices', []);
  const pathEntries = [];
  const pathKeys = new Set();
  if (value.paths !== undefined) {
    if (!value.paths || typeof value.paths !== 'object' || Array.isArray(value.paths) || Object.getPrototypeOf(value.paths) !== Object.prototype) {
      fail('INVALID_REQUEST', 'selections.conflictChoices.paths');
    }
    for (const rawPath of Object.keys(value.paths).sort((left, right) => left.localeCompare(right, 'en-US'))) {
      const normalized = canonicalPath(rawPath, `selections.conflictChoices.paths.${rawPath}`);
      if (pathKeys.has(normalized.pathKey)) fail('INVALID_REQUEST', 'selections.conflictChoices.paths');
      pathKeys.add(normalized.pathKey);
      const decision = exact(value.paths[rawPath], ['choice', 'alternatePath'], `selections.conflictChoices.paths.${rawPath}`, ['choice']);
      if (!CONFLICT_CHOICES.has(decision.choice)) fail('INVALID_REQUEST', `selections.conflictChoices.paths.${rawPath}.choice`);
      if (decision.choice === 'keep-both') {
        if (decision.alternatePath === undefined) fail('INVALID_REQUEST', `selections.conflictChoices.paths.${rawPath}.alternatePath`);
        pathEntries.push([normalized.pathKey, {
          choice: decision.choice,
          alternatePath: canonicalPath(decision.alternatePath, `selections.conflictChoices.paths.${rawPath}.alternatePath`).path
        }]);
      } else {
        if (decision.alternatePath !== undefined) fail('INVALID_REQUEST', `selections.conflictChoices.paths.${rawPath}.alternatePath`);
        pathEntries.push([normalized.pathKey, { choice: decision.choice }]);
      }
    }
  }
  const categories = {};
  if (value.categories !== undefined) {
    if (!value.categories || typeof value.categories !== 'object' || Array.isArray(value.categories) || Object.getPrototypeOf(value.categories) !== Object.prototype) {
      fail('INVALID_REQUEST', 'selections.conflictChoices.categories');
    }
    for (const role of Object.keys(value.categories).sort((left, right) => left.localeCompare(right, 'en-US'))) {
      if (!OWNERSHIP_ROLES.has(role) || !['keep-mine', 'use-pack'].includes(value.categories[role])) {
        fail('INVALID_REQUEST', `selections.conflictChoices.categories.${role}`);
      }
      categories[role] = value.categories[role];
    }
  }
  pathEntries.sort(([left], [right]) => left.localeCompare(right, 'en-US'));
  return { paths: Object.fromEntries(pathEntries), categories };
}

function normalizeOwnershipPlan(value, original) {
  if (!isAppIssuedOwnershipPlan(original)) fail('INVALID_REQUEST', 'ownershipPlan');
  const decisions = getAppIssuedOwnershipDecisions(original);
  if (!decisions) fail('INVALID_REQUEST', 'ownershipPlan');
  const plan = clone(value, 'ownershipPlan');
  exact(plan, [
    'type', 'schemaVersion', 'actions', 'added', 'changed', 'removed', 'preserved', 'conflicts', 'orphaned', 'userAddons', 'blocked', 'confirmation'
  ], 'ownershipPlan');
  if (plan.type !== 'ownership-plan' || plan.schemaVersion !== 1 || !Array.isArray(plan.actions) || !Array.isArray(plan.blocked)) fail('INVALID_REQUEST', 'ownershipPlan');
  if (plan.blocked.length > 0) fail('INVALID_REQUEST', 'ownershipPlan.blocked');
  return { plan, decisions };
}

function buildPreflightPlan(inputValue) {
  const input = clone(inputValue, 'input');
  exact(input, ['operation', 'source', 'artifactSet', 'runtime', 'inspection', 'serverSnapshot', 'ownershipPlan', 'restorePoints', 'selections'], 'input');
  // Use the original object for the app-issued WeakSet check; all other values come from the strict clone.
  const operation = normalizeOperation(input.operation);
  const source = normalizeSource(input.source);
  const artifact = normalizeArtifactSet(inputValue.artifactSet, source);
  if (source.provider === 'local' && source.artifactSha256 !== artifact.setDigest) {
    fail('INVALID_REQUEST', 'source.artifactSha256');
  }
  const targetRuntime = operation.kind === 'files-only'
    ? (input.runtime === null ? null : fail('INVALID_REQUEST', 'runtime'))
    : runtime(input.runtime, 'runtime');
  const inspection = normalizeInspection(input.inspection);
  const snapshot = normalizeServerSnapshot(input.serverSnapshot, {
    allowNullRuntime: (operation.kind === 'files-only' && operation.serverKind === 'new') ||
      (operation.kind === 'install' && operation.serverKind === 'existing')
  });
  const ownershipEvidence = normalizeOwnershipPlan(input.ownershipPlan, inputValue.ownershipPlan);
  const ownership = ownershipEvidence.plan;
  const restorePoints = normalizeRestorePoints(input.restorePoints);
  const selections = normalizeSelections(input.selections);
  if (JSON.stringify(selections.conflictChoices) !== JSON.stringify(ownershipEvidence.decisions)) {
    fail('INVALID_REQUEST', 'selections.conflictChoices');
  }
  if (operation.expectedContentRevision !== snapshot.contentRevision || !snapshot.writeable) fail('INVALID_REQUEST', 'serverSnapshot');
  if ((operation.kind === 'files-only') !== (inspection.kind === 'files-only')) fail('INVALID_REQUEST', 'inspection.kind');
  if (operation.kind === 'files-only') {
    if (selections.runtimeChoice !== null || snapshot.sourceRuntime !== null) fail('INVALID_REQUEST', 'selections.runtimeChoice');
    if (selections.maxRam !== null) fail('INVALID_REQUEST', 'selections.maxRam');
    if (selections.serverPort !== null) fail('INVALID_REQUEST', 'selections.serverPort');
    if (selections.networkAccess !== null) fail('INVALID_REQUEST', 'selections.networkAccess');
  } else if (selections.runtimeChoice !== null && (
    selections.runtimeChoice.minecraftVersion !== targetRuntime.minecraftVersion ||
    selections.runtimeChoice.loaderFamily !== targetRuntime.loaderFamily ||
    selections.runtimeChoice.loaderVersion !== targetRuntime.loaderVersion
  )) {
    fail('INVALID_REQUEST', 'selections.runtimeChoice');
  }
  if (operation.kind !== 'files-only') {
    if (operation.serverKind === 'new') {
      if (selections.maxRam === null) fail('INVALID_REQUEST', 'selections.maxRam');
      if (selections.serverPort === null) fail('INVALID_REQUEST', 'selections.serverPort');
      if (selections.networkAccess === null) fail('INVALID_REQUEST', 'selections.networkAccess');
    }
    if (operation.serverKind === 'existing') {
      if (selections.maxRam !== null) fail('INVALID_REQUEST', 'selections.maxRam');
      if (selections.serverPort !== null) fail('INVALID_REQUEST', 'selections.serverPort');
      if (selections.networkAccess !== null) fail('INVALID_REQUEST', 'selections.networkAccess');
    }
  }

  const missingProviderDigest = source.provider === 'github' && artifact.parts.some(part => part.providerDigest === null);
  if (missingProviderDigest && !selections.acknowledgeMissingProviderDigest) {
    fail('MISSING_PROVIDER_DIGEST', null, { partId: artifact.parts.find(part => part.providerDigest === null).partId });
  }
  if (!missingProviderDigest && selections.acknowledgeMissingProviderDigest) {
    fail('INVALID_REQUEST', 'selections.acknowledgeMissingProviderDigest');
  }
  if (operation.downgrade) {
    if (!selections.acknowledgeDowngradeWorldRisk) fail('INVALID_REQUEST', 'restorePoints');
  } else if (selections.acknowledgeDowngradeWorldRisk) {
    fail('INVALID_REQUEST', 'selections.acknowledgeDowngradeWorldRisk');
  }

  const downloadBytes = artifact.parts.reduce((total, part) => total + BigInt(part.measuredSize), 0n);
  const baseFootprint = downloadBytes + BigInt(inspection.expandedBytes) + snapshot.candidateBytes + snapshot.restorePointBytes +
    snapshot.rollbackBytes + snapshot.journalBytes;
  const reserveBytes = BigInt(computePreflightReserve(baseFootprint.toString()));
  const requiredBytes = baseFootprint + reserveBytes;
  if (snapshot.availableBytes < requiredBytes) fail('INSUFFICIENT_DISK', null, {
    requiredBytes: requiredBytes.toString(), availableBytes: snapshot.availableBytes.toString()
  });

  const sourceIdentity = source.provider === 'github'
    ? {
        provider: 'github', repositoryId: source.repositoryId, releaseId: source.releaseId,
        githubOwner: source.githubOwner, githubRepo: source.githubRepo, version: source.version,
        ...(source.channel === undefined ? {} : {
          channel: source.channel,
          prerelease: source.prerelease,
          publishedAt: source.publishedAt
        })
      }
    : source.provider === 'modrinth'
      ? {
          provider: 'modrinth', projectId: source.projectId, versionId: source.versionId, version: source.version,
          ...(source.channel === undefined ? {} : {
            channel: source.channel,
            prerelease: source.prerelease,
            publishedAt: source.publishedAt
          })
        }
      : { provider: 'local', importId: source.importId, artifactSha256: source.artifactSha256, version: source.version };
  const verifiedRestorePointRequired = operation.serverKind === 'existing' && operation.kind !== 'detach';
  const preconditions = {
    contentRevision: snapshot.contentRevision,
    paths: snapshot.pathPreconditions,
    sourceIdentity,
    artifactSetDigest: artifact.setDigest,
    artifactPartsFingerprint: fingerprint(artifact.parts),
    runtimeFingerprint: fingerprint(targetRuntime),
    inspectionFingerprint: fingerprint(inspection),
    ownershipFingerprint: fingerprint(ownership),
    selectionsFingerprint: fingerprint(selections),
    restorePointsFingerprint: fingerprint(restorePoints),
    assetPatternFingerprint: fingerprint(source.assetPattern ?? null),
    acceptedMappingFingerprint: fingerprint(source.acceptedMapping ?? null),
    operationFingerprint: fingerprint(operation),
    minimumAvailableBytes: requiredBytes.toString()
  };
  const planWithoutFingerprint = {
    type: 'modpack-preflight-plan',
    schemaVersion: 1,
    operation,
    source: sourceIdentity,
    artifact,
    runtime: targetRuntime,
    inspection,
    ownership,
    restorePoints,
    selections,
    disk: {
      downloadBytes: downloadBytes.toString(),
      expandedBytes: inspection.expandedBytes,
      candidateBytes: snapshot.candidateBytes.toString(),
      restorePointBytes: snapshot.restorePointBytes.toString(),
      rollbackBytes: snapshot.rollbackBytes.toString(),
      journalBytes: snapshot.journalBytes.toString(),
      reserveBytes: reserveBytes.toString(),
      requiredBytes: requiredBytes.toString(),
      availableBytes: snapshot.availableBytes.toString()
    },
    requirements: {
      missingProviderDigestAcknowledged: missingProviderDigest && selections.acknowledgeMissingProviderDigest,
      downgradeWorldRiskAcknowledged: operation.downgrade && selections.acknowledgeDowngradeWorldRisk,
      verifiedRestorePointRequired,
      filesOnlySafetyConfirmed: inspection.kind === 'files-only'
    },
    preconditions
  };
  const plan = deepFreeze({ ...planWithoutFingerprint, fingerprint: computePreflightPlanFingerprint(planWithoutFingerprint) });
  APP_ISSUED_PREFLIGHT_PLANS.add(plan);
  return plan;
}

function assertPlanStillValid(planValue, snapshotValue, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => key !== 'skipAvailableCapacity') ||
      (options.skipAvailableCapacity !== undefined && typeof options.skipAvailableCapacity !== 'boolean')) {
    fail('INVALID_REQUEST', 'options');
  }
  if (!planValue || typeof planValue !== 'object' || !APP_ISSUED_PREFLIGHT_PLANS.has(planValue)) {
    fail('PLAN_STALE', 'plan');
  }
  const plan = clone(planValue, 'plan');
  const snapshot = clone(snapshotValue, 'currentSnapshot');
  if (!plan || plan.type !== 'modpack-preflight-plan' || plan.schemaVersion !== 1 ||
      computePreflightPlanFingerprint(plan) !== plan.fingerprint) fail('PLAN_STALE', 'plan');
  exact(snapshot, [
    'contentRevision', 'pathPreconditions', 'sourceIdentity', 'artifactSetDigest', 'artifactPartsFingerprint', 'runtime',
    'inspectionFingerprint', 'ownershipFingerprint', 'selectionsFingerprint', 'restorePointsFingerprint',
    'assetPatternFingerprint', 'acceptedMappingFingerprint', 'operationFingerprint', 'availableBytes'
  ], 'currentSnapshot');
  const checks = {
    contentRevision: snapshot.contentRevision,
    paths: normalizePathPreconditions(snapshot.pathPreconditions),
    sourceIdentity: snapshot.sourceIdentity,
    artifactSetDigest: snapshot.artifactSetDigest,
    artifactPartsFingerprint: snapshot.artifactPartsFingerprint,
    runtimeFingerprint: fingerprint(plan.operation.kind === 'files-only' && snapshot.runtime === null
      ? null
      : runtime(snapshot.runtime, 'currentSnapshot.runtime')),
    inspectionFingerprint: snapshot.inspectionFingerprint,
    ownershipFingerprint: snapshot.ownershipFingerprint,
    selectionsFingerprint: snapshot.selectionsFingerprint,
    restorePointsFingerprint: snapshot.restorePointsFingerprint,
    assetPatternFingerprint: snapshot.assetPatternFingerprint,
    acceptedMappingFingerprint: snapshot.acceptedMappingFingerprint,
    operationFingerprint: snapshot.operationFingerprint
  };
  for (const [key, value] of Object.entries(checks)) {
    if (JSON.stringify(value) !== JSON.stringify(plan.preconditions[key])) fail('PLAN_STALE', key);
  }
  if (options.skipAvailableCapacity !== true &&
      bytes(snapshot.availableBytes, 'currentSnapshot.availableBytes') < BigInt(plan.preconditions.minimumAvailableBytes)) {
    fail('PLAN_STALE', 'availableBytes');
  }
  return planValue;
}

module.exports = { assertPlanStillValid, buildPreflightPlan };
