const fs = require('fs');
const path = require('path');
const { createZip, listBackups } = require('../utils/backup-util.cjs');
const AdmZip = require('adm-zip');
const { sendServerCommand, getServerState } = require('./server-manager.cjs');
const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');
// Lazy-load retention policy when needed
let RetentionPolicy = null;

// Initialize logger
const logger = getLoggerHandlers();

// Enhanced performance tracking
let performanceMetrics = {
  backupsCreated: 0,
  backupsRestored: 0,
  backupsDeleted: 0,
  totalBackupSize: 0,
  averageBackupTime: 0,
  cleanupOperations: 0,
  sizeCalculations: 0,
  cacheHits: 0,
  cacheMisses: 0,
  lastBackupSize: 0,
  largestBackupSize: 0,
  smallestBackupSize: Number.MAX_SAFE_INTEGER
};

// Function to get enhanced performance metrics
function getPerformanceMetrics() {
  return {
    ...performanceMetrics,
    averageBackupSizeMB: performanceMetrics.backupsCreated > 0 
      ? Math.round((performanceMetrics.totalBackupSize / performanceMetrics.backupsCreated) / (1024 * 1024) * 100) / 100
      : 0,
    totalBackupSizeGB: Math.round((performanceMetrics.totalBackupSize / (1024 * 1024 * 1024)) * 100) / 100,
    cacheEfficiency: performanceMetrics.sizeCalculations > 0 
      ? Math.round((performanceMetrics.cacheHits / performanceMetrics.sizeCalculations) * 100)
      : 0
  };
}

// Log service initialization
logger.info('Backup service initialized', {
  category: 'storage',
  data: {
    service: 'BackupService',
    admZipAvailable: !!AdmZip
  }
});

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
  // Use local time for filename to match UI display
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hour = now.getHours().toString().padStart(2, '0');
  const minute = now.getMinutes().toString().padStart(2, '0');
  const second = now.getSeconds().toString().padStart(2, '0');
  const timestamp = `${year}-${month}-${day}_${hour}-${minute}-${second}`;
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
    timestamp: now.toISOString(), // Keep ISO format for internal use but filename uses local time
    size: stats.size,
    trigger,
    // Optionally add MC/Fabric version here
  };
  fs.writeFileSync(zipPath.replace('.zip', '.json'), JSON.stringify(metadata, null, 2));
  return { name, size: stats.size, metadata };
}

