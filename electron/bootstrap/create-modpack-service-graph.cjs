const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const { markStartupTrace } = require('../utils/startup-trace.cjs');

const { ServerMutationCoordinator } = require('../services/server-mutation-coordinator.cjs');
const { createServerMutationPolicy } = require('../services/server-mutation-policy.cjs');
const { ServerHealthValidator } = require('../services/server-health-validator.cjs');
const { DEFAULT_SERVER_HEALTH_TIMEOUT_MS } = require('../services/server-health-constants.cjs');
const { ModpackError } = require('../services/modpacks/errors.cjs');
const { normalizeRuntimeTuple } = require('../services/modpacks/contracts.cjs');
const { ArtifactCache } = require('../services/modpacks/artifacts/artifact-cache.cjs');
const { ArtifactDownloader } = require('../services/modpacks/artifacts/artifact-downloader.cjs');
const { ArchiveWorkerClient } = require('../services/modpacks/archive/archive-worker-client.cjs');
const { SelectionRegistry } = require('../services/modpacks/local/selection-registry.cjs');
const { WindowsReparseInspector } = require('../services/modpacks/local/windows-reparse-inspector.cjs');
const { PinnedHttpsClient } = require('../services/modpacks/network/pinned-https-client.cjs');
const { BoundedApiClient } = require('../services/modpacks/network/bounded-api-client.cjs');
const { ReleaseTrackingReconciler } = require('../services/modpacks/notifications/release-tracking-reconciler.cjs');
const { ReleaseTrackingStore } = require('../services/modpacks/notifications/release-tracking-store.cjs');
const { createModpackPaths } = require('../services/modpacks/paths.cjs');
const { GitHubReleasesSource } = require('../services/modpacks/providers/github-releases-source.cjs');
const { ModrinthModpackProvider } = require('../services/modpacks/providers/modrinth-modpack-provider.cjs');
const { ModpackStateRepository } = require('../services/modpacks/state/modpack-state-repository.cjs');
const { ModpackRecoveryService } = require('../services/modpack-lifecycle/modpack-recovery-service.cjs');
const { RecoveryRegistry } = require('../services/modpack-lifecycle/recovery-registry.cjs');
const { ServerRuntimeWriterAuthority } = require('../services/modpack-lifecycle/server-runtime-writer-authority.cjs');
const { createWindowsBootSequenceProvider } = require('../services/client-modpacks/client-runtime-ownership.cjs');
const { RestorePointService, normalizeMetadata } = require('../services/modpack-lifecycle/restore-point-service.cjs');
const { establishStartupRecoveryBoundary } = require('../services/modpack-lifecycle/startup-recovery-bootstrap.cjs');
const { createVerifiedRestoreExtractor } = require('../services/modpack-lifecycle/verified-restore-extractor.cjs');
const { inspectFolderEvidence } = require('../services/modpacks/instance-ownership.cjs');
const { createDurableFs } = require('../utils/durable-fs.cjs');
const { createInstanceConfigFsFactory, createLegacyInstanceConfigFs } = require('../utils/instance-config-fs.cjs');
const {
  configureServerConfigDurableFsFactory,
  readServerConfig
} = require('../utils/config-manager.cjs');
const instanceContext = require('../utils/instance-context.cjs');
const { createClientConnectionCore } = require('./create-client-connection-core.cjs');
const { WindowsDurableFsClient } = require('../utils/windows-durable-fs-client.cjs');
const { isNetworkAccess } = require('../utils/server-network-properties.cjs');
const { getRequiredJavaVersion } = require('../services/minecraft-launcher/utils.cjs');

function absoluteDirectory(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new TypeError(`${name} must be an absolute non-root path`);
  }
  return path.resolve(value);
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

// Worker verification refuses reparse points, so an install reached through a
// junction, symlink, SUBST drive or 8.3 short name uses its canonical drive-letter
// path. A path that differs from it only in letter case keeps the given spelling.
function canonicalRuntimeRoot(value, fsSync) {
  let canonical;
  try {
    canonical = fsSync.realpathSync.native(value);
  } catch {
    return value;
  }
  if (typeof canonical !== 'string' || !/^[A-Za-z]:[\\/]/u.test(canonical) ||
      canonical.toLocaleLowerCase('en-US') === value.toLocaleLowerCase('en-US')) return value;
  const resolved = path.resolve(canonical);
  return resolved === path.parse(resolved).root ? value : resolved;
}

// Coordinator operation ids allow only letters, digits, '_' and '-'; channels such
// as 'backups:delete' and 'mod-watch:add' contain ':'.
function channelOperationId(channel, randomUUID) {
  return `${channel.replace(/[^A-Za-z0-9_-]/g, '-')}-${randomUUID()}`;
}

function freezeRecord(value) {
  return Object.freeze({ ...(value || {}) });
}

function normalizedClock(value) {
  if (typeof value === 'function') return Object.freeze({ now: value });
  if (!value || typeof value !== 'object' || typeof value.now !== 'function') throw new TypeError('clock must provide now()');
  return value;
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'Startup recovery services could not be composed safely', { cause });
}

function recoveryClock(clock) {
  return () => {
    const value = clock.now();
    const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(result.getTime())) throw recoveryRequired();
    return result;
  };
}

function sameLocalPath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32'
    ? first.toLocaleLowerCase('en-US') === second.toLocaleLowerCase('en-US')
    : first === second;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function minimalAllowedRoots(values) {
  const roots = [...new Set(values.map(value => path.resolve(value)))];
  return roots.filter(candidate => !roots.some(other => !sameLocalPath(candidate, other) && isWithin(other, candidate)));
}

