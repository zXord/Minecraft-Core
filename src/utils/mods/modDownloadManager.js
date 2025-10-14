/**
 * Utilities for managing mod downloads
 */
/// <reference path="../../electron.d.ts" />
import { get } from 'svelte/store';
import { registerListener } from '../ipcUtils.js';
import {
  downloads,
  showDownloads,
  createEnhancedDownloadProgress,
  updateDownloadProgress,
  calculateEstimatedTimeRemaining,
  updateQueuePositions,
  generateStatusMessage
} from '../../stores/modStore.js';
import logger from '../logger.js';

let downloadCleanupTimer = null;

// Store initialization state in globalThis to survive hot-reloads
if (!globalThis.__downloadManagerState) {
  globalThis.__downloadManagerState = {
    isInitialized: false,
    cleanup: null
  };
}

/**
 * Initialize download manager and set up listeners
 * @returns {Function} - Cleanup function to remove listeners
 */
export function initDownloadManager() {
  // Prevent multiple initializations - only allow one active download manager
  if (globalThis.__downloadManagerState.isInitialized) {
    logger.warn('Download manager already initialized, returning existing cleanup function', {
      category: 'mods',
      data: {
        function: 'initDownloadManager',
        alreadyInitialized: true
      }
    });
    return globalThis.__downloadManagerState.cleanup || (() => {});
  }

  logger.info('Initializing download manager', {
    category: 'mods',
    data: {
      function: 'initDownloadManager'
    }
  });

  globalThis.__downloadManagerState.isInitialized = true;

  // Set up the download progress listener
  const cleanup = registerListener('download-progress', handleDownloadProgress);
  
  // Schedule download cleanup
  scheduleCleanup();
  
  logger.info('Download manager initialized successfully', {
    category: 'mods',
    data: {
      function: 'initDownloadManager',
      success: true
    }
  });
  
  // Store cleanup function for returning on duplicate initialization attempts
  globalThis.__downloadManagerState.cleanup = () => {
    logger.debug('Cleaning up download manager', {
      category: 'mods',
      data: {
        function: 'initDownloadManager.cleanup',
        hasCleanupTimer: !!downloadCleanupTimer
      }
    });

    cleanup();

    if (downloadCleanupTimer) {
      clearTimeout(downloadCleanupTimer);
      downloadCleanupTimer = null;
    }

    // Reset initialization flag so it can be re-initialized later
    globalThis.__downloadManagerState.isInitialized = false;
    globalThis.__downloadManagerState.cleanup = null;
  };

  // Return cleanup function
  return globalThis.__downloadManagerState.cleanup;
}

/**
 * Handle download progress updates
 * @param {Object} progress - Download progress data
 */
function handleDownloadProgress(progress) {
  if (!progress || !progress.id) {
    logger.warn('Invalid download progress data received', {
      category: 'mods',
      data: {
        function: 'handleDownloadProgress',
        progress,
        hasId: !!(progress?.id)
      }
    });
    return;
  }
  
  logger.debug('Handling download progress update', {
    category: 'mods',
    data: {
      function: 'handleDownloadProgress',
      downloadId: progress.id,
      downloadName: progress.name,
      progress: progress.progress,
      state: progress.state,
      source: progress.source,
      attempt: progress.attempt,
      completed: progress.completed,
      hasError: !!progress.error
    }
  });
  
  // Validate and normalize progress data
  const validatedProgress = validateAndNormalizeProgress(progress);
  if (!validatedProgress) {
    logger.error('Failed to validate download progress data', {
      category: 'mods',
      data: {
        function: 'handleDownloadProgress',
        downloadId: progress.id,
        originalProgress: progress
      }
    });
    return;
  }
  
  // Update download progress
  downloads.update(currentDownloads => {
    const newDownloads = { ...currentDownloads };
    const currentDownload = newDownloads[validatedProgress.id];
    const wasExisting = !!currentDownload;
    
    // Determine if this is a final state
    const isFinalState = validatedProgress.state === 'completed' || validatedProgress.state === 'failed';
    
    if (isFinalState) {
      // Handle final states (completed/failed)
      const updates = {
        ...validatedProgress,
        progress: validatedProgress.state === 'completed' ? 100 : validatedProgress.progress,
        completedTime: Date.now(),
        completed: validatedProgress.state === 'completed',
        error: validatedProgress.state === 'failed' ? (validatedProgress.error || 'Download failed') : null
      };
      
      if (currentDownload) {
        newDownloads[validatedProgress.id] = updateDownloadProgress(currentDownload, updates);
      } else {
        newDownloads[validatedProgress.id] = createEnhancedDownloadProgress(
          validatedProgress.id,
          validatedProgress.name,
          updates
        );
      }
      
      logger.info(`Download ${validatedProgress.state}`, {
        category: 'mods',
        data: {
          function: 'handleDownloadProgress',
          downloadId: validatedProgress.id,
          downloadName: validatedProgress.name,
          finalState: validatedProgress.state,
          wasExisting,
          source: validatedProgress.source,
          attempt: validatedProgress.attempt
        }
      });
    } else {
      // Handle in-progress states
      const updates = {
        ...validatedProgress,
        estimatedTimeRemaining: calculateEstimatedTimeRemaining(
          validatedProgress.progress,
          validatedProgress.speed,
          validatedProgress.size
        )
      };
      
      if (currentDownload) {
        newDownloads[validatedProgress.id] = updateDownloadProgress(currentDownload, updates);
      } else {
        newDownloads[validatedProgress.id] = createEnhancedDownloadProgress(
          validatedProgress.id,
          validatedProgress.name,
          updates
        );
        
        logger.debug('Created new download entry', {
          category: 'mods',
          data: {
            function: 'handleDownloadProgress',
            downloadId: validatedProgress.id,
            downloadName: validatedProgress.name,
            state: validatedProgress.state,
            source: validatedProgress.source
          }
        });
      }
    }
    
    // Update queue positions for all downloads
    return updateQueuePositions(newDownloads);
  });
  
  // Update UI visibility
  updateDownloadVisibility();
  
  // Log state-specific information
  logStateSpecificInfo(validatedProgress);
}

