// Config file management utilities
const fs = require('fs');
const path = require('path');

// Lazy logger initialization to avoid circular dependency
let logger = null;
const getLogger = () => {
  if (!logger) {
    try {
      const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');
      logger = getLoggerHandlers();
    } catch {
      // Fallback to console if logger not available
      logger = {
        debug: console.log,
        info: console.log,
        warn: console.warn,
        error: console.error
      };
    }
  }
  return logger;
};

/**
 * Detects Minecraft version from server JAR files
 * @param {string} serverPath - Path to the server directory
 * @returns {string|null} Detected version or null if not found
 */
function detectMinecraftVersion(serverPath) {
  getLogger().debug('Starting Minecraft version detection', {
    category: 'settings',
    data: {
      function: 'detectMinecraftVersion',
      serverPath,
      pathExists: fs.existsSync(serverPath)
    }
  });

  try {
    if (!fs.existsSync(serverPath)) {
      getLogger().warn('Server path does not exist for version detection', {
        category: 'settings',
        data: {
          function: 'detectMinecraftVersion',
          serverPath,
          reason: 'path_not_found'
        }
      });
      return null;
    }
    
    const files = fs.readdirSync(serverPath);
    const serverJars = files.filter(file =>
      file.endsWith('.jar') && (
        file.includes('server') ||
        file.includes('minecraft') ||
        file.includes('paper') || 
        file.includes('forge') || 
        file.includes('fabric') ||
        file === 'fabric-server-launch.jar'
      )
    );
    
    getLogger().debug('Found JAR files for version detection', {
      category: 'settings',
      data: {
        function: 'detectMinecraftVersion',
        serverPath,
        totalFiles: files.length,
        jarFiles: serverJars.length,
        jarNames: serverJars
      }
    });
    
    // Try to extract version from jar filenames
    for (const jarName of serverJars) {
      const versionMatch = jarName.match(/(\d+\.\d+(?:\.\d+)?)/);
      if (versionMatch) {
        const detectedVersion = versionMatch[1];
        getLogger().info('Version detected from JAR filename', {
          category: 'settings',
          data: {
            function: 'detectMinecraftVersion',
            serverPath,
            jarName,
            detectedVersion,
            detectionMethod: 'jar_filename'
          }
        });
        return detectedVersion;
      }
    }
    
    // Check for version.json file (vanilla servers)
    const versionPath = path.join(serverPath, 'version.json');
    if (fs.existsSync(versionPath)) {
      getLogger().debug('Checking version.json file', {
        category: 'settings',
        data: {
          function: 'detectMinecraftVersion',
          serverPath,
          versionPath
        }
      });

      try {
        const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
        if (versionData.name || versionData.id) {
          const detectedVersion = versionData.name || versionData.id;
          getLogger().info('Version detected from version.json', {
            category: 'settings',
            data: {
              function: 'detectMinecraftVersion',
              serverPath,
              detectedVersion,
              detectionMethod: 'version_json',
              versionData: { name: versionData.name, id: versionData.id }
            }
          });
          return detectedVersion;
        }
      } catch (error) {
        getLogger().warn('Failed to parse version.json file', {
          category: 'settings',
          data: {
            function: 'detectMinecraftVersion',
            serverPath,
            versionPath,
            errorType: error.constructor.name,
            errorMessage: error.message
          }
        });
        // Continue with other methods
      }
    }
    
    getLogger().warn('No version could be detected', {
      category: 'settings',
      data: {
        function: 'detectMinecraftVersion',
        serverPath,
        jarCount: serverJars.length,
        versionJsonExists: fs.existsSync(versionPath)
      }
    });
    return null;
  } catch (error) {
    getLogger().error(`Version detection failed: ${error.message}`, {
      category: 'settings',
      data: {
        function: 'detectMinecraftVersion',
        serverPath,
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    });
    return null;
  }
}

/**
 * Ensures a .minecraft-core.json config file exists in the given server directory
 * 
 * @param {string} serverPath - Path to the server directory
 * @param {object} defaultSettings - Default settings to use if config doesn't exist
 * @returns {object} The current config (either existing or newly created)
 */
function ensureConfigFile(serverPath, defaultSettings = {}) {
  getLogger().debug('Ensuring config file exists', {
    category: 'settings',
    data: {
      function: 'ensureConfigFile',
      serverPath,
      hasDefaultSettings: Object.keys(defaultSettings).length > 0,
      defaultSettingsKeys: Object.keys(defaultSettings)
    }
  });

  if (!serverPath) {
    getLogger().warn('No server path provided for config file', {
      category: 'settings',
      data: {
        function: 'ensureConfigFile',
        reason: 'no_server_path'
      }
    });
    return null;
  }
  
  try {
    // Check if the directory exists
    if (!fs.existsSync(serverPath)) {
      getLogger().warn('Server directory does not exist', {
        category: 'settings',
        data: {
          function: 'ensureConfigFile',
          serverPath,
          reason: 'directory_not_found'
        }
      });
      return null;
    }
    
    const configPath = path.join(serverPath, '.minecraft-core.json');
    let config = defaultSettings;
    let configExists = false;
    let configCorrupted = false;

    // Try to read existing config
    if (fs.existsSync(configPath)) {
      configExists = true;
      getLogger().debug('Existing config file found', {
        category: 'settings',
        data: {
          function: 'ensureConfigFile',
          serverPath,
          configPath
        }
      });

      try {
        const configData = fs.readFileSync(configPath, 'utf8');
        const parsedConfig = JSON.parse(configData);
        config = parsedConfig;
        
        getLogger().info('Config file loaded successfully', {
          category: 'settings',
          data: {
            function: 'ensureConfigFile',
            serverPath,
            configKeys: Object.keys(config),
            configSize: configData.length,
            hasVersion: !!config.version,
            managedBy: config.managedBy
          }
        });
      } catch (error) {
        configCorrupted = true;
        getLogger().error(`Config file corrupted, using defaults: ${error.message}`, {
          category: 'settings',
          data: {
            function: 'ensureConfigFile',
            serverPath,
            configPath,
            errorType: error.constructor.name,
            errorMessage: error.message,
            recovery: 'using_defaults'
          }
        });
        // Will use the default settings if there's an error
      }
    } else {
      getLogger().info('No existing config file, creating new one', {
        category: 'settings',
        data: {
          function: 'ensureConfigFile',
          serverPath,
          configPath,
          action: 'creating_new'
        }
      });
    }
    
    // Merge with defaults to ensure all fields exist
    const originalConfig = { ...config };
    config = {
      ...defaultSettings,
      ...config
    };
    
    const configChanged = JSON.stringify(originalConfig) !== JSON.stringify(config);
    if (configChanged) {
      getLogger().debug('Config merged with defaults', {
        category: 'settings',
        data: {
          function: 'ensureConfigFile',
          serverPath,
          originalKeys: Object.keys(originalConfig),
          mergedKeys: Object.keys(config),
          addedKeys: Object.keys(config).filter(key => !(key in originalConfig))
        }
      });
    }
    
    // AUTO-DETECT version if not provided and not already in config
    if (!config.version) {
      getLogger().debug('No version in config, attempting auto-detection', {
        category: 'settings',
        data: {
          function: 'ensureConfigFile',
          serverPath,
          action: 'version_detection'
        }
      });

      const detectedVersion = detectMinecraftVersion(serverPath);
      if (detectedVersion) {
        config.version = detectedVersion;
        config.detectedAt = new Date().toISOString();
        config.detectionMethod = 'automatic';
        
        getLogger().info('Version auto-detected and added to config', {
          category: 'settings',
          data: {
            function: 'ensureConfigFile',
            serverPath,
            detectedVersion,
            detectedAt: config.detectedAt
          }
        });
      } else {
        getLogger().warn('Version auto-detection failed', {
          category: 'settings',
          data: {
            function: 'ensureConfigFile',
            serverPath,
            reason: 'detection_failed'
          }
        });
      }
    }
    
    // Set managedBy field to identify our config files
    if (!config.managedBy) {
      config.managedBy = 'minecraft-core';
      getLogger().debug('Added managedBy field to config', {
        category: 'settings',
        data: {
          function: 'ensureConfigFile',
          serverPath,
          managedBy: config.managedBy
        }
      });
    }

    // Write the config back to ensure all fields are present
    try {
      const configJson = JSON.stringify(config, null, 2);
      fs.writeFileSync(configPath, configJson, 'utf8');
      
      getLogger().info('Config file written successfully', {
        category: 'settings',
        data: {
          function: 'ensureConfigFile',
          serverPath,
          configPath,
          configSize: configJson.length,
          wasExisting: configExists,
          wasCorrupted: configCorrupted,
          hasVersion: !!config.version,
          configKeys: Object.keys(config)
        }
      });
    } catch (error) {
      getLogger().error(`Failed to write config file: ${error.message}`, {
        category: 'settings',
        data: {
          function: 'ensureConfigFile',
          serverPath,
          configPath,
          errorType: error.constructor.name,
          errorMessage: error.message,
          recovery: 'returning_config_anyway'
        }
      });
      // Ignore write errors - will return config anyway
    }

    return config;
  } catch (error) {
    getLogger().error(`Config file management failed: ${error.message}`, {
      category: 'settings',
      data: {
        function: 'ensureConfigFile',
        serverPath,
        errorType: error.constructor.name,
        errorMessage: error.message,
        stack: error.stack
      }
    });
    return null;
  }
}

module.exports = {
  ensureConfigFile,
  detectMinecraftVersion
};
