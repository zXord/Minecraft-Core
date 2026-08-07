const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_AUTHORITY_KEY = /(?:path|directory|destination|command|argument|executable)/i;
const PLANNING_AUTHORITY_KEY = /(?:path|url|uri|cache|workspace|directory|destination|command|argument|executable|token|secret|password|artifactSetId|inputDirectoryId|outputDirectoryId|planningSessionId)/i;
const PUBLIC_INTERNAL_KEY = /(?:path|url|uri|cache|workspace|directory|destination|command|argument|executable|token|secret|password|provider.?internal|artifactSetId|inputDirectoryId|outputDirectoryId|planningSessionId)/i;
const INTERNAL_ID = /^(?:artifact-set|input|output|planning|workspace|cache)-/i;
const SHA256 = /^[a-f0-9]{64}$/;
const EXECUTION_CHOICE_KEYS = Object.freeze(['acceptEula', 'startAfterInstall', 'restorePointId']);
const MANAGEMENT_OPERATION_KINDS = new Set(['detach', 'uninstall', 'repair', 'rollback-restore-point']);
const MUTATION_RUNTIME_METHODS = Object.freeze([
  'resolveInstance', 'suspendAutoRestart', 'quiesce', 'revalidate', 'createRestorePoint', 'buildCandidate',
  'validateCandidate', 'publishCandidate', 'registerPublishedInstance', 'commitCandidate', 'startFinal',
  'validateLive', 'persistOutcome', 'cleanup', 'rollback', 'abandonCandidate', 'restorePriorState'
]);
const MUTATION_OPERATION_KINDS = new Set([
  'install-new', 'install-existing', 'update', 'downgrade', 'switch', 'repair', 'rollback-restore-point', 'detach',
  'import-files-only-new', 'uninstall-managed'
]);
const TERMINAL_JOB_PHASES = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);
const MAX_OUTCOME_ACTIONS = 16;

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The modpack lifecycle request is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale', { cause });
}

function cancelled(cause) {
  return new ModpackError('CANCELLED', 'The modpack operation was cancelled', { cause });
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'The modpack operation requires recovery', { cause });
}

function strictObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.some(name => !allowedKeys.includes(name)) || requiredKeys.some(name => !Object.hasOwn(descriptors, name))) throw invalid();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return descriptors;
}

function clone(value) {
  try { return strictJsonClone(value); }
  catch (error) { throw invalid(error); }
}

function assertIdentifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid();
  return value;
}

function assertSafeString(value, { allowRemoteUrl = false, allowInternalId = false } = {}) {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.normalize('NFC') ||
      /(?:^|\s)[A-Za-z]:[\\/]/u.test(value) || /(?:^|\s)\\\\/u.test(value) || /\bfile:\/\//iu.test(value) ||
      (!allowRemoteUrl && /\bhttps?:\/\//iu.test(value)) || (!allowInternalId && INTERNAL_ID.test(value))) throw invalid();
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) throw invalid();
  }
  return value;
}

function validateClosedValue(value, options, field = 'request', depth = 0) {
  if (depth > 12) throw invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (typeof value === 'string') {
    return assertSafeString(value, {
      allowRemoteUrl: options.allowRemoteUrl,
      allowInternalId: options.allowInternalId || field === 'request.inspectionId'
    });
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000) throw invalid();
    return value.map((item, index) => validateClosedValue(item, options, `${field}.${index}`, depth + 1));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 512) throw invalid();
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key)) throw invalid();
    const qualified = `${field}.${key}`;
    const keyAllowed = options.allowedAuthorityKeys?.has(qualified);
    if (!keyAllowed && options.forbiddenKey.test(key)) throw invalid();
    result[key] = validateClosedValue(descriptor.value, options, qualified, depth + 1);
  }
  return result;
}

function sourceRequest(value) {
  const cloned = clone(value);
  return deepFreeze(validateClosedValue(cloned, {
    allowRemoteUrl: true,
    allowInternalId: true,
    forbiddenKey: SOURCE_AUTHORITY_KEY
  }));
}

function planningRequest(value) {
  const cloned = clone(value);
  const normalized = validateClosedValue(cloned, {
    allowRemoteUrl: false,
    allowInternalId: false,
    forbiddenKey: PLANNING_AUTHORITY_KEY,
    allowedAuthorityKeys: new Set(['request.inspectionId'])
  });
  assertIdentifier(normalized.inspectionId);
  return deepFreeze(normalized);
}

function managementPlanningRequest(value) {
  const descriptors = strictObject(value, ['instanceId', 'operationKind', 'selectionRef'], ['instanceId', 'operationKind']);
  const instanceId = assertIdentifier(descriptors.instanceId.value);
  const operationKind = descriptors.operationKind.value;
  if (!MANAGEMENT_OPERATION_KINDS.has(operationKind)) throw invalid();
  const selectionRef = descriptors.selectionRef?.value ?? null;
  if (selectionRef !== null) assertIdentifier(selectionRef);
  if (operationKind === 'rollback-restore-point' && selectionRef === null) throw invalid();
  if (['detach', 'uninstall'].includes(operationKind) && selectionRef !== null) throw invalid();
  return deepFreeze({ instanceId, operationKind, selectionRef });
}

