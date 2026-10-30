const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

// Boundaries with process-wide side effects (logger IPC, the real app store,
// the server process registry) and the browser panel's unrelated handler
// groups are stubbed for this whole file. Backup, ownership and state code
// runs for real.
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };
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
  ['server-mod-handlers.cjs', { createServerModHandlers: () => ({}) }],
  ['mod-info-handlers.cjs', { createModInfoHandlers: () => ({}) }],
  ['management-server-handlers.cjs', { createManagementServerHandlers: () => ({}) }],
  ['server-java-manager.cjs', { ServerJavaManager: class StubServerJavaManager {} }],
  ['auto-restart.cjs', { setAutoRestartOptions() {}, getAutoRestartState() {} }]
]);
const originalLoad = Module._load;
Module._load = function stubBoundaries(request, parent, isMain) {
  const stub = typeof request === 'string' ? STUBS.get(path.posix.basename(request)) : undefined;
  return stub || originalLoad(request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; });

const backupHandlers = require('../electron/ipc/backup-handlers.cjs');
const backupService = require('../electron/services/backup-service.cjs');
const { BrowserPanelServer } = require('../electron/services/browser-panel-server.cjs');
const { ModpackStateRepository } = require('../electron/services/modpacks/state/modpack-state-repository.cjs');
const { readContentRevision } = require('../electron/services/server-content-revision.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationPolicy } = require('../electron/services/server-mutation-policy.cjs');
const { configureServerConfigDurableFsFactory } = require('../electron/utils/config-manager.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { createInstanceConfigFsFactory } = require('../electron/utils/instance-config-fs.cjs');

const BLOCKED = 'MANAGED_BACKUP_RESTORE_BLOCKED';
const EVENT = { sender: { id: 1 } };
const FULL_BACKUP = 'backup-full-2026-06-01_10-00-00.zip';
const WORLD_BACKUP = 'backup-world-2026-06-02_10-00-00.zip';
const RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64'
});
// A full backup taken while an older pack release was installed.
const OLDER_FULL_BACKUP = Object.freeze({
  '.minecraft-core.json': JSON.stringify({ port: 25565, maxRam: 6, contentRevision: 2, modpackManaged: true }, null, 2),
  '.minecraft-core-state/modpack.json': '{"schemaVersion":1,"modpackManaged":true,"contentRevision":2}',
  'mods/pack-mod.jar': 'pack mod v1',
  'config/pack.toml': 'pack config v1',
  'world/level.dat': 'backed-up-world'
});
// What v26.6.1 writes for a full backup: no modpack state and no change counter.
const V26_FULL_BACKUP = Object.freeze({
  '.minecraft-core.json': JSON.stringify({ port: 25565, maxRam: 6 }, null, 2),
  'mods/pack-mod.jar': 'pack mod v1',
  'config/pack.toml': 'pack config v1',
  'world/level.dat': 'backed-up-world'
});
const WORLD_ONLY_BACKUP = Object.freeze({
  'world/level.dat': 'backed-up-world',
  'world_nether/DIM-1/level.dat': 'backed-up-nether'
});

let sequence = 0;
function strictFactory(roots) {
  return createDurableFs({
    fsApi: fs,
    allowedRoots: [...roots],
    tempNameFactory: () => `managed-restore-${++sequence}`,
    durableClient: {
      moveWriteThrough: (source, destination) => fs.renameSync(source, destination),
      replaceFileWriteThrough: (source, destination) => fs.renameSync(source, destination),
      flushDirectory() {}
    }
  });
}
const instanceConfigFsFactory = createInstanceConfigFsFactory({ strictFactory });
configureServerConfigDurableFsFactory(instanceConfigFsFactory);

