/// <reference path="../../electron.d.ts" />

/**
 * Backup Size Calculator Utility
 * Provides functions for calculating and formatting backup sizes with performance optimizations
 */

import {
  calculateTotalSizeOptimized,
  addSizeChangeListener,
  invalidateOptimizedCache,
  getPerformanceStats,
  cleanup as cleanupOptimizer,
  fsOptimizer
} from './performanceOptimizer.js';

/**
 * Cache for backup size calculations to improve performance
 */
const sizeCache = new Map();
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Background calculation queue for non-blocking operations
 */
const backgroundQueue = [];
let backgroundProcessing = false;

/**
 * Calculate total size of all backups with comprehensive error handling and performance optimizations
 * @param {Array} backups - Array of backup objects with size property
 * @param {string} serverPath - Server path for optimized calculations
 * @param {Object} options - Calculation options
 * @returns {Promise<number>} Total size in bytes
 */
export async function calculateTotalSize(backups, serverPath = '', options = {}) {
  try {
    if (!Array.isArray(backups)) {
      throw new Error('Backups must be an array');
    }

    const {
      useOptimized = true,
      forceRefresh = false,
      enableBackground = true,
      enableIncremental = true
    } = options;

    // Use optimized calculation if server path is available and optimization is enabled
    if (useOptimized && serverPath) {
      try {
        const result = await calculateTotalSizeOptimized(serverPath, backups, {
          forceRefresh,
          enableBackground,
          enableIncremental
        });
        
        return result.totalSize;
      } catch {
        // Fall through to standard calculation
      }
    }

    // Standard calculation with error handling
  let totalSize = 0;
  const errors = [];

    for (const backup of backups) {
      try {
        if (!backup) {
          continue; // Skip null/undefined backups
        }

        if (typeof backup.size === 'number' && backup.size >= 0) {
          totalSize += backup.size;
        } else if (backup.name && serverPath) {
          // Try to get size from backend if not available
          try {
            const sizeResult = await calculateBackupSizes(serverPath, false);
            const backupWithSize = sizeResult.backups?.find(b => b.name === backup.name);
            if (backupWithSize && typeof backupWithSize.size === 'number' && backupWithSize.size >= 0) {
              totalSize += backupWithSize.size;
            }
          } catch (sizeError) {
            errors.push({
              backup: backup.name || 'unknown',
              error: sizeError.message,
              type: 'size_calculation_failed'
            });
          }
        }
      } catch (backupError) {
        errors.push({
          backup: backup?.name || 'unknown',
          error: backupError.message,
          type: 'backup_processing_failed'
        });
  // Track errors via errors.length
      }
    }

    // Log errors but don't fail the entire calculation
    if (errors.length > 0) {
      // Size calculation encountered errors: ${errorCount}
    }

    return totalSize;
  } catch (error) {
    throw new Error(`Failed to calculate total backup size: ${error.message}`);
  }
}

/**
 * Format bytes into human-readable size string
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string (e.g., "1.5 GB")
 */