function publicView(value) {
  const cloned = clone(value);
  const normalized = validateClosedValue(cloned, {
    allowRemoteUrl: false,
    allowInternalId: false,
    forbiddenKey: PUBLIC_INTERNAL_KEY,
    allowedAuthorityKeys: new Set(['public.inspectionId'])
  }, 'public');
  return deepFreeze(normalized);
}

function executionChoices(value) {
  const descriptors = strictObject(value, EXECUTION_CHOICE_KEYS, []);
  const acceptEula = descriptors.acceptEula?.value ?? false;
  const startAfterInstall = descriptors.startAfterInstall?.value ?? false;
  const restorePointId = descriptors.restorePointId?.value ?? null;
  if (typeof acceptEula !== 'boolean' || typeof startAfterInstall !== 'boolean' ||
      (restorePointId !== null && (typeof restorePointId !== 'string' || !IDENTIFIER.test(restorePointId)))) throw invalid();
  return deepFreeze({ acceptEula, startAfterInstall, restorePointId });
}

function normalizeIssuedActions(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_OUTCOME_ACTIONS) throw invalid();
  const seen = new Set();
  return value.map(item => {
    const descriptors = strictObject(item, ['actionId', 'opaqueRef']);
    const actionId = assertIdentifier(descriptors.actionId.value);
    const opaqueRef = assertIdentifier(descriptors.opaqueRef.value);
    if (seen.has(actionId)) throw invalid();
    seen.add(actionId);
    return { actionId, opaqueRef };
  });
}

function hasVerifiedRetainedArtifact(plan) {
  const artifact = plan?.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) ||
      !SHA256.test(artifact.setDigest || '') || !Array.isArray(artifact.parts) || artifact.parts.length < 1) return false;
  const partIds = new Set();
  for (const part of artifact.parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part) ||
        typeof part.partId !== 'string' || !IDENTIFIER.test(part.partId) || partIds.has(part.partId) ||
        typeof part.measuredSize !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(part.measuredSize) ||
        !SHA256.test(part.sha256 || '')) return false;
    partIds.add(part.partId);
  }
  return true;
}

function mutationOperationKind(plan) {
  const operation = plan?.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw stale();
  let kind;
  if (operation.kind === 'install') {
    if (operation.serverKind === 'new') kind = 'install-new';
    else if (operation.serverKind === 'existing') kind = 'install-existing';
  } else if (operation.kind === 'files-only' && operation.serverKind === 'new' &&
      plan.requirements?.filesOnlySafetyConfirmed === true && plan.inspection?.kind === 'files-only') {
    kind = 'import-files-only-new';
  } else if (operation.kind === 'uninstall' && operation.serverKind === 'existing') {
    const confirmation = plan.ownership?.confirmation;
    if (!confirmation || typeof confirmation.unchangedManagedRemovalCount !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(confirmation.unchangedManagedRemovalCount) ||
        !Array.isArray(confirmation.preservedCategories) || typeof confirmation.possibleNonRunnable !== 'boolean' ||
        confirmation.instanceRetained !== true || confirmation.worldsRetained !== true) throw stale();
    kind = 'uninstall-managed';
  } else if (operation.kind === 'upgrade') {
    kind = 'update';
  } else if (['downgrade', 'switch', 'repair', 'rollback-restore-point', 'detach'].includes(operation.kind)) {
    kind = operation.kind;
  }
  if (!MUTATION_OPERATION_KINDS.has(kind) || typeof operation.instanceId !== 'string' ||
      !IDENTIFIER.test(operation.instanceId) || !Number.isSafeInteger(operation.expectedContentRevision) ||
      operation.expectedContentRevision < 0) throw stale();
  return kind;
}

function compatibleDowngradeRestorePoint(plan, choices) {
  if (!Array.isArray(plan.restorePoints) || plan.requirements?.downgradeWorldRiskAcknowledged !== true) return null;
  const candidates = plan.restorePoints.filter(point => point && typeof point === 'object' &&
    point.worldIncluded === true && point.sourceRevision === plan.operation.expectedContentRevision &&
    typeof point.id === 'string' && IDENTIFIER.test(point.id));
  if (choices.restorePointId !== null) return candidates.find(point => point.id === choices.restorePointId) || null;
  return candidates.length === 1 ? candidates[0] : null;
}

function selectedPinnedRestorePoint(plan, choices) {
  if (!Array.isArray(plan.restorePoints) || choices.restorePointId === null) return null;
  return plan.restorePoints.find(point => point && typeof point === 'object' && point.id === choices.restorePointId) || null;
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'COMMIT_FAILED';
}

function publicSource(source) {
  if (!source) return null;
  const common = {
    provider: source.provider,
    version: source.version,
    title: source.title
  };
  if (source.provider === 'github') {
    return {
      ...common,
      repositoryId: source.repositoryId,
      releaseId: source.releaseId,
      githubOwner: source.githubOwner,
      githubRepo: source.githubRepo
    };
  }
  if (source.provider === 'modrinth') {
    return { ...common, projectId: source.projectId, versionId: source.versionId };
  }
  if (source.provider === 'local') {
    return { ...common, importId: source.importId, artifactSha256: source.artifactSha256 };
  }
  throw invalid();
}