async function safeCreateBackup({ serverPath, type, trigger }) {
  const backupStartTime = Date.now();
  performanceMetrics.backupsCreated++;
  
  logger.info('Starting backup creation', {
    category: 'storage',
    data: {
      service: 'BackupService',
      operation: 'safeCreateBackup',
      serverPath,
      type,
      trigger,
      totalBackupsCreated: performanceMetrics.backupsCreated
    }
  });
  // Removed noisy console START log
  
  try {
    const backupDir = getBackupDir(serverPath);
    if (!fs.existsSync(backupDir)) {
      logger.debug('Creating backup directory', {
        category: 'storage',
        data: {
          service: 'BackupService',
          operation: 'safeCreateBackup',
          backupDir
        }
      });
      fs.mkdirSync(backupDir, { recursive: true });
    }

  const now = new Date();
  // Use local time for filename to match UI display
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hour = now.getHours().toString().padStart(2, '0');
  const minute = now.getMinutes().toString().padStart(2, '0');
  const second = now.getSeconds().toString().padStart(2, '0');
  const timestamp = `${year}-${month}-${day}_${hour}-${minute}-${second}`;
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
    timestamp: now.toISOString(), // Keep ISO format for internal use
    size: 0, // Will be updated after ZIP creation
    trigger,
    automated: trigger === 'auto' || trigger === 'app-launch',
    source: trigger,
  };
  
  // Try to write metadata file first
  try {
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
  } catch (error) {
    logger.error('Failed to write backup metadata file', {
      category: 'storage',
      data: {
        service: 'BackupService',
        operation: 'safeCreateBackup',
        metaPath,
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    });
  }

  // Verify we have valid directories to backup
  if (items.length === 0) {
    const backupDuration = Date.now() - backupStartTime;
    logger.error('No valid directories found to backup', {
      category: 'storage',
      data: {
        service: 'BackupService',
        operation: 'safeCreateBackup',
        duration: backupDuration,
        serverPath,
        type,
        trigger,
        itemsFound: items.length
      }
    });
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

  // Update metadata with file size and integrate with enhanced size tracking
  if (fs.existsSync(zipPath)) {
    const stats = fs.statSync(zipPath);
    metadata.size = stats.size;
    performanceMetrics.totalBackupSize += stats.size;
    performanceMetrics.lastBackupSize = stats.size;
    
    // Track largest and smallest backup sizes
    if (stats.size > performanceMetrics.largestBackupSize) {
      performanceMetrics.largestBackupSize = stats.size;
    }
    if (stats.size < performanceMetrics.smallestBackupSize) {
      performanceMetrics.smallestBackupSize = stats.size;
    }
    
    // Calculate backup duration and update average
    const backupDuration = Date.now() - backupStartTime;
    performanceMetrics.averageBackupTime = 
      (performanceMetrics.averageBackupTime + backupDuration) / 2;
    
    // Verify the zip isn't empty (should be at least a few bytes)
    if (stats.size < 100) {
      logger.error('Backup file appears to be empty or corrupted', {
        category: 'storage',
        data: {
          service: 'BackupService',
          operation: 'safeCreateBackup',
          duration: backupDuration,
          zipPath,
          fileSize: stats.size,
          type,
          trigger
        }
      });
      throw new Error('Backup file appears to be empty or corrupted');
    }
    
    // Write updated metadata with the correct size
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    
  logger.info('Backup created successfully', {
      category: 'storage',
      data: {
        service: 'BackupService',
        operation: 'safeCreateBackup',
        duration: backupDuration,
        name,
        size: stats.size,
        type,
        trigger,
        isServerRunning,
        itemsBackedUp: items.length,
        totalBackupsCreated: performanceMetrics.backupsCreated,
        totalBackupSize: performanceMetrics.totalBackupSize,
        averageBackupTime: Math.round(performanceMetrics.averageBackupTime)
      }
    });
  // Removed noisy console SUCCESS log
    
  // Fire-and-forget advanced retention after successful creation
  try { applyAdvancedRetention({ serverPath, trigger }); } catch { /* ignore */ }
  return { name, size: stats.size, metadata };
  } else {
    const backupDuration = Date.now() - backupStartTime;
    logger.error('Backup file was not created correctly', {
      category: 'storage',
      data: {
        service: 'BackupService',
        operation: 'safeCreateBackup',
        duration: backupDuration,
        zipPath,
        type,
        trigger,
        isServerRunning
      }
    });
    throw new Error('Backup file was not created correctly');
  }
  } catch (error) {
    const backupDuration = Date.now() - backupStartTime;
  logger.error(`Backup creation failed: ${error.message}`, {
      category: 'storage',
      data: {
        service: 'BackupService',
        operation: 'safeCreateBackup',
        duration: backupDuration,
        serverPath,
        type,
        trigger,
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    });
  try { console.error('[BackupService] ERROR', { message: error.message, type, trigger, duration: backupDuration }); } catch { /* console logging failed */ }
    throw error;
  }
}

// Internal helper to apply advanced retention rules (size/age/count) centrally after automated backups
async function applyAdvancedRetention({ serverPath, trigger }) {
  try {
    // Only for automated triggers
    if (!(trigger === 'auto' || trigger === 'app-launch' || trigger === 'manual-auto')) return;

    const appStore = require('../utils/app-store.cjs');
    const retentionKey = `retentionSettings_${Buffer.from(serverPath).toString('base64')}`;
    const adv = appStore.get(retentionKey);
  logger.debug('Advanced retention loaded', { category: 'backup', data: { serverPath, hasSettings: !!adv } });
    if (!adv || !(adv.sizeRetentionEnabled || adv.ageRetentionEnabled || adv.countRetentionEnabled)) {
  logger.debug('Advanced retention skipped (no enabled rules)', { category: 'backup', data: { serverPath } });
      return;
    }
    // Load engine
    try { ({ RetentionPolicy } = require('../utils/retention-policy.cjs')); } catch (e) {
  logger.warn('Advanced retention engine load failed', { category: 'backup', data: { serverPath, error: e.message } }); return; }

    const toBytes = (value, unit) => {
      const n = Number(value) || 0; const u = (unit||'').toLowerCase();
      if (u === 'kb') return n*1024; if (u === 'mb') return n*1024*1024; if (u === 'gb') return n*1024*1024*1024; if (u === 'tb') return n*1024*1024*1024*1024; return n; };
    const toMs = (value, unit) => {
      const n = Number(value) || 0; const u = (unit||'').toLowerCase();
      switch(u){ case 'minutes': return n*60*1000; case 'hours': return n*60*60*1000; case 'days': return n*24*60*60*1000; case 'weeks': return n*7*24*60*60*1000; case 'months': return n*30*24*60*60*1000; default: return n; }
    };
    const policy = {
      maxSize: adv.sizeRetentionEnabled ? toBytes(adv.maxSizeValue, adv.maxSizeUnit) : null,
      maxAge: adv.ageRetentionEnabled ? toMs(adv.maxAgeValue, adv.maxAgeUnit) : null,
      maxCount: adv.countRetentionEnabled ? adv.maxCountValue : null,
      preserveRecent: 1
    };
  logger.debug('Advanced retention policy constructed', { category: 'backup', data: { serverPath, policy } });
    let engine;
  try { engine = new RetentionPolicy(policy); } catch (e) { logger.warn('Advanced retention invalid policy', { category: 'backup', data: { serverPath, error: e.message } }); return; }
  if (!engine.hasActiveRules()) { logger.debug('Advanced retention no active rules after validation', { category: 'backup', data: { serverPath } }); return; }
    const backups = await listBackupsWithMetadata(serverPath);
  logger.debug('Advanced retention evaluating backups', { category: 'backup', data: { serverPath, count: backups.length } });
    const toDelete = await engine.evaluateBackups(backups);
  logger.info('Advanced retention evaluation result', { category: 'backup', data: { serverPath, deleteCount: toDelete.length } });
    for (const b of toDelete) {
      try {
        await deleteBackup({ serverPath, name: b.name });
  logger.debug('Advanced retention deleted backup', { category: 'backup', data: { serverPath, name: b.name } });
      } catch (e) {
  logger.warn('Advanced retention delete failed', { category: 'backup', data: { serverPath, name: b.name, error: e.message } });
      }
    }
  } catch (err) {
  logger.error('Advanced retention error', { category: 'backup', data: { serverPath, error: err.message } });
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
    // Use local time for filename consistency
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hour = now.getHours().toString().padStart(2, '0');
    const minute = now.getMinutes().toString().padStart(2, '0');
    const second = now.getSeconds().toString().padStart(2, '0');
    const timestamp = `${year}-${month}-${day}_${hour}-${minute}-${second}`;
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
    const zip = new (/** @type {any} */ (AdmZip))(zipPath);
    zip.extractAllTo(serverPath, true);
    return { success: true, message: 'Backup restored successfully.', preRestoreBackup: preRestoreBackupName };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Function to clean up old automatic backups based on retention policy
async function cleanupAutomaticBackups(serverPath, maxCount) {
  try {
    if (!maxCount || maxCount <= 0) {
      return { success: true, message: 'No cleanup needed' };
    }
    
  const backups = await listBackupsWithMetadata(serverPath);
  // (diagnostic log removed)
    
    // Filter to only get automated backups (including app-launch)
    const autoBackups = backups.filter(b => 
      b.metadata && 
      (b.metadata.automated === true || 
       b.metadata.trigger === 'auto' || 
       b.metadata.trigger === 'app-launch' ||
       b.metadata.trigger === 'manual-auto')
    );
    
  if (autoBackups.length === 0) {
      return { success: true, deleted: 0, message: 'No automated backups to clean up' };
    }
    
    // Sort by timestamp (newest first) - use both metadata timestamp and file created time as fallback
    autoBackups.sort((a, b) => {
      const timeA = a.metadata?.timestamp ? new Date(a.metadata.timestamp).getTime() : new Date(a.created).getTime();
      const timeB = b.metadata?.timestamp ? new Date(b.metadata.timestamp).getTime() : new Date(b.created).getTime();
      return timeB - timeA;
    });
    
    // If we have more than the max, delete the oldest ones
  if (autoBackups.length > maxCount) {
      const backupsToDelete = autoBackups.slice(maxCount);
      
      let deletedCount = 0;
      for (const backup of backupsToDelete) {
        try {
          const result = await deleteBackup({ serverPath, name: backup.name });
          if (result.success) {
            deletedCount++;
          }
        } catch {
          // TODO: Add proper logging - Error deleting backup during cleanup
        }
      }
      
      return { 
        success: true, 
        deleted: deletedCount,
        message: `Deleted ${deletedCount} old automated backups`
      };
    }
    
  // (diagnostic log removed)
  return { success: true, deleted: 0, message: 'No cleanup needed' };
  } catch (err) {
    // TODO: Add proper logging - Error during backup cleanup
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
  getBackupDir,
  getPerformanceMetrics
}; 