export function formatSize(bytes) {
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

/**
 * Get cached size calculation result
 * @param {string} cacheKey - Cache key for the calculation
 * @returns {Object|null} Cached result or null if not found/expired
 */
export function getCachedSize(cacheKey) {
  const cached = sizeCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  
  const now = Date.now();
  if (now - cached.timestamp > CACHE_EXPIRY_MS) {
    sizeCache.delete(cacheKey);
    return null;
  }
  
  return cached.data;
}

/**
 * Cache size calculation result
 * @param {string} cacheKey - Cache key for the calculation
 * @param {any} data - Data to cache
 */
export function setCachedSize(cacheKey, data) {
  sizeCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
}

/**
 * Clear all cached size calculations
 */
export function clearSizeCache() {
  sizeCache.clear();
}

/**
 * Set up file system watcher for backup directory size changes with error handling
 * @param {string} serverPath - Path to the server directory
 * @param {Function} callback - Callback function to call when changes are detected
 * @param {number} retryCount - Number of retry attempts (internal use)
 * @returns {Promise<Function>} Cleanup function to stop watching
 */
export async function watchSizeChanges(serverPath, callback, retryCount = 0) {
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 2000;

  try {
    if (!serverPath || typeof serverPath !== 'string') {
      throw new Error('Server path must be a valid string');
    }
    
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    
    // Set up the backend watcher
    const result = await window.electron.invoke('backups:watch-size-changes', {
      serverPath
    });
    
    if (!result || !result.success) {
      const errorMessage = result?.error || 'Failed to setup file system watcher';
      
      // Retry for certain types of errors
      if (retryCount < MAX_RETRIES && isRetryableError(errorMessage)) {
        // File watcher setup failed, retrying...
        
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        return watchSizeChanges(serverPath, callback, retryCount + 1);
      }
      
      throw new Error(errorMessage);
    }
    
    // Set up event listener for backup size changes with error handling
    const eventHandler = (data) => {
      try {
        if (data && data.serverPath === serverPath) {
          callback(data);
        }
      } catch {
        // Error in size change callback
        // Don't throw here to avoid breaking the watcher
      }
    };
    
    // Register the event listener
    window.electron.on('backup-size-changed', eventHandler);
    

    
    // Return cleanup function with error handling
    return () => {
      try {
        window.electron.removeListener('backup-size-changed', eventHandler);

      } catch {
        // Error cleaning up file system watcher
      }
    };
  } catch {
    // Failed to set up size change watcher
    
    if (retryCount >= MAX_RETRIES) {
      // File system watcher setup failed after all retries, continuing without watcher
      
      // Return a no-op cleanup function
      return () => {

      };
    }
    
    throw new Error(`Failed to setup file system watcher after ${retryCount + 1} attempts`);
  }
}

/**
 * Calculate backup sizes with caching, performance optimizations, and comprehensive error handling
 * @param {string} serverPath - Path to the server directory
 * @param {boolean} forceRefresh - Whether to force refresh cache
 * @param {number} retryCount - Number of retry attempts (internal use)
 * @returns {Promise<Object>} Object containing backups with sizes and total size
 */
export async function calculateBackupSizes(serverPath, forceRefresh = false, retryCount = 0) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 1000;

  try {
    if (!serverPath || typeof serverPath !== 'string') {
      throw new Error('Server path must be a valid string');
    }
    
    const cacheKey = `backup-sizes-${serverPath}`;
    
    // Check cache first unless force refresh is requested
    if (!forceRefresh) {
      const cached = getCachedSize(cacheKey);
      if (cached) {
        return cached;
      }
    }
    
    // Use file system optimizer for better performance
    const result = await fsOptimizer.queueOperation(async () => {
      return await window.electron.invoke('backups:calculate-sizes', { 
        serverPath,
        forceRecalculate: forceRefresh
      });
    });
    
    if (!result) {
      throw new Error('No response received from backend');
    }
    
    if (!result.success) {
      const errorMessage = result.error || 'Failed to calculate backup sizes';
      
      // Check if this is a temporary file system error that might benefit from retry
      if (retryCount < MAX_RETRIES && isRetryableError(errorMessage)) {
        // Size calculation failed, retrying...
        
        // Wait before retrying with exponential backoff
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, retryCount)));
        
        return calculateBackupSizes(serverPath, forceRefresh, retryCount + 1);
      }
      
      throw new Error(errorMessage);
    }
    
    // Validate result structure
    if (!result.backups || !Array.isArray(result.backups)) {
      // Backend returned invalid backup list, using fallback
      result.backups = [];
    }
    
    if (typeof result.totalSize !== 'number') {
      // Backend returned invalid total size, calculating from backup list
      result.totalSize = result.backups.reduce((sum, backup) => {
        return sum + (typeof backup.size === 'number' && backup.size >= 0 ? backup.size : 0);
      }, 0);
    }
    
    // Cache the result with performance metrics
    setCachedSize(cacheKey, {
      ...result,
      cached: false,
      calculationTime: result.calculationTime || 0,
      optimized: true
    });
    
    return result;
  } catch {
    // Failed to calculate backup sizes
    
    // If all retries failed, try to provide fallback size estimation
    if (retryCount >= MAX_RETRIES) {
      // All retry attempts failed, attempting fallback size estimation
      
      try {
        const fallbackResult = await getFallbackSizeEstimation(serverPath);
        return fallbackResult;
      } catch {
        // Fallback size estimation also failed
      }
    }
    
    throw new Error(`Failed to calculate backup sizes after ${retryCount + 1} attempts`);
  }
}

/**
 * Check if an error is retryable (temporary file system issues)
 * @param {string} errorMessage - Error message to check
 * @returns {boolean} True if error might be temporary and worth retrying
 */
function isRetryableError(errorMessage) {
  const retryablePatterns = [
    'EBUSY',
    'EMFILE',
    'ENFILE',
    'EAGAIN',
    'ENOENT',
    'temporarily unavailable',
    'resource temporarily unavailable',
    'too many open files',
    'file is locked',
    'access denied'
  ];
  
  const lowerMessage = errorMessage.toLowerCase();
  return retryablePatterns.some(pattern => lowerMessage.includes(pattern.toLowerCase()));
}

