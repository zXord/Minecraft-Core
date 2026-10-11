const fs = require('node:fs');
const path = require('node:path');
const { markStartupTrace } = require('../utils/startup-trace.cjs');

const { ModpackLifecycleService } = require('../services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { ModpackRecoveryFacade } = require('../services/modpack-lifecycle/modpack-recovery-facade.cjs');
const { OperationEventStore } = require('../services/modpack-lifecycle/operation-event-store.cjs');
const { reconcileOperationStoreWithRecovery } = require('../services/modpack-lifecycle/operation-recovery-reconciler.cjs');
const { OperationStore } = require('../services/modpack-lifecycle/operation-store.cjs');
const { OutcomeActionService } = require('../services/modpack-lifecycle/outcome-action-service.cjs');
const { PlanRegistry } = require('../services/modpack-lifecycle/plan-registry.cjs');
const { FailedRestorePointRetirement } = require('../services/modpack-lifecycle/failed-restorepoint-retirement.cjs');
const { createRetirementWarningPublisher } = require('../services/modpack-lifecycle/failed-restorepoint-retirement-warning.cjs');
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
const { createModpackPaths } = require('../services/modpacks/paths.cjs');

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

    const canonicalRoot = value => typeof value === 'string' && path.isAbsolute(value)
      ? (process.platform === 'win32' ? path.resolve(value).normalize('NFC').toLowerCase() : path.resolve(value)) : null;
    const expectedPaths = createModpackPaths(userDataPath);
    for (const key of ['root', 'operations', 'workspaces']) {
      if (canonicalRoot(paths.modpacks[key]) !== canonicalRoot(expectedPaths[key])) throw invalid();
    }

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
    let ownerState = 'starting';
    const ownerEpoch = Symbol('modpack-launch-owner');
    const ownerLease = workspaceRegistry.rootLease;
    const launchOwner = Object.freeze({
      epoch: ownerEpoch,
      assertCurrent(expectedEpoch, { allowClosing = false, startupOnly = false } = {}) {
        if (expectedEpoch !== ownerEpoch || ownerState === 'disposed' ||
            (ownerState === 'closing' && !allowClosing) || (startupOnly && ownerState !== 'starting') ||
            !ownerLease || workspaceRegistry.rootLease !== ownerLease || canonicalRoot(workspaceRegistry.root) !== canonicalRoot(expectedPaths.workspaces)) {
          throw new ModpackError('PLAN_STALE', 'The modpack workspace owner is unavailable');
        }
        workspaceRegistry.assertLease();
      }
    });
    const assertAdmission = () => {
      try {
        launchOwner.assertCurrent(ownerEpoch);
        if (ownerState !== 'ready') throw invalid();
      } catch (cause) { throw new ModpackError('PLAN_STALE', 'The modpack workspace owner is unavailable', { cause }); }
    };
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
      assertAdmission,
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
      randomUUID,
      launchOwner
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
    const publishRetirementWarning = createRetirementWarningPublisher({ notificationStore });
    let retirement = null;
    let retirementClosing = false;
    let retirementPass = null;
    let startupRetirementArmed = false;
    let retirementDispatch = null;
    const retirementSetImmediate = input.retirementSetImmediateFn || setImmediate;
    const retirementClearImmediate = input.retirementClearImmediateFn || clearImmediate;
    function createRetirement(verifyLiveProof) {
      // Older injected library fixtures have no retirement metadata API. Their
      // absence is not authority; production's registry supplies all methods.
      if (['loadPublishedTerminalEvidence', 'loadRestorePointRetirement', 'writeRestorePointRetirement',
        'listRestorePointRetirementItems', 'hasOtherActiveRestorePointReference'].some(key => typeof recoveryRegistry[key] !== 'function')) return null;
      retirement = new FailedRestorePointRetirement({ registry: recoveryRegistry, coordinator, planRegistry, stateRepository,
        clock: nowDate, randomUUID, verifyLiveProof,
        restorePointServiceFor(selector) {
          const service = recoveryServices.restorePointService;
          if (typeof service?.withExactRetirementPoint !== 'function') throw Object.assign(new Error('Exact retirement is unavailable'), { retirementReason: 'unsupported-native' });
          return { withExactRetirementPoint(candidate, options, work) {
            if (options.authority.selector.instanceId !== selector.instanceId ||
                options.authority.selector.serverPath !== selector.serverPath) throw invalid();
            return service.withExactRetirementPoint(candidate, options, work);
          } };
        },
        async assertTargetAvailable(selector, lease) {
          coordinator.assertMutationLease(lease, selector, lease.operationId);
          const current = await instanceResolver.resolveInstance(selector.instanceId);
          if (current?.instanceId !== selector.instanceId || typeof current.serverPath !== 'string' ||
              path.resolve(current.serverPath).toLowerCase() !== path.resolve(selector.serverPath).toLowerCase()) throw invalid();
          if (current.priorRunning !== false) throw new ModpackError('SERVER_RUNNING', 'The server is running');
          coordinator.assertMutationLease(lease, selector, lease.operationId);
        } });
      return retirement;
    }
    function startRetirementPass(request) {
      if (retirementClosing || retirementPass || !retirement) return false;
      retirementPass = Promise.resolve().then(async () => {
        if (retirementClosing) return;
        const targets = new Map(recoveryRegistry.listRestorePointRetirementItems({ selector: null }).map(item => [item.jobId, item.selector.instanceId]));
        const pass = await retirement.retryPass(request);
        for (const result of pass.results) {
          const serverId = targets.get(result.jobId);
          if (!serverId) continue;
          try { await publishRetirementWarning({ jobId: result.jobId, serverId, result }); }
          catch { console.warn('Backup cleanup notice could not be updated'); }
        }
      }).catch(() => { console.warn('Backup cleanup pass was deferred'); }).finally(() => { retirementPass = null; });
      return true;
    }
    function armStartupRetirement(ready) {
      if (retirementClosing || startupRetirementArmed || !retirement || !ready || typeof ready.then !== 'function') return false;
      startupRetirementArmed = true;
      void Promise.resolve(ready).then(value => {
        if (value !== true || retirementClosing) return;
        retirementDispatch = retirementSetImmediate(() => {
          retirementDispatch = null;
          if (!retirementClosing) startRetirementPass({ trigger: 'startup', selector: null });
        });
      }).catch(() => {});
      return true;
    }
    const lifecycleOutcomeActionIssuer = retainingOutcomeActionIssuer({
      issuer: new LifecycleOutcomeActionIssuer(),
      artifactCache
    });
    let lifecycleService = null;
    const recoveryFacade = new ModpackRecoveryFacade({
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
        // Admitted recovery still owns the lease during teardown and must release
        // its exact claim; only fresh housekeeping is suppressed while closing.
        if (!await planRegistry.releaseClaim(jobId)) await workspaceRegistry.releaseOwner(jobId);
        if (retirementClosing) return true;
        if (record.target.kind === 'existing') startRetirementPass({ trigger: 'recovery-completed',
          selector: { instanceId: record.target.stableServerId, serverPath: record.target.path } });
        return true;
      }
    });
    // Admit before the facade's first scan/raw recovery await, not at onResolved.
    const recoveryService = Object.freeze({
      listRecovery: () => recoveryFacade.listRecovery(),
      recover: request => lifecycleService.runAdmittedWork(() => recoveryFacade.recover(request))
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
      randomUUID,
      failedRestorePointRetirementFactory: verify => createRetirement(verify) || { retireLive: async () => { throw invalid(); } },
      publishRetirementWarning
    });
    if (input.mutationRuntime) createRetirement(() => false);

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
      assertAdmission,
      destinationReservations: destinationReservationService,
      launchOwner,
      clock: nowMs,
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
    let initializationPromise = null;
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
      ownerState = 'closing';
      lifecycleService.closeAdmission();
      retirementClosing = true;
      if (retirementDispatch !== null) { retirementClearImmediate(retirementDispatch); retirementDispatch = null; }
      const retirementDrain = retirement?.close();
      const activeRetirement = retirementPass;

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
        beginCleanup(() => releaseMonitor.stop()),
        beginCleanup(() => nativeNotificationBridge.stop())
      ];
      const clientCleanup = beginCleanup(() => clientPacks.dispose());

      void (async () => {
        const failures = [];
        // No reference or native/workspace dependency may close while a sent
        // deletion still has unconfirmed ownership. Deliberately no deadline.
        await retirementDrain;
        await activeRetirement;
        // Startup can already be awaiting an injected/native dependency when
        // orderly quit closes admission. Its continuations also own the lease.
        if (initializationPromise) await initializationPromise.catch(() => {});
        await lifecycleService.drain();
        const planResult = await beginCleanup(() => planRegistry.dispose());
        for (const cleanupResult of cleanupResults) {
          const result = await cleanupResult;
          if (!result.ok) failures.push(result.error);
        }
        if (!planResult.ok) failures.push(planResult.error);

        // Client downloads/runtime operations must settle before their shared hash/workspaces close.
        const clientResult = await clientCleanup;
        if (!clientResult.ok) throw new AggregateError([...failures, clientResult.error], 'Client pack owners did not settle');
        const hashResult = await beginCleanup(() => candidateHashService.dispose());
        if (!hashResult.ok) failures.push(hashResult.error);
        const workspaceResult = await beginCleanup(() => workspaceRegistry.dispose());
        if (!workspaceResult.ok) failures.push(workspaceResult.error);
        if (workspaceRegistry.disposed) ownerState = 'disposed';

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
      acquireLegacyManagementContext: clientPacks.acquireLegacyManagementContext,
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
        if (initializationPromise) return initializationPromise;
        launchOwner.assertCurrent(ownerEpoch, { startupOnly: true });
        initializationPromise = (async () => {
        markStartupTrace('composition:operation-store-init:start');
        const jobs = await operationStore.initialize();
        // All dispositions retain their incarnation; this is not hold reconstruction
        // or startup closure (those remain the later launch-classification slice).
        const launches = await operationStore.listNewServerLaunchBindings(ownerEpoch);
        for (const launch of launches) destinationReservationService.retainInstanceId(launch.binding.instanceId);
        markStartupTrace('composition:operation-store-init:complete');
        markStartupTrace('composition:notification-store-init:start');
        await notificationStore.initialize();
        markStartupTrace('composition:notification-store-init:complete');
        markStartupTrace('composition:release-tracking-init:start');
        await releaseTrackingStore.initialize();
        markStartupTrace('composition:release-tracking-init:complete');
        markStartupTrace('composition:client-packs-init:start');
        await clientPacks.initialize();
        markStartupTrace('composition:client-packs-init:complete');
        if (typeof recoveryRegistry.loadHistory === 'function') {
          markStartupTrace('composition:recovery-history-reconcile:start');
          await reconcileOperationStoreWithRecovery({
            operationStore,
            recoveryRegistry,
            jobs,
            outcomeActionIssuer: lifecycleOutcomeActionIssuer
          });
          markStartupTrace('composition:recovery-history-reconcile:complete');
        }
        scheduleArtifactCachePrune();
        launchOwner.assertCurrent(ownerEpoch, { startupOnly: true });
        ownerState = 'ready';
        initialized = true;
        return composition;
        })();
        return initializationPromise;
      },
      scheduleArtifactCachePrune,
      armStartupRetirement,
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
