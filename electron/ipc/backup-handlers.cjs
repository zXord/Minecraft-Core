const backupService = require('../services/backup-service.cjs');
const appStore = require('../utils/app-store.cjs');
const { safeSend } = require('../utils/safe-send.cjs');
const path = require('path');

// Timeout ID for automated backup scheduler
let autoBackupTimeoutId = null;
// Flag to prevent double initialization
let backupManagerInitialized = false;

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
        if (autoBackupTimeoutId) {
          clearTimeout(autoBackupTimeoutId);
          autoBackupTimeoutId = null;
        }
        
        // Get previous settings
        const previousSettings = appStore.get('backupSettings') || {};
        
        // Save the settings (create new object to avoid mutation issues)
        const backupSettings = {
          enabled,
          frequency,
          type,
          retentionCount,
          runOnLaunch,
          hour: hour || 3,
          minute: minute || 0,
          day: day !== undefined ? day : 0, // Default to Sunday (0)
          lastRun: previousSettings.lastRun || null
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
          retentionCount: 14,  // keep last 14 automated backups (about 2 weeks for daily)
          runOnLaunch: false,  // don't run on app launch by default
          hour: 3,             // default to 3 AM
          minute: 0,           // default to 00 minutes
          day: 0,              // default to Sunday
          lastRun: null        // never run yet
        };
        
        // Calculate next scheduled backup time if enabled
        let nextBackupTime = null;
        if (settings.enabled && settings.frequency >= 86400000) {
          const now = new Date();
          const scheduledHour = settings.hour !== undefined ? settings.hour : 3;
          const scheduledMinute = settings.minute !== undefined ? settings.minute : 0;
          
          // Create next run time for today
          nextBackupTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), scheduledHour, scheduledMinute, 0, 0);
          
          // If the time has already passed today, schedule for tomorrow
          if (nextBackupTime <= now) {
            nextBackupTime.setDate(nextBackupTime.getDate() + 1);
          }
          
          // For weekly backups, adjust to the correct day
          if (settings.frequency >= 604800000) { // Weekly
            const targetDay = settings.day !== undefined ? settings.day : 0;
            const currentDay = nextBackupTime.getDay();
            const daysUntilTarget = (targetDay - currentDay + 7) % 7;
            
            if (daysUntilTarget > 0) {
              nextBackupTime.setDate(nextBackupTime.getDate() + daysUntilTarget);
            } else if (daysUntilTarget === 0 && nextBackupTime <= now) {
              nextBackupTime.setDate(nextBackupTime.getDate() + 7);
            }
          }
          
          // Check if we already ran today/this week and adjust
          const lastRun = settings.lastRun ? new Date(settings.lastRun) : null;
          if (lastRun) {
            if (settings.frequency < 604800000) { // Daily
              const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              const lastRunDay = new Date(lastRun.getFullYear(), lastRun.getMonth(), lastRun.getDate());
              
              if (lastRunDay.getTime() === today.getTime()) {
                nextBackupTime.setDate(nextBackupTime.getDate() + 1);
              }
            } else { // Weekly
              const daysSinceLastRun = Math.floor((now.getTime() - lastRun.getTime()) / (1000 * 60 * 60 * 24));
              if (daysSinceLastRun < 6) {
                const daysToAdd = 7 - (daysSinceLastRun % 7);
                nextBackupTime.setDate(nextBackupTime.getDate() + daysToAdd);
              }
            }
          }
        }
        
        return { 
          success: true, 
          settings: {
            ...settings,
            nextBackupTime: nextBackupTime ? nextBackupTime.toISOString() : null
          }
        };
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
        
        // Update last run time in settings
        const updatedSettings = { ...settings, lastRun: new Date().toISOString() };
        appStore.set('backupSettings', updatedSettings);
        
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

  // Clear any existing timeout
  if (autoBackupTimeoutId) {
    clearTimeout(autoBackupTimeoutId);
    autoBackupTimeoutId = null;
  }

  // Calculate when the next backup should run
  function scheduleNextBackup() {
    const now = new Date();
    let nextRunTime;

    if (settings.frequency >= 86400000) { // Daily or weekly
      const scheduledHour = settings.hour !== undefined ? settings.hour : 3;
      const scheduledMinute = settings.minute !== undefined ? settings.minute : 0;
      
      // Create next run time for today
      nextRunTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), scheduledHour, scheduledMinute, 0, 0);
      
      // If the time has already passed today, schedule for tomorrow
      if (nextRunTime <= now) {
        nextRunTime.setDate(nextRunTime.getDate() + 1);
      }
      
      // For weekly backups, adjust to the correct day
      if (settings.frequency >= 604800000) { // Weekly
        const targetDay = settings.day !== undefined ? settings.day : 0; // Sunday = 0
        const currentDay = nextRunTime.getDay();
        const daysUntilTarget = (targetDay - currentDay + 7) % 7;
        
        if (daysUntilTarget > 0) {
          nextRunTime.setDate(nextRunTime.getDate() + daysUntilTarget);
        } else if (daysUntilTarget === 0 && nextRunTime <= now) {
          // If today is the target day but time has passed, schedule for next week
          nextRunTime.setDate(nextRunTime.getDate() + 7);
        }
      }
      
      // Check if we already ran today (for daily) or this week (for weekly)
      const lastRun = settings.lastRun ? new Date(settings.lastRun) : null;
      if (lastRun) {
        if (settings.frequency < 604800000) { // Daily
          const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const lastRunDay = new Date(lastRun.getFullYear(), lastRun.getMonth(), lastRun.getDate());
          
          if (lastRunDay.getTime() === today.getTime()) {
            // Already ran today, schedule for tomorrow
            nextRunTime.setDate(nextRunTime.getDate() + 1);
          }
        } else { // Weekly
          const daysSinceLastRun = Math.floor((now.getTime() - lastRun.getTime()) / (1000 * 60 * 60 * 24));
          if (daysSinceLastRun < 6) {
            // Already ran this week, schedule for next week
            const daysToAdd = 7 - (daysSinceLastRun % 7);
            nextRunTime.setDate(nextRunTime.getDate() + daysToAdd);
          }
        }
      }
    } else {
      // For shorter intervals (hourly, etc.), schedule based on interval
      const lastRun = settings.lastRun ? new Date(settings.lastRun) : null;
      if (lastRun) {
        nextRunTime = new Date(lastRun.getTime() + settings.frequency);
      } else {
        nextRunTime = new Date(now.getTime() + settings.frequency);
      }
    }

    const msUntilNextRun = nextRunTime.getTime() - now.getTime();

    // Schedule the backup to run at the exact time
    autoBackupTimeoutId = setTimeout(async () => {
      try {
        const currentSettings = appStore.get('backupSettings') || settings;
        
        // Double-check that backups are still enabled
        if (!currentSettings.enabled) {
          return;
        }

        const now = new Date();
        
        await backupService.safeCreateBackup({
          serverPath,
          type: currentSettings.type || 'world',
          trigger: 'auto'
        });
        
        // Update last run time
        const updatedSettings = { ...currentSettings, lastRun: now.toISOString() };
        appStore.set('backupSettings', updatedSettings);
        
        // Apply retention policy
        if (currentSettings.retentionCount) {
          await backupService.cleanupAutomaticBackups(serverPath, currentSettings.retentionCount);
        }
        
        safeSend('backup-notification', {
          success: true,
          message: `✅ ${currentSettings.type === 'full' ? 'Full' : 'World-only'} auto-backup created at ${now.toLocaleString()}`
        });

        // Schedule the next backup
        scheduleNextBackup();
        
      } catch (err) {
        console.error('Failed to create scheduled backup:', err);
        safeSend('backup-notification', {
          success: false,
          message: `⚠️ Failed to create scheduled backup: ${formatErrorMessage(err)}`
        });
        
        // Schedule the next backup even if this one failed
        scheduleNextBackup();
      }
    }, msUntilNextRun);
  }

  // Start the scheduling
  scheduleNextBackup();
}

