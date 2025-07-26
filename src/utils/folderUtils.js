/**
 * Utility functions for folder operations
 */
import { safeInvoke } from './ipcUtils.js';
import logger from './logger.js';

/**
 * Opens a folder in the system file explorer
 * Uses a dedicated folder opener when available; otherwise falls back to
 * a single IPC-based method
 *
 * @param {string} folderPath - Path to the folder to open
 * @returns {Promise<boolean>} - True if any method was successful
 */
export async function openFolder(folderPath) {
  logger.info('Opening folder in system explorer', {
    category: 'utils',
    data: {
      function: 'openFolder',
      folderPath,
      hasFolderOpener: !!window.folderOpener
    }
  });
  
  if (!folderPath) {
    logger.warn('No folder path provided to openFolder', {
      category: 'utils',
      data: {
        function: 'openFolder',
        folderPath
      }
    });
    return false;
  }
  
  try {
    // Method 1: Try the dedicated folder opener if available
    if (window.folderOpener) {
      logger.debug('Attempting to use dedicated folder opener', {
        category: 'utils',
        data: {
          function: 'openFolder',
          folderPath,
          method: 'folderOpener'
        }
      });
      
      const result = await window.folderOpener.open(folderPath);
      if (result && result.success) {
        logger.info('Folder opened successfully using dedicated opener', {
          category: 'utils',
          data: {
            function: 'openFolder',
            folderPath,
            method: 'folderOpener'
          }
        });
        return true;
      }
    }
    
    // Method 2: Use regular IPC channel - only use one method, not multiple
    logger.debug('Attempting to use IPC channel to open folder', {
      category: 'utils',
      data: {
        function: 'openFolder',
        folderPath,
        method: 'IPC'
      }
    });
    
    try {
      const result = await safeInvoke('open-folder', folderPath);
      const success = result && result.success;
      
      if (success) {
        logger.info('Folder opened successfully using IPC', {
          category: 'utils',
          data: {
            function: 'openFolder',
            folderPath,
            method: 'IPC'
          }
        });
      } else {
        logger.warn('IPC folder open returned unsuccessful result', {
          category: 'utils',
          data: {
            function: 'openFolder',
            folderPath,
            result
          }
        });
      }
      
      return success;
    } catch (err) {
      logger.error('Error opening folder via IPC', {
        category: 'utils',
        data: {
          function: 'openFolder',
          folderPath,
          method: 'IPC',
          errorMessage: err.message
        }
      });
      return false;
    }
  } catch (err) {
    logger.error('Error opening folder', {
      category: 'utils',
      data: {
        function: 'openFolder',
        folderPath,
        errorMessage: err.message
      }
    });
    return false;
  }
}

/**
 * Validates a server path 
 * @param {string} path - Path to validate
 * @returns {boolean} - True if path appears valid
 */
export function validateServerPath(path) {
  logger.debug('Validating server path', {
    category: 'utils',
    data: {
      function: 'validateServerPath',
      path,
      isString: typeof path === 'string',
      hasPath: !!path
    }
  });
  
  if (!path) {
    logger.debug('Server path validation failed - no path provided', {
      category: 'utils',
      data: {
        function: 'validateServerPath',
        path,
        reason: 'empty_path'
      }
    });
    return false;
  }
  
  // Basic validation - path should be a non-empty string
  // More complex validation could be added if needed
  const isValid = typeof path === 'string' && path.trim().length > 0;
  
  logger.debug('Server path validation result', {
    category: 'utils',
    data: {
      function: 'validateServerPath',
      path,
      isValid,
      trimmedLength: typeof path === 'string' ? path.trim().length : 0
    }
  });
  
  return isValid;
} 