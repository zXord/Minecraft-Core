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

function createBackupHandlers(win) {
  return {
    'backups:create': async (_e, { serverPath, type, trigger }) => {
      try {
        return await backupService.createBackup({ serverPath, type, trigger });
      } catch (err) {
        console.error('Backup creation error:', err);
        return { error: formatErrorMessage(err) };
      }
    },
    'backups:list': async (_e, { serverPath }) => {
      try {
        return await backupService.listBackupsWithMetadata(serverPath);
      } catch (err) {
        console.error('Backup listing error:', err);
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
        console.error('Safe backup creation error:', err);
        
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
        const isNewActivation = !previousSettings.enabled && enabled;
        
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
          startAutomatedBackups(win, backupSettings, serverPath, isNewActivation);
        }
        
        return { success: true };
      } catch (err) {
        console.error('Configure automation error:', err);
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
        console.error('Get automation settings error:', err);
        return { success: false, error: formatErrorMessage(err) };
      }
    },
    'backups:run-immediate-auto': async (_e, { serverPath }) => {
      try {
        const settings = appStore.get('backupSettings') || {};
        const type = settings.type || 'world';
        const result = await backupService.safeCreateBackup({ 
          serverPath, 
          type, 
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
          message: `✅ Manual ${type === 'full' ? 'Full' : 'World-only'} auto-backup created at ${new Date().toLocaleTimeString()}`
        });
        
        return result;
      } catch (err) {
        console.error('Run immediate auto backup error:', err);
        safeSend('backup-notification', {
          success: false,
          message: `⚠️ Failed to create manual auto-backup: ${formatErrorMessage(err)}`
        });
        return { error: formatErrorMessage(err) };
      }
    }
  };
}

function startAutomatedBackups(win, settings, serverPath, isNewActivation = false) {
  if (!settings.enabled || !settings.frequency) {
    console.log('[Backup] Automated backups disabled or no frequency set');
    return;
  }
  
  console.log(`[Backup] Starting automated backup scheduler with frequency: ${settings.frequency}ms`);
  
  // Convert frequency to milliseconds if it's a string option
  let intervalMs = settings.frequency;
  
  // Note: We've moved the app launch backup code to the initializeAutomatedBackups function
  // so we don't need to handle it here anymore
  
  // Set up the interval for regular backups
  if (autoBackupIntervalId) {
    console.log('[Backup] Clearing existing backup interval');
    clearInterval(autoBackupIntervalId);
  }
  
  console.log('[Backup] Setting up new backup interval check (every minute)');
  autoBackupIntervalId = setInterval(async () => {
    try {
      // Check if it's been at least frequency ms since last backup
      const lastRun = settings.lastRun ? new Date(settings.lastRun) : null;
      const now = new Date();
      
      // For daily and weekly backups, check the time of day too
      if (settings.frequency >= 86400000) { // Daily or weekly
        const hour = settings.hour !== undefined ? settings.hour : 3; // Default to 3 AM
        const minute = settings.minute !== undefined ? settings.minute : 0; // Default to 00 minutes
        
        // Only run if we're in the right hour and minute (or just past it)
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        
        const isRightTime = (currentHour === hour && currentMinute >= minute) || 
                           (currentHour > hour);
        
        // For weekly backups, also check the day of week
        if (settings.frequency >= 604800000) { // Weekly
          const dayOfWeek = settings.day !== undefined ? settings.day : 0; // Default to Sunday (0)
          const currentDay = now.getDay(); // 0 = Sunday, 6 = Saturday
          
          // If it's not the right day of the week, skip
          if (currentDay !== dayOfWeek) {
            return;
          }
        }
        
        // For daily backups, check if we already ran today
        if (lastRun) {
          const lastRunDate = new Date(lastRun);
          const sameDay = lastRunDate.getDate() === now.getDate() && 
                          lastRunDate.getMonth() === now.getMonth() &&
                          lastRunDate.getFullYear() === now.getFullYear();
          
          // If already ran today after the scheduled time, skip
          if (sameDay && 
              (lastRunDate.getHours() > hour || 
              (lastRunDate.getHours() === hour && lastRunDate.getMinutes() >= minute))) {
            return;
          }
          
          // For weekly backups, check if we already ran this week
          if (settings.frequency >= 604800000) { // Weekly
            const msInDay = 24 * 60 * 60 * 1000;
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const lastRunDay = new Date(lastRunDate.getFullYear(), lastRunDate.getMonth(), lastRunDate.getDate());
            
            // Check if the last run was on the selected day of this week
            const selectedDayThisWeek = new Date(today);
            const currentDayOfWeek = today.getDay();
            const selectedDay = settings.day !== undefined ? settings.day : 0;
            
            // Adjust date to the selected day this week
            selectedDayThisWeek.setDate(today.getDate() - currentDayOfWeek + selectedDay);
            if (selectedDayThisWeek > today) {
              // If selected day is ahead of current day, go back a week
              selectedDayThisWeek.setDate(selectedDayThisWeek.getDate() - 7);
            }
            
            // If last run was on or after the selected day this week, skip
            if (lastRunDay >= selectedDayThisWeek) {
              return;
            }
          }
        }
        
        // Skip if it's not the right time yet
        if (!isRightTime) {
          return;
        }
      } else if (lastRun && (now.getTime() - lastRun.getTime() < intervalMs)) {
        // For shorter frequencies, just check if enough time has elapsed
        return; // Not time for a backup yet
      }
      
      console.log('[Backup] Conditions met for scheduled backup, executing now');
      await backupService.safeCreateBackup({
        serverPath,
        type: settings.type || 'world',
        trigger: 'auto'
      });
      
      // Update last run time
      settings.lastRun = now.toISOString();
      appStore.set('backupSettings', settings);
      
      // Apply retention policy
      if (settings.retentionCount) {
        await backupService.cleanupAutomaticBackups(serverPath, settings.retentionCount);
      }
      
      // Notify the user
      safeSend('backup-notification', {
        success: true, 
        message: `✅ ${settings.type === 'full' ? 'Full' : 'World-only'} auto-backup created at ${now.toLocaleTimeString()}`
      });
    } catch (err) {
      console.error('Scheduled auto-backup failed:', err);
      safeSend('backup-notification', {
        success: false, 
        message: `⚠️ Failed to create scheduled backup: ${formatErrorMessage(err)}`
      });
    }
  }, 60000); // Check every minute if a backup should run
}

