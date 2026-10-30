const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const AdmZip = require('adm-zip');

async function withBackupService(fn) {
  const modulePath = path.resolve(__dirname, '../electron/services/backup-service.cjs');
  const originalLoad = Module._load;
  const sentEvents = [];

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === '../ipc/logger-handlers.cjs' || request.includes('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    }

    if (request === '../utils/safe-send.cjs' || request.endsWith('/safe-send.cjs')) {
      return {
        safeSend(channel, data) {
          sentEvents.push({ channel, data });
        }
      };
    }

    if (request === './server-manager.cjs' || request.endsWith('/server-manager.cjs')) {
      return {
        sendServerCommand() {},
        getServerState() {
          return { status: 'Stopped' };
        }
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const backupService = require(modulePath);
    return await fn(backupService, { sentEvents });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

async function withTempServer(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-backup-realpath-'));
  const serverPath = path.join(root, 'server');
  await fsp.mkdir(path.join(serverPath, 'backups'), { recursive: true });

  try {
    return await fn({ root, serverPath, backupDir: path.join(serverPath, 'backups') });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

// Some RAM disks and virtual drives cannot report a final path, and libuv then
// fails native realpath with EISDIR for a directory that exists. Ordinary
// backups worked on such drives in v26.6.1.
function failNativeRealpath(t) {
  return t.mock.method(fs.realpathSync, 'native', () => {
    throw Object.assign(new Error('EISDIR: illegal operation on a directory, realpath'), { code: 'EISDIR' });
  });
}

async function writeBackupFiles(backupDir, name, metadata, modifiedAt = null) {
  const zipPath = path.join(backupDir, name);
  const metaPath = zipPath.replace(/\.zip$/i, '.json');
  await fsp.writeFile(zipPath, 'backup bytes');
  await fsp.writeFile(metaPath, JSON.stringify(metadata, null, 2));
  if (modifiedAt) {
    await fsp.utimes(zipPath, modifiedAt, modifiedAt);
    await fsp.utimes(metaPath, modifiedAt, modifiedAt);
  }
  return { zipPath, metaPath };
}

test('a manual world backup is created, listed, renamed and deleted where native realpath fails', async (t) => {
  await withBackupService(async (backupService) => {
    await withTempServer(async ({ serverPath, backupDir }) => {
      await fsp.mkdir(path.join(serverPath, 'world', 'region'), { recursive: true });
      await fsp.writeFile(path.join(serverPath, 'world', 'level.dat'), Buffer.alloc(4096, 1));
      await fsp.writeFile(path.join(serverPath, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(8192, 2));
      const nativeRealpath = failNativeRealpath(t);

      const created = await backupService.safeCreateBackup({ serverPath, type: 'world', trigger: 'manual' });
      assert.match(created.name, /^backup-world-.+\.zip$/);
      const zipPath = path.join(backupDir, created.name);
      const metaPath = zipPath.replace(/\.zip$/i, '.json');
      const metadata = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      assert.equal(metadata.type, 'world');
      assert.equal(metadata.trigger, 'manual');
      assert.equal(metadata.status, 'complete');
      const entries = new AdmZip(zipPath).getEntries().map(entry => entry.entryName.replace(/\\/g, '/'));
      assert.equal(entries.includes('world/level.dat'), true);
      assert.equal(entries.includes('world/region/r.0.0.mca'), true);
      assert.ok(nativeRealpath.mock.callCount() > 0);

      const listed = await backupService.listBackupsWithMetadata(serverPath);
      assert.deepEqual(listed.map(backup => [backup.name, backup.metadata?.status]), [[created.name, 'complete']]);

      await backupService.renameBackup({ serverPath, oldName: created.name, newName: 'before-the-trip.zip' });
      assert.equal(fs.existsSync(zipPath), false);
      assert.equal(fs.existsSync(metaPath), false);
      assert.equal(fs.existsSync(path.join(backupDir, 'before-the-trip.zip')), true);
      assert.equal(fs.existsSync(path.join(backupDir, 'before-the-trip.json')), true);

      assert.deepEqual(await backupService.deleteBackup({ serverPath, name: 'before-the-trip.zip' }), { success: true });
      assert.deepEqual(fs.readdirSync(backupDir), []);
      assert.deepEqual(await backupService.listBackupsWithMetadata(serverPath), []);
    });
  });
});

test('stale incomplete backups are cleaned up where native realpath fails', async (t) => {
  await withBackupService(async (backupService) => {
    await withTempServer(async ({ serverPath, backupDir }) => {
      const staleDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const { zipPath, metaPath } = await writeBackupFiles(backupDir, 'backup-world-2026-10-01_10-00-00.zip', {
        type: 'world',
        timestamp: staleDate.toISOString(),
        size: 0,
        trigger: 'manual',
        status: 'in-progress'
      }, staleDate);
      failNativeRealpath(t);

      const cleanup = await backupService.cleanupIncompleteBackups(serverPath);
      assert.equal(cleanup.success, true);
      assert.equal(cleanup.deleted, 1);
      assert.equal(fs.existsSync(zipPath), false);
      assert.equal(fs.existsSync(metaPath), false);
    });
  });
});

test('automatic backup retention prunes the oldest backups where native realpath fails', async (t) => {
  await withBackupService(async (backupService) => {
    await withTempServer(async ({ serverPath, backupDir }) => {
      const names = [];
      for (const day of [1, 2, 3]) {
        const name = `backup-world-2026-10-0${day}_10-00-00.zip`;
        names.push(name);
        await writeBackupFiles(backupDir, name, {
          type: 'world',
          timestamp: new Date(Date.UTC(2026, 9, day, 10)).toISOString(),
          size: 12,
          trigger: 'auto',
          automated: true,
          status: 'complete'
        });
      }
      failNativeRealpath(t);

      const result = await backupService.cleanupAutomaticBackups(serverPath, 1);
      assert.equal(result.success, true, result.error);
      assert.equal(result.deleted, 2);
      assert.deepEqual(fs.readdirSync(backupDir).sort(), [
        'backup-world-2026-10-03_10-00-00.json',
        names[2]
      ]);
    });
  });
});
