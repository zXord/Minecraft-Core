const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../services/modpacks/errors.cjs');
const { proveEntriesAbsent } = require('../services/modpacks/instance-ownership.cjs');
const {
  CURRENT_STATE,
  STATE_DIRECTORY,
  createModpackStateObserver
} = require('../services/modpacks/state/modpack-state-repository.cjs');
const { ClientPackStateStore } = require('../services/client-modpacks/client-pack-state.cjs');
const { ClientPackTransaction } = require('../services/client-modpacks/client-pack-transaction.cjs');
const { ClientProcessGuard } = require('../services/client-modpacks/client-process-guard.cjs');
const { ManagementPackClient } = require('../services/client-modpacks/management-pack-client.cjs');
const { createClientPackIntegration } = require('../services/client-modpacks/client-pack-integration.cjs');
const { normalizeCompanionDescriptor } = require('../services/client-modpacks/companion-contracts.cjs');
const { HOST_UNREACHABLE_REASON } = require('../services/management-session-transport.cjs');
const {
  createScanOnlyDurableFs,
  modpackServicesUnavailable
} = require('../services/modpack-lifecycle/degraded-recovery-gate.cjs');
const { clientDurableRouter } = require('./create-client-pack-composition.cjs');

const MODPACK_STATE_ENTRY = `${STATE_DIRECTORY}/${CURRENT_STATE}`;
const PACK_PATH_CODES = Object.freeze(new Set(['CLIENT_PACK_UNAVAILABLE', 'RECOVERY_REQUIRED']));
const SETTLED_JOURNAL_PHASES = Object.freeze(['committed', 'abandoned']);
const BLOCKED_RECOVERY_TITLE = 'Interrupted modpack operation';
const BLOCKED_RECOVERY_SUMMARY = 'Modpack features are turned off, so this interrupted modpack operation cannot be recovered yet. ' +
  'The server stays blocked to protect its files until Minecraft Core can start its modpack features again.';
const GLOBAL_RECOVERY_TITLE = 'Saved modpack operations could not be checked';
const GLOBAL_RECOVERY_SUMMARY = 'Minecraft Core could not check its saved modpack operations, so server changes stay blocked ' +
  'to protect your files until it can start its modpack features again.';

// A refusal on a pack path (a manifest, a journal or a host requirement)
// reads as "modpack features are off". A host that gave no HTTP response at
// all stays a connection problem, and the caller's own work keeps its error.
function degradedError(error) {
  if (error instanceof ModpackError && PACK_PATH_CODES.has(error.code) && error.reason !== HOST_UNREACHABLE_REASON) {
    return modpackServicesUnavailable(error);
  }
  return error;
}

