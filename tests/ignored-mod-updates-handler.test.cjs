const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadServerModHandlers({
  getResult = { found: false, data: {} },
  getError = null,
  saveResult = false
} = {}) {
  const originalLoad = Module._load;
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  const calls = { save: [] };
  Module._load = function loadIgnoredUpdatesHandlerFixture(request, parent, isMain) {
    if (request === '../../services/mod-api-service.cjs') return {};
    if (request === '../mod-utils/mod-file-manager.cjs') {
      return {
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
    if (request === '../../utils/server-loader.cjs') return {};
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
