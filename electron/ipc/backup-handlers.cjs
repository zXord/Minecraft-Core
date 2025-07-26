const backupService = require('../services/backup-service.cjs');
const appStore = require('../utils/app-store.cjs');
const { safeSend } = require('../utils/safe-send.cjs');
const path = require('path');
const { getLoggerHandlers } = require('./logger-handlers.cjs');

const logger = getLoggerHandlers();

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
  logger.info('Backup handlers initialized', {
    category: 'backup',
    data: { handler: 'createBackupHandlers' }
  });

  return {
    'backups:create': async (_e, { serverPath, type, trigger }) => {
      const startTime = Date.now();
      
      logger.info('Backup creation requested', {
        category: 'backup',
        data: {
          handler: 'backups:create',
          serverPath,
          type,
          trigger,
          sender: _e.sender.id
        }
      });

      try {
        // Validate parameters
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for backup creation', {
            category: 'backup',
            data: {
              handler: 'backups:create',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        if (!type || !['full', 'world'].includes(type)) {
          logger.error('Invalid backup type specified', {
            category: 'backup',
            data: {
              handler: 'backups:create',
              type,
              validTypes: ['full', 'world']
            }
          });
          throw new Error('Invalid backup type');
        }

        logger.debug('Creating backup with validated parameters', {
          category: 'backup',
          data: {
            handler: 'backups:create',
            serverPath,
            type,
            trigger: trigger || 'manual'
          }
        });

        const result = await backupService.createBackup({ serverPath, type, trigger });
        const duration = Date.now() - startTime;

        logger.info('Backup created successfully', {
          category: 'performance',
          data: {
            handler: 'backups:create',
            duration,
            success: true,
            backupName: result?.name,
            backupSize: result?.size,
            type,
            trigger
          }
        });

        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);
        
        logger.error(`Backup creation failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:create',
            errorType: err.constructor.name,
            duration,
            serverPath,
            type,
            trigger,
            formattedError
          }
        });

        return { error: formattedError };
      }
    },
    'backups:list': async (_e, { serverPath }) => {
      const startTime = Date.now();
      
      logger.debug('Backup list requested', {
        category: 'backup',
        data: {
          handler: 'backups:list',
          serverPath,
          sender: _e.sender.id
        }
      });

      try {
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for backup listing', {
            category: 'backup',
            data: {
              handler: 'backups:list',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        const result = await backupService.listBackupsWithMetadata(serverPath);
        const duration = Date.now() - startTime;

        logger.info('Backup list retrieved successfully', {
          category: 'performance',
          data: {
            handler: 'backups:list',
            duration,
            success: true,
            backupCount: (result && Array.isArray(result)) ? result.length : 0,
            serverPath
          }
        });

        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);
        
        logger.error(`Backup listing failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:list',
            errorType: err.constructor.name,
            duration,
            serverPath,
            formattedError
          }
        });

        return { error: formattedError };
      }
    },
    'backups:delete': async (_e, { serverPath, name }) => {
      const startTime = Date.now();
      
      logger.warn('Backup deletion requested', {
        category: 'backup',
        data: {
          handler: 'backups:delete',
          serverPath,
          backupName: name,
          sender: _e.sender.id
        }
      });

      try {
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for backup deletion', {
            category: 'backup',
            data: {
              handler: 'backups:delete',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        if (!name || typeof name !== 'string') {
          logger.error('Invalid backup name for deletion', {
            category: 'backup',
            data: {
              handler: 'backups:delete',
              name,
              nameType: typeof name,
              serverPath
            }
          });
          throw new Error('Invalid backup name');
        }

        const result = await backupService.deleteBackup({ serverPath, name });
        const duration = Date.now() - startTime;

        logger.warn('Backup deleted successfully', {
          category: 'performance',
          data: {
            handler: 'backups:delete',
            duration,
            success: result?.success || false,
            backupName: name,
            serverPath
          }
        });

        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Backup deletion failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:delete',
            errorType: err.constructor.name,
            duration,
            serverPath,
            backupName: name
          }
        });
        throw err;
      }
    },
    'backups:rename': async (_e, { serverPath, oldName, newName }) => {
      const startTime = Date.now();
      
      logger.info('Backup rename requested', {
        category: 'backup',
        data: {
          handler: 'backups:rename',
          serverPath,
          oldName,
          newName,
          sender: _e.sender.id
        }
      });

      try {
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for backup rename', {
            category: 'backup',
            data: {
              handler: 'backups:rename',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        if (!oldName || typeof oldName !== 'string') {
          logger.error('Invalid old backup name for rename', {
            category: 'backup',
            data: {
              handler: 'backups:rename',
              oldName,
              oldNameType: typeof oldName,
              serverPath
            }
          });
          throw new Error('Invalid old backup name');
        }

        if (!newName || typeof newName !== 'string') {
          logger.error('Invalid new backup name for rename', {
            category: 'backup',
            data: {
              handler: 'backups:rename',
              newName,
              newNameType: typeof newName,
              serverPath
            }
          });
          throw new Error('Invalid new backup name');
        }

        await backupService.renameBackup({ serverPath, oldName, newName });
        const duration = Date.now() - startTime;

        logger.info('Backup renamed successfully', {
          category: 'performance',
          data: {
            handler: 'backups:rename',
            duration,
            success: true,
            oldName,
            newName,
            serverPath
          }
        });

        return { success: true };
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Backup rename failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:rename',
            errorType: err.constructor.name,
            duration,
            serverPath,
            oldName,
            newName
          }
        });
        throw err;
      }
    },
    'backups:restore': async (_e, { serverPath, name, serverStatus }) => {
      const startTime = Date.now();
      
      logger.warn('Backup restore requested', {
        category: 'backup',
        data: {
          handler: 'backups:restore',
          serverPath,
          backupName: name,
          serverStatus,
          sender: _e.sender.id
        }
      });

      try {
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for backup restore', {
            category: 'backup',
            data: {
              handler: 'backups:restore',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        if (!name || typeof name !== 'string') {
          logger.error('Invalid backup name for restore', {
            category: 'backup',
            data: {
              handler: 'backups:restore',
              name,
              nameType: typeof name,
              serverPath
            }
          });
          throw new Error('Invalid backup name');
        }

        logger.warn('Starting backup restore process', {
          category: 'backup',
          data: {
            handler: 'backups:restore',
            backupName: name,
            serverPath,
            serverStatus
          }
        });

        const result = await backupService.restoreBackup({ serverPath, name, serverStatus });
        const duration = Date.now() - startTime;

        logger.warn('Backup restore completed', {
          category: 'performance',
          data: {
            handler: 'backups:restore',
            duration,
            success: result?.success || false,
            backupName: name,
            serverPath,
            serverStatus
          }
        });

        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Backup restore failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:restore',
            errorType: err.constructor.name,
            duration,
            serverPath,
            backupName: name,
            serverStatus
          }
        });
        throw err;
      }
    },
    // New handlers for automated backups
    'backups:safe-create': async (_e, { serverPath, type, trigger }) => {
      const startTime = Date.now();
      
      logger.info('Safe backup creation requested', {
        category: 'backup',
        data: {
          handler: 'backups:safe-create',
          serverPath,
          type,
          trigger,
          sender: _e.sender.id
        }
      });

      try {
        // Validate the server path to check if it exists and has valid world directories
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for safe backup creation', {
            category: 'backup',
            data: {
              handler: 'backups:safe-create',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        if (!path.isAbsolute(serverPath)) {
          logger.error('Server path must be absolute for safe backup', {
            category: 'backup',
            data: {
              handler: 'backups:safe-create',
              serverPath,
              isAbsolute: path.isAbsolute(serverPath)
            }
          });
          throw new Error('Server path must be absolute');
        }

        if (!type || !['full', 'world'].includes(type)) {
          logger.error('Invalid backup type for safe backup', {
            category: 'backup',
            data: {
              handler: 'backups:safe-create',
              type,
              validTypes: ['full', 'world']
            }
          });
          throw new Error('Invalid backup type');
        }

        logger.debug('Creating safe backup with validated parameters', {
          category: 'backup',
          data: {
            handler: 'backups:safe-create',
            serverPath,
            type,
            trigger: trigger || 'manual'
          }
        });
        
        const result = await backupService.safeCreateBackup({ serverPath, type, trigger });
        
        // Verify backup was created successfully
        if (!result || !result.name || result.size === 0) {
          logger.error('Backup file appears to be empty or invalid', {
            category: 'backup',
            data: {
              handler: 'backups:safe-create',
              result,
              hasName: !!result?.name,
              size: result?.size || 0
            }
          });
          throw new Error('Backup file was created but appears to be empty');
        }

        logger.info('Safe backup created successfully', {
          category: 'backup',
          data: {
            handler: 'backups:safe-create',
            backupName: result.name,
            backupSize: result.size,
            type,
            trigger
          }
        });
        
        // Show a success notification with type info
        safeSend('backup-notification', {
          success: true,
          message: `✅ ${type === 'full' ? 'Full' : 'World-only'} ${trigger} backup created at ${new Date().toLocaleTimeString()}`
        });
        
        // Apply retention policy if it's an automated backup
        if (trigger === 'auto' || trigger === 'app-launch') {
          const backupSettings = appStore.get('backupSettings') || {};
          if (backupSettings.retentionCount) {
            logger.debug('Applying retention policy for automated backup', {
              category: 'backup',
              data: {
                handler: 'backups:safe-create',
                retentionCount: backupSettings.retentionCount,
                trigger,
                serverPath
              }
            });
            await backupService.cleanupAutomaticBackups(serverPath, backupSettings.retentionCount);
          }
        }

        const duration = Date.now() - startTime;
        logger.info('Safe backup process completed', {
          category: 'performance',
          data: {
            handler: 'backups:safe-create',
            duration,
            success: true,
            backupName: result.name,
            backupSize: result.size
          }
        });
        
        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);
        
        logger.error(`Safe backup creation failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:safe-create',
            errorType: err.constructor.name,
            duration,
            serverPath,
            type,
            trigger,
            formattedError
          }
        });

        // Show an error notification with user-friendly message
        safeSend('backup-notification', {
          success: false,
          message: `⚠️ Failed to create ${type === 'full' ? 'full' : 'world-only'} ${trigger} backup: ${formattedError}`
        });
        
        return { error: formattedError };
      }
    },
    'backups:configure-automation': (_e, { enabled, frequency, type, retentionCount, runOnLaunch, serverPath, hour, minute, day }) => {
      const startTime = Date.now();
      
      logger.info('Backup automation configuration requested', {
        category: 'backup',
        data: {
          handler: 'backups:configure-automation',
          enabled,
          frequency,
          type,
          retentionCount,
          runOnLaunch,
          serverPath,
          hour,
          minute,
          day,
          sender: _e.sender.id
        }
      });

      try {
        // Stop existing scheduler if running
        if (autoBackupTimeoutId) {
          logger.debug('Stopping existing backup scheduler', {
            category: 'backup',
            data: {
              handler: 'backups:configure-automation',
              hadExistingScheduler: true
            }
          });
          clearTimeout(autoBackupTimeoutId);
          autoBackupTimeoutId = null;
        }
        
        // Get previous settings
        const previousSettings = appStore.get('backupSettings') || {};
        
        logger.debug('Previous backup settings retrieved', {
          category: 'settings',
          data: {
            handler: 'backups:configure-automation',
            previousEnabled: previousSettings.enabled,
            previousFrequency: previousSettings.frequency,
            previousType: previousSettings.type
          }
        });
        
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

        logger.info('Saving backup automation settings', {
          category: 'settings',
          data: {
            handler: 'backups:configure-automation',
            newSettings: {
              enabled: backupSettings.enabled,
              frequency: backupSettings.frequency,
              type: backupSettings.type,
              retentionCount: backupSettings.retentionCount,
              runOnLaunch: backupSettings.runOnLaunch,
              hour: backupSettings.hour,
              minute: backupSettings.minute,
              day: backupSettings.day
            }
          }
        });

        appStore.set('backupSettings', backupSettings);
        
        // If enabled, start the new scheduler
        if (enabled && frequency && serverPath) {
          logger.info('Starting automated backup scheduler', {
            category: 'backup',
            data: {
              handler: 'backups:configure-automation',
              serverPath,
              frequency,
              type
            }
          });
          startAutomatedBackups(backupSettings, serverPath);
        } else {
          logger.debug('Automated backups not started', {
            category: 'backup',
            data: {
              handler: 'backups:configure-automation',
              enabled,
              hasFrequency: !!frequency,
              hasServerPath: !!serverPath
            }
          });
        }

        const duration = Date.now() - startTime;
        logger.info('Backup automation configured successfully', {
          category: 'performance',
          data: {
            handler: 'backups:configure-automation',
            duration,
            success: true,
            enabled,
            schedulerStarted: enabled && frequency && serverPath
          }
        });
        
        return { success: true };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);
        
        logger.error(`Backup automation configuration failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:configure-automation',
            errorType: err.constructor.name,
            duration,
            enabled,
            frequency,
            type,
            serverPath,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },
    'backups:get-automation-settings': () => {
      const startTime = Date.now();
      
      logger.debug('Backup automation settings requested', {
        category: 'backup',
        data: { handler: 'backups:get-automation-settings' }
      });

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

        logger.debug('Backup settings retrieved from store', {
          category: 'settings',
          data: {
            handler: 'backups:get-automation-settings',
            enabled: settings.enabled,
            frequency: settings.frequency,
            type: settings.type,
            retentionCount: settings.retentionCount,
            hasLastRun: !!settings.lastRun
          }
        });
        
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
              // Only skip today if the last run occurred *after* the upcoming scheduled time.
              if (lastRun >= nextBackupTime) {
                nextBackupTime.setDate(nextBackupTime.getDate() + 1);
              }
            } else { // Weekly
              // Skip this week only if the last run happened after the upcoming scheduled time this week
              if (lastRun >= nextBackupTime) {
                nextBackupTime.setDate(nextBackupTime.getDate() + 7);
              }
            }
          }
        }
        
        const duration = Date.now() - startTime;
        
        logger.debug('Backup automation settings retrieved successfully', {
          category: 'performance',
          data: {
            handler: 'backups:get-automation-settings',
            duration,
            success: true,
            enabled: settings.enabled,
            hasNextBackupTime: !!nextBackupTime
          }
        });

        return { 
          success: true, 
          settings: {
            ...settings,
            nextBackupTime: nextBackupTime ? nextBackupTime.toISOString() : null
          }
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);
        
        logger.error(`Failed to get backup automation settings: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:get-automation-settings',
            errorType: err.constructor.name,
            duration,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },
    'backups:run-immediate-auto': async (_e, { serverPath, type }) => {
      const startTime = Date.now();
      
      logger.info('Immediate auto-backup requested', {
        category: 'backup',
        data: {
          handler: 'backups:run-immediate-auto',
          serverPath,
          type,
          sender: _e.sender.id
        }
      });

      try {
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for immediate auto-backup', {
            category: 'backup',
            data: {
              handler: 'backups:run-immediate-auto',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        const settings = appStore.get('backupSettings') || {};
        const backupType = type || settings.type || 'world';

        logger.debug('Running immediate auto-backup', {
          category: 'backup',
          data: {
            handler: 'backups:run-immediate-auto',
            serverPath,
            backupType,
            settingsType: settings.type
          }
        });

        const result = await backupService.safeCreateBackup({
          serverPath,
          type: backupType,
          trigger: 'manual-auto'  // Mark as manually triggered auto backup
        });
        
        // Update last run time in settings
        const updatedSettings = { ...settings, lastRun: new Date().toISOString() };
        appStore.set('backupSettings', updatedSettings);
        
        logger.debug('Updated last run time in settings', {
          category: 'settings',
          data: {
            handler: 'backups:run-immediate-auto',
            lastRun: updatedSettings.lastRun
          }
        });
        
        // Apply retention policy
        if (settings.retentionCount) {
          logger.debug('Applying retention policy for immediate auto-backup', {
            category: 'backup',
            data: {
              handler: 'backups:run-immediate-auto',
              retentionCount: settings.retentionCount,
              serverPath
            }
          });
          await backupService.cleanupAutomaticBackups(serverPath, settings.retentionCount);
        }

        const duration = Date.now() - startTime;
        
        logger.info('Immediate auto-backup completed successfully', {
          category: 'performance',
          data: {
            handler: 'backups:run-immediate-auto',
            duration,
            success: true,
            backupName: result?.name,
            backupSize: result?.size,
            backupType
          }
        });
        
        // Send notification
        safeSend('backup-notification', {
          success: true,
          message: `✅ Manual ${backupType === 'full' ? 'Full' : 'World-only'} auto-backup created at ${new Date().toLocaleTimeString()}`
        });
        
        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);
        
        logger.error(`Immediate auto-backup failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:run-immediate-auto',
            errorType: err.constructor.name,
            duration,
            serverPath,
            type,
            formattedError
          }
        });

        safeSend('backup-notification', {
          success: false,
          message: `⚠️ Failed to create manual auto-backup: ${formattedError}`
        });
        return { error: formattedError };
      }
    }
  };
}

