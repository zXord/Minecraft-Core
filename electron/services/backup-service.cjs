const fs = require('fs');
const path = require('path');
const { createZip, listBackups } = require('../utils/backup-util.cjs');
const AdmZip = require('adm-zip').default;
const { sendServerCommand, getServerState } = require('./server-manager.cjs');

// Add a utility to wait for a specified time
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getBackupDir(serverPath) {
  return path.join(serverPath, 'backups');
}

function getWorldDirs(serverPath) {
  return ['world', 'world_nether', 'world_the_end']
    .map(dir => path.join(serverPath, dir))
    .filter(fs.existsSync);
}

function getAllDirs(serverPath) {
  return fs.readdirSync(serverPath)
    .filter(f => f !== 'backups')
    .map(f => path.join(serverPath, f));
}

async function createBackup({ serverPath, type, trigger }) {
  const backupDir = getBackupDir(serverPath);
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
  const name = `backup-${type}-${timestamp}.zip`;
  const zipPath = path.join(backupDir, name);

  let items;
  if (type === 'full') {
    items = getAllDirs(serverPath);
  } else {
    items = getWorldDirs(serverPath);
  }

  await createZip(items, zipPath);
  const stats = fs.statSync(zipPath);
  const metadata = {
    type,
    timestamp: now.toISOString(),
    size: stats.size,
    trigger,
    // Optionally add MC/Fabric version here
  };
  fs.writeFileSync(zipPath.replace('.zip', '.json'), JSON.stringify(metadata, null, 2));
  return { name, size: stats.size, metadata };
}

async function safeCreateBackup({ serverPath, type, trigger }) {
  const backupDir = getBackupDir(serverPath);
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
  const name = `backup-${type}-${timestamp}.zip`;
  const zipPath = path.join(backupDir, name);
  const metaPath = zipPath.replace('.zip', '.json');

  let items;
  if (type === 'full') {
    items = getAllDirs(serverPath);
  } else {
    items = getWorldDirs(serverPath);
  }

  // Check if the server is running
  const serverState = getServerState();
  const isServerRunning = serverState.isRunning;

  // Create metadata first to ensure it's saved even if the zip has issues
  const metadata = {
    type,
    timestamp: now.toISOString(),
    size: 0, // Will be updated after ZIP creation
    trigger,
    automated: trigger === 'auto' || trigger === 'app-launch',
    source: trigger,
  };
  
  // Try to write metadata file first
  try {
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
  } catch (err) {
    console.error('Metadata write failed', err);
  }

  // Verify we have valid directories to backup
  if (items.length === 0) {
    throw new Error('No valid directories found to backup');
  }
  
  // If server is running, use the save-off/save-on protocol
  if (isServerRunning) {
    try {
      // Disable world saving
      sendServerCommand('save-off');
      
      // Flush all pending changes to disk
      sendServerCommand('save-all flush');
      
      // Wait for flush to complete (approximately 2 seconds)
      await sleep(2000);
      
      // Create the backup with retry logic for EBUSY errors
      let attempts = 0;
      const maxAttempts = 5; // Increased from 3 to 5
      let backupError = null;
      
      while (attempts < maxAttempts) {
        try {
          await createZip(items, zipPath);
          backupError = null;
          break; // Success, exit the loop
        } catch (err) {
          backupError = err;
          attempts++;
          
          if ((err.code === 'EBUSY' || err.code === 'DIRECTORYFUNCTIONINVALIDDATA') && attempts < maxAttempts) {
            const waitTime = 2000 * attempts; // Progressively longer wait
            await sleep(waitTime);
            continue;
          }
          // If we've exhausted retries or it's not a retriable error, break the loop
          break;
        }
      }
      
      // Re-enable world saving
      sendServerCommand('save-on');
      
      // If all attempts failed, throw the last error
      if (backupError) {
        throw backupError;
      }
    } catch (err) {
      // Make sure to re-enable saving even if backup fails
      if (isServerRunning) {
        sendServerCommand('save-on');
      }
      
      // Delete the incomplete zip file if it exists
      if (fs.existsSync(zipPath)) {
        fs.rmSync(zipPath, { force: true });
      }
      
      throw err;
    }  } else {
    // Server not running, just create the backup normally
    let attempts = 0;
    const maxAttempts = 3;
    let backupError = null;
    
    while (attempts < maxAttempts) {
      try {
        await createZip(items, zipPath);
        backupError = null;
        break; // Success, exit the loop
      } catch (err) {
        backupError = err;
        attempts++;
        
        if ((err.code === 'EBUSY' || err.code === 'DIRECTORYFUNCTIONINVALIDDATA') && attempts < maxAttempts) {
          const waitTime = 1000 * attempts;
          await sleep(waitTime);
          continue;
        }
        break;
      }
    }
    
    if (backupError) {
      if (fs.existsSync(zipPath)) {
        fs.rmSync(zipPath, { force: true });
      }
      throw backupError;
    }
  }

  // Update metadata with file size
  if (fs.existsSync(zipPath)) {
    const stats = fs.statSync(zipPath);
    metadata.size = stats.size;
      // Verify the zip isn't empty (should be at least a few bytes)
    if (stats.size < 100) {
      throw new Error('Backup file appears to be empty or corrupted');
    }
    
    // Write updated metadata with the correct size
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    
    return { name, size: stats.size, metadata };
  } else {
    throw new Error('Backup file was not created correctly');
  }
}