function durableWorkerPaths(runtimeRoots) {
  if (runtimeRoots.isPackaged) {
    return Object.freeze({
      workerPath: path.join(runtimeRoots.resourcesPath, 'archive', 'worker', 'ArchiveWorker.exe'),
      workerManifestPath: path.join(runtimeRoots.resourcesPath, 'archive', 'manifests', 'archive-worker-x64.json')
    });
  }
  return Object.freeze({
    workerPath: path.join(runtimeRoots.runtimeRoot, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe'),
    workerManifestPath: path.join(runtimeRoots.runtimeRoot, 'build-resources', 'archive-runtime', 'archive-worker-x64.json')
  });
}

function createProductionDurableFsFactory({
  fsSync,
  fsPromises,
  randomUUID,
  runtimeRoots,
  userDataPath,
  requireConfirmedClose = false,
  durableClientFactory = options => new WindowsDurableFsClient(options)
}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) ||
      typeof durableClientFactory !== 'function') {
    throw new TypeError('Production durable filesystem dependencies are invalid');
  }
  const worker = durableWorkerPaths(runtimeRoots);
  const appOwnedRoot = path.join(path.resolve(userDataPath), 'archive-worker', 'durable-fs');
  return rootsValue => {
    const allowedRoots = minimalAllowedRoots(rootsValue);
    try {
      const durableClient = durableClientFactory({
        workerPath: worker.workerPath,
        workerManifestPath: worker.workerManifestPath,
        allowedRoots,
        appOwnedRoot,
        requireConfirmedClose
      });
      return createDurableFs({
        fsApi: fsSync,
        asyncFsApi: fsPromises,
        durableClient,
        allowedRoots,
        tempNameFactory: randomUUID
      });
    } catch (error) {
      throw recoveryRequired(error);
    }
  };
}

