/**
 * Utilities for managing mod downloads
 */
import { get } from 'svelte/store';
import { registerListener } from '../ipcUtils.js';
import {
  downloads,
  showDownloads
} from '../../stores/modStore.js';

let downloadCleanupTimer = null;

/**
 * Initialize download manager and set up listeners
 * @returns {Function} - Cleanup function to remove listeners
 */
export function initDownloadManager() {
  // Set up the download progress listener
  const cleanup = registerListener('download-progress', handleDownloadProgress);
  
  // Schedule download cleanup
  scheduleCleanup();
  
  // Return cleanup function
  return () => {
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
    return;
  }
  
  // Ensure progress properties are valid
  const validatedProgress = {
    ...progress,
    progress: typeof progress.progress === 'number' ? 
              // Convert from 0-1 to 0-100 if needed and ensure it's a valid number
              (progress.progress <= 1 ? progress.progress * 100 : progress.progress) || 0 : 0,
    size: typeof progress.size === 'number' && !isNaN(progress.size) ? progress.size : 0,
    speed: typeof progress.speed === 'number' && !isNaN(progress.speed) ? progress.speed : 0
  };
  
  // Update download progress
  downloads.update(currentDownloads => {
    const newDownloads = { ...currentDownloads };
    
    if (validatedProgress.completed || validatedProgress.error) {
      // Mark download as completed or failed
      newDownloads[validatedProgress.id] = {
        ...newDownloads[validatedProgress.id] || {},
        ...validatedProgress,
        progress: validatedProgress.completed ? 100 : validatedProgress.progress,
        completedTime: Date.now()
      };
    } else {
      // Update download progress
      newDownloads[validatedProgress.id] = {
        ...newDownloads[validatedProgress.id] || {},
        ...validatedProgress
      };
    }
    
    return newDownloads;
  });
  
  // Update showDownloads flag
  const currentDownloads = get(downloads);
  if (Object.keys(currentDownloads).length > 0) {
    showDownloads.set(true);
    // Ensure cleanup is scheduled
    scheduleCleanup();
  }
}

/**
 * Clean up old completed or failed downloads
 */
function cleanupDownloads() {
  const now = Date.now();
  let hasChanges = false;
  
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
      }
    }
    
    return newDownloads;
  });
  
  if (hasChanges) {
    // Update show/hide status
    const currentDownloads = get(downloads);
    showDownloads.set(Object.keys(currentDownloads).length > 0);
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
  if (Object.keys(currentDownloads).length > 0) {
    downloadCleanupTimer = setTimeout(cleanupDownloads, 2000);
  } else {
    downloadCleanupTimer = null;
  }
}

/**
 * Track a download manually (e.g., for UI feedback before actual download starts)
 * @param {string} id - Download ID
 * @param {string} name - Download name
 */
export function trackDownload(id, name) {
  if (!id) return;
  
  downloads.update(currentDownloads => {
    return {
      ...currentDownloads,
      [id]: {
        id,
        name,
        progress: 0,
        speed: 0,
        completed: false,
        error: null,
        startTime: Date.now()
      }
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
  if (!id) return;
  
  downloads.update(currentDownloads => {
    if (!currentDownloads[id]) return currentDownloads;
    
    return {
      ...currentDownloads,
      [id]: {
        ...currentDownloads[id],
        progress: isError ? currentDownloads[id].progress : 100,
        completed: !isError,
        error: isError ? errorMessage : null,
        completedTime: Date.now()
      }
    };
  });
  
  scheduleCleanup();
} 