const backupService = require('../services/backup-service.cjs');
const appStore = require('../utils/app-store.cjs');
const { safeSend } = require('../utils/safe-send.cjs');
const path = require('path');

// Interval ID for automated backup scheduler
let autoBackupIntervalId = null;

// Helper to format error messages in a user-friendly way
function formatErrorMessage(err) {
  const message = err.message || String(err);
  
  // Handle specific known errors
  if (message.includes('DIRECTORYFUNCTIONINVALIDDATA')) {
    return 'Failed to process some files. Try again or check if files are locked by another process.';
  } else if (message.includes('EBUSY')) {
    return 'Some files are in use by another process. Try again later or stop the server first.';
  } else if (message.includes('ENOENT')) {
    return 'Files or directories not found. The world may have been deleted or moved.';
  } else if (message.includes('No valid directories found')) {
    return 'No valid world directories found to backup. Check if your server path is correct.';
  }
  
  // Return the original message for unrecognized errors
  return message;
}

function createBackupHandlers() {
  return {
    'backups:create': async (_e, { serverPath, type, trigger }) => {
      try {
        return await backupService.createBackup({ serverPath, type, trigger });
      } catch (err) {
        return { error: formatErrorMessage(err) };
      }
    },
    'backups:list': async (_e, { serverPath }) => {
      try {
        return await backupService.listBackupsWithMetadata(serverPath);
      } catch (err) {
        return { error: formatErrorMessage(err) };
      }
    },
    'backups:delete': async (_e, { serverPath, name }) => {
      return backupService.deleteBackup({ serverPath, name });
    },
    'backups:rename': async (_e, { serverPath, oldName, newName }) => {
      return backupService.renameBackup({ serverPath, oldName, newName });
    },
    'backups:restore': async (_e, { serverPath, name, serverStatus }) => {
      return backupService.restoreBackup({ serverPath, name, serverStatus });
    },
    // New handlers for automated backups
    'backups:safe-create': async (_e, { serverPath, type, trigger }) => {
      try {
        // Validate the server path to check if it exists and has valid world directories
        if (!path.isAbsolute(serverPath)) {
          throw new Error('Server path must be absolute');
        }
        
        const result = await backupService.safeCreateBackup({ serverPath, type, trigger });
        
        // Verify backup was created successfully
        if (!result || !result.name || result.size === 0) {
          throw new Error('Backup file was created but appears to be empty');
        }
        
        // Show a success notification with type info
        safeSend('backup-notification', {
          success: true,
          message: `✅ ${type === 'full' ? 'Full' : 'World-only'} ${trigger} backup created at ${new Date().toLocaleTimeString()}`
        });
        
        // Apply retention policy if it's an automated backup
        if (trigger === 'auto' || trigger === 'app-launch') {
          const backupSettings = appStore.get('backupSettings') || {};
          if (backupSettings.retentionCount) {
            await backupService.cleanupAutomaticBackups(serverPath, backupSettings.retentionCount);
          }
        }
        
        return result;
      } catch (err) {
        
        // Show an error notification with user-friendly message
        safeSend('backup-notification', {
          success: false,
          message: `⚠️ Failed to create ${type === 'full' ? 'full' : 'world-only'} ${trigger} backup: ${formatErrorMessage(err)}`
        });
        
        return { error: formatErrorMessage(err) };
      }
    },
    'backups:configure-automation': (_e, { enabled, frequency, type, retentionCount, runOnLaunch, serverPath, hour, minute, day }) => {
      try {
        // Stop existing scheduler if running
        if (autoBackupIntervalId) {
          clearInterval(autoBackupIntervalId);
          autoBackupIntervalId = null;
        }
        
        // Get previous settings to check if this is a new activation vs just settings update
        const previousSettings = appStore.get('backupSettings') || {};
        // const isNewActivation = !previousSettings.enabled && enabled;
        
        // Save the settings
        const backupSettings = {
          enabled,
          frequency,
          type,
          retentionCount,
          runOnLaunch,
          hour: hour || 3,
          minute: minute || 0,
          day: day !== undefined ? day : 0, // Default to Sunday (0)
          lastRun: previousSettings.lastRun || new Date().toISOString()
        };
        appStore.set('backupSettings', backupSettings);
        
        // If enabled, start the new scheduler
        if (enabled && frequency && serverPath) {
          startAutomatedBackups(backupSettings, serverPath);
        }
        
        return { success: true };
      } catch (err) {
        return { success: false, error: formatErrorMessage(err) };
      }
    },
    'backups:get-automation-settings': () => {
      try {
        const settings = appStore.get('backupSettings') || {
          enabled: false,
          frequency: 86400000, // 24 hours in milliseconds (default)
          type: 'world',       // default to world-only backups
          retentionCount: 7,   // keep last 7 automated backups
          runOnLaunch: false,  // don't run on app launch by default
          hour: 3,             // default to 3 AM
          minute: 0,           // default to 00 minutes
          day: 0,              // default to Sunday
          lastRun: null        // never run yet
        };
        return { success: true, settings };
      } catch (err) {
        return { success: false, error: formatErrorMessage(err) };
      }
    },
    'backups:run-immediate-auto': async (_e, { serverPath, type }) => {
      try {
        const settings = appStore.get('backupSettings') || {};
        const backupType = type || settings.type || 'world';
        const result = await backupService.safeCreateBackup({
          serverPath,
          type: backupType,
          trigger: 'manual-auto'  // Mark as manually triggered auto backup
        });
        
        // Update last run time
        settings.lastRun = new Date().toISOString();
        appStore.set('backupSettings', settings);
        
        // Apply retention policy
        if (settings.retentionCount) {
          await backupService.cleanupAutomaticBackups(serverPath, settings.retentionCount);
        }
        
        // Send notification
        safeSend('backup-notification', {
          success: true,
          message: `✅ Manual ${backupType === 'full' ? 'Full' : 'World-only'} auto-backup created at ${new Date().toLocaleTimeString()}`
        });
        
        return result;
      } catch (err) {
        safeSend('backup-notification', {
          success: false,
          message: `⚠️ Failed to create manual auto-backup: ${formatErrorMessage(err)}`
        });
        return { error: formatErrorMessage(err) };
      }
    }
  };
}

