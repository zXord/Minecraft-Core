const crypto = require('node:crypto');
const path = require('node:path');

const { ModpackError } = require('./modpacks/errors.cjs');
const { getServerMutationCoordinator } = require('./server-mutation-context.cjs');
const CLIENT_SAFE_SETTINGS_CHANNELS = new Set([
  'minecraft-auth', 'minecraft-save-auth', 'minecraft-import-auth-from-instance', 'minecraft-check-refresh-auth',
  'minecraft-clear-auth', 'set-download-preferences', 'save-client-config'
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
const MANAGED_MOD_EDIT_MESSAGE = 'Individual mod changes are disabled while this server is managed. Use Modpack to change or repair the pack, or review Detach to keep all files and manage mods individually.';

const CORE_SERVER_WRITER_POLICIES = Object.freeze({
  'write-config': policy('write-config', 'payload:serverPath'),
  'update-config': policy('update-config', 'payload:serverPath'),
  'select-folder': manualPolicy('initialize-server-folder'),
  'save-version-selection': policy('save-version-selection', 'payload:path'),
  'write-eula': policy('write-eula', 'payload:path'),
  'delete-world': policy('delete-world', 'string'),
  'update-settings': policy('update-settings', 'payload:serverPath|instanceId'),
  'save-instances': manyPolicy('save-instances'),
  'rename-instance': policy('rename-instance', 'payload:id', { revisionMode: 'none' }),
  'delete-instance': policy('delete-instance', 'payload:id', { revisionMode: 'none' }),
  'write-server-properties': policy('write-server-properties', 'payload:serverPath'),
  'generate-server-properties': policy('generate-server-properties', 'string'),
  'restore-backup-properties': policy('restore-backup-properties', 'string'),
  'download-minecraft-server': policy('download-minecraft-server', 'payload:targetPath'),
  'download-and-install-loader': policy('install-server-loader', 'payload:targetPath|path'),
  'download-and-install-fabric': policy('install-fabric-loader', 'payload:path'),
  'repair-health': policy('repair-server-health', 'payload:targetPath', { markOnSuccess: false }),
  'server-java-ensure': policy('ensure-server-java', 'payload:serverPath', { markOnSuccess: false }),
  'backups:delete': policy('delete-server-backup', 'payload:serverPath', {
    revisionMode: 'none',
    markOnSuccess: false
  }),
  'backups:rename': policy('rename-server-backup', 'payload:serverPath', {
    revisionMode: 'none',
    markOnSuccess: false
  }),
  'backups:restore': policy('restore-server-backup', 'payload:serverPath'),
  'backups:configure-automation': policy('configure-backups', 'payload:serverPath'),
  'backups:apply-retention-policy': policy('apply-backup-retention', 'payload:serverPath', {
    revisionMode: 'none',
    markOnSuccess: false
  }),
  'backups:save-retention-settings': policy('save-backup-retention', 'payload:serverPath', {
    revisionMode: 'none',
    markOnSuccess: false
  }),
  'set-auto-restart': optionalPolicy('set-auto-restart', 'payload:targetPath')
});

const CONTENT_SERVER_WRITER_POLICIES = Object.freeze({
  'start-management-server': serverContentPolicy('start-management-server', 'payload:serverPath|instanceId'),
  'set-management-server-external-host': serverContentPolicy('set-management-server-external-host', 'payload:serverPath|instanceId'),
  'set-management-invite-host': serverContentPolicy('set-management-invite-host', 'payload:serverPath|instanceId'),
  'regenerate-management-invite-secret': serverContentPolicy('regenerate-management-invite-secret', 'payload:serverPath|instanceId'),

  'add-player': serverContentPolicy('add-player', 'arg:1', { markOnSuccess: false }),
  'add-player-with-details': serverContentPolicy('add-player-with-details', 'arg:1', { markOnSuccess: false }),
  'remove-player': serverContentPolicy('remove-player', 'arg:1', { markOnSuccess: false }),

  'direct-add-mod': serverContentPolicy('direct-add-mod', 'payload:serverPath'),
  'save-disabled-mods': serverContentPolicy('save-disabled-mods', 'arg:0'),
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

  'mod-watch:add': serverContentPolicy('add-mod-availability-watch', 'payload:serverPath'),
  'mod-watch:remove': serverContentPolicy('remove-mod-availability-watch', 'payload:serverPath'),
  'mod-watch:clear': serverContentPolicy('clear-mod-availability-watches', 'string'),
  'mod-watch:history:clear': serverContentPolicy('clear-mod-availability-history', 'string')
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

function normalizePathKey(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) return null;
  const resolved = path.resolve(value.trim());
  return process.platform === 'win32'
    ? resolved.toLocaleLowerCase('en-US')
    : resolved;
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

function resolveRegisteredSelector(
  { serverPath, instanceId },
  getInstances,
  { allowNested = false, instanceTypes = ['server'], requireRegistered = false } = {}
) {
  const instances = registeredInstances(getInstances, instanceTypes);
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
  if (byPath && requestedId && byPath.id && byPath.id !== requestedId) throw invalidRequest();

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

function selectorKey(selector) {
  return normalizePathKey(selector.serverPath) || `id:${selector.instanceId}`;
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

function resolveManySelectors(args, getInstances) {
  const current = registeredInstances(getInstances, ['server']);
  const incoming = normalizeInstances(args[0]).filter(instance => instance.type === 'server');
  const selectors = [];
  const seen = new Set();
  for (const instance of [...current, ...incoming]) {
    if (typeof instance.path !== 'string' || instance.path.trim().length === 0) continue;
    const selector = resolveRegisteredSelector({
      instanceId: typeof instance.id === 'string' ? instance.id : null,
      serverPath: instance.path
    }, () => current);
    const key = selectorKey(selector);
    if (seen.has(key)) continue;
    seen.add(key);
    selectors.push(selector);
  }
  return selectors;
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

function createServerMutationPolicy({
  coordinator = getServerMutationCoordinator(),
  getInstances = () => [],
  getClientPackIntegration = null,
  getModpackStateRepository = null,
  createOperationId = defaultOperationId
} = {}) {
  if (!coordinator || typeof coordinator.runMutation !== 'function' ||
      typeof coordinator.runManyMutations !== 'function' || typeof getInstances !== 'function' ||
      typeof createOperationId !== 'function') throw invalidRequest();

  function wrapHandler(channel, handler) {
    if (typeof handler !== 'function') throw invalidRequest();
    const descriptor = SERVER_WRITER_POLICIES[channel];
    if (!descriptor || descriptor.kind === 'manual' || descriptor.kind === 'internal') return handler;

    return async function coordinatedServerWriter(event, ...args) {
      if (channel === 'save-client-config') {
        // Saving a connection is never authority to seed or replace personal game files.
        args = [{ ...args[0], initializeMultiplayer: false }, ...args.slice(1)];
      }
      const operationId = createOperationId(channel);
      const options = {
        operation: descriptor.operation,
        operationId,
        revisionMode: descriptor.revisionMode,
        quiesce: null
      };
      if (descriptor.kind === 'many') {
        const selectors = resolveManySelectors(args, getInstances);
        if (selectors.length === 0) return handler(event, ...args);
        return coordinator.runManyMutations(selectors, options, async leases => {
          const clients = registeredInstances(getInstances, ['client']);
          for (const selector of selectors) {
            if (clients.some(client => pathIsInside(selector.serverPath, client.path) || pathIsInside(client.path, selector.serverPath))) throw invalidRequest();
            if (getClientPackIntegration) {
              const integration = getClientPackIntegration();
              if (!integration?.assertServerDestination) throw new ModpackError('CLIENT_PACK_UNAVAILABLE', 'Matching client ownership services are not ready');
              await integration.assertServerDestination(selector.serverPath);
            }
          }
          const result = await handler(event, ...args);
          if (descriptor.markOnSuccess && mutationSucceeded(result)) {
            for (const lease of leases) lease.markDirty();
          }
          return result;
        });
      }

      const selector = resolveSingleSelector(descriptor, args, getInstances);
      if (!selector) return handler(event, ...args);
      assertSecondaryWriteDestination(channel, args[0], selector);
      return coordinator.runMutation(selector, options, async lease => {
        const perform = () => handler(event, ...args);
        let result;
        const clients = registeredInstances(getInstances, ['client']).filter(instance =>
          pathIsInside(selector.serverPath, instance.path) || pathIsInside(instance.path, selector.serverPath));
        if (getClientPackIntegration && clients.length) {
          if (clients.length !== 1 || !descriptor.instanceTypes?.includes('client') ||
              !pathIsInside(selector.serverPath, clients[0].path)) throw invalidRequest();
          const client = clients[0];
          if (channel === 'minecraft-launch') result = await perform();
          else {
            const integration = getClientPackIntegration();
            const method = CLIENT_SAFE_SETTINGS_CHANNELS.has(channel) ? 'runPersonalMutation' : 'runLegacyMutation';
            if (!integration || typeof integration[method] !== 'function') {
              throw new ModpackError('CLIENT_PACK_UNAVAILABLE', 'Matching client services are not ready');
            }
            result = await integration[method]({ clientId: client.id, clientPath: client.path }, perform);
          }
        } else {
          if (getClientPackIntegration && !CLIENT_SAFE_SETTINGS_CHANNELS.has(channel)) {
            const integration = getClientPackIntegration();
            if (!integration?.assertServerDestination) throw new ModpackError('CLIENT_PACK_UNAVAILABLE', 'Matching client ownership services are not ready');
            await integration.assertServerDestination(selector.serverPath);
          }
          if (getModpackStateRepository && !clients.length && MOD_JAR_EDIT_CHANNELS.has(channel)) {
            // Read only the resolved registered server, inside its mutation reservation.
            const server = registeredInstances(getInstances, ['server']).find(instance =>
              normalizePathKey(instance.path) === normalizePathKey(selector.serverPath));
            if (!server) throw invalidRequest();
            let current;
            try {
              const repository = getModpackStateRepository();
              if (typeof repository?.read !== 'function') throw new Error('State service unavailable');
              current = await repository.read(server.path);
              if (current !== null && typeof current?.state?.modpackManaged !== 'boolean') throw new Error('Invalid state');
            } catch (cause) {
              throw new ModpackError('MANAGED_MOD_EDIT_BLOCKED', MANAGED_MOD_EDIT_MESSAGE, { cause });
            }
            if (current?.state.modpackManaged) throw new ModpackError('MANAGED_MOD_EDIT_BLOCKED', MANAGED_MOD_EDIT_MESSAGE);
          }
          result = await perform();
        }
        if (descriptor.markOnSuccess && mutationSucceeded(result)) lease.markDirty();
        return result;
      });
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
  SERVER_WRITER_POLICIES,
  createServerMutationPolicy
};
