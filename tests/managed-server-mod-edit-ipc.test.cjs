const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createServerMutationPolicy } = require('../electron/services/server-mutation-policy.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { ModpackStateRepository } = require('../electron/services/modpacks/state/modpack-state-repository.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { createModpackServiceGraph } = require('../electron/bootstrap/create-modpack-service-graph.cjs');

// Exercise the real IPC composition and policy. Only unrelated factories/native boundaries are substituted.
function loadSetup({ ipcMain, handlers, store }) {
  const logger = { info() {}, debug() {}, error() {}, warn() {} };
  const module = { exports: {} };
  const exports = module.exports;
  const requireBoundary = request => {
    if (request === 'electron') return { ipcMain };
    if (request === 'fs') return fs;
    if (request.endsWith('utils/ipc-helpers.cjs')) return { registeredHandlers: new Set(), registerIpcHandlers() {} };
    if (request.endsWith('utils/app-store.cjs')) return store;
    if (request.endsWith('server-mutation-policy.cjs')) return { createServerMutationPolicy };
    if (request.endsWith('management-server.cjs')) return { configureClientModpackResolver() {} };
    if (request.endsWith('auto-restart.cjs')) return { setAutoRestartOptions() {}, getAutoRestartState() {} };
    if (request.startsWith('./ipc/')) return new Proxy({}, { get(_target, key) {
      if (key === 'getLoggerHandlers') return () => logger;
      if (key === 'createModHandlers') return () => handlers;
      return () => ({});
    } });
    throw new Error(`Unexpected boundary ${request}`);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/ipc-handlers.cjs'), 'utf8'),
    { require: requireBoundary, module, exports }, { filename: 'ipc-handlers.cjs' });
  return module.exports.setupIpcHandlers;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-edit-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, 'registered'); fs.mkdirSync(server);
  fs.writeFileSync(path.join(server, 'addon.jar'), 'addon remains');
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {}
  } });
  const repository = new ModpackStateRepository({ durableFs });
  repository.writeCandidate(server, {
    schemaVersion: 1, modpackManaged: true,
    source: { provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Pack-Team', githubRepo: 'Pack',
      version: 'v1', title: 'Pack', selectedAssetIds: ['10'], artifactSetDigest: 'a'.repeat(64) },
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' },
    selectedOptionalFiles: [], installedAt: '2026-10-08T00:00:00.000Z', contentRevision: 1,
    manifest: { schemaVersion: 1, installationId: 'install-one', entries: [] }
  });
  // Forged renderer/summary flags must not bypass authoritative persisted ownership.
  fs.writeFileSync(path.join(server, '.minecraft-core.json'), '{"modpackManaged":false}');
  let writes = 0; let revision = 0;
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => revision, bumpContentRevision: () => ++revision });
  coordinator.completeStartupRecovery([]);
  const registered = new Map();
  const store = { get: key => key === 'instances' ? [{ id: 'a', type: 'server', path: server }] : null };
  const setup = loadSetup({ store, ipcMain: { handle: (key, work) => registered.set(key, work), removeHandler() {} },
    handlers: { 'delete-mod': async () => { writes++; fs.unlinkSync(path.join(server, 'addon.jar')); return true; } } });
  const dependencies = { store, serverMutationCoordinator: coordinator,
    clientPackLaunchOptions: { beginManagedLaunch() {} },
    modpacks: { stateRepository: repository, clientPackIntegration: { async assertServerDestination() {} } } };
  return { server, repository, registered, setup, dependencies, stats: () => ({ writes, revision }) };
}
for (const corrupt of [false, true]) test(`production IPC reads ${corrupt ? 'corrupt' : 'managed'} ownership before loose writes`, async t => {
  const f = fixture(t);
  if (corrupt) fs.writeFileSync(path.join(f.server, '.minecraft-core-state', 'modpack.json'), '{broken');
  f.setup({ webContents: { on() {} }, once() {} }, f.dependencies);
  await assert.rejects(f.registered.get('delete-mod')(null, f.server, 'addon.jar'), { code: 'MANAGED_MOD_EDIT_BLOCKED' });
  assert.deepEqual(f.stats(), { writes: 0, revision: 0 });
  assert.equal(fs.readFileSync(path.join(f.server, 'addon.jar'), 'utf8'), 'addon remains');
});
test('production IPC missing expected ownership services fails closed', async t => {
  const f = fixture(t); delete f.dependencies.modpacks.stateRepository;
  f.setup({ webContents: { on() {} }, once() {} }, f.dependencies);
  await assert.rejects(f.registered.get('delete-mod')(null, f.server, 'addon.jar'), { code: 'MANAGED_MOD_EDIT_BLOCKED' });
  assert.deepEqual(f.stats(), { writes: 0, revision: 0 });
});

for (const ownership of ['managed', 'unmanaged', 'absent', 'unavailable']) test(`graph-owned policy through IPC: ${ownership}`, async t => {
  const f = fixture(t);
  if (ownership === 'absent') fs.unlinkSync(path.join(f.server, '.minecraft-core-state', 'modpack.json'));
  if (ownership === 'unmanaged') {
    const stateFile = path.join(f.server, '.minecraft-core-state', 'modpack.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.modpackManaged = false;
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  const graph = createModpackServiceGraph({
    app: { isPackaged: false, getPath: () => path.dirname(f.server) },
    store: f.dependencies.store, coordinator: f.dependencies.serverMutationCoordinator,
    userDataPath: path.dirname(f.server),
    runtimeRoots: { runtimeRoot: path.dirname(f.server), resourcesPath: path.dirname(f.server), isPackaged: false, arch: 'x64' },
    clock: { now: () => 1 }, dnsLookup: async () => [], httpsRequest() {},
    randomUUID: () => '00000000-0000-4000-8000-000000000001', randomBytes: size => Buffer.alloc(size),
    workerFactory() {}, processFactory() {}, windowFactory() {},
    startup: { initializeRecovery: async () => {}, automaticReleaseChecksEnabled: false },
    modpackFactory: async () => ({ stateRepository: f.repository, clientPackIntegration: { async assertServerDestination() {} } })
  });
  if (ownership !== 'unavailable') await graph.startup.initializeRecovery(graph);
  f.setup({ webContents: { on() {} }, once() {} }, graph);
  const write = () => f.registered.get('delete-mod')(null, f.server, 'addon.jar');
  if (ownership === 'managed' || ownership === 'unavailable') {
    await assert.rejects(write(), { code: ownership === 'unavailable' ? 'CLIENT_PACK_UNAVAILABLE' : 'MANAGED_MOD_EDIT_BLOCKED' });
    assert.deepEqual(f.stats(), { writes: 0, revision: 0 });
  } else {
    assert.equal(await write(), true);
    assert.deepEqual(f.stats(), { writes: 1, revision: 1 });
  }
  if (ownership !== 'unavailable') assert.equal(graph.modpacks.stateRepository, f.repository);
});