function writeTree(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function createServer(t, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-managed-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server');
  writeTree(serverPath, {
    'world/level.dat': 'live-world',
    'world_nether/DIM-1/level.dat': 'live-nether',
    'mods/pack-mod.jar': 'pack mod v2',
    'config/pack.toml': 'pack config v2',
    'server.properties': 'server-port=25565\n',
    ...extraFiles
  });
  fs.mkdirSync(path.join(serverPath, 'backups'));
  return { root, serverPath };
}

// Publishes real modpack state through the strict repository, as an install does.
function createManagedServer(t) {
  const server = createServer(t);
  const repository = new ModpackStateRepository({ durableFs: strictFactory([server.root]) });
  repository.writeCandidate(server.serverPath, {
    schemaVersion: 1,
    modpackManaged: true,
    source: {
      provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Pack-Team', githubRepo: 'Pack',
      version: 'v2', title: 'Pack', selectedAssetIds: ['10'], artifactSetDigest: 'a'.repeat(64)
    },
    runtime: { ...RUNTIME },
    selectedOptionalFiles: [],
    installedAt: '2026-10-08T00:00:00.000Z',
    contentRevision: 5,
    manifest: { schemaVersion: 1, installationId: 'install-two', entries: [] }
  });
  return { ...server, repository };
}

function setModpackManaged(serverPath, modpackManaged) {
  const statePath = path.join(serverPath, '.minecraft-core-state', 'modpack.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.modpackManaged = modpackManaged;
  fs.writeFileSync(statePath, JSON.stringify(state));
}

function zipBuffer(entries) {
  const zip = new AdmZip();
  for (const [entryName, content] of Object.entries(entries)) zip.addFile(entryName, Buffer.from(content));
  return zip.toBuffer();
}

function writeBackup(serverPath, name, type, archive) {
  const backupDir = path.join(serverPath, 'backups');
  fs.writeFileSync(path.join(backupDir, name), Buffer.isBuffer(archive) ? archive : zipBuffer(archive));
  if (type) {
    fs.writeFileSync(path.join(backupDir, name.replace(/\.zip$/, '.json')), JSON.stringify({
      type, timestamp: '2026-06-01T10:00:00.000Z', size: 1, trigger: 'manual', status: 'complete'
    }));
  }
}

// AdmZip normalises names when it adds them, so an entry that climbs out of
// the world folder is written by patching an equal-length name in place.
function worldBackupThatClimbsOut() {
  const placeholder = Buffer.from('world/zz/.minecraft-core-state');
  const climbing = Buffer.from('world/../.minecraft-core-state');
  const archive = zipBuffer({
    'world/level.dat': 'backed-up-world',
    'world/zz/.minecraft-core-state/modpack.json': '{"schemaVersion":1,"modpackManaged":true,"contentRevision":1}'
  });
  let patched = 0;
  for (let index = archive.indexOf(placeholder); index !== -1; index = archive.indexOf(placeholder, index + 1)) {
    climbing.copy(archive, index);
    patched += 1;
  }
  assert.equal(patched, 2, 'the local and central names are both patched');
  return archive;
}

function snapshot(directory, prefix = '') {
  const result = {};
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (child.startsWith(prefix) || prefix.startsWith(`${child}/`)) walk(child);
        continue;
      }
      if (!child.startsWith(prefix)) continue;
      const absolute = path.join(directory, ...child.split('/'));
      result[child] = `${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}@${fs.statSync(absolute).mtimeMs}`;
    }
  };
  walk('');
  return result;
}

function contents(serverPath, relativePath) {
  return fs.readFileSync(path.join(serverPath, ...relativePath.split('/')), 'utf8');
}

function preRestoreBackups(serverPath) {
  return fs.readdirSync(path.join(serverPath, 'backups')).filter(name => name.startsWith('pre-restore-')).sort();
}

function restoreHandler(options) {
  const handler = backupHandlers.createBackupHandlers(options)['backups:restore'];
  return (serverPath, name) => handler(EVENT, { serverPath, name, serverStatus: 'Stopped' });
}

function assertManagedRefusal(result) {
  assert.equal(result.success, false);
  assert.equal(result.code, BLOCKED);
  assert.match(result.error, /managed/);
  assert.match(result.error, /Restore-point rollback/);
  assert.match(result.error, /Detach/);
  assert.match(result.error, /World backups can still be restored/);
}

function assertUncheckedRefusal(result) {
  assert.equal(result.success, false);
  assert.equal(result.code, BLOCKED);
  assert.match(result.error, /could not be checked/);
  assert.match(result.error, /Restore-point rollback/);
  assert.match(result.error, /Detach/);
}

test('a full backup restore on a modpack-managed server is refused before any file changes', async t => {
  const { serverPath, repository } = createManagedServer(t);
  writeBackup(serverPath, FULL_BACKUP, 'full', OLDER_FULL_BACKUP);
  const before = snapshot(serverPath);

  const result = await restoreHandler({ getModpackStateRepository: () => repository })(serverPath, FULL_BACKUP);

  assertManagedRefusal(result);
  assert.deepEqual(snapshot(serverPath), before);
});

