/**
 * Utility functions for folder operations
 */
import { safeInvoke } from './ipcUtils.js';

/**
 * Opens a folder in the system file explorer
 * Tries multiple methods in sequence to ensure robustness across platforms
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
      try {
        const result = await window.folderOpener.open(folderPath);
        if (result && result.success) {
          return true;
        }
      } catch (err) {
        // Continue to fallback method
      }
    }
    
    // Method 2: Use regular IPC channel - only use one method, not multiple
    try {
      const result = await safeInvoke('open-folder', folderPath);
      return result && result.success;
    } catch (err) {
      return false;
    }
  } catch (err) {
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