async function listBackupsWithMetadata(serverPath) {
  const backups = await listBackups(serverPath);
  return backups.map(b => {
    const metaPath = b.path.replace('.zip', '.json');
    let metadata = null;
    if (fs.existsSync(metaPath)) {      try {
        metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      } catch {
        metadata = null;
      }
    }
    return { ...b, metadata };
  });
}

async function deleteBackup({ serverPath, name }) {
  try {
    const backupDir = getBackupDir(serverPath);
    const zipPath = path.join(backupDir, name);
    const metaPath = zipPath.replace('.zip', '.json');
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function renameBackup({ serverPath, oldName, newName }) {
  if (!newName.endsWith('.zip')) throw new Error('Backup name must end with .zip');
  const backupDir = getBackupDir(serverPath);
  const oldZip = path.join(backupDir, oldName);
  const oldMeta = oldZip.replace('.zip', '.json');
  const newZip = path.join(backupDir, newName);
  const newMeta = newZip.replace('.zip', '.json');
  if (fs.existsSync(newZip)) throw new Error('A backup with that name already exists');
  fs.renameSync(oldZip, newZip);
  if (fs.existsSync(oldMeta)) fs.renameSync(oldMeta, newMeta);
}

async function restoreBackup({ serverPath, name, serverStatus }) {
  try {
    if (serverStatus && serverStatus === 'Running') {
      return { success: false, error: 'Cannot restore while server is running. Please stop the server first.' };
    }
    const backupDir = getBackupDir(serverPath);
    const zipPath = path.join(backupDir, name);
    const metaPath = zipPath.replace('.zip', '.json');
    if (!fs.existsSync(zipPath)) {
      return { success: false, error: 'Backup file not found.' };
    }
    let type = 'full';
    if (fs.existsSync(metaPath)) {      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.type) type = meta.type;
      } catch {
        type = 'full';
      }
    }
    // Determine if this is a world-type restore (including world-delete backups)
    const isWorldType = (type === 'world' || type === 'world-delete');
    // Before restoring, backup the current world (or everything for full)
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    let preRestoreBackupName = `pre-restore-${type}-${timestamp}.zip`;
    let preRestoreBackupPath = path.join(backupDir, preRestoreBackupName);
    // Choose folders to backup before restore
    const itemsToBackup = isWorldType
      ? getWorldDirs(serverPath)
      : getAllDirs(serverPath);
    if (itemsToBackup.length > 0) {
      try {
        await createZip(itemsToBackup, preRestoreBackupPath);
        // Write metadata for pre-restore backup
        const stats = fs.statSync(preRestoreBackupPath);
        const preMeta = {
          type,
          timestamp: now.toISOString(),
          size: stats.size,
          trigger: 'pre-restore'
        };
        fs.writeFileSync(preRestoreBackupPath.replace('.zip', '.json'), JSON.stringify(preMeta, null, 2));
      } catch (err) {
        return { success: false, error: 'Failed to create pre-restore backup: ' + err.message };
      }
    }
    // For world-type backups, delete only world folders first
    if (isWorldType) {
      for (const folder of ['world', 'world_nether', 'world_the_end']) {
        const folderPath = path.join(serverPath, folder);
        if (fs.existsSync(folderPath)) {
          fs.rmSync(folderPath, { recursive: true, force: true });
        }
      }
    }
    // For full backups, just extract and overwrite everything
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(serverPath, true);
    return { success: true, message: 'Backup restored successfully.', preRestoreBackup: preRestoreBackupName };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Function to clean up old automatic backups based on retention policy
async function cleanupAutomaticBackups(serverPath, maxCount) {
  try {
    if (!maxCount || maxCount <= 0) return { success: true, message: 'No cleanup needed' };
    
    const backups = await listBackupsWithMetadata(serverPath);
    
    // Filter to only get automated backups
    const autoBackups = backups.filter(b => 
      b.metadata && b.metadata.automated === true
    );
    
    // Sort by timestamp (newest first)
    autoBackups.sort((a, b) => {
      const timeA = a.metadata?.timestamp ? new Date(a.metadata.timestamp) : new Date(a.created);
      const timeB = b.metadata?.timestamp ? new Date(b.metadata.timestamp) : new Date(b.created);
      return timeB.getTime() - timeA.getTime();
    });
    
    // If we have more than the max, delete the oldest ones
    if (autoBackups.length > maxCount) {
      const backupsToDelete = autoBackups.slice(maxCount);
      
      for (const backup of backupsToDelete) {
        await deleteBackup({ serverPath, name: backup.name });
      }
      
      return { 
        success: true, 
        deleted: backupsToDelete.length,
        message: `Deleted ${backupsToDelete.length} old automated backups`
      };
    }
    
    return { success: true, deleted: 0 };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  createBackup,
  safeCreateBackup,
  listBackupsWithMetadata,
  deleteBackup,
  renameBackup,
  restoreBackup,
  cleanupAutomaticBackups,
  getWorldDirs,
  getBackupDir
}; 