for (const [label, name, type, archive] of [
  ['a backup without metadata (restored as a full backup)', 'backup-2026-06-03_10-00-00.zip', null, OLDER_FULL_BACKUP],
  ['a world-labelled backup that also holds modpack state', 'backup-world-2026-06-04_10-00-00.zip', 'world', {
    'world/level.dat': 'backed-up-world',
    '.minecraft-core-state/modpack.json': '{"schemaVersion":1,"modpackManaged":true,"contentRevision":1}'
  }],
  ['a world-labelled backup whose entry climbs out of the world folder', 'backup-world-2026-06-05_10-00-00.zip', 'world',
    worldBackupThatClimbsOut()],
  ['a lifecycle restore-point archive', 'restore-point-2026-06-06T10-00-00.000Z-abcdef.zip', null, OLDER_FULL_BACKUP]
]) {
  test(`${label} is refused on a modpack-managed server`, async t => {
    const { serverPath, repository } = createManagedServer(t);
    writeBackup(serverPath, name, type, archive);
    const before = snapshot(serverPath);

    const result = await restoreHandler({ getModpackStateRepository: () => repository })(serverPath, name);

    assertManagedRefusal(result);
    assert.deepEqual(snapshot(serverPath), before);
  });
}

test('a world-only restore on a modpack-managed server still restores the world', async t => {
  const { serverPath, repository } = createManagedServer(t);
  writeBackup(serverPath, WORLD_BACKUP, 'world', WORLD_ONLY_BACKUP);
  const state = snapshot(serverPath, '.minecraft-core-state/');
  const config = fs.readFileSync(path.join(serverPath, '.minecraft-core.json'));

  const result = await restoreHandler({ getModpackStateRepository: () => repository })(serverPath, WORLD_BACKUP);

  assert.equal(result.success, true, result.error);
  assert.equal(contents(serverPath, 'world/level.dat'), 'backed-up-world');
  assert.equal(contents(serverPath, 'world_nether/DIM-1/level.dat'), 'backed-up-nether');
  assert.equal(contents(serverPath, 'mods/pack-mod.jar'), 'pack mod v2');
  assert.equal(contents(serverPath, 'config/pack.toml'), 'pack config v2');
  assert.deepEqual(snapshot(serverPath, '.minecraft-core-state/'), state);
  assert.deepEqual(fs.readFileSync(path.join(serverPath, '.minecraft-core.json')), config);
  assert.deepEqual(preRestoreBackups(serverPath).map(name => name.replace(/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/, '<time>')),
    ['pre-restore-world-<time>.json', 'pre-restore-world-<time>.zip']);
});

test('through the coordinated IPC writer a refusal keeps the change counter and a world restore gains one bump', async t => {
  const { serverPath, repository } = createManagedServer(t);
  writeBackup(serverPath, FULL_BACKUP, 'full', OLDER_FULL_BACKUP);
  writeBackup(serverPath, WORLD_BACKUP, 'world', WORLD_ONLY_BACKUP);
  const coordinator = new ServerMutationCoordinator({ durableFsFactory: instanceConfigFsFactory });
  coordinator.completeStartupRecovery([]);
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'managed-server', type: 'server', path: serverPath }],
    createOperationId: () => `managed-restore-op-${++sequence}`
  });
  const restore = policy.wrapHandler('backups:restore',
    backupHandlers.createBackupHandlers({ getModpackStateRepository: () => repository })['backups:restore']);
  const request = name => restore(EVENT, { serverPath, name, serverStatus: 'Stopped' });
  const before = snapshot(serverPath);

  assertManagedRefusal(await request(FULL_BACKUP));
  assert.deepEqual(snapshot(serverPath), before);
  assert.equal(readContentRevision(serverPath), 5);

  const state = snapshot(serverPath, '.minecraft-core-state/');
  const restored = await request(WORLD_BACKUP);
  assert.equal(restored.success, true, restored.error);
  assert.equal(contents(serverPath, 'world/level.dat'), 'backed-up-world');
  assert.equal(readContentRevision(serverPath), 6);
  assert.deepEqual(snapshot(serverPath, '.minecraft-core-state/'), state);
  const lease = await coordinator.acquireStart({ instanceId: 'managed-server', serverPath }, {
    operation: 'server-start',
    operationId: `managed-restore-start-${++sequence}`,
    parentMutationLease: null
  });
  assert.equal(lease.baseRevision, 6);
  lease.release();
});

test('a detached server keeps the full backup restore', async t => {
  const { serverPath, repository } = createManagedServer(t);
  setModpackManaged(serverPath, false);
  writeBackup(serverPath, FULL_BACKUP, 'full', OLDER_FULL_BACKUP);

  const result = await restoreHandler({ getModpackStateRepository: () => repository })(serverPath, FULL_BACKUP);

  assert.equal(result.success, true, result.error);
  assert.equal(contents(serverPath, 'mods/pack-mod.jar'), 'pack mod v1');
  assert.equal(contents(serverPath, 'world/level.dat'), 'backed-up-world');
  assert.equal(contents(serverPath, '.minecraft-core-state/modpack.json'), OLDER_FULL_BACKUP['.minecraft-core-state/modpack.json']);
});