function startAutomatedBackups(settings, serverPath) {
  if (!settings.enabled || !settings.frequency) {
    return;
  }

  // Convert frequency to milliseconds if it's a string option
  let intervalMs = settings.frequency;

  // Set up the interval for regular backups
  if (autoBackupIntervalId) {
    clearInterval(autoBackupIntervalId);
  }

  autoBackupIntervalId = setInterval(async () => {
    try {
      // Check if it's been at least frequency ms since last backup
      const lastRun = settings.lastRun ? new Date(settings.lastRun) : null;
      const now = new Date();

      // For daily and weekly backups, check the time of day too
      if (settings.frequency >= 86400000) { // Daily or weekly
        const hour = settings.hour !== undefined ? settings.hour : 3; // Default to 3 AM
        const minute = settings.minute !== undefined ? settings.minute : 0; // Default to 00 minutes
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        const isRightTime = (currentHour === hour && currentMinute >= minute) || (currentHour > hour);
        // For weekly backups, also check the day of week
        if (settings.frequency >= 604800000) { // Weekly
          const dayOfWeek = settings.day !== undefined ? settings.day : 0; // Default to Sunday (0)
          const currentDay = now.getDay(); // 0 = Sunday, 6 = Saturday
          if (currentDay !== dayOfWeek) {
            return;
          }
        }
        if (lastRun) {
          const lastRunDate = new Date(lastRun);
          const sameDay = lastRunDate.getDate() === now.getDate() && lastRunDate.getMonth() === now.getMonth() && lastRunDate.getFullYear() === now.getFullYear();
          if (sameDay && (lastRunDate.getHours() > hour || (lastRunDate.getHours() === hour && lastRunDate.getMinutes() >= minute))) {
            return;
          }
          if (settings.frequency >= 604800000) { // Weekly
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const lastRunDay = new Date(lastRunDate.getFullYear(), lastRunDate.getMonth(), lastRunDate.getDate());
            const selectedDayThisWeek = new Date(today);
            const currentDayOfWeek = today.getDay();
            const selectedDay = settings.day !== undefined ? settings.day : 0;
            selectedDayThisWeek.setDate(today.getDate() - currentDayOfWeek + selectedDay);
            if (selectedDayThisWeek > today) {
              selectedDayThisWeek.setDate(selectedDayThisWeek.getDate() - 7);
            }
            if (lastRunDay >= selectedDayThisWeek) {
              return;
            }
          }
        }
        if (!isRightTime) {
          return;
        }
      } else if (lastRun && (now.getTime() - lastRun.getTime() < intervalMs)) {
        return; // Not time for a backup yet
      }
      await backupService.safeCreateBackup({
        serverPath,
        type: settings.type || 'world',
        trigger: 'auto'
      });
      settings.lastRun = now.toISOString();
      appStore.set('backupSettings', settings);
      if (settings.retentionCount) {
        await backupService.cleanupAutomaticBackups(serverPath, settings.retentionCount);
      }
      safeSend('backup-notification', {
        success: true,
        message: `✅ ${settings.type === 'full' ? 'Full' : 'World-only'} auto-backup created at ${now.toLocaleTimeString()}`
      });
    } catch (err) {
      safeSend('backup-notification', {
        success: false,
        message: `⚠️ Failed to create scheduled backup: ${formatErrorMessage(err)}`
      });
    }
  }, 60000); // Check every minute if a backup should run
}

