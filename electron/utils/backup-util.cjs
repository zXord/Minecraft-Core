// Backup utility functions
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
      // Create a file to stream archive data to
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', {
        zlib: { level: 5 } // Compression level (1-9)
      });
      
      // Listen for all errors
      output.on('error', (err) => {
        console.error('Output stream error:', err);
        // Try to close things properly
        try {
          output.end();
        } catch (e) { /* ignore */ }
        reject(err);
      });
      
      archive.on('error', (err) => {
        console.error('Archive error:', err);
        // Try to close things properly
        try {
          output.end();
        } catch (e) { /* ignore */ }
        reject(err);
      });
      
      // Wait for close event to resolve the promise
      output.on('close', () => {
        console.log(`Backup created: ${outputPath} (${archive.pointer()} bytes)`);
        resolve();
      });
      
      // Handle warning events
      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
          // Log warning but continue
          console.warn('Archive warning (missing file):', err.path || err.message);
        } else {
          console.error('Archive warning:', err);
          reject(err);
        }
      });
      
      // Pipe archive data to the file
      archive.pipe(output);
      
      // Add folders and files to the archive with better error handling
      for (const item of items) {
        try {
          if (!fs.existsSync(item)) {
            console.warn(`Skipping non-existent item: ${item}`);
            continue;
          }
          
          const itemName = path.basename(item);
          const stats = fs.statSync(item);
          
          if (stats.isDirectory()) {
            // FIX: Instead of using a filter function that returns false (which causes DIRECTORYFUNCTIONINVALIDDATA),
            // use the glob pattern exclusion feature of archiver
            archive.glob('**/*', {
              cwd: item,
              ignore: ['**/*~', '**/tmp*', '**/*.lock', '**/*.tmp'],
              dot: true
            }, { prefix: itemName });
          } else {
            // Try to open the file first to see if it's accessible
            try {
              // Try a quick read test
              fs.accessSync(item, fs.constants.R_OK);
              archive.file(item, { name: itemName });
            } catch (fileErr) {
              console.warn(`Skipping potentially locked file: ${item}`, fileErr);
            }
          }
        } catch (itemErr) {
          console.warn(`Error processing item ${item}:`, itemErr);
          // Continue with other items
        }
      }
      
      // Finalize the archive
      archive.finalize();
    } catch (err) {
      console.error('Error creating backup:', err);
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
  try {
    // Create backups directory if it doesn't exist
    const backupDir = path.join(serverPath, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    // Generate backup filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `server-backup-${timestamp}.zip`;
    const backupPath = path.join(backupDir, backupFilename);
    
    // Determine what to include in the backup
    let itemsToBackup = [];
    
    if (folders && Array.isArray(folders) && folders.length > 0) {
      // Backup specific folders
      itemsToBackup = folders.map(folder => path.join(serverPath, folder))
        .filter(folderPath => fs.existsSync(folderPath));
    } else {
      // Backup important server folders
      const defaultFolders = ['world', 'world_nether', 'world_the_end', 'config', 'mods'];
      itemsToBackup = defaultFolders.map(folder => path.join(serverPath, folder))
        .filter(folderPath => fs.existsSync(folderPath));
      
      // Add server.properties if it exists
      const serverPropertiesPath = path.join(serverPath, 'server.properties');
      if (fs.existsSync(serverPropertiesPath)) {
        itemsToBackup.push(serverPropertiesPath);
      }
    }
    
    if (itemsToBackup.length === 0) {
      throw new Error('No valid folders or files found to backup');
    }
    
    // Create the backup zip
    await createZip(itemsToBackup, backupPath);
    
    return backupPath;
  } catch (err) {
    console.error('Error creating server backup:', err);
    throw err;
  }
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
      .sort((a, b) => b.created.getTime() - a.created.getTime()); // Sort newest first
    
    return backupFiles;
  } catch (err) {
    console.error('Error listing backups:', err);
    return [];
  }
}

module.exports = {
  createZip,
  createServerBackup,
  listBackups
}; 