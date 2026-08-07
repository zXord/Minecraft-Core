const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { prepareManagedServerRuntime } = require('../loader-install-service.cjs');
const { ServerHealthValidator } = require('../server-health-validator.cjs');
const { ServerJavaManager } = require('../server-java-manager.cjs');
const { getDefaultServerConfig, readServerConfig } = require('../../utils/config-manager.cjs');
const instanceContext = require('../../utils/instance-context.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { ReleaseTrackingReconciler } = require('../modpacks/notifications/release-tracking-reconciler.cjs');
const { canonicalPath } = require('../modpacks/planning/ownership-planner.cjs');
const {
  copyRegularFile,
  copyTree,
  scanManifest
} = require('../modpacks/planning/production-candidate-preparer.cjs');
const { assertPlanStillValid } = require('../modpacks/planning/preflight-planner.cjs');
const { computePreflightPlanFingerprint } = require('../modpacks/planning/plan-fingerprint.cjs');
const { createVerifiedRestoreExtractor } = require('./verified-restore-extractor.cjs');
const { RestorePointService } = require('./restore-point-service.cjs');
const { consumeReservedTarget } = require('./reserved-target-authority.cjs');
const { copyServerDirectoryContents, inspectServerDirectoryTree } = require('./server-directory-identity.cjs');
const {
  buildExistingCandidate,
  buildNewCandidate,
  cleanupCommittedTransaction,
  createExistingSiblingPaths,
  createSiblingPaths,
  markCommittedHealthy,
  publishNewCandidate,
  registerPublishedInstance,
  swapExistingCandidate
} = require('./server-directory-transaction.cjs');

const SOURCE_OPERATION_KINDS = new Set(['install', 'upgrade', 'downgrade', 'switch', 'repair', 'files-only']);
const MANAGEMENT_OPERATION_KINDS = new Set(['detach', 'uninstall', 'rollback-restore-point']);
const DURABLE_COMMIT_PHASES = new Set(['committed-healthy', 'cleanup', 'cleanup-pending', 'completed']);
const RUNTIME_ROOTS = new Set(['java', 'libraries', 'versions', '.fabric', '.quilt']);
const RUNTIME_FILES = new Set([
  'server.jar', 'fabric-server-launch.jar', 'quilt-server-launch.jar',
  'quilt-server-launcher.properties', 'user_jvm_args.txt',
  'run.bat', 'run.cmd', 'run.ps1', 'run.sh'
]);
const FORGE_SHIM = /^forge-[A-Za-z0-9._+-]+-[A-Za-z0-9._+-]+-shim\.jar$/i;
const EXCLUDED_MANIFEST_ROOTS = new Set(['backups', 'crash-reports', 'logs']);

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The production modpack mutation request is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reviewed modpack mutation is stale', { cause });
}