/**
 * Unified function to initialize the backup manager
 * This replaces both initializeAutomatedBackups and loadBackupManager
 */
function loadBackupManager() {
  // Prevent double initialization
  if (backupManagerInitialized) {
    return;
  }
  backupManagerInitialized = true;
  
  // Load backup settings
  const settings = appStore.get('backupSettings') || {
    enabled: false,
    frequency: 86400000, // 24 hours in milliseconds (default)
    type: 'world',       // default to world-only backups
    retentionCount: 14,  // keep last 14 automated backups (about 2 weeks for daily)
    runOnLaunch: false,  // don't run on app launch by default
    hour: 3,             // default to 3 AM
    minute: 0,           // default to 00 minutes
    day: 0,              // default to Sunday
    lastRun: null        // never run yet
  };
  
  // Get server path
  const serverSettings = appStore.get('serverSettings') || {};
  const lastServerPath = appStore.get('lastServerPath');
  const serverPath = serverSettings.path || lastServerPath;
  
  if (!serverPath) {
    return; // No server path available
  }
  
  // Start automated backups if enabled
  if (settings.enabled) {
    startAutomatedBackups(settings, serverPath);
  }
  
  // Handle app-launch backup if enabled
  if (settings.runOnLaunch) {
    // Get the getWorldDirs function to check valid worlds
    const getWorldDirs = require('../services/backup-service.cjs').getWorldDirs;
    
    // Check if we have valid world directories
    const worldDirs = getWorldDirs(serverPath);
    if (worldDirs && worldDirs.length > 0) {
      // Run the backup with a delay to ensure app is fully loaded
      setTimeout(async () => {
        try {
          await backupService.safeCreateBackup({
            serverPath,
            type: settings.type || 'world',
            trigger: 'app-launch'
          });
          
          // Update last run time
          const updatedSettings = { ...settings, lastRun: new Date().toISOString() };
          appStore.set('backupSettings', updatedSettings);
          
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
  if (autoBackupTimeoutId) {
    clearTimeout(autoBackupTimeoutId);
    autoBackupTimeoutId = null;
  }
  // Reset initialization flag
  backupManagerInitialized = false;
}

module.exports = { createBackupHandlers, loadBackupManager, clearBackupIntervals };