function startAutomatedBackups(settings, serverPath) {
  logger.info('Starting automated backup scheduler', {
    category: 'backup',
    data: {
      function: 'startAutomatedBackups',
      enabled: settings.enabled,
      frequency: settings.frequency,
      type: settings.type,
      serverPath,
      retentionCount: settings.retentionCount
    }
  });

  if (!settings.enabled || !settings.frequency) {
    logger.debug('Automated backups not started - disabled or no frequency', {
      category: 'backup',
      data: {
        function: 'startAutomatedBackups',
        enabled: settings.enabled,
        hasFrequency: !!settings.frequency
      }
    });
    return;
  }

  // Clear any existing timeout
  if (autoBackupTimeoutId) {
    logger.debug('Clearing existing backup scheduler timeout', {
      category: 'backup',
      data: {
        function: 'startAutomatedBackups',
        hadExistingTimeout: true
      }
    });
    clearTimeout(autoBackupTimeoutId);
    autoBackupTimeoutId = null;
  }

  // Calculate when the next backup should run
  function scheduleNextBackup() {
    const now = new Date();
    // Always use the latest settings from the store (in case they changed since the last run)
    const currentSettings = appStore.get('backupSettings') || settings;

    logger.debug('Calculating next backup schedule', {
      category: 'backup',
      data: {
        function: 'scheduleNextBackup',
        frequency: currentSettings.frequency,
        type: currentSettings.type,
        enabled: currentSettings.enabled,
        hour: currentSettings.hour,
        minute: currentSettings.minute,
        day: currentSettings.day,
        lastRun: currentSettings.lastRun
      }
    });

    let nextRunTime;

    if (currentSettings.frequency >= 86400000) { // Daily or weekly
      const scheduledHour = currentSettings.hour !== undefined ? currentSettings.hour : 3;
      const scheduledMinute = currentSettings.minute !== undefined ? currentSettings.minute : 0;
      
      // Create next run time for today
      nextRunTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), scheduledHour, scheduledMinute, 0, 0);
      
      // If the time has already passed today, schedule for tomorrow
      if (nextRunTime <= now) {
        nextRunTime.setDate(nextRunTime.getDate() + 1);
      }
      
      // For weekly backups, adjust to the correct day
      if (currentSettings.frequency >= 604800000) { // Weekly
        const targetDay = currentSettings.day !== undefined ? currentSettings.day : 0; // Sunday = 0
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
      const lastRun = currentSettings.lastRun ? new Date(currentSettings.lastRun) : null;
      if (lastRun) {
        if (currentSettings.frequency < 604800000) { // Daily
          // Only defer to tomorrow if the last run occurred after the upcoming scheduled time.
          if (lastRun >= nextRunTime) {
            nextRunTime.setDate(nextRunTime.getDate() + 1);
          }
        } else { // Weekly
          // Only skip this week if the last run happened after the upcoming scheduled time this week
          if (lastRun >= nextRunTime) {
            nextRunTime.setDate(nextRunTime.getDate() + 7);
          }
        }
      }
    } else {
      // For shorter intervals (hourly, etc.), schedule based on interval
      const lastRun = currentSettings.lastRun ? new Date(currentSettings.lastRun) : null;
      if (lastRun) {
        nextRunTime = new Date(lastRun.getTime() + currentSettings.frequency);
      } else {
        nextRunTime = new Date(now.getTime() + currentSettings.frequency);
      }
    }

    const msUntilNextRun = nextRunTime.getTime() - now.getTime();

    logger.info('Backup scheduled for next run', {
      category: 'backup',
      data: {
        function: 'scheduleNextBackup',
        nextRunTime: nextRunTime.toISOString(),
        msUntilNextRun,
        hoursUntilRun: Math.round(msUntilNextRun / (1000 * 60 * 60) * 100) / 100,
        serverPath
      }
    });

    // Schedule the backup to run at the exact time
    autoBackupTimeoutId = setTimeout(async () => {
      try {
        const currentSettings = appStore.get('backupSettings') || settings;
        
        logger.info('Executing scheduled backup', {
          category: 'backup',
          data: {
            function: 'scheduleNextBackup',
            trigger: 'auto',
            type: currentSettings.type,
            serverPath,
            scheduledTime: new Date().toISOString()
          }
        });
        
        // Double-check that backups are still enabled
        if (!currentSettings.enabled) {
          logger.warn('Scheduled backup cancelled - backups disabled', {
            category: 'backup',
            data: {
              function: 'scheduleNextBackup',
              enabled: currentSettings.enabled,
              serverPath
            }
          });
          return;
        }

        const now = new Date();
        const startTime = Date.now();
        
        const result = await backupService.safeCreateBackup({
          serverPath,
          type: currentSettings.type || 'world',
          trigger: 'auto'
        });
        
        const duration = Date.now() - startTime;
        
        // Update last run time
        const updatedSettings = { ...currentSettings, lastRun: now.toISOString() };
        appStore.set('backupSettings', updatedSettings);
        
        logger.info('Scheduled backup completed successfully', {
          category: 'performance',
          data: {
            function: 'scheduleNextBackup',
            duration,
            backupName: result?.name,
            backupSize: result?.size,
            type: currentSettings.type,
            trigger: 'auto',
            serverPath
          }
        });
        
        // Apply retention policy
        if (currentSettings.retentionCount) {
          logger.debug('Applying retention policy for scheduled backup', {
            category: 'backup',
            data: {
              function: 'scheduleNextBackup',
              retentionCount: currentSettings.retentionCount,
              serverPath
            }
          });
          await backupService.cleanupAutomaticBackups(serverPath, currentSettings.retentionCount);
        }
        
        safeSend('backup-notification', {
          success: true,
          message: `✅ ${currentSettings.type === 'full' ? 'Full' : 'World-only'} auto-backup created at ${now.toLocaleString()}`
        });

        // Schedule the next backup
        logger.debug('Scheduling next automated backup after successful completion', {
          category: 'backup',
          data: {
            function: 'scheduleNextBackup',
            serverPath
          }
        });
        scheduleNextBackup();
        
      } catch (err) {
        logger.error(`Scheduled backup failed: ${err.message}`, {
          category: 'backup',
          data: {
            function: 'scheduleNextBackup',
            errorType: err.constructor.name,
            serverPath,
            trigger: 'auto',
            formattedError: formatErrorMessage(err)
          }
        });
        
        safeSend('backup-notification', {
          success: false,
          message: `⚠️ Failed to create scheduled backup: ${formatErrorMessage(err)}`
        });
        
        // Schedule the next backup even if this one failed
        logger.debug('Scheduling next automated backup after failure', {
          category: 'backup',
          data: {
            function: 'scheduleNextBackup',
            serverPath,
            previousAttemptFailed: true
          }
        });
        scheduleNextBackup();
      }
    }, msUntilNextRun);
  }

  // Start the scheduling
  logger.debug('Starting backup scheduler', {
    category: 'backup',
    data: {
      function: 'startAutomatedBackups',
      serverPath
    }
  });
  scheduleNextBackup();
}

