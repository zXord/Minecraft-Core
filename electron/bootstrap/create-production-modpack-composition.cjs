const fs = require('node:fs');
const path = require('node:path');

const { ModpackLifecycleService } = require('../services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { ModpackRecoveryFacade } = require('../services/modpack-lifecycle/modpack-recovery-facade.cjs');
const { OperationEventStore } = require('../services/modpack-lifecycle/operation-event-store.cjs');
const { reconcileOperationStoreWithRecovery } = require('../services/modpack-lifecycle/operation-recovery-reconciler.cjs');
const { OperationStore } = require('../services/modpack-lifecycle/operation-store.cjs');
const { OutcomeActionService } = require('../services/modpack-lifecycle/outcome-action-service.cjs');
const { PlanRegistry } = require('../services/modpack-lifecycle/plan-registry.cjs');
const { ArtifactWorkspaceRegistry } = require('../services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { VerifiedArtifactAcquisition } = require('../services/modpacks/artifacts/verified-artifact-acquisition.cjs');
const { ArchiveExtractor } = require('../services/modpacks/archive/archive-extractor.cjs');
const { resolveBundledArchiveRuntimePaths } = require('../services/modpacks/archive/archive-engine-paths.cjs');
const { ArchiveInspector } = require('../services/modpacks/archive/archive-inspector.cjs');
const { LocalArtifactSource } = require('../services/modpacks/local/local-artifact-source.cjs');
const { WindowsReparseInspector } = require('../services/modpacks/local/windows-reparse-inspector.cjs');
const { ModpackError } = require('../services/modpacks/errors.cjs');
const { NativeModpackNotificationBridge } = require('../services/modpacks/notifications/native-notification-bridge.cjs');
const { NotificationStore } = require('../services/modpacks/notifications/notification-store.cjs');
const {
  CompositeOutcomeActionExecutor,
  CompositeOutcomeReferenceAuthority,
  LifecycleOutcomeActionExecutor,
  LifecycleOutcomeActionIssuer,
  LifecycleOutcomeReferenceAuthority
} = require('../services/modpacks/notifications/lifecycle-outcome-actions.cjs');
const { ReleaseActionExecutor, ReleaseNotificationReferenceAuthority } = require('../services/modpacks/notifications/release-action-authority.cjs');
const { ReleaseMonitor } = require('../services/modpacks/notifications/release-monitor.cjs');
const { ReleaseTrackingStore } = require('../services/modpacks/notifications/release-tracking-store.cjs');
const { PersistentCandidateHashService } = require('../services/modpacks/planning/candidate-hash-service.cjs');
const { ProductionCandidatePreparer } = require('../services/modpacks/planning/production-candidate-preparer.cjs');
const { ProductionPlanningAdapter } = require('../services/modpacks/planning/production-planning-adapter.cjs');
const { createProductionServerSnapshot } = require('../services/modpacks/planning/production-server-snapshot.cjs');
const {
  ServerDestinationReservationService,
  createCompositeInstanceResolver
} = require('../services/modpacks/planning/server-destination-reservation-service.cjs');
const { ProductionModpackSourceResolver } = require('../services/modpacks/providers/production-source-resolver.cjs');
const { ModpackStateRepository } = require('../services/modpacks/state/modpack-state-repository.cjs');
const { validateServerPorts } = require('../utils/port-validator.cjs');

const SHUTDOWN_PRUNE_TIMEOUT_MS = 2_000;

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'Production modpack services could not be composed', { cause });
}

function milliseconds(clock) {
  const value = clock.now();
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(result) || result < 0) throw invalid();
  return result;
}

