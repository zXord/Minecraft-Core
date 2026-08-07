const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeRuntimeTuple } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { captureReservedTarget } = require('../../modpack-lifecycle/reserved-target-authority.cjs');
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
const PUBLIC_CONFLICT_CHOICES = new Set(['keep-mine', 'use-pack', 'keep-both', 'disable-addon', 'remove-addon']);

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
      ...(source.acceptedMapping === undefined ? {} : { acceptedMapping: source.acceptedMapping })
    };
  }
  if (source.provider === 'github') {
    return {
      provider: 'github', repositoryId: source.repositoryId, releaseId: source.releaseId,
      githubOwner: source.githubOwner, githubRepo: source.githubRepo, version: source.version,
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
    runtimeChoice: value.runtimeChoice ?? null
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

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
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
  // The verified archive is already present, but rollback can temporarily hold
  // both secure extraction staging and the reconstructed final payload.
  const selectedBytes = selectedExpandedBytes * 2n;
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

class ProductionPlanningAdapter {
  constructor({
    instanceResolver,
    stateRepository,
    reparseInspector,
    preparePlanInputs,
    snapshotServer,
    fsApi = fs,
    availableBytes = null,
    planOwnershipFn = planOwnership,
    buildPreflightPlanFn = buildPreflightPlan,
    workspaceRegistry = null,
    resolveRestorePoint = null,
    conflictAuthoritySecret = crypto.randomBytes(32)
  } = {}) {
    if (!instanceResolver || typeof instanceResolver.resolveInstance !== 'function' ||
        !stateRepository || typeof stateRepository.read !== 'function' ||
        !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
        typeof preparePlanInputs !== 'function' || typeof snapshotServer !== 'function' ||
        !fsApi || typeof fsApi.lstatSync !== 'function' || typeof fsApi.statfsSync !== 'function' ||
        typeof planOwnershipFn !== 'function' || typeof buildPreflightPlanFn !== 'function' ||
        !Buffer.isBuffer(conflictAuthoritySecret) || conflictAuthoritySecret.length < 32 ||
        (workspaceRegistry !== null && (!workspaceRegistry || typeof workspaceRegistry.createPlanningSession !== 'function' ||
          typeof workspaceRegistry.createStagingOutput !== 'function' || typeof workspaceRegistry.releaseOwner !== 'function')) ||
        (resolveRestorePoint !== null && typeof resolveRestorePoint !== 'function') ||
        (availableBytes !== null && typeof availableBytes !== 'function')) throw invalid();
    this.instanceResolver = instanceResolver;
    this.stateRepository = stateRepository;
    this.reparseInspector = reparseInspector;
    this.preparePlanInputs = preparePlanInputs;
    this.snapshotServer = snapshotServer;
    this.fs = fsApi;
    this.availableBytes = availableBytes || (serverPath => defaultAvailableBytes(this.fs, serverPath));
    this.planOwnership = planOwnershipFn;
    this.buildPreflightPlan = buildPreflightPlanFn;
    this.workspaceRegistry = workspaceRegistry;
    this.resolveRestorePoint = resolveRestorePoint;
    this.conflictAuthoritySecret = Buffer.from(conflictAuthoritySecret);
    this.executionRecords = new Map();
  }

  async createPlan({ request, inspection, source } = {}) {
    if (!request || !inspection || !source || request.inspectionId !== inspection.inspectionId ||
        typeof request.instanceId !== 'string') throw invalid();
    const resolved = await this.instanceResolver.resolveInstance(request.instanceId);
    if (!resolved || resolved.instanceId !== request.instanceId || typeof resolved.serverPath !== 'string') throw stale();
    const serverPath = path.resolve(resolved.serverPath);
    const exists = targetExists(this.fs, serverPath);
    let currentState = null;
    if (exists) {
      try { currentState = this.stateRepository.read(serverPath); }
      catch (error) { throw stale(error); }
    }
    const managed = currentState?.state?.modpackManaged === true && currentState?.manifest;
    const reservation = managed
      ? null
      : await captureReservedTarget({
          targetPath: serverPath,
          fsApi: this.fs,
          reparseInspector: this.reparseInspector
        });
    const serverKind = managed ? 'existing' : 'new';
    const operationKind = OPERATION_MAP[request.operationKind];
    if (!operationKind || (serverKind === 'new' && !['install', 'files-only'].includes(operationKind))) throw invalid();
    const expectedContentRevision = serverKind === 'existing' ? currentState.state.contentRevision : 0;
    const selections = normalizeSelections(request.selections);
    let snapshot = null;
    if (operationKind === 'repair' && managed) {
      snapshot = await this.snapshotServer({
        currentState,
        expectedContentRevision,
        operationKind,
        runtime: currentState.state.runtime,
        serverKind,
        serverPath
      });
      if (!snapshot || !snapshot.liveSnapshot || !Array.isArray(snapshot.pathPreconditions)) throw invalid();
    }
    const prepared = await this.preparePlanInputs({
      inspection,
      operationKind,
      selections,
      serverKind,
      serverPath,
      source,
      ...(snapshot ? { currentState, liveSnapshot: snapshot.liveSnapshot } : {})
    });
    if (!prepared || typeof prepared !== 'object' || !prepared.incomingManifest) throw invalid();
    const planInspection = inspectionForPlan(prepared.inspectionResult || inspection.result);
    if ((operationKind === 'files-only') !== (planInspection.kind === 'files-only')) throw invalid();
    let runtime = null;
    if (operationKind !== 'files-only') {
      try { runtime = normalizeRuntimeTuple(prepared.runtime || inspection.result.classification.runtime); }
      catch { throw runtimeIncomplete(); }
    } else if (prepared.runtime !== null) {
      throw invalid();
    }
    let effectiveSource = effectiveReviewedSource(
      source,
      prepared.inspectionResult || inspection.result,
      runtime,
      selections
    );
    if (operationKind === 'repair' && managed) {
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
    snapshot ||= await this.snapshotServer({
      currentState,
      expectedContentRevision,
      operationKind,
      runtime,
      serverKind,
      serverPath
    });
    if (!snapshot || !snapshot.liveSnapshot || !Array.isArray(snapshot.pathPreconditions)) throw invalid();
    const ownershipInput = {
      oldManifest: currentState?.manifest || null,
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
        availableBytes: await this.availableBytes(serverPath),
        // Existing mutations first clone the complete live tree, then overlay
        // the reviewed pack. Targeted runtime repair also builds the trusted
        // runtime in a private workspace before moving back only mismatches.
        candidateBytes: completeCandidateBytes,
        restorePointBytes: String(snapshot.restorePointBytes ?? '0'),
        rollbackBytes: String(snapshot.rollbackBytes ?? '0'),
        journalBytes: String(snapshot.journalBytes ?? '1048576'),
        writeable: snapshot.writeable !== false,
        pathPreconditions: snapshot.pathPreconditions,
        sourceRuntime: snapshot.sourceRuntime ?? runtime
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
      reservation,
      serverKind,
      source: { ...effectiveSource },
      serverPath
    }));
    return deepFreeze({
      plan,
      sanitizedView: {
        title: effectiveSource.title || 'Modpack installation',
        source: { provider: effectiveSource.provider, version: effectiveSource.version },
        runtime: runtime ? {
          minecraft: runtime.minecraftVersion,
          loader: runtime.loaderFamily,
          loaderVersion: runtime.loaderVersion,
          java: runtime.javaMajor
        } : null,
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

  async createManagementPlan({ request, currentState, instance } = {}) {
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
    const serverPath = path.resolve(instance.serverPath);
    const runtime = request.operationKind === 'rollback-restore-point'
      ? currentState.state.runtime ?? null
      : currentState.state.runtime;
    const snapshot = await this.snapshotServer({
      currentState,
      expectedContentRevision: currentState.state.contentRevision,
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
      selectedRestorePoint = await this.resolveRestorePoint({
        serverPath,
        id: selectedPublicRestorePoint.id,
        sha256: selectedPublicRestorePoint.sha256
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
      expectedContentRevision: currentState.state.contentRevision,
      downgrade: false
    };
    const preconditions = {
      contentRevision: currentState.state.contentRevision,
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
      if (this.executionRecords.has(plan.fingerprint)) throw stale();
      this.executionRecords.set(plan.fingerprint, deepFreeze({
        execution: { managementOutputId },
        operationKind: request.operationKind,
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
          source: currentState.state.source
            ? { provider: currentState.state.source.provider, version: currentState.state.source.version }
            : null,
          runtime: {
            minecraft: targetRuntime.minecraftVersion,
            loader: targetRuntime.loaderFamily,
            loaderVersion: targetRuntime.loaderVersion,
            java: targetRuntime.javaMajor
          },
          server: { contentRevision: currentState.state.contentRevision, priorState: 'existing' },
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
        try { this.workspaceRegistry.releaseOwner(planningSessionId); } catch { /* retain the planning failure */ }
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