/**
 * Unified function to initialize the backup manager
 * This replaces both initializeAutomatedBackups and loadBackupManager
 */
function loadBackupManager() {
  logger.info('Loading backup manager', {
    category: 'backup',
    data: {
      function: 'loadBackupManager',
      alreadyInitialized: backupManagerInitialized
    }
  });

  // Prevent double initialization
  if (backupManagerInitialized) {
    logger.debug('Backup manager already initialized, skipping', {
      category: 'backup',
      data: { function: 'loadBackupManager' }
    });
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
  
  logger.debug('Backup settings loaded', {
    category: 'settings',
    data: {
      function: 'loadBackupManager',
      enabled: settings.enabled,
      frequency: settings.frequency,
      type: settings.type,
      retentionCount: settings.retentionCount,
      runOnLaunch: settings.runOnLaunch,
      hasLastRun: !!settings.lastRun
    }
  });
  
  // Get server path
  const serverSettings = appStore.get('serverSettings') || {};
  const lastServerPath = appStore.get('lastServerPath');
  const serverPath = serverSettings.path || lastServerPath;
  
  logger.debug('Server path resolved for backup manager', {
    category: 'backup',
    data: {
      function: 'loadBackupManager',
      hasServerPath: !!serverPath,
      hasServerSettings: !!serverSettings.path,
      hasLastServerPath: !!lastServerPath
    }
  });
  
  if (!serverPath) {
    logger.warn('No server path available for backup manager', {
      category: 'backup',
      data: {
        function: 'loadBackupManager',
        serverSettings: Object.keys(serverSettings),
        hasLastServerPath: !!lastServerPath
      }
    });
    return; // No server path available
  }
  
  // Start automated backups if enabled
  if (settings.enabled) {
    logger.info('Starting automated backups from backup manager', {
      category: 'backup',
      data: {
        function: 'loadBackupManager',
        serverPath,
        frequency: settings.frequency,
        type: settings.type
      }
    });
    startAutomatedBackups(settings, serverPath);
  } else {
    logger.debug('Automated backups not enabled', {
      category: 'backup',
      data: {
        function: 'loadBackupManager',
        enabled: settings.enabled
      }
    });
  }
  
  // Handle app-launch backup if enabled
  if (settings.runOnLaunch) {
    logger.info('App-launch backup enabled, checking world directories', {
      category: 'backup',
      data: {
        function: 'loadBackupManager',
        serverPath,
        type: settings.type
      }
    });

    // Get the getWorldDirs function to check valid worlds
    const getWorldDirs = require('../services/backup-service.cjs').getWorldDirs;
    
    // Check if we have valid world directories
    const worldDirs = getWorldDirs(serverPath);
    
    logger.debug('World directories check completed', {
      category: 'backup',
      data: {
        function: 'loadBackupManager',
        worldDirCount: worldDirs?.length || 0,
        hasValidWorlds: worldDirs && worldDirs.length > 0,
        serverPath
      }
    });

    if (worldDirs && worldDirs.length > 0) {
      logger.info('Scheduling app-launch backup with delay', {
        category: 'backup',
        data: {
          function: 'loadBackupManager',
          delayMs: 3000,
          worldDirCount: worldDirs.length,
          type: settings.type
        }
      });

      // Run the backup with a delay to ensure app is fully loaded
      setTimeout(async () => {
        const startTime = Date.now();
        
        try {
          logger.info('Executing app-launch backup', {
            category: 'backup',
            data: {
              function: 'loadBackupManager',
              trigger: 'app-launch',
              type: settings.type,
              serverPath
            }
          });

          const result = await backupService.safeCreateBackup({
            serverPath,
            type: settings.type || 'world',
            trigger: 'app-launch'
          });
          
          const duration = Date.now() - startTime;
          
          // Update last run time
          const updatedSettings = { ...settings, lastRun: new Date().toISOString() };
          appStore.set('backupSettings', updatedSettings);
          
          logger.info('App-launch backup completed successfully', {
            category: 'performance',
            data: {
              function: 'loadBackupManager',
              duration,
              backupName: result?.name,
              backupSize: result?.size,
              type: settings.type,
              trigger: 'app-launch'
            }
          });
          
          // Apply retention policy
          if (settings.retentionCount) {
            logger.debug('Applying retention policy for app-launch backup', {
              category: 'backup',
              data: {
                function: 'loadBackupManager',
                retentionCount: settings.retentionCount,
                serverPath
              }
            });
            await backupService.cleanupAutomaticBackups(serverPath, settings.retentionCount);
          }
          
          // Send notification
          safeSend('backup-notification', {
            success: true,
            message: `✅ Auto-backup on application launch completed at ${new Date().toLocaleTimeString()}`
          });
        } catch (err) {
          const duration = Date.now() - startTime;
          
          logger.error(`App-launch backup failed: ${err.message}`, {
            category: 'backup',
            data: {
              function: 'loadBackupManager',
              errorType: err.constructor.name,
              duration,
              serverPath,
              type: settings.type,
              trigger: 'app-launch',
              formattedError: formatErrorMessage(err)
            }
          });

          // Send notification
          safeSend('backup-notification', {
            success: false,
            message: `⚠️ Auto-backup on launch failed: ${formatErrorMessage(err)}`
          });
        }
      }, 3000);
    } else {
      logger.warn('App-launch backup skipped - no valid world directories', {
        category: 'backup',
        data: {
          function: 'loadBackupManager',
          serverPath,
          worldDirCount: worldDirs?.length || 0
        }
      });

      safeSend('backup-notification', {
        success: false,
        message: `⚠️ Auto-backup on launch skipped: No valid world directories found`
      });
    }
  } else {
    logger.debug('App-launch backup not enabled', {
      category: 'backup',
      data: {
        function: 'loadBackupManager',
        runOnLaunch: settings.runOnLaunch
      }
    });
  }

  logger.info('Backup manager loaded successfully', {
    category: 'backup',
    data: {
      function: 'loadBackupManager',
      automatedBackupsEnabled: settings.enabled,
      appLaunchBackupEnabled: settings.runOnLaunch,
      serverPath
    }
  });
}

/**
 * Clear backup intervals for app shutdown
 */
function clearBackupIntervals() {
  logger.info('Clearing backup intervals for shutdown', {
    category: 'backup',
    data: {
      function: 'clearBackupIntervals',
      hadActiveTimeout: !!autoBackupTimeoutId,
      wasInitialized: backupManagerInitialized
    }
  });

  if (autoBackupTimeoutId) {
    logger.debug('Clearing active backup timeout', {
      category: 'backup',
      data: { function: 'clearBackupIntervals' }
    });
    clearTimeout(autoBackupTimeoutId);
    autoBackupTimeoutId = null;
  }
  
  // Reset initialization flag
  backupManagerInitialized = false;
  
  logger.debug('Backup intervals cleared successfully', {
    category: 'backup',
    data: { function: 'clearBackupIntervals' }
  });
}

module.exports = { createBackupHandlers, loadBackupManager, clearBackupIntervals };