function stateRepositoryRouter({ durableFsFactory, fsApi, clock, userDataPath }) {
  const repositories = new Map();
  function repositoryFor(serverPathValue) {
    if (typeof serverPathValue !== 'string' || !path.isAbsolute(serverPathValue)) throw invalid();
    const serverPath = path.resolve(serverPathValue);
    const key = path.dirname(serverPath).normalize('NFC').toLocaleLowerCase('en-US');
    if (!repositories.has(key)) {
      repositories.set(key, new ModpackStateRepository({
        fsApi,
        durableFs: durableFsFactory([userDataPath, path.dirname(serverPath)]),
        clock: () => new Date(milliseconds(clock))
      }));
    }
    return repositories.get(key);
  }
  const facade = { repositoryFor };
  for (const method of [
    'read', 'writeCandidate', 'writeCandidateAsync', 'appendHistory', 'appendHistoryAsync', 'listHistory', 'verifyManagedFiles',
    'recordFilesOnlyCandidate', 'detachCandidate', 'uninstallCandidate'
  ]) {
    facade[method] = (serverPath, ...args) => repositoryFor(serverPath)[method](serverPath, ...args);
  }
  return Object.freeze(facade);
}

function instanceIdAvailable(store, instanceId) {
  const instances = store.get('instances');
  return Array.isArray(instances) && !instances.some(instance => instance?.id === instanceId);
}