async function directoryHasNoEntries(directory, fsPromises) {
  let stat;
  try {
    stat = await fsPromises.lstat(directory);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  try {
    return (await fsPromises.readdir(directory)).length === 0;
  } catch {
    return false;
  }
}

function recoveryItemId(...parts) {
  return `recovery-${crypto.createHash('sha256').update(`degraded-modpack-recovery\0${parts.join('\0')}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function recoveryItem(recoveryId, serverId, title, summary) {
  return {
    recoveryId,
    serverId,
    instanceId: serverId,
    stableServerId: serverId,
    visibilityScope: 'registered-server',
    phase: 'blocked',
    automaticPossible: false,
    title,
    summary,
    actions: []
  };
}

/**
 * What still works when the modpack services could not start (degraded
 * startup). Instances without modpack evidence get v26.6.1 behaviour; any
 * modpack evidence is refused with MODPACK_SERVICES_UNAVAILABLE.
 * - stateRepository: the state observer over a delegate that always refuses,
 *   so a read is null exactly where the strict repository's would be.
 * - clientPackIntegration: the real integration over the real client guard,
 *   journal-first transactions, the marker-first manifest store and the core
 *   management broker. Nothing it uses can write pack state.
 * - companionResolver: per server, as CompanionService.getStatus answers it.
 * - readServerState, readClientState and listRecovery answer the modpack and
 *   client-pack IPC that degraded mode keeps.
 */
function createDegradedModpackFallbacks({
  userDataPath,
  store,
  clientConnectionCore,
  instanceResolver,
  clock = { now: () => Date.now() },
  fsSync = fs,
  fsPromises = fsp,
  randomUUID = crypto.randomUUID,
  recoveryGate = null,
  isCompositionDisposalPending = () => false,
  reparseInspector = null
} = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) || !store || typeof store.get !== 'function' ||
      typeof clientConnectionCore?.resolveClient !== 'function' || typeof clientConnectionCore?.resolveClientByPath !== 'function' ||
      !clientConnectionCore.managementSessionBroker || typeof instanceResolver?.resolveInstance !== 'function' ||
      typeof clock?.now !== 'function' || typeof isCompositionDisposalPending !== 'function' || typeof randomUUID !== 'function') {
    throw new TypeError('Degraded modpack fallback dependencies are invalid');
  }
  const registeredInstances = type => {
    const instances = store.get('instances');
    if (!Array.isArray(instances)) throw modpackServicesUnavailable();
    return instances.filter(item => item?.type === type && typeof item.id === 'string' &&
      typeof item.path === 'string' && path.isAbsolute(item.path));
  };

  const stateRepository = createModpackStateObserver({
    repository: Object.freeze({
      read() { throw modpackServicesUnavailable(); },
      listHistory() { throw modpackServicesUnavailable(); }
    }),
    fsApi: fsSync
  });

  const clientPacksRoot = path.join(userDataPath, 'client-packs');
  const journalRoot = path.join(clientPacksRoot, 'transactions');
  const scanOnlyFactory = roots => createScanOnlyDurableFs({ fsApi: fsSync, asyncFsApi: fsPromises, allowedRoots: roots });
  const scanOnlyRouter = clientDurableRouter({
    root: clientPacksRoot,
    getInstances: () => registeredInstances('client'),
    durableFsFactory: scanOnlyFactory
  });
  const stateStore = new ClientPackStateStore({ durableFs: scanOnlyRouter, fsPromises });

  // An empty journal folder means no client has a pack transaction; otherwise
  // the real transaction reads the journals (and refuses what is unsettled).
  let journals = null;
  const realTransaction = () => {
    if (!journals) {
      journals = new ClientPackTransaction({ journalRoot, durableFs: scanOnlyRouter, stateStore,
        ...(reparseInspector ? { reparseInspector } : {}) });
    }
    return journals;
  };
  const transaction = Object.freeze({
    async status(target) {
      if (await directoryHasNoEntries(journalRoot, fsPromises)) return null;
      return realTransaction().status(target);
    },
    async assertNoUnsettledAtPath(clientPath) {
      if (await directoryHasNoEntries(journalRoot, fsPromises)) return;
      await realTransaction().assertNoUnsettledAtPath(clientPath);
    }
  });

  // The real guard for shared holds: a client without pack evidence shares its
  // folder (with the app's own game and other client writers) as in a full
  // start. A strict hold (pack evidence) needs a durable launch record that
  // degraded mode cannot write, so it is refused before any process scan or
  // exclusive hold.
  const refusingLaunchRecords = Object.freeze({
    async readFileBoundedAsync() { throw modpackServicesUnavailable(); },
    async writeJsonAtomicAsync() { throw modpackServicesUnavailable(); }
  });
  let guard = null;
  let guardFailure;
  try {
    const processRoot = path.join(clientPacksRoot, 'processes');
    fsSync.mkdirSync(processRoot, { recursive: true, mode: 0o700 });
    guard = new ClientProcessGuard({ root: processRoot, durableFs: refusingLaunchRecords, randomUUID });
  } catch (error) {
    guardFailure = error;
  }
  const sharedHold = options => options?.proof === 'none';
  const processGuard = Object.freeze({
    withMutation(request, callback, options) {
      if (!guard || !sharedHold(options)) return Promise.reject(modpackServicesUnavailable(guardFailure));
      return guard.withMutation(request, callback, options);
    },
    beginLaunch(request, options) {
      if (!guard || !sharedHold(options)) return Promise.reject(modpackServicesUnavailable(guardFailure));
      return guard.beginLaunch(request, options);
    },
    listActiveMutations() {
      return guard ? guard.listActiveMutations() : Object.freeze([]);
    }
  });

  const sessionClock = () => {
    const value = clock.now();
    return value instanceof Date ? value.getTime() : value;
  };
  const managementClient = new ManagementPackClient({
    sessionBroker: clientConnectionCore.managementSessionBroker,
    clock: sessionClock
  });
  const integration = createClientPackIntegration({
    resolveClient: clientConnectionCore.resolveClient,
    resolveClientByPath: clientConnectionCore.resolveClientByPath,
    processGuard,
    transaction,
    stateStore,
    managementClient,
    clientPackService: Object.freeze({
      async getLaunchAuthority() { throw modpackServicesUnavailable(); }
    }),
    clock: sessionClock
  });

  // A composition that failed to start may still be settling client cleanup;
  // until it has, a client with a pack journal is not touched.
  async function refuseJournaledClientWhileDisposing(resolveTarget) {
    if (!isCompositionDisposalPending()) return;
    const target = await resolveTarget();
    let journaled;
    try {
      journaled = (await transaction.status(target)) !== null;
    } catch {
      journaled = true;
    }
    if (journaled && isCompositionDisposalPending()) throw modpackServicesUnavailable();
  }

  async function clientOperation(resolveTarget, operation, work) {
    let workFailure = null;
    const trackedWork = typeof work === 'function'
      ? async () => {
        try {
          return await work();
        } catch (error) {
          workFailure = { error };
          throw error;
        }
      }
      : work;
    try {
      await refuseJournaledClientWhileDisposing(resolveTarget);
      return await operation(trackedWork);
    } catch (error) {
      if (workFailure && error === workFailure.error) throw error;
      throw degradedError(error);
    }
  }

  const byId = request => () => clientConnectionCore.resolveClient(request?.clientId);
  // A registry edit names the registration it changes (a copied client folder shares its id).
  const byRegistration = request => () => clientConnectionCore.resolveClient(request?.clientId, request?.clientPath);
  const clientPackIntegration = Object.freeze({
    async assertServerDestination(serverPath) {
      try {
        return await integration.assertServerDestination(serverPath);
      } catch (error) {
        throw degradedError(error);
      }
    },
    runLegacyMutation: (request, work) => clientOperation(byId(request), run => integration.runLegacyMutation(request, run), work),
    runPersonalMutation: (request, work) => clientOperation(byId(request), run => integration.runPersonalMutation(request, run), work),
    runLocalMutation: (request, work) => clientOperation(byId(request), run => integration.runLocalMutation(request, run), work),
    runRegistryMutation: (request, work) => clientOperation(byRegistration(request), run => integration.runRegistryMutation(request, run), work),
    beginManagedLaunch: (request, options) => clientOperation(
      () => clientConnectionCore.resolveClientByPath(request?.clientPath),
      () => integration.beginManagedLaunch(request, options))
  });

  // Mirrors CompanionService.getStatus: an unregistered server is refused, a
  // server whose modpack state is proven absent has no matching pack, and any
  // modpack state refuses that server alone.
  function companionResolver(serverId) {
    const matches = registeredInstances('server').filter(item => item.id === serverId);
    if (matches.length !== 1) throw new ModpackError('INVALID_REQUEST', 'Choose a registered server instance');
    if (proveEntriesAbsent(path.resolve(matches[0].path), [MODPACK_STATE_ENTRY], { fsApi: fsSync })) return null;
    throw modpackServicesUnavailable();
  }

  // modpacks:get-state: the lifecycle's unmanaged state where no modpack state
  // exists; anything else needs the modpack services.
  async function readServerState(serverId) {
    const resolved = await instanceResolver.resolveInstance(serverId);
    if (stateRepository.read(resolved.serverPath) !== null) throw modpackServicesUnavailable();
    return deepFreeze({
      type: 'modpack-state',
      instanceId: serverId,
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

  // client-packs:get-state and verify: ClientPackService.getState's steps for
  // a client without a pack; a client with a pack needs the modpack services.
  async function readClientState({ clientId } = {}) {
    try {
      const target = await clientConnectionCore.resolveClient(clientId);
      await refuseJournaledClientWhileDisposing(() => target);
      const journal = await transaction.status(target);
      if (journal && !SETTLED_JOURNAL_PHASES.includes(journal.phase)) throw modpackServicesUnavailable();
      let descriptor;
      try {
        const { descriptor: requirement, binding } = await managementClient.readRequirement(clientId);
        if (!binding || typeof binding.generation !== 'string' || !binding.generation) {
          throw new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The matching client requirement could not be read');
        }
        descriptor = requirement === null ? null : normalizeCompanionDescriptor(requirement);
      } catch (cause) {
        if (!(cause instanceof ModpackError) || cause.code !== 'CLIENT_PACK_UNAVAILABLE' ||
            cause.reason !== HOST_UNREACHABLE_REASON || await stateStore.read(target.clientPath) !== null) throw cause;
        return deepFreeze({ clientId, status: 'requirement-unavailable', verified: false, descriptor: null });
      }
      if (await stateStore.read(target.clientPath) !== null) throw modpackServicesUnavailable();
      const status = descriptor?.status === 'ready' ? 'install-required' : descriptor?.status === 'unpaired' ? 'unpaired' : 'unmanaged';
      return deepFreeze({ clientId, status, verified: false, descriptor });
    } catch (error) {
      throw degradedError(error);
    }
  }

  // modpacks:list-recovery: one item per server the recovery gate blocks, so the
  // server page keeps its Start disabled exactly where starts are refused.
  function listRecovery() {
    if (!recoveryGate) throw modpackServicesUnavailable();
    const servers = registeredInstances('server');
    const pathKey = value => path.resolve(value).normalize('NFC').toLocaleLowerCase('en-US');
    const items = new Map();
    if (recoveryGate.globalBlock) {
      for (const server of servers) {
        const recoveryId = recoveryItemId('global', server.id);
        items.set(recoveryId, recoveryItem(recoveryId, server.id, GLOBAL_RECOVERY_TITLE, GLOBAL_RECOVERY_SUMMARY));
      }
    }
    for (const block of recoveryGate.blocks || []) {
      const selector = block?.selector || {};
      const ids = new Set();
      if (typeof selector.instanceId === 'string') ids.add(selector.instanceId);
      if (typeof selector.serverPath === 'string') {
        for (const server of servers) if (pathKey(server.path) === pathKey(selector.serverPath)) ids.add(server.id);
      }
      for (const serverId of ids) {
        const recoveryId = recoveryItemId(block.operationId, serverId);
        if (!items.has(recoveryId)) items.set(recoveryId, recoveryItem(recoveryId, serverId, BLOCKED_RECOVERY_TITLE, BLOCKED_RECOVERY_SUMMARY));
      }
    }
    return deepFreeze({ items: [...items.values()].sort((left, right) => left.recoveryId.localeCompare(right.recoveryId, 'en-US')) });
  }

  return Object.freeze({
    stateRepository,
    clientPackIntegration,
    companionResolver,
    readServerState,
    readClientState,
    listRecovery,
    listActiveMutations: () => processGuard.listActiveMutations()
  });
}

module.exports = { createDegradedModpackFallbacks };
