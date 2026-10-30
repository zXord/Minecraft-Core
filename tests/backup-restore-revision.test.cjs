const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const AdmZip = require('adm-zip');

const { configureServerConfigDurableFsFactory } = require('../electron/utils/config-manager.cjs');
const { readContentRevision } = require('../electron/services/server-content-revision.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationPolicy } = require('../electron/services/server-mutation-policy.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { createInstanceConfigFsFactory } = require('../electron/utils/instance-config-fs.cjs');

let sequence = 0;

function strictFactory(roots) {
  return createDurableFs({
    fsApi: fs,
    allowedRoots: [...roots],
    tempNameFactory: () => `restore-revision-${++sequence}`,
    durableClient: {
      moveWriteThrough: (source, destination) => fs.renameSync(source, destination),
      replaceFileWriteThrough: (source, destination) => fs.renameSync(source, destination),
      flushDirectory() {}
    }
  });
}

const WRITERS = [
  ['the strict durable writer', strictFactory],
  ['the instance-config writer selection', createInstanceConfigFsFactory({ strictFactory })]
];

function loadBackupService(t) {
  const modulePath = path.resolve(__dirname, '../electron/services/backup-service.cjs');
  const originalLoad = Module._load;
  Module._load = function mockLoad(request, parent, isMain) {
    if (request.includes('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    }
    if (request.endsWith('/safe-send.cjs') || request === '../utils/safe-send.cjs') return { safeSend() {} };
    if (request.endsWith('/server-manager.cjs') || request === './server-manager.cjs') {
      return { sendServerCommand() {}, getServerState: () => ({ isRunning: false, status: 'Stopped' }) };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
    t.after(() => { delete require.cache[modulePath]; });
  }
}

function serverAtRevision(t, revision) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-restore-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(path.join(serverPath, 'world'), { recursive: true });
  fs.mkdirSync(path.join(serverPath, 'backups'));
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), 'live-world');
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), `${JSON.stringify({
    port: 25565,
    maxRam: 4,
    contentRevision: revision
  }, null, 2)}\n`);
  return serverPath;
}

function writeBackup(serverPath, name, type, entries) {
  const zip = new AdmZip();
  for (const [entryName, content] of Object.entries(entries)) zip.addFile(entryName, Buffer.from(content));
  zip.writeZip(path.join(serverPath, 'backups', name));
  fs.writeFileSync(path.join(serverPath, 'backups', name.replace(/\.zip$/, '.json')), JSON.stringify({
    type,
    timestamp: '2026-06-01T10:00:00.000Z',
    size: 1,
    trigger: 'manual',
    status: 'complete'
  }));
}

function coordinatedRestore(t, serverPath, durableFsFactory) {
  const backupService = loadBackupService(t);
  configureServerConfigDurableFsFactory(durableFsFactory);
  const coordinator = new ServerMutationCoordinator({ durableFsFactory });
  coordinator.completeStartupRecovery([]);
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'restore-server', type: 'server', path: serverPath }],
    createOperationId: () => `restore-revision-op-${++sequence}`
  });
  const restore = policy.wrapHandler('backups:restore', (_event, request) => backupService.restoreBackup(request));
  return {
    backupService,
    coordinator,
    restore: name => restore({ sender: { id: 1 } }, { serverPath, name, serverStatus: 'Stopped' }),
    async startOnce() {
      const lease = await coordinator.acquireStart({ instanceId: 'restore-server', serverPath }, {
        operation: 'server-start',
        operationId: `restore-revision-start-${++sequence}`,
        parentMutationLease: null
      });
      const base = lease.baseRevision;
      lease.release();
      return base;
    }
  };
}