for (const [label, prepare] of [
  ['unreadable modpack state', ({ serverPath }) => {
    fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{broken');
    return { getModpackStateRepository: () => new ModpackStateRepository({ durableFs: strictFactory([path.dirname(serverPath)]) }) };
  }],
  ['no modpack state service', () => ({})],
  ['a modpack state service that is not ready', () => ({ getModpackStateRepository: () => null })],
  ['a failing modpack state service', () => ({ getModpackStateRepository: () => { throw new Error('state service failed'); } })]
]) {
  test(`${label} keeps a full restore refused`, async t => {
    const server = createManagedServer(t);
    writeBackup(server.serverPath, FULL_BACKUP, 'full', OLDER_FULL_BACKUP);
    const options = prepare(server);
    const before = snapshot(server.serverPath);

    const result = await restoreHandler(options)(server.serverPath, FULL_BACKUP);

    assertUncheckedRefusal(result);
    assert.deepEqual(snapshot(server.serverPath), before);
  });
}

for (const [label, extraFiles] of [
  ['a v26.6.1 server', {}],
  ['a server with runtime bookkeeping only', { '.minecraft-core-state/runtime.json': '{"pid":1}' }],
  ['a server whose config claims a modpack', {
    '.minecraft-core.json': JSON.stringify({ port: 25565, maxRam: 4, contentRevision: 7, modpackManaged: true }, null, 2)
  }]
]) {
  test(`a full restore on ${label} behaves exactly as before`, async t => {
    const first = createServer(t, extraFiles);
    const second = path.join(first.root, 'twin');
    writeBackup(first.serverPath, FULL_BACKUP, 'full', V26_FULL_BACKUP);
    fs.cpSync(first.serverPath, second, { recursive: true, preserveTimestamps: true });
    const handler = restoreHandler({
      getModpackStateRepository: () => { throw new Error('servers without evidence never read modpack state'); }
    });

    const throughHandler = await handler(first.serverPath, FULL_BACKUP);
    const direct = await backupService.restoreBackup({ serverPath: second, name: FULL_BACKUP, serverStatus: 'Stopped' });

    assert.equal(throughHandler.success, true, throughHandler.error);
    const normalize = result => ({ ...result, preRestoreBackup: result.preRestoreBackup.replace(/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/, '<time>') });
    assert.deepEqual(normalize(throughHandler), normalize(direct));
    const restoredTree = serverPath => Object.fromEntries(Object.entries(snapshot(serverPath))
      .filter(([relativePath]) => !relativePath.startsWith('backups/pre-restore-'))
      .map(([relativePath, digest]) => [relativePath, digest.split('@')[0]]));
    assert.deepEqual(restoredTree(first.serverPath), restoredTree(second));
    assert.equal(contents(first.serverPath, 'mods/pack-mod.jar'), 'pack mod v1');
    assert.equal(preRestoreBackups(first.serverPath).length, 2);
  });
}

test('the browser panel restore route is guarded with the state the app registered', async t => {
  const passthrough = { wrapHandlers: handlers => handlers, wrapHandler: (_channel, handler) => handler };
  const panelRestore = (panel, serverPath, name) => panel.browserWriterHandlers.backups['backups:restore'](
    { sender: { id: 'browser' } }, { serverPath, name, serverStatus: 'Stopped' });

  const managed = createManagedServer(t);
  writeBackup(managed.serverPath, FULL_BACKUP, 'full', OLDER_FULL_BACKUP);
  writeBackup(managed.serverPath, WORLD_BACKUP, 'world', WORLD_ONLY_BACKUP);
  const unmanaged = createServer(t);
  writeBackup(unmanaged.serverPath, FULL_BACKUP, 'full', V26_FULL_BACKUP);
  const before = snapshot(managed.serverPath);

  // Before the app registers its IPC handlers there is no state reader: fail closed.
  backupHandlers.createBackupHandlers();
  const panel = new BrowserPanelServer({ mutationPolicy: passthrough });
  assertUncheckedRefusal(await panelRestore(panel, managed.serverPath, FULL_BACKUP));
  assert.deepEqual(snapshot(managed.serverPath), before);

  backupHandlers.createBackupHandlers({ getModpackStateRepository: () => managed.repository });
  assertManagedRefusal(await panelRestore(panel, managed.serverPath, FULL_BACKUP));
  assert.deepEqual(snapshot(managed.serverPath), before);

  const world = await panelRestore(panel, managed.serverPath, WORLD_BACKUP);
  assert.equal(world.success, true, world.error);
  assert.equal(contents(managed.serverPath, 'world/level.dat'), 'backed-up-world');

  const full = await panelRestore(panel, unmanaged.serverPath, FULL_BACKUP);
  assert.equal(full.success, true, full.error);
  assert.equal(contents(unmanaged.serverPath, 'mods/pack-mod.jar'), 'pack mod v1');
});