function canExposePendingNewServer(store, record) {
  try {
    const instances = store.get('instances');
    const stableServerId = record?.target?.stableServerId;
    const targetPath = record?.target?.path;
    if (!Array.isArray(instances) || typeof stableServerId !== 'string' ||
        typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return false;
    const targetPathKey = path.resolve(targetPath).normalize('NFC').toLocaleLowerCase('en-US');
    return !instances.some(instance => {
      if (!instance || typeof instance !== 'object' || Array.isArray(instance)) return false;
      if (instance.id === stableServerId) return true;
      if (typeof instance.path !== 'string' || !path.isAbsolute(instance.path)) return false;
      return path.resolve(instance.path).normalize('NFC').toLocaleLowerCase('en-US') === targetPathKey;
    });
  } catch {
    return false;
  }
}

function newServerRegistrationState(store, record) {
  try {
    const instances = store.get('instances');
    const stableServerId = record?.target?.stableServerId;
    const targetPath = record?.target?.path;
    if (!Array.isArray(instances) || typeof stableServerId !== 'string' ||
        typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return 'conflict';
    const targetPathKey = path.resolve(targetPath).normalize('NFC').toLocaleLowerCase('en-US');
    const idMatches = [];
    const pathMatches = [];
    for (const instance of instances) {
      if (!instance || typeof instance !== 'object' || Array.isArray(instance)) continue;
      if (instance.id === stableServerId) idMatches.push(instance);
      if (typeof instance.path === 'string' && path.isAbsolute(instance.path) &&
          path.resolve(instance.path).normalize('NFC').toLocaleLowerCase('en-US') === targetPathKey) {
        pathMatches.push(instance);
      }
    }
    if (idMatches.length === 0 && pathMatches.length === 0) return 'absent';
    if (idMatches.length === 1 && pathMatches.length === 1 && idMatches[0] === pathMatches[0] &&
        idMatches[0].type === 'server') return 'registered';
    return 'conflict';
  } catch {
    return 'conflict';
  }
}

function finalizeResolvedNewServerReservation({ destinationReservations, store, record, result }) {
  if (record?.target?.kind !== 'new') return true;
  const instanceId = record.target.stableServerId;
  const targetPath = record.target.path;
  const reservation = destinationReservations.resolve(instanceId);
  if (!reservation) return true;
  const registrationState = newServerRegistrationState(store, record);
  if (result?.action === 'new-publication-completed' ||
      (result?.action === 'already-finished' && registrationState === 'registered')) {
    if (registrationState !== 'registered' || destinationReservations.consume(instanceId, targetPath) !== true) {
      throw invalid();
    }
    return true;
  }
  if (['pre-publication-cleanup', 'new-health-failed'].includes(result?.action) ||
      (result?.action === 'already-finished' && registrationState === 'absent')) {
    if (registrationState !== 'absent' || destinationReservations.release(instanceId) !== true) throw invalid();
    return true;
  }
  throw invalid();
}

function controlledFolderOpener(shell, cachePath) {
  return Object.freeze({
    async openCacheParent() {
      if (!shell || typeof shell.openPath !== 'function') throw invalid();
      const failure = await shell.openPath(cachePath);
      if (failure !== undefined && failure !== '') throw invalid();
      return true;
    }
  });
}

function requireRecoveryServices(input) {
  const services = input.rawRecoveryServices || input.recoveryServices;
  const registry = services?.registry;
  const recoveryService = services?.recoveryService;
  if (!registry || typeof registry.listActive !== 'function' || !recoveryService ||
      ['recover', 'rollback', 'retryCommittedCleanup'].some(method => typeof recoveryService[method] !== 'function')) throw invalid();
  return { services, registry, recoveryService };
}

function retainedArtifactDigests(value) {
  const parts = value?.plan?.artifact?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const digests = parts.map(part => part?.sha256);
  if (digests.some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) return null;
  return [...new Set(digests)];
}

function retainingOutcomeActionIssuer({ issuer, artifactCache } = {}) {
  return Object.freeze({
    async issue(value) {
      const actions = await issuer.issue(value);
      if (typeof artifactCache.retainForOutcome !== 'function' ||
          !actions.some(action => action?.actionId === 'open-retained-download-folder')) return actions;
      const digests = retainedArtifactDigests(value);
      if (!digests) return actions;
      await artifactCache.retainForOutcome({ ownerId: value.jobId, sha256s: digests });
      return actions;
    }
  });
}

async function createProductionModpackComposition(input = {}) {
  let workspaceRegistry = null;
  let candidateHashService = null;
  let clientPacks = null;
  try {
    const {
      artifactCache, artifactDownloader, clock, coordinator, dialog, durableFsFactory,
      fsPromises, fsSync = fs, getWindow, instanceResolver, paths, providers, randomUUID,
      reparseInspector: suppliedReparseInspector, runtimeRoots, selectionRegistry, shell, store,
      shutdownClearTimeoutFn = clearTimeout, shutdownSetTimeoutFn = setTimeout,
      userDataPath, workerFactory
    } = input;
    if (!artifactCache || typeof artifactCache !== 'object' || !artifactDownloader ||
        typeof artifactDownloader.downloadSet !== 'function' || typeof artifactDownloader.downloadPart !== 'function' ||
        !clock || typeof clock.now !== 'function' || !coordinator || typeof coordinator.runMutation !== 'function' ||
        !dialog || typeof dialog.showOpenDialog !== 'function' || typeof durableFsFactory !== 'function' ||
        !fsPromises || !fsSync || typeof getWindow !== 'function' || !instanceResolver ||
        typeof instanceResolver.resolveInstance !== 'function' || !paths?.modpacks || !providers?.modrinth || !providers?.github ||
        typeof randomUUID !== 'function' || !runtimeRoots || !selectionRegistry || !shell ||
        typeof shutdownClearTimeoutFn !== 'function' || typeof shutdownSetTimeoutFn !== 'function' ||
        !store || typeof store.get !== 'function' || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) ||
        typeof workerFactory !== 'function') throw invalid();

    for (const directory of [
      userDataPath, paths.modpacks.root, paths.modpacks.cache, paths.modpacks.workspaces,
      paths.modpacks.notifications, paths.modpacks.operations
    ]) fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });

    const nowMs = () => milliseconds(clock);
    const nowDate = () => new Date(nowMs());
    const reparseInspector = suppliedReparseInspector || new WindowsReparseInspector();
    candidateHashService = input.candidateHashService || new PersistentCandidateHashService();
    if (!candidateHashService || typeof candidateHashService.hashFile !== 'function' ||
        typeof candidateHashService.dispose !== 'function') throw invalid();
    workspaceRegistry = await ArtifactWorkspaceRegistry.open({
      root: paths.modpacks.workspaces,
      artifactCache,
      clock: nowMs,
      idFactory: randomUUID,
      reparseInspector
    });
    const archiveRuntimeResolver = input.archiveRuntimeResolver || input.archiveRuntimePathResolver || resolveBundledArchiveRuntimePaths;
    const archiveRuntime = input.archiveRuntime || await archiveRuntimeResolver(runtimeRoots);
    if (!archiveRuntime || typeof archiveRuntime.resourcesRoot !== 'string' || typeof archiveRuntime.workerPath !== 'string' ||
        typeof archiveRuntime.workerManifestPath !== 'string') throw invalid();
    const archiveWorkerClient = input.archiveWorkerClient || workerFactory({
      workerPath: archiveRuntime.workerPath,
      workerManifestPath: archiveRuntime.workerManifestPath,
      resourcesRoot: archiveRuntime.resourcesRoot,
      runtimeLayout: archiveRuntime.runtimeLayout,
      workspaceRoot: paths.modpacks.workspaces,
      workspaceRegistry,
      spawn: input.processFactory,
      appOwnedRoot: path.join(userDataPath, 'archive-worker'),
      reparseInspector
    });
    if (!archiveWorkerClient || typeof archiveWorkerClient.run !== 'function') throw invalid();

    const archiveInspector = new ArchiveInspector({
      workspaceRegistry,
      workspaceRoot: paths.modpacks.workspaces,
      workerClient: archiveWorkerClient
    });
    const archiveExtractor = new ArchiveExtractor({
      workspaceRegistry,
      workspaceRoot: paths.modpacks.workspaces,
      workerClient: archiveWorkerClient,
      reparseInspector,
      clock: nowMs
    });
    const artifactAcquisition = new VerifiedArtifactAcquisition({ artifactDownloader });
    const localArtifactSource = new LocalArtifactSource({
      dialog,
      registry: selectionRegistry,
      clock: nowMs,
      fsApi: fsPromises,
      cache: artifactCache,
      partialRoot: path.join(paths.modpacks.cache, 'partial'),
      partialIdSource: randomUUID,
      reparseInspector
    });
    const sourceResolver = new ProductionModpackSourceResolver({ providers, localArtifactSource });
    const candidatePreparer = new ProductionCandidatePreparer({
      workspaceRegistry,
      archiveExtractor,
      artifactDownloader,
      artifactCache,
      candidateHashService,
      reparseInspector,
      randomUUID
    });

    const destinationReservationService = new ServerDestinationReservationService({
      dialog,
      reparseInspector,
      randomUUID,
      clock: nowMs,
      isInstanceIdAvailable: instanceId => instanceIdAvailable(store, instanceId)
    });
    const compositeInstanceResolver = createCompositeInstanceResolver({
      liveInstanceResolver: instanceResolver,
      destinationReservations: destinationReservationService
    });
    const stateRepository = stateRepositoryRouter({ durableFsFactory, fsApi: fsSync, clock, userDataPath });
    clientPacks = require('./create-client-pack-composition.cjs').createClientPackComposition({
      ...input, stateRepository, sourceResolver, artifactAcquisition, archiveInspector, archiveExtractor,
      workspaceRegistry, candidateHashService, reparseInspector
    });
    const snapshotServer = createProductionServerSnapshot({ fsApi: fsSync, reparseInspector, stateRepository });
    const planningAdapter = new ProductionPlanningAdapter({
      instanceResolver: compositeInstanceResolver,
      stateRepository,
      reparseInspector,
      preparePlanInputs: request => candidatePreparer.preparePlanInputs(request),
      snapshotServer,
      fsApi: fsSync,
      validateServerPorts: input.validateServerPorts ?? validateServerPorts,
      workspaceRegistry,
      resolveRestorePoint: (request, options) => {
        const service = (input.rawRecoveryServices || input.recoveryServices)?.restorePointService;
        if (!service || typeof service.resolveRestorePoint !== 'function') throw invalid();
        return service.resolveRestorePoint(request, options);
      },
      listAvailableRestorePoints: request => {
        const service = (input.rawRecoveryServices || input.recoveryServices)?.restorePointService;
        if (!service || typeof service.listAvailableRestorePoints !== 'function') throw invalid();
        return service.listAvailableRestorePoints(request);
      }
    });
    const planRegistry = new PlanRegistry({ workspaceRegistry, clock: nowMs, randomUUID });

    const rootDurableFs = durableFsFactory([userDataPath]);
    const nativeNotificationBridge = new NativeModpackNotificationBridge({ Notification: input.Notification || null, getWindow });
    const baseOperationStore = new OperationStore({
      userDataPath,
      fsApi: fsSync,
      durableFs: rootDurableFs,
      clock: nowDate,
      randomUUID
    });
    let cachePrunePromise = null;
    const runArtifactCachePrune = () => {
      if (typeof artifactCache.prune !== 'function') return Promise.resolve(null);
      if (!cachePrunePromise) {
        cachePrunePromise = Promise.resolve().then(() => artifactCache.prune()).catch(() => null).finally(() => {
          cachePrunePromise = null;
        });
      }
      return cachePrunePromise;
    };
    const scheduleArtifactCachePrune = () => {
      void runArtifactCachePrune();
      return typeof artifactCache.prune === 'function';
    };
    const awaitArtifactCachePruneForShutdown = async () => {
      if (typeof artifactCache.prune !== 'function') return;
      let deadlineHandle = null;
      let deadlineActive = true;
      const deadlinePromise = new Promise(resolve => {
        deadlineHandle = shutdownSetTimeoutFn(() => {
          deadlineActive = false;
          resolve(false);
        }, SHUTDOWN_PRUNE_TIMEOUT_MS);
        if (deadlineHandle && typeof deadlineHandle.unref === 'function') deadlineHandle.unref();
      });
      const waitWithinDeadline = promise => Promise.race([
        Promise.resolve(promise).then(() => true, () => true),
        deadlinePromise
      ]);
      try {
        // A maintenance pass may already be running. Queue one fresh pass after
        // it so newly released owner references are always observed. The queue
        // remains live even if orderly shutdown reaches its bounded deadline.
        const earlyPrune = cachePrunePromise;
        const postReleasePrune = Promise.resolve(earlyPrune).then(() => runArtifactCachePrune());
        await waitWithinDeadline(postReleasePrune);
      } catch {
        // Cache maintenance is best effort and must never prevent orderly quit.
      } finally {
        if (deadlineActive) {
          deadlineActive = false;
          try {
            shutdownClearTimeoutFn(deadlineHandle);
          } catch {
            // A test or host timer implementation cannot make disposal fail.
          }
        }
      }
    };
    const operationStore = new OperationEventStore({
      operationStore: baseOperationStore,
      nativeNotificationBridge,
      onTerminal: scheduleArtifactCachePrune
    });
    const notificationStore = new NotificationStore({
      userDataPath,
      fsApi: fsSync,
      durableFs: rootDurableFs,
      clock: nowDate,
      randomUUID,
      eventSink: notification => nativeNotificationBridge.publish(notification)
    });
    const releaseTrackingStore = input.rawRecoveryServices?.releaseTrackingStore || new ReleaseTrackingStore({
      userDataPath,
      fsApi: fsSync,
      durableFs: rootDurableFs,
      clock: nowDate
    });
    const releaseMonitor = new ReleaseMonitor({
      clock: nowDate,
      notificationStore,
      trackingStore: releaseTrackingStore,
      providers,
      ...(input.setIntervalFn ? { setIntervalFn: input.setIntervalFn } : {}),
      ...(input.clearIntervalFn ? { clearIntervalFn: input.clearIntervalFn } : {})
    });

    const { services: recoveryServices, registry: recoveryRegistry, recoveryService: rawRecoveryService } = requireRecoveryServices(input);
    const lifecycleOutcomeActionIssuer = retainingOutcomeActionIssuer({
      issuer: new LifecycleOutcomeActionIssuer(),
      artifactCache
    });
    let lifecycleService = null;
    const recoveryService = new ModpackRecoveryFacade({
      recoveryRegistry,
      recoveryService: rawRecoveryService,
      canExposePendingNewServer: record => canExposePendingNewServer(store, record),
      hasActiveJob: jobId => {
        if (!lifecycleService) throw new ModpackError('RECOVERY_REQUIRED', 'Operation ownership is unavailable');
        return lifecycleService.hasActiveJob(jobId);
      },
      async onResolved(jobId, record, result) {
        finalizeResolvedNewServerReservation({
          destinationReservations: destinationReservationService,
          store,
          record,
          result
        });
        const job = await operationStore.get(jobId);
        if (job && (job.terminalAt === null || job.phase === 'recovery-required')) {
          const result = await reconcileOperationStoreWithRecovery({
            operationStore,
            recoveryRegistry,
            jobs: [job],
            outcomeActionIssuer: lifecycleOutcomeActionIssuer
          });
          if (!result.reconciled.includes(jobId)) return false;
        }
        if (!await planRegistry.releaseClaim(jobId)) await workspaceRegistry.releaseOwner(jobId);
        return true;
      }
    });
    const mutationRuntime = input.mutationRuntime || new (require('../services/modpack-lifecycle/production-mutation-runtime.cjs').ProductionMutationRuntime)({
      artifactCache,
      candidateHashService,
      candidatePreparer,
      coordinator,
      destinationReservations: destinationReservationService,
      durableFsFactory,
      fsApi: fsSync,
      instanceResolver: compositeInstanceResolver,
      planningAdapter,
      recoveryServices,
      releaseTrackingStore,
      reparseInspector,
      stateRepository,
      store,
      userDataPath,
      workspaceRegistry,
      clock: nowDate,
      randomUUID
    });

    lifecycleService = new ModpackLifecycleService({
      sourceResolver,
      artifactDownloader: artifactAcquisition,
      archiveInspector,
      inspectionLoader: archiveInspector.materializer,
      planningAdapter,
      planRegistry,
      operationStore,
      mutationCoordinator: coordinator,
      mutationRuntime,
      instanceResolver: compositeInstanceResolver,
      resolveServerSelection: instanceId => {
        const instances = store.get('instances');
        const matches = Array.isArray(instances) ? instances.filter(item => item?.id === instanceId) : [];
        if (matches.length !== 1 || matches[0].type !== 'server' || typeof matches[0].path !== 'string' || !path.isAbsolute(matches[0].path)) {
          throw new ModpackError('PLAN_STALE', 'The server instance is no longer available');
        }
        return { instanceId };
      },
      stateRepository,
      stateEventSink: state => nativeNotificationBridge.publishStateChanged(state),
      outcomeActionIssuer: lifecycleOutcomeActionIssuer,
      workspaceRegistry
    });

    const lifecycleAuthority = new LifecycleOutcomeReferenceAuthority({ operationStore, randomUUID });
    const releaseAuthority = new ReleaseNotificationReferenceAuthority({
      notificationStore,
      trackingStore: releaseTrackingStore,
      randomUUID
    });
    const referenceAuthority = new CompositeOutcomeReferenceAuthority({ lifecycleAuthority, releaseAuthority });
    const lifecycleExecutor = new LifecycleOutcomeActionExecutor({
      operationStore,
      getLifecycleService: () => lifecycleService,
      recoveryService
    });
    const releaseExecutor = new ReleaseActionExecutor({ releaseMonitor });
    const actionExecutor = new CompositeOutcomeActionExecutor({ lifecycleExecutor, releaseExecutor });
    const outcomeActionService = new OutcomeActionService({
      referenceAuthority,
      artifactCache,
      controlledFolderOpener: controlledFolderOpener(shell, paths.modpacks.cache),
      actionExecutor
    });

    let initialized = false;
    let disposePromise = null;

    function beginCleanup(operation) {
      try {
        return Promise.resolve(operation()).then(
          () => ({ ok: true }),
          error => ({ ok: false, error })
        );
      } catch (error) {
        return Promise.resolve({ ok: false, error });
      }
    }

    function dispose() {
      if (disposePromise) return disposePromise;

      let resolveDisposal;
      let rejectDisposal;
      disposePromise = new Promise((resolve, reject) => {
        resolveDisposal = resolve;
        rejectDisposal = reject;
      });

      // Begin all synchronous cleanup before yielding so ownership cannot leak
      // while Electron is entering its orderly-quit barrier.
      const cleanupResults = [
        beginCleanup(() => lifecycleService.dispose()),
        beginCleanup(() => planRegistry.dispose()),
        beginCleanup(() => releaseMonitor.stop()),
        beginCleanup(() => nativeNotificationBridge.stop())
      ];
      const clientCleanup = beginCleanup(() => clientPacks.dispose());

      void (async () => {
        const failures = [];
        for (const cleanupResult of cleanupResults) {
          const result = await cleanupResult;
          if (!result.ok) failures.push(result.error);
        }

        // Client downloads/runtime operations must settle before their shared hash/workspaces close.
        const clientResult = await clientCleanup;
        if (!clientResult.ok) throw new AggregateError([...failures, clientResult.error], 'Client pack owners did not settle');
        const hashResult = await beginCleanup(() => candidateHashService.dispose());
        if (!hashResult.ok) failures.push(hashResult.error);
        const workspaceResult = await beginCleanup(() => workspaceRegistry.dispose());
        if (!workspaceResult.ok) failures.push(workspaceResult.error);

        // Cache eligibility depends on the references released above. Bound one
        // fresh post-release maintenance pass without making cleanup failure fatal.
        await beginCleanup(() => awaitArtifactCachePruneForShutdown());

        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Production modpack composition disposal failed');
        }
      })().then(resolveDisposal, rejectDisposal);

      return disposePromise;
    }

    const composition = {
      companionService: clientPacks.companionService,
      clientPackService: clientPacks.clientPackService,
      clientPackIntegration: clientPacks.clientPackIntegration,
      managementSessionBroker: clientPacks.managementSessionBroker,
      resolveClientByPath: clientPacks.resolveClientByPath,
      providers,
      artifactAcquisition,
      workspaceRegistry,
      archiveInspector,
      archiveExtractor,
      candidatePreparer,
      candidateHashService,
      planningAdapter,
      planRegistry,
      stateRepository,
      mutationRuntime,
      localArtifactSource,
      destinationReservationService,
      lifecycleService,
      recoveryService,
      notificationStore,
      releaseMonitor,
      releaseTrackingStore,
      outcomeActionService,
      nativeNotificationBridge,
      async initialize() {
        if (initialized) return composition;
        const jobs = await operationStore.initialize();
        await notificationStore.initialize();
        await releaseTrackingStore.initialize();
        await clientPacks.initialize();
        if (typeof recoveryRegistry.loadHistory === 'function') {
          await reconcileOperationStoreWithRecovery({
            operationStore,
            recoveryRegistry,
            jobs,
            outcomeActionIssuer: lifecycleOutcomeActionIssuer
          });
        }
        scheduleArtifactCachePrune();
        initialized = true;
        return composition;
      },
      scheduleArtifactCachePrune,
      dispose
    };
    return Object.freeze(composition);
  } catch (error) {
    if (clientPacks) await clientPacks.dispose();
    if (candidateHashService) await candidateHashService.dispose().catch(() => {});
    if (workspaceRegistry) await workspaceRegistry.dispose().catch(() => {});
    throw invalid(error);
  }
}

module.exports = { createProductionModpackComposition, stateRepositoryRouter };