for (const [label, durableFsFactory] of WRITERS) {
  test(`restoring a v26.6.1 full backup keeps the change counter monotonic with ${label}`, async (t) => {
    const serverPath = serverAtRevision(t, 3);
    writeBackup(serverPath, 'backup-full-2026-06-01_10-00-00.zip', 'full', {
      '.minecraft-core.json': JSON.stringify({ port: 25565, maxRam: 6 }, null, 2),
      'world/level.dat': 'backed-up-world'
    });
    const harness = coordinatedRestore(t, serverPath, durableFsFactory);

    const result = await harness.restore('backup-full-2026-06-01_10-00-00.zip');

    assert.equal(result.success, true, result.error);
    assert.equal(fs.readFileSync(path.join(serverPath, 'world', 'level.dat'), 'utf8'), 'backed-up-world');
    const config = JSON.parse(fs.readFileSync(path.join(serverPath, '.minecraft-core.json'), 'utf8'));
    assert.equal(config.maxRam, 6);
    assert.equal(config.contentRevision, 4);
    assert.equal(await harness.startOnce(), 4);
  });
}

test('restoring a full backup made at an older revision by this build resumes from the live revision', async (t) => {
  const serverPath = serverAtRevision(t, 9);
  writeBackup(serverPath, 'backup-full-2026-06-02_10-00-00.zip', 'full', {
    '.minecraft-core.json': JSON.stringify({ port: 25566, maxRam: 5, contentRevision: 2 }, null, 2),
    'world/level.dat': 'older-world'
  });
  const harness = coordinatedRestore(t, serverPath, WRITERS[1][1]);

  const result = await harness.restore('backup-full-2026-06-02_10-00-00.zip');

  assert.equal(result.success, true, result.error);
  const config = JSON.parse(fs.readFileSync(path.join(serverPath, '.minecraft-core.json'), 'utf8'));
  assert.deepEqual([config.port, config.maxRam, config.contentRevision], [25566, 5, 10]);
  assert.equal(await harness.startOnce(), 10);
});

test('a world-only restore never writes the server config', async (t) => {
  const serverPath = serverAtRevision(t, 3);
  const configPath = path.join(serverPath, '.minecraft-core.json');
  const oldTime = new Date('2026-01-02T03:04:05.000Z');
  fs.utimesSync(configPath, oldTime, oldTime);
  const original = fs.readFileSync(configPath);
  writeBackup(serverPath, 'backup-world-2026-06-01_10-00-00.zip', 'world', {
    'world/level.dat': 'backed-up-world'
  });
  const backupService = loadBackupService(t);
  configureServerConfigDurableFsFactory(() => {
    throw new Error('a world-only restore must not open the config writer');
  });
  t.after(() => configureServerConfigDurableFsFactory(strictFactory));

  const result = await backupService.restoreBackup({
    serverPath,
    name: 'backup-world-2026-06-01_10-00-00.zip',
    serverStatus: 'Stopped'
  });

  assert.equal(result.success, true, result.error);
  assert.equal(fs.readFileSync(path.join(serverPath, 'world', 'level.dat'), 'utf8'), 'backed-up-world');
  assert.deepEqual(fs.readFileSync(configPath), original);
  assert.equal(fs.statSync(configPath).mtimeMs, oldTime.getTime());
  assert.equal(readContentRevision(serverPath), 3);
});

test('a coordinated world-only restore only gains the coordinator bump', async (t) => {
  const serverPath = serverAtRevision(t, 3);
  writeBackup(serverPath, 'backup-world-2026-06-03_10-00-00.zip', 'world', {
    'world/level.dat': 'backed-up-world'
  });
  const harness = coordinatedRestore(t, serverPath, WRITERS[1][1]);

  const result = await harness.restore('backup-world-2026-06-03_10-00-00.zip');

  assert.equal(result.success, true, result.error);
  const config = JSON.parse(fs.readFileSync(path.join(serverPath, '.minecraft-core.json'), 'utf8'));
  assert.deepEqual([config.port, config.maxRam, config.contentRevision], [25565, 4, 4]);
  assert.equal(await harness.startOnce(), 4);
});
