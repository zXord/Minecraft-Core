const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const AdmZip = require('adm-zip');
const { createZip, normalizeCompressionLevel } = require('../electron/utils/backup-util.cjs');

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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-backup-boundary-'));
  const serverPath = path.join(root, 'server');
  await fsp.mkdir(path.join(serverPath, 'backups'), { recursive: true });

  try {
    return await fn({ root, serverPath, backupDir: path.join(serverPath, 'backups') });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('deleteBackup rejects names that escape the backup folder', async () => {
  await withBackupService(async (backupService) => {
    await withTempServer(async ({ serverPath }) => {
      const outsideBackupDirFile = path.join(serverPath, 'outside.zip');
      await fsp.writeFile(outsideBackupDirFile, 'not a backup');

      const result = await backupService.deleteBackup({
        serverPath,
        name: '../outside.zip'
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Invalid backup name/i);
      assert.equal(fs.existsSync(outsideBackupDirFile), true);
    });
  });
});

test('renameBackup rejects target names that escape the backup folder', async () => {
  await withBackupService(async (backupService) => {
    await withTempServer(async ({ serverPath, backupDir }) => {
      const backupPath = path.join(backupDir, 'safe.zip');
      const outsideBackupDirFile = path.join(serverPath, 'renamed.zip');
      await fsp.writeFile(backupPath, 'backup');

      await assert.rejects(
        () => backupService.renameBackup({
          serverPath,
          oldName: 'safe.zip',
          newName: '../renamed.zip'
        }),
        /Invalid backup name/i
      );

      assert.equal(fs.existsSync(backupPath), true);
      assert.equal(fs.existsSync(outsideBackupDirFile), false);
    });
  });
});

test('restoreBackup rejects zip entries that escape the server folder', async () => {
  await withBackupService(async (backupService) => {
    await withTempServer(async ({ serverPath, backupDir }) => {
      const backupPath = path.join(backupDir, 'malicious.zip');
      const outsideServerFile = path.join(path.dirname(serverPath), 'outside.txt');
      const unsafeEntryName = outsideServerFile.replace(/\\/g, '/');
      const zip = new AdmZip();
      zip.addFile(unsafeEntryName, Buffer.from('escaped'));
      zip.writeZip(backupPath);

      const result = await backupService.restoreBackup({
        serverPath,
        name: 'malicious.zip',
        serverStatus: 'Stopped'
      });

      assert.equal(result.success, false);
      assert.match(result.error, /Unsafe backup entry/i);
      assert.equal(fs.existsSync(outsideServerFile), false);
    });
  });
});

test('pre-update full backup emits progress and keeps full backup scope', async () => {
  await withBackupService(async (backupService, { sentEvents }) => {
    await withTempServer(async ({ serverPath, backupDir }) => {
      const folders = [
        'world',
        'mods',
        'config',
        'bluemap',
        'client',
        'java',
        'logs'
      ];

      for (const folder of folders) {
        await fsp.mkdir(path.join(serverPath, folder), { recursive: true });
        await fsp.writeFile(path.join(serverPath, folder, `${folder}.txt`), folder);
      }

      await fsp.writeFile(path.join(serverPath, 'server.jar'), 'server');

      const result = await backupService.safeCreateBackup({
        serverPath,
        type: 'full',
        trigger: 'pre-update'
      });

      assert.equal(result.name.startsWith('backup-full-'), true);

      const backupPath = path.join(backupDir, result.name);
      const zip = new AdmZip(backupPath);
      const entries = zip.getEntries().map(entry => entry.entryName.replace(/\\/g, '/'));

      assert.equal(entries.some(entry => entry.startsWith('world/')), true);
      assert.equal(entries.some(entry => entry.startsWith('mods/')), true);
      assert.equal(entries.some(entry => entry.startsWith('config/')), true);
      assert.equal(entries.includes('server.jar'), true);
      assert.equal(entries.some(entry => entry.startsWith('bluemap/')), true);
      assert.equal(entries.some(entry => entry.startsWith('client/')), true);
      assert.equal(entries.some(entry => entry.startsWith('java/')), true);
      assert.equal(entries.some(entry => entry.startsWith('logs/')), true);

      const progressEvents = sentEvents.filter(event => event.channel === 'backup-progress');
      assert.equal(progressEvents.length > 0, true);
      assert.equal(progressEvents[0].data.trigger, 'pre-update');
      assert.equal(progressEvents.at(-1).data.phase, 'complete');
      assert.equal(progressEvents.at(-1).data.percent, 100);

      const metadataPath = path.join(backupDir, result.name.replace(/\.zip$/i, '.json'));
      const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
      assert.equal(metadata.status, 'complete');
      assert.equal(metadata.compressionLevel, 1);
    });
  });
});

test('listBackupsWithMetadata removes stale incomplete backups but keeps fresh ones', async () => {
  await withBackupService(async (backupService) => {
    await withTempServer(async ({ backupDir, serverPath }) => {
      const staleName = 'backup-full-2026-06-19_21-15-18.zip';
      const staleZipPath = path.join(backupDir, staleName);
      const staleMetaPath = staleZipPath.replace(/\.zip$/i, '.json');
      const staleDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

      await fsp.writeFile(staleZipPath, 'partial zip data');
      await fsp.writeFile(staleMetaPath, JSON.stringify({
        type: 'full',
        timestamp: staleDate.toISOString(),
        size: 0,
        trigger: 'pre-update'
      }, null, 2));
      await fsp.utimes(staleZipPath, staleDate, staleDate);
      await fsp.utimes(staleMetaPath, staleDate, staleDate);

      const freshName = 'backup-full-2026-06-19_22-15-18.zip';
      const freshZipPath = path.join(backupDir, freshName);
      const freshMetaPath = freshZipPath.replace(/\.zip$/i, '.json');

      await fsp.writeFile(freshZipPath, 'still being written');
      await fsp.writeFile(freshMetaPath, JSON.stringify({
        type: 'full',
        timestamp: new Date().toISOString(),
        size: 0,
        trigger: 'pre-update',
        status: 'in-progress'
      }, null, 2));

      const backups = await backupService.listBackupsWithMetadata(serverPath);

      assert.equal(fs.existsSync(staleZipPath), false);
      assert.equal(fs.existsSync(staleMetaPath), false);
      assert.equal(backups.some(backup => backup.name === staleName), false);

      assert.equal(fs.existsSync(freshZipPath), true);
      assert.equal(fs.existsSync(freshMetaPath), true);
      assert.equal(backups.some(backup => backup.name === freshName), true);
    });
  });
});

test('createZip reports a stable precomputed source byte total', async () => {
  await withTempServer(async ({ root }) => {
    const sourceDir = path.join(root, 'source');
    const outputPath = path.join(root, 'backup.zip');
    await fsp.mkdir(path.join(sourceDir, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(sourceDir, 'a.txt'), Buffer.alloc(128));
    await fsp.writeFile(path.join(sourceDir, 'nested', 'b.txt'), Buffer.alloc(256));
    await fsp.writeFile(path.join(sourceDir, 'ignored.tmp'), Buffer.alloc(512));

    const progressEvents = [];
    await createZip([sourceDir], outputPath, {
      onProgress(event) {
        progressEvents.push(event);
      }
    });

    const expectedTotalBytes = 384;
    const byteEvents = progressEvents.filter(event => event.totalBytes);

    assert.equal(byteEvents.length > 0, true);
    for (const event of byteEvents) {
      assert.equal(event.totalBytes, expectedTotalBytes);
    }

    const queued = progressEvents.find(event => event.phase === 'queued');
    assert.equal(queued.totalBytes, expectedTotalBytes);

    const complete = progressEvents.at(-1);
    assert.equal(complete.phase, 'complete');
    assert.equal(complete.totalBytes, expectedTotalBytes);
    assert.equal(complete.processedBytes, expectedTotalBytes);
  });
});

test('backup compression level normalization keeps safe archiver values', () => {
  assert.equal(normalizeCompressionLevel(1), 1);
  assert.equal(normalizeCompressionLevel('0'), 0);
  assert.equal(normalizeCompressionLevel(9), 9);
  assert.equal(normalizeCompressionLevel(-1), 5);
  assert.equal(normalizeCompressionLevel(10), 5);
  assert.equal(normalizeCompressionLevel('fast'), 5);
});
