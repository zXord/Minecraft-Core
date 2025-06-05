// File and folder IPC handlers
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { dialog, shell } = require('electron');
const rimraf = require('rimraf');
const appStore = require('../utils/app-store.cjs');
const { ensureConfigFile } = require('../utils/config-manager.cjs');
const { createZip } = require('../utils/backup-util.cjs');

/**
 * Create file and folder management IPC handlers
 * 
 * @param {BrowserWindow} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createFileHandlers(win) {  return {
    'get-last-server-path': () => {
      // Return both the path and server settings
      return {
        path: appStore.get('lastServerPath') || null,
        serverSettings: appStore.get('serverSettings') || { port: 25565, maxRam: 4 }
      };
    },
    
    'set-server-path': (_e, path) => {
      if (!path) return { success: false, error: 'Invalid path' };
      
      try {
        // Verify path exists
        if (!fs.existsSync(path)) {
          return { success: false, error: 'Path does not exist' };
        }
        
        // Save to persistent store
        appStore.set('lastServerPath', path);
        
        // Notify the renderer
        if (win && win.webContents) {
          win.webContents.send('update-server-path', path);
        }
        
        return { success: true, path };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    'update-server-path': (_e, path) => {
      if (!path) return { success: false, error: 'Invalid path' };
      
      try {
        // Verify path exists
        if (!fs.existsSync(path)) {
          return { success: false, error: 'Path does not exist' };
        }
        
        // Save to persistent store
        appStore.set('lastServerPath', path);
        
        // Notify the renderer
        if (win && win.webContents) {
          win.webContents.send('update-server-path', path);
        }
        
        return { success: true, path };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    'select-folder': async () => {
      try {
        const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (canceled) return null;
        const folder = filePaths[0];
        
        // Create needed directories
        try {
          ['mods', 'logs', 'config'].forEach(dir => {
            fs.mkdirSync(path.join(folder, dir), { recursive: true });
          });
        } catch (err) {
          console.error('[IPC:Files] Failed to create directories:', err);
          throw new Error(`Failed to create directories: ${err.message}`);
        }
        
        // Ensure config file exists with defaults
        const serverSettings = appStore.get('serverSettings') || { port: 25565, maxRam: 4 };
        const autoRestart = appStore.get('autoRestart') || { enabled: false, delay: 10, maxCrashes: 3 };
        
        ensureConfigFile(folder, {
          version: null,
          fabric: null,
          port: serverSettings.port,
          maxRam: serverSettings.maxRam,
          autoRestart: {
            enabled: autoRestart.enabled,
            delay: autoRestart.delay, 
            maxCrashes: autoRestart.maxCrashes
          }
        });
        
        // Save path to persistent store
        appStore.set('lastServerPath', folder);
        
        // Share selected path with renderer through preload script
        if (win && win.webContents) {
          win.webContents.send('update-server-path', folder);
        }
  
        return folder;
      } catch (err) {
        console.error('[IPC:Files] Failed to select folder:', err);
        throw err;
      }
    },
    
    'open-folder': async (_e, folderPath) => {
      try {
        if (!folderPath || !fs.existsSync(folderPath)) {
          throw new Error('Invalid or non-existent folder path');
        }
        console.log('[IPC:Files] Opening folder in explorer:', folderPath);
        await shell.openPath(folderPath);
        return { success: true };
      } catch (err) {
        console.error('[IPC:Files] Failed to open folder:', err);
        throw new Error(`Failed to open folder: ${err.message}`);
      }
    },
    
    'read-config': (_e, targetPath) => {
      try {
        if (!targetPath) {
          return null;
        }
        const configPath = path.join(targetPath, '.minecraft-core.json');
        if (!fs.existsSync(configPath)) {
          return null;
        }
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (err) {
        console.error('[IPC:Files] Failed to read config:', err);
        return null;
      }
    },
    
    'save-version-selection': (_e, { path: targetPath, mcVersion, fabricVersion }) => {
      try {
        if (!targetPath) {
          throw new Error('Target path is required');
        }
        
        const configFile = path.join(targetPath, '.minecraft-core.json');
        let config = {};
        
        if (fs.existsSync(configFile)) {
          try {
            config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
          } catch (parseErr) {
            console.error('[IPC:Files] Error parsing config, creating new one:', parseErr);
            // Continue with empty config
          }
        }
        
        // Preserve any existing settings and update version info
        config.version = mcVersion;
        config.fabric = fabricVersion;
        
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        return true;
      } catch (err) {
        console.error('[IPC:Files] Failed to save version selection:', err);
        throw err;
      }
    },
    
    'write-eula': (_e, { path: targetPath, content }) => {
      try {
        if (!targetPath || typeof content !== 'string') {
          throw new Error('Invalid parameters for writing EULA');
        }
        fs.writeFileSync(path.join(targetPath, 'eula.txt'), content);
        return true;
      } catch (err) {
        console.error('[IPC:Files] Failed to write EULA:', err);
        throw err;
      }
    },
    
    'delete-world': async (_event, serverPath) => {
      try {
        if (!serverPath) {
          throw new Error('Server path is required');
        }
        console.log('[IPC:Files] Deleting world folders for server:', serverPath);
        return await deleteWorld(serverPath);
      } catch (err) {
        console.error('[IPC:Files] Failed to delete world:', err);
        throw new Error(`Failed to delete world: ${err.message}`);
      }
    },
    
    'show-confirmation-dialog': async (_event, options) => {
      try {
        if (!options || !win) {
          throw new Error('Invalid parameters or window not available');
        }
        console.log('[IPC:Files] Showing confirmation dialog');
        return await dialog.showMessageBox(win, options);
      } catch (err) {
        console.error('[IPC:Files] Failed to show dialog:', err);
        throw new Error(`Failed to show dialog: ${err.message}`);
      }
    }
  };
}

/**
 * Delete world folder
 * 
 * @param {string} serverPath - Path to the server directory 
 * @returns {Promise<Object>} - Result with success status
 */
