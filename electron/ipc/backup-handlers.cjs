const backupService = require('../services/backup-service.cjs');
const appStore = require('../utils/app-store.cjs');
const { safeSend } = require('../utils/safe-send.cjs');
const path = require('path');
const fs = require('fs');
const { getLoggerHandlers } = require('./logger-handlers.cjs');

// Enhanced backup size tracking system
class BackupSizeTracker {
  constructor() {
    this.sizeCache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes cache TTL
    this.watchers = new Map();
    this.alertThresholds = {
      warning: 0.8, // 80% of limit
      critical: 0.95 // 95% of limit
    };
  }

  // Get cached size or calculate if not cached/expired with enhanced error handling
  async getBackupSize(backupPath, forceRecalculate = false, retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 500;
    const cacheKey = backupPath;

    try {
      const cached = this.sizeCache.get(cacheKey);

      if (!forceRecalculate && cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
        return cached.size;
      }

      const stats = await fs.promises.stat(backupPath);
      const size = stats.size;

      // Validate size is reasonable
      if (size < 0) {
        throw new Error('Invalid file size returned');
      }

      // Cache the result
      this.sizeCache.set(cacheKey, {
        size,
        timestamp: Date.now()
      });

      return size;
    } catch (error) {
      const errorMessage = error.message || String(error);

      // Check if this is a retryable error
      if (retryCount < MAX_RETRIES && this.isRetryableError(errorMessage)) {
        logger.warn(`Backup size calculation failed (attempt ${retryCount + 1}/${MAX_RETRIES + 1}): ${errorMessage}. Retrying...`, {
          category: 'backup',
          data: {
            backupPath,
            retryCount,
            error: errorMessage
          }
        });

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));

        return this.getBackupSize(backupPath, forceRecalculate, retryCount + 1);
      }

      logger.error('Failed to get backup size after retries', {
        category: 'backup',
        data: {
          backupPath,
          retryCount,
          error: errorMessage,
          errorCode: (error && error['code']) || 'unknown'
        }
      });

      // Try to get cached value as fallback
      const cached = this.sizeCache.get(cacheKey);
      if (cached) {
        logger.warn('Using cached backup size as fallback', {
          category: 'backup',
          data: {
            backupPath,
            cachedSize: cached.size,
            cacheAge: Date.now() - cached.timestamp
          }
        });
        return cached.size;
      }