/**
 * Validate and normalize download progress data
 * @param {Object} progress - Raw progress data
 * @returns {Object|null} Validated progress data or null if invalid
 */
function validateAndNormalizeProgress(progress) {
  try {
    // Ensure required fields exist
    if (!progress.id || !progress.name) {
      return null;
    }
    
    // Normalize progress value (convert 0-1 to 0-100 if needed)
    let normalizedProgress = 0;
    if (typeof progress.progress === 'number' && !isNaN(progress.progress)) {
      normalizedProgress = progress.progress <= 1 ? progress.progress * 100 : progress.progress;
      normalizedProgress = Math.max(0, Math.min(100, Math.round(normalizedProgress * 100) / 100));
    }
    
    // Normalize other numeric fields
    const normalizedSize = typeof progress.size === 'number' && !isNaN(progress.size) ? Math.max(0, progress.size) : 0;
    const normalizedSpeed = typeof progress.speed === 'number' && !isNaN(progress.speed) ? Math.max(0, progress.speed) : 0;
    const normalizedAttempt = typeof progress.attempt === 'number' && !isNaN(progress.attempt) ? Math.max(1, progress.attempt) : 1;
    const normalizedMaxAttempts = typeof progress.maxAttempts === 'number' && !isNaN(progress.maxAttempts) ? Math.max(1, progress.maxAttempts) : 3;
    
    // Determine state (with fallback for legacy completed/error fields)
    let state = progress.state;
    if (!state) {
      if (progress.completed) {
        state = 'completed';
      } else if (progress.error) {
        state = 'failed';
      } else {
        state = 'downloading';
      }
    }
    
    return {
      ...progress,
      progress: normalizedProgress,
      size: normalizedSize,
      speed: normalizedSpeed,
      attempt: normalizedAttempt,
      maxAttempts: normalizedMaxAttempts,
      state,
      source: progress.source || 'server',
      statusMessage: progress.statusMessage || generateStatusMessage(state, progress)
    };
  } catch (error) {
    logger.error(`Progress validation failed: ${error.message}`, {
      category: 'mods',
      data: {
        function: 'validateAndNormalizeProgress',
        downloadId: progress?.id,
        error: error.message
      }
    });
    return null;
  }
}

/**
 * Update download visibility based on current downloads
 */
function updateDownloadVisibility() {
  const currentDownloads = get(downloads);
  const downloadCount = Object.keys(currentDownloads).length;
  
  if (downloadCount > 0) {
    showDownloads.set(true);
    scheduleCleanup();
    
    logger.debug('Updated download visibility', {
      category: 'ui',
      data: {
        function: 'updateDownloadVisibility',
        showDownloads: true,
        activeDownloadCount: downloadCount
      }
    });
  } else {
    showDownloads.set(false);
    
    logger.debug('Updated download visibility', {
      category: 'ui',
      data: {
        function: 'updateDownloadVisibility',
        showDownloads: false,
        activeDownloadCount: downloadCount
      }
    });
  }
}

/**
 * Log state-specific information for downloads
 * @param {Object} progress - Validated progress data
 */