/**
 * Provide fallback size estimation when exact calculation fails
 * @param {string} serverPath - Path to the server directory
 * @returns {Promise<Object>} Fallback result with estimated sizes
 */
async function getFallbackSizeEstimation(serverPath) {
  try {
    // Try to get basic backup list without sizes
    const basicResult = await window.electron.invoke('backups:list', { serverPath });
    
    if (!basicResult || basicResult.error) {
      throw new Error('Cannot access backup directory');
    }
    
    const backups = Array.isArray(basicResult) ? basicResult : [];
    
    // Estimate sizes based on typical backup sizes or use cached values
    const estimatedBackups = backups.map(backup => {
      // Try to get cached size first
      const cachedSize = getCachedSize(`backup-size-${backup.name}`);
      if (cachedSize !== null) {
        return { ...backup, size: cachedSize, estimated: false };
      }
      
      // Fallback to estimation based on backup type and age
      const estimatedSize = estimateBackupSize(backup);
      return { ...backup, size: estimatedSize, estimated: true };
    });
    
    const totalSize = estimatedBackups.reduce((sum, backup) => sum + (backup.size || 0), 0);
    
    // Using fallback size estimation
    
    return {
      success: true,
      backups: estimatedBackups,
      totalSize,
      estimated: true,
      warning: 'Size calculations are estimated due to file system access issues'
    };
  } catch {
    // Last resort: return empty result
    // Fallback size estimation failed
    
    return {
      success: true,
      backups: [],
      totalSize: 0,
      estimated: true,
      error: 'Unable to calculate or estimate backup sizes'
    };
  }
}

/**
 * Estimate backup size based on backup metadata
 * @param {Object} backup - Backup object with metadata
 * @returns {number} Estimated size in bytes
 */
function estimateBackupSize(backup) {
  // Default estimates based on backup type and age
  const DEFAULT_WORLD_SIZE = 50 * 1024 * 1024; // 50MB
  const DEFAULT_FULL_SIZE = 200 * 1024 * 1024; // 200MB
  
  if (!backup || !backup.metadata) {
    return DEFAULT_WORLD_SIZE;
  }
  
  // Estimate based on backup type
  if (backup.metadata.type === 'full') {
    return DEFAULT_FULL_SIZE;
  } else {
    return DEFAULT_WORLD_SIZE;
  }
}

/**
 * Invalidate cache for a specific server path with optimized cache clearing
 * @param {string} serverPath - Path to the server directory
 */
export function invalidateSizeCache(serverPath) {
  if (!serverPath) {
    // Clear all caches
    sizeCache.clear();
    invalidateOptimizedCache();
    return;
  }
  
  const cacheKey = `backup-sizes-${serverPath}`;
  sizeCache.delete(cacheKey);
  
  // Also invalidate optimized cache
  invalidateOptimizedCache(serverPath);
}

/**
 * Create user-friendly error messages for size calculation failures
 * @param {Error} error - The original error
 * @param {string} context - Context where the error occurred
 * @returns {string} User-friendly error message
 */
export function createSizeCalculationErrorMessage(error, context = 'size calculation') {
  if (!error) {
    return `Unknown error occurred during ${context}`;
  }
  
  const message = error.message || String(error);
  const lowerMessage = message.toLowerCase();
  
  // File system access errors
  if (lowerMessage.includes('enoent') || lowerMessage.includes('not found')) {
    return 'Some backup files could not be found. They may have been moved or deleted.';
  }
  
  if (lowerMessage.includes('eacces') || lowerMessage.includes('access denied') || lowerMessage.includes('permission denied')) {
    return 'Permission denied accessing backup files. Please check file permissions.';
  }
  
  if (lowerMessage.includes('ebusy') || lowerMessage.includes('file is locked')) {
    return 'Backup files are currently in use by another process. Please try again in a moment.';
  }
  
  if (lowerMessage.includes('emfile') || lowerMessage.includes('enfile') || lowerMessage.includes('too many open files')) {
    return 'System has too many files open. Please close other applications and try again.';
  }
  
  if (lowerMessage.includes('enospc') || lowerMessage.includes('no space left')) {
    return 'Not enough disk space to complete the operation.';
  }
  
  if (lowerMessage.includes('network') || lowerMessage.includes('connection')) {
    return 'Network error occurred while accessing backup files.';
  }
  
  if (lowerMessage.includes('timeout')) {
    return 'Operation timed out. The backup directory may be very large or on a slow drive.';
  }
  
  // Backend communication errors
  if (lowerMessage.includes('no response') || lowerMessage.includes('invoke')) {
    return 'Unable to communicate with the backup system. Please restart the application.';
  }
  
  // Fallback to a generic but helpful message
  return `Unable to calculate backup sizes. Please check that backup files are accessible and try again.`;
}

