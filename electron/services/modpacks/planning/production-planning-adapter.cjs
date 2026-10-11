const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { getDefaultServerConfig } = require('../../../utils/config-manager.cjs');
const { normalizeRuntimeTuple } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const {
  captureExistingUnmanagedTarget,
  captureReservedTarget
} = require('../../modpack-lifecycle/reserved-target-authority.cjs');
const { readContentRevision: defaultReadContentRevision } = require('../../server-content-revision.cjs');
const { computePreflightReserve } = require('../limits.cjs');
const { compileAssetPatternForInspection } = require('../providers/github-asset-pattern.cjs');
const { canonicalPath, planOwnership } = require('./ownership-planner.cjs');
const { computePreflightPlanFingerprint } = require('./plan-fingerprint.cjs');
const { buildPreflightPlan } = require('./preflight-planner.cjs');

const OPERATION_MAP = Object.freeze({
  'install-new': 'install',
  'install-existing': 'install',
  update: 'upgrade',
  upgrade: 'upgrade',
  downgrade: 'downgrade',
  switch: 'switch',
  repair: 'repair',
  detach: 'detach',
  uninstall: 'uninstall',
  'rollback-restore-point': 'rollback-restore-point',
  'files-only': 'files-only',
  'import-files-only-new': 'files-only'
});
const NON_DOWNGRADE_MANAGED_REPLACEMENTS = new Set(['install', 'upgrade', 'switch']);
const GITHUB_METADATA_RETAINING_REPLACEMENTS = new Set(['upgrade', 'downgrade']);
const PUBLIC_CONFLICT_CHOICES = new Set(['keep-mine', 'use-pack', 'keep-both', 'disable-addon', 'remove-addon']);
const PREFLIGHT_PROGRESS_PHASES = new Set([
  'validating-destination', 'preparing-candidate', 'scanning-server', 'verifying-restore-point', 'calculating-changes',
  'checking-capacity', 'sealing-plan'
]);
const CANDIDATE_PROGRESS_ACTIVITIES = new Set([
  'extracting', 'verifying-archive', 'downloading-pack-files', 'assembling-files', 'hashing-candidate-files'
]);
const DEFAULT_NEW_SERVER_CONFIG = getDefaultServerConfig();
const DEFAULT_NEW_SERVER_MAX_RAM = DEFAULT_NEW_SERVER_CONFIG.maxRam;
const DEFAULT_NEW_SERVER_PORT = DEFAULT_NEW_SERVER_CONFIG.port;
const DEFAULT_NEW_SERVER_NETWORK_ACCESS = DEFAULT_NEW_SERVER_CONFIG.networkAccess;

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The modpack preflight request is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reviewed server or archive changed', { cause });
}

function runtimeIncomplete() {
  return new ModpackError(
    'RUNTIME_INCOMPLETE',
    'The archive does not provide one exact Minecraft and loader runtime. Choose a Modrinth server pack or a GitHub asset with exact runtime evidence.'
  );
}

function downgradeRequired() {
  return new ModpackError(
    'DOWNGRADE_REQUIRED',
    'The selected runtime is older than the managed server runtime. Retry this operation as a downgrade.',
    { retryable: true }
  );
}

function switchRequired() {
  return new ModpackError(
    'SWITCH_REQUIRED',
    'The selected runtime uses a different loader family. Retry this operation as a switch.',
    { retryable: true }
  );
}

function selectedPortUnavailable(cause) {
  return new ModpackError(
    'INVALID_REQUEST',
    'The selected Minecraft server port is already in use. Choose another port and retry.',
    { cause, details: { field: 'selections.serverPort' }, retryable: true }
  );
}

function selectedPortCheckFailed(cause) {
  return new ModpackError(
    'INVALID_REQUEST',
    'The selected Minecraft server port could not be checked. Retry the review.',
    { cause, details: { field: 'selections.serverPort' }, retryable: true }
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function addByteCounts(...values) {
  try {
    return values.reduce((total, value) => {
      const normalized = String(value);
      if (!/^(0|[1-9][0-9]*)$/.test(normalized)) throw new TypeError();
      return total + BigInt(normalized);
    }, 0n).toString();
  } catch {
    throw invalid();
  }
}

function repairRuntimeStagingBytes(currentState, ownershipPlan, operationKind) {
  if (operationKind !== 'repair' || !currentState?.manifest?.entries) return '0';
  const runtimeByPath = new Map(currentState.manifest.entries
    .filter(entry => entry.origin === 'runtime' && entry.managementPolicy === 'replaceable-managed')
    .map(entry => [entry.pathKey, entry]));
  const needsRuntimeRebuild = ownershipPlan.actions.some(action =>
    ['replace', 'restore-missing'].includes(action.action) && runtimeByPath.has(action.pathKey));
  if (!needsRuntimeRebuild) return '0';
  return addByteCounts(...[...runtimeByPath.values()].map(entry => entry.size));
}

function sourceForPlan(source) {
  if (source.provider === 'modrinth') {
    return {
      provider: 'modrinth', projectId: source.projectId, versionId: source.versionId,
      version: source.version,
      ...(source.channel === undefined ? {} : {
        channel: source.channel,
        prerelease: source.prerelease,
        publishedAt: source.publishedAt
      }),
      ...(source.acceptedMapping === undefined ? {} : { acceptedMapping: source.acceptedMapping })
    };
  }
  if (source.provider === 'github') {
    return {
      provider: 'github', repositoryId: source.repositoryId, releaseId: source.releaseId,
      githubOwner: source.githubOwner, githubRepo: source.githubRepo, version: source.version,
      ...(source.channel === undefined ? {} : {
        channel: source.channel,
        prerelease: source.prerelease,
        publishedAt: source.publishedAt
      }),
      ...(source.assetPattern === undefined ? {} : { assetPattern: source.assetPattern }),
      ...(source.acceptedMapping === undefined ? {} : { acceptedMapping: source.acceptedMapping })
    };
  }
  if (source.provider === 'local') {
    return {
      provider: 'local', importId: source.importId, artifactSha256: source.artifactSha256,
      version: source.version
    };
  }
  throw invalid();
}

function createProgressReporter(onProgress) {
  if (onProgress === undefined) return () => {};
  if (typeof onProgress !== 'function') throw invalid();
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !PREFLIGHT_PROGRESS_PHASES.has(value.phase)) return;
    const event = { phase: value.phase };
    if (value.activity !== undefined) {
      const validActivity = CANDIDATE_PROGRESS_ACTIVITIES.has(value.activity) && (
        value.phase === 'preparing-candidate' ||
        (value.phase === 'verifying-restore-point' && value.activity === 'verifying-archive')
      );
      if (!validActivity) return;
      event.activity = value.activity;
    }
    for (const [completed, total] of [
      ['completedItems', 'totalItems'], ['processedBytes', 'totalBytes']
    ]) {
      const hasCompleted = value[completed] !== undefined;
      const hasTotal = value[total] !== undefined;
      if (hasCompleted !== hasTotal) return;
      if (!hasCompleted) continue;
      const completedValue = Number(value[completed]);
      const totalValue = Number(value[total]);
      if (!Number.isSafeInteger(completedValue) || completedValue < 0 ||
          !Number.isSafeInteger(totalValue) || totalValue < 0 || completedValue > totalValue ||
          !['preparing-candidate', 'verifying-restore-point'].includes(value.phase)) return;
      event[completed] = completedValue;
      event[total] = totalValue;
    }
    try {
      Promise.resolve(onProgress(deepFreeze(event))).catch(() => {});
    } catch { /* preflight progress cannot change the reviewed plan */ }
  };
}

