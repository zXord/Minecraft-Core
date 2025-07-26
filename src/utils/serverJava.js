/**
 * Server Java Management Utilities
 * Frontend interface for server Java version management
 */
import logger from './logger.js';

/**
 * Check Java requirements for a specific Minecraft version
 * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
 * @param {string} serverPath - Server path (optional, will use current server if not provided)
 * @returns {Promise<Object>} - Java requirement information
 */
export async function checkServerJavaRequirements(minecraftVersion, serverPath = null) {
  logger.info('Checking server Java requirements', {
    category: 'utils',
    data: {
      function: 'checkServerJavaRequirements',
      minecraftVersion,
      hasServerPath: !!serverPath
    }
  });
  
  try {
    const result = await window.electron.invoke('server-java-check-requirements', {
      minecraftVersion,
      serverPath
    });
    
    logger.info('Server Java requirements check completed', {
      category: 'utils',
      data: {
        function: 'checkServerJavaRequirements',
        minecraftVersion,
        success: result.success,
        needsDownload: result.needsDownload,
        isAvailable: result.isAvailable
      }
    });
    
    return result;
  } catch (err) {
    logger.error('Error checking server Java requirements', {
      category: 'utils',
      data: {
        function: 'checkServerJavaRequirements',
        minecraftVersion,
        serverPath,
        errorMessage: err.message
      }
    });
    return {
      success: false,
      error: err.message,
      needsDownload: false,
      isAvailable: false
    };
  }
}

/**
 * Ensure Java is available for a Minecraft version (download if needed)
 * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
 * @param {string} serverPath - Server path (optional, will use current server if not provided)
 * @returns {Promise<Object>} - Result of Java ensure operation
 */
export async function ensureServerJava(minecraftVersion, serverPath = null) {
  logger.info('Ensuring server Java availability', {
    category: 'utils',
    data: {
      function: 'ensureServerJava',
      minecraftVersion,
      hasServerPath: !!serverPath
    }
  });
  
  try {
    const result = await window.electron.invoke('server-java-ensure', {
      minecraftVersion,
      serverPath
    });
    
    logger.info('Server Java ensure operation completed', {
      category: 'utils',
      data: {
        function: 'ensureServerJava',
        minecraftVersion,
        success: result.success,
        wasDownloaded: result.downloaded,
        javaPath: result.javaPath
      }
    });
    
    return result;
  } catch (err) {
    logger.error('Error ensuring server Java', {
      category: 'utils',
      data: {
        function: 'ensureServerJava',
        minecraftVersion,
        serverPath,
        errorMessage: err.message
      }
    });
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Get the Java path for a Minecraft version
 * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
 * @returns {Promise<Object>} - Java path information
 */
export async function getServerJavaPath(minecraftVersion) {
  logger.debug('Getting server Java path', {
    category: 'utils',
    data: {
      function: 'getServerJavaPath',
      minecraftVersion
    }
  });
  
  try {
    const result = await window.electron.invoke('server-java-get-path', {
      minecraftVersion
    });
    
    logger.debug('Server Java path retrieved', {
      category: 'utils',
      data: {
        function: 'getServerJavaPath',
        minecraftVersion,
        success: result.success,
        available: result.available,
        hasJavaPath: !!result.javaPath
      }
    });
    
    return result;
  } catch (err) {
    logger.error('Error getting server Java path', {
      category: 'utils',
      data: {
        function: 'getServerJavaPath',
        minecraftVersion,
        errorMessage: err.message
      }
    });
    return {
      success: false,
      error: err.message,
      available: false,
      javaPath: null
    };
  }
}

/**
 * Check if correct Java is available for a Minecraft version (quick check)
 * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
 * @returns {Promise<Object>} - Availability check result
 */
export async function isServerJavaAvailable(minecraftVersion) {
  logger.debug('Checking if server Java is available', {
    category: 'utils',
    data: {
      function: 'isServerJavaAvailable',
      minecraftVersion
    }
  });
  
  try {
    const result = await window.electron.invoke('server-java-is-available', {
      minecraftVersion
    });
    
    logger.debug('Server Java availability check completed', {
      category: 'utils',
      data: {
        function: 'isServerJavaAvailable',
        minecraftVersion,
        success: result.success,
        available: result.available
      }
    });
    
    return result;
  } catch (err) {
    logger.error('Error checking server Java availability', {
      category: 'utils',
      data: {
        function: 'isServerJavaAvailable',
        minecraftVersion,
        errorMessage: err.message
      }
    });
    return {
      success: false,
      error: err.message,
      available: false
    };
  }
}

/**
 * Get all available Java versions for servers
 * @returns {Promise<Object>} - Available Java versions
 */
export async function getAvailableServerJavaVersions() {
  logger.debug('Getting available server Java versions', {
    category: 'utils',
    data: {
      function: 'getAvailableServerJavaVersions'
    }
  });
  
  try {
    const result = await window.electron.invoke('server-java-get-available-versions');
    
    logger.debug('Available server Java versions retrieved', {
      category: 'utils',
      data: {
        function: 'getAvailableServerJavaVersions',
        success: result.success,
        versionsCount: result.versions ? result.versions.length : 0
      }
    });
    
    return result;
  } catch (err) {
    logger.error('Error getting available server Java versions', {
      category: 'utils',
      data: {
        function: 'getAvailableServerJavaVersions',
        errorMessage: err.message
      }
    });
    return {
      success: false,
      error: err.message,
      versions: []
    };
  }
}

/**
 * Listen for server Java download progress events
 * @param {Function} callback - Callback function to handle progress updates
 * @returns {Function} - Cleanup function to remove the listener
 */
export function onServerJavaDownloadProgress(callback) {
  logger.debug('Setting up server Java download progress listener', {
    category: 'utils',
    data: {
      function: 'onServerJavaDownloadProgress',
      hasCallback: typeof callback === 'function'
    }
  });
  
  if (typeof callback !== 'function') {
    logger.warn('Invalid callback provided to onServerJavaDownloadProgress', {
      category: 'utils',
      data: {
        function: 'onServerJavaDownloadProgress',
        callback,
        callbackType: typeof callback
      }
    });
    return () => {}; // Return empty cleanup function
  }
  
  const handleProgress = (data) => {
    logger.debug('Server Java download progress received', {
      category: 'utils',
      data: {
        function: 'onServerJavaDownloadProgress',
        progress: data.progress,
        phase: data.phase
      }
    });
    callback(data);
  };
  
  window.electron.on('server-java-download-progress', handleProgress);
  
  // Return cleanup function
  return () => {
    logger.debug('Removing server Java download progress listener', {
      category: 'utils',
      data: {
        function: 'onServerJavaDownloadProgress'
      }
    });
    window.electron.removeListener('server-java-download-progress', handleProgress);
  };
} 