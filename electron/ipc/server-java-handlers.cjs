const { ServerJavaManager } = require('../services/server-java-manager.cjs');

// Global server Java manager instance (will be updated per server)
let serverJavaManager = new ServerJavaManager();

/**
 * Create server Java management IPC handlers
 * @param {object} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createServerJavaHandlers(win) {
  return {
    /**
     * Check Java requirements for a specific Minecraft version
     */
    'server-java-check-requirements': async (_e, { minecraftVersion, serverPath }) => {
      try {
        if (!minecraftVersion) {
          throw new Error('Minecraft version is required');
        }
        
        // Set server path if provided
        if (serverPath) {
          serverJavaManager.setServerPath(serverPath);
        }
        
        return serverJavaManager.getJavaRequirementsForMinecraft(minecraftVersion);
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    },
    
    /**
     * Ensure Java is available for a Minecraft version (download if needed)
     */
    'server-java-ensure': async (_e, { minecraftVersion, serverPath }) => {
      try {
        if (!minecraftVersion) {
          throw new Error('Minecraft version is required');
        }
        
        // Set server path if provided
        if (serverPath) {
          serverJavaManager.setServerPath(serverPath);
        }
        
        return await serverJavaManager.ensureJavaForMinecraft(
          minecraftVersion,
          (progress) => {
            // Send progress updates to the renderer
            if (win && !win.isDestroyed()) {
              win.webContents.send('server-java-download-progress', {
                minecraftVersion,
                serverPath,
                ...progress
              });
            }
          }
        );
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    },
    
    /**
     * Get the best Java path for a Minecraft version
     */
    'server-java-get-path': async (_e, { minecraftVersion, serverPath }) => {
      try {
        if (!minecraftVersion) {
          throw new Error('Minecraft version is required');
        }
        
        // Set server path if provided
        if (serverPath) {
          serverJavaManager.setServerPath(serverPath);
        }
        
        const javaPath = serverJavaManager.getBestJavaPathForMinecraft(minecraftVersion);
        
        return {
          success: true,
          javaPath,
          available: !!javaPath
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    },
    
    /**
     * Get all available Java versions
     */
    'server-java-get-available-versions': async (_e, params = {}) => {
      try {
        // Set server path if provided
        if (params.serverPath) {
          serverJavaManager.setServerPath(params.serverPath);
        }
        
        const versions = serverJavaManager.getAvailableJavaVersions();
        
        return {
          success: true,
          versions
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          versions: []
        };
      }
    },
    
    /**
     * Check if correct Java is available for a Minecraft version (quick check)
     */
    'server-java-is-available': async (_e, { minecraftVersion, serverPath }) => {
      try {
        if (!minecraftVersion) {
          throw new Error('Minecraft version is required');
        }
        
        // Set server path if provided
        if (serverPath) {
          serverJavaManager.setServerPath(serverPath);
        }
        
        const isAvailable = serverJavaManager.isCorrectJavaAvailableForMinecraft(minecraftVersion);
        
        return {
          success: true,
          available: isAvailable,
          minecraftVersion
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          available: false
        };
      }
    }
  };
}

module.exports = { createServerJavaHandlers }; 