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
const { getBundledArchiveRuntime } = require('../services/modpacks/archive/archive-engine-paths.cjs');
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
const { ProductionCandidatePreparer } = require('../services/modpacks/planning/production-candidate-preparer.cjs');
const { ProductionPlanningAdapter } = require('../services/modpacks/planning/production-planning-adapter.cjs');
const { createProductionServerSnapshot } = require('../services/modpacks/planning/production-server-snapshot.cjs');
const {
  ServerDestinationReservationService,
  createCompositeInstanceResolver
} = require('../services/modpacks/planning/server-destination-reservation-service.cjs');
const { ProductionModpackSourceResolver } = require('../services/modpacks/providers/production-source-resolver.cjs');
const { ModpackStateRepository } = require('../services/modpacks/state/modpack-state-repository.cjs');

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
    'read', 'writeCandidate', 'appendHistory', 'listHistory', 'verifyManagedFiles',
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

async function createProductionModpackComposition(input = {}) {
  try {
    const {
      artifactCache, artifactDownloader, clock, coordinator, dialog, durableFsFactory,
      fsPromises, fsSync = fs, getWindow, instanceResolver, paths, providers, randomUUID,
      reparseInspector: suppliedReparseInspector, runtimeRoots, selectionRegistry, shell, store,
      userDataPath, workerFactory
    } = input;
    if (!artifactCache || typeof artifactCache !== 'object' || !artifactDownloader ||
        typeof artifactDownloader.downloadSet !== 'function' || typeof artifactDownloader.downloadPart !== 'function' ||
        !clock || typeof clock.now !== 'function' || !coordinator || typeof coordinator.runMutation !== 'function' ||
        !dialog || typeof dialog.showOpenDialog !== 'function' || typeof durableFsFactory !== 'function' ||
        !fsPromises || !fsSync || typeof getWindow !== 'function' || !instanceResolver ||
        typeof instanceResolver.resolveInstance !== 'function' || !paths?.modpacks || !providers?.modrinth || !providers?.github ||
        typeof randomUUID !== 'function' || !runtimeRoots || !selectionRegistry || !shell ||
        !store || typeof store.get !== 'function' || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) ||
        typeof workerFactory !== 'function') throw invalid();

    for (const directory of [
      userDataPath, paths.modpacks.root, paths.modpacks.cache, paths.modpacks.workspaces,
      paths.modpacks.notifications, paths.modpacks.operations
    ]) fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });

    const nowMs = () => milliseconds(clock);
    const nowDate = () => new Date(nowMs());
    const reparseInspector = suppliedReparseInspector || new WindowsReparseInspector();
    const workspaceRegistry = new ArtifactWorkspaceRegistry({
      root: paths.modpacks.workspaces,
      artifactCache,
      clock: nowMs,
      idFactory: randomUUID
    });
    const archiveRuntime = input.archiveRuntime || await (input.archiveRuntimeResolver || getBundledArchiveRuntime)(runtimeRoots);
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
      appOwnedRoot: path.join(userDataPath, 'archive-worker')
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
    const snapshotServer = createProductionServerSnapshot({ fsApi: fsSync, reparseInspector, stateRepository });
    const planningAdapter = new ProductionPlanningAdapter({
      instanceResolver: compositeInstanceResolver,
      stateRepository,
      reparseInspector,
      preparePlanInputs: request => candidatePreparer.preparePlanInputs(request),
      snapshotServer,
      fsApi: fsSync,
      workspaceRegistry,
      resolveRestorePoint: request => {
        const service = (input.rawRecoveryServices || input.recoveryServices)?.restorePointService;
        if (!service || typeof service.resolveRestorePoint !== 'function') throw invalid();
        return service.resolveRestorePoint(request);
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
    const operationStore = new OperationEventStore({ operationStore: baseOperationStore, nativeNotificationBridge });
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
    const recoveryService = new ModpackRecoveryFacade({ recoveryRegistry, recoveryService: rawRecoveryService });
    const mutationRuntime = input.mutationRuntime || new (require('../services/modpack-lifecycle/production-mutation-runtime.cjs').ProductionMutationRuntime)({
      artifactCache,
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

    const lifecycleOutcomeActionIssuer = new LifecycleOutcomeActionIssuer();
    let lifecycleService = null;
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
      stateRepository,
      stateEventSink: state => nativeNotificationBridge.publishStateChanged(state),
      outcomeActionIssuer: lifecycleOutcomeActionIssuer
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
    let disposed = false;
    const composition = {
      providers,
      artifactAcquisition,
      workspaceRegistry,
      archiveInspector,
      archiveExtractor,
      candidatePreparer,
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
        if (typeof recoveryRegistry.loadHistory === 'function') {
          await reconcileOperationStoreWithRecovery({
            operationStore,
            recoveryRegistry,
            jobs,
            outcomeActionIssuer: lifecycleOutcomeActionIssuer
          });
        }
        initialized = true;
        return composition;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        releaseMonitor.stop();
        nativeNotificationBridge.stop();
      }
    };
    return Object.freeze(composition);
  } catch (error) {
    throw invalid(error);
  }
}

module.exports = { createProductionModpackComposition, stateRepositoryRouter };