function initializeAutomatedBackups(win) {
  // Load the settings and start the scheduler if enabled
  const settings = appStore.get('backupSettings');
  console.log('[Backup] Initializing automated backups with settings:', 
    settings ? JSON.stringify({
      enabled: settings.enabled,
      runOnLaunch: settings.runOnLaunch,
      type: settings.type
    }) : 'null');
    
  if (settings && settings.enabled) {
    // Need to retrieve the server path from app settings
    const serverSettings = appStore.get('serverSettings') || {};
    const lastServerPath = appStore.get('lastServerPath');
    const serverPath = serverSettings.path || lastServerPath;
    
    console.log('[Backup] Server path for automated backups:', serverPath);
    
    if (serverPath) {
      console.log('[Backup] Initializing automated backups on app startup');
      
      // If runOnLaunch is enabled, force a backup now
      if (settings.runOnLaunch) {
        console.log('[Backup] Run-on-launch is enabled, scheduling immediate backup');
        // Run a backup immediately (after a short delay to let app initialize)
        setTimeout(async () => {
          try {
            console.log('[Backup] Executing app-launch backup now');
            const result = await backupService.safeCreateBackup({
              serverPath,
              type: settings.type || 'world',
              trigger: 'app-launch'
            });
            
            console.log('[Backup] App launch backup completed:', result);
            
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
            console.error('[Backup] Auto-backup on launch failed:', err);
            safeSend('backup-notification', {
              success: false, 
              message: `⚠️ Failed to create app-launch backup: ${formatErrorMessage(err)}`
            });
          }
        }, 5000);
      }
      
      // Always start the scheduler regardless
      startAutomatedBackups(win, settings, serverPath);
    } else {
      console.log('[Backup] No server path available, skipping automated backup initialization');
    }
  } else {
    console.log('[Backup] Automated backups not enabled, skipping initialization');
  }
}

/**
 * Initializes the backup manager and starts automated backups if configured
 * 
 * @param {BrowserWindow} win - The main application window
 */
function loadBackupManager(win) {
  try {
    console.log('[Backup] Initializing backup manager');
    
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
      console.log('[Backup] Starting automated backup scheduler');
      startAutomatedBackups(win, settings, serverPath);
    }
    
    // Check if we should run a backup on launch
    if (settings.runOnLaunch && serverPath) {
      console.log('[Backup] Checking for world directories before running launch backup');
      
      // Get the getWorldDirs function to check valid worlds
      const getWorldDirs = require('../services/backup-service.cjs').getWorldDirs;
      
      // Check if we have valid world directories
      const worldDirs = getWorldDirs(serverPath);
      if (worldDirs && worldDirs.length > 0) {
        console.log(`[Backup] Found ${worldDirs.length} valid world directories, proceeding with backup`);
        
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
            console.error('[Backup] Auto-backup on launch failed:', err);
            
            // Send notification
            safeSend('backup-notification', {
              success: false,
              message: `⚠️ Auto-backup on launch failed: ${formatErrorMessage(err)}`
            });
          }
        }, 3000);
      } else {
        console.log('[Backup] No valid world directories found, skipping launch backup');
        safeSend('backup-notification', {
          success: false,
          message: `⚠️ Auto-backup on launch skipped: No valid world directories found`
        });
      }
    }
  } catch (err) {
    console.error('[Backup] Error initializing backup manager:', err);
  }
}

module.exports = { createBackupHandlers, loadBackupManager, initializeAutomatedBackups }; 