function pathAlias(value) {
  return path.resolve(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function matchingInstance(instances, record) {
  return instances.find(item => item && item.id === record.target.stableServerId &&
    typeof item.path === 'string' && pathAlias(item.path) === pathAlias(record.target.path)) || null;
}

function createLiveInstanceResolver({ store, isInstanceRunning } = {}) {
  if (!store || typeof store.get !== 'function' || typeof isInstanceRunning !== 'function') {
    throw new TypeError('Live instance resolver dependencies are invalid');
  }
  return Object.freeze({
    async resolveInstance(instanceId) {
      if (typeof instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(instanceId)) {
        throw new ModpackError('INVALID_REQUEST', 'The modpack instance request is invalid');
      }
      const instances = store.get('instances');
      if (!Array.isArray(instances)) throw new ModpackError('PLAN_STALE', 'The reviewed server instance is no longer available');
      const matches = instances.filter(item => item && item.id === instanceId);
      if (matches.length !== 1 || matches[0].type !== 'server' || typeof matches[0].path !== 'string' ||
          !path.isAbsolute(matches[0].path)) {
        throw new ModpackError('PLAN_STALE', 'The reviewed server instance is no longer available');
      }
      const serverPath = absoluteDirectory(matches[0].path, 'serverPath');
      const priorRunning = isInstanceRunning({ instanceId, targetPath: serverPath, serverPath }) === true;
      return Object.freeze({ instanceId, serverPath, priorRunning });
    }
  });
}

function recoveryInstanceName(store, record) {
  const current = Array.isArray(store.get('instances')) ? store.get('instances') : [];
  return matchingInstance(current, record)?.name || record.outcome?.registration?.name ||
    record.outcome?.target?.name || path.basename(record.target.path);
}

function createUnregisterPublishedInstance(store) {
  return async record => {
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw recoveryRequired();
    const current = store.get('instances');
    if (!Array.isArray(current)) throw recoveryRequired();
    const idMatches = current.filter(item => item?.id === record.target.stableServerId);
    const pathMatches = current.filter(item => typeof item?.path === 'string' &&
      pathAlias(item.path) === pathAlias(record.target.path));
    if (idMatches.length === 0 && pathMatches.length === 0) {
      instanceContext.updateInstances(current);
      return Object.freeze({ unregistered: true, alreadyAbsent: true });
    }
    if (idMatches.length !== 1 || pathMatches.length !== 1 || idMatches[0] !== pathMatches[0] ||
        idMatches[0].type !== 'server') throw recoveryRequired();
    const next = current.filter(item => item !== idMatches[0]);
    store.set('instances', next);
    const persisted = store.get('instances');
    if (!Array.isArray(persisted) || persisted.some(item => item?.id === record.target.stableServerId ||
      (typeof item?.path === 'string' && pathAlias(item.path) === pathAlias(record.target.path)))) throw recoveryRequired();
    instanceContext.updateInstances(persisted);
    return Object.freeze({ unregistered: true, alreadyAbsent: false });
  };
}

function createRevisionPublisher() {
  const published = new Set();
  return Object.freeze({
    async publishOnce(event) {
      if (!event || typeof event.eventId !== 'string') throw recoveryRequired();
      if (published.has(event.eventId)) return Object.freeze({ published: true, duplicate: true });
      const eventBus = require('../utils/event-bus.cjs');
      eventBus.emit('server-content-revision-changed', Object.freeze({ ...event }));
      published.add(event.eventId);
      return Object.freeze({ published: true, duplicate: false });
    }
  });
}

function createRecoveryRuntimePolicy() {
  const { createRecoveryRuntimePolicy: createPolicy } = require('../services/auto-restart.cjs');
  return createPolicy({
    runtimeController: Object.freeze({
      async ensureStopped(request) {
        const { shutdownMinecraftServer } = require('../services/server-manager.cjs');
        return shutdownMinecraftServer({ instanceId: request.instanceId, targetPath: request.serverPath }, {
          gracefulTimeoutMs: 8000,
          killTimeoutMs: 5000,
          forceKill: true
        });
      },
      adoptValidatedHandoff(request) {
        const { adoptValidatedLifecycleProcess } = require('../services/server-manager.cjs');
        return adoptValidatedLifecycleProcess(request);
      }
    })
  });
}

function runtimeOutcome(record, authority) {
  const outcome = record.outcome?.runtime;
  const selected = outcome?.[authority];
  if (!selected) return null;
  return Object.freeze({
    runtime: selected.runtime || selected,
    maxRam: selected.maxRam ?? outcome.maxRam,
    networkAccess: isNetworkAccess(selected.networkAccess)
      ? selected.networkAccess
      : (isNetworkAccess(outcome.networkAccess) ? outcome.networkAccess : 'pack-default'),
    port: selected.port ?? outcome.port
  });
}

const RECOVERY_LOADER_ALIASES = Object.freeze({
  'fabric-loader': 'fabric',
  fabricloader: 'fabric',
  'forge-loader': 'forge',
  'neo-forge': 'neoforge',
  neo_forge: 'neoforge',
  'quilt-loader': 'quilt',
  quiltloader: 'quilt'
});

function deriveRecoveryRuntimeTuple(config) {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw recoveryRequired();
    const minecraftVersion = typeof config.version === 'string' ? config.version.trim() : '';
    const rawLoader = config.loader || (config.fabric ? 'fabric' : 'vanilla');
    const normalizedLoader = typeof rawLoader === 'string' ? rawLoader.trim().toLocaleLowerCase('en-US') : '';
    const loaderFamily = RECOVERY_LOADER_ALIASES[normalizedLoader] || normalizedLoader;
    const selectedLoaderVersion = config.loaderVersion ?? (loaderFamily === 'fabric' ? config.fabric : null) ??
      (loaderFamily === 'vanilla' ? minecraftVersion : null);
    const loaderVersion = typeof selectedLoaderVersion === 'string'
      ? selectedLoaderVersion.trim()
      : String(selectedLoaderVersion ?? '').trim();
    const explicitJava = config.javaMajor ?? config.javaVersion;
    const parsedJava = Number.isSafeInteger(explicitJava)
      ? explicitJava
      : (typeof explicitJava === 'string' && /^\d{1,2}$/u.test(explicitJava.trim())
          ? Number(explicitJava.trim())
          : null);
    return normalizeRuntimeTuple({
      minecraftVersion,
      loaderFamily,
      loaderVersion,
      javaMajor: parsedJava ?? getRequiredJavaVersion(minecraftVersion),
      os: 'win32',
      architecture: 'x64'
    });
  } catch (error) {
    throw recoveryRequired(error);
  }
}

function createRuntimeConfigResolver({ fsSync, record, stateRepository }) {
  return async ({ authority }) => {
    const durable = runtimeOutcome(record, authority);
    if (durable?.runtime && typeof durable.maxRam === 'number' && Number.isSafeInteger(durable.port)) return durable;
    const candidates = (authority === 'source'
      ? [record.rollbackPath, record.target.path, record.failedPath, record.candidatePath]
      : [record.target.path, record.candidatePath, record.failedPath, record.rollbackPath])
      .filter(value => typeof value === 'string');
    let serverPath = null;
    let persisted = null;
    for (const candidate of candidates) {
      try {
        const stat = fsSync.lstatSync(candidate, { bigint: true, throwIfNoEntry: false });
        if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
        if (!serverPath) serverPath = candidate;
        const loaded = stateRepository.read(candidate);
        if (loaded?.state?.runtime) {
          serverPath = candidate;
          persisted = loaded.state.runtime;
          break;
        }
      } catch { /* another candidate may still carry the exact runtime tuple */ }
    }
    if (!serverPath) throw recoveryRequired();
    const { readServerConfig } = require('../utils/config-manager.cjs');
    const config = readServerConfig(serverPath);
    if (!config || typeof config.maxRam !== 'number' || !Number.isSafeInteger(config.port)) throw recoveryRequired();
    return Object.freeze({
      runtime: durable?.runtime || persisted || deriveRecoveryRuntimeTuple(config),
      maxRam: durable?.maxRam ?? config.maxRam,
      networkAccess: durable?.networkAccess ?? config.networkAccess,
      port: durable?.port ?? config.port
    });
  };
}

async function validateRecoveryDirectory(fsSync, reparseInspector, directoryPath) {
  const stat = fsSync.lstatSync(directoryPath, { bigint: true, throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() ||
      !sameLocalPath(fsSync.realpathSync.native(directoryPath), directoryPath) ||
      await reparseInspector.isReparsePoint(directoryPath) !== false) throw recoveryRequired();
  return true;
}

function decodeJson(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (JSON.stringify(value, null, 2) + '\n' !== text) throw recoveryRequired();
    return value;
  } catch (error) {
    throw recoveryRequired(error);
  }
}

function restoreReference(serverPath, metadata) {
  const backupPath = path.join(serverPath, 'backups');
  return Object.freeze({
    id: metadata.id,
    name: metadata.name,
    sha256: metadata.sha256,
    size: metadata.size,
    scopeSha256: metadata.scopeSha256,
    sourceRevision: metadata.sourceRevision,
    sourceRuntime: Object.freeze({ ...metadata.sourceRuntime }),
    operationId: metadata.operationId,
    createdAt: metadata.createdAt,
    serverPath,
    archivePath: path.join(backupPath, metadata.name),
    metadataPath: path.join(backupPath, metadata.name.replace(/\.zip$/u, '.json'))
  });
}

function createRestoreInfrastructure({ clock, durableFor, fsSync, randomUUID, reparseInspector }) {
  const serviceByRoot = new Map();
  function durableForServer(serverPath) {
    return durableFor([path.dirname(serverPath)]);
  }
  function serviceFor(serverPath) {
    const key = pathAlias(path.dirname(serverPath));
    if (!serviceByRoot.has(key)) {
      const durableFs = durableForServer(serverPath);
      serviceByRoot.set(key, new RestorePointService({
        fsApi: fsSync,
        durableFs,
        clock,
        randomUUID,
        retirementDurableFsFor: parentPath => durableFor([parentPath]),
        extractVerifiedArchiveFn: createVerifiedRestoreExtractor({
          fsApi: fsSync,
          durableFs,
          reparseInspector
        })
      }));
    }
    return serviceByRoot.get(key);
  }
  const facade = Object.freeze({
    withExactRetirementPoint(candidate, options, work) {
      return serviceFor(options.authority.selector.serverPath).withExactRetirementPoint(candidate, options, work);
    },
    cleanupInterruptedRestorePointCreation(request) {
      return serviceFor(request.serverPath).cleanupInterruptedRestorePointCreation(request);
    },
    listAvailableRestorePoints(request) {
      return serviceFor(request.serverPath).listAvailableRestorePoints(request);
    },
    resolveRestorePoint(request, options) { return serviceFor(request.serverPath).resolveRestorePoint(request, options); },
    verifyRestorePoint(reference) { return serviceFor(reference.serverPath).verifyRestorePoint(reference); },
    restoreToFreshCandidate(reference, destination) {
      return serviceFor(reference.serverPath).restoreToFreshCandidate(reference, destination);
    }
  });
  async function resolve(record, context) {
    const roots = [record.target.path, record.failedPath, record.candidatePath, record.rollbackPath]
      .filter(value => typeof value === 'string');
    const matches = [];
    const seen = new Set();
    for (const serverPath of roots) {
      const key = pathAlias(serverPath);
      if (seen.has(key)) continue;
      seen.add(key);
      try { await validateRecoveryDirectory(fsSync, reparseInspector, serverPath); }
      catch { continue; }
      const backupPath = path.join(serverPath, 'backups');
      try { await validateRecoveryDirectory(fsSync, reparseInspector, backupPath); }
      catch { continue; }
      const names = fsSync.readdirSync(backupPath).filter(name => /^restore-point-[A-Za-z0-9._-]{1,180}\.json$/u.test(name)).sort();
      for (const name of names) {
        try {
          const metadataPath = path.join(backupPath, name);
          const bytes = context.durableFs.readFileBounded(metadataPath, { maxBytes: 16 * 1024 * 1024 });
          const metadata = normalizeMetadata(decodeJson(bytes));
          if (metadata.id !== record.restorePoint.id || metadata.sha256 !== record.restorePoint.sha256 ||
              name !== metadata.name.replace(/\.zip$/u, '.json')) continue;
          const reference = restoreReference(serverPath, metadata);
          const archiveStat = fsSync.lstatSync(reference.archivePath, { bigint: true, throwIfNoEntry: false });
          if (!archiveStat?.isFile() || archiveStat.isSymbolicLink()) throw recoveryRequired();
          matches.push(reference);
        } catch (error) {
          if (error instanceof ModpackError) throw error;
          throw recoveryRequired(error);
        }
      }
    }
    if (matches.length !== 1) throw recoveryRequired();
    return matches[0];
  }
  return Object.freeze({ resolve, service: facade });
}

async function createProductionRecoveryServices(input) {
  const {
    clock, coordinator, fsSync, randomUUID, runtimeRoots, store, userDataPath
  } = input;
  try {
    fsSync.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const durableFor = input.durableFsFactory || createProductionDurableFsFactory({
      fsSync,
      randomUUID,
      runtimeRoots,
      userDataPath,
      requireConfirmedClose: true
    });
    const registryDurableFs = durableFor([userDataPath]);
    const now = recoveryClock(clock);
    const registry = new RecoveryRegistry({
      userDataPath,
      fsApi: fsSync,
      durableFs: registryDurableFs,
      clock: now,
      randomUUID
    });
    const releaseTrackingStore = input.releaseTrackingStore || new ReleaseTrackingStore({
      userDataPath,
      fsApi: fsSync,
      durableFs: registryDurableFs,
      clock: now
    });
    markStartupTrace('recovery:release-tracking-init:start');
    await releaseTrackingStore.initialize();
    markStartupTrace('recovery:release-tracking-init:complete');
    const releaseTrackingReconciler = input.releaseTrackingReconciler || new ReleaseTrackingReconciler({
      trackingStore: releaseTrackingStore,
      recoveryRegistry: registry,
      clock: now
    });
    const reparseInspector = input.reparseInspector || new WindowsReparseInspector();
    const healthValidator = input.healthValidator || new ServerHealthValidator({ coordinator });
    const runtimePolicy = input.runtimePolicy || createRecoveryRuntimePolicy();
    const runtimeWriterAuthority = new ServerRuntimeWriterAuthority({ registry, coordinator,
      getBootSequence: input.runtimeWriterGetBootSequence || createWindowsBootSequenceProvider() });
    const revisionPublisher = input.revisionPublisher || createRevisionPublisher();
    const restore = createRestoreInfrastructure({
      clock: now,
      durableFor,
      fsSync,
      randomUUID,
      reparseInspector
    });
    const unregisterPublishedInstance = createUnregisterPublishedInstance(store);
    const contextFactory = async ({ record, mutationLease }) => {
      const durableFs = durableFor([userDataPath, path.dirname(record.target.path)]);
      const stateRepository = new ModpackStateRepository({ fsApi: fsSync, durableFs, clock: now });
      const durableRuntime = runtimeOutcome(record, 'target') || runtimeOutcome(record, 'source');
      return {
        appStore: store,
        durableFs,
        fsApi: fsSync,
        healthTimeoutMs: input.healthTimeoutMs || DEFAULT_SERVER_HEALTH_TIMEOUT_MS,
        healthValidator,
        instanceContext,
        jobId: record.jobId,
        maxRam: durableRuntime?.maxRam,
        mutationLease,
        name: recoveryInstanceName(store, record),
        networkAccess: durableRuntime?.networkAccess,
        operationKind: record.operationKind,
        port: durableRuntime?.port,
        recoveryRegistry: registry,
        reparseInspector,
        resolveRecoveryRuntimeConfig: createRuntimeConfigResolver({ fsSync, record, stateRepository }),
        revisionPublisher,
        runtime: durableRuntime?.runtime,
        runtimePolicy,
        releaseTrackingReconciler,
        stableInstanceId: record.target.stableServerId,
        stateRepository,
        targetPath: record.target.path,
        unregisterPublishedInstance
      };
    };
    const recoveryService = new ModpackRecoveryService({
      coordinator,
      recoveryRegistry: registry,
      contextFactory,
      runtimePolicy,
      runtimeWriterAuthority,
      restorePointResolver: restore.resolve,
      restorePointService: restore.service
    });
    const runtimeVerifier = input.runtimeVerifier || Object.freeze({
      async verifyBeforeRecovery() {
        try {
          const lease = await coordinator.acquireStart({
            instanceId: 'startup-recovery-probe',
            serverPath: userDataPath
          }, {
            operation: 'startup-recovery-probe',
            operationId: 'startup-recovery-probe'
          });
          await lease?.release?.();
          return Object.freeze({ quiescent: false });
        } catch (error) {
          return Object.freeze({ quiescent: error?.code === 'RECOVERY_REQUIRED' });
        }
      }
    });
    return Object.freeze({
      registry,
      recoveryService,
      runtimePolicy,
      runtimeWriterAuthority,
      runtimeVerifier,
      restorePointService: restore.service,
      releaseTrackingStore,
      releaseTrackingReconciler
    });
  } catch (error) {
    throw recoveryRequired(error);
  }
}

function createModpackServiceGraph(deps = {}) {
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) throw new TypeError('Service graph dependencies are invalid');
  const app = deps.app;
  const store = deps.store;
  if (!app || typeof app !== 'object' || !store || typeof store.get !== 'function') {
    throw new TypeError('Service graph requires app and store');
  }

  const userDataPath = absoluteDirectory(deps.userDataPath || app.getPath?.('userData'), 'userData');
  const fsSync = deps.fsSync || fs;
  const suppliedRoots = deps.runtimeRoots || {};
  const defaultRuntimeRoot = path.resolve(__dirname, '..', '..');
  const runtimeRoots = Object.freeze({
    resourcesPath: canonicalRuntimeRoot(absoluteDirectory(suppliedRoots.resourcesPath || process.resourcesPath || defaultRuntimeRoot, 'resourcesPath'), fsSync),
    runtimeRoot: canonicalRuntimeRoot(absoluteDirectory(suppliedRoots.runtimeRoot || defaultRuntimeRoot, 'runtimeRoot'), fsSync),
    isPackaged: suppliedRoots.isPackaged === undefined ? Boolean(app.isPackaged) : suppliedRoots.isPackaged,
    arch: suppliedRoots.arch || process.arch
  });
  if (typeof runtimeRoots.isPackaged !== 'boolean' || typeof runtimeRoots.arch !== 'string' || !runtimeRoots.arch) {
    throw new TypeError('Runtime roots are invalid');
  }

  const clock = normalizedClock(deps.clock || { now: () => Date.now() });
  const fsPromises = deps.fsPromises || fsp;
  const dnsLookup = requireFunction(deps.dnsLookup || dns.promises.lookup, 'dnsLookup');
  const httpsRequest = requireFunction(deps.httpsRequest || https.request, 'httpsRequest');
  const randomUUID = requireFunction(deps.randomUUID || crypto.randomUUID, 'randomUUID');
  const randomBytes = requireFunction(deps.randomBytes || crypto.randomBytes, 'randomBytes');
  const processFactory = requireFunction(deps.processFactory || childProcess.spawn, 'processFactory');
  const workerFactory = requireFunction(deps.workerFactory || (options => new ArchiveWorkerClient(options)), 'workerFactory');
  const windowFactory = requireFunction(deps.windowFactory, 'windowFactory');
  const productionDurableFsFactory = requireFunction(
    deps.durableFsFactory || createProductionDurableFsFactory({ fsSync, fsPromises, randomUUID, runtimeRoots, userDataPath }),
    'durableFsFactory'
  );
  const clientDurableFsFactory = deps.clientDurableFsFactory || createProductionDurableFsFactory({
    fsSync, fsPromises, randomUUID, runtimeRoots, userDataPath, requireConfirmedClose: true
  });
  // Instance configs and their revision counters: a folder without modpack
  // evidence keeps the v26.6.1 writer (no ArchiveWorker); any evidence, or
  // evidence that cannot be ruled out, keeps the strict production writer.
  // Every modpack lifecycle path below keeps productionDurableFsFactory.
  const instanceConfigFsFactory = createInstanceConfigFsFactory({
    strictFactory: productionDurableFsFactory,
    inspect: folder => inspectFolderEvidence(folder, { fsApi: fsSync }),
    legacyFs: createLegacyInstanceConfigFs({ fsApi: fsSync, tempNameFactory: randomUUID })
  });

  const modpackPaths = createModpackPaths(userDataPath);
  const paths = Object.freeze({ userData: userDataPath, modpacks: modpackPaths });
  const http = deps.httpClient || new PinnedHttpsClient({ lookup: dnsLookup, request: httpsRequest });
  if (!http || typeof http.request !== 'function') throw new TypeError('HTTP client is invalid');
  const modrinthApi = deps.modrinthApiClient || new BoundedApiClient({
    client: http,
    baseUrl: 'https://api.modrinth.com/v2/'
  });
  const githubApi = deps.githubApiClient || new BoundedApiClient({
    client: http,
    baseUrl: 'https://api.github.com/',
    maxRedirects: 1
  });

  const providerAdapters = deps.providerAdapters || {};
  if (!providerAdapters || typeof providerAdapters !== 'object' || Array.isArray(providerAdapters)) {
    throw new TypeError('Provider adapters are invalid');
  }
  const providers = Object.freeze({
    modrinth: providerAdapters.modrinth || new ModrinthModpackProvider({ http: modrinthApi }),
    github: providerAdapters.github || new GitHubReleasesSource({ http: githubApi, clock }),
    local: providerAdapters.local || null
  });

  const artifactCache = deps.artifactCache || new ArtifactCache({
    root: modpackPaths.cache,
    workspaceRoot: modpackPaths.workspaces,
    fsApi: fsPromises,
    fsSyncApi: fsSync,
    clock: () => clock.now(),
    durabilityRoot: userDataPath,
    durableFsFactory: () => productionDurableFsFactory(Object.freeze([userDataPath]))
  });
  const artifactDownloader = deps.artifactDownloader || new ArtifactDownloader({
    client: http,
    cache: artifactCache,
    partialRoot: path.join(modpackPaths.cache, 'partial'),
    fsApi: fsPromises,
    randomUUID
  });
  const selectionRegistry = deps.selectionRegistry || new SelectionRegistry({
    clock: () => clock.now(),
    randomId: () => randomBytes(24).toString('base64url')
  });

  const suppliedCoordinatorOptions = deps.coordinatorOptions || {};
  const coordinatorOptionsArePlain = suppliedCoordinatorOptions && typeof suppliedCoordinatorOptions === 'object' &&
    !Array.isArray(suppliedCoordinatorOptions) && Object.getPrototypeOf(suppliedCoordinatorOptions) === Object.prototype;
  const coordinatorHasDurability = coordinatorOptionsArePlain &&
    (Object.hasOwn(suppliedCoordinatorOptions, 'durableFs') ||
      Object.hasOwn(suppliedCoordinatorOptions, 'durableFsFactory'));
  const coordinatorOptions = coordinatorOptionsArePlain && !coordinatorHasDurability
    ? { ...suppliedCoordinatorOptions, durableFsFactory: instanceConfigFsFactory }
    : suppliedCoordinatorOptions;
  const coordinator = deps.coordinator || new ServerMutationCoordinator(coordinatorOptions);
  const clientPackIpcDisposers = new Set();
  // Client resolution and management sessions need no modpack services: built
  // now (no I/O), shared with the composition, and disposed after it.
  const clientConnectionCore = createClientConnectionCore({
    store,
    readClientConfig: deps.readClientConfig,
    getPinnedHttpsAgent: deps.getPinnedHttpsAgent,
    managementSessionRequestJson: deps.managementSessionRequestJson,
    randomUUID,
    clock
  });
  const beginManagedLaunch = request => {
    if (!modpackServices?.clientPackIntegration) throw new ModpackError('CLIENT_PACK_UNAVAILABLE', 'Matching client services are not ready');
    return modpackServices.clientPackIntegration.beginManagedLaunch(request);
  };
  // Read-only classification. A composition without an observer keeps the strict
  // repository, which answers the same where the observer answers and refuses more.
  const getStateObserver = () => modpackServices?.stateObserver || modpackServices?.stateRepository || null;
  const serverMutationPolicy = deps.serverMutationPolicy || createServerMutationPolicy({
    coordinator,
    getClientPackIntegration: () => modpackServices?.clientPackIntegration || null,
    getModpackStateRepository: getStateObserver,
    getInstances: () => store.get('instances') || [],
    createOperationId: channel => channelOperationId(channel, randomUUID)
  });
  let recoveryServices = null;
  let rawRecoveryServices = null;
  let recoveryPromise = null;
  const recoveryFactory = deps.recoveryFactory || createProductionRecoveryServices;
  if (typeof recoveryFactory !== 'function') throw new TypeError('Recovery factory is invalid');
  const recovery = Object.freeze({
    initialize() {
      if (!recoveryPromise) {
        recoveryPromise = (async () => {
          markStartupTrace('recovery:factory:start');
          const services = await recoveryFactory({
            clock,
            coordinator,
            durableFsFactory: deps.recoveryDurableFsFactory || deps.durableFsFactory || createProductionDurableFsFactory({
              fsSync, fsPromises, randomUUID, runtimeRoots, userDataPath, requireConfirmedClose: true
            }),
            fsSync,
            healthTimeoutMs: deps.recoveryHealthTimeoutMs,
            healthValidator: deps.recoveryHealthValidator,
            randomUUID,
            reparseInspector: deps.recoveryReparseInspector,
            revisionPublisher: deps.recoveryRevisionPublisher,
            runtimePolicy: deps.recoveryRuntimePolicy,
            runtimeRoots,
            runtimeVerifier: deps.recoveryRuntimeVerifier,
            runtimeWriterGetBootSequence: deps.runtimeWriterGetBootSequence,
            store,
            userDataPath
          });
          markStartupTrace('recovery:factory:complete');
          if (!services || typeof services !== 'object' ||
              !services.registry || typeof services.registry.initialize !== 'function' ||
              !services.recoveryService || typeof services.recoveryService.recoverAll !== 'function' ||
              !services.runtimeVerifier || (typeof services.runtimeVerifier !== 'function' &&
                typeof services.runtimeVerifier.verifyBeforeRecovery !== 'function')) throw recoveryRequired();
          rawRecoveryServices = services;
          recoveryServices = Object.freeze({ ...services });
          return establishStartupRecoveryBoundary({
            coordinator,
            registry: recoveryServices.registry,
            runtimeVerifier: recoveryServices.runtimeVerifier
          });
        })();
      }
      return recoveryPromise;
    },
    getServices() { return recoveryServices; }
  });

  const runningProbe = deps.isInstanceRunning || ((selector) => {
    const { isInstanceRunning } = require('../services/server-manager.cjs');
    return isInstanceRunning(selector);
  });
  const instanceResolver = deps.instanceResolver || createLiveInstanceResolver({ store, isInstanceRunning: runningProbe });
  const modpackFactory = deps.modpackFactory || ((input) => {
    const { createProductionModpackComposition } = require('./create-production-modpack-composition.cjs');
    return createProductionModpackComposition(input);
  });
  if (typeof modpackFactory !== 'function') throw new TypeError('Modpack composition factory is invalid');
  let modpackServices = null;
  let modpackPromise = null;
  async function initializeModpacks() {
    if (!modpackPromise) {
      markStartupTrace('composition:factory:start');
      modpackPromise = Promise.resolve(modpackFactory({
        app,
        artifactCache,
        artifactDownloader,
        clock,
        coordinator,
        dialog: deps.dialog || null,
        durableFsFactory: deps.modpackDurableFsFactory || deps.recoveryDurableFsFactory ||
          productionDurableFsFactory,
        clientDurableFsFactory,
        clientConnectionCore,
        clientWorkerDurableConfig: { ...durableWorkerPaths(runtimeRoots), appOwnedRoot: path.join(userDataPath, 'archive-worker', 'durable-fs') },
        fsPromises,
        fsSync,
        getWindow: deps.getWindow || (() => null),
        http,
        instanceResolver,
        Notification: deps.ipc?.nativeNotificationsEnabled === false ? null : (deps.Notification || null),
        paths,
        processFactory,
        providers,
        randomBytes,
        randomUUID,
        rawRecoveryServices,
        recoveryServices,
        reparseInspector: deps.reparseInspector || deps.recoveryReparseInspector || null,
        runtimeRoots,
        selectionRegistry,
        shell: deps.shell || null,
        store,
        userDataPath,
        workerFactory
      })).then(async services => {
        markStartupTrace('composition:factory:complete');
        if (!services || typeof services !== 'object') throw new TypeError('Modpack composition is invalid');
        if (services.providers !== undefined && (!services.providers || typeof services.providers !== 'object' ||
            !services.providers.modrinth || !services.providers.github)) {
          throw new TypeError('Modpack composition providers are invalid');
        }
        if (typeof services.initialize === 'function') {
          markStartupTrace('composition:initialize:start');
          await services.initialize();
          markStartupTrace('composition:initialize:complete');
        }
        modpackServices = services;
        return services;
      });
    }
    return modpackPromise;
  }

  const modpacks = {};
  Object.defineProperties(modpacks, {
    stateRepository: { enumerable: true, get: () => modpackServices?.stateRepository || null },
    stateObserver: { enumerable: true, get: getStateObserver },
    clientPackService: { enumerable: true, get: () => modpackServices?.clientPackService || null },
    companionService: { enumerable: true, get: () => modpackServices?.companionService || null },
    clientPackIntegration: { enumerable: true, get: () => modpackServices?.clientPackIntegration || null },
    listActiveClientMutations: { enumerable: true, get: () => modpackServices?.listActiveClientMutations || null },
    managementSessionBroker: { enumerable: true, get: () => clientConnectionCore.managementSessionBroker },
    resolveClientByPath: { enumerable: true, get: () => clientConnectionCore.resolveClientByPath },
    acquireLegacyManagementContext: { enumerable: true, get: () => clientConnectionCore.acquireLegacyManagementContext },
    providers: { enumerable: true, get: () => modpackServices?.providers || providers },
    localArtifactSource: { enumerable: true, get: () => modpackServices?.localArtifactSource || null },
    destinationReservationService: { enumerable: true, get: () => modpackServices?.destinationReservationService || null },
    lifecycleService: { enumerable: true, get: () => modpackServices?.lifecycleService || null },
    recoveryService: { enumerable: true, get: () => modpackServices?.recoveryService || null },
    notificationStore: { enumerable: true, get: () => modpackServices?.notificationStore || null },
    releaseMonitor: { enumerable: true, get: () => modpackServices?.releaseMonitor || null },
    releaseTrackingStore: { enumerable: true, get: () => modpackServices?.releaseTrackingStore || null },
    outcomeActionService: { enumerable: true, get: () => modpackServices?.outcomeActionService || null }
  });
  Object.freeze(modpacks);
  const startupInput = deps.startup || {};
  if (startupInput.automaticReleaseChecksEnabled !== undefined &&
      typeof startupInput.automaticReleaseChecksEnabled !== 'boolean') {
    throw new TypeError('Automatic release-check startup policy is invalid');
  }
  const automaticReleaseChecksEnabled = startupInput.automaticReleaseChecksEnabled !== false;
  const initializeServerConfig = async () => {
    const instances = store.get('instances') || [];
    const serverInstances = Array.isArray(instances)
      ? instances.filter(instance => instance && instance.type === 'server' &&
        typeof instance.path === 'string' && instance.path && fsSync.existsSync(instance.path))
      : [];
    const selectedPath = store.get('lastServerPath');
    let selected = serverInstances.find(instance => instance.path === selectedPath) || null;
    if (!selected) selected = serverInstances[0] || null;
    if (!selected) {
      if (selectedPath && typeof store.set === 'function') store.set('lastServerPath', null);
      return null;
    }
    if (selected.path !== selectedPath && typeof store.set === 'function') {
      store.set('lastServerPath', selected.path);
    }

    const serverSettings = store.get('serverSettings') || {
      port: 25565,
      maxRam: 4,
      autoStartMinecraft: false,
      autoStartManagement: false
    };
    const autoRestart = store.get('autoRestart') || { enabled: false, delay: 10, maxCrashes: 3 };
    const defaultConfig = {
      version: null,
      port: serverSettings.port,
      maxRam: serverSettings.maxRam,
      autoRestart: {
        enabled: autoRestart.enabled,
        delay: autoRestart.delay,
        maxCrashes: autoRestart.maxCrashes
      }
    };
    const config = readServerConfig(selected.path, defaultConfig);
    if (!config) {
      throw new ModpackError('INVALID_REQUEST', 'The selected server configuration could not be inspected');
    }
    return Object.freeze(config);
  };
  const recoveryInitializer = startupInput.initializeRecovery || recovery.initialize;
  if (typeof recoveryInitializer !== 'function') throw new TypeError('Startup recovery initializer is invalid');
  let startupPromise = null;
  const initializeRecovery = graph => {
    if (!startupPromise) {
      startupPromise = Promise.resolve(recoveryInitializer(graph)).then(async result => {
        await initializeModpacks();
        return result;
      });
    }
    return startupPromise;
  };
  const afterWindowCreated = async (window, graph) => {
    if (typeof startupInput.afterWindowCreated === 'function') await startupInput.afterWindowCreated(window, graph);
    modpackServices?.nativeNotificationBridge?.start?.();
    if (automaticReleaseChecksEnabled) await modpackServices?.releaseMonitor?.start?.();
    if (typeof startupInput.waitForWindowNavigationReady === 'function' &&
        typeof modpackServices?.armStartupRetirement === 'function') {
      let ready;
      try { ready = startupInput.waitForWindowNavigationReady(window); }
      catch { ready = Promise.resolve(false); }
      modpackServices.armStartupRetirement(Promise.resolve(ready));
    }
  };
  const dispose = async graph => {
    try {
      modpackServices?.releaseMonitor?.stop?.();
      modpackServices?.nativeNotificationBridge?.stop?.();
      await Promise.all([...clientPackIpcDisposers].map(disposeIpc => disposeIpc()));
      await modpackServices?.dispose?.();
      if (typeof startupInput.dispose === 'function') await startupInput.dispose(graph);
    } finally {
      // Last: client pack work that is still settling may use its sessions. A session
      // read nothing tracks (a local edit's or a launch's requirement check) ends at
      // its own deadline or here.
      clientConnectionCore.dispose();
    }
  };
  const scheduleArtifactCachePrune = () => {
    try { return modpackServices?.scheduleArtifactCachePrune?.() === true; }
    catch { return false; }
  };
  const startup = Object.freeze({
    initializeRecovery,
    initializeServerConfig,
    cleanupRuntime: startupInput.cleanupRuntime || null,
    scheduleArtifactCachePrune,
    markTiming: startupInput.markTiming || null,
    installSecurity: startupInput.installSecurity || null,
    configureAfterReady: startupInput.configureAfterReady || null,
    afterWindowCreated,
    dispose
  });

  configureServerConfigDurableFsFactory(instanceConfigFsFactory);

  return Object.freeze({
    app,
    store,
    paths,
    runtimeRoots,
    clock,
    filesystem: Object.freeze({ sync: fsSync, promises: fsPromises }),
    network: Object.freeze({ lookup: dnsLookup, request: httpsRequest, http }),
    random: Object.freeze({ randomUUID, randomBytes }),
    factories: Object.freeze({ worker: workerFactory, process: processFactory }),
    providers,
    artifacts: Object.freeze({ cache: artifactCache, downloader: artifactDownloader, selections: selectionRegistry }),
    coordinator,
    serverMutationPolicy,
    clientPackLaunchOptions: Object.freeze({
      beginManagedLaunch,
      acquireLegacyManagementContext: clientConnectionCore.acquireLegacyManagementContext
    }),
    registerClientPackIpcDisposer(disposeIpc) {
      if (typeof disposeIpc !== 'function') throw new TypeError('Client IPC disposer is invalid');
      clientPackIpcDisposers.add(disposeIpc);
    },
    recovery,
    modpacks,
    ipc: freezeRecord(deps.ipc),
    window: Object.freeze({ create: windowFactory, get: deps.getWindow || null }),
    updater: deps.updater || null,
    tray: deps.tray || null,
    watchdog: deps.watchdog || null,
    get nativeNotifications() { return deps.nativeNotifications || modpackServices?.nativeNotificationBridge || null; },
    managementServer: deps.managementServer || null,
    startup
  });
}

module.exports = {
  channelOperationId,
  createLiveInstanceResolver,
  createModpackServiceGraph,
  createProductionDurableFsFactory,
  deriveRecoveryRuntimeTuple
};