function publicHistoryEntry(entry) {
  const result = {
    schemaVersion: entry.schemaVersion,
    operationId: entry.operationId,
    sequence: entry.sequence,
    kind: entry.kind,
    outcome: entry.outcome,
    timestamp: entry.timestamp,
    sourceRevision: entry.sourceRevision,
    targetRevision: entry.targetRevision
  };
  for (const key of ['restorePointId', 'restorePointSha256', 'sourceRuntime', 'targetRuntime']) {
    if (entry[key] !== undefined) result[key] = clone(entry[key]);
  }
  return result;
}

function assertResolvedInstance(value, expectedInstanceId) {
  const descriptors = strictObject(value, ['instanceId', 'serverPath', 'priorRunning']);
  const instanceId = descriptors.instanceId.value;
  const serverPath = descriptors.serverPath.value;
  const priorRunning = descriptors.priorRunning.value;
  if (instanceId !== expectedInstanceId || typeof serverPath !== 'string' || serverPath.length < 1 ||
      typeof priorRunning !== 'boolean') throw stale();
  return deepFreeze({ instanceId, serverPath, priorRunning });
}

class ModpackLifecycleService {
  constructor({
    sourceResolver,
    artifactDownloader,
    archiveInspector,
    inspectionLoader,
    planningAdapter,
    planRegistry,
    operationStore,
    mutationCoordinator = null,
    mutationRuntime = null,
    instanceResolver = null,
    stateRepository = null,
    stateEventSink = null,
    outcomeActionIssuer = null
  } = {}) {
    if (!sourceResolver || typeof sourceResolver.resolveArtifactSetPlan !== 'function' ||
        !artifactDownloader || typeof artifactDownloader.downloadSet !== 'function' ||
        !archiveInspector || typeof archiveInspector.inspectArchive !== 'function' ||
        !inspectionLoader || typeof inspectionLoader.loadInspection !== 'function' ||
        !planningAdapter || typeof planningAdapter.createPlan !== 'function' ||
        !planRegistry || typeof planRegistry.create !== 'function' || typeof planRegistry.get !== 'function' ||
        typeof planRegistry.claim !== 'function' ||
        !operationStore || typeof operationStore.get !== 'function' || typeof operationStore.requestCancellation !== 'function' ||
        (stateEventSink !== null && typeof stateEventSink !== 'function') ||
        (outcomeActionIssuer !== null && (!outcomeActionIssuer || typeof outcomeActionIssuer.issue !== 'function'))) {
      throw invalid();
    }
    this.sourceResolver = sourceResolver;
    this.artifactDownloader = artifactDownloader;
    this.archiveInspector = archiveInspector;
    this.inspectionLoader = inspectionLoader;
    this.planningAdapter = planningAdapter;
    this.planRegistry = planRegistry;
    this.operationStore = operationStore;
    this.mutationCoordinator = mutationCoordinator;
    this.mutationRuntime = mutationRuntime;
    this.instanceResolver = instanceResolver;
    this.stateRepository = stateRepository;
    this.stateEventSink = stateEventSink;
    this.outcomeActionIssuer = outcomeActionIssuer;
    this.inspections = new Map();
    this.activeOperations = new Map();
    this.releasedClaims = new Set();
  }

  async inspectSource(request) {
    const normalizedRequest = sourceRequest(request);
    const resolution = await this.sourceResolver.resolveArtifactSetPlan(normalizedRequest);
    const descriptors = strictObject(resolution, ['artifactSetPlan', 'source']);
    const source = clone(descriptors.source.value);
    const verifiedArtifactSet = await this.artifactDownloader.downloadSet(descriptors.artifactSetPlan.value);
    const inspected = await this.archiveInspector.inspectArchive({ verifiedArtifactSet });
    const safeInspection = publicView(inspected);
    const inspectionId = assertIdentifier(safeInspection.inspectionId);
    if (this.inspections.has(inspectionId)) throw stale();
    this.inspections.set(inspectionId, deepFreeze({ source, request: clone(normalizedRequest) }));
    return safeInspection;
  }