async function deleteWorld(serverPath) {
  try {
    if (!serverPath) {
      throw new Error('Server path is not provided');
    }
    
    // Verify server path exists
    if (!fs.existsSync(serverPath)) {
      throw new Error('Server path does not exist');
    }
    
    const worldPath = path.join(serverPath, 'world');
    const worldNetherPath = path.join(serverPath, 'world_nether');
    const worldEndPath = path.join(serverPath, 'world_the_end');
    
    // Check if any of the world folders exist
    const worldExists = await fsPromises.access(worldPath).then(() => true).catch(() => false);
    const worldNetherExists = await fsPromises.access(worldNetherPath).then(() => true).catch(() => false);
    const worldEndExists = await fsPromises.access(worldEndPath).then(() => true).catch(() => false);
    
    if (!worldExists && !worldNetherExists && !worldEndExists) {
      console.log('[IPC:Files] No world folders found to delete, skipping deletion');
      return { success: false, error: 'World folders not found' };
    }
    
    // Create a backup before deletion
    console.log('[IPC:Files] Creating backup before world deletion');
    const backupPath = path.join(serverPath, 'backups');
    await fsPromises.mkdir(backupPath, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `world-backup-${timestamp}.zip`;
    const backupFilePath = path.join(backupPath, backupFilename);
    
    const foldersToBackup = [
      worldExists ? worldPath : null,
      worldNetherExists ? worldNetherPath : null,
      worldEndExists ? worldEndPath : null
    ].filter(Boolean);
    
    let backupCreated = false;
    if (foldersToBackup.length > 0) {
      try {
        await createZip(foldersToBackup, backupFilePath);
        // Check if the backup is a zip file and not a folder
        const stat = fs.existsSync(backupFilePath) ? fs.statSync(backupFilePath) : null;
        const isZip = stat && stat.isFile() && backupFilePath.endsWith('.zip');
        const backupDirContents = fs.readdirSync(backupPath);
        console.log('[IPC:Files] Backups dir contents after backup:', backupDirContents);
        if (!isZip) {
          console.error('[IPC:Files] Backup is not a zip file:', backupFilePath, stat);
          return { success: false, error: 'Backup was not created as a zip file. World was NOT deleted.' };
        }
        // Write metadata for backup
        const stats = fs.statSync(backupFilePath);
        const metadata = {
          type: 'world-delete',
          timestamp: new Date().toISOString(),
          size: stats.size,
          trigger: 'delete-world'
        };
        fs.writeFileSync(backupFilePath.replace('.zip', '.json'), JSON.stringify(metadata, null, 2));
        console.log('[IPC:Files] World backup created:', backupFilePath);
        backupCreated = true;
      } catch (err) {
        console.error('[IPC:Files] Failed to create backup:', err);
        return { success: false, error: 'Failed to create world backup zip. World was NOT deleted.' };
      }
    }
    if (!backupCreated) {
      return { success: false, error: 'Failed to create world backup zip. World was NOT deleted.' };
    }
    
    // Delete world folders using fsPromises.rm
    const deletePromises = [];
    if (worldExists) {
      deletePromises.push(fsPromises.rm(worldPath, { recursive: true, force: true }));
    }
    if (worldNetherExists) {
      deletePromises.push(fsPromises.rm(worldNetherPath, { recursive: true, force: true }));
    }
    if (worldEndExists) {
      deletePromises.push(fsPromises.rm(worldEndPath, { recursive: true, force: true }));
    }
    await Promise.all(deletePromises);
    console.log('[IPC:Files] World folders deleted successfully');
    
    return { 
      success: true, 
      backup: backupCreated ? backupFilePath : null 
    };
  } catch (err) {
    console.error('[IPC:Files] Failed to delete world:', err);
    return { success: false, error: err.message };
  }
}

module.exports = { createFileHandlers };