      // Return 0 as last resort
      return 0;
    }
  }

  // Check if an error is retryable (temporary file system issues)
  isRetryableError(errorMessage) {
    const retryablePatterns = [
      'EBUSY',
      'EMFILE',
      'ENFILE',
      'EAGAIN',
      'ENOENT',
      'EPERM',
      'EACCES',
      'temporarily unavailable',
      'resource temporarily unavailable',
      'too many open files',
      'file is locked',
      'access denied',
      'permission denied'
    ];

    const lowerMessage = errorMessage.toLowerCase();
    return retryablePatterns.some(pattern => lowerMessage.includes(pattern.toLowerCase()));
  }

  // Calculate total size of all backups with enhanced error handling and caching optimization
  async calculateTotalSize(serverPath, forceRecalculate = false) {
    const errors = [];
    let partialFailure = false;

    try {
      if (!serverPath || typeof serverPath !== 'string') {
        throw new Error('Invalid server path provided');
      }

      const backupDir = path.join(serverPath, 'backups');

      // Check if backup directory exists, create if needed
      try {
        if (!fs.existsSync(backupDir)) {
          logger.info('Backup directory does not exist, creating it', {
            category: 'backup',
            data: { backupDir }
          });
          fs.mkdirSync(backupDir, { recursive: true });
          return { totalSize: 0, backupCount: 0, cached: false };
        }
      } catch (dirError) {
        logger.error('Failed to access or create backup directory', {
          category: 'backup',
          data: {
            backupDir,
            error: dirError.message
          }
        });
        throw new Error(`Cannot access backup directory: ${dirError.message}`);
      }

      let backupFiles;
      try {
        backupFiles = fs.readdirSync(backupDir)
          .filter(file => file.endsWith('.zip'))
          .map(file => path.join(backupDir, file));
      } catch (readError) {
        logger.error('Failed to read backup directory', {
          category: 'backup',
          data: {
            backupDir,
            error: readError.message
          }
        });
        throw new Error(`Cannot read backup directory: ${readError.message}`);
      }

      if (backupFiles.length === 0) {
        return { totalSize: 0, backupCount: 0, cached: false };
      }

      let totalSize = 0;
      let cachedCount = 0;
      let successCount = 0;

      // Process backups with individual error handling
      const sizePromises = backupFiles.map(async (backupPath) => {
        try {
          const size = await this.getBackupSize(backupPath, forceRecalculate);
          if (!forceRecalculate && this.sizeCache.has(backupPath)) {
            cachedCount++;
          }
          successCount++;
          return size;
        } catch (sizeError) {
          const fileName = path.basename(backupPath);
          errors.push({
            file: fileName,
            error: sizeError.message
          });
          partialFailure = true;

          logger.warn('Failed to get size for individual backup', {
            category: 'backup',
            data: {
              backupPath: fileName,
              error: sizeError.message
            }
          });

          return 0; // Return 0 for failed backups to continue calculation
        }
      });

      const sizes = await Promise.all(sizePromises);
      totalSize = sizes.reduce((sum, size) => sum + (typeof size === 'number' ? size : 0), 0);

      const result = {
        totalSize,
        backupCount: backupFiles.length,
        cached: cachedCount > 0,
        successCount,
        partialFailure,
        errors: errors.length > 0 ? errors : undefined
      };

      if (partialFailure) {
        logger.warn('Total backup size calculated with partial failures', {
          category: 'backup',
          data: {
            serverPath,
            totalSize,
            backupCount: backupFiles.length,
            successCount,
            failedCount: errors.length,
            cachedResults: cachedCount,
            forceRecalculate
          }
        });
      } else {
        logger.debug('Total backup size calculated successfully', {
          category: 'backup',
          data: {
            serverPath,
            totalSize,
            backupCount: backupFiles.length,
            cachedResults: cachedCount,
            forceRecalculate
          }
        });
      }

      return result;
    } catch (error) {
      logger.error('Critical failure in total backup size calculation', {
        category: 'backup',
        data: {
          serverPath,
          error: error.message,
          errorCode: (error && error['code']) || 'unknown'
        }
      });

      return {
        totalSize: 0,
        backupCount: 0,
        cached: false,
        error: error.message,
        criticalFailure: true
      };
    }
  }

  // Invalidate cache for specific backup or all backups
  invalidateCache(backupPath = null) {
    if (backupPath) {
      this.sizeCache.delete(backupPath);
    } else {
      this.sizeCache.clear();
    }
  }

  // Setup file system watcher for backup directory with enhanced error handling
  setupSizeWatcher(serverPath, callback, retryCount = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 1000;
    const backupDir = path.join(serverPath, 'backups');

    try {
      // Clean up existing watcher if present
      if (this.watchers.has(serverPath)) {
        try {
          this.watchers.get(serverPath).close();
        } catch (closeError) {
          logger.warn('Error closing existing watcher', {
            category: 'backup',
            data: {
              serverPath,
              error: closeError.message
            }
          });
        }
        this.watchers.delete(serverPath);
      }

      // Ensure backup directory exists
      try {
        if (!fs.existsSync(backupDir)) {
          fs.mkdirSync(backupDir, { recursive: true });
          logger.info('Created backup directory for watcher', {
            category: 'backup',
            data: { backupDir }
          });
        }
      } catch (dirError) {
        throw new Error(`Cannot create backup directory: ${dirError.message}`);
      }

      // Create watcher with error handling
      const watcher = fs.watch(backupDir, { persistent: false }, (eventType, filename) => {
        try {
          if (filename && filename.endsWith('.zip')) {
            const backupPath = path.join(backupDir, filename);

            // Invalidate cache for this specific backup
            this.invalidateCache(backupPath);

            logger.debug('Backup directory change detected', {
              category: 'backup',
              data: {
                serverPath,
                eventType,
                filename,
                backupDir
              }
            });

            // Notify callback about the change with error handling
            if (callback && typeof callback === 'function') {
              try {
                callback({
                  serverPath,
                  eventType,
                  filename,
                  timestamp: new Date().toISOString()
                });
              } catch (callbackError) {
                logger.error('Error in watcher callback', {
                  category: 'backup',
                  data: {
                    serverPath,
                    filename,
                    error: callbackError.message
                  }
                });
              }
            }
          }
        } catch (watcherError) {
          logger.error('Error in file system watcher event handler', {
            category: 'backup',
            data: {
              serverPath,
              eventType,
              filename,
              error: watcherError.message
            }
          });
        }
      });

      // Handle watcher errors
      watcher.on('error', (watchError) => {
        logger.error('File system watcher error', {
          category: 'backup',
          data: {
            serverPath,
            backupDir,
            error: watchError.message,
            errorCode: (watchError && watchError['code']) || 'unknown'
          }
        });

        // Try to restart the watcher if it's a recoverable error
        if (retryCount < MAX_RETRIES && this.isRetryableError(watchError.message)) {
          logger.info(`Attempting to restart file system watcher (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`, {
            category: 'backup',
            data: { serverPath }
          });

          setTimeout(() => {
            try {
              this.setupSizeWatcher(serverPath, callback, retryCount + 1);
            } catch (retryError) {
              logger.error('Failed to restart file system watcher', {
                category: 'backup',
                data: {
                  serverPath,
                  error: retryError.message
                }
              });
            }
          }, RETRY_DELAY_MS * (retryCount + 1));
        }
      });

      this.watchers.set(serverPath, watcher);

      logger.info('Backup size watcher setup successfully', {
        category: 'backup',
        data: {
          serverPath,
          backupDir,
          retryCount
        }
      });

      return watcher;
    } catch (error) {
      const errorMessage = error.message || String(error);

      // Retry for certain types of errors
      if (retryCount < MAX_RETRIES && this.isRetryableError(errorMessage)) {
        logger.warn(`Watcher setup failed (attempt ${retryCount + 1}/${MAX_RETRIES + 1}): ${errorMessage}. Retrying...`, {
          category: 'backup',
          data: {
            serverPath,
            retryCount,
            error: errorMessage
          }
        });

        setTimeout(() => {
          try {
            return this.setupSizeWatcher(serverPath, callback, retryCount + 1);
          } catch (retryError) {
            logger.error('Retry failed for watcher setup', {
              category: 'backup',
              data: {
                serverPath,
                error: retryError.message
              }
            });
          }
        }, RETRY_DELAY_MS * (retryCount + 1));

        return null; // Return null to indicate setup is pending
      }

      logger.error('Failed to setup backup size watcher after retries', {
        category: 'backup',
        data: {
          serverPath,
          retryCount,
          error: errorMessage
        }
      });

      throw new Error(`Cannot setup file system watcher: ${errorMessage}`);
    }
  }

  // Check if backup size exceeds thresholds and send alerts
  async checkSizeAlerts(serverPath, maxSizeBytes) {
    if (!maxSizeBytes || maxSizeBytes <= 0) {
      return { alerts: [] };
    }

    const { totalSize } = await this.calculateTotalSize(serverPath);
    const alerts = [];

    const warningThreshold = maxSizeBytes * this.alertThresholds.warning;
    const criticalThreshold = maxSizeBytes * this.alertThresholds.critical;

    if (totalSize >= criticalThreshold) {
      alerts.push({
        level: 'critical',
        message: `Backup storage is at ${Math.round((totalSize / maxSizeBytes) * 100)}% of limit`,
        totalSize,
        maxSize: maxSizeBytes,
        percentage: (totalSize / maxSizeBytes) * 100
      });
    } else if (totalSize >= warningThreshold) {
      alerts.push({
        level: 'warning',
        message: `Backup storage is at ${Math.round((totalSize / maxSizeBytes) * 100)}% of limit`,
        totalSize,
        maxSize: maxSizeBytes,
        percentage: (totalSize / maxSizeBytes) * 100
      });
    }

    return { alerts, totalSize, maxSize: maxSizeBytes };
  }

  // Cleanup watchers
  cleanup() {
    this.watchers.forEach((watcher, serverPath) => {
      try {
        watcher.close();
      } catch (error) {
        logger.error('Error closing backup watcher', {
          category: 'backup',
          data: {
            serverPath,
            error: error.message
          }
        });
      }
    });
    this.watchers.clear();
    this.sizeCache.clear();
  }
}

// Global instance of the backup size tracker
const backupSizeTracker = new BackupSizeTracker();

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

