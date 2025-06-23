const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

/**
 * Create a zip file from a list of folders or files
 * 
 * @param {Array<string>} items - Paths to folders or files to include in the zip
 * @param {string} outputPath - Path where to save the zip file
 * @returns {Promise<void>} - Resolves when zip is created
 */
async function createZip(items, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const output = fs.createWriteStream(outputPath);
      const archive = (/** @type {any} */ (archiver))('zip', {
        zlib: { level: 5 }
      });
      
      output.on('error', (err) => {
        output.end();
        reject(err);
      });

      archive.on('error', (err) => {
        output.end();
        reject(err);
      });
      
      output.on('close', () => {
        resolve();
      });
      archive.on('warning', (err) => {
        if (err.code !== 'ENOENT') {
          reject(err);
        }
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
  listBackups
}; 