function runtimeIncomplete(cause) {
  return new ModpackError('RUNTIME_INCOMPLETE', 'The selected modpack runtime could not be prepared', { cause });
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function nowDate(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid();
  return date;
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function sourceForState(source, artifactSetDigest = null) {
  if (!source || typeof source !== 'object') throw stale();
  const common = { provider: source.provider, version: source.version, title: source.title || 'Modpack' };
  if (source.provider === 'modrinth') {
    return {
      ...common,
      projectId: source.projectId,
      versionId: source.versionId,
      ...(artifactSetDigest ? { artifactSetDigest } : {}),
      ...(source.acceptedMapping ? { acceptedMapping: source.acceptedMapping } : {})
    };
  }
  if (source.provider === 'github') {
    return {
      ...common,
      repositoryId: source.repositoryId,
      releaseId: source.releaseId,
      githubOwner: source.githubOwner,
      githubRepo: source.githubRepo,
      ...(Array.isArray(source.selectedAssetIds) && source.selectedAssetIds.length > 0
        ? { selectedAssetIds: [...new Set(source.selectedAssetIds)].sort((left, right) => left.localeCompare(right, 'en-US')) }
        : {}),
      ...(artifactSetDigest ? { artifactSetDigest } : {}),
      ...(source.assetPattern ? { assetPattern: source.assetPattern } : {}),
      ...(source.acceptedMapping ? { acceptedMapping: source.acceptedMapping } : {})
    };
  }
  if (source.provider === 'local') {
    return {
      ...common,
      importId: source.importId,
      artifactSha256: source.artifactSha256
    };
  }
  throw stale();
}

function runtimeOwnership(relativePath, runtimePathKeys = null) {
  const key = relativePath.toLocaleLowerCase('en-US');
  const first = key.split('/')[0];
  if (!runtimePathKeys?.has(key) && !RUNTIME_ROOTS.has(first) && !RUNTIME_FILES.has(key) && !FORGE_SHIM.test(relativePath)) {
    return null;
  }
  const role = ['java', 'libraries', 'versions'].includes(first)
    ? 'library'
    : RUNTIME_FILES.has(key) && key.endsWith('.jar')
      ? 'server'
      : 'runtime';
  return { origin: 'runtime', managementPolicy: 'replaceable-managed', role };
}

function isManifestExcluded(pathKey) {
  const first = pathKey.split('/')[0];
  return pathKey === 'eula.txt' || EXCLUDED_MANIFEST_ROOTS.has(first);
}

async function scanCandidateManifest({
  candidatePath,
  installationId,
  incomingManifest,
  oldManifest = null,
  ownershipPlan = null,
  runtimePathKeys = null,
  reparseInspector,
  signal
} = {}) {
  const scanned = await scanManifest(candidatePath, installationId, { reparseInspector, signal });
  const incoming = new Map((incomingManifest?.entries || []).map(entry => [entry.pathKey, entry]));
  const old = new Map((oldManifest?.entries || []).map(entry => [entry.pathKey, entry]));
  const actions = new Map((ownershipPlan?.actions || []).map(entry => [entry.pathKey, entry]));
  const entries = [];
  for (const measured of scanned.manifest.entries) {
    if (isManifestExcluded(measured.pathKey)) continue;
    const runtime = runtimeOwnership(measured.path, runtimePathKeys);
    const incomingEntry = incoming.get(measured.pathKey);
    const oldEntry = old.get(measured.pathKey);
    const action = actions.get(measured.pathKey);
    if (runtime) {
      entries.push({ ...measured, ...runtime, priorBaseline: null });
    } else if (incomingEntry && !['preserve-modified', 'preserve-orphan'].includes(action?.action)) {
      entries.push({
        ...incomingEntry,
        path: measured.path,
        pathKey: measured.pathKey,
        installedHash: measured.installedHash,
        size: measured.size
      });
    } else if (oldEntry && ['unchanged', 'preserve-modified', 'preserve-orphan', 'absent'].includes(action?.action)) {
      const preservedByUser = ['preserve-modified', 'preserve-orphan'].includes(action?.action) ||
        measured.installedHash !== oldEntry.installedHash;
      entries.push({
        ...oldEntry,
        path: measured.path,
        pathKey: measured.pathKey,
        origin: preservedByUser ? 'user' : oldEntry.origin,
        managementPolicy: preservedByUser ? 'protected' : oldEntry.managementPolicy,
        installedHash: measured.installedHash,
        size: measured.size,
        priorBaseline: preservedByUser ? oldEntry.installedHash : oldEntry.priorBaseline
      });
    } else {
      entries.push({
        ...measured,
        origin: 'user',
        managementPolicy: 'protected',
        role: measured.role === 'world' ? 'world' : 'other',
        priorBaseline: null
      });
    }
  }
  entries.sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  return deepFreeze({ schemaVersion: 1, installationId, entries });
}

function exactIncomingManifest(left, right) {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw stale();
  return left;
}

function operationKindForRecord(plan) {
  if (plan.operation.kind === 'files-only') return 'import';
  if (plan.operation.kind === 'rollback-restore-point') return 'rollback';
  return plan.operation.kind;
}

function transactionOperationKind(operationKind) {
  if (operationKind === 'install-new' || operationKind === 'install-existing') return 'install';
  if (operationKind === 'update') return 'upgrade';
  if (operationKind === 'rollback-restore-point') return 'rollback';
  if (operationKind === 'import-files-only-new') return 'import';
  if (operationKind === 'uninstall-managed') return 'uninstall';
  return operationKind;
}

function historyKind(operationKind) {
  if (operationKind === 'install-new' || operationKind === 'install-existing') return 'install';
  if (operationKind === 'update') return 'upgrade';
  if (operationKind === 'rollback-restore-point') return 'rollback';
  if (operationKind === 'import-files-only-new') return 'import-files-only';
  if (operationKind === 'uninstall-managed') return 'uninstall';
  return operationKind;
}

function defaultRevisionPublisher() {
  const published = new Set();
  return Object.freeze({
    async publishOnce(event) {
      if (published.has(event.eventId)) return { published: true, duplicate: true };
      require('../../utils/event-bus.cjs').emit('server-content-revision-changed', Object.freeze({ ...event }));
      published.add(event.eventId);
      return { published: true, duplicate: false };
    }
  });
}

class ProductionMutationRuntime {
  constructor({
    availableBytes = null,
    buildExistingCandidateFn = buildExistingCandidate,
    buildNewCandidateFn = buildNewCandidate,
    cleanupCommittedTransactionFn = cleanupCommittedTransaction,
    clock = () => new Date(),
    consumeReservedTargetFn = consumeReservedTarget,
    coordinator,
    destinationReservations,
    durableFsFactory,
    fsApi = fs,
    healthTimeoutMs = 180_000,
    healthValidator = null,
    instanceContext: suppliedInstanceContext = instanceContext,
    instanceResolver,
    javaManagerFactory = (serverPath, options) => new ServerJavaManager(serverPath, options),
    markCommittedHealthyFn = markCommittedHealthy,
    planValidator = assertPlanStillValid,
    planningAdapter,
    prepareRuntime = prepareManagedServerRuntime,
    publishNewCandidateFn = publishNewCandidate,
    randomUUID = () => require('node:crypto').randomUUID(),
    recoveryServices,
    registerPublishedInstanceFn = registerPublishedInstance,
    releaseTrackingStore,
    reparseInspector,
    restorePointServiceFactory = null,
    revisionPublisher = null,
    snapshotServer = null,
    stateRepository,
    store,
    swapExistingCandidateFn = swapExistingCandidate,
    userDataPath,
    workspaceRegistry
  } = {}) {
    const registry = recoveryServices?.registry;
    const recoveryService = recoveryServices?.recoveryService;
    const runtimePolicy = recoveryServices?.runtimePolicy;
    if (typeof clock !== 'function' ||
        (!healthValidator && !recoveryServices?.healthValidator && !coordinator) || !destinationReservations ||
        typeof destinationReservations.resolve !== 'function' || typeof destinationReservations.consume !== 'function' ||
        typeof destinationReservations.release !== 'function' ||
        typeof durableFsFactory !== 'function' || !fsApi || !instanceResolver ||
        typeof instanceResolver.resolveInstance !== 'function' || typeof planValidator !== 'function' ||
        !planningAdapter || typeof planningAdapter.getExecutionRecord !== 'function' || typeof prepareRuntime !== 'function' ||
        !registry || ['create', 'load', 'transition', 'finish'].some(method => typeof registry[method] !== 'function') ||
        !recoveryService || ['recoverWithLease', 'rollbackWithLease', 'failNewWithLease'].some(method => typeof recoveryService[method] !== 'function') ||
        !runtimePolicy || ['suspend', 'ensureStopped', 'adoptValidatedHandoff', 'restoreAutoRestart'].some(method => typeof runtimePolicy[method] !== 'function') ||
        !releaseTrackingStore || ['list', 'remove', 'upsert'].some(method => typeof releaseTrackingStore[method] !== 'function') ||
        !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
        !stateRepository || typeof stateRepository.read !== 'function' ||
        !store || typeof store.get !== 'function' || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) ||
        !workspaceRegistry || typeof workspaceRegistry.resolveOwnedWorkspace !== 'function' ||
        typeof javaManagerFactory !== 'function' || typeof consumeReservedTargetFn !== 'function' ||
        (restorePointServiceFactory !== null && typeof restorePointServiceFactory !== 'function') ||
        !Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 1 || healthTimeoutMs > 300_000) throw invalid();
    this.availableBytes = availableBytes || (async serverPath => {
      const probe = fsApi.existsSync(serverPath) ? serverPath : path.dirname(serverPath);
      const stat = fsApi.statfsSync(probe, { bigint: true });
      return (BigInt(stat.bavail) * BigInt(stat.bsize)).toString();
    });
    this.buildExistingCandidateFn = buildExistingCandidateFn;
    this.buildNewCandidateFn = buildNewCandidateFn;
    this.cleanupCommittedTransactionFn = cleanupCommittedTransactionFn;
    this.clock = clock;
    this.consumeReservedTargetFn = consumeReservedTargetFn;
    this.destinationReservations = destinationReservations;
    this.durableFsFactory = durableFsFactory;
    this.fs = fsApi;
    this.healthTimeoutMs = healthTimeoutMs;
    this.healthValidator = healthValidator || recoveryServices.healthValidator || new ServerHealthValidator({ coordinator });
    this.instanceContext = suppliedInstanceContext;
    this.instanceResolver = instanceResolver;
    this.javaManagerFactory = javaManagerFactory;
    this.markCommittedHealthyFn = markCommittedHealthyFn;
    this.planValidator = planValidator;
    this.planningAdapter = planningAdapter;
    this.prepareRuntime = prepareRuntime;
    this.publishNewCandidateFn = publishNewCandidateFn;
    this.randomUUID = randomUUID;
    this.recoveryRegistry = registry;
    this.recoveryService = recoveryService;
    this.registerPublishedInstanceFn = registerPublishedInstanceFn;
    this.releaseTrackingStore = releaseTrackingStore;
    this.releaseTrackingReconciler = recoveryServices.releaseTrackingReconciler || new ReleaseTrackingReconciler({
      trackingStore: releaseTrackingStore,
      recoveryRegistry: registry,
      clock
    });
    this.reparseInspector = reparseInspector;
    this.restorePointServiceFactory = restorePointServiceFactory;
    this.revisionPublisher = revisionPublisher || recoveryServices.revisionPublisher || defaultRevisionPublisher();
    this.runtimePolicy = runtimePolicy;
    this.snapshotServer = snapshotServer || planningAdapter.snapshotServer;
    if (typeof this.snapshotServer !== 'function') throw invalid();
    this.stateRepository = stateRepository;
    this.store = store;
    this.swapExistingCandidateFn = swapExistingCandidateFn;
    this.userDataPath = path.resolve(userDataPath);
    this.workspaceRegistry = workspaceRegistry;
    this.contexts = new Map();
    this.restartTokens = new Map();
    this.restoredRestartTokens = new WeakMap();
    this.restoreServices = new Map();
  }

  async resolveInstance({ jobId, plan } = {}) {
    if (typeof jobId !== 'string' || plan?.operation?.instanceId === undefined) throw invalid();
    const resolved = await this.instanceResolver.resolveInstance(plan.operation.instanceId);
    if (!resolved || resolved.instanceId !== plan.operation.instanceId || typeof resolved.serverPath !== 'string' ||
        typeof resolved.priorRunning !== 'boolean') throw stale();
    return deepFreeze({
      instanceId: resolved.instanceId,
      serverPath: path.resolve(resolved.serverPath),
      priorRunning: resolved.priorRunning
    });
  }

  async suspendAutoRestart({ jobId, plan, resolved } = {}) {
    if (plan?.operation?.serverKind === 'new') {
      const token = deepFreeze({ held: false, newServer: true, enabled: false, operationId: jobId, serverPath: resolved.serverPath });
      this.restartTokens.set(jobId, token);
      return token;
    }
    const config = readServerConfig(resolved.serverPath, getDefaultServerConfig()) || getDefaultServerConfig();
    const hold = await this.runtimePolicy.suspend({
      instanceId: resolved.instanceId,
      jobId,
      operationId: jobId,
      serverPath: resolved.serverPath
    });
    if (!hold || hold.held !== true) throw invalid();
    const token = deepFreeze({
      ...hold,
      newServer: false,
      enabled: config.autoRestart?.enabled === true,
      operationId: jobId,
      serverPath: resolved.serverPath
    });
    this.restartTokens.set(jobId, token);
    return token;
  }

  async quiesce({ jobId, resolved, restartToken, signal } = {}) {
    if (signal?.aborted) throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
    const token = restartToken || this.restartTokens.get(jobId);
    if (token?.newServer) return deepFreeze({ alreadyStopped: true });
    return this.runtimePolicy.ensureStopped({
      instanceId: resolved.instanceId,
      jobId,
      operationId: jobId,
      serverPath: resolved.serverPath
    });
  }

  async revalidate({ jobId, plan, choices, selectedRestorePoint, resolved, lease, signal } = {}) {
    const management = plan?.type === 'modpack-management-plan';
    const allowedOperation = management
      ? MANAGEMENT_OPERATION_KINDS.has(plan?.operation?.kind)
      : SOURCE_OPERATION_KINDS.has(plan?.operation?.kind);
    if (!plan?.operation || !allowedOperation || !['new', 'existing'].includes(plan.operation.serverKind) ||
        (management && plan.operation.serverKind !== 'existing') ||
        plan.operation.instanceId !== resolved?.instanceId) throw invalid();
    const expectedPath = plan.operation.serverKind === 'new'
      ? this.destinationReservations.resolve(resolved.instanceId)?.targetPath || resolved.serverPath
      : resolved.serverPath;
    if (!samePath(resolved.serverPath, expectedPath)) throw invalid();
    if (!lease || lease.kind !== 'mutation' || lease.instanceId !== resolved.instanceId ||
        !samePath(lease.serverPath, resolved.serverPath)) throw invalid();
    const executionRecord = this.planningAdapter.getExecutionRecord(plan);
    if (!executionRecord || executionRecord.serverKind !== plan.operation.serverKind ||
        !samePath(executionRecord.serverPath, resolved.serverPath)) throw stale();
    let template = null;
    if (management) {
      if (executionRecord.operationKind !== plan.operation.kind ||
          typeof executionRecord.execution?.managementOutputId !== 'string') throw stale();
      this.workspaceRegistry.resolveOwnedWorkspace({
        ownerId: jobId,
        id: executionRecord.execution.managementOutputId,
        kind: 'output'
      });
      if (plan.operation.kind === 'rollback-restore-point') {
        const planned = plan.restorePoints?.[0];
        const privatePoint = executionRecord.selectedRestorePoint;
        if (!planned || !privatePoint || privatePoint.id !== planned.id || privatePoint.sha256 !== planned.sha256 ||
            !samePath(privatePoint.serverPath, resolved.serverPath) || selectedRestorePoint?.id !== planned.id ||
            choices?.restorePointId !== planned.id) throw stale();
      } else if (executionRecord.selectedRestorePoint !== null || selectedRestorePoint) {
        throw stale();
      }
    } else {
      if (!executionRecord.incomingManifest || typeof executionRecord.execution?.templateOutputId !== 'string') throw stale();
      template = this.workspaceRegistry.resolveOwnedWorkspace({
        ownerId: jobId,
        id: executionRecord.execution.templateOutputId,
        kind: 'output'
      });
      const expectedTemplateManifest = plan.operation.kind === 'repair'
        ? executionRecord.execution.repairPayloadManifest
        : executionRecord.incomingManifest;
      if (!expectedTemplateManifest) throw stale();
      const rescanned = await scanManifest(template.path, expectedTemplateManifest.installationId, {
        reparseInspector: this.reparseInspector,
        signal
      });
      exactIncomingManifest(rescanned.manifest, expectedTemplateManifest);
    }

    const currentState = plan.operation.serverKind === 'existing' ? this.stateRepository.read(resolved.serverPath) : null;
    const snapshot = await this.snapshotServer({
      currentState,
      expectedContentRevision: plan.operation.expectedContentRevision,
      operationKind: plan.operation.kind,
      runtime: plan.runtime,
      serverKind: plan.operation.serverKind,
      serverPath: resolved.serverPath
    });
    const availableBytes = await this.availableBytes(resolved.serverPath);
    const currentSnapshot = management
      ? {
          currentState,
          pathPreconditions: snapshot.pathPreconditions,
          restorePoints: snapshot.restorePoints || [],
          availableBytes
        }
      : {
          contentRevision: plan.operation.expectedContentRevision,
          pathPreconditions: snapshot.pathPreconditions,
          sourceIdentity: plan.source,
          artifactSetDigest: plan.artifact.setDigest,
          artifactPartsFingerprint: plan.preconditions.artifactPartsFingerprint,
          runtime: plan.runtime,
          inspectionFingerprint: plan.preconditions.inspectionFingerprint,
          ownershipFingerprint: plan.preconditions.ownershipFingerprint,
          selectionsFingerprint: plan.preconditions.selectionsFingerprint,
          restorePointsFingerprint: plan.preconditions.restorePointsFingerprint,
          assetPatternFingerprint: plan.preconditions.assetPatternFingerprint,
          acceptedMappingFingerprint: plan.preconditions.acceptedMappingFingerprint,
          operationFingerprint: plan.preconditions.operationFingerprint,
          availableBytes
        };
    if (management) this.#assertManagementPlanStillValid(plan, currentSnapshot);
    else this.planValidator(plan, currentSnapshot);

    const targetKind = plan.operation.serverKind;
    const paths = targetKind === 'new'
      ? createSiblingPaths(resolved.serverPath, jobId)
      : createExistingSiblingPaths(resolved.serverPath, jobId);
    const durableFs = this.durableFsFactory([this.userDataPath, path.dirname(resolved.serverPath)]);
    const config = readServerConfig(resolved.serverPath, getDefaultServerConfig()) || getDefaultServerConfig();
    const priorAutoRestart = this.restartTokens.get(jobId)?.enabled === true;
    const recordOperationKind = operationKindForRecord(plan);
    const timestamp = nowDate(this.clock).toISOString();
    await this.recoveryRegistry.create({
      schemaVersion: 1,
      sequence: 0,
      jobId,
      operationKind: recordOperationKind,
      target: { kind: targetKind, stableServerId: resolved.instanceId, path: paths.targetPath },
      candidatePath: paths.candidatePath,
      rollbackPath: paths.rollbackPath || null,
      failedPath: paths.failedPath,
      restorePoint: null,
      journalPath: null,
      priorRuntime: { running: resolved.priorRunning, autoRestart: priorAutoRestart },
      phase: 'queued',
      swapStep: 'none',
      directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
      createdAt: timestamp,
      updatedAt: timestamp,
      outcome: null
    });
    let existingEvidence = null;
    if (targetKind === 'existing') {
      existingEvidence = await inspectServerDirectoryTree(resolved.serverPath, {
        fsApi: this.fs,
        reparseInspector: this.reparseInspector,
        signal
      });
    }
    const uninstallWithoutRuntime = management && plan.operation.kind === 'uninstall' &&
      plan.ownership?.confirmation?.possibleNonRunnable === true;
    const targetRunning = uninstallWithoutRuntime
      ? false
      : management || plan.operation.kind === 'files-only'
        ? resolved.priorRunning
        : resolved.priorRunning || choices.startAfterInstall === true;
    const reservation = targetKind === 'new' ? executionRecord.reservation : null;
    await this.recoveryRegistry.transition(jobId, {
      expectedPhase: 'queued',
      nextPhase: 'preflight',
      patch: {
        directoryIdentities: {
          target: existingEvidence?.directoryIdentity || null,
          candidate: null,
          rollback: null,
          failed: null
        },
        outcome: {
          ...(reservation ? { reservation } : {}),
          ...(existingEvidence ? { live: { fingerprint: existingEvidence.fingerprint } } : {}),
          runtime: {
            maxRam: config.maxRam,
            port: config.port,
            source: currentState?.state ? currentState.state.runtime : plan.runtime,
            target: uninstallWithoutRuntime ? null : plan.runtime
          },
          runtimePolicy: {
            targetRunning,
            targetAutoRestart: uninstallWithoutRuntime ? false : priorAutoRestart,
            targetInactive: uninstallWithoutRuntime
          },
          target: {
            name: targetKind === 'new'
              ? this.destinationReservations.resolve(resolved.instanceId)?.displayName || path.basename(resolved.serverPath)
              : path.basename(resolved.serverPath)
          }
        }
      }
    });
    if (targetKind === 'new') {
      const privateReservation = this.destinationReservations.resolve(resolved.instanceId);
      if (!privateReservation || !samePath(privateReservation.targetPath, resolved.serverPath) ||
          JSON.stringify(privateReservation.reservation) !== JSON.stringify(reservation)) throw stale();
      await this.consumeReservedTargetFn({
        targetPath: resolved.serverPath,
        reservation,
        mutationLease: lease,
        durableFs,
        fsApi: this.fs,
        reparseInspector: this.reparseInspector,
        signal
      });
    }
    const context = {
      choices,
      config,
      currentSnapshot,
      currentState,
      durableFs,
      executionRecord,
      management,
      paths,
      plan,
      resolved,
      targetRunning,
      templatePath: template?.path || null
    };
    this.contexts.set(jobId, context);
    return deepFreeze({ revalidated: true, targetKind });
  }

  async createRestorePoint({ jobId, plan, resolved, signal } = {}) {
    const context = this.#context(jobId, plan, resolved);
    if (plan.operation.serverKind !== 'existing' || !context.currentState?.state) throw invalid();
    const service = this.#restoreService(resolved.serverPath, context.durableFs);
    const reference = await service.createVerifiedRestorePoint({
      serverPath: resolved.serverPath,
      operationId: jobId,
      sourceRevision: context.currentState.state.contentRevision,
      sourceRuntime: context.currentState.state.runtime
    });
    if (signal?.aborted) throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
    await this.recoveryRegistry.transition(jobId, {
      expectedPhase: 'preflight',
      nextPhase: 'snapshotting',
      patch: { restorePoint: { id: reference.id, sha256: reference.sha256 } }
    });
    context.restorePoint = reference;
    return reference;
  }

  async buildCandidate({ jobId, operationKind, plan, choices, resolved, lease, signal } = {}) {
    const context = this.#context(jobId, plan, resolved);
    if (![
      'install-new', 'install-existing', 'update', 'downgrade', 'switch', 'repair',
      'import-files-only-new', 'detach', 'uninstall-managed', 'rollback-restore-point'
    ].includes(operationKind)) {
      throw invalid(new Error(`Unsupported production mutation: ${operationKind}`));
    }
    const filesOnly = operationKind === 'import-files-only-new';
    const management = context.management;
    const candidateState = {
      schemaVersion: 1,
      modpackManaged: !filesOnly,
      source: sourceForState(context.executionRecord.source, plan.artifact?.setDigest || null),
      runtime: plan.runtime,
      selectedOptionalFiles: [...(plan.selections?.optionalFileIds || context.currentState?.state?.selectedOptionalFiles || [])],
      installedAt: context.currentState?.state?.installedAt || nowDate(this.clock).toISOString(),
      contentRevision: plan.operation.expectedContentRevision + 1,
      manifest: management ? context.currentState?.manifest || null : null
    };
    if (operationKind === 'detach') candidateState.modpackManaged = false;
    if (operationKind === 'uninstall-managed') {
      candidateState.modpackManaged = false;
      candidateState.runtime = null;
      candidateState.manifest = null;
    }
    context.candidateState = candidateState;
    const common = this.#transactionContext({ jobId, operationKind, plan, resolved, lease, signal, context, candidateState });
    if (plan.operation.serverKind === 'new') {
      const persistCandidateState = filesOnly
        ? ({ candidatePath }) => this.stateRepository.recordFilesOnlyCandidate(candidatePath, {
            operationId: jobId,
            timestamp: nowDate(this.clock).toISOString(),
            contentRevision: candidateState.contentRevision,
            source: sourceForState(context.executionRecord.source, plan.artifact?.setDigest || null),
            provenance: {
              classification: 'files-only',
              inspectionFingerprint: plan.inspection.fingerprint
            }
          })
        : undefined;
      return this.buildNewCandidateFn({
        ...common,
        candidatePath: context.paths.candidatePath,
        ...(filesOnly ? { persistCandidateState, validateCandidate: false } : {}),
        materializeCandidate: async ({ candidatePath }) => {
          if (filesOnly) await this.#materializeFilesOnlyCandidate({ candidatePath, context, signal });
          else await this.#materializeNewCandidate({ candidatePath, context, choices, lease, signal });
        }
      });
    }
    const uninstall = operationKind === 'uninstall-managed';
    const detach = operationKind === 'detach';
    const rollbackRestore = operationKind === 'rollback-restore-point';
    if (uninstall && !context.restorePoint) throw stale();
    if (detach && !context.restorePoint) throw stale();
    if (rollbackRestore && !context.restorePoint) throw stale();
    return this.buildExistingCandidateFn({
      ...common,
      candidatePath: context.paths.candidatePath,
      ...(rollbackRestore ? { freshCandidate: true } : {}),
      ...(uninstall && plan.ownership.confirmation.possibleNonRunnable ? { validateCandidate: false } : {}),
      ...(uninstall ? {
        persistCandidateState: ({ candidatePath }) => this.stateRepository.uninstallCandidate(candidatePath, {
          operationId: jobId,
          timestamp: nowDate(this.clock).toISOString(),
          contentRevision: candidateState.contentRevision,
          confirmation: plan.ownership.confirmation,
          restorePointId: context.restorePoint.id,
          restorePointSha256: context.restorePoint.sha256,
          ...(typeof context.restorePoint.totalBytes === 'string'
            ? { restorePointTotalBytes: context.restorePoint.totalBytes }
            : {})
        })
      } : {}),
      ...(detach ? {
        persistCandidateState: ({ candidatePath }) => {
          const detached = this.stateRepository.detachCandidate(candidatePath, {
            operationId: jobId,
            timestamp: nowDate(this.clock).toISOString(),
            contentRevision: candidateState.contentRevision,
            restorePointId: context.restorePoint.id,
            restorePointSha256: context.restorePoint.sha256,
            ...(typeof context.restorePoint.totalBytes === 'string'
              ? { restorePointTotalBytes: context.restorePoint.totalBytes }
              : {})
          });
          return detached?.state ? detached : { state: detached };
        }
      } : {}),
      ...(rollbackRestore ? {
        persistCandidateState: ({ candidatePath }) => this.#persistRollbackCandidateState({
          candidatePath,
          context,
          jobId
        })
      } : {}),
      applyIncoming: async ({ candidatePath }) => {
        if (rollbackRestore) await this.#applyRollbackCandidate({ candidatePath, context, jobId, lease, signal });
        else if (!uninstall && operationKind !== 'detach') {
          await this.#applyExistingCandidate({ candidatePath, context, choices, jobId, lease, signal });
        }
      }
    });
  }

  async validateCandidate({ jobId, plan, resolved } = {}) {
    this.#context(jobId, plan, resolved);
    return deepFreeze({ validatedByTransaction: true });
  }

  async publishCandidate({ jobId, plan, resolved, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    return this.publishNewCandidateFn(this.#transactionContext({
      jobId, operationKind: 'install-new', plan, resolved, lease, signal: undefined, context,
      candidateState: context.candidateState
    }));
  }

  async registerPublishedInstance({ jobId, plan, resolved, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    const reservation = this.destinationReservations.resolve(resolved.instanceId);
    if (!reservation || !samePath(reservation.targetPath, resolved.serverPath)) throw stale();
    return this.registerPublishedInstanceFn({
      ...this.#transactionContext({
        jobId, operationKind: 'install-new', plan, resolved, lease, signal: undefined, context,
        candidateState: context.candidateState
      }),
      appStore: this.store,
      instanceContext: this.instanceContext,
      name: reservation.displayName
    });
  }

  async commitCandidate({ jobId, operationKind, plan, resolved, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    return this.swapExistingCandidateFn(this.#transactionContext({
      jobId, operationKind, plan, resolved, lease, signal: undefined, context,
      candidateState: context.candidateState
    }));
  }

  async startFinal({ jobId, plan, resolved } = {}) {
    this.#context(jobId, plan, resolved);
    return deepFreeze({ deferredToLiveValidation: true });
  }

  async validateLive({ jobId, operationKind, plan, resolved, running, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    context.releaseTrackingIntent ||= this.releaseTrackingReconciler.createIntent({
      serverId: resolved.instanceId,
      operationKind,
      source: context.candidateState.source
    });
    if (plan.operation.serverKind === 'existing') {
      const validation = await this.markCommittedHealthyFn(this.#transactionContext({
        jobId, operationKind, plan, resolved, lease, signal: undefined, context,
        candidateState: context.candidateState,
        ...(operationKind === 'uninstall-managed' && plan.ownership.confirmation.possibleNonRunnable
          ? { validateLive: false }
          : {})
      }));
      return validation;
    }
    let record = await this.recoveryRegistry.load(jobId);
    if (!record || record.phase !== 'registering' || record.outcome?.registration?.complete !== true) throw invalid();
    record = await this.recoveryRegistry.transition(jobId, {
      expectedPhase: 'registering', nextPhase: 'validating-live', patch: {}
    });
    const filesOnly = operationKind === 'import-files-only-new';
    if (filesOnly && running === true) throw invalid();
    const validation = filesOnly
      ? deepFreeze({ skipped: true, reason: 'files-only' })
      : await this.healthValidator.validateLive({
          instanceId: resolved.instanceId,
          jobId,
          keepRunning: running === true,
          maxRam: context.config.maxRam,
          mutationLease: lease,
          port: context.config.port,
          runtime: plan.runtime,
          serverPath: resolved.serverPath,
          timeoutMs: this.healthTimeoutMs
        });
    let adopted = false;
    if (!filesOnly && running === true) {
      if (!validation?.handoff) throw new ModpackError('HEALTH_CHECK_FAILED', 'The validated server process could not be adopted');
      const result = await this.runtimePolicy.adoptValidatedHandoff({
        eventId: `modpack-runtime-handoff:${jobId}`,
        handoff: validation.handoff,
        instanceId: resolved.instanceId,
        jobId,
        serverPath: resolved.serverPath
      });
      adopted = result?.adopted === true;
      if (!adopted) throw new ModpackError('HEALTH_CHECK_FAILED', 'The validated server process could not be adopted');
    }
    const event = {
      eventId: `modpack-content-revision:${jobId}:${context.candidateState.contentRevision}`,
      instanceId: resolved.instanceId,
      operationKind: transactionOperationKind(operationKind),
      targetRevision: context.candidateState.contentRevision
    };
    record = await this.recoveryRegistry.transition(jobId, {
      expectedPhase: 'validating-live',
      nextPhase: 'committed-healthy',
      patch: {
        outcome: {
          ...(record.outcome || {}),
          health: validation?.evidence || validation || { ok: true },
          runtimePolicy: {
            ...(record.outcome?.runtimePolicy || {}),
            handoffEventId: !filesOnly && running ? `modpack-runtime-handoff:${jobId}` : null,
            runningRestored: adopted
          },
          revisionEvent: { eventId: event.eventId, published: false },
          releaseTracking: context.releaseTrackingIntent
        }
      }
    });
    await this.revisionPublisher.publishOnce(event);
    await this.recoveryRegistry.transition(jobId, {
      expectedPhase: 'committed-healthy',
      nextPhase: 'committed-healthy',
      patch: {
        outcome: {
          ...record.outcome,
          revisionEvent: { eventId: event.eventId, published: true }
        }
      }
    });
    return validation;
  }

  async isDurablyCommitted({ jobId, plan, resolved } = {}) {
    this.#context(jobId, plan, resolved);
    const record = await this.recoveryRegistry.load(jobId);
    return Boolean(
      record && record.jobId === jobId && DURABLE_COMMIT_PHASES.has(record.phase) &&
      record.target?.stableServerId === resolved.instanceId && samePath(record.target.path, resolved.serverPath)
    );
  }

  async persistOutcome({ jobId, operationKind, plan, restorePoint, resolved, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    const stateRepositoryOwnsHistory = [
      'detach', 'uninstall-managed', 'import-files-only-new', 'rollback-restore-point'
    ].includes(operationKind);
    const effectiveRestorePoint = restorePoint || context.restorePoint || null;
    const existing = this.stateRepository.listHistory(resolved.serverPath, { cursor: null, limit: 200 });
    const ownedHistory = (existing?.items || []).find(entry => entry.operationId === jobId);
    const sequence = ownedHistory?.sequence || Math.max(0, ...(existing?.items || []).map(entry => entry.sequence || 0)) + 1;
    const history = {
      schemaVersion: 1,
      operationId: jobId,
      sequence,
      kind: historyKind(operationKind),
      outcome: 'completed',
      timestamp: nowDate(this.clock).toISOString(),
      sourceRevision: plan.operation.expectedContentRevision,
      targetRevision: context.candidateState.contentRevision,
      ...(context.currentState?.state?.runtime ? { sourceRuntime: context.currentState.state.runtime } : {}),
      ...(plan.runtime ? { targetRuntime: plan.runtime } : {}),
      ...(effectiveRestorePoint?.id
        ? {
            restorePointId: effectiveRestorePoint.id,
            restorePointSha256: effectiveRestorePoint.sha256,
            ...(typeof effectiveRestorePoint.totalBytes === 'string'
              ? { restorePointTotalBytes: effectiveRestorePoint.totalBytes }
              : {})
          }
        : {})
    };
    if (!stateRepositoryOwnsHistory) this.stateRepository.appendHistory(resolved.serverPath, history);
    context.releaseTrackingIntent ||= this.releaseTrackingReconciler.createIntent({
      serverId: resolved.instanceId,
      operationKind,
      source: context.candidateState.source
    });
    await this.releaseTrackingReconciler.persistIntent(jobId, context.releaseTrackingIntent);
    await this.releaseTrackingReconciler.reconcile(jobId);
    return deepFreeze({ historySequence: sequence });
  }

  async cleanup({ jobId, operationKind, plan, resolved, lease } = {}) {
    const context = this.#context(jobId, plan, resolved);
    await this.releaseTrackingReconciler.reconcile(jobId);
    if (plan.operation.serverKind === 'existing') {
      await this.cleanupCommittedTransactionFn(this.#transactionContext({
        jobId, operationKind, plan, resolved, lease, signal: undefined, context,
        candidateState: context.candidateState
      }));
    }
    const record = await this.recoveryRegistry.load(jobId);
    if (record) await this.recoveryRegistry.finish(jobId, {
      terminalPhase: 'completed',
      outcome: record.outcome || { result: 'completed' }
    });
    if (plan.operation.serverKind === 'new') this.destinationReservations.consume(resolved.instanceId, resolved.serverPath);
    this.contexts.delete(jobId);
    this.restartTokens.delete(jobId);
    return deepFreeze({ cleaned: true });
  }

  async rollback({ jobId, plan, resolved, lease, error } = {}) {
    this.#context(jobId, plan, resolved);
    const record = await this.recoveryRegistry.load(jobId);
    if (!record) throw invalid();
    const beforeExistingSwap = plan.operation.serverKind === 'existing' && (
      ['queued', 'preflight', 'snapshotting', 'staging', 'validating-candidate'].includes(record.phase) ||
      (record.phase === 'committing' && ['none', 'prepared'].includes(record.swapStep))
    );
    const result = plan.operation.serverKind === 'new'
      ? this.recoveryService.failNewWithLease(record, lease, error)
      : beforeExistingSwap
        ? this.recoveryService.recoverWithLease(record, lease)
        : this.recoveryService.rollbackWithLease(record, lease, error?.code || 'lifecycle-rollback');
    const recovered = await result;
    if (plan.operation.serverKind === 'new') this.#releaseReservation(resolved);
    this.contexts.delete(jobId);
    return recovered;
  }

  async abandonCandidate({ jobId, plan, resolved, lease } = {}) {
    this.#context(jobId, plan, resolved);
    const record = await this.recoveryRegistry.load(jobId);
    if (!record) return deepFreeze({ alreadyAbsent: true });
    const recovered = await this.recoveryService.recoverWithLease(record, lease);
    if (plan.operation.serverKind === 'new') this.#releaseReservation(resolved);
    this.contexts.delete(jobId);
    return recovered;
  }

  async restorePriorState({ jobId, plan, resolved, restartToken } = {}) {
    const token = restartToken || this.restartTokens.get(jobId);
    if (!token || token.newServer) {
      this.restartTokens.delete(jobId);
      return deepFreeze({ restored: true, newServer: true });
    }
    if (this.restoredRestartTokens.has(token)) return this.restoredRestartTokens.get(token);
    const keepDisabled = plan?.operation?.kind === 'uninstall' &&
      plan.ownership?.confirmation?.possibleNonRunnable === true;
    const restored = await this.runtimePolicy.restoreAutoRestart({
      enabled: keepDisabled ? false : token.enabled,
      operationId: token.operationId,
      serverPath: resolved.serverPath
    });
    this.restoredRestartTokens.set(token, restored);
    this.restartTokens.delete(jobId);
    return restored;
  }

  #assertManagementPlanStillValid(plan, snapshot) {
    if (!plan || plan.type !== 'modpack-management-plan' || plan.schemaVersion !== 1 ||
        computePreflightPlanFingerprint(plan) !== plan.fingerprint || !snapshot.currentState?.state ||
        snapshot.currentState.state.contentRevision !== plan.operation.expectedContentRevision ||
        sha256(snapshot.currentState) !== plan.preconditions?.stateFingerprint ||
        JSON.stringify(snapshot.pathPreconditions) !== JSON.stringify(plan.preconditions?.pathPreconditions) ||
        sha256(snapshot.pathPreconditions) !== plan.preconditions?.pathPreconditionsFingerprint ||
        sha256(plan.ownership) !== plan.preconditions?.ownershipFingerprint ||
        sha256(plan.restorePoints) !== plan.preconditions?.restorePointsFingerprint ||
        sha256(plan.operation) !== plan.preconditions?.operationFingerprint) throw stale();
    for (const expected of plan.restorePoints || []) {
      const current = snapshot.restorePoints.find(point => point?.id === expected.id);
      if (!current || current.sha256 !== expected.sha256 || current.sourceRevision !== expected.sourceRevision ||
          current.worldIncluded !== expected.worldIncluded || JSON.stringify(current.runtime) !== JSON.stringify(expected.runtime)) {
        throw stale();
      }
    }
    try {
      if (BigInt(snapshot.availableBytes) < BigInt(plan.preconditions.minimumAvailableBytes)) throw stale();
    } catch (error) {
      throw error instanceof ModpackError ? error : stale(error);
    }
    return plan;
  }

  #releaseReservation(resolved) {
    const released = this.destinationReservations.release(resolved.instanceId);
    if (released !== true) throw new ModpackError(
      'RECOVERY_REQUIRED',
      'The failed server destination reservation could not be released'
    );
  }

  #context(jobId, plan, resolved) {
    const context = this.contexts.get(jobId);
    if (!context || context.plan !== plan || context.resolved.instanceId !== resolved.instanceId ||
        !samePath(context.resolved.serverPath, resolved.serverPath)) throw stale();
    return context;
  }

  #transactionContext({ jobId, operationKind, plan, resolved, lease, signal, context, candidateState, validateLive }) {
    return {
      jobId,
      operationKind: transactionOperationKind(operationKind),
      stableInstanceId: resolved.instanceId,
      targetPath: resolved.serverPath,
      fsApi: this.fs,
      durableFs: context.durableFs,
      recoveryRegistry: this.recoveryRegistry,
      mutationLease: lease,
      reparseInspector: this.reparseInspector,
      plan,
      currentSnapshot: context.currentSnapshot,
      stateRepository: this.stateRepository,
      planValidator: context.management
        ? (managementPlan, snapshot) => this.#assertManagementPlanStillValid(managementPlan, snapshot)
        : this.planValidator,
      candidateState,
      ...(validateLive === undefined ? {} : { validateLive }),
      healthValidator: this.healthValidator,
      runtime: plan.runtime,
      maxRam: context.config.maxRam,
      port: context.config.port,
      healthTimeoutMs: this.healthTimeoutMs,
      signal,
      runtimePolicy: this.runtimePolicy,
      revisionPublisher: this.revisionPublisher,
      ...(context.releaseTrackingIntent ? { releaseTrackingIntent: context.releaseTrackingIntent } : {}),
      clock: this.clock
    };
  }

  async #materializeFilesOnlyCandidate({ candidatePath, context, signal }) {
    await this.#verifyTemplate(context, signal);
    await copyTree(context.templatePath, candidatePath, { reparseInspector: this.reparseInspector, signal });
  }

  async #applyRollbackCandidate({ candidatePath, context, jobId, lease, signal }) {
    const selected = context.executionRecord.selectedRestorePoint;
    if (!selected || selected.id !== context.plan.restorePoints?.[0]?.id ||
        selected.sha256 !== context.plan.restorePoints?.[0]?.sha256) throw stale();
    const service = this.#restoreService(context.resolved.serverPath, context.durableFs);
    if (typeof service.restoreToOwnedCandidate !== 'function') throw invalid();
    const operationWorkspace = path.join(candidatePath, '.minecraft-core-state', 'operations', jobId);
    const restoreDirectory = path.join(operationWorkspace, 'selected-restore');
    await service.restoreToOwnedCandidate(selected, restoreDirectory, candidatePath);
    const restored = this.stateRepository.read(restoreDirectory);
    if (!restored?.state || restored.state.modpackManaged !== true || !restored.manifest ||
        restored.state.contentRevision !== selected.sourceRevision ||
        JSON.stringify(restored.state.runtime) !== JSON.stringify(context.plan.runtime)) throw stale();

    const preservedNames = new Set(['.minecraft-core-state', 'backups']);
    for (const name of this.fs.readdirSync(candidatePath)) {
      if (preservedNames.has(name.toLocaleLowerCase('en-US'))) continue;
      await this.#removeControlledEntry(path.join(candidatePath, name), candidatePath, signal);
      lease.markDirty();
    }
    for (const entry of this.fs.readdirSync(restoreDirectory, { withFileTypes: true })) {
      if (['.minecraft-core-state', 'backups'].includes(entry.name.toLocaleLowerCase('en-US'))) continue;
      const source = path.join(restoreDirectory, entry.name);
      const destination = path.join(candidatePath, entry.name);
      const stat = this.fs.lstatSync(source, { bigint: true });
      if (this.fs.existsSync(destination) || entry.isSymbolicLink() || stat.isSymbolicLink() ||
          await this.reparseInspector.isReparsePoint(source, signal ? { signal } : undefined) !== false ||
          (!stat.isDirectory() && (!stat.isFile() || BigInt(stat.nlink) !== 1n))) throw stale();
      context.durableFs.renameDurable(source, destination);
      lease.markDirty();
    }

    const liveHistory = path.join(context.resolved.serverPath, '.minecraft-core-state', 'history');
    const candidateHistory = path.join(candidatePath, '.minecraft-core-state', 'history');
    if (this.fs.existsSync(liveHistory)) {
      await copyServerDirectoryContents(liveHistory, candidateHistory, {
        durableFs: context.durableFs,
        fsApi: this.fs,
        reparseInspector: this.reparseInspector,
        signal
      });
      lease.markDirty();
    }
    const liveBackups = path.join(context.resolved.serverPath, 'backups');
    const candidateBackups = path.join(candidatePath, 'backups');
    if (this.fs.existsSync(liveBackups) && !this.fs.existsSync(candidateBackups)) {
      this.fs.mkdirSync(candidateBackups, { recursive: false });
      context.durableFs.flushDirectory(candidatePath);
      await copyServerDirectoryContents(liveBackups, candidateBackups, {
        durableFs: context.durableFs,
        fsApi: this.fs,
        reparseInspector: this.reparseInspector,
        signal
      });
      lease.markDirty();
    }
    await this.#removeControlledEntry(restoreDirectory, candidatePath, signal);
    lease.markDirty();
    Object.assign(context.candidateState, {
      schemaVersion: 1,
      modpackManaged: true,
      source: structuredClone(restored.state.source),
      runtime: structuredClone(restored.state.runtime),
      selectedOptionalFiles: [...restored.state.selectedOptionalFiles],
      installedAt: restored.state.installedAt,
      contentRevision: context.plan.operation.expectedContentRevision + 1,
      manifest: structuredClone(restored.manifest)
    });
  }

  #persistRollbackCandidateState({ candidatePath, context, jobId }) {
    const written = this.stateRepository.writeCandidate(candidatePath, context.candidateState);
    const existing = this.stateRepository.listHistory(candidatePath, { cursor: null, limit: 200 });
    const sequence = Math.max(0, ...(existing?.items || []).map(entry => entry.sequence || 0)) + 1;
    const safety = context.restorePoint;
    if (!safety?.id || !safety.sha256) throw stale();
    this.stateRepository.appendHistory(candidatePath, {
      schemaVersion: 1,
      operationId: jobId,
      sequence,
      kind: 'rollback',
      outcome: 'completed',
      timestamp: nowDate(this.clock).toISOString(),
      sourceRevision: context.plan.operation.expectedContentRevision,
      targetRevision: context.candidateState.contentRevision,
      ...(context.currentState?.state?.runtime ? { sourceRuntime: context.currentState.state.runtime } : {}),
      targetRuntime: context.candidateState.runtime,
      restorePointId: safety.id,
      restorePointSha256: safety.sha256,
      ...(typeof safety.totalBytes === 'string' ? { restorePointTotalBytes: safety.totalBytes } : {})
    });
    return written;
  }

  async #removeControlledEntry(entryPath, ownedRoot, signal) {
    if (signal?.aborted) throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
    const relative = path.relative(ownedRoot, entryPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw invalid();
    const stat = this.fs.lstatSync(entryPath, { bigint: true });
    if (stat.isSymbolicLink() || await this.reparseInspector.isReparsePoint(entryPath, signal ? { signal } : undefined) !== false) {
      throw stale();
    }
    if (stat.isDirectory()) {
      for (const name of this.fs.readdirSync(entryPath)) {
        await this.#removeControlledEntry(path.join(entryPath, name), ownedRoot, signal);
      }
      this.fs.rmdirSync(entryPath);
    } else if (stat.isFile() && BigInt(stat.nlink) === 1n) {
      this.fs.unlinkSync(entryPath);
    } else {
      throw stale();
    }
  }

  async #ensureControlledDirectory(directoryPath, ownedRoot, durableFs, signal) {
    const root = path.resolve(ownedRoot);
    const destination = path.resolve(directoryPath);
    const relative = path.relative(root, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw stale();
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat = this.fs.lstatSync(current, { bigint: true, throwIfNoEntry: false });
      if (!stat) {
        this.fs.mkdirSync(current, { recursive: false, mode: 0o700 });
        durableFs.flushDirectory(path.dirname(current));
        stat = this.fs.lstatSync(current, { bigint: true });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          await this.reparseInspector.isReparsePoint(current, signal ? { signal } : undefined) !== false) throw stale();
    }
  }

  async #verifyTemplate(context, signal) {
    const expectedTemplateManifest = context.plan.operation.kind === 'repair'
      ? context.executionRecord.execution.repairPayloadManifest
      : context.executionRecord.incomingManifest;
    if (!expectedTemplateManifest) throw stale();
    const rescanned = await scanManifest(
      context.templatePath,
      expectedTemplateManifest.installationId,
      { reparseInspector: this.reparseInspector, signal }
    );
    exactIncomingManifest(rescanned.manifest, expectedTemplateManifest);
  }

  async #materializeNewCandidate({ candidatePath, context, choices, lease, signal }) {
    await this.#verifyTemplate(context, signal);
    await copyTree(context.templatePath, candidatePath, { reparseInspector: this.reparseInspector, signal });
    await this.#prepareCandidateRuntime({ candidatePath, context, choices, lease, signal, oldManifest: null });
  }

  async #applyExistingCandidate({ candidatePath, context, choices, jobId, lease, signal }) {
    await this.#verifyTemplate(context, signal);
    const targetedRepair = context.plan.operation.kind === 'repair';
    const oldEntries = new Map((context.currentState?.manifest?.entries || []).map(entry => [entry.pathKey, entry]));
    const runtimeRepairs = new Map();
    for (const action of context.plan.ownership.actions) {
      if (signal?.aborted) throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
      const relative = canonicalPath(action.path).path;
      const destination = path.resolve(candidatePath, ...relative.split('/'));
      if (!samePath(path.resolve(candidatePath, path.relative(candidatePath, destination)), destination) ||
          path.relative(candidatePath, destination).startsWith('..')) throw invalid();
      if (['remove', 'remove-user-addon'].includes(action.action)) {
        const stat = this.fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink()) throw stale();
          this.fs.unlinkSync(destination);
          context.durableFs.flushDirectory(path.dirname(destination));
          lease.markDirty();
        }
        continue;
      }
      if (action.action === 'disable-user-addon') {
        const disabled = `${destination}.disabled`;
        if (this.fs.existsSync(disabled)) throw stale();
        context.durableFs.renameDurable(destination, disabled);
        lease.markDirty();
        continue;
      }
      if (!['add', 'seed-protected', 'restore-missing', 'replace', 'keep-both'].includes(action.action)) continue;
      const oldEntry = oldEntries.get(action.pathKey);
      if (targetedRepair && oldEntry?.origin === 'runtime') {
        if (!['replace', 'restore-missing'].includes(action.action) || runtimeRepairs.has(action.pathKey) ||
            oldEntry.managementPolicy !== 'replaceable-managed' ||
            oldEntry.path !== relative) throw stale();
        runtimeRepairs.set(action.pathKey, { action, entry: oldEntry, relative });
        continue;
      }
      const source = path.resolve(context.templatePath, ...relative.split('/'));
      const incomingDestination = action.action === 'keep-both'
        ? path.resolve(candidatePath, ...canonicalPath(action.incomingPath).path.split('/'))
        : destination;
      if (action.action === 'replace' && this.fs.existsSync(incomingDestination)) {
        const stat = this.fs.lstatSync(incomingDestination, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) throw stale();
        this.fs.unlinkSync(incomingDestination);
      }
      await copyRegularFile(source, incomingDestination, {
        reparseInspector: this.reparseInspector,
        signal,
        replace: false
      });
      lease.markDirty();
    }
    if (targetedRepair) {
      if (choices.acceptEula === true) {
        const eulaPath = path.join(candidatePath, 'eula.txt');
        context.durableFs.writeFileAtomic(eulaPath, Buffer.from('eula=true\n', 'utf8'));
        lease.markDirty();
      }
      if (runtimeRepairs.size > 0) {
        await this.#repairCandidateRuntimePaths({
          candidatePath,
          context,
          jobId,
          lease,
          repairs: [...runtimeRepairs.values()],
          signal
        });
      }
      const runtimePathKeys = new Set((context.currentState?.manifest?.entries || [])
        .filter(entry => entry.origin === 'runtime')
        .map(entry => entry.pathKey));
      const candidateManifest = await scanCandidateManifest({
        candidatePath,
        installationId: context.executionRecord.incomingManifest.installationId,
        incomingManifest: context.executionRecord.incomingManifest,
        oldManifest: context.currentState?.manifest || null,
        ownershipPlan: context.plan.ownership,
        runtimePathKeys,
        reparseInspector: this.reparseInspector,
        signal
      });
      for (const repair of runtimeRepairs.values()) {
        const actual = candidateManifest.entries.find(entry => entry.pathKey === repair.entry.pathKey);
        if (!actual || actual.installedHash !== repair.entry.installedHash || actual.size !== repair.entry.size) {
          throw runtimeIncomplete();
        }
      }
      context.candidateState.manifest = candidateManifest;
    } else {
      await this.#prepareCandidateRuntime({
        candidatePath,
        context,
        choices,
        lease,
        signal,
        oldManifest: context.currentState?.manifest || null
      });
    }
  }

  async #repairCandidateRuntimePaths({ candidatePath, context, jobId, lease, repairs, signal }) {
    if (typeof jobId !== 'string' || jobId.length < 1 || !Array.isArray(repairs) || repairs.length < 1) throw stale();
    const operationRoot = path.join(candidatePath, '.minecraft-core-state', 'operations', jobId);
    const stagingPath = path.join(operationRoot, 'runtime-repair');
    const operationStat = this.fs.lstatSync(operationRoot, { bigint: true, throwIfNoEntry: false });
    if (!operationStat?.isDirectory() || operationStat.isSymbolicLink() ||
        await this.reparseInspector.isReparsePoint(operationRoot, signal ? { signal } : undefined) !== false ||
        this.fs.existsSync(stagingPath)) throw stale();
    this.fs.mkdirSync(stagingPath, { recursive: false, mode: 0o700 });
    context.durableFs.flushDirectory(operationRoot);
    lease.markDirty();

    try {
      const repairsJava = repairs.some(({ entry }) => entry.pathKey === 'java' || entry.pathKey.startsWith('java/'));
      const repairsManagedRuntime = repairs.some(({ entry }) => entry.pathKey !== 'java' && !entry.pathKey.startsWith('java/'));
      let javaPath = null;
      if (repairsManagedRuntime && !repairsJava) {
        const candidateJavaManager = this.javaManagerFactory(candidatePath, {
          onMutation: () => { throw stale(); }
        });
        if (candidateJavaManager && typeof candidateJavaManager.getJavaValidationStatus === 'function') {
          const status = candidateJavaManager.getJavaValidationStatus(context.plan.runtime.javaMajor);
          if (status?.isInstalled === true && typeof status.javaPath === 'string' && path.isAbsolute(status.javaPath)) {
            const relativeJava = path.relative(candidatePath, status.javaPath).replaceAll('\\', '/');
            if (relativeJava && !relativeJava.startsWith('..') && !path.isAbsolute(relativeJava)) {
              const canonicalJava = canonicalPath(relativeJava);
              const baseline = context.currentState?.manifest?.entries?.find(entry => entry.pathKey === canonicalJava.pathKey);
              const javaStat = this.fs.lstatSync(status.javaPath, { bigint: true, throwIfNoEntry: false });
              if (baseline?.origin === 'runtime' && baseline.managementPolicy === 'replaceable-managed' &&
                  javaStat?.isFile() && !javaStat.isSymbolicLink() && BigInt(javaStat.nlink) === 1n &&
                  await this.reparseInspector.isReparsePoint(status.javaPath,
                    signal ? { signal } : undefined) === false) javaPath = status.javaPath;
            }
          }
        }
      }
      if (repairsJava || (repairsManagedRuntime && !javaPath)) {
        const stagingJavaManager = this.javaManagerFactory(stagingPath, { onMutation: () => lease.markDirty() });
        const java = await stagingJavaManager.ensureJava(context.plan.runtime.javaMajor);
        if (!java?.success || typeof java.javaPath !== 'string' || !path.isAbsolute(java.javaPath) ||
            path.relative(stagingPath, java.javaPath).startsWith('..') || path.isAbsolute(path.relative(stagingPath, java.javaPath))) {
          throw runtimeIncomplete();
        }
        javaPath = java.javaPath;
      }
      if (repairsManagedRuntime) {
        if (!javaPath) throw runtimeIncomplete();
        await this.prepareRuntime({
          targetPath: stagingPath,
          runtime: context.plan.runtime,
          javaPath,
          signal
        });
        lease.markDirty();
      }

      const staged = await scanManifest(
        stagingPath,
        context.executionRecord.incomingManifest.installationId,
        { reparseInspector: this.reparseInspector, signal }
      );
      const stagedEntries = new Map(staged.manifest.entries.map(entry => [entry.pathKey, entry]));
      for (const repair of repairs) {
        const stagedEntry = stagedEntries.get(repair.entry.pathKey);
        if (!stagedEntry || stagedEntry.path !== repair.relative ||
            stagedEntry.installedHash !== repair.entry.installedHash || stagedEntry.size !== repair.entry.size) {
          throw runtimeIncomplete();
        }
        const source = path.resolve(stagingPath, ...repair.relative.split('/'));
        const destination = path.resolve(candidatePath, ...repair.relative.split('/'));
        const sourceStat = this.fs.lstatSync(source, { bigint: true, throwIfNoEntry: false });
        if (!sourceStat?.isFile() || sourceStat.isSymbolicLink() || BigInt(sourceStat.nlink) !== 1n ||
            await this.reparseInspector.isReparsePoint(source, signal ? { signal } : undefined) !== false) {
          throw runtimeIncomplete();
        }
        const destinationStat = this.fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
        if (destinationStat && (!destinationStat.isFile() || destinationStat.isSymbolicLink() ||
            BigInt(destinationStat.nlink) !== 1n ||
            await this.reparseInspector.isReparsePoint(destination, signal ? { signal } : undefined) !== false)) {
          throw stale();
        }
        if (destinationStat) {
          this.fs.unlinkSync(destination);
          context.durableFs.flushDirectory(path.dirname(destination));
        }
        await this.#ensureControlledDirectory(path.dirname(destination), candidatePath, context.durableFs, signal);
        context.durableFs.renameDurable(source, destination);
        lease.markDirty();
      }
    } finally {
      if (this.fs.existsSync(stagingPath)) {
        await this.#removeControlledEntry(stagingPath, operationRoot, undefined);
        context.durableFs.flushDirectory(operationRoot);
        lease.markDirty();
      }
    }
  }

  async #prepareCandidateRuntime({ candidatePath, context, choices, lease, signal, oldManifest }) {
    if (choices.acceptEula === true) {
      const eulaPath = path.join(candidatePath, 'eula.txt');
      context.durableFs.writeFileAtomic(eulaPath, Buffer.from('eula=true\n', 'utf8'));
      lease.markDirty();
    }
    const beforeRuntime = await scanManifest(
      candidatePath,
      context.executionRecord.incomingManifest.installationId,
      { reparseInspector: this.reparseInspector, signal }
    );
    const javaManager = this.javaManagerFactory(candidatePath, { onMutation: () => lease.markDirty() });
    const java = await javaManager.ensureJava(context.plan.runtime.javaMajor);
    if (!java?.success || typeof java.javaPath !== 'string' || !path.isAbsolute(java.javaPath)) throw runtimeIncomplete();
    await this.prepareRuntime({
      targetPath: candidatePath,
      runtime: context.plan.runtime,
      javaPath: java.javaPath,
      signal
    });
    lease.markDirty();
    const afterRuntime = await scanManifest(
      candidatePath,
      context.executionRecord.incomingManifest.installationId,
      { reparseInspector: this.reparseInspector, signal }
    );
    const beforePaths = new Map(beforeRuntime.manifest.entries.map(entry => [entry.pathKey, entry]));
    const runtimePathKeys = new Set(afterRuntime.manifest.entries
      .filter(entry => {
        const before = beforePaths.get(entry.pathKey);
        return !before || before.installedHash !== entry.installedHash || before.size !== entry.size;
      })
      .map(entry => entry.pathKey));
    context.candidateState.manifest = await scanCandidateManifest({
      candidatePath,
      installationId: context.executionRecord.incomingManifest.installationId,
      incomingManifest: context.executionRecord.incomingManifest,
      oldManifest,
      ownershipPlan: context.plan.ownership,
      runtimePathKeys,
      reparseInspector: this.reparseInspector,
      signal
    });
  }

  #restoreService(serverPath, durableFs) {
    const key = path.dirname(serverPath).normalize('NFC').toLocaleLowerCase('en-US');
    if (!this.restoreServices.has(key)) {
      const dependencies = {
        fsApi: this.fs,
        durableFs,
        clock: () => nowDate(this.clock),
        randomUUID: this.randomUUID,
        extractVerifiedArchiveFn: createVerifiedRestoreExtractor({
          fsApi: this.fs,
          durableFs,
          reparseInspector: this.reparseInspector
        })
      };
      const service = this.restorePointServiceFactory
        ? this.restorePointServiceFactory(dependencies)
        : new RestorePointService(dependencies);
      if (!service || typeof service.createVerifiedRestorePoint !== 'function' ||
          typeof service.restoreToOwnedCandidate !== 'function') throw invalid();
      this.restoreServices.set(key, service);
    }
    return this.restoreServices.get(key);
  }

}

module.exports = { ProductionMutationRuntime, scanCandidateManifest, sourceForState };