  async createPlan(request) {
    const normalizedRequest = planningRequest(request);
    const inspectionId = normalizedRequest.inspectionId;
    const session = this.inspections.get(inspectionId);
    if (!session) throw stale();
    let inspection;
    try { inspection = this.inspectionLoader.loadInspection(inspectionId); }
    catch (error) { throw error instanceof ModpackError ? error : stale(error); }
    if (!inspection || inspection.inspectionId !== inspectionId) throw stale();
    const planned = await this.planningAdapter.createPlan({
      request: normalizedRequest,
      inspection,
      source: deepFreeze(clone(session.source))
    });
    if (planned?.requiresConflictReview === true) {
      const descriptors = strictObject(planned, ['requiresConflictReview', 'conflicts']);
      if (!Array.isArray(descriptors.conflicts.value) || descriptors.conflicts.value.length < 1) throw invalid();
      return publicView(planned);
    }
    const descriptors = strictObject(planned, ['plan', 'sanitizedView']);
    const plan = descriptors.plan.value;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || typeof plan.fingerprint !== 'string') throw invalid();
    const created = this.planRegistry.create({
      plan,
      sanitizedView: descriptors.sanitizedView.value,
      fingerprint: plan.fingerprint,
      planningSessionId: inspectionId
    });
    this.inspections.delete(inspectionId);
    return deepFreeze({
      planId: created.planId,
      planFingerprint: created.fingerprint,
      planView: created.planView,
      expiresAt: created.expiresAt
    });
  }

  async createManagementPlan(requestValue) {
    const request = managementPlanningRequest(requestValue);
    if (typeof this.planningAdapter.createManagementPlan !== 'function' ||
        !this.stateRepository || typeof this.stateRepository.read !== 'function') throw invalid();
    const instance = await this.#resolveStateInstance(request.instanceId);
    const currentState = this.stateRepository.read(instance.serverPath);
    if (!currentState || (request.operationKind !== 'rollback-restore-point' &&
        (currentState.state.modpackManaged !== true || !currentState.manifest))) throw stale();
    const planned = await this.planningAdapter.createManagementPlan({ request, currentState, instance });
    const descriptors = strictObject(planned, ['plan', 'sanitizedView', 'planningSessionId']);
    const plan = descriptors.plan.value;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || typeof plan.fingerprint !== 'string' ||
        !SHA256.test(plan.fingerprint)) throw invalid();
    const operationDescriptors = strictObject(plan.operation, [
      'kind', 'serverKind', 'instanceId', 'expectedContentRevision', 'downgrade'
    ], ['kind', 'serverKind', 'instanceId', 'expectedContentRevision']);
    if (operationDescriptors.kind.value !== request.operationKind || operationDescriptors.serverKind.value !== 'existing' ||
        operationDescriptors.instanceId.value !== request.instanceId ||
        operationDescriptors.expectedContentRevision.value !== currentState.state.contentRevision ||
        (operationDescriptors.downgrade && operationDescriptors.downgrade.value !== false)) throw stale();
    if (request.operationKind === 'rollback-restore-point' &&
        (!Array.isArray(plan.restorePoints) || !plan.restorePoints.some(point =>
          point && typeof point === 'object' && point.id === request.selectionRef))) throw stale();
    const created = this.planRegistry.create({
      plan,
      sanitizedView: descriptors.sanitizedView.value,
      fingerprint: plan.fingerprint,
      planningSessionId: assertIdentifier(descriptors.planningSessionId.value)
    });
    return deepFreeze({
      planId: created.planId,
      planFingerprint: created.fingerprint,
      planView: created.planView,
      expiresAt: created.expiresAt
    });
  }

  async getJob(jobId) {
    let normalized;
    try { normalized = assertIdentifier(jobId); }
    catch (error) { throw stale(error); }
    const job = await this.operationStore.get(normalized);
    if (!job) throw stale();
    return job;
  }

  async cancelJob(jobId) {
    const existing = await this.getJob(jobId);
    const cancelledJob = await this.operationStore.requestCancellation(existing.jobId);
    this.activeOperations.get(existing.jobId)?.abort();
    return cancelledJob;
  }

  async getState(instanceIdValue) {
    const instanceId = assertIdentifier(instanceIdValue);
    const resolved = await this.#resolveStateInstance(instanceId);
    if (!this.stateRepository || typeof this.stateRepository.read !== 'function') throw invalid();
    const current = this.stateRepository.read(resolved.serverPath);
    if (!current) {
      return deepFreeze({
        type: 'modpack-state',
        instanceId,
        modpackManaged: false,
        lifecycleMode: 'unmanaged',
        source: null,
        runtime: null,
        selectedOptionalFiles: [],
        installedAt: null,
        contentRevision: null,
        managedFileCount: '0'
      });
    }
    const managedFileCount = current.manifest
      ? current.manifest.entries.filter(entry =>
        ['pack', 'runtime'].includes(entry.origin) && entry.managementPolicy === 'replaceable-managed').length
      : 0;
    return deepFreeze({
      type: 'modpack-state',
      instanceId,
      modpackManaged: current.state.modpackManaged,
      lifecycleMode: current.state.lifecycleMode || (current.state.modpackManaged ? 'managed' : 'detached'),
      source: publicSource(current.state.source),
      runtime: current.state.runtime ? clone(current.state.runtime) : null,
      selectedOptionalFiles: [...current.state.selectedOptionalFiles],
      installedAt: current.state.installedAt,
      contentRevision: current.state.contentRevision,
      managedFileCount: String(managedFileCount)
    });
  }

  async listHistory(instanceIdValue, optionsValue = {}) {
    const instanceId = assertIdentifier(instanceIdValue);
    const descriptors = strictObject(optionsValue, ['cursor', 'limit'], []);
    const cursor = descriptors.cursor?.value ?? null;
    const limit = descriptors.limit?.value ?? 50;
    if ((cursor !== null && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 512)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid();
    const resolved = await this.#resolveStateInstance(instanceId);
    if (!this.stateRepository || typeof this.stateRepository.listHistory !== 'function') throw invalid();
    const page = this.stateRepository.listHistory(resolved.serverPath, { cursor, limit });
    return deepFreeze({
      instanceId,
      items: page.items.map(publicHistoryEntry),
      nextCursor: page.nextCursor
    });
  }

  async verify(instanceIdValue) {
    const instanceId = assertIdentifier(instanceIdValue);
    this.#assertVerificationDependencies();
    const queued = await this.operationStore.create({
      operationKind: 'verify',
      serverId: instanceId,
      planFingerprint: null
    });
    const controller = new AbortController();
    this.activeOperations.set(queued.jobId, controller);
    Promise.resolve().then(() => this.#executeVerification({
      jobId: queued.jobId,
      instanceId,
      signal: controller.signal
    })).catch(() => {}).finally(() => {
      if (this.activeOperations.get(queued.jobId) === controller) this.activeOperations.delete(queued.jobId);
    });
    return queued;
  }

  async startOperation(request) {
    this.#assertMutationDependencies();
    const descriptors = strictObject(request, ['planId', 'planFingerprint', 'choices']);
    const planId = assertIdentifier(descriptors.planId.value);
    const planFingerprint = descriptors.planFingerprint.value;
    if (typeof planFingerprint !== 'string' || !SHA256.test(planFingerprint)) throw invalid();
    const choices = executionChoices(descriptors.choices.value);

    let claimed = null;
    try {
      claimed = this.planRegistry.claim({ planId, fingerprint: planFingerprint });
      if (!claimed || claimed.planId !== planId || claimed.fingerprint !== planFingerprint ||
          typeof claimed.jobId !== 'string' || !IDENTIFIER.test(claimed.jobId)) throw stale();
      const operationKind = mutationOperationKind(claimed.plan);
      const selectedRestorePoint = operationKind === 'downgrade'
        ? compatibleDowngradeRestorePoint(claimed.plan, choices)
        : operationKind === 'rollback-restore-point'
          ? selectedPinnedRestorePoint(claimed.plan, choices)
          : null;
      if (operationKind === 'downgrade' && !selectedRestorePoint) throw stale();
      if (operationKind === 'rollback-restore-point' && !selectedRestorePoint) throw stale();
      if (operationKind !== 'downgrade' && choices.restorePointId !== null && operationKind !== 'rollback-restore-point') throw invalid();

      const queued = await this.operationStore.create({
        jobId: claimed.jobId,
        operationKind,
        serverId: claimed.plan.operation.instanceId,
        planFingerprint
      });
      const controller = new AbortController();
      this.activeOperations.set(claimed.jobId, controller);
      Promise.resolve().then(() => this.#executeOperation({
        claimed,
        choices,
        operationKind,
        selectedRestorePoint,
        signal: controller.signal
      })).catch(() => {}).finally(() => {
        if (this.activeOperations.get(claimed.jobId) === controller) this.activeOperations.delete(claimed.jobId);
      });
      return queued;
    } catch (error) {
      if (claimed) {
        try { this.#releaseClaim(claimed.jobId); }
        catch (releaseError) { throw recoveryRequired(releaseError); }
      }
      throw error;
    }
  }

  #assertMutationDependencies() {
    if (!this.mutationCoordinator || typeof this.mutationCoordinator.runMutation !== 'function' ||
        !this.mutationRuntime || MUTATION_RUNTIME_METHODS.some(method => typeof this.mutationRuntime[method] !== 'function') ||
        typeof this.operationStore.create !== 'function' || typeof this.operationStore.transition !== 'function' ||
        typeof this.planRegistry.releaseClaim !== 'function') throw invalid();
  }

  #assertVerificationDependencies() {
    if (!this.instanceResolver || typeof this.instanceResolver.resolveInstance !== 'function' ||
        !this.stateRepository || typeof this.stateRepository.verifyManagedFiles !== 'function' ||
        typeof this.operationStore.create !== 'function' || typeof this.operationStore.transition !== 'function') throw invalid();
  }

  async #resolveStateInstance(instanceId) {
    if (!this.instanceResolver || typeof this.instanceResolver.resolveInstance !== 'function') throw invalid();
    const resolved = assertResolvedInstance(await this.instanceResolver.resolveInstance(instanceId), instanceId);
    return { instanceId, serverPath: resolved.serverPath };
  }

  async #emitStateChanged(instanceId) {
    if (this.stateEventSink === null) return;
    try {
      const state = await this.getState(instanceId);
      await this.stateEventSink(state);
    } catch {
      // Durable state is authoritative; event delivery must not invalidate a committed transaction.
    }
  }

  async #executeVerification({ jobId, instanceId, signal }) {
    try {
      await this.#transition(jobId, 'verifying', 10, 'Verifying managed files', signal);
      const resolved = assertResolvedInstance(await this.instanceResolver.resolveInstance(instanceId), instanceId);
      await this.#throwIfCancelled(jobId, signal);
      const result = await this.stateRepository.verifyManagedFiles(resolved.serverPath);
      const outcome = await this.#withIssuedActions({
        status: 'completed',
        message: result.healthy ? 'All managed files match the installed manifest' : 'Managed file differences were found',
        operationKind: 'verify',
        result: { instanceId, ...result }
      }, {
        jobId,
        operationKind: 'verify',
        instanceId,
        phase: 'completed',
        status: 'completed',
        errorCode: null,
        plan: null,
        restorePointId: null,
        automaticRecovery: false
      });
      await this.#transition(jobId, 'completed', 100, 'Managed files verified', signal, outcome);
    } catch (error) {
      const job = await this.operationStore.get(jobId).catch(() => null);
      if (!job || TERMINAL_JOB_PHASES.has(job.phase)) return;
      const wasCancelled = job.phase === 'cancelling' || error?.code === 'CANCELLED';
      let current = job;
      if (wasCancelled && current.phase !== 'cancelling') {
        current = await this.operationStore.requestCancellation(jobId);
      }
      const terminalPhase = wasCancelled ? 'cancelled' : 'failed';
      const errorCode = safeErrorCode(error);
      const outcome = await this.#withIssuedActions({
        status: terminalPhase,
        message: wasCancelled ? 'Verification was cancelled' : 'Managed file verification failed',
        errorCode
      }, {
        jobId,
        operationKind: 'verify',
        instanceId,
        phase: terminalPhase,
        status: terminalPhase,
        errorCode,
        plan: null,
        restorePointId: null,
        automaticRecovery: false
      });
      await this.operationStore.transition(jobId, {
        expectedPhase: current.phase,
        nextPhase: terminalPhase,
        patch: {
          outcome
        }
      });
    }
  }

  #releaseClaim(jobId) {
    if (this.releasedClaims.has(jobId)) return true;
    if (this.planRegistry.releaseClaim(jobId) !== true) throw recoveryRequired();
    this.releasedClaims.add(jobId);
    return true;
  }

  async #executeOperation(context) {
    const { claimed, choices, operationKind, signal } = context;
    let resolved = null;
    let restartToken = null;
    const state = { candidateBuilt: false, commitStarted: false, committedHealthy: false, restorePoint: null };
    try {
      await this.#throwIfCancelled(claimed.jobId, signal);
      resolved = assertResolvedInstance(await this.mutationRuntime.resolveInstance({
        jobId: claimed.jobId,
        plan: claimed.plan,
        choices,
        signal
      }), claimed.plan.operation.instanceId);
      await this.#transition(claimed.jobId, 'preflight', 5, 'Revalidating the reviewed plan', signal);
      const selector = { instanceId: resolved.instanceId, serverPath: resolved.serverPath };
      await this.mutationCoordinator.runMutation(selector, {
        operation: operationKind,
        operationId: claimed.jobId,
        revisionMode: 'lifecycle',
        signal,
        quiesce: async quiesceContext => {
          restartToken = await this.mutationRuntime.suspendAutoRestart({
            ...quiesceContext,
            jobId: claimed.jobId,
            plan: claimed.plan,
            resolved
          });
          await this.mutationRuntime.quiesce({
            ...quiesceContext,
            jobId: claimed.jobId,
            plan: claimed.plan,
            resolved,
            restartToken
          });
        }
      }, async lease => {
        try {
          await this.#executeUnderLease({ ...context, lease, resolved, restartToken, state });
        } catch (error) {
          await this.#handleFailure({ ...context, lease, resolved, restartToken, state, error });
          throw error;
        }
      });
    } catch (error) {
      const job = await this.operationStore.get(claimed.jobId).catch(() => null);
      if (job && (TERMINAL_JOB_PHASES.has(job.phase) || job.phase === 'cleanup-pending')) return;
      await this.#handleFailure({ ...context, lease: null, resolved, restartToken, state, error }).catch(() => {});
    }
  }

  async #executeUnderLease(context) {
    const { claimed, choices, operationKind, selectedRestorePoint, signal, lease, resolved, restartToken, state } = context;
    await this.#throwIfCancelled(claimed.jobId, signal);
    await this.mutationRuntime.revalidate({
      jobId: claimed.jobId,
      plan: claimed.plan,
      choices,
      selectedRestorePoint,
      resolved,
      lease,
      signal
    });
    await this.#throwIfCancelled(claimed.jobId, signal);

    const existing = !['install-new', 'import-files-only-new'].includes(operationKind);
    const requiresRuntimeValidation = operationKind !== 'import-files-only-new' &&
      !(operationKind === 'uninstall-managed' && claimed.plan.ownership.confirmation.possibleNonRunnable);
    const requiresCommitFinalizationWithoutHealth = operationKind === 'import-files-only-new' ||
      (operationKind === 'uninstall-managed' && claimed.plan.ownership.confirmation.possibleNonRunnable);
    let restorePoint = selectedRestorePoint;
    if (existing) {
      await this.#transition(claimed.jobId, 'snapshotting', 15, 'Creating a verified restore point', signal);
      restorePoint = await this.mutationRuntime.createRestorePoint({
        jobId: claimed.jobId,
        plan: claimed.plan,
        choices,
        selectedRestorePoint,
        resolved,
        lease,
        signal
      });
      state.restorePoint = restorePoint;
      await this.#throwIfCancelled(claimed.jobId, signal);
    }

    await this.#transition(claimed.jobId, 'staging', 35, 'Building the server candidate', signal);
    const candidate = await this.mutationRuntime.buildCandidate({
      jobId: claimed.jobId,
      operationKind,
      plan: claimed.plan,
      choices,
      restorePoint,
      resolved,
      lease,
      signal
    });
    state.candidateBuilt = true;
    await this.#throwIfCancelled(claimed.jobId, signal);
    if (requiresRuntimeValidation) {
      await this.#transition(claimed.jobId, 'validating-candidate', 50, 'Validating the server candidate', signal);
      await this.mutationRuntime.validateCandidate({
        jobId: claimed.jobId,
        operationKind,
        plan: claimed.plan,
        choices,
        candidate,
        resolved,
        lease,
        signal
      });
      await this.#throwIfCancelled(claimed.jobId, signal);
    }

    await this.#transition(claimed.jobId, 'committing', 65, 'Committing the reviewed changes', signal);
    state.commitStarted = true;
    lease.markDirty();
    let committed;
    if (!existing) {
      await this.#transition(claimed.jobId, 'publishing', 70, 'Publishing the new server', null);
      committed = await this.mutationRuntime.publishCandidate({
        jobId: claimed.jobId, plan: claimed.plan, choices, candidate, resolved, lease
      });
      await this.#transition(claimed.jobId, 'published', 75, 'New server published', null);
      await this.#transition(claimed.jobId, 'registering', 80, 'Registering the new server', null);
      await this.mutationRuntime.registerPublishedInstance({
        jobId: claimed.jobId, plan: claimed.plan, choices, committed, resolved, lease
      });
    } else {
      committed = await this.mutationRuntime.commitCandidate({
        jobId: claimed.jobId,
        operationKind,
        plan: claimed.plan,
        choices,
        candidate,
        restorePoint,
        resolved,
        lease
      });
    }

    const shouldRun = requiresRuntimeValidation && (resolved.priorRunning || choices.startAfterInstall);
    if (shouldRun) {
      await this.#transition(claimed.jobId, 'starting', 85, 'Starting the committed server', null);
      await this.mutationRuntime.startFinal({
        jobId: claimed.jobId, plan: claimed.plan, choices, committed, resolved, lease
      });
    }
    let validation = {
      skipped: true,
      reason: operationKind === 'uninstall-managed' ? 'unmanaged-files-only' : 'files-only'
    };
    if (requiresRuntimeValidation || requiresCommitFinalizationWithoutHealth) {
      await this.#transition(
        claimed.jobId,
        'validating-live',
        90,
        requiresRuntimeValidation ? 'Validating the committed server' : 'Finalizing the files-only server state',
        null
      );
      validation = await this.mutationRuntime.validateLive({
        jobId: claimed.jobId,
        operationKind,
        plan: claimed.plan,
        choices,
        committed,
        resolved,
        running: shouldRun,
        lease
      });
      // validateLive is the durable commit boundary: production runtimes have
      // already marked recovery committed-healthy and published the revision.
      // From this point onward, side-effect failures must be reconciled as
      // cleanup-pending and must never roll the canonical server back.
      state.committedHealthy = true;
      await this.#transition(claimed.jobId, 'committed-healthy', 95, 'Committed server is healthy', null);
    } else if (existing) {
      await this.#transition(claimed.jobId, 'validating-live', 90, 'Recording the unmanaged files-only outcome', null);
    }
    await this.mutationRuntime.persistOutcome({
      jobId: claimed.jobId,
      operationKind,
      plan: claimed.plan,
      choices,
      committed,
      restorePoint,
      validation,
      resolved,
      running: shouldRun,
      lease
    });
    await this.#emitStateChanged(resolved.instanceId);
    if (!state.committedHealthy) {
      await this.#transition(claimed.jobId, 'committed-healthy', 95, 'Committed server is healthy', null);
      state.committedHealthy = true;
    }
    await this.mutationRuntime.restorePriorState({
      jobId: claimed.jobId,
      plan: claimed.plan,
      resolved,
      restartToken,
      running: shouldRun,
      lease
    });
    await this.#transition(claimed.jobId, 'cleanup', 98, 'Cleaning temporary files', null);
    await this.mutationRuntime.cleanup({
      jobId: claimed.jobId, operationKind, plan: claimed.plan, committed, resolved, lease
    });
    this.#releaseClaim(claimed.jobId);
    const completedOutcome = await this.#withIssuedActions({
      status: 'completed',
      message: 'The modpack operation completed successfully',
      operationKind
    }, {
      jobId: claimed.jobId,
      operationKind,
      instanceId: resolved.instanceId,
      phase: 'completed',
      status: 'completed',
      errorCode: null,
      plan: claimed.plan,
      restorePointId: restorePoint?.id || null,
      automaticRecovery: false
    });
    await this.#transition(claimed.jobId, 'completed', 100, 'Modpack operation completed', null, completedOutcome);
  }

  async #handleFailure(context) {
    const { claimed, operationKind, plan, choices, selectedRestorePoint, lease, resolved, restartToken, state, error } = {
      plan: context.claimed.plan,
      ...context
    };
    let job = await this.operationStore.get(claimed.jobId);
    if (!job || TERMINAL_JOB_PHASES.has(job.phase) || job.phase === 'cleanup-pending') return;

    if (!state.committedHealthy && state.commitStarted && resolved &&
        typeof this.mutationRuntime.isDurablyCommitted === 'function') {
      try {
        state.committedHealthy = await this.mutationRuntime.isDurablyCommitted({
          jobId: claimed.jobId,
          plan,
          resolved
        }) === true;
      } catch {
        // The normal rollback path remains authoritative unless a durable
        // committed recovery record can be positively identified.
      }
    }

    if (state.committedHealthy || ['committed-healthy', 'cleanup'].includes(job.phase)) {
      if (state.committedHealthy && job.phase === 'registering') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'registering', nextPhase: 'committed-healthy', patch: {}
        });
      } else if (state.committedHealthy && job.phase === 'starting') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'starting', nextPhase: 'validating-live', patch: {}
        });
      }
      if (state.committedHealthy && job.phase === 'validating-live') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'validating-live', nextPhase: 'committed-healthy', patch: {}
        });
      }
      if (job.phase === 'committed-healthy') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'committed-healthy', nextPhase: 'cleanup-pending', patch: {}
        });
      } else if (job.phase === 'cleanup') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'cleanup', nextPhase: 'cleanup-pending', patch: {}
        });
      }
      return job;
    }

    if (!state.commitStarted) {
      let cleanupError = null;
      if (state.candidateBuilt && resolved) {
        try {
          await this.mutationRuntime.abandonCandidate({
            jobId: claimed.jobId, operationKind, plan, choices, resolved, lease, error
          });
        } catch (candidateError) {
          cleanupError = candidateError;
        }
      }
      if (restartToken !== null && resolved) {
        try {
          await this.mutationRuntime.restorePriorState({
            jobId: claimed.jobId, plan, resolved, restartToken, running: resolved.priorRunning, lease
          });
        } catch (policyError) {
          cleanupError ||= policyError;
        }
      }
      try { this.#releaseClaim(claimed.jobId); }
      catch (releaseError) { cleanupError ||= releaseError; }
      job = await this.operationStore.get(claimed.jobId);
      const wasCancelled = job.phase === 'cancelling' || error?.code === 'CANCELLED';
      if (wasCancelled && job.phase !== 'cancelling') {
        job = await this.operationStore.requestCancellation(claimed.jobId);
      }
      const terminalPhase = wasCancelled ? 'cancelled' : 'failed';
      const errorCode = safeErrorCode(cleanupError || error);
      const outcome = await this.#withIssuedActions({
        status: terminalPhase,
        message: wasCancelled ? 'The operation was cancelled before the server changed' : 'The operation failed before the server changed',
        errorCode,
        cleanupPending: cleanupError !== null,
        ...(hasVerifiedRetainedArtifact(plan) ? { retainedDownload: true } : {})
      }, {
        jobId: claimed.jobId,
        operationKind,
        instanceId: claimed.plan.operation.instanceId,
        phase: terminalPhase,
        status: terminalPhase,
        errorCode,
        plan,
        restorePointId: state.restorePoint?.id || selectedRestorePoint?.id || null,
        automaticRecovery: false
      });
      return this.operationStore.transition(claimed.jobId, {
        expectedPhase: job.phase,
        nextPhase: terminalPhase,
        patch: {
          outcome
        }
      });
    }

    try {
      if (job.phase !== 'rolling-back') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: job.phase,
          nextPhase: 'rolling-back',
          patch: {}
        });
      }
      await this.mutationRuntime.rollback({
        jobId: claimed.jobId,
        operationKind,
        plan,
        choices,
        selectedRestorePoint,
        resolved,
        restartToken,
        lease,
        error
      });
      if (restartToken !== null && resolved) {
        await this.mutationRuntime.restorePriorState({
          jobId: claimed.jobId, plan, resolved, restartToken, running: resolved.priorRunning, lease
        });
      }
      this.#releaseClaim(claimed.jobId);
      const errorCode = safeErrorCode(error);
      const outcome = await this.#withIssuedActions({
        status: 'rolled-back',
        message: 'The original server was restored after the operation failed',
        errorCode
      }, {
        jobId: claimed.jobId,
        operationKind,
        instanceId: claimed.plan.operation.instanceId,
        phase: 'rolled-back',
        status: 'rolled-back',
        errorCode,
        plan,
        restorePointId: state.restorePoint?.id || selectedRestorePoint?.id || null,
        automaticRecovery: false
      });
      return this.operationStore.transition(claimed.jobId, {
        expectedPhase: 'rolling-back',
        nextPhase: 'rolled-back',
        patch: {
          outcome
        }
      });
    } catch (rollbackError) {
      const latest = await this.operationStore.get(claimed.jobId);
      if (!latest || TERMINAL_JOB_PHASES.has(latest.phase)) return latest;
      const phase = latest.phase === 'rolling-back' ? latest.phase : job.phase;
      const errorCode = safeErrorCode(rollbackError);
      const outcome = await this.#withIssuedActions({
        status: 'recovery-required',
        message: 'The server needs recovery before it can be used',
        errorCode,
        automatic: false
      }, {
        jobId: claimed.jobId,
        operationKind,
        instanceId: claimed.plan.operation.instanceId,
        phase: 'recovery-required',
        status: 'recovery-required',
        errorCode,
        plan,
        restorePointId: state.restorePoint?.id || selectedRestorePoint?.id || null,
        automaticRecovery: false
      });
      return this.operationStore.transition(claimed.jobId, {
        expectedPhase: phase,
        nextPhase: 'recovery-required',
        patch: {
          outcome
        }
      });
    }
  }

  async #throwIfCancelled(jobId, signal) {
    if (signal?.aborted) throw cancelled();
    const job = await this.operationStore.get(jobId);
    if (!job || job.phase === 'cancelling' || job.cancellationRequested) throw cancelled();
  }

  async #withIssuedActions(outcome, context) {
    if (this.outcomeActionIssuer === null) return outcome;
    try {
      const actions = normalizeIssuedActions(await this.outcomeActionIssuer.issue(deepFreeze({ ...context })));
      return { ...outcome, actions };
    } catch {
      return { ...outcome, actions: [], actionIssuanceFailed: true };
    }
  }

  async #transition(jobId, nextPhase, percent, message, signal, outcome = null) {
    if (signal) await this.#throwIfCancelled(jobId, signal);
    const current = await this.operationStore.get(jobId);
    if (!current) throw stale();
    if (current.phase === 'cancelling') throw cancelled();
    const patch = outcome === null
      ? { progress: { percent, message, currentItem: null } }
      : { progress: { percent, message, currentItem: null }, outcome };
    return this.operationStore.transition(jobId, {
      expectedPhase: current.phase,
      nextPhase,
      patch
    });
  }
}

module.exports = { ModpackLifecycleService };
