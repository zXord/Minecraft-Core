/**
 * Server Java Management Utilities
 * Frontend interface for server Java version management
 */

/**
 * Check Java requirements for a specific Minecraft version
 * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
 * @param {string} serverPath - Server path (optional, will use current server if not provided)
 * @returns {Promise<Object>} - Java requirement information
 */
export async function checkServerJavaRequirements(minecraftVersion, serverPath = null) {
  try {
    const result = await window.electron.invoke('server-java-check-requirements', {
      minecraftVersion,
      serverPath
    });
    
    return result;
  } catch (error) {
    console.error('Error checking server Java requirements:', error);
    return {
      success: false,
      error: error.message,
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
  try {
    const result = await window.electron.invoke('server-java-ensure', {
      minecraftVersion,
      serverPath
    });
    
    return result;
  } catch (error) {
    console.error('Error ensuring server Java:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get the Java path for a Minecraft version
 * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
 * @returns {Promise<Object>} - Java path information
 */
export async function getServerJavaPath(minecraftVersion) {
  try {
    const result = await window.electron.invoke('server-java-get-path', {
      minecraftVersion
    });
    
    return result;
  } catch (error) {
    console.error('Error getting server Java path:', error);
    return {
      success: false,
      error: error.message,
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
  try {
    const result = await window.electron.invoke('server-java-is-available', {
      minecraftVersion
    });
    
    return result;
  } catch (error) {
    console.error('Error checking server Java availability:', error);
    return {
      success: false,
      error: error.message,
      available: false
    };
  }
}

/**
 * Get all available Java versions for servers
 * @returns {Promise<Object>} - Available Java versions
 */
export async function getAvailableServerJavaVersions() {
  try {
    const result = await window.electron.invoke('server-java-get-available-versions');
    
    return result;
  } catch (error) {
    console.error('Error getting available server Java versions:', error);
    return {
      success: false,
      error: error.message,
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
  const handleProgress = (data) => {
    callback(data);
  };
  
  window.electron.on('server-java-download-progress', handleProgress);
  
  // Return cleanup function
  return () => {
    window.electron.removeListener('server-java-download-progress', handleProgress);
  };
} 