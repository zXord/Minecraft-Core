const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The panel's unrelated boundaries are stubbed; its writer delegates, the
// shared mutation policy and the coordinator are real.
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };
const calls = { deleteMod: 0, startManagement: 0 };
const STUBS = new Map([
  ['logger-handlers.cjs', { getLoggerHandlers: () => SILENT }],
  ['app-store.cjs', { get: () => null, set() {}, delete() {} }],
  ['safe-send.cjs', { safeSend() {} }],
  ['server-manager.cjs', {
    getServerState: () => ({ isRunning: false, status: 'Stopped' }),
    sendServerCommand() {},
    startMinecraftServer() {},
    stopMinecraftServer() {},
    killMinecraftServer() {}
  }],
  ['management-server.cjs', { getManagementServer: () => null }],
  ['tls-utils.cjs', { getBrowserPanelTlsConfig: () => null }],
  ['player-handlers.cjs', { createPlayerHandlers: () => ({}) }],
  ['server-properties-handlers.cjs', { createServerPropertiesHandlers: () => ({}) }],
  ['server-mod-handlers.cjs', {
    createServerModHandlers: () => ({
      'delete-mod': async () => {
        calls.deleteMod += 1;
        return true;
      }
    })
  }],
  ['mod-info-handlers.cjs', { createModInfoHandlers: () => ({}) }],
  ['management-server-handlers.cjs', {
    createManagementServerHandlers: () => ({
      'start-management-server': async (_event, { port }) => {
        calls.startManagement += 1;
        return { success: true, port };
      }
    })
  }],
  ['server-java-manager.cjs', { ServerJavaManager: class StubServerJavaManager {} }],
  ['auto-restart.cjs', { setAutoRestartOptions() {}, getAutoRestartState() {} }]
]);
const originalLoad = Module._load;
Module._load = function stubBoundaries(request, parent, isMain) {
  const stub = typeof request === 'string' ? STUBS.get(path.posix.basename(request)) : undefined;
  return stub || originalLoad(request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; });

const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { installServerMutationCoordinator } = require('../electron/services/server-mutation-context.cjs');
const { createServerMutationPolicy } = require('../electron/services/server-mutation-policy.cjs');
const browserPanel = require('../electron/services/browser-panel-server.cjs');

const BROWSER = { sender: { id: 'browser' } };

test('the browser panel writes through the app policy once it is configured', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedPath = path.join(root, 'Managed');
  const plainPath = path.join(root, 'Plain');
  for (const folder of [managedPath, plainPath]) fs.mkdirSync(path.join(folder, 'mods'), { recursive: true });
  const instances = [
    { id: 'server-managed', type: 'server', path: managedPath },
    { id: 'server-plain', type: 'server', path: plainPath }
  ];
  let revision = 0;
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => revision, bumpContentRevision: () => ++revision });
  coordinator.completeStartupRecovery([]);
  installServerMutationCoordinator(coordinator);
  const shared = createServerMutationPolicy({
    coordinator,
    getInstances: () => instances,
    getModpackStateRepository: () => ({
      read: async serverPath => (path.resolve(serverPath) === path.resolve(managedPath) ? { state: { modpackManaged: true } } : null)
    }),
    getClientPackIntegration: () => ({ async assertServerDestination() {} })
  });

  // The IPC handlers create the panel before the app hands it the shared policy.
  const panel = browserPanel.getBrowserPanel();
  browserPanel.configureBrowserPanelMutationPolicy(shared);
  assert.equal(browserPanel.getBrowserPanel(), panel);

  await assert.rejects(panel.browserWriterHandlers.serverMods['delete-mod'](BROWSER, managedPath, 'addon.jar'),
    { code: 'MANAGED_MOD_EDIT_BLOCKED' });
  assert.equal(calls.deleteMod, 0);
  assert.equal(await panel.browserWriterHandlers.serverMods['delete-mod'](BROWSER, plainPath, 'addon.jar'), true);
  assert.equal(calls.deleteMod, 1);

  const start = (serverPath, pid) => coordinator.acquireStart({ instanceId: null, serverPath },
    { operation: 'server-start', operationId: `browser-run-${pid}`, parentMutationLease: null })
    .then(lease => lease.markRunning({ pid }));
  const plainRun = await start(plainPath, 9101);
  const managedRun = await start(managedPath, 9102);
  try {
    // Starting management for a running server without a modpack is fine, as in v26.6.1.
    assert.deepEqual(await panel.browserWriterHandlers.management['start-management-server'](BROWSER, { port: 8080, serverPath: plainPath }),
      { success: true, port: 8080 });
    // A modpack-managed server needs to be stopped first.
    await assert.rejects(panel.browserWriterHandlers.management['start-management-server'](BROWSER, { port: 8081, serverPath: managedPath }),
      { code: 'SERVER_RUNNING' });
  } finally {
    plainRun.release();
    managedRun.release();
  }
  assert.equal(calls.startManagement, 1);
});

test('the browser panel refuses a policy without writer wrapping', () => {
  assert.throws(() => browserPanel.configureBrowserPanelMutationPolicy({}), TypeError);
  assert.throws(() => browserPanel.configureBrowserPanelMutationPolicy(null), TypeError);
});
