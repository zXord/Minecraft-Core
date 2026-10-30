const fs = require('node:fs');
const path = require('node:path');
const { markStartupTrace } = require('../utils/startup-trace.cjs');
const { ModpackError } = require('../services/modpacks/errors.cjs');
const { CompanionStore } = require('../services/client-modpacks/companion-store.cjs');
const { CompanionService } = require('../services/client-modpacks/companion-service.cjs');
const { ManagedServerModHealth } = require('../services/client-modpacks/managed-server-mod-health.cjs');
const { ClientCandidatePreparer } = require('../services/client-modpacks/client-candidate-preparer.cjs');
const { ClientPackStateStore } = require('../services/client-modpacks/client-pack-state.cjs');
const { ClientPackTransaction } = require('../services/client-modpacks/client-pack-transaction.cjs');
const { ClientPackService } = require('../services/client-modpacks/client-pack-service.cjs');
const { ClientProcessGuard } = require('../services/client-modpacks/client-process-guard.cjs');
const { ClientRuntimeOwnership } = require('../services/client-modpacks/client-runtime-ownership.cjs');
const { ClientRuntimeInstaller } = require('../services/client-modpacks/client-runtime-installer.cjs');
const { ManagementPackClient } = require('../services/client-modpacks/management-pack-client.cjs');
const { createClientPackIntegration } = require('../services/client-modpacks/client-pack-integration.cjs');
const { createModpackStateObserver } = require('../services/modpacks/state/modpack-state-repository.cjs');
const { createClientConnectionCore } = require('./create-client-connection-core.cjs');
const fail = () => new ModpackError('CLIENT_PACK_UNAVAILABLE', 'Matching client pack services are unavailable');
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function inside(root, value) { const relative = path.relative(root, value); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); }

// Main-owned paths only. Each native helper receives the smallest app/client-parent
// scope needed by this operation; clients created after startup work without a global drive root.
function clientDurableRouter({ root, getInstances, durableFsFactory }) {
  const cache = new Map();
  function forPaths(values) {
    const parents = [...new Set(getInstances().filter(i => i?.type === 'client' && typeof i.path === 'string' && path.isAbsolute(i.path))
      .map(i => path.dirname(path.resolve(i.path))))];
    const roots = new Set([root]);
    for (const value of values) {
      if (typeof value !== 'string' || !path.isAbsolute(value)) throw fail();
      if (inside(root, value)) continue;
      const parent = parents.filter(p => inside(p, value)).sort((a, b) => b.length - a.length)[0];
      if (!parent || parent === path.parse(parent).root) throw fail();
      roots.add(parent);
    }
    const selected = [...roots].sort(); const cacheKey = selected.map(key).join('\0');
    if (!cache.has(cacheKey)) cache.set(cacheKey, durableFsFactory(selected));
    return cache.get(cacheKey);
  }
  const router = {};
  for (const method of ['readFileBoundedAsync', 'writeJsonAtomicAsync', 'flushDirectoryAsync']) {
    router[method] = (target, ...args) => forPaths([target])[method](target, ...args);
  }
  router.renameDurableAsync = (source, destination, ...args) => forPaths([source, destination]).renameDurableAsync(source, destination, ...args);
  router.flushDirectoriesAsync = directories => forPaths(directories).flushDirectoriesAsync(directories);
  return Object.freeze(router);
}