/**
 * Validate backup size calculation result and provide warnings
 * @param {Object} result - Result from size calculation
 * @returns {Object} Validation result with warnings
 */
export function validateSizeCalculationResult(result) {
  const validation = {
    isValid: true,
    warnings: [],
    errors: []
  };
  
  if (!result) {
    validation.isValid = false;
    validation.errors.push('No result received from size calculation');
    return validation;
  }
  
  // Check for estimated results
  if (result.estimated) {
    validation.warnings.push('Backup sizes are estimated due to file access issues');
  }
  
  // Check for missing backups
  if (result.backups && Array.isArray(result.backups)) {
    const backupsWithoutSize = result.backups.filter(b => 
      typeof b.size !== 'number' || b.size < 0
    );
    
    if (backupsWithoutSize.length > 0) {
      validation.warnings.push(
        `${backupsWithoutSize.length} backup(s) could not be measured accurately`
      );
    }
  }
  
  // Check for unreasonably large total size (might indicate an error)
  if (typeof result.totalSize === 'number' && result.totalSize > 1024 * 1024 * 1024 * 1024) { // 1TB
    validation.warnings.push('Total backup size is unusually large. Please verify the results.');
  }
  
  // Check for backend errors
  if (result.error) {
    validation.warnings.push(result.error);
  }
  
  return validation;
}

/**
 * Process background calculation queue
 */
async function processBackgroundQueue() {
  if (backgroundProcessing || backgroundQueue.length === 0) {
    return;
  }

  backgroundProcessing = true;

  try {
    while (backgroundQueue.length > 0) {
      const task = backgroundQueue.shift();
      
      try {
        const result = await task.operation();
        task.resolve(result);
      } catch (error) {
        task.reject(error);
      }

      // Small delay to prevent overwhelming the system
      if (backgroundQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  } finally {
    backgroundProcessing = false;
  }
}

/**
 * Queue a size calculation for background processing
 * @param {Function} operation - The calculation operation
 * @returns {Promise} Promise that resolves when calculation is complete
 */
export function queueBackgroundCalculation(operation) {
  return new Promise((resolve, reject) => {
    backgroundQueue.push({ operation, resolve, reject });
    
    // Start processing if not already running
    setTimeout(processBackgroundQueue, 0);
  });
}

/**
 * Calculate backup sizes in background to avoid UI blocking
 * @param {string} serverPath - Path to the server directory
 * @param {boolean} forceRefresh - Whether to force refresh cache
 * @returns {Promise<Object>} Promise that resolves with size calculation result
 */
export async function calculateBackupSizesBackground(serverPath, forceRefresh = false) {
  return queueBackgroundCalculation(async () => {
    return calculateBackupSizes(serverPath, forceRefresh);
  });
}

/**
 * Add a size change listener for real-time updates
 * @param {Function} listener - Callback function for size changes
 * @returns {Function} Cleanup function to remove the listener
 */
export function addSizeChangeListenerOptimized(listener) {
  return addSizeChangeListener(listener);
}

/**
 * Get comprehensive cache statistics for debugging and monitoring
 * @returns {Object} Cache statistics including performance metrics
 */
export function getCacheStats() {
  const now = Date.now();
  let validEntries = 0;
  let expiredEntries = 0;
  
  sizeCache.forEach((value) => {
    if (now - value.timestamp > CACHE_EXPIRY_MS) {
      expiredEntries++;
    } else {
      validEntries++;
    }
  });
  
  const basicStats = {
    totalEntries: sizeCache.size,
    validEntries,
    expiredEntries,
    cacheExpiryMs: CACHE_EXPIRY_MS,
    backgroundQueueLength: backgroundQueue.length,
    backgroundProcessing
  };

  // Get performance stats from optimizer
  try {
    const performanceStats = getPerformanceStats();
    return {
      ...basicStats,
      performance: performanceStats
    };
  } catch {
    // Failed to get performance stats
    return basicStats;
  }
}

/**
 * Cleanup all resources and background processes
 */
export function cleanup() {
  // Clear background queue
  backgroundQueue.length = 0;
  backgroundProcessing = false;
  
  // Clear caches
  sizeCache.clear();
  
  // Cleanup optimizer
  try {
    cleanupOptimizer();
  } catch {
    // Failed to cleanup optimizer
  }
}