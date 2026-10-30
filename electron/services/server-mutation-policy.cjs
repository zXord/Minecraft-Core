const crypto = require('node:crypto');
const path = require('node:path');

const { ModpackError } = require('./modpacks/errors.cjs');
const { getServerMutationCoordinator } = require('./server-mutation-context.cjs');
const { canonicalCoordinatorSelector } = require('./coordinator-identity.cjs');
const { coordinatorInstanceKey, coordinatorPathKey } = require('./server-mutation-coordinator.cjs');

// Every wrapped writer is an ordinary coordinator writer: like v26.6.1 it shares
// its folder with other writers and with a running server, and it can never
// overlap modpack lifecycle or recovery work, which holds a folder exclusively.
const CLIENT_SAFE_SETTINGS_CHANNELS = new Set([
  'minecraft-auth', 'minecraft-save-auth', 'minecraft-import-auth-from-instance', 'minecraft-check-refresh-auth',
  'minecraft-clear-auth', 'set-download-preferences', 'save-client-config'
]);
// The client's own mods, shaders and resource packs. They stay editable while the
// host gives no HTTP response, never against a host that requires a matching pack.
const CLIENT_LOCAL_CONTENT_CHANNELS = new Set([
  'toggle-client-mod', 'delete-client-mod', 'toggle-client-asset', 'delete-client-asset', 'toggle-manual-mod',
  'remove-manual-mods', 'disable-client-mod', 'disable-client-mods', 'clear-client-mod-cache',
  'migrate-client-mod-metadata', 'install-client-mod', 'update-client-mod', 'update-client-mods',
  'update-manual-mod', 'download-client-mod-version-updates'
]);
// Only loose mod JAR writers: pack lifecycle, metadata and other content stay usable.
const MOD_JAR_EDIT_CHANNELS = new Set([
  'direct-add-mod', 'add-mod', 'install-mod', 'install-mod-with-fallback', 'download-mod-with-fallback',
  'delete-mod', 'update-mod', 'move-mod-file', 'enable-and-update-mod', 'save-disabled-mods',
  'auto-redownload-corrupted-file',
  'install-client-mod', 'update-client-mod', 'disable-client-mod', 'update-client-mods', 'disable-client-mods',
  'download-client-mod-version-updates', 'remove-manual-mods', 'toggle-manual-mod', 'update-manual-mod',
  'toggle-client-mod', 'delete-client-mod', 'minecraft-download-mods', 'minecraft-check-mods',
  'minecraft-remove-unmanaged-mods', 'minecraft-remove-server-managed-mods'
]);
const INSTANCE_REGISTRATION_CHANNELS = new Set(['rename-instance', 'delete-instance']);
const MANAGED_MOD_EDIT_MESSAGE = 'Individual mod changes are disabled while this server is managed. Use Modpack to change or repair the pack, or review Detach to keep all files and manage mods individually.';
const UNCHECKED_MOD_EDIT_MESSAGE = "Mod changes are paused because this server's modpack ownership could not be checked. Open Modpack to review it, then retry.";
const NESTED_MANAGED_CLIENT_MESSAGE = 'This server folder and a client folder are inside each other, and that client uses a matching modpack. Move the client or the server into its own separate folder.';
const CLIENT_CONTAINS_SERVER_MESSAGE = 'This client folder contains a server; stop and remove that server first.';
const DEFAULT_LANE_WAIT_TIMEOUT_MS = 60000;

// A running server blocks only the writers the v26.6.1 UI already disabled while
// it ran: they replace or delete files the server holds.
const STOPPED_ONLY = Object.freeze({ stoppedOnly: true });
// Management metadata of a server with an attached modpack changes only while it
// is stopped; every other server keeps v26.6.1 behaviour.
const MANAGEMENT_METADATA = Object.freeze({ lane: 'config', stoppedOnlyWhenManaged: true });
// Read-modify-write families of one folder run one at a time (see runInWriteLane).
const CONFIG_LANE = Object.freeze({ lane: 'config' });
const SERVER_PROPERTIES_LANE = Object.freeze({ lane: 'server-properties' });

