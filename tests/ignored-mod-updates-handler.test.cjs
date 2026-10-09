const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadServerModHandlers({
  getResult = { found: false, data: {} },
  getError = null,
  saveResult = false,
  disabledMods = [],
  installedMods = [],
  inventoryError = null,
  disabledModsError = inventoryError,
  installedModsError = inventoryError,
  resolveLoader = () => ({ loader: 'vanilla' }),
  versionsLookup = async () => []
} = {}) {
  const originalLoad = Module._load;
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  const calls = { save: [], inventory: [], loader: [], versions: [] };
  Module._load = function loadIgnoredUpdatesHandlerFixture(request, parent, isMain) {
    if (request === '../../services/mod-api-service.cjs') {
      return {
        async getModrinthVersions(...args) {
          calls.versions.push(args);
          return versionsLookup(...args);
        }
      };
    }
    if (request === '../mod-utils/mod-file-manager.cjs') {
      return {
        async getDisabledMods(...args) {
          calls.inventory.push(['disabled', ...args]);
          if (disabledModsError) throw disabledModsError;
          return disabledMods;
        },
        async getInstalledModInfo(...args) {
          calls.inventory.push(['installed', ...args]);
          if (installedModsError) throw installedModsError;
          return installedMods;
        },
        async getIgnoredModUpdates() {
          if (getError) throw getError;
          return getResult;
        },
        async saveIgnoredModUpdates(...args) {
          calls.save.push(args);
          return saveResult;
        }
      };
    }
    if (request === '../mod-utils/mod-installation-service.cjs') return {};
    if (request === '../../services/download-manager.cjs') return {};
    if (request === '../../utils/app-store.cjs') return { get: () => [] };
    if (request === './mod-handler-utils.cjs') return {};
    if (request === '../logger-handlers.cjs') return { getLoggerHandlers: () => logger };
    if (request === '../error-monitoring-handlers.cjs') return { serverErrorMonitor: {} };
    if (request === '../../utils/server-loader.cjs') {
      return {
        resolveServerLoader(...args) {
          calls.loader.push(args);
          return resolveLoader(...args);
        }
      };
    }
    if (request === '../../utils/security-boundaries.cjs') return {};
    if (request === '../../services/server-mutation-context.cjs') {
      return { markCurrentServerMutationDirty() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve('../electron/ipc/mod-handlers/server-mod-handlers.cjs');
  delete require.cache[modulePath];
  try {
    return { handlers: require(modulePath).createServerModHandlers(null), calls };
  } finally {
    Module._load = originalLoad;
  }
}

test('check-disabled-mod-updates skips runtime and provider lookup when no disabled work exists', async () => {
  const { handlers, calls } = loadServerModHandlers({
    disabledMods: [],
    resolveLoader() { throw new Error('runtime must not be inspected'); },
    versionsLookup: async () => { throw new Error('provider must not be queried'); }
  });

  const result = await handlers['check-disabled-mod-updates'](
    { sender: { id: 1 } },
    { serverPath: 'C:\\server', mcVersion: '1.20.1' }
  );

  assert.deepEqual(result, []);
  assert.deepEqual(calls.loader, []);
  assert.deepEqual(calls.versions, []);
});

test('check-disabled-mod-updates skips runtime when disabled names have no installed records', async () => {
  const { handlers, calls } = loadServerModHandlers({
    disabledMods: ['missing.jar'],
    installedMods: [{ fileName: 'other.jar', projectId: 'project' }],
    resolveLoader() { throw new Error('runtime must not be inspected'); },
    versionsLookup: async () => { throw new Error('provider must not be queried'); }
  });

  const result = await handlers['check-disabled-mod-updates'](
    { sender: { id: 1 } },
    { serverPath: 'C:\\server', mcVersion: '1.20.1' }
  );

  assert.deepEqual(result, []);
  assert.deepEqual(calls.loader, []);
  assert.deepEqual(calls.versions, []);
});

test('check-disabled-mod-updates preserves nonempty work behavior and validates the runtime', async () => {
  const { handlers, calls } = loadServerModHandlers({
    disabledMods: ['disabled.jar'],
    installedMods: [{ fileName: 'disabled.jar', name: 'Disabled mod', projectId: 'disabled-project', version: '1.0' }],
    resolveLoader: serverPath => ({ loader: serverPath === 'C:\\server' ? 'fabric' : 'vanilla' })
  });

  const result = await handlers['check-disabled-mod-updates'](
    { sender: { id: 1 } },
    { serverPath: 'C:\\server', mcVersion: '1.20.1' }
  );

  assert.equal(calls.loader.length, 1);
  assert.deepEqual(calls.versions, [['disabled-project', 'fabric', '1.20.1', false]]);
  assert.deepEqual(result, [{
    projectId: 'disabled-project',
    fileName: 'disabled.jar',
    name: 'Disabled mod',
    currentVersion: '1.0',
    hasUpdate: false,
    updateAvailable: false,
    isCompatibleUpdate: false,
    reason: 'No versions available for Minecraft 1.20.1'
  }]);
});

test('check-disabled-mod-updates keeps inventory read failures as failures', async () => {
  const { handlers, calls } = loadServerModHandlers({
    disabledMods: ['disabled.jar'],
    installedMods: [],
    inventoryError: new Error('inventory unavailable'),
    resolveLoader() { throw new Error('loader should not be reached'); }
  });

  await assert.rejects(
    handlers['check-disabled-mod-updates'](
      { sender: { id: 1 } },
      { serverPath: 'C:\\server', mcVersion: '1.20.1' }
    ),
    /Failed to check disabled mod updates: inventory unavailable/
  );
  assert.deepEqual(calls.loader, []);
});

test('check-disabled-mod-updates propagates second inventory read failures without runtime or provider calls', async () => {
  const { handlers, calls } = loadServerModHandlers({
    disabledMods: ['disabled.jar'],
    installedModsError: new Error('installed inventory unavailable')
  });

  await assert.rejects(
    handlers['check-disabled-mod-updates'](
      { sender: { id: 1 } },
      { serverPath: 'C:\\server', mcVersion: '1.20.1' }
    ),
    /Failed to check disabled mod updates: installed inventory unavailable/
  );
  assert.deepEqual(calls.inventory.map(([read]) => read), ['disabled', 'installed']);
  assert.deepEqual(calls.loader, []);
  assert.deepEqual(calls.versions, []);
});

test('check-disabled-mod-updates keeps runtime failures for nonempty work as failures', async () => {
  const { handlers, calls } = loadServerModHandlers({
    disabledMods: ['disabled.jar'],
    installedMods: [{ fileName: 'disabled.jar', projectId: 'project' }],
    resolveLoader() { throw new Error('runtime rejected'); }
  });

  await assert.rejects(
    handlers['check-disabled-mod-updates'](
      { sender: { id: 1 } },
      { serverPath: 'C:\\server', mcVersion: '1.20.1' }
    ),
    /Failed to check disabled mod updates: runtime rejected/
  );
  assert.equal(calls.loader.length, 1);
});

test('save-ignored-mod-updates reports whether persistence changed the file', async () => {
  const { handlers } = loadServerModHandlers({ saveResult: false });

  const result = await handlers['save-ignored-mod-updates'](
    { sender: { id: 1 } },
    'C:\\server',
    '{}'
  );

  assert.deepEqual(result, { success: true, changed: false });
});

test('get-ignored-mod-updates returns a strict missing-data envelope', async () => {
  const { handlers } = loadServerModHandlers({ getResult: { found: false, data: {} } });

  const result = await handlers['get-ignored-mod-updates'](
    { sender: { id: 1 } },
    'C:\\server'
  );

  assert.deepEqual(result, { success: true, found: false, data: {} });
});

test('get-ignored-mod-updates returns a strict persisted-data envelope', async () => {
  const data = { 'Example.jar': { ids: ['version-one'], vers: [] } };
  const { handlers } = loadServerModHandlers({ getResult: { found: true, data } });

  const result = await handlers['get-ignored-mod-updates'](
    { sender: { id: 1 } },
    'C:\\server'
  );

  assert.deepEqual(result, { success: true, found: true, data });
});

test('get-ignored-mod-updates returns a failure envelope for parse or I/O errors', async () => {
  const { handlers } = loadServerModHandlers({ getError: new Error('ignored updates are unreadable') });

  const result = await handlers['get-ignored-mod-updates'](
    { sender: { id: 1 } },
    'C:\\server'
  );

  assert.deepEqual(result, { success: false, error: 'ignored updates are unreadable' });
});

test('save-ignored-mod-updates rejects malformed JSON without erasing persisted data', async () => {
  const { handlers, calls } = loadServerModHandlers({ saveResult: true });

  const result = await handlers['save-ignored-mod-updates'](
    { sender: { id: 1 } },
    'C:\\server',
    '{"broken":'
  );

  assert.equal(result.success, false);
  assert.match(result.error, /JSON|Unexpected|position|end/i);
  assert.deepEqual(calls.save, []);
});