function logStateSpecificInfo(progress) {
  const logData = {
    category: 'mods',
    data: {
      function: 'logStateSpecificInfo',
      downloadId: progress.id,
      downloadName: progress.name,
      state: progress.state,
      progress: progress.progress,
      source: progress.source,
      attempt: progress.attempt
    }
  };
  
  switch (progress.state) {
    case 'completed':
      logger.info('Download completed successfully', logData);
      break;
    case 'failed':
      logger.error('Download failed', {
        ...logData,
        data: {
          ...logData.data,
          error: progress.error,
          errorDetails: progress.errorDetails
        }
      });
      break;
    case 'retrying':
      logger.warn('Download retry attempt', {
        ...logData,
        data: {
          ...logData.data,
          maxAttempts: progress.maxAttempts
        }
      });
      break;
    case 'fallback':
      logger.info('Download fallback triggered', {
        ...logData,
        data: {
          ...logData.data,
          fallbackCountdown: progress.fallbackCountdown
        }
      });
      break;
    case 'verifying':
      logger.debug('Download verification in progress', logData);
      break;
    default:
      // Only log debug for other states to avoid spam
      logger.debug('Download progress update', logData);
  }
}

/**
 * Clean up old completed or failed downloads
 */
function cleanupDownloads() {
  const now = Date.now();
  let hasChanges = false;
  let cleanedCount = 0;
  const cleanupDelay = 5000; // 5 seconds for better user experience
  
  logger.debug('Starting download cleanup', {
    category: 'mods',
    data: {
      function: 'cleanupDownloads',
      currentTime: now,
      cleanupDelay
    }
  });
  
  // Keep only recent downloads (less than cleanupDelay old if completed/failed)
  downloads.update(currentDownloads => {
    const newDownloads = { ...currentDownloads };
    
    for (const id in newDownloads) {
      const download = newDownloads[id];
      const isFinalState = download.state === 'completed' || download.state === 'failed';
      const hasCompletedTime = download.completedTime && typeof download.completedTime === 'number';
      
      // Clean up downloads that are in final state and older than cleanup delay
      if (isFinalState && hasCompletedTime && now - download.completedTime > cleanupDelay) {
        logger.debug('Cleaning up old download', {
          category: 'mods',
          data: {
            function: 'cleanupDownloads',
            downloadId: id,
            downloadName: download.name,
            state: download.state,
            ageMs: now - download.completedTime
          }
        });
        
        delete newDownloads[id];
        hasChanges = true;
        cleanedCount++;
      }
      
      // Also clean up legacy downloads using old completed/error flags
      else if ((download.completed || download.error) && 
               download.completedTime && 
               now - download.completedTime > cleanupDelay) {
        logger.debug('Cleaning up legacy download', {
          category: 'mods',
          data: {
            function: 'cleanupDownloads',
            downloadId: id,
            downloadName: download.name,
            completed: download.completed,
            hasError: !!download.error,
            ageMs: now - download.completedTime
          }
        });
        
        delete newDownloads[id];
        hasChanges = true;
        cleanedCount++;
      }
    }
    
    return newDownloads;
  });
  
  if (hasChanges) {
    logger.debug('Cleaned up old downloads', {
      category: 'mods',
      data: {
        function: 'cleanupDownloads',
        cleanedCount,
        hasChanges
      }
    });
    
    // Update show/hide status
    updateDownloadVisibility();
  }
  
  // Schedule next cleanup if needed
  scheduleCleanup();
}

/**
 * Schedule the next cleanup
 */
function scheduleCleanup() {
  if (downloadCleanupTimer) {
    clearTimeout(downloadCleanupTimer);
  }
  
  // Schedule next cleanup if there are active downloads
  const currentDownloads = get(downloads);
  const activeDownloadsCount = Object.keys(currentDownloads).length;
  
  if (activeDownloadsCount > 0) {
    downloadCleanupTimer = setTimeout(cleanupDownloads, 2000);
    
    logger.debug('Scheduled download cleanup', {
      category: 'mods',
      data: {
        function: 'scheduleCleanup',
        activeDownloadsCount,
        cleanupDelayMs: 2000
      }
    });
  } else {
    downloadCleanupTimer = null;
    
    logger.debug('No active downloads, cleanup not scheduled', {
      category: 'mods',
      data: {
        function: 'scheduleCleanup',
        activeDownloadsCount
      }
    });
  }
}

/**
 * Track a download manually (e.g., for UI feedback before actual download starts)
 * @param {string} id - Download ID
 * @param {string} name - Download name
 * @param {Object} options - Additional options for the download
 */
