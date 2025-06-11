/**
 * Utility functions for folder operations
 */
import { safeInvoke } from './ipcUtils.js';

/**
 * Opens a folder in the system file explorer
 * Uses a dedicated folder opener when available; otherwise falls back to
 * a single IPC-based method
 *
 * @param {string} folderPath - Path to the folder to open
 * @returns {Promise<boolean>} - True if any method was successful
 */
export async function openFolder(folderPath) {
  if (!folderPath) {
    return false;
  }
  
  try {
    // Method 1: Try the dedicated folder opener if available
    if (window.folderOpener) {
      const result = await window.folderOpener.open(folderPath);
      if (result && result.success) {
        return true;
      }
    }
    
    // Method 2: Use regular IPC channel - only use one method, not multiple
  try {
      const result = await safeInvoke('open-folder', folderPath);
      return result && result.success;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Validates a server path 
 * @param {string} path - Path to validate
 * @returns {boolean} - True if path appears valid
 */
export function validateServerPath(path) {
  if (!path) return false;
  
  // Basic validation - path should be a non-empty string
  // More complex validation could be added if needed
  return typeof path === 'string' && path.trim().length > 0;
} 