function sourceForReview(source) {
  if (source === null) return null;
  const reviewed = { provider: source.provider, version: source.version };
  if (source.provider === 'github') {
    return {
      ...reviewed,
      repositoryId: source.repositoryId,
      releaseId: source.releaseId
    };
  }
  return reviewed;
}

function normalizeSelections(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return {
    optionalFileIds: Array.isArray(value.optionalFileIds) ? [...value.optionalFileIds] : [],
    conflictChoices: value.conflictChoices && typeof value.conflictChoices === 'object'
      ? value.conflictChoices
      : { paths: {}, categories: {} },
    acknowledgeMissingProviderDigest: value.acknowledgeMissingProviderDigest === true,
    acknowledgeDowngradeWorldRisk: value.acknowledgeDowngradeWorldRisk === true,
    selectedRoot: value.selectedRoot ?? null,
    runtimeChoice: value.runtimeChoice ?? null,
    maxRam: value.maxRam ?? null,
    serverPort: value.serverPort ?? null,
    networkAccess: value.networkAccess ?? null
  };
}

function inspectionForPlan(result) {
  const classification = result?.classification;
  if (!classification || classification.blocked === true || classification.confidence !== 'exact') throw runtimeIncomplete();
  const kind = classification.kind === 'mrpack-server'
    ? 'mrpack-server'
    : classification.kind === 'prepared-server-pack' || classification.kind === 'loader-installer-bundle'
      ? 'prepared-server-pack'
      : classification.kind === 'files-only'
        ? 'files-only'
        : null;
  if (!kind) throw runtimeIncomplete();
  const totals = result?.limitEvidence?.totals;
  if (!totals || !Number.isSafeInteger(totals.entryCount) || typeof totals.expandedBytes !== 'string') throw invalid();
  return {
    kind,
    selectedRoot: result.selectedRoot ?? null,
    expandedBytes: totals.expandedBytes,
    entryCount: totals.entryCount,
    fingerprint: sha256(result),
    ...(kind === 'files-only' ? { filesOnlySafe: true } : {})
  };
}

function defaultAvailableBytes(fsApi, serverPath) {
  const probe = fsApi.existsSync(serverPath) ? serverPath : path.dirname(serverPath);
  const stat = fsApi.statfsSync(probe, { bigint: true });
  return (BigInt(stat.bavail) * BigInt(stat.bsize)).toString();
}

function targetExists(fsApi, serverPath) {
  try { return Boolean(fsApi.lstatSync(serverPath, { bigint: true, throwIfNoEntry: false })); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function count(plan, key) {
  return Array.isArray(plan?.[key]) ? plan[key].length : 0;
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0;
}

function opaqueConflictId(secret, inspectionId, kind, value) {
  return `${kind}-${crypto.createHmac('sha256', secret)
    .update(`modpack-conflict-v1\0${inspectionId}\0${kind}\0${value}`, 'utf8')
    .digest('hex').slice(0, 48)}`;
}

function keepBothAllowed(action) {
  if (action.action !== 'conflict' || ['file-ancestor-collision', 'file-descendant-collision'].includes(action.reason)) return false;
  if (['protected-incoming-removed', 'protected-user-removed'].includes(action.reason)) return false;
  return !['world', 'secret'].includes(action.role);
}

function allowedConflictChoices(action) {
  if (action.action === 'incompatible-user-addon') return ['disable-addon', 'remove-addon'];
  if (action.action !== 'conflict' || ['file-ancestor-collision', 'file-descendant-collision'].includes(action.reason)) return [];
  return keepBothAllowed(action) ? ['keep-mine', 'use-pack', 'keep-both'] : ['keep-mine', 'use-pack'];
}

function alternateFor(action, occupied) {
  if (!keepBothAllowed(action)) return null;
  const extension = path.posix.extname(action.path);
  const withoutExtension = extension ? action.path.slice(0, -extension.length) : action.path;
  for (let index = 1; index <= 100; index += 1) {
    const suffix = index === 1 ? '.pack' : `.pack-${index}`;
    const candidate = `${withoutExtension}${suffix}${extension}`;
    let normalized;
    try { normalized = canonicalPath(candidate); }
    catch { continue; }
    if (!occupied.has(normalized.pathKey)) {
      occupied.add(normalized.pathKey);
      return normalized.path;
    }
  }
  return null;
}

function conflictAuthority(ownershipPlan, inspectionId, secret) {
  const occupied = new Set(ownershipPlan.actions.map(action => action.pathKey));
  const byId = new Map();
  const conflicts = ownershipPlan.blocked.map(action => {
    const id = opaqueConflictId(secret, inspectionId, 'conflict', action.pathKey);
    const allowedChoices = allowedConflictChoices(action);
    const alternatePath = alternateFor(action, occupied);
    const alternateOptions = alternatePath === null ? [] : [{
      id: opaqueConflictId(secret, inspectionId, 'alternate', `${action.pathKey}\0${alternatePath}`),
      label: alternatePath,
      alternatePath
    }];
    const authority = { action, allowedChoices, alternateOptions };
    byId.set(id, authority);
    return {
      id,
      label: action.path,
      role: action.role,
      reason: action.reason,
      protected: action.protected === true,
      allowedChoices: [...allowedChoices],
      alternateOptions: alternateOptions.map(option => ({ id: option.id, label: option.label }))
    };
  });
  return { byId, conflicts };
}

function publicChoiceEntries(value) {
  if (value === undefined) return { paths: {}, categories: {} };
  if (!plain(value) || Object.keys(value).some(key => !['paths', 'categories'].includes(key))) throw invalid();
  const paths = value.paths ?? {};
  const categories = value.categories ?? {};
  if (!plain(paths) || !plain(categories) || Object.keys(paths).length > 10_000 || Object.keys(categories).length > 32) throw invalid();
  return { paths, categories };
}

function resolveConflictChoices(value, preview, inspectionId, secret) {
  const submitted = publicChoiceEntries(value);
  const authority = conflictAuthority(preview, inspectionId, secret);
  const paths = {};
  for (const [id, decision] of Object.entries(submitted.paths)) {
    const issued = authority.byId.get(id);
    if (!issued || !plain(decision) || Object.keys(decision).some(key => !['choice', 'alternateId'].includes(key)) ||
        !PUBLIC_CONFLICT_CHOICES.has(decision.choice) || !issued.allowedChoices.includes(decision.choice)) throw invalid();
    const internal = { choice: decision.choice };
    if (decision.choice === 'keep-both') {
      if (typeof decision.alternateId !== 'string') throw invalid();
      const alternate = issued.alternateOptions.find(option => option.id === decision.alternateId);
      if (!alternate) throw invalid();
      internal.alternatePath = alternate.alternatePath;
    } else if (decision.alternateId !== undefined) {
      throw invalid();
    }
    paths[issued.action.path] = internal;
  }
  return { paths, categories: { ...submitted.categories } };
}

function effectiveReviewedSource(source, inspectionResult, runtime, selections) {
  const { rememberAssetPattern, assetPatternSeed, ...base } = source;
  if (rememberAssetPattern !== true) {
    if (assetPatternSeed !== undefined) throw invalid();
    return base;
  }
  if (source.provider !== 'github' || runtime === null || !inspectionResult?.classification) throw invalid();
  const assetPattern = compileAssetPatternForInspection({
    seed: assetPatternSeed,
    version: source.version,
    classificationKind: inspectionResult.classification.kind,
    inspectionResult,
    runtimeEvidence: runtime,
    userOverrides: {
      selectedRoot: selections.selectedRoot ?? null,
      runtimeChoice: selections.runtimeChoice ?? null
    }
  });
  return { ...base, assetPattern };
}

function sameRuntime(left, right) {
  try {
    return JSON.stringify(normalizeRuntimeTuple(left)) === JSON.stringify(normalizeRuntimeTuple(right));
  } catch {
    return false;
  }
}

function versionTokens(value) {
  const normalized = String(value).trim().replace(/^v(?=\d)/i, '');
  if (!/^\d+(?:\.\d+)*(?:-[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*)?$/.test(normalized)) return null;
  const precedence = normalized.split('+', 1)[0];
  const separator = precedence.indexOf('-');
  const main = separator === -1 ? precedence : precedence.slice(0, separator);
  const prerelease = separator === -1 ? null : precedence.slice(separator + 1);
  const tokenize = part => part.match(/\d+|[A-Za-z]+/g)?.map(token => (
    /^\d+$/.test(token) ? BigInt(token) : token.toLocaleLowerCase('en-US')
  )) || [];
  return {
    main: tokenize(main),
    prerelease: prerelease === null ? null : tokenize(prerelease)
  };
}

function compareTokenLists(left, right, { missingNumbersAreZero, numericBeforeText = false }) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftToken = left[index];
    const rightToken = right[index];
    if (leftToken === undefined || rightToken === undefined) {
      if (leftToken === undefined && rightToken === undefined) return 0;
      const remaining = leftToken === undefined ? right.slice(index) : left.slice(index);
      const equivalentToMissing = missingNumbersAreZero && remaining.every(token => typeof token === 'bigint' && token === 0n);
      if (equivalentToMissing) return 0;
      return leftToken === undefined ? -1 : 1;
    }
    if (typeof leftToken === typeof rightToken) {
      if (leftToken === rightToken) continue;
      return leftToken > rightToken ? 1 : -1;
    }
    if (numericBeforeText) return typeof leftToken === 'bigint' ? -1 : 1;
    return typeof leftToken === 'bigint' ? 1 : -1;
  }
  return 0;
}

function compareExactVersions(left, right) {
  if (left === right) return 0;
  const leftVersion = versionTokens(left);
  const rightVersion = versionTokens(right);
  if (leftVersion === null || rightVersion === null) return null;
  const main = compareTokenLists(leftVersion.main, rightVersion.main, { missingNumbersAreZero: true });
  if (main !== 0) return main;
  if (leftVersion.prerelease === null && rightVersion.prerelease !== null) return 1;
  if (leftVersion.prerelease !== null && rightVersion.prerelease === null) return -1;
  if (leftVersion.prerelease === null) return 0;
  return compareTokenLists(leftVersion.prerelease, rightVersion.prerelease, {
    missingNumbersAreZero: false,
    numericBeforeText: true
  });
}

function canonicalLoaderVersion(runtime) {
  if (runtime.loaderFamily !== 'forge') return runtime.loaderVersion;
  const minecraftPrefix = `${runtime.minecraftVersion}-`;
  return runtime.loaderVersion.startsWith(minecraftPrefix)
    ? runtime.loaderVersion.slice(minecraftPrefix.length)
    : runtime.loaderVersion;
}

function runtimeDirection(sourceRuntime, targetRuntime) {
  const minecraftDirection = compareExactVersions(targetRuntime.minecraftVersion, sourceRuntime.minecraftVersion);
  if (minecraftDirection === null || minecraftDirection < 0) return 'downgrade';
  if (targetRuntime.loaderFamily !== sourceRuntime.loaderFamily) return 'switch';
  if (minecraftDirection > 0) return 'forward';
  const targetLoaderVersion = canonicalLoaderVersion(targetRuntime);
  const sourceLoaderVersion = canonicalLoaderVersion(sourceRuntime);
  const loaderDirection = compareExactVersions(targetLoaderVersion, sourceLoaderVersion);
  return loaderDirection === null || loaderDirection < 0 ? 'downgrade' : 'forward';
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameGithubRepository(left, right) {
  return left?.provider === 'github' && right?.provider === 'github' &&
    left.repositoryId === right.repositoryId;
}

function sameAssetIds(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length < 1 || left.length !== right.length) return false;
  const normalize = value => value.map(item => {
    if (typeof item !== 'string' || !/^[1-9][0-9]{0,29}$/.test(item)) throw new TypeError();
    return item;
  }).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  try {
    const normalizedLeft = normalize(left);
    const normalizedRight = normalize(right);
    return new Set(normalizedLeft).size === normalizedLeft.length &&
      normalizedLeft.every((item, index) => item === normalizedRight[index]);
  } catch {
    return false;
  }
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  if (left.some(item => typeof item !== 'string') || right.some(item => typeof item !== 'string')) return false;
  const normalizedLeft = [...left].sort((a, b) => a.localeCompare(b, 'en-US'));
  const normalizedRight = [...right].sort((a, b) => a.localeCompare(b, 'en-US'));
  return new Set(normalizedLeft).size === normalizedLeft.length &&
    new Set(normalizedRight).size === normalizedRight.length &&
    normalizedLeft.every((item, index) => item === normalizedRight[index]);
}

function sameRepairSource(installed, reviewed, reviewedArtifactSetDigest = null) {
  if (!installed || !reviewed || installed.provider !== reviewed.provider) return false;
  if (!sameJson(installed.acceptedMapping, reviewed.acceptedMapping) ||
      !sameJson(installed.assetPattern, reviewed.assetPattern)) return false;
  if (installed.provider === 'modrinth') {
    return installed.projectId === reviewed.projectId && installed.versionId === reviewed.versionId &&
      (installed.artifactSetDigest === undefined || installed.artifactSetDigest === reviewedArtifactSetDigest);
  }
  if (installed.provider === 'github') {
    return installed.repositoryId === reviewed.repositoryId && installed.releaseId === reviewed.releaseId &&
      installed.githubOwner === reviewed.githubOwner && installed.githubRepo === reviewed.githubRepo &&
      (installed.channel === undefined || (installed.channel === reviewed.channel &&
        installed.prerelease === reviewed.prerelease && installed.publishedAt === reviewed.publishedAt)) &&
      Array.isArray(installed.selectedAssetIds) && installed.selectedAssetIds.length > 0 &&
      sameAssetIds(installed.selectedAssetIds, reviewed.selectedAssetIds) &&
      installed.artifactSetDigest === reviewedArtifactSetDigest;
  }
  if (installed.provider === 'local') return installed.artifactSha256 === reviewed.artifactSha256;
  return false;
}

function emptyManagementOwnership(preservedCount = 0) {
  return deepFreeze({
    type: 'ownership-plan', schemaVersion: 1,
    actions: [], added: [], changed: [], removed: [], preserved: [], conflicts: [], orphaned: [], userAddons: [], blocked: [],
    confirmation: {
      unchangedManagedRemovalCount: '0', preservedCategories: [], possibleNonRunnable: false,
      instanceRetained: true, worldsRetained: true
    },
    summary: { preservedCount }
  });
}

function managementDisk(snapshot, selectedRestorePoint, operationKind, availableBytes) {
  const candidateBytes = BigInt(String(snapshot.candidateBytes ?? '0'));
  const restorePointBytes = BigInt(String(snapshot.restorePointBytes ?? '0'));
  const rollbackBytes = BigInt(String(snapshot.rollbackBytes ?? '0'));
  const journalBytes = BigInt(String(snapshot.journalBytes ?? '1048576'));
  const selectedArchiveBytes = operationKind === 'rollback-restore-point'
    ? BigInt(String(selectedRestorePoint?.size ?? '0'))
    : 0n;
  const selectedExpandedBytes = operationKind === 'rollback-restore-point'
    ? BigInt(String(selectedRestorePoint?.totalBytes ?? '0'))
    : 0n;
  if (operationKind === 'rollback-restore-point' && selectedRestorePoint?.totalBytes === undefined) throw stale();
  // The verified archive is already present. Its extracted tree is promoted
  // into the owned candidate with same-volume renames, so it occupies one
  // expanded-payload allocation rather than separate staging and final trees.
  const selectedBytes = selectedExpandedBytes;
  const baseBytes = candidateBytes + restorePointBytes + rollbackBytes + journalBytes + selectedBytes;
  const reserveBytes = BigInt(computePreflightReserve(baseBytes.toString()));
  const requiredBytes = baseBytes + reserveBytes;
  const available = BigInt(String(availableBytes));
  if (available < requiredBytes) {
    throw new ModpackError('INSUFFICIENT_DISK', 'There is not enough disk space for this operation', {
      details: { requiredBytes: requiredBytes.toString(), availableBytes: available.toString() }
    });
  }
  return {
    candidateBytes: candidateBytes.toString(), restorePointBytes: restorePointBytes.toString(),
    rollbackBytes: rollbackBytes.toString(), journalBytes: journalBytes.toString(),
    selectedArchiveBytes: selectedArchiveBytes.toString(), selectedExpandedBytes: selectedExpandedBytes.toString(),
    selectedExtractionBytes: selectedExpandedBytes.toString(), selectedFinalPayloadBytes: selectedExpandedBytes.toString(),
    selectedBytes: selectedBytes.toString(),
    reserveBytes: reserveBytes.toString(), requiredBytes: requiredBytes.toString(), availableBytes: available.toString()
  };
}

function reviewedServerDisk(snapshot) {
  return {
    candidateBytes: String(snapshot.candidateBytes ?? '0'),
    restorePointBytes: String(snapshot.restorePointBytes ?? '0'),
    rollbackBytes: String(snapshot.rollbackBytes ?? '0'),
    journalBytes: String(snapshot.journalBytes ?? '1048576')
  };
}

class ProductionPlanningAdapter {
  constructor({
    instanceResolver,
    stateRepository,
    reparseInspector,
    preparePlanInputs,
    snapshotServer,
    fsApi = fs,
    availableBytes = null,
    validateServerPorts,
    planOwnershipFn = planOwnership,
    buildPreflightPlanFn = buildPreflightPlan,
    workspaceRegistry = null,
    resolveRestorePoint = null,
    listAvailableRestorePoints = null,
    readContentRevision = defaultReadContentRevision,
    conflictAuthoritySecret = crypto.randomBytes(32)
  } = {}) {
    if (!instanceResolver || typeof instanceResolver.resolveInstance !== 'function' ||
        !stateRepository || typeof stateRepository.read !== 'function' ||
        !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
        typeof preparePlanInputs !== 'function' || typeof snapshotServer !== 'function' ||
        !fsApi || typeof fsApi.lstatSync !== 'function' || typeof fsApi.statfsSync !== 'function' ||
        typeof validateServerPorts !== 'function' ||
        typeof planOwnershipFn !== 'function' || typeof buildPreflightPlanFn !== 'function' ||
        typeof readContentRevision !== 'function' ||
        !Buffer.isBuffer(conflictAuthoritySecret) || conflictAuthoritySecret.length < 32 ||
        (workspaceRegistry !== null && (!workspaceRegistry || typeof workspaceRegistry.createPlanningSession !== 'function' ||
          typeof workspaceRegistry.createStagingOutput !== 'function' || typeof workspaceRegistry.releaseOwner !== 'function')) ||
        (resolveRestorePoint !== null && typeof resolveRestorePoint !== 'function') ||
        (listAvailableRestorePoints !== null && typeof listAvailableRestorePoints !== 'function') ||
        (availableBytes !== null && typeof availableBytes !== 'function')) throw invalid();
    this.instanceResolver = instanceResolver;
    this.stateRepository = stateRepository;
    this.reparseInspector = reparseInspector;
    this.preparePlanInputs = preparePlanInputs;
    this.snapshotServer = snapshotServer;
    this.fs = fsApi;
    this.availableBytes = availableBytes || (serverPath => defaultAvailableBytes(this.fs, serverPath));
    this.validateServerPorts = validateServerPorts;
    this.planOwnership = planOwnershipFn;
    this.buildPreflightPlan = buildPreflightPlanFn;
    this.workspaceRegistry = workspaceRegistry;
    this.resolveRestorePoint = resolveRestorePoint;
    this.listAvailableRestorePoints = listAvailableRestorePoints;
    this.readContentRevision = readContentRevision;
    this.conflictAuthoritySecret = Buffer.from(conflictAuthoritySecret);
    this.executionRecords = new Map();
  }

  async listRollbackOptions({ instanceId } = {}) {
    if (typeof instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(instanceId) ||
        typeof this.stateRepository.listHistory !== 'function' ||
        typeof this.listAvailableRestorePoints !== 'function') throw invalid();
    const resolved = await this.instanceResolver.resolveInstance(instanceId);
    if (!resolved || resolved.instanceId !== instanceId || typeof resolved.serverPath !== 'string') throw stale();
    const serverPath = path.resolve(resolved.serverPath);
    if (!targetExists(this.fs, serverPath)) throw stale();
    const currentState = this.stateRepository.read(serverPath);
    if (!currentState?.state) throw stale();
    const historyPage = this.stateRepository.listHistory(serverPath, { cursor: null, limit: 200 });
    if (!historyPage || !Array.isArray(historyPage.items)) throw stale();
    const listed = await this.listAvailableRestorePoints({ serverPath, history: historyPage.items });
    if (!Array.isArray(listed) || listed.length > 200) throw stale();
    const seen = new Set();
    const items = listed.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          Object.keys(item).sort().join(',') !== 'createdAt,operationKind,restorePointId,runtime,sourceRevision,totalBytes' ||
          typeof item.restorePointId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.restorePointId) ||
          seen.has(item.restorePointId) || typeof item.operationKind !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.operationKind) ||
          typeof item.createdAt !== 'string' || Number.isNaN(Date.parse(item.createdAt)) ||
          !Number.isSafeInteger(item.sourceRevision) || item.sourceRevision < 0 ||
          typeof item.totalBytes !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(item.totalBytes)) throw stale();
      seen.add(item.restorePointId);
      return Object.freeze({
        restorePointId: item.restorePointId,
        operationKind: item.operationKind,
        createdAt: item.createdAt,
        sourceRevision: item.sourceRevision,
        runtime: normalizeRuntimeTuple(item.runtime),
        totalBytes: item.totalBytes
      });
    });
    return deepFreeze({ items });
  }

  async createPlan({ request, inspection, source, onProgress, preparationAttempt = null } = {}) {
    if (!request || !inspection || !source || request.inspectionId !== inspection.inspectionId ||
        typeof request.instanceId !== 'string') throw invalid();
    const reportProgress = createProgressReporter(onProgress);
    reportProgress({ phase: 'validating-destination' });
    const resolved = await this.instanceResolver.resolveInstance(request.instanceId);
    if (!resolved || resolved.instanceId !== request.instanceId || typeof resolved.serverPath !== 'string') throw stale();
    const serverPath = path.resolve(resolved.serverPath);
    const exists = targetExists(this.fs, serverPath);
    let currentState = null;
    if (exists) {
      try { currentState = this.stateRepository.read(serverPath); }
      catch (error) { throw stale(error); }
    }
    const operationKind = OPERATION_MAP[request.operationKind];
    if (!operationKind) throw invalid();
    const managed = currentState?.state?.modpackManaged === true && currentState?.manifest;
    const adoptingUnmanaged = !managed && request.operationKind === 'install-existing' &&
      operationKind === 'install' && exists && this.fs.readdirSync(serverPath).length > 0;
    const adoption = adoptingUnmanaged
      ? await captureExistingUnmanagedTarget({
          targetPath: serverPath,
          fsApi: this.fs,
          reparseInspector: this.reparseInspector
        })
      : null;
    const reservation = managed || adoptingUnmanaged
      ? null
      : await captureReservedTarget({
          targetPath: serverPath,
          fsApi: this.fs,
          reparseInspector: this.reparseInspector
        });
    const serverKind = managed || adoptingUnmanaged ? 'existing' : 'new';
    if (serverKind === 'new' && !['install', 'files-only'].includes(operationKind)) throw invalid();
    const expectedContentRevision = serverKind === 'existing'
      ? Math.max(currentState?.state?.contentRevision ?? 0, this.readContentRevision(serverPath))
      : 0;
    const selections = normalizeSelections(request.selections);
    if (serverKind === 'new' && operationKind !== 'files-only' && selections.maxRam === null) {
      // New modpack servers have no prior server configuration to inherit.
      // Bind the application's server default into the reviewed plan when an
      // older renderer does not yet send an explicit resource choice.
      selections.maxRam = DEFAULT_NEW_SERVER_MAX_RAM;
    }
    if (serverKind === 'new' && operationKind !== 'files-only') {
      if (selections.serverPort === null) selections.serverPort = DEFAULT_NEW_SERVER_PORT;
      if (selections.networkAccess === null) selections.networkAccess = DEFAULT_NEW_SERVER_NETWORK_ACCESS;
      let portValidation;
      try {
        portValidation = await this.validateServerPorts({
          instanceId: resolved.instanceId,
          serverPath,
          minecraftPort: selections.serverPort
        });
      } catch (error) {
        throw selectedPortCheckFailed(error);
      }
      if (!portValidation || typeof portValidation !== 'object' || Array.isArray(portValidation) ||
          typeof portValidation.valid !== 'boolean' || !Array.isArray(portValidation.errors)) {
        throw selectedPortCheckFailed();
      }
      if (!portValidation.valid) throw selectedPortUnavailable();
    }
    let snapshot = null;
    if (operationKind === 'repair' && managed) {
      reportProgress({ phase: 'scanning-server' });
      snapshot = await this.snapshotServer({
        currentState,
        expectedContentRevision,
        operationKind,
        runtime: currentState.state.runtime,
        serverKind,
        serverPath,
        unmanagedAdoption: adoptingUnmanaged
      });
      if (!snapshot || !snapshot.liveSnapshot || !Array.isArray(snapshot.pathPreconditions)) throw invalid();
    }
    reportProgress({ phase: 'preparing-candidate' });
    const prepared = await this.preparePlanInputs({
      inspection,
      preparationAttempt,
      operationKind,
      selections,
      serverKind,
      serverPath,
      source,
      onProgress: progress => reportProgress({ ...progress, phase: 'preparing-candidate' }),
      ...(snapshot ? { currentState, liveSnapshot: snapshot.liveSnapshot } : {})
    });
    if (!prepared || typeof prepared !== 'object' || !prepared.incomingManifest) throw invalid();
    if (selections.runtimeChoice !== null && prepared.runtimeChoice !== undefined) {
      if (!prepared.runtimeChoice || typeof prepared.runtimeChoice !== 'object' || Array.isArray(prepared.runtimeChoice)) throw invalid();
      selections.runtimeChoice = prepared.runtimeChoice;
    }
    const planInspection = inspectionForPlan(prepared.inspectionResult || inspection.result);
    if ((operationKind === 'files-only') !== (planInspection.kind === 'files-only')) throw invalid();
    let runtime = null;
    if (operationKind !== 'files-only') {
      try { runtime = normalizeRuntimeTuple(prepared.runtime || inspection.result.classification.runtime); }
      catch { throw runtimeIncomplete(); }
    } else if (prepared.runtime !== null) {
      throw invalid();
    }
    if (managed && NON_DOWNGRADE_MANAGED_REPLACEMENTS.has(operationKind)) {
      let sourceRuntime;
      try { sourceRuntime = normalizeRuntimeTuple(currentState.state.runtime); }
      catch (error) { throw stale(error); }
      const direction = runtimeDirection(sourceRuntime, runtime);
      if (direction === 'downgrade') throw downgradeRequired();
      if (direction === 'switch' && operationKind !== 'switch') throw switchRequired();
    }
    let effectiveSource = effectiveReviewedSource(
      source,
      prepared.inspectionResult || inspection.result,
      runtime,
      selections
    );
    const retainInstalledSourceMetadata = managed && (
      operationKind === 'repair' ||
      (GITHUB_METADATA_RETAINING_REPLACEMENTS.has(operationKind) &&
        sameGithubRepository(currentState.state.source, effectiveSource))
    );
    if (retainInstalledSourceMetadata) {
      effectiveSource = {
        ...effectiveSource,
        ...(effectiveSource.assetPattern === undefined && currentState.state.source.assetPattern !== undefined
          ? { assetPattern: structuredClone(currentState.state.source.assetPattern) }
          : {}),
        ...(effectiveSource.acceptedMapping === undefined && currentState.state.source.acceptedMapping !== undefined
          ? { acceptedMapping: structuredClone(currentState.state.source.acceptedMapping) }
          : {})
      };
    }
    if (operationKind === 'repair' && (!managed || !sameRepairSource(
      currentState.state.source,
      effectiveSource,
      inspection.verifiedArtifactSet?.artifactSet?.setDigest
    ) ||
        !sameRuntime(currentState.state.runtime, runtime) ||
        !sameStringSet(currentState.state.selectedOptionalFiles, selections.optionalFileIds))) throw stale();
    if (!snapshot) reportProgress({ phase: 'scanning-server' });
    snapshot ||= await this.snapshotServer({
      currentState,
      expectedContentRevision,
      operationKind,
      runtime,
      serverKind,
      serverPath,
      unmanagedAdoption: adoptingUnmanaged
    });
    if (!snapshot || !snapshot.liveSnapshot || !Array.isArray(snapshot.pathPreconditions)) throw invalid();
    reportProgress({ phase: 'calculating-changes' });
    const ownershipInput = {
      oldManifest: managed ? currentState.manifest : null,
      liveSnapshot: snapshot.liveSnapshot,
      incomingManifest: prepared.incomingManifest,
      ...(operationKind === 'repair' ? { operationKind: 'repair' } : {})
    };
    let ownershipPreview;
    try {
      ownershipPreview = this.planOwnership({ ...ownershipInput, conflictChoices: {} });
    } catch (error) {
      if (operationKind === 'repair') throw stale(error);
      throw error;
    }
    const resolvedConflictChoices = resolveConflictChoices(
      selections.conflictChoices,
      ownershipPreview,
      request.inspectionId,
      this.conflictAuthoritySecret
    );
    const ownershipPlan = Object.keys(resolvedConflictChoices.paths).length > 0 ||
      Object.keys(resolvedConflictChoices.categories).length > 0
      ? this.planOwnership({ ...ownershipInput, conflictChoices: resolvedConflictChoices })
      : ownershipPreview;
    if (ownershipPlan.blocked.length > 0) {
      const authority = conflictAuthority(ownershipPlan, request.inspectionId, this.conflictAuthoritySecret);
      return deepFreeze({
        requiresConflictReview: true,
        conflicts: authority.conflicts
      });
    }
    selections.conflictChoices = resolvedConflictChoices;
    const incomingCandidateBytes = prepared.candidateBytes ?? planInspection.expandedBytes;
    const runtimeStagingBytes = repairRuntimeStagingBytes(currentState, ownershipPlan, operationKind);
    const completeCandidateBytes = serverKind === 'existing'
      ? addByteCounts(snapshot.candidateBytes ?? '0', incomingCandidateBytes, runtimeStagingBytes)
      : addByteCounts(incomingCandidateBytes);
    reportProgress({ phase: 'checking-capacity' });
    const availableBytes = await this.availableBytes(serverPath);
    if (serverKind === 'existing') {
      let currentContentRevision;
      try {
        currentContentRevision = Math.max(
          currentState?.state?.contentRevision ?? 0,
          this.readContentRevision(serverPath)
        );
      } catch (error) {
        throw stale(error);
      }
      if (currentContentRevision !== expectedContentRevision) throw stale();
    }
    reportProgress({ phase: 'sealing-plan' });
    const plan = this.buildPreflightPlan({
      operation: {
        kind: operationKind,
        serverKind,
        instanceId: request.instanceId,
        expectedContentRevision,
        downgrade: operationKind === 'downgrade'
      },
      source: sourceForPlan(effectiveSource),
      artifactSet: inspection.verifiedArtifactSet,
      runtime,
      inspection: planInspection,
      serverSnapshot: {
        contentRevision: expectedContentRevision,
        availableBytes,
        // Existing mutations first clone the complete live tree, then overlay
        // the reviewed pack. Targeted runtime repair also builds the trusted
        // runtime in a private workspace before moving back only mismatches.
        candidateBytes: completeCandidateBytes,
        restorePointBytes: String(snapshot.restorePointBytes ?? '0'),
        rollbackBytes: String(snapshot.rollbackBytes ?? '0'),
        journalBytes: String(snapshot.journalBytes ?? '1048576'),
        writeable: snapshot.writeable !== false,
        pathPreconditions: snapshot.pathPreconditions,
        sourceRuntime: Object.hasOwn(snapshot, 'sourceRuntime') ? snapshot.sourceRuntime : runtime
      },
      ownershipPlan,
      restorePoints: snapshot.restorePoints || [],
      selections
    });
    if (this.executionRecords.has(plan.fingerprint)) throw stale();
    this.executionRecords.set(plan.fingerprint, deepFreeze({
      execution: prepared.execution || {},
      incomingManifest: prepared.incomingManifest,
      inspectionResult: prepared.inspectionResult || inspection.result,
      adoption,
      reservation,
      reviewedServerDisk: reviewedServerDisk(snapshot),
      serverKind,
      source: { ...effectiveSource },
      serverPath
    }));
    return deepFreeze({
      plan,
      sanitizedView: {
        title: effectiveSource.title || 'Modpack installation',
        source: sourceForReview(plan.source),
        runtime: runtime ? {
          minecraft: runtime.minecraftVersion,
          loader: runtime.loaderFamily,
          loaderVersion: runtime.loaderVersion,
          java: runtime.javaMajor
        } : null,
        resources: serverKind === 'new' && runtime
          ? {
              maxRam: plan.selections.maxRam,
              serverPort: plan.selections.serverPort,
              networkAccess: plan.selections.networkAccess
            }
          : null,
        server: { contentRevision: expectedContentRevision, priorState: serverKind },
        changes: {
          added: count(ownershipPlan, 'added'),
          changed: count(ownershipPlan, 'changed'),
          removed: count(ownershipPlan, 'removed'),
          preserved: count(ownershipPlan, 'preserved')
        },
        warnings: plan.requirements.missingProviderDigestAcknowledged
          ? [{ code: 'MISSING_PROVIDER_DIGEST', message: 'The provider supplied no trusted digest; the app-calculated SHA-256 is pinned.' }]
          : [],
        blockers: []
      }
    });
  }

  async createManagementPlan({ request, currentState, instance, onProgress } = {}) {
    if (!request || !currentState?.state || !instance || !this.workspaceRegistry ||
        request.instanceId !== instance.instanceId || typeof instance.serverPath !== 'string' ||
        !Number.isSafeInteger(currentState.state.contentRevision) || currentState.state.contentRevision < 0) throw invalid();
    if (request.operationKind === 'repair') {
      throw new ModpackError(
        'INVALID_REQUEST',
        'Repair requires the exact installed source to be selected and reviewed again'
      );
    }
    if (!['detach', 'uninstall', 'rollback-restore-point'].includes(request.operationKind)) throw invalid();
    if (['detach', 'uninstall'].includes(request.operationKind) &&
        (currentState.state.modpackManaged !== true || !currentState.manifest)) throw stale();
    const reportProgress = createProgressReporter(onProgress);
    const serverPath = path.resolve(instance.serverPath);
    const expectedContentRevision = Math.max(
      currentState.state.contentRevision,
      this.readContentRevision(serverPath)
    );
    const runtime = request.operationKind === 'rollback-restore-point'
      ? currentState.state.runtime ?? null
      : currentState.state.runtime;
    reportProgress({ phase: 'scanning-server' });
    const snapshot = await this.snapshotServer({
      currentState,
      expectedContentRevision,
      operationKind: request.operationKind,
      runtime,
      serverKind: 'existing',
      serverPath
    });
    if (!snapshot?.liveSnapshot || !Array.isArray(snapshot.pathPreconditions) || snapshot.writeable === false ||
        !Array.isArray(snapshot.restorePoints)) throw stale();

    let selectedPublicRestorePoint = null;
    let selectedRestorePoint = null;
    if (request.operationKind === 'rollback-restore-point') {
      selectedPublicRestorePoint = snapshot.restorePoints.find(point => point?.id === request.selectionRef) || null;
      if (!selectedPublicRestorePoint || typeof this.resolveRestorePoint !== 'function') throw stale();
      reportProgress({ phase: 'verifying-restore-point', activity: 'verifying-archive' });
      const expandedBytes = Number(selectedPublicRestorePoint.totalBytes);
      let archiveBytes = 0;
      let lastProcessedBytes = 0;
      const reportRestoreVerification = value => {
        if (!value || typeof value !== 'object') return;
        const processed = Number(value.processedBytes);
        const total = Number(value.totalBytes);
        if (!Number.isSafeInteger(processed) || processed < 0 ||
            !Number.isSafeInteger(total) || total < 0 || processed > total ||
            !Number.isSafeInteger(expandedBytes) || expandedBytes < 0) return;
        if (value.phase === 'archive-hash') archiveBytes = total;
        if (!['archive-hash', 'entry-verify'].includes(value.phase) || !Number.isSafeInteger(archiveBytes)) return;
        const combinedTotal = archiveBytes + expandedBytes;
        const combinedProcessed = value.phase === 'archive-hash' ? processed : archiveBytes + processed;
        if (!Number.isSafeInteger(combinedTotal) || !Number.isSafeInteger(combinedProcessed) ||
            combinedProcessed < lastProcessedBytes || combinedProcessed > combinedTotal) return;
        lastProcessedBytes = combinedProcessed;
        reportProgress({
          phase: 'verifying-restore-point',
          activity: 'verifying-archive',
          processedBytes: combinedProcessed,
          totalBytes: combinedTotal
        });
      };
      selectedRestorePoint = await this.resolveRestorePoint({
        serverPath,
        id: selectedPublicRestorePoint.id,
        sha256: selectedPublicRestorePoint.sha256
      }, {
        onProgress: reportRestoreVerification
      });
      if (!selectedRestorePoint || selectedRestorePoint.id !== selectedPublicRestorePoint.id ||
          selectedRestorePoint.sha256 !== selectedPublicRestorePoint.sha256 ||
          path.resolve(selectedRestorePoint.serverPath) !== serverPath) throw stale();
      if (typeof selectedRestorePoint.totalBytes !== 'string' ||
          !/^(0|[1-9][0-9]*)$/.test(selectedRestorePoint.totalBytes) ||
          (selectedPublicRestorePoint.totalBytes !== undefined &&
            selectedPublicRestorePoint.totalBytes !== selectedRestorePoint.totalBytes)) throw stale();
      selectedPublicRestorePoint = {
        ...selectedPublicRestorePoint,
        totalBytes: selectedRestorePoint.totalBytes
      };
    }

    reportProgress({ phase: 'calculating-changes' });
    let ownershipPlan;
    if (request.operationKind === 'uninstall') {
      const ownershipInput = {
        oldManifest: currentState.manifest,
        liveSnapshot: snapshot.liveSnapshot,
        incomingManifest: { schemaVersion: 1, installationId: 'uninstall-empty', entries: [] }
      };
      const preview = this.planOwnership({ ...ownershipInput, conflictChoices: {} });
      const paths = Object.fromEntries(preview.blocked.map(action => [action.path, { choice: 'keep-mine' }]));
      ownershipPlan = this.planOwnership({ ...ownershipInput, conflictChoices: { paths, categories: {} } });
      if (ownershipPlan.blocked.length > 0) throw stale();
    } else {
      ownershipPlan = emptyManagementOwnership(snapshot.liveSnapshot.entries.length);
    }

    reportProgress({ phase: 'checking-capacity' });
    const disk = managementDisk(
      snapshot,
      selectedRestorePoint,
      request.operationKind,
      await this.availableBytes(serverPath)
    );
    const targetRuntime = request.operationKind === 'rollback-restore-point'
      ? normalizeRuntimeTuple(selectedPublicRestorePoint.runtime)
      : normalizeRuntimeTuple(currentState.state.runtime);
    const restorePoints = request.operationKind === 'rollback-restore-point'
      ? [selectedPublicRestorePoint]
      : [];
    const operation = {
      kind: request.operationKind,
      serverKind: 'existing',
      instanceId: request.instanceId,
      expectedContentRevision,
      downgrade: false
    };
    const preconditions = {
      contentRevision: expectedContentRevision,
      stateFingerprint: sha256(currentState),
      pathPreconditions: snapshot.pathPreconditions,
      pathPreconditionsFingerprint: sha256(snapshot.pathPreconditions),
      ownershipFingerprint: sha256(ownershipPlan),
      restorePointsFingerprint: sha256(restorePoints),
      operationFingerprint: sha256(operation),
      minimumAvailableBytes: disk.requiredBytes,
      // Management reviews can be abandoned or expire while the underlying
      // server is unchanged. A fresh non-authority nonce keeps a later review
      // independently claimable without weakening any live-state precondition.
      reviewNonce: crypto.randomBytes(16).toString('hex')
    };
    reportProgress({ phase: 'sealing-plan' });
    const planWithoutFingerprint = {
      type: 'modpack-management-plan', schemaVersion: 1,
      operation,
      source: currentState.state.source ? sourceForPlan(currentState.state.source) : null,
      runtime: targetRuntime,
      ownership: ownershipPlan,
      restorePoints,
      disk,
      requirements: {
        verifiedRestorePointRequired: true,
        filesOnlySafetyConfirmed: false,
        missingProviderDigestAcknowledged: false,
        downgradeWorldRiskAcknowledged: false
      },
      preconditions
    };
    const plan = deepFreeze({
      ...planWithoutFingerprint,
      fingerprint: computePreflightPlanFingerprint(planWithoutFingerprint)
    });

    let planningSessionId = null;
    try {
      planningSessionId = this.workspaceRegistry.createPlanningSession();
      const managementOutputId = this.workspaceRegistry.createStagingOutput({ ownerId: planningSessionId });
      let currentContentRevision;
      try {
        currentContentRevision = Math.max(
          currentState.state.contentRevision,
          this.readContentRevision(serverPath)
        );
      } catch (error) {
        throw stale(error);
      }
      if (currentContentRevision !== expectedContentRevision) throw stale();
      if (this.executionRecords.has(plan.fingerprint)) throw stale();
      this.executionRecords.set(plan.fingerprint, deepFreeze({
        execution: { managementOutputId },
        operationKind: request.operationKind,
        reviewedServerDisk: reviewedServerDisk(snapshot),
        selectedRestorePoint,
        serverKind: 'existing',
        serverPath,
        source: currentState.state.source ? structuredClone(currentState.state.source) : null
      }));
      const changes = request.operationKind === 'uninstall'
        ? {
            added: count(ownershipPlan, 'added'), changed: count(ownershipPlan, 'changed'),
            removed: count(ownershipPlan, 'removed'), preserved: count(ownershipPlan, 'preserved')
          }
        : { added: 0, changed: 0, removed: 0, preserved: snapshot.liveSnapshot.entries.length };
      return deepFreeze({
        plan,
        planningSessionId,
        sanitizedView: {
          title: request.operationKind === 'detach'
            ? 'Detach modpack management'
            : request.operationKind === 'uninstall'
              ? 'Uninstall managed modpack files'
              : 'Restore an exact modpack point',
          operation: request.operationKind,
          source: sourceForReview(plan.source),
          runtime: {
            minecraft: targetRuntime.minecraftVersion,
            loader: targetRuntime.loaderFamily,
            loaderVersion: targetRuntime.loaderVersion,
            java: targetRuntime.javaMajor
          },
          server: { contentRevision: expectedContentRevision, priorState: 'existing' },
          changes,
          ...(request.operationKind === 'uninstall' ? { confirmation: ownershipPlan.confirmation } : {}),
          ...(selectedPublicRestorePoint ? {
            rollback: {
              id: selectedPublicRestorePoint.id,
              sourceRevision: selectedPublicRestorePoint.sourceRevision,
              worldIncluded: selectedPublicRestorePoint.worldIncluded
            }
          } : {}),
          warnings: request.operationKind === 'detach'
            ? [{ code: 'DETACH_STOPS_TRACKING', message: 'No server files will be removed; automatic modpack tracking will stop.' }]
            : [],
          blockers: []
        }
      });
    } catch (error) {
      if (planningSessionId !== null) {
        try { await this.workspaceRegistry.releaseOwner(planningSessionId); } catch { /* retain the planning failure */ }
      }
      throw error;
    }
  }

  getExecutionRecord(plan) {
    const record = this.executionRecords.get(plan?.fingerprint);
    if (!record) throw stale();
    return record;
  }
}

module.exports = { ProductionPlanningAdapter, inspectionForPlan, sameRepairSource, sourceForPlan };