// Helper to format bytes into human-readable size string
function formatSizeBytes(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) {
    return '0 B';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  // Ensure we don't exceed the sizes array
  const sizeIndex = Math.min(i, sizes.length - 1);
  const formattedValue = parseFloat((bytes / Math.pow(k, sizeIndex)).toFixed(2));

  return `${formattedValue} ${sizes[sizeIndex]}`;
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

        // Apply retention policy if it's an automated backup (scheduled, app launch, or manual-auto)
        if (trigger === 'auto' || trigger === 'app-launch' || trigger === 'manual-auto') {
          const backupSettings = appStore.get('backupSettings') || {};
          // Preload advanced settings to decide whether to skip legacy retention
            const advKeyPre = `retentionSettings_${Buffer.from(serverPath).toString('base64')}`;
            const advPre = appStore.get(advKeyPre);
            const advancedEnabled = !!(advPre && (advPre.sizeRetentionEnabled || advPre.ageRetentionEnabled || advPre.countRetentionEnabled));

          // Fix for users with old low retention counts - upgrade to 100 if it's too low
          let retentionCount = backupSettings.retentionCount;
          if (retentionCount && retentionCount < 50) {
            retentionCount = 100;
            // Update the stored setting
            const updatedSettings = { ...backupSettings, retentionCount: 100 };
            appStore.set('backupSettings', updatedSettings);
            logger.info('Upgraded low retention count to prevent unwanted backup deletion', {
              category: 'backup',
              data: {
                handler: 'backups:safe-create',
                oldRetentionCount: backupSettings.retentionCount,
                newRetentionCount: 100
              }
            });
          }

          if (retentionCount && !advancedEnabled) {
            logger.debug('Applying retention policy for automated backup', {
              category: 'backup',
              data: {
                handler: 'backups:safe-create',
                retentionCount: retentionCount,
                trigger,
                serverPath
              }
            });
            await backupService.cleanupAutomaticBackups(serverPath, retentionCount);
          } else if (retentionCount && advancedEnabled) {
            logger.debug('Skipping legacy retentionCount cleanup because advanced retention rules are active', {
              category: 'backup',
              data: { handler: 'backups:safe-create', retentionCount, advancedEnabled }
            });
          }

          // Also apply the new advanced retention policy (maxSize / maxAge / maxCount) if configured
          try {
            const adv = advPre; // reuse preloaded settings
            logger.debug('Loaded advanced retention settings for automated backup (post-backup)', {
              category: 'backup',
              data: { handler: 'backups:safe-create', serverPath, advPresent: !!adv, adv }
            });
            if (adv && (adv.sizeRetentionEnabled || adv.ageRetentionEnabled || adv.countRetentionEnabled)) {
              // Lazy-load utilities we need (avoid top-level require cost if not used)
              let convertSizeToBytes, convertAgeToMs, RetentionPolicy;
              try {
                ({ RetentionPolicy } = require('../utils/retention-policy.cjs'));
              } catch (e) {
                logger.debug('Could not load RetentionPolicy module for advanced retention (auto)', {
                  category: 'backup',
                  data: { handler: 'backups:safe-create', error: e.message }
                });
              }
              // Basic converters (mirror frontend logic) if not provided elsewhere
              convertSizeToBytes = (value, unit) => {
                const n = Number(value) || 0;
                switch ((unit || '').toLowerCase()) {
                  case 'kb': return n * 1024;
                  case 'mb': return n * 1024 * 1024;
                  case 'gb': return n * 1024 * 1024 * 1024;
                  default: return n; // bytes
                }
              };
              convertAgeToMs = (value, unit) => {
                const n = Number(value) || 0;
                switch ((unit || '').toLowerCase()) {
                  case 'minutes': return n * 60 * 1000;
                  case 'hours': return n * 60 * 60 * 1000;
                  case 'days': return n * 24 * 60 * 60 * 1000;
                  case 'weeks': return n * 7 * 24 * 60 * 60 * 1000;
                  default: return n; // ms
                }
              };
              const policy = {
                maxSize: adv.sizeRetentionEnabled ? convertSizeToBytes(adv.maxSizeValue, adv.maxSizeUnit) : null,
                maxAge: adv.ageRetentionEnabled ? convertAgeToMs(adv.maxAgeValue, adv.maxAgeUnit) : null,
                maxCount: adv.countRetentionEnabled ? adv.maxCountValue : null,
                preserveRecent: 1
              };
              logger.debug('Applying advanced retention policy after automated backup', {
                category: 'backup',
                data: { handler: 'backups:safe-create', serverPath, policy }
              });
              // Reuse existing engine
              let retentionEngine = null;
              if (RetentionPolicy) {
                try {
                  retentionEngine = new RetentionPolicy({
                    maxSize: policy.maxSize,
                    maxAge: policy.maxAge,
                    maxCount: policy.maxCount,
                    preserveRecent: policy.preserveRecent
                  });
                } catch (rpErr) {
                  logger.warn('Advanced retention policy invalid; skipping', {
                    category: 'backup',
                    data: { handler: 'backups:safe-create', error: rpErr.message }
                  });
                }
              }
              const backups = await backupService.listBackupsWithMetadata(serverPath);
              logger.debug('Advanced retention evaluation input (auto)', {
                category: 'backup',
                data: { handler: 'backups:safe-create', backupCount: backups?.length }
              });
              const toDelete = retentionEngine ? await retentionEngine.evaluateBackups(backups) : [];
              logger.debug('Advanced retention evaluation output (auto)', {
                category: 'backup',
                data: { handler: 'backups:safe-create', toDeleteCount: toDelete.length, names: toDelete.map(b=>b.name) }
              });
              if (toDelete.length) {
                logger.info('Advanced retention deleting backups (auto)', {
                  category: 'backup',
                  data: { handler: 'backups:safe-create', deleteCount: toDelete.length }
                });
                for (const b of toDelete) {
                  try {
                    await backupService.deleteBackup({ serverPath, name: b.name });
                  } catch (delErr) {
                    logger.warn('Failed to delete backup during advanced retention (auto)', {
                      category: 'backup',
                      data: { handler: 'backups:safe-create', name: b.name, error: delErr.message }
                    });
                  }
                }
              } else {
                logger.debug('Advanced retention found nothing to delete (auto)', {
                  category: 'backup', data: { handler: 'backups:safe-create' }
                });
              }
            }
            else {
              logger.debug('Advanced retention skipped: no settings or rules enabled', {
                category: 'backup',
                data: { handler: 'backups:safe-create', serverPath, advPresent: !!adv }
              });
            }
          } catch (advErr) {
            logger.error('Failed applying advanced retention after auto backup', {
              category: 'backup',
              data: { handler: 'backups:safe-create', error: advErr.message }
            });
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
          retentionCount: 100,  // keep last 100 automated backups (high default to avoid unwanted deletion)
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
          // Fix for users with old low retention counts - upgrade to 100 if it's too low
          let retentionCount = settings.retentionCount;
          if (retentionCount && retentionCount < 50) {
            retentionCount = 100;
            // Update the stored setting
            const updatedSettings = { ...settings, retentionCount: 100 };
            appStore.set('backupSettings', updatedSettings);
            logger.info('Upgraded low retention count to prevent unwanted backup deletion', {
              category: 'backup',
              data: {
                handler: 'backups:run-immediate-auto',
                oldRetentionCount: settings.retentionCount,
                newRetentionCount: 100
              }
            });
          }

          logger.debug('Applying retention policy for immediate auto-backup', {
            category: 'backup',
            data: {
              handler: 'backups:run-immediate-auto',
              retentionCount: retentionCount,
              serverPath
            }
          });
          await backupService.cleanupAutomaticBackups(serverPath, retentionCount);
        }

        // Apply advanced retention (new engine) for manual-auto trigger
        try {
          const retentionKey = `retentionSettings_${Buffer.from(serverPath).toString('base64')}`;
            const adv = appStore.get(retentionKey);
            logger.debug('Loaded advanced retention settings (manual-auto)', { category: 'backup', data: { handler: 'backups:run-immediate-auto', serverPath, advPresent: !!adv, adv } });
            if (adv && (adv.sizeRetentionEnabled || adv.ageRetentionEnabled || adv.countRetentionEnabled)) {
              let RetentionPolicy;
              try { ({ RetentionPolicy } = require('../utils/retention-policy.cjs')); } catch (e) {
                logger.debug('Could not load RetentionPolicy module for advanced retention (manual-auto)', {
                  category: 'backup', data: { handler: 'backups:run-immediate-auto', error: e.message }
                });
              }
              const convertSizeToBytes = (value, unit) => {
                const n = Number(value) || 0; const u = (unit||'').toLowerCase();
                return u === 'kb' ? n*1024 : u === 'mb' ? n*1024*1024 : u === 'gb' ? n*1024*1024*1024 : n;
              };
              const convertAgeToMs = (value, unit) => {
                const n = Number(value) || 0; const u = (unit||'').toLowerCase();
                switch (u) { case 'minutes': return n*60*1000; case 'hours': return n*60*60*1000; case 'days': return n*24*60*60*1000; case 'weeks': return n*7*24*60*60*1000; default: return n; }
              };
              const policy = {
                maxSize: adv.sizeRetentionEnabled ? convertSizeToBytes(adv.maxSizeValue, adv.maxSizeUnit) : null,
                maxAge: adv.ageRetentionEnabled ? convertAgeToMs(adv.maxAgeValue, adv.maxAgeUnit) : null,
                maxCount: adv.countRetentionEnabled ? adv.maxCountValue : null,
                preserveRecent: 1
              };
              logger.debug('Applying advanced retention policy after manual-auto backup', {
                category: 'backup', data: { handler: 'backups:run-immediate-auto', serverPath, policy }
              });
              let retentionEngine = null;
              if (RetentionPolicy) {
                try { retentionEngine = new RetentionPolicy(policy); } catch (rpErr) {
                  logger.warn('Advanced retention invalid (manual-auto); skipping', { category: 'backup', data: { handler: 'backups:run-immediate-auto', error: rpErr.message } });
                }
              }
              const backups = await backupService.listBackupsWithMetadata(serverPath);
              logger.debug('Advanced retention evaluation input (manual-auto)', { category: 'backup', data: { handler: 'backups:run-immediate-auto', backupCount: backups?.length } });
              const toDelete = retentionEngine ? await retentionEngine.evaluateBackups(backups) : [];
              logger.debug('Advanced retention evaluation output (manual-auto)', { category: 'backup', data: { handler: 'backups:run-immediate-auto', toDeleteCount: toDelete.length, names: toDelete.map(b=>b.name) } });
              if (toDelete.length) {
                logger.info('Advanced retention deleting backups (manual-auto)', { category: 'backup', data: { handler: 'backups:run-immediate-auto', deleteCount: toDelete.length } });
                for (const b of toDelete) {
                  try { await backupService.deleteBackup({ serverPath, name: b.name }); } catch (delErr) {
                    logger.warn('Failed to delete backup during advanced retention (manual-auto)', { category: 'backup', data: { handler: 'backups:run-immediate-auto', name: b.name, error: delErr.message } });
                  }
                }
              } else {
                logger.debug('Advanced retention found nothing to delete (manual-auto)', { category: 'backup', data: { handler: 'backups:run-immediate-auto' } });
              }
            } else {
              logger.debug('Advanced retention skipped: no enabled rules (manual-auto)', { category: 'backup', data: { handler: 'backups:run-immediate-auto', serverPath } });
            }
        } catch (advErr) {
          logger.error('Failed applying advanced retention after manual-auto backup', { category: 'backup', data: { handler: 'backups:run-immediate-auto', error: advErr.message } });
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
    },
    'backups:calculate-sizes': async (_e, { serverPath, forceRecalculate = false }) => {
      const startTime = Date.now();

      logger.info('Backup size calculation requested', {
        category: 'backup',
        data: {
          handler: 'backups:calculate-sizes',
          serverPath,
          forceRecalculate,
          sender: _e.sender.id
        }
      });

      try {
        // Validate parameters
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for backup size calculation', {
            category: 'backup',
            data: {
              handler: 'backups:calculate-sizes',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        // Use enhanced size tracking system
        const sizeResult = await backupSizeTracker.calculateTotalSize(serverPath, forceRecalculate);

        // Get backups with metadata and enhanced size information
        const backups = await backupService.listBackupsWithMetadata(serverPath);

        // Enhance backups with accurate size information using cache
        const backupsWithSizes = await Promise.all(backups.map(async backup => {
          const backupPath = path.join(serverPath, 'backups', backup.name);
          const accurateSize = await backupSizeTracker.getBackupSize(backupPath, forceRecalculate);

          return {
            ...backup,
            size: accurateSize,
            sizeFormatted: formatSizeBytes(accurateSize)
          };
        }));

        const duration = Date.now() - startTime;

        logger.info('Enhanced backup sizes calculated successfully', {
          category: 'performance',
          data: {
            handler: 'backups:calculate-sizes',
            duration,
            success: true,
            backupCount: sizeResult.backupCount,
            totalSize: sizeResult.totalSize,
            totalSizeFormatted: formatSizeBytes(sizeResult.totalSize),
            cached: sizeResult.cached,
            forceRecalculate
          }
        });

        return {
          success: true,
          backups: backupsWithSizes,
          totalSize: sizeResult.totalSize,
          totalSizeFormatted: formatSizeBytes(sizeResult.totalSize),
          backupCount: sizeResult.backupCount,
          cached: sizeResult.cached,
          calculationTime: duration,
          partialFailure: sizeResult.partialFailure,
          errors: sizeResult.errors,
          successCount: sizeResult.successCount,
          warnings: sizeResult.partialFailure ? ['Some backup sizes could not be calculated accurately'] : undefined
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Failed to calculate backup sizes: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:calculate-sizes',
            errorType: err.constructor.name,
            duration,
            serverPath,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },
    'backups:watch-size-changes': async (_e, { serverPath }) => {
      const startTime = Date.now();

      logger.info('Enhanced backup size change watcher setup requested', {
        category: 'backup',
        data: {
          handler: 'backups:watch-size-changes',
          serverPath,
          sender: _e.sender.id
        }
      });

      try {
        // Validate parameters
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for backup size watcher', {
            category: 'backup',
            data: {
              handler: 'backups:watch-size-changes',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        // Setup enhanced size watcher with callback
        const watcher = backupSizeTracker.setupSizeWatcher(serverPath, (changeData) => {
          // Notify the renderer process about the change with enhanced data
          safeSend('backup-size-changed', {
            ...changeData,
            enhanced: true
          });
        });

        const duration = Date.now() - startTime;

        logger.info('Enhanced backup size change watcher setup successfully', {
          category: 'performance',
          data: {
            handler: 'backups:watch-size-changes',
            duration,
            success: true,
            serverPath,
            watcherActive: !!watcher
          }
        });

        return {
          success: true,
          message: 'Enhanced file system watcher setup successfully',
          enhanced: true
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Failed to setup enhanced backup size watcher: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:watch-size-changes',
            errorType: err.constructor.name,
            duration,
            serverPath,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },
    'backups:apply-retention-policy': async (_e, { serverPath, policy, dryRun = false, batchSize = 5 }) => {
      const startTime = Date.now();

      logger.info('Enhanced retention policy application requested', {
        category: 'backup',
        data: {
          handler: 'backups:apply-retention-policy',
          serverPath,
          dryRun,
          batchSize,
          policy: {
            maxSize: policy?.maxSize,
            maxAge: policy?.maxAge,
            maxCount: policy?.maxCount,
            preserveRecent: policy?.preserveRecent
          }
        }
      });

      try {
        // Enhanced input validation
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for retention policy', {
            category: 'backup',
            data: {
              handler: 'backups:apply-retention-policy',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          return { success: false, error: 'Server path must be a valid string' };
        }

        if (!policy || typeof policy !== 'object') {
          logger.error('Invalid retention policy configuration', {
            category: 'backup',
            data: {
              handler: 'backups:apply-retention-policy',
              policy,
              policyType: typeof policy
            }
          });
          return { success: false, error: 'Retention policy must be a valid object' };
        }

        // Validate batch size
        const requestedBatchSize = parseInt(String(batchSize)) || 5;
        const validBatchSize = Math.max(1, Math.min(20, requestedBatchSize));
        if (validBatchSize !== requestedBatchSize) {
          logger.warn('Batch size adjusted for safety', {
            category: 'backup',
            data: {
              handler: 'backups:apply-retention-policy',
              requestedBatchSize: requestedBatchSize,
              adjustedBatchSize: validBatchSize
            }
          });
        }

        // Import and use the enhanced retention policy engine
        const { RetentionPolicy } = require('../utils/retention-policy.cjs');

        let retentionEngine;
        try {
          retentionEngine = new RetentionPolicy(policy);
        } catch (error) {
          logger.error('Invalid retention policy configuration', {
            category: 'backup',
            data: {
              handler: 'backups:apply-retention-policy',
              error: error.message,
              policy
            }
          });
          return { success: false, error: `Invalid policy configuration: ${error.message}` };
        }

        // Safety check: ensure policy has at least one active rule
        if (!retentionEngine.hasActiveRules()) {
          logger.warn('No active retention rules specified', {
            category: 'backup',
            data: {
              handler: 'backups:apply-retention-policy',
              serverPath,
              policy
            }
          });
          return {
            success: true,
            message: 'No active retention rules - no action taken',
            deletedBackups: [],
            failedDeletions: [],
            spaceSaved: 0,
            totalBackups: 0,
            backupsRemaining: 0
          };
        }

        // Get backups with metadata
        const backups = await backupService.listBackupsWithMetadata(serverPath);

        if (!Array.isArray(backups)) {
          logger.error('Failed to get backups for retention policy', {
            category: 'backup',
            data: {
              handler: 'backups:apply-retention-policy',
              serverPath,
              backupsType: typeof backups
            }
          });
          return { success: false, error: 'Failed to retrieve backups' };
        }

        logger.debug('Retrieved backups for enhanced retention policy', {
          category: 'backup',
          data: {
            handler: 'backups:apply-retention-policy',
            serverPath,
            backupCount: backups.length,
            dryRun
          }
        });

        // Safety check: ensure we have backups to evaluate
        if (backups.length === 0) {
          logger.info('No backups found for retention policy', {
            category: 'backup',
            data: {
              handler: 'backups:apply-retention-policy',
              serverPath
            }
          });
          return {
            success: true,
            message: 'No backups found',
            deletedBackups: [],
            failedDeletions: [],
            spaceSaved: 0,
            totalBackups: 0,
            backupsRemaining: 0
          };
        }

        // Use the enhanced retention policy engine
        const toDelete = await retentionEngine.evaluateBackups(backups);

        logger.info('Enhanced retention policy evaluation completed', {
          category: 'backup',
          data: {
            handler: 'backups:apply-retention-policy',
            serverPath,
            totalBackups: backups.length,
            backupsToDelete: toDelete.length,
            preserveRecent: policy.preserveRecent || 1,
            dryRun
          }
        });

        // If dry run, return what would be deleted without actually deleting
        if (dryRun) {
          const spaceThatWouldBeSaved = toDelete.reduce((sum, backup) => sum + (backup.size || 0), 0);

          logger.info('Dry run completed - no backups deleted', {
            category: 'backup',
            data: {
              handler: 'backups:apply-retention-policy',
              serverPath,
              backupsToDelete: toDelete.length,
              spaceThatWouldBeSaved
            }
          });

          return {
            success: true,
            dryRun: true,
            message: `Dry run: ${toDelete.length} backups would be deleted`,
            backupsToDelete: toDelete.map(b => ({
              name: b.name,
              size: b.size || 0,
              created: b.created,
              reason: 'retention-policy'
            })),
            spaceThatWouldBeSaved,
            totalBackups: backups.length,
            backupsRemaining: backups.length - toDelete.length
          };
        }

        // Execute deletions with batch processing and progress tracking
        const deletionResults = [];
        let spaceSaved = 0;
        let processedCount = 0;

        // Process deletions in batches to avoid overwhelming the system
        for (let i = 0; i < toDelete.length; i += validBatchSize) {
          const batch = toDelete.slice(i, i + validBatchSize);

          logger.debug('Processing retention policy deletion batch', {
            category: 'backup',
            data: {
              handler: 'backups:apply-retention-policy',
              batchNumber: Math.floor(i / validBatchSize) + 1,
              batchSize: batch.length,
              totalBatches: Math.ceil(toDelete.length / validBatchSize),
              processedCount,
              totalToDelete: toDelete.length
            }
          });

          // Process batch with progress tracking
          const batchPromises = batch.map(async (backup) => {
            try {
              const result = await backupService.deleteBackup({ serverPath, name: backup.name });

              if (result.success) {
                const deletionResult = {
                  name: backup.name,
                  success: true,
                  size: backup.size || 0,
                  reason: 'retention-policy',
                  timestamp: new Date().toISOString()
                };

                spaceSaved += backup.size || 0;

                logger.info('Successfully deleted backup via enhanced retention policy', {
                  category: 'backup',
                  data: {
                    handler: 'backups:apply-retention-policy',
                    serverPath,
                    backupName: backup.name,
                    backupSize: backup.size,
                    reason: 'retention-policy',
                    batchProcessing: true
                  }
                });

                return deletionResult;
              } else {
                const deletionResult = {
                  name: backup.name,
                  success: false,
                  error: result.error || 'Unknown error',
                  size: backup.size || 0,
                  reason: 'retention-policy',
                  timestamp: new Date().toISOString()
                };

                logger.error('Failed to delete backup via enhanced retention policy', {
                  category: 'backup',
                  data: {
                    handler: 'backups:apply-retention-policy',
                    serverPath,
                    backupName: backup.name,
                    error: result.error,
                    batchProcessing: true
                  }
                });

                return deletionResult;
              }
            } catch (error) {
              const deletionResult = {
                name: backup.name,
                success: false,
                error: error.message,
                size: backup.size || 0,
                reason: 'retention-policy',
                timestamp: new Date().toISOString()
              };

              logger.error('Exception during enhanced retention policy backup deletion', {
                category: 'backup',
                data: {
                  handler: 'backups:apply-retention-policy',
                  serverPath,
                  backupName: backup.name,
                  error: error.message,
                  batchProcessing: true
                }
              });

              return deletionResult;
            }
          });

          // Wait for batch to complete
          const batchResults = await Promise.all(batchPromises);
          deletionResults.push(...batchResults);
          processedCount += batch.length;

          // Send progress update
          safeSend('retention-policy-progress', {
            serverPath,
            processed: processedCount,
            total: toDelete.length,
            percentage: Math.round((processedCount / toDelete.length) * 100),
            spaceSaved,
            batchCompleted: Math.floor(i / validBatchSize) + 1,
            totalBatches: Math.ceil(toDelete.length / validBatchSize)
          });

          // Small delay between batches to prevent system overload
          if (i + validBatchSize < toDelete.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        const successfulDeletions = deletionResults.filter(r => r.success);
        const failedDeletions = deletionResults.filter(r => !r.success);

        const duration = Date.now() - startTime;

        logger.info('Enhanced retention policy application completed', {
          category: 'performance',
          data: {
            handler: 'backups:apply-retention-policy',
            duration,
            success: true,
            totalBackups: backups.length,
            backupsDeleted: successfulDeletions.length,
            backupsFailed: failedDeletions.length,
            spaceSaved,
            batchSize: validBatchSize,
            totalBatches: Math.ceil(toDelete.length / validBatchSize)
          }
        });

        // Invalidate size cache after deletions
        backupSizeTracker.invalidateCache();

        return {
          success: true,
          deletedBackups: successfulDeletions,
          failedDeletions,
          spaceSaved,
          totalBackups: backups.length,
          backupsRemaining: backups.length - successfulDeletions.length,
          batchProcessed: true,
          batchSize: validBatchSize,
          processingTime: duration
        };

      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Enhanced retention policy application failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:apply-retention-policy',
            errorType: err.constructor.name,
            duration,
            serverPath,
            formattedError,
            dryRun,
            batchSize
          }
        });

        return { success: false, error: formattedError };
      }
    },

    'backups:get-retention-settings': (_e, { serverPath }) => {
      const startTime = Date.now();

      logger.debug('Retention policy settings requested', {
        category: 'backup',
        data: {
          handler: 'backups:get-retention-settings',
          serverPath
        }
      });

      try {
        // Validate server path
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for retention settings', {
            category: 'backup',
            data: {
              handler: 'backups:get-retention-settings',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          return { success: false, error: 'Invalid server path' };
        }

        // Get retention settings from store, with defaults
        const retentionKey = `retentionSettings_${Buffer.from(serverPath).toString('base64')}`;
        const settings = appStore.get(retentionKey) || {
          sizeRetentionEnabled: false,
          maxSizeValue: 10,
          maxSizeUnit: 'GB',
          ageRetentionEnabled: false,
          maxAgeValue: 30,
          maxAgeUnit: 'days',
          countRetentionEnabled: false,
          maxCountValue: 14,
          minBackupsToPreserve: 1
        };

        const duration = Date.now() - startTime;

        logger.debug('Retention policy settings retrieved successfully', {
          category: 'performance',
          data: {
            handler: 'backups:get-retention-settings',
            duration,
            success: true,
            sizeRetentionEnabled: settings.sizeRetentionEnabled,
            ageRetentionEnabled: settings.ageRetentionEnabled,
            countRetentionEnabled: settings.countRetentionEnabled
          }
        });

        return {
          success: true,
          settings
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Failed to get retention policy settings: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:get-retention-settings',
            errorType: err.constructor.name,
            duration,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },

    'backups:save-retention-settings': (_e, { serverPath, settings }) => {
      const startTime = Date.now();

      logger.info('Retention policy settings save requested', {
        category: 'backup',
        data: {
          handler: 'backups:save-retention-settings',
          serverPath,
          sizeRetentionEnabled: settings?.sizeRetentionEnabled,
          ageRetentionEnabled: settings?.ageRetentionEnabled,
          countRetentionEnabled: settings?.countRetentionEnabled
        }
      });

      try {
        // Validate server path
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for retention settings save', {
            category: 'backup',
            data: {
              handler: 'backups:save-retention-settings',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          return { success: false, error: 'Invalid server path' };
        }

        // Validate settings object
        if (!settings || typeof settings !== 'object') {
          logger.error('Invalid settings object for retention policy save', {
            category: 'backup',
            data: {
              handler: 'backups:save-retention-settings',
              settings,
              settingsType: typeof settings
            }
          });
          return { success: false, error: 'Invalid settings object' };
        }

        // Validate individual settings
        const validatedSettings = {
          sizeRetentionEnabled: Boolean(settings.sizeRetentionEnabled),
          maxSizeValue: Math.max(1, parseInt(settings.maxSizeValue) || 10),
          maxSizeUnit: ['GB', 'TB'].includes(settings.maxSizeUnit) ? settings.maxSizeUnit : 'GB',
          ageRetentionEnabled: Boolean(settings.ageRetentionEnabled),
          maxAgeValue: Math.max(1, parseInt(settings.maxAgeValue) || 30),
          maxAgeUnit: ['days', 'weeks', 'months'].includes(settings.maxAgeUnit) ? settings.maxAgeUnit : 'days',
          countRetentionEnabled: Boolean(settings.countRetentionEnabled),
          maxCountValue: Math.max(1, parseInt(settings.maxCountValue) || 14),
          minBackupsToPreserve: Math.max(1, Math.min(10, parseInt(settings.minBackupsToPreserve) || 1))
        };

        // Save to store with server-specific key
        const retentionKey = `retentionSettings_${Buffer.from(serverPath).toString('base64')}`;
        appStore.set(retentionKey, validatedSettings);

        const duration = Date.now() - startTime;

        logger.info('Retention policy settings saved successfully', {
          category: 'performance',
          data: {
            handler: 'backups:save-retention-settings',
            duration,
            success: true,
            validatedSettings
          }
        });

        return { success: true };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Failed to save retention policy settings: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:save-retention-settings',
            errorType: err.constructor.name,
            duration,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },

    // Enhanced backup size tracking handlers
    'backups:get-size-cache-stats': (_e, { serverPath }) => {
      const startTime = Date.now();

      logger.debug('Backup size cache stats requested', {
        category: 'backup',
        data: {
          handler: 'backups:get-size-cache-stats',
          serverPath
        }
      });

      try {
        const cacheSize = backupSizeTracker.sizeCache.size;
        const cacheEntries = Array.from(backupSizeTracker.sizeCache.entries()).map(([key, value]) => ({
          path: key,
          size: value.size,
          timestamp: value.timestamp,
          age: Date.now() - value.timestamp
        }));

        const duration = Date.now() - startTime;

        logger.debug('Backup size cache stats retrieved', {
          category: 'performance',
          data: {
            handler: 'backups:get-size-cache-stats',
            duration,
            cacheSize,
            serverPath
          }
        });

        return {
          success: true,
          cacheSize,
          cacheEntries,
          cacheTTL: backupSizeTracker.cacheTTL
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Failed to get cache stats: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:get-size-cache-stats',
            errorType: err.constructor.name,
            duration,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },

    'backups:invalidate-size-cache': (_e, { serverPath, backupName = null }) => {
      const startTime = Date.now();

      logger.info('Backup size cache invalidation requested', {
        category: 'backup',
        data: {
          handler: 'backups:invalidate-size-cache',
          serverPath,
          backupName
        }
      });

      try {
        if (backupName) {
          const backupPath = path.join(serverPath, 'backups', backupName);
          backupSizeTracker.invalidateCache(backupPath);
        } else {
          backupSizeTracker.invalidateCache();
        }

        const duration = Date.now() - startTime;

        logger.info('Backup size cache invalidated successfully', {
          category: 'performance',
          data: {
            handler: 'backups:invalidate-size-cache',
            duration,
            success: true,
            serverPath,
            backupName,
            scope: backupName ? 'single' : 'all'
          }
        });

        return {
          success: true,
          message: backupName ? `Cache invalidated for ${backupName}` : 'All cache invalidated'
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Failed to invalidate cache: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:invalidate-size-cache',
            errorType: err.constructor.name,
            duration,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },

    'backups:check-size-alerts': async (_e, { serverPath, maxSizeBytes }) => {
      const startTime = Date.now();

      logger.info('Backup size alerts check requested', {
        category: 'backup',
        data: {
          handler: 'backups:check-size-alerts',
          serverPath,
          maxSizeBytes
        }
      });

      try {
        // Validate parameters
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path for size alerts check', {
            category: 'backup',
            data: {
              handler: 'backups:check-size-alerts',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        const alertResult = await backupSizeTracker.checkSizeAlerts(serverPath, maxSizeBytes);
        const duration = Date.now() - startTime;

        logger.info('Backup size alerts checked successfully', {
          category: 'performance',
          data: {
            handler: 'backups:check-size-alerts',
            duration,
            success: true,
            serverPath,
            alertCount: alertResult.alerts.length,
            totalSize: alertResult.totalSize,
            maxSize: alertResult.maxSize
          }
        });

        return {
          success: true,
          ...alertResult
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Failed to check size alerts: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:check-size-alerts',
            errorType: err.constructor.name,
            duration,
            serverPath,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },

    'backups:get-performance-metrics': () => {
      const startTime = Date.now();

      logger.debug('Backup performance metrics requested', {
        category: 'backup',
        data: {
          handler: 'backups:get-performance-metrics'
        }
      });

      try {
        const metrics = backupService.getPerformanceMetrics();
        const duration = Date.now() - startTime;

        logger.debug('Backup performance metrics retrieved', {
          category: 'performance',
          data: {
            handler: 'backups:get-performance-metrics',
            duration,
            success: true,
            backupsCreated: metrics.backupsCreated,
            totalBackupSizeGB: metrics.totalBackupSizeGB,
            cacheEfficiency: metrics.cacheEfficiency
          }
        });

        return {
          success: true,
          metrics
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Failed to get performance metrics: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:get-performance-metrics',
            errorType: err.constructor.name,
            duration,
            formattedError
          }
        });

        return { success: false, error: formattedError };
      }
    },

    'backups:validate-retention-policy': (_e, { policy }) => {
      const startTime = Date.now();

      logger.debug('Retention policy validation requested', {
        category: 'backup',
        data: {
          handler: 'backups:validate-retention-policy',
          policy
        }
      });

      try {
        if (!policy || typeof policy !== 'object') {
          return {
            success: false,
            error: 'Policy must be a valid object',
            valid: false
          };
        }

        // Import and validate using the retention policy engine
        const { RetentionPolicy } = require('../utils/retention-policy.cjs');

        try {
          const retentionEngine = new RetentionPolicy(policy);
          const hasActiveRules = retentionEngine.hasActiveRules();

          const duration = Date.now() - startTime;

          logger.debug('Retention policy validation completed', {
            category: 'performance',
            data: {
              handler: 'backups:validate-retention-policy',
              duration,
              valid: true,
              hasActiveRules
            }
          });

          return {
            success: true,
            valid: true,
            hasActiveRules,
            message: hasActiveRules ? 'Policy is valid and has active rules' : 'Policy is valid but has no active rules',
            policy: {
              maxSize: policy.maxSize,
              maxAge: policy.maxAge,
              maxCount: policy.maxCount,
              preserveRecent: policy.preserveRecent || 1
            }
          };
        } catch (validationError) {
          const duration = Date.now() - startTime;

          logger.warn('Retention policy validation failed', {
            category: 'backup',
            data: {
              handler: 'backups:validate-retention-policy',
              duration,
              error: validationError.message,
              policy
            }
          });

          return {
            success: true,
            valid: false,
            error: validationError.message,
            message: `Policy validation failed: ${validationError.message}`
          };
        }
      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Retention policy validation error: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:validate-retention-policy',
            errorType: err.constructor.name,
            duration,
            formattedError
          }
        });

        return { success: false, error: formattedError, valid: false };
      }
    },

    'backups:preview-retention-policy': async (_e, { serverPath, policy }) => {
      const startTime = Date.now();

      logger.info('Retention policy preview requested', {
        category: 'backup',
        data: {
          handler: 'backups:preview-retention-policy',
          serverPath,
          policy
        }
      });

      try {
        // Validate inputs
        if (!serverPath || typeof serverPath !== 'string') {
          return { success: false, error: 'Server path must be a valid string' };
        }

        if (!policy || typeof policy !== 'object') {
          return { success: false, error: 'Retention policy must be a valid object' };
        }

        // Import and use the retention policy engine
        const { RetentionPolicy } = require('../utils/retention-policy.cjs');

        let retentionEngine;
        try {
          retentionEngine = new RetentionPolicy(policy);
        } catch (error) {
          return { success: false, error: `Invalid policy configuration: ${error.message}` };
        }

        // Get backups with metadata
        const backups = await backupService.listBackupsWithMetadata(serverPath);

        if (!Array.isArray(backups)) {
          return { success: false, error: 'Failed to retrieve backups' };
        }

        if (backups.length === 0) {
          return {
            success: true,
            preview: {
              totalBackups: 0,
              backupsToDelete: [],
              backupsToKeep: [],
              spaceThatWouldBeSaved: 0,
              spaceToKeep: 0,
              hasActiveRules: retentionEngine.hasActiveRules()
            }
          };
        }

        // Use the retention policy engine to evaluate backups
        const toDelete = await retentionEngine.evaluateBackups(backups);
        const toKeep = backups.filter(backup => !toDelete.find(d => d.name === backup.name));

        const spaceThatWouldBeSaved = toDelete.reduce((sum, backup) => sum + (backup.size || 0), 0);
        const spaceToKeep = toKeep.reduce((sum, backup) => sum + (backup.size || 0), 0);

        const duration = Date.now() - startTime;

        logger.info('Retention policy preview completed', {
          category: 'performance',
          data: {
            handler: 'backups:preview-retention-policy',
            duration,
            success: true,
            totalBackups: backups.length,
            backupsToDelete: toDelete.length,
            backupsToKeep: toKeep.length,
            spaceThatWouldBeSaved
          }
        });

        return {
          success: true,
          preview: {
            totalBackups: backups.length,
            backupsToDelete: toDelete.map(backup => ({
              name: backup.name,
              size: backup.size || 0,
              sizeFormatted: formatSizeBytes(backup.size || 0),
              created: backup.created,
              metadata: backup.metadata
            })),
            backupsToKeep: toKeep.map(backup => ({
              name: backup.name,
              size: backup.size || 0,
              sizeFormatted: formatSizeBytes(backup.size || 0),
              created: backup.created,
              metadata: backup.metadata
            })),
            spaceThatWouldBeSaved,
            spaceThatWouldBeSavedFormatted: formatSizeBytes(spaceThatWouldBeSaved),
            spaceToKeep,
            spaceToKeepFormatted: formatSizeBytes(spaceToKeep),
            hasActiveRules: retentionEngine.hasActiveRules(),
            policy: {
              maxSize: policy.maxSize,
              maxAge: policy.maxAge,
              maxCount: policy.maxCount,
              preserveRecent: policy.preserveRecent || 1
            }
          }
        };

      } catch (err) {
        const duration = Date.now() - startTime;
        const formattedError = formatErrorMessage(err);

        logger.error(`Retention policy preview failed: ${err.message}`, {
          category: 'backup',
          data: {
            handler: 'backups:preview-retention-policy',
            errorType: err.constructor.name,
            duration,
            serverPath,
            formattedError
          }
        });

        return { success: false, error: formattedError };
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
  logger.info('Loading enhanced backup manager', {
    category: 'backup',
    data: {
      function: 'loadBackupManager',
      alreadyInitialized: backupManagerInitialized
    }
  });

  // Prevent double initialization
  if (backupManagerInitialized) {
    logger.debug('Enhanced backup manager already initialized, skipping', {
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
    retentionCount: 100,  // keep last 100 automated backups (high default to avoid unwanted deletion)
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
 * Enhanced cleanup function for backup system shutdown
 */
function clearBackupIntervals() {
  logger.info('Clearing enhanced backup system for shutdown', {
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

  // Cleanup enhanced size tracker
  try {
    backupSizeTracker.cleanup();
    logger.debug('Enhanced backup size tracker cleaned up', {
      category: 'backup',
      data: { function: 'clearBackupIntervals' }
    });
  } catch (error) {
    logger.error('Error cleaning up backup size tracker', {
      category: 'backup',
      data: {
        function: 'clearBackupIntervals',
        error: error.message
      }
    });
  }

  // Reset initialization flag
  backupManagerInitialized = false;

  logger.info('Enhanced backup system cleared successfully', {
    category: 'backup',
    data: { function: 'clearBackupIntervals' }
  });
}

module.exports = {
  createBackupHandlers,
  loadBackupManager,
  clearBackupIntervals,
  backupSizeTracker // Export for testing and integration purposes
};