function createClientPackComposition(input) {
  const { userDataPath, store, clientDurableFsFactory, clientWorkerDurableConfig, stateRepository,
    coordinator, providers, sourceResolver, artifactAcquisition, archiveInspector, archiveExtractor,
    workspaceRegistry, artifactDownloader, artifactCache, candidateHashService, reparseInspector, randomUUID, clock } = input;
  if (typeof clientDurableFsFactory !== 'function' || !clientWorkerDurableConfig) throw fail();
  const root = path.join(userDataPath, 'client-packs');
  const journalRoot = path.join(root, 'transactions'); const processRoot = path.join(root, 'processes');
  const runtimeRoot = path.join(root, 'runtime-ownership');
  for (const directory of [root, journalRoot, processRoot, runtimeRoot]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const getInstances = () => { const values = store.get('instances'); if (!Array.isArray(values)) throw fail(); return values; };
  // The service graph owns the connection core so client sessions outlive this
  // composition; a core built here is owned, and disposed, by this composition.
  const ownsConnectionCore = !input.clientConnectionCore;
  const connectionCore = input.clientConnectionCore || createClientConnectionCore({ store, readClientConfig: input.readClientConfig,
    getPinnedHttpsAgent: input.getPinnedHttpsAgent, managementSessionRequestJson: input.managementSessionRequestJson, randomUUID, clock });
  const { resolveClient, resolveClientByPath, managementSessionBroker, acquireLegacyManagementContext } = connectionCore;
  if (typeof resolveClient !== 'function' || typeof resolveClientByPath !== 'function' || !managementSessionBroker ||
      typeof acquireLegacyManagementContext !== 'function' || typeof connectionCore.dispose !== 'function') throw fail();
  // Read-only classification: a server whose modpack state is proven absent reads
  // as unmanaged whatever its folder shape; present or unprovable state stays strict.
  const stateObserver = input.stateObserver || createModpackStateObserver({ repository: stateRepository, fsApi: input.fsSync || fs });
  const resolveServer = async serverId => {
    const matches = getInstances().filter(i => i?.id === serverId && i.type === 'server' && typeof i.path === 'string' && path.isAbsolute(i.path));
    if (matches.length !== 1) throw new ModpackError('INVALID_REQUEST', 'Choose a registered server instance');
    return { instanceId: serverId, serverPath: path.resolve(matches[0].path) };
  };
  const durableFs = clientDurableRouter({ root, getInstances, durableFsFactory: clientDurableFsFactory });
  const authorityFs = clientDurableFsFactory([root]);
  const companionStore = new CompanionStore({ filePath: path.join(root, 'companions.json'), durableFs: authorityFs });
  const managedServerModHealth = new ManagedServerModHealth({ readRecord: serverPath => stateRepository.read(serverPath), reparseInspector });
  const clientCandidatePreparer = new ClientCandidatePreparer({ workspaceRegistry, archiveExtractor, artifactDownloader,
    artifactCache, candidateHashService, reparseInspector, randomUUID });
  const companionService = new CompanionService({ store: companionStore, resolveServer,
    readServerState: async (id, { force = false, signal } = {}) => {
      const { serverPath } = await resolveServer(id);
      const installed = await stateObserver.read(serverPath);
      await managedServerModHealth.assertHealthy({ serverId: id, serverPath, record: installed, force, signal });
      const registered = await resolveServer(id);
      if (registered.serverPath !== serverPath) throw new ModpackError('PLAN_STALE', 'The managed server changed during verification');
      return installed?.state ?? null;
    }, coordinator, providers,
    sourceResolver, artifactAcquisition, archiveInspector, clientCandidatePreparer, clock: () => clock.now() });
  const stateStore = new ClientPackStateStore({ durableFs });
  const transaction = new ClientPackTransaction({ journalRoot, durableFs, stateStore, reparseInspector });
  const processGuard = new ClientProcessGuard({ root: processRoot, durableFs: authorityFs, randomUUID,
    ...(input.clientProcessInspector === undefined ? {} : { inspectProcesses: input.clientProcessInspector }),
    isCurrentUnrelatedServer: input.isCurrentUnrelatedServer ?? require('../services/server-process-runner.cjs').sharedServerProcessRunner.isCurrentUnrelatedServer });
  const ownership = new ClientRuntimeOwnership({ root: runtimeRoot, durableFs: authorityFs, workerDurableConfig: clientWorkerDurableConfig });
  const runtimeInstaller = new ClientRuntimeInstaller({ ownership });
  const sessionClock = () => { const value = clock.now(); return value instanceof Date ? value.getTime() : value; };
  const managementClient = new ManagementPackClient({ sessionBroker: managementSessionBroker, clock: sessionClock });
  const clientPackService = new ClientPackService({ resolveClient, managementClient, candidatePreparer: clientCandidatePreparer,
    sourceResolver, artifactAcquisition, archiveInspector, processGuard, transaction, stateStore, runtimeInstaller,
    listServerPaths: () => getInstances().filter(i => i?.type === 'server' && typeof i.path === 'string' && path.isAbsolute(i.path)).map(i => i.path),
    reparseInspector, clock: () => clock.now() });
  const clientPackIntegration = createClientPackIntegration({ resolveClient, resolveClientByPath,
    processGuard, transaction, stateStore, managementClient, clientPackService, clock: sessionClock });
  let initialized = false; let disposal;
  async function cleanupRegisteredClients() {
    for (const instance of getInstances().filter(i => i?.type === 'client')) {
      try {
        const target = await resolveClient(instance.id);
        if (await transaction.status(target)) await clientPackService.cleanup({ clientId: instance.id });
      } catch { /* Retain unproven/running work; never block a healthy server. */ }
    }
  }
  return Object.freeze({ companionService, clientPackService, clientPackIntegration, managementSessionBroker, resolveClientByPath, acquireLegacyManagementContext,
    // In-flight exclusive client pack mutations, for the app update guard.
    listActiveMutations: () => processGuard.listActiveMutations(),
    async initialize() {
      if (initialized) return;
      markStartupTrace('client-packs:companion-store-init:start');
      try {
        await companionStore.initialize();
        markStartupTrace('client-packs:companion-store-init:complete');
      } catch { /* Corruption remains explicit in companion requests; never reset. */ }
      markStartupTrace('client-packs:registered-cleanup:start');
      await cleanupRegisteredClients();
      markStartupTrace('client-packs:registered-cleanup:complete');
      initialized = true;
    },
    dispose() {
      if (ownsConnectionCore) connectionCore.dispose();
      if (!disposal) disposal = (async () => {
        const results = await Promise.allSettled([clientPackService.dispose(), companionService.dispose(), managedServerModHealth.dispose()]);
        await cleanupRegisteredClients();
        const failures = results.filter(r => r.status === 'rejected').map(r => r.reason);
        if (failures.length) throw new AggregateError(failures, 'Client pack disposal could not settle');
      })();
      return disposal;
    }
  });
}
module.exports = { createClientPackComposition, clientDurableRouter };