const CORE_SERVER_WRITER_POLICIES = Object.freeze({
  'write-config': policy('write-config', 'payload:serverPath', CONFIG_LANE),
  'update-config': policy('update-config', 'payload:serverPath', CONFIG_LANE),
  'select-folder': manualPolicy('initialize-server-folder'),
  'save-version-selection': policy('save-version-selection', 'payload:path', CONFIG_LANE),
  'write-eula': policy('write-eula', 'payload:path', CONFIG_LANE),
  'delete-world': policy('delete-world', 'string', STOPPED_ONLY),
  'update-settings': policy('update-settings', 'payload:serverPath|instanceId', CONFIG_LANE),
  'save-instances': manyPolicy('save-instances'),
  'rename-instance': policy('rename-instance', 'payload:id', { revisionMode: 'none' }),
  'delete-instance': policy('delete-instance', 'payload:id', { revisionMode: 'none', ...STOPPED_ONLY }),
  'write-server-properties': policy('write-server-properties', 'payload:serverPath', SERVER_PROPERTIES_LANE),
  'generate-server-properties': policy('generate-server-properties', 'string', SERVER_PROPERTIES_LANE),
  'restore-backup-properties': policy('restore-backup-properties', 'string', SERVER_PROPERTIES_LANE),
  'download-minecraft-server': policy('download-minecraft-server', 'payload:targetPath', STOPPED_ONLY),
  'download-and-install-loader': policy('install-server-loader', 'payload:targetPath|path', STOPPED_ONLY),
  'download-and-install-fabric': policy('install-fabric-loader', 'payload:path', STOPPED_ONLY),
  'repair-health': policy('repair-server-health', 'payload:targetPath', { markOnSuccess: false, ...STOPPED_ONLY }),
  'server-java-ensure': policy('ensure-server-java', 'payload:serverPath', { markOnSuccess: false }),
  'backups:delete': policy('delete-server-backup', 'payload:serverPath', {
    revisionMode: 'none',
    markOnSuccess: false,
    lane: 'backups-meta'
  }),
  'backups:rename': policy('rename-server-backup', 'payload:serverPath', {
    revisionMode: 'none',
    markOnSuccess: false,
    lane: 'backups-meta'
  }),
  'backups:restore': policy('restore-server-backup', 'payload:serverPath', STOPPED_ONLY),
  'backups:configure-automation': policy('configure-backups', 'payload:serverPath', { lane: 'backups-meta' }),
  'backups:apply-retention-policy': policy('apply-backup-retention', 'payload:serverPath', {
    revisionMode: 'none',
    markOnSuccess: false,
    lane: 'backups-meta'
  }),
  'backups:save-retention-settings': policy('save-backup-retention', 'payload:serverPath', {
    revisionMode: 'none',
    markOnSuccess: false,
    lane: 'backups-meta'
  }),
  'set-auto-restart': optionalPolicy('set-auto-restart', 'payload:targetPath', CONFIG_LANE)
});

const CONTENT_SERVER_WRITER_POLICIES = Object.freeze({
  'start-management-server': serverContentPolicy('start-management-server', 'payload:serverPath|instanceId', MANAGEMENT_METADATA),
  'set-management-server-external-host': serverContentPolicy('set-management-server-external-host', 'payload:serverPath|instanceId', MANAGEMENT_METADATA),
  'set-management-invite-host': serverContentPolicy('set-management-invite-host', 'payload:serverPath|instanceId', MANAGEMENT_METADATA),
  'regenerate-management-invite-secret': serverContentPolicy('regenerate-management-invite-secret', 'payload:serverPath|instanceId', MANAGEMENT_METADATA),

  'add-player': serverContentPolicy('add-player', 'arg:1', { markOnSuccess: false, lane: 'players' }),
  'add-player-with-details': serverContentPolicy('add-player-with-details', 'arg:1', { markOnSuccess: false, lane: 'players' }),
  'remove-player': serverContentPolicy('remove-player', 'arg:1', { markOnSuccess: false, lane: 'players' }),

  'direct-add-mod': serverContentPolicy('direct-add-mod', 'payload:serverPath'),
  'save-disabled-mods': serverContentPolicy('save-disabled-mods', 'arg:0', { lane: 'disabled-mods' }),
  'save-ignored-mod-updates': serverContentPolicy('save-ignored-mod-updates', 'arg:0', {
    revisionMode: 'none',
    markOnSuccess: false
  }),
  'install-mod': serverContentPolicy('install-server-mod', 'arg:0'),
  'install-mod-with-fallback': serverContentPolicy('install-server-mod-fallback', 'arg:0'),
  'download-mod-with-fallback': serverContentPolicy('download-server-mod-fallback', 'payload:serverPath'),
  'store-file-checksum': contentPolicy('store-file-checksum', 'payload:filePath'),
  'auto-redownload-corrupted-file': serverContentPolicy('redownload-corrupted-mod', 'payload:serverPath'),
  'add-mod': serverContentPolicy('add-server-mod', 'arg:0'),
  'delete-mod': serverContentPolicy('delete-server-mod', 'arg:0'),
  'update-mod': serverContentPolicy('update-server-mod', 'payload:serverPath'),
  'move-mod-file': serverContentPolicy('move-server-mod', 'payload:serverPath'),
  'enable-and-update-mod': serverContentPolicy('enable-update-server-mod', 'payload:serverPath'),
  'delete-shader': serverContentPolicy('delete-server-shader', 'arg:0'),
  'delete-resourcepack': serverContentPolicy('delete-server-resourcepack', 'arg:0'),
  'install-shader-with-fallback': serverContentPolicy('install-server-shader', 'arg:0'),
  'install-resourcepack-with-fallback': serverContentPolicy('install-server-resourcepack', 'arg:0'),
  'migrate-server-mod-metadata': serverContentPolicy('migrate-server-mod-metadata', 'string'),

  'install-client-mod': contentPolicy('install-client-mod', 'payload:clientPath'),
  'update-client-mod': contentPolicy('update-client-mod', 'payload:clientPath'),
  'disable-client-mod': contentPolicy('disable-client-mod', 'payload:clientPath|modFilePath'),
  'update-client-mods': contentPolicy('update-client-mods', 'payload:clientPath'),
  'disable-client-mods': contentPolicy('disable-client-mods', 'payload:clientPath'),
  'download-client-mod-version-updates': contentPolicy('download-client-mod-version-updates', 'payload:clientPath'),
  'clear-client-mod-cache': contentPolicy('clear-client-mod-cache', 'payload:clientPath'),
  'migrate-client-mod-metadata': contentPolicy('migrate-client-mod-metadata', 'string'),
  'remove-manual-mods': contentPolicy('remove-manual-mods', 'payload:clientPath'),
  'toggle-manual-mod': contentPolicy('toggle-manual-mod', 'payload:clientPath'),
  'update-manual-mod': contentPolicy('update-manual-mod', 'payload:clientPath'),

  'minecraft-auth': optionalContentPolicy('save-client-auth', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-save-auth': contentPolicy('save-client-auth', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-import-auth-from-instance': contentPolicy('import-client-auth', 'payload:targetClientPath', { markOnSuccess: false }),
  'minecraft-check-refresh-auth': contentPolicy('refresh-client-auth', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-clear-auth': contentPolicy('clear-client-auth', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-download-mods': contentPolicy('download-client-mods', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-download-assets': contentPolicy('download-client-assets', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-launch': contentPolicy('prepare-client-launch', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-check-mods': contentPolicy('reconcile-client-mods', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-check-client': contentPolicy('check-reconcile-client', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-check-client-sync': contentPolicy('check-reconcile-client-sync', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-download-client': contentPolicy('download-client-runtime', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-clear-client': contentPolicy('clear-client-runtime', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-clear-client-full': contentPolicy('clear-client-runtime-full', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-clear-assets': contentPolicy('clear-client-assets', 'payload:clientPath', { markOnSuccess: false }),
  'toggle-client-mod': contentPolicy('toggle-client-mod', 'payload:clientPath', { markOnSuccess: false }),
  'toggle-client-asset': contentPolicy('toggle-client-asset', 'payload:clientPath', { markOnSuccess: false }),
  'delete-client-asset': contentPolicy('delete-client-asset', 'payload:clientPath', { markOnSuccess: false }),
  'delete-client-mod': contentPolicy('delete-client-mod', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-remove-unmanaged-mods': contentPolicy('remove-unmanaged-client-mods', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-remove-server-managed-mods': contentPolicy('remove-managed-client-mods', 'payload:clientPath', { markOnSuccess: false }),
  'minecraft-acknowledge-dependency': contentPolicy('acknowledge-client-dependency', 'payload:clientPath', { markOnSuccess: false }),
  'clear-expected-mod-state': contentPolicy('clear-client-mod-state', 'payload:clientPath', { markOnSuccess: false }),
  'set-download-preferences': contentPolicy('set-client-download-preferences', 'payload:instanceId'),
  'save-client-config': contentPolicy('save-client-config', 'payload:path', {
    markOnSuccess: false,
    requireRegistered: false
  }),

  'mod-watch:add': serverContentPolicy('add-mod-availability-watch', 'payload:serverPath', { lane: 'mod-watch' }),
  'mod-watch:remove': serverContentPolicy('remove-mod-availability-watch', 'payload:serverPath', { lane: 'mod-watch' }),
  'mod-watch:clear': serverContentPolicy('clear-mod-availability-watches', 'string', { lane: 'mod-watch' }),
  'mod-watch:history:clear': serverContentPolicy('clear-mod-availability-history', 'string', { lane: 'mod-watch' })
});

const SERVER_WRITER_POLICIES = Object.freeze({
  ...CORE_SERVER_WRITER_POLICIES,
  ...CONTENT_SERVER_WRITER_POLICIES,
  'modpacks:start-operation': internalPolicy('modpack-lifecycle-operation'),
  // Reconciliation observes an already-issued launch and may drain its owned
  // terminal settlement; the lifecycle service retains that mutation authority.
  'modpacks:reconcile-new-server-launch': internalPolicy('modpack-lifecycle-launch-reconciliation'),
  'modpacks:recover': internalPolicy('modpack-lifecycle-recovery'),
  'modpacks:verify': internalPolicy('modpack-lifecycle-verify'),
  'modpacks:perform-safe-action': internalPolicy('modpack-lifecycle-safe-action')
});

function policy(operation, selector, overrides = {}) {
  return Object.freeze({
    kind: 'mutation',
    operation,
    revisionMode: 'auto',
    markOnSuccess: true,
    selector,
    ...overrides
  });
}

function optionalPolicy(operation, selector, overrides = {}) {
  return Object.freeze({
    ...policy(operation, selector, overrides),
    optionalSelector: true
  });
}

function contentPolicy(operation, selector, overrides = {}) {
  return policy(operation, selector, {
    allowNested: true,
    instanceTypes: Object.freeze(['server', 'client']),
    requireRegistered: true,
    ...overrides
  });
}

function serverContentPolicy(operation, selector, overrides = {}) {
  return policy(operation, selector, {
    requireRegistered: true,
    ...overrides
  });
}

function optionalContentPolicy(operation, selector, overrides = {}) {
  return Object.freeze({
    ...contentPolicy(operation, selector, overrides),
    optionalSelector: true
  });
}

function manyPolicy(operation) {
  return Object.freeze({
    kind: 'many',
    operation,
    revisionMode: 'auto',
    markOnSuccess: false,
    selector: 'instances'
  });
}

function manualPolicy(operation) {
  return Object.freeze({
    kind: 'manual',
    operation,
    revisionMode: 'auto',
    markOnSuccess: false,
    selector: 'selected-path'
  });
}

function internalPolicy(operation) {
  return Object.freeze({ kind: 'internal', operation, revisionMode: 'lifecycle' });
}

function invalidRequest(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The server mutation request is invalid', { cause });
}

function operationInProgress() {
  return new ModpackError('OPERATION_IN_PROGRESS', 'Another operation is already changing this server');
}

function normalizePathKey(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) return null;
  const resolved = path.resolve(value.trim());
  return process.platform === 'win32'
    ? resolved.toLocaleLowerCase('en-US')
    : resolved;
}

function samePathKey(left, right) {
  const key = normalizePathKey(left);
  return key !== null && key === normalizePathKey(right);
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function normalizeInstances(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(instance => instance && typeof instance === 'object' && !Array.isArray(instance));
}

function registeredInstances(getInstances, instanceTypes = ['server']) {
  const allowedTypes = new Set(instanceTypes);
  return normalizeInstances(getInstances()).filter(instance =>
    allowedTypes.has(instance.type) && typeof instance.path === 'string' && instance.path.trim().length > 0
  );
}

function selectField(payload, expression) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  for (const field of expression.split('|')) {
    const value = payload[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function pathIsInside(candidatePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(left, right) {
  return pathIsInside(left, right) || pathIsInside(right, left);
}

function resolveRegisteredSelector(
  { serverPath, instanceId },
  getInstances,
  { allowNested = false, instanceTypes = ['server'], requireRegistered = false } = {}
) {
  const allInstances = normalizeInstances(getInstances());
  const instances = registeredInstances(() => allInstances, instanceTypes);
  const requestedPathKey = normalizePathKey(serverPath);
  const requestedId = typeof instanceId === 'string' && instanceId.trim().length > 0
    ? instanceId.trim()
    : null;
  const byId = requestedId
    ? instances.find(instance => instance.id === requestedId) || null
    : null;
  const exactByPath = requestedPathKey
    ? instances.find(instance => normalizePathKey(instance.path) === requestedPathKey) || null
    : null;
  const nestedByPath = requestedPathKey && allowNested
    ? instances
      .filter(instance => pathIsInside(serverPath, instance.path))
      .sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length)[0] || null
    : null;
  const byPath = exactByPath || nestedByPath;

  if (byId && requestedPathKey) {
    const idPathMatches = allowNested
      ? pathIsInside(serverPath, byId.path)
      : normalizePathKey(byId.path) === requestedPathKey;
    if (!idPathMatches) throw invalidRequest();
  }
  // Another registration of the very same folder (a v26.6.1 duplicate) and an id
  // registered nowhere both name that folder. A known id elsewhere is ambiguous.
  const knownId = requestedId !== null && allInstances.some(instance => instance.id === requestedId);
  if (byPath && requestedId && byPath.id && byPath.id !== requestedId && knownId &&
      !(byId && samePathKey(byId.path, byPath.path))) throw invalidRequest();

  const registered = byId || byPath;
  if (!registered && requireRegistered) throw invalidRequest();
  const resolvedPath = registered?.path || serverPath;
  if (typeof resolvedPath !== 'string' || resolvedPath.trim().length === 0) throw invalidRequest();
  return {
    instanceId: registered?.id || null,
    serverPath: resolvedPath.trim()
  };
}

function resolveSingleSelector(descriptor, args, getInstances) {
  const payload = args[0];
  if (descriptor.selector === 'string') {
    return resolveRegisteredSelector({ serverPath: payload }, getInstances, descriptor);
  }
  if (descriptor.selector.startsWith('arg:')) {
    const index = Number.parseInt(descriptor.selector.slice('arg:'.length), 10);
    if (!Number.isSafeInteger(index) || index < 0) throw invalidRequest();
    return resolveRegisteredSelector({ serverPath: args[index] }, getInstances, descriptor);
  }
  if (!descriptor.selector.startsWith('payload:')) throw invalidRequest();
  const fields = descriptor.selector.slice('payload:'.length);
  const values = fields.split('|');
  const serverPathFields = values.filter(field => field !== 'id' && field !== 'instanceId');
  let serverPath = selectField(payload, serverPathFields.join('|'));
  let instanceId = selectField(payload, values.includes('id') ? 'id' : 'instanceId');
  if (!serverPath && instanceId && (path.isAbsolute(instanceId) || path.win32.isAbsolute(instanceId))) {
    serverPath = instanceId;
    instanceId = null;
  }
  if (!serverPath && !instanceId && descriptor.optionalSelector) return null;
  return resolveRegisteredSelector({ serverPath, instanceId }, getInstances, descriptor);
}

function assertSecondaryWriteDestination(channel, payload, selector) {
  let destination;
  if (channel === 'disable-client-mod') destination = payload?.modFilePath;
  else if (channel === 'update-client-mod') destination = payload?.modInfo?.currentFilePath;
  else if (channel === 'auto-redownload-corrupted-file') destination = payload?.filePath;
  if (destination !== undefined && destination !== null && destination !== '') {
    const modsRoot = path.join(selector.serverPath, 'mods');
    if (!normalizePathKey(destination) || !pathIsInside(destination, modsRoot) ||
        normalizePathKey(destination) === normalizePathKey(modsRoot)) throw invalidRequest();
  }
}

// The coordinator's identity for a selector: its instance key and folder key.
function sameCoordinatorSelector(left, right) {
  return coordinatorInstanceKey(left.instanceId) === coordinatorInstanceKey(right.instanceId) &&
    coordinatorPathKey(left.serverPath) === coordinatorPathKey(right.serverPath);
}

function folderKey(value) {
  return coordinatorPathKey(value) ?? normalizePathKey(value);
}

function mutationSucceeded(result) {
  if (result === false) return false;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return true;
  if (result.success === false) return false;
  if (result.error && result.success !== true) return false;
  if (result.changed === false || result.dirty === false || result.skipped === true) return false;
  if (result.deletedFrom === 'not_found') return false;
  if (typeof result.action === 'string' && result.action.startsWith('already_')) return false;
  const noOpCountKeys = ['updatedCount', 'disabledCount', 'removedCount', 'deletedFromCount'];
  const presentNoOpCounts = noOpCountKeys.filter(key => Number.isFinite(result[key]));
  if (presentNoOpCounts.length > 0 && presentNoOpCounts.every(key => result[key] === 0)) return false;
  return true;
}

function defaultOperationId() {
  return `server-writer-${crypto.randomUUID()}`;
}

// Production ids are `${channel}-${uuid}`; channels such as backups:restore and
// mod-watch:add contain characters the coordinator does not accept.
function sanitizeOperationId(value) {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9_-]/g, '-') : value;
}

function defaultLogger() {
  try {
    return require('./logger-service.cjs').getLogger();
  } catch {
    return null;
  }
}

// Read-modify-write families of one folder (its config, player lists,
// server.properties, backup metadata, mod watches, disabled mods) run one at a
// time in arrival order inside their shared coordinator lease, so two quick
// edits never lose one another. Waiting is bounded. Lanes belong to the
// coordinator, so the desktop IPC policy, the browser panel and the mod
// availability watcher queue in the same lanes.
const laneRegistries = new WeakMap();

function laneRegistryFor(coordinator) {
  let registry = laneRegistries.get(coordinator);
  if (!registry) {
    registry = new Map();
    laneRegistries.set(coordinator, registry);
  }
  return registry;
}

function acquireLane(registry, key, timeoutMs) {
  let lane = registry.get(key);
  if (!lane) {
    lane = { held: false, waiters: [] };
    registry.set(key, lane);
  }
  const grant = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = lane.waiters.shift();
      if (next) {
        next.admit();
        return;
      }
      lane.held = false;
      if (registry.get(key) === lane) registry.delete(key);
    };
  };
  if (!lane.held) {
    lane.held = true;
    return Promise.resolve(grant());
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      admit: () => {
        clearTimeout(timer);
        resolve(grant());
      }
    };
    const timer = setTimeout(() => {
      const index = lane.waiters.indexOf(waiter);
      if (index !== -1) lane.waiters.splice(index, 1);
      reject(operationInProgress());
    }, timeoutMs);
    lane.waiters.push(waiter);
  });
}

/**
 * Runs work in one read-modify-write lane of a server folder. The caller already
 * holds that folder's coordinator lease.
 * @returns {Promise<*>} the work's result; OPERATION_IN_PROGRESS when the lane
 *   stays busy longer than timeoutMs
 */
async function runInWriteLane(coordinator, lane, serverPath, work, { timeoutMs = DEFAULT_LANE_WAIT_TIMEOUT_MS } = {}) {
  const key = folderKey(serverPath);
  if (!coordinator || typeof lane !== 'string' || !lane || !key || typeof work !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw invalidRequest();
  const release = await acquireLane(laneRegistryFor(coordinator), `${lane}\u0000${key}`, timeoutMs);
  try {
    return await work();
  } finally {
    release();
  }
}

// The server's modpack state changed between classification and admission.
class ModpackStateChanged extends Error {}

function createServerMutationPolicy({
  coordinator = getServerMutationCoordinator(),
  getInstances = () => [],
  getClientPackIntegration = null,
  getModpackStateRepository = null,
  createOperationId = defaultOperationId,
  laneWaitTimeoutMs = DEFAULT_LANE_WAIT_TIMEOUT_MS,
  logger = null
} = {}) {
  if (!coordinator || typeof coordinator.runMutation !== 'function' ||
      typeof coordinator.runManyMutations !== 'function' || typeof getInstances !== 'function' ||
      typeof createOperationId !== 'function' ||
      !Number.isSafeInteger(laneWaitTimeoutMs) || laneWaitTimeoutMs < 0) throw invalidRequest();

  const canonical = selector => canonicalCoordinatorSelector({ instances: getInstances(), selector, coordinator });
  const isRegistered = instanceId => typeof instanceId === 'string' &&
    normalizeInstances(getInstances()).some(instance => instance.id === instanceId);
  const overlappingClients = folder => registeredInstances(getInstances, ['client'])
    .filter(client => pathsOverlap(folder, client.path));
  const isRegisteredServerRoot = folder => registeredInstances(getInstances, ['server'])
    .some(server => samePathKey(server.path, folder));

  function warn(message, data) {
    try {
      (logger || defaultLogger())?.warn?.(message, {
        category: 'settings',
        data: { service: 'server-mutation-policy', ...data }
      });
    } catch {
      // Logging never changes a writer's outcome.
    }
  }

  function writerOptions(channel, descriptor, stoppedOnly) {
    return {
      operation: descriptor.operation,
      operationId: sanitizeOperationId(createOperationId(channel)),
      revisionMode: descriptor.revisionMode,
      quiesce: null,
      ordinary: true,
      stoppedOnly
    };
  }

  function withLane(lane, serverPath, work) {
    if (!lane) return work();
    return runInWriteLane(coordinator, lane, serverPath, work, { timeoutMs: laneWaitTimeoutMs });
  }

  // A registration this writer removed is forgotten when its lease is released,
  // best-effort: a delete or save that already succeeded never fails here.
  function retireRemovedRegistration(lease) {
    if (!lease?.instanceId || isRegistered(lease.instanceId)) return;
    try {
      coordinator.retireRegistrationOnRelease?.(lease);
    } catch (error) {
      warn('A removed registration keeps its server lock until restart', { instanceId: lease.instanceId, error: error?.message });
    }
  }

  function retireDisappearedClients(clientsBefore) {
    for (const client of clientsBefore) {
      if (isRegistered(client.id)) continue;
      try {
        coordinator.retireIdleRegistration?.({ instanceId: client.id, serverPath: client.path });
      } catch (error) {
        warn('A removed client keeps its folder lock until restart', { instanceId: client.id, error: error?.message });
      }
    }
  }

  function clientServices(method, unavailableMessage = 'Matching client services are not ready') {
    const integration = getClientPackIntegration();
    if (!integration || typeof integration[method] !== 'function') {
      throw new ModpackError('CLIENT_PACK_UNAVAILABLE', unavailableMessage);
    }
    return integration;
  }

  // Only a client with matching-pack evidence (a manifest or an unsettled pack
  // journal) refuses a server beside it; plain v26.6.1 nesting stays usable.
  async function assertClientsWithoutPack(clients) {
    if (!getClientPackIntegration || clients.length === 0) return;
    const integration = clientServices('assertServerDestination', 'Matching client ownership services are not ready');
    for (const client of clients) {
      try {
        await integration.assertServerDestination(client.path);
      } catch (cause) {
        throw new ModpackError('INVALID_REQUEST', NESTED_MANAGED_CLIENT_MESSAGE, { cause });
      }
    }
  }

  async function assertServerDestination(serverPath) {
    if (!getClientPackIntegration) return;
    await clientServices('assertServerDestination', 'Matching client ownership services are not ready')
      .assertServerDestination(serverPath);
  }

  async function assertLooseModEditsAllowed(serverPath) {
    // Read only the resolved registered server, inside its mutation reservation.
    const server = registeredInstances(getInstances, ['server']).find(instance => samePathKey(instance.path, serverPath));
    if (!server) throw invalidRequest();
    let current;
    try {
      const repository = getModpackStateRepository();
      if (typeof repository?.read !== 'function') throw new Error('State service unavailable');
      current = await repository.read(server.path);
      if (current !== null && typeof current?.state?.modpackManaged !== 'boolean') throw new Error('Invalid state');
    } catch (cause) {
      throw new ModpackError('MANAGED_MOD_EDIT_BLOCKED', UNCHECKED_MOD_EDIT_MESSAGE, { cause });
    }
    if (current?.state.modpackManaged === true) throw new ModpackError('MANAGED_MOD_EDIT_BLOCKED', MANAGED_MOD_EDIT_MESSAGE);
  }

  // Management metadata of a server with an attached modpack (or whose state
  // cannot be read) changes only while that server is stopped.
  async function needsStoppedServer(serverPath) {
    if (typeof getModpackStateRepository !== 'function') return true;
    try {
      const repository = getModpackStateRepository();
      if (typeof repository?.read !== 'function') return true;
      const current = await repository.read(serverPath);
      if (current === null) return false;
      return typeof current?.state?.modpackManaged !== 'boolean' || current.state.modpackManaged;
    } catch {
      return true;
    }
  }

  async function performSingle(channel, descriptor, perform, selector) {
    const clients = overlappingClients(selector.serverPath);
    const clientChannel = descriptor.instanceTypes?.includes('client') === true;
    // A registered server root owns its writes even when a plain client folder is
    // nested with it or shares it (layouts v26.6.1 allowed). Only that same-path
    // client's own channels act for the client.
    const serverRoot = isRegisteredServerRoot(selector.serverPath) &&
      !(clientChannel && clients.some(client => samePathKey(client.path, selector.serverPath)));
    if (getClientPackIntegration && clients.length && clientChannel && !serverRoot) {
      // Only the client registered for the selected folder acts, never a client nested
      // in it or around it. A folder registered twice acts as its lowest id in
      // code-point order, the client its launch resolves, never by array order.
      const client = clients
        .filter(candidate => typeof candidate.id === 'string' && samePathKey(candidate.path, selector.serverPath))
        .sort((left, right) => compareCodePoints(left.id, right.id))[0];
      if (!client) throw invalidRequest();
      if (channel === 'minecraft-launch') return perform();
      const method = CLIENT_SAFE_SETTINGS_CHANNELS.has(channel)
        ? 'runPersonalMutation'
        : CLIENT_LOCAL_CONTENT_CHANNELS.has(channel) ? 'runLocalMutation' : 'runLegacyMutation';
      return clientServices(method)[method]({ clientId: client.id, clientPath: client.path }, perform);
    }
    if (clients.length && (serverRoot || !clientChannel)) await assertClientsWithoutPack(clients);
    if (!CLIENT_SAFE_SETTINGS_CHANNELS.has(channel)) await assertServerDestination(selector.serverPath);
    if (getModpackStateRepository && (!clients.length || serverRoot) && MOD_JAR_EDIT_CHANNELS.has(channel)) {
      await assertLooseModEditsAllowed(selector.serverPath);
    }
    return perform();
  }

  function runSingleWriter(channel, descriptor, handler, event, args) {
    const request = () => {
      const resolved = resolveSingleSelector(descriptor, args, getInstances);
      return resolved ? { resolved, selector: canonical(resolved) } : null;
    };
    const attempt = stoppedOnly => {
      const admitted = request();
      const options = writerOptions(channel, descriptor, stoppedOnly);
      return coordinator.runMutation(admitted.selector, options, async lease => {
        if (descriptor.stoppedOnlyWhenManaged === true && !stoppedOnly &&
            await needsStoppedServer(admitted.resolved.serverPath)) throw new ModpackStateChanged();
        return withLane(descriptor.lane, lease.serverPath, async () => {
          // The registry may have changed while this writer waited.
          let current;
          try {
            current = request();
          } catch {
            current = null;
          }
          if (!current || !sameCoordinatorSelector(current.selector, admitted.selector) ||
              !samePathKey(current.resolved.serverPath, admitted.resolved.serverPath)) throw operationInProgress();
          const result = await performSingle(channel, descriptor, () => handler(event, ...args), current.resolved);
          if (descriptor.markOnSuccess && mutationSucceeded(result)) lease.markDirty();
          if (channel === 'delete-instance' && mutationSucceeded(result)) retireRemovedRegistration(lease);
          return result;
        });
      });
    };

    return (async () => {
      const initial = request();
      if (!initial) return handler(event, ...args);
      assertSecondaryWriteDestination(channel, args[0], initial.resolved);
      let stoppedOnly = descriptor.stoppedOnly === true;
      if (!stoppedOnly && descriptor.stoppedOnlyWhenManaged === true) {
        stoppedOnly = await needsStoppedServer(initial.resolved.serverPath);
      }
      try {
        return await attempt(stoppedOnly);
      } catch (error) {
        if (!(error instanceof ModpackStateChanged)) throw error;
        return attempt(true);
      }
    })();
  }

  // Client rename and delete are registry edits. They never contact the host and
  // tolerate a client whose folder is gone, as in v26.6.1, yet they never overlap
  // a client-pack transaction (the client-pack layer refuses that) or a server
  // whose files a delete would remove.
  async function runClientRegistration(channel, descriptor, handler, event, args, clientId) {
    const deleting = channel === 'delete-instance';
    const deleteFiles = deleting && Boolean(args[0]?.deleteFiles);
    const request = () => {
      const client = registeredInstances(getInstances, ['client']).find(instance => instance.id === clientId) || null;
      if (!client) return null;
      const servers = deleteFiles
        ? registeredInstances(getInstances, ['server']).filter(server => pathsOverlap(server.path, client.path))
        : [];
      const selectors = [client, ...servers].map(instance => canonical({ instanceId: instance.id, serverPath: instance.path }));
      return { client, servers, selectors };
    };
    const initial = request();
    let integration = null;
    if (getClientPackIntegration) {
      integration = getClientPackIntegration();
      if (typeof integration?.runRegistryMutation !== 'function') {
        if (initial.servers.length) throw new ModpackError('INVALID_REQUEST', CLIENT_CONTAINS_SERVER_MESSAGE);
        throw new ModpackError('CLIENT_PACK_UNAVAILABLE', 'Matching client services are not ready');
      }
    }
    const work = async leases => {
      const current = request();
      if (!current || current.selectors.length !== initial.selectors.length ||
          current.selectors.some((selector, index) => !sameCoordinatorSelector(selector, initial.selectors[index]))) {
        throw operationInProgress();
      }
      const { client } = current;
      const perform = () => handler(event, ...args);
      const result = integration
        ? await integration.runRegistryMutation({ clientId: client.id, clientPath: client.path }, perform)
        : await perform();
      if (descriptor.markOnSuccess && mutationSucceeded(result)) leases.forEach(lease => lease.markDirty());
      if (deleting && mutationSucceeded(result)) leases.forEach(retireRemovedRegistration);
      return result;
    };
    const options = writerOptions(channel, descriptor, deleting);
    if (initial.servers.length) return coordinator.runManyMutations(initial.selectors, options, work);
    return coordinator.runMutation(initial.selectors[0], options, lease => work([lease]));
  }

  // save-instances only edits the registry. A server re-listed with the same id
  // and folder is untouched (v26.6.1 saved the list while servers ran); only the
  // folders whose registration the save adds or removes are reserved and
  // inspected, and a folder that loses a registration needs its server stopped.
  function planInstanceSave(args) {
    const all = normalizeInstances(getInstances());
    const current = registeredInstances(() => all, ['server']);
    const incoming = normalizeInstances(args[0]).filter(instance => instance.type === 'server' && instance.id &&
      typeof instance.path === 'string' && instance.path.trim().length > 0);
    const pairKey = instance => `${String(instance.id)}\u0000${folderKey(instance.path)}`;
    const currentPairs = new Set(current.map(pairKey));
    const incomingPairs = new Set(incoming.map(pairKey));
    const items = new Map();
    const note = (instance, kind) => {
      const key = folderKey(instance.path);
      const item = items.get(key) || { key, adds: false, removes: false, serverPath: instance.path.trim(), instanceId: instance.id };
      if (kind === 'added') item.adds = true;
      else {
        item.removes = true;
        item.instanceId = instance.id;
      }
      items.set(key, item);
    };
    for (const instance of incoming) {
      if (currentPairs.has(pairKey(instance))) continue;
      // A registered id never moves to another folder or turns from a client into a server.
      if (all.some(existing => existing.id === instance.id && existing.type !== 'server')) throw invalidRequest();
      resolveRegisteredSelector({ instanceId: instance.id, serverPath: instance.path }, () => all);
      note(instance, 'added');
    }
    for (const instance of current) {
      if (!incomingPairs.has(pairKey(instance))) note(instance, 'removed');
    }
    return [...items.values()].map(item => Object.freeze({
      ...item,
      selector: canonical({
        instanceId: typeof item.instanceId === 'string' ? item.instanceId : null,
        serverPath: item.serverPath
      })
    }));
  }

  async function runInstanceSave(channel, descriptor, handler, event, args) {
    const clientsBefore = registeredInstances(getInstances, ['client']);
    const plan = planInstanceSave(args);
    if (plan.length === 0) {
      // Planned synchronously right before the handler, which reads the registry
      // before its first await: nothing can change in between.
      const result = await handler(event, ...args);
      if (mutationSucceeded(result)) retireDisappearedClients(clientsBefore);
      return result;
    }
    const stoppedOnly = plan.some(item => item.removes);
    const result = await coordinator.runManyMutations(plan.map(item => item.selector),
      writerOptions(channel, descriptor, stoppedOnly), async leases => {
        const checked = new Set();
        for (const item of plan.filter(entry => entry.adds)) {
          await assertClientsWithoutPack(overlappingClients(item.serverPath));
          await assertServerDestination(item.serverPath);
          checked.add(item.key);
        }
        // Re-plan against the registry as it is now. Run the handler only when
        // every folder it adds or removes is held (and checked when added).
        const held = new Set(leases.map(lease => folderKey(lease.serverPath)));
        const current = planInstanceSave(args);
        if (current.some(item => !held.has(item.key) || (item.adds && !checked.has(item.key)) ||
            (item.removes && !stoppedOnly))) throw operationInProgress();
        const outcome = await handler(event, ...args);
        if (descriptor.markOnSuccess && mutationSucceeded(outcome)) leases.forEach(lease => lease.markDirty());
        if (mutationSucceeded(outcome)) leases.forEach(retireRemovedRegistration);
        return outcome;
      });
    if (mutationSucceeded(result)) retireDisappearedClients(clientsBefore);
    return result;
  }

  function wrapHandler(channel, handler) {
    if (typeof handler !== 'function') throw invalidRequest();
    const descriptor = SERVER_WRITER_POLICIES[channel];
    if (!descriptor || descriptor.kind === 'manual' || descriptor.kind === 'internal') return handler;

    return async function coordinatedServerWriter(event, ...args) {
      if (channel === 'save-client-config') {
        // Saving a connection is never authority to seed or replace personal game files.
        args = [{ ...args[0], initializeMultiplayer: false }, ...args.slice(1)];
      }
      if (descriptor.kind === 'many') return runInstanceSave(channel, descriptor, handler, event, args);
      if (INSTANCE_REGISTRATION_CHANNELS.has(channel)) {
        // The id may name a server or a client; an unknown id gets the handler's
        // own 'Instance not found', as in v26.6.1.
        const id = args[0]?.id;
        if (typeof id !== 'string' || !registeredInstances(getInstances, ['server']).some(instance => instance.id === id)) {
          if (typeof id === 'string' && registeredInstances(getInstances, ['client']).some(instance => instance.id === id)) {
            return runClientRegistration(channel, descriptor, handler, event, args, id);
          }
          return handler(event, ...args);
        }
      }
      return runSingleWriter(channel, descriptor, handler, event, args);
    };
  }

  function wrapHandlers(handlers) {
    if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) throw invalidRequest();
    return Object.fromEntries(Object.entries(handlers).map(([channel, handler]) => [
      channel,
      typeof handler === 'function' ? wrapHandler(channel, handler) : handler
    ]));
  }

  return Object.freeze({
    getPolicy(channel) {
      return SERVER_WRITER_POLICIES[channel] || null;
    },
    wrapHandler,
    wrapHandlers
  });
}

module.exports = {
  CONTENT_SERVER_WRITER_POLICIES,
  CORE_SERVER_WRITER_POLICIES,
  NESTED_MANAGED_CLIENT_MESSAGE,
  SERVER_WRITER_POLICIES,
  createServerMutationPolicy,
  runInWriteLane
};