function initializeAutomatedBackups() {
  // Load the settings and start the scheduler if enabled
  const settings = appStore.get('backupSettings');
    
  if (settings && settings.enabled) {
    // Need to retrieve the server path from app settings
    const serverSettings = appStore.get('serverSettings') || {};
    const lastServerPath = appStore.get('lastServerPath');
    const serverPath = serverSettings.path || lastServerPath;
    
    
    if (serverPath) {
      
      // If runOnLaunch is enabled, force a backup now
      if (settings.runOnLaunch) {
        // Run a backup immediately (after a short delay to let app initialize)
        setTimeout(async () => {
          try {
            await backupService.safeCreateBackup({
              serverPath,
              type: settings.type || 'world',
              trigger: 'app-launch'
            });
            
            
            // Update last run time
            settings.lastRun = new Date().toISOString();
            appStore.set('backupSettings', settings);
            
            // Apply retention policy
            if (settings.retentionCount) {
              await backupService.cleanupAutomaticBackups(serverPath, settings.retentionCount);
            }
            
            // Notify the user
            safeSend('backup-notification', {
              success: true,
              message: `✅ ${settings.type === 'full' ? 'Full' : 'World-only'} app-launch backup created at ${new Date().toLocaleTimeString()}`
            });
          } catch (err) {
            safeSend('backup-notification', {
              success: false, 
              message: `⚠️ Failed to create app-launch backup: ${formatErrorMessage(err)}`
            });
          }
        }, 5000);
      }
        // Always start the scheduler regardless
      startAutomatedBackups(settings, serverPath);
    }
  }
}

/**
 * Initializes the backup manager and starts automated backups if configured
 */
function loadBackupManager() {
    
    // Load backup settings
    const settings = appStore.get('backupSettings') || {
      enabled: false,
      frequency: 86400000, // 24 hours in milliseconds (default)
      type: 'world',       // default to world-only backups
      retentionCount: 7,   // keep last 7 automated backups
      runOnLaunch: false,  // don't run on app launch by default
      hour: 3,             // default to 3 AM
      minute: 0,           // default to 00 minutes
      day: 0,              // default to Sunday
      lastRun: null        // never run yet
    };
    
    // Get server path
    const serverPath = appStore.get('lastServerPath');
    
    // Start automated backups if enabled
    if (settings.enabled && serverPath) {
      startAutomatedBackups(settings, serverPath);
    }
    
    // Check if we should run a backup on launch
    if (settings.runOnLaunch && serverPath) {
      
      // Get the getWorldDirs function to check valid worlds
      const getWorldDirs = require('../services/backup-service.cjs').getWorldDirs;
      
      // Check if we have valid world directories
      const worldDirs = getWorldDirs(serverPath);
      if (worldDirs && worldDirs.length > 0) {
        
        // Run the backup with a slight delay to ensure app is fully loaded
        setTimeout(async () => {
          try {
            await backupService.safeCreateBackup({
              serverPath,
              type: settings.type || 'world',
              trigger: 'app-launch'
            });
            
            // Update last run time
            settings.lastRun = new Date().toISOString();
            appStore.set('backupSettings', settings);
            
            // Apply retention policy
            if (settings.retentionCount) {
              await backupService.cleanupAutomaticBackups(serverPath, settings.retentionCount);
            }
            
            // Send notification
            safeSend('backup-notification', {
              success: true,
              message: `✅ Auto-backup on application launch completed at ${new Date().toLocaleTimeString()}`
            });
          } catch (err) {
            
            // Send notification
            safeSend('backup-notification', {
              success: false,
              message: `⚠️ Auto-backup on launch failed: ${formatErrorMessage(err)}`
            });
          }
        }, 3000);
      } else {
        safeSend('backup-notification', {
          success: false,
          message: `⚠️ Auto-backup on launch skipped: No valid world directories found`
        });
      }
    }
}

/**
 * Clear backup intervals for app shutdown
 */
function clearBackupIntervals() {
  if (autoBackupIntervalId) {
    clearInterval(autoBackupIntervalId);
    autoBackupIntervalId = null;
    
  }
}

module.exports = { createBackupHandlers, loadBackupManager, initializeAutomatedBackups, clearBackupIntervals };