export function trackDownload(id, name, options = {}) {
  if (!id) {
    logger.warn('Attempted to track download without ID', {
      category: 'mods',
      data: {
        function: 'trackDownload',
        id,
        name,
        options
      }
    });
    return;
  }
  
  logger.info('Tracking new download', {
    category: 'mods',
    data: {
      function: 'trackDownload',
      downloadId: id,
      downloadName: name,
      source: options.source || 'server',
      maxAttempts: options.maxAttempts || 3
    }
  });
  
  downloads.update(currentDownloads => {
    const newDownload = createEnhancedDownloadProgress(id, name, {
      state: 'queued',
      progress: 0,
      speed: 0,
      source: options.source || 'server',
      attempt: 1,
      maxAttempts: options.maxAttempts || 3,
      completed: false,
      error: null,
      startTime: Date.now(),
      ...options
    });
    
    logger.debug('Added download to store', {
      category: 'mods',
      data: {
        function: 'trackDownload',
        downloadId: id,
        downloadName: name,
        state: newDownload.state,
        source: newDownload.source,
        startTime: newDownload.startTime
      }
    });
    
    const updatedDownloads = {
      ...currentDownloads,
      [id]: newDownload
    };
    
    // Update queue positions for all downloads
    return updateQueuePositions(updatedDownloads);
  });
  
  showDownloads.set(true);
  scheduleCleanup();
}

/**
 * Mark a download as complete
 * @param {string} id - Download ID
 * @param {boolean} isError - Whether the download failed
 * @param {string} errorMessage - Error message if failed
 * @param {Object} additionalData - Additional completion data
 */
export function completeDownload(id, isError = false, errorMessage = null, additionalData = {}) {
  if (!id) {
    logger.warn('Attempted to complete download without ID', {
      category: 'mods',
      data: {
        function: 'completeDownload',
        id,
        isError,
        errorMessage,
        additionalData
      }
    });
    return;
  }
  
  const currentDownloads = get(downloads);
  if (!currentDownloads[id]) {
    logger.warn('Attempted to complete non-existent download', {
      category: 'mods',
      data: {
        function: 'completeDownload',
        downloadId: id,
        isError,
        errorMessage,
        additionalData
      }
    });
    return;
  }
  
  const currentDownload = currentDownloads[id];
  const finalState = isError ? 'failed' : 'completed';
  
  logger.info(isError ? 'Download failed' : 'Download completed successfully', {
    category: 'mods',
    data: {
      function: 'completeDownload',
      downloadId: id,
      downloadName: currentDownload.name,
      finalState,
      source: currentDownload.source,
      attempt: currentDownload.attempt,
      errorMessage,
      additionalData
    }
  });
  
  downloads.update(currentDownloads => {
    const currentDownload = currentDownloads[id];
    const updates = {
      progress: isError ? currentDownload.progress : 100,
      state: finalState,
      completed: !isError,
      error: isError ? errorMessage : null,
      completedTime: Date.now(),
      ...additionalData
    };
    
    const updatedDownload = updateDownloadProgress(currentDownload, updates);
    
    logger.debug('Updated download completion state in store', {
      category: 'mods',
      data: {
        function: 'completeDownload',
        downloadId: id,
        finalState: updatedDownload.state,
        finalProgress: updatedDownload.progress,
        completed: updatedDownload.completed,
        hasError: !!updatedDownload.error,
        completedTime: updatedDownload.completedTime,
        source: updatedDownload.source,
        attempt: updatedDownload.attempt
      }
    });
    
    return {
      ...currentDownloads,
      [id]: updatedDownload
    };
  });
  
  scheduleCleanup();
}

/**
 * Update download state (for intermediate states like retrying, verifying, etc.)
 * @param {string} id - Download ID
 * @param {string} state - New state
 * @param {Object} additionalData - Additional state data
 */
export function updateDownloadState(id, state, additionalData = {}) {
  if (!id || !state) {
    logger.warn('Attempted to update download state with missing parameters', {
      category: 'mods',
      data: {
        function: 'updateDownloadState',
        id,
        state,
        additionalData
      }
    });
    return;
  }
  
  const currentDownloads = get(downloads);
  if (!currentDownloads[id]) {
    logger.warn('Attempted to update state of non-existent download', {
      category: 'mods',
      data: {
        function: 'updateDownloadState',
        downloadId: id,
        state,
        additionalData
      }
    });
    return;
  }
  
  logger.debug('Updating download state', {
    category: 'mods',
    data: {
      function: 'updateDownloadState',
      downloadId: id,
      newState: state,
      oldState: currentDownloads[id].state,
      additionalData
    }
  });
  
  downloads.update(currentDownloads => {
    const currentDownload = currentDownloads[id];
    const updates = {
      state,
      lastUpdateTime: Date.now(),
      ...additionalData
    };
    
    const updatedDownload = updateDownloadProgress(currentDownload, updates);
    
    return {
      ...currentDownloads,
      [id]: updatedDownload
    };
  });
} 