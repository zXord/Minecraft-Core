const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function shouldIgnoreArchiveEntry(fileName) {
  const normalized = String(fileName || '').toLowerCase();
  return normalized.endsWith('~')
    || normalized.startsWith('tmp')
    || normalized.endsWith('.lock')
    || normalized.endsWith('.tmp');
}

function calculateArchiveInputSize(items) {
  const summary = {
    totalBytes: 0,
    fileCount: 0
  };

  const walk = (itemPath) => {
    if (!fs.existsSync(itemPath)) {
      return;
    }

    const stats = fs.statSync(itemPath);
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(itemPath, { withFileTypes: true })) {
        if (shouldIgnoreArchiveEntry(entry.name)) {
          continue;
        }
        walk(path.join(itemPath, entry.name));
      }
      return;
    }

    if (stats.isFile()) {
      summary.totalBytes += stats.size;
      summary.fileCount += 1;
    }
  };

  for (const item of items) {
    walk(item);
  }

  return summary;
}

function normalizeCompressionLevel(level) {
  const numericLevel = Number(level);
  if (Number.isInteger(numericLevel) && numericLevel >= 0 && numericLevel <= 9) {
    return numericLevel;
  }
  return 5;
}

/**
 * Create a zip file from a list of folders or files
 * 
 * @param {Array<string>} items - Paths to folders or files to include in the zip
 * @param {string} outputPath - Path where to save the zip file
 * @returns {Promise<void>} - Resolves when zip is created
 */
async function createZip(items, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      const inputSummary = options.inputSummary || calculateArchiveInputSize(items);
      const compressionLevel = normalizeCompressionLevel(options.compressionLevel);
      const expectedTotalBytes = Number(inputSummary.totalBytes) || 0;
      const expectedEntriesTotal = Number(inputSummary.fileCount) || items.length;
      let settled = false;
      let lastProgressAt = 0;

      const emitProgress = (payload, { force = false } = {}) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - lastProgressAt < 500) return;
        lastProgressAt = now;
        onProgress(payload);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const output = fs.createWriteStream(outputPath);
      const archive = (/** @type {any} */ (archiver))('zip', {
        zlib: { level: compressionLevel }
      });
      
      output.on('error', (err) => {
        output.end();
        fail(err);
      });

      archive.on('error', (err) => {
        output.end();
        fail(err);
      });
      
      output.on('close', () => {
        if (settled) return;
        settled = true;
        emitProgress({
          phase: 'complete',
          percent: 100,
          processedBytes: expectedTotalBytes || archive.pointer(),
          totalBytes: expectedTotalBytes,
          entriesTotal: expectedEntriesTotal
        }, { force: true });
        resolve();
      });
      archive.on('warning', (err) => {
        if (err.code !== 'ENOENT') {
          fail(err);
        }
      });

      archive.on('progress', (progress) => {
        const processedBytes = progress?.fs?.processedBytes || 0;
        const totalBytes = expectedTotalBytes || progress?.fs?.totalBytes || 0;
        const entriesProcessed = progress?.entries?.processed || 0;
        const entriesTotal = expectedEntriesTotal || progress?.entries?.total || 0;
        const bytePercent = totalBytes > 0 ? (processedBytes / totalBytes) * 100 : null;
        const entryPercent = entriesTotal > 0 ? (entriesProcessed / entriesTotal) * 100 : null;
        const percent = bytePercent ?? entryPercent;

        emitProgress({
          phase: 'zipping',
          percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
          processedBytes,
          totalBytes,
          entriesProcessed,
          entriesTotal
        });
      });

      archive.pipe(output);

      for (const item of items) {
          if (!fs.existsSync(item)) {
            continue;
          }
          
          const itemName = path.basename(item);
          const stats = fs.statSync(item);
          
          if (stats.isDirectory()) {
            archive.glob('**/*', {
              cwd: item,
              ignore: ['**/*~', '**/tmp*', '**/*.lock', '**/*.tmp'],
              dot: true
            }, { prefix: itemName });
          } else {
            fs.accessSync(item, fs.constants.R_OK);
            archive.file(item, { name: itemName });
          }
      }
      
      emitProgress({
        phase: 'queued',
        percent: 0,
        processedBytes: 0,
        totalBytes: expectedTotalBytes,
        entriesTotal: expectedEntriesTotal
      }, { force: true });
      archive.finalize();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Create a backup of the entire server or specific folders
 * 
 * @param {string} serverPath - Path to the server directory
 * @param {Array<string>} [folders] - Optional list of specific folders to backup
 * @returns {Promise<string>} - Path to the created backup file
 */
async function createServerBackup(serverPath, folders = null) {
    const backupDir = path.join(serverPath, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `server-backup-${timestamp}.zip`;
    const backupPath = path.join(backupDir, backupFilename);
    
    let itemsToBackup = [];
    
    if (folders && Array.isArray(folders) && folders.length > 0) {
      itemsToBackup = folders.map(folder => path.join(serverPath, folder))
        .filter(folderPath => fs.existsSync(folderPath));
    } else {
      const defaultFolders = ['world', 'world_nether', 'world_the_end', 'config', 'mods'];
      itemsToBackup = defaultFolders.map(folder => path.join(serverPath, folder))
        .filter(folderPath => fs.existsSync(folderPath));
      
        const serverPropertiesPath = path.join(serverPath, 'server.properties');
      if (fs.existsSync(serverPropertiesPath)) {
        itemsToBackup.push(serverPropertiesPath);
      }
    }
    
    if (itemsToBackup.length === 0) {
      throw new Error('No valid folders or files found to backup');
    }
    
    await createZip(itemsToBackup, backupPath);
    return backupPath;
}

/**
 * List available backups for a server
 * 
 * @param {string} serverPath - Path to the server directory
 * @returns {Promise<Array<Object>>} - List of backup info objects
 */
async function listBackups(serverPath) {
  try {
    const backupDir = path.join(serverPath, 'backups');
    if (!fs.existsSync(backupDir)) {
      return [];
    }
    
    const backupFiles = fs.readdirSync(backupDir)
      .filter(file => file.endsWith('.zip'))
      .map(file => {
        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);
        
        return {
          name: file,
          path: filePath,
          size: stats.size,
          created: stats.mtime
        };
      })
        .sort((a, b) => b.created.getTime() - a.created.getTime());
    
    return backupFiles;
    } catch {
      return [];
    }
  }

module.exports = {
  createZip,
  createServerBackup,
  listBackups,
  calculateArchiveInputSize,
  normalizeCompressionLevel
}; 
