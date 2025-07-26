/**
 * Utilities for managing mod downloads
 */
import { get } from 'svelte/store';
import { registerListener } from '../ipcUtils.js';
import {
  downloads,
  showDownloads
} from '../../stores/modStore.js';
import logger from '../logger.js';

let downloadCleanupTimer = null;

/**
 * Initialize download manager and set up listeners
 * @returns {Function} - Cleanup function to remove listeners
 */
export function initDownloadManager() {
  logger.info('Initializing download manager', {
    category: 'mods',
    data: {
      function: 'initDownloadManager'
    }
  });
  
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
  
  // Return cleanup function
  return () => {
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
  };
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
      completed: progress.completed,
      hasError: !!progress.error
    }
  });
    // Ensure progress properties are valid
  const validatedProgress = {
    ...progress,
    progress: typeof progress.progress === 'number' ? 
              // Convert from 0-1 to 0-100 if needed and ensure it's a valid number, then round to 2 decimal places
              Math.round((progress.progress <= 1 ? progress.progress * 100 : progress.progress) * 100) / 100 || 0 : 0,
    size: typeof progress.size === 'number' && !isNaN(progress.size) ? progress.size : 0,
    speed: typeof progress.speed === 'number' && !isNaN(progress.speed) ? progress.speed : 0
  };
  
  // Update download progress
  downloads.update(currentDownloads => {
    const newDownloads = { ...currentDownloads };
    const wasExisting = !!newDownloads[validatedProgress.id];
    
    if (validatedProgress.completed || validatedProgress.error) {
      // Mark download as completed or failed
      newDownloads[validatedProgress.id] = {
        ...newDownloads[validatedProgress.id] || {},
        ...validatedProgress,
        progress: validatedProgress.completed ? 100 : validatedProgress.progress,
        completedTime: Date.now()
      };
      
      logger.debug('Updated download to final state', {
        category: 'mods',
        data: {
          function: 'handleDownloadProgress',
          downloadId: validatedProgress.id,
          wasExisting: wasExisting,
          finalState: validatedProgress.completed ? 'completed' : 'error'
        }
      });
    } else {
      // Update download progress
      newDownloads[validatedProgress.id] = {
        ...newDownloads[validatedProgress.id] || {},
        ...validatedProgress
      };
      
      if (!wasExisting) {
        logger.debug('Created new download entry', {
          category: 'mods',
          data: {
            function: 'handleDownloadProgress',
            downloadId: validatedProgress.id,
            downloadName: validatedProgress.name
          }
        });
      }
    }
    
    return newDownloads;
  });
  
  // Update showDownloads flag
  const currentDownloads = get(downloads);
  const downloadCount = Object.keys(currentDownloads).length;
  
  if (downloadCount > 0) {
    showDownloads.set(true);
    // Ensure cleanup is scheduled
    scheduleCleanup();
    
    logger.debug('Updated download visibility', {
      category: 'ui',
      data: {
        function: 'handleDownloadProgress',
        showDownloads: true,
        activeDownloadCount: downloadCount
      }
    });
  }
  
  // Log completion or error
  if (validatedProgress.completed) {
    logger.info('Download completed successfully', {
      category: 'mods',
      data: {
        function: 'handleDownloadProgress',
        downloadId: validatedProgress.id,
        downloadName: validatedProgress.name,
        progress: validatedProgress.progress
      }
    });
  } else if (validatedProgress.error) {
    logger.error('Download failed with error', {
      category: 'mods',
      data: {
        function: 'handleDownloadProgress',
        downloadId: validatedProgress.id,
        downloadName: validatedProgress.name,
        error: validatedProgress.error
      }
    });
  }
}

/**
 * Clean up old completed or failed downloads
 */
function cleanupDownloads() {
  const now = Date.now();
  let hasChanges = false;
  let cleanedCount = 0;
  
  logger.debug('Starting download cleanup', {
    category: 'mods',
    data: {
      function: 'cleanupDownloads',
      currentTime: now
    }
  });
  
  // Keep only recent downloads (less than 10 seconds old if completed/error)
  downloads.update(currentDownloads => {
    const newDownloads = { ...currentDownloads };
    
    for (const id in newDownloads) {
      const download = newDownloads[id];
      if ((download.completed || download.error) && 
          download.completedTime && 
          now - download.completedTime > 10000) {
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
    const currentDownloads = get(downloads);
    const remainingCount = Object.keys(currentDownloads).length;
    const shouldShow = remainingCount > 0;
    showDownloads.set(shouldShow);
    
    logger.debug('Updated download visibility after cleanup', {
      category: 'ui',
      data: {
        function: 'cleanupDownloads',
        showDownloads: shouldShow,
        remainingDownloadCount: remainingCount
      }
    });
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
 */
export function trackDownload(id, name) {
  if (!id) {
    logger.warn('Attempted to track download without ID', {
      category: 'mods',
      data: {
        function: 'trackDownload',
        id,
        name
      }
    });
    return;
  }
  
  logger.info('Tracking new download', {
    category: 'mods',
    data: {
      function: 'trackDownload',
      downloadId: id,
      downloadName: name
    }
  });
  
  downloads.update(currentDownloads => {
    const newDownload = {
      id,
      name,
      progress: 0,
      speed: 0,
      completed: false,
      error: null,
      startTime: Date.now()
    };
    
    logger.debug('Added download to store', {
      category: 'mods',
      data: {
        function: 'trackDownload',
        downloadId: id,
        downloadName: name,
        startTime: newDownload.startTime
      }
    });
    
    return {
      ...currentDownloads,
      [id]: newDownload
    };
  });
  
  showDownloads.set(true);
  scheduleCleanup();
}

/**
 * Mark a download as complete
 * @param {string} id - Download ID
 * @param {boolean} isError - Whether the download failed
 * @param {string} errorMessage - Error message if failed
 */
export function completeDownload(id, isError = false, errorMessage = null) {
  if (!id) {
    logger.warn('Attempted to complete download without ID', {
      category: 'mods',
      data: {
        function: 'completeDownload',
        id,
        isError,
        errorMessage
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
        errorMessage
      }
    });
    return;
  }
  
  logger.info(isError ? 'Download failed' : 'Download completed successfully', {
    category: 'mods',
    data: {
      function: 'completeDownload',
      downloadId: id,
      downloadName: currentDownloads[id].name,
      isError,
      errorMessage
    }
  });
  
  downloads.update(currentDownloads => {
    const updatedDownload = {
      ...currentDownloads[id],
      progress: isError ? currentDownloads[id].progress : 100,
      completed: !isError,
      error: isError ? errorMessage : null,
      completedTime: Date.now()
    };
    
    logger.debug('Updated download completion state in store', {
      category: 'mods',
      data: {
        function: 'completeDownload',
        downloadId: id,
        finalProgress: updatedDownload.progress,
        completed: updatedDownload.completed,
        hasError: !!updatedDownload.error,
        completedTime: updatedDownload.completedTime
      }
    });
    
    return {
      ...currentDownloads,
      [id]: updatedDownload
    };
  });
  
  scheduleCleanup();
} 