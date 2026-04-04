// Config IPC handlers
const fs = require('fs');
const path = require('path');
const { getLoggerHandlers } = require('./logger-handlers.cjs');
const {
  readServerConfig,
  writeServerConfig,
  updateServerConfig
} = require('../utils/config-manager.cjs');

const logger = getLoggerHandlers();

/**
 * Create config IPC handlers
 * 
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createConfigHandlers() {
  logger.info('Config handlers initialized', {
    category: 'settings',
    data: { handler: 'createConfigHandlers' }
  });

  return {
    'read-config': async (_e, serverPath) => {
      const startTime = Date.now();
      
      logger.debug('Reading configuration file', {
        category: 'settings',
        data: {
          handler: 'read-config',
          serverPath,
          sender: _e.sender.id
        }
      });

      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          logger.error('Invalid server path for config read', {
            category: 'settings',
            data: {
              handler: 'read-config',
              serverPath,
              pathExists: serverPath ? fs.existsSync(serverPath) : false
            }
          });
          throw new Error('Invalid server path');
        }
        
        const configPath = path.join(serverPath, '.minecraft-core.json');
        
        if (!fs.existsSync(configPath)) {
          logger.debug('Config file does not exist', {
            category: 'settings',
            data: {
              handler: 'read-config',
              configPath,
              duration: Date.now() - startTime,
              fileExists: false
            }
          });
          return null; // No config file exists yet
        }
        
        logger.debug('Reading config file content', {
          category: 'storage',
          data: {
            handler: 'read-config',
            configPath
          }
        });

        let rawConfig = null;
        try {
          rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (parseError) {
          logger.warn('Failed to parse raw config before normalization', {
            category: 'settings',
            data: {
              handler: 'read-config',
              errorType: parseError.constructor.name,
              errorMessage: parseError.message,
              configPath
            }
          });
        }

        const config = readServerConfig(serverPath);
        if (!config) {
          return null;
        }

        if (!rawConfig || JSON.stringify(rawConfig) !== JSON.stringify(config)) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
        
        const duration = Date.now() - startTime;

        logger.info('Configuration file read successfully', {
          category: 'performance',
          data: {
            handler: 'read-config',
            duration,
            configPath,
            hasVersion: !!config.version,
            hasFabric: !!config.fabric,
            hasPort: !!config.port,
            hasLoader: !!config.loader,
            hasLoaderVersion: !!config.loaderVersion,
            hasJavaVersion: !!config.javaVersion,
            configKeys: Object.keys(config)
          }
        });

        return config;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to read config: ${error.message}`, {
          category: 'settings',
          data: {
            handler: 'read-config',
            errorType: error.constructor.name,
            duration,
            serverPath
          }
        });
        throw error;
      }
    },
    
    'write-config': async (_e, { serverPath, config }) => {
      const startTime = Date.now();
      
      logger.debug('Writing configuration file', {
        category: 'settings',
        data: {
          handler: 'write-config',
          serverPath,
          hasConfig: !!config,
          configKeys: config ? Object.keys(config) : [],
          sender: _e.sender.id
        }
      });

      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          logger.error('Invalid server path for config write', {
            category: 'settings',
            data: {
              handler: 'write-config',
              serverPath,
              pathExists: serverPath ? fs.existsSync(serverPath) : false
            }
          });
          throw new Error('Invalid server path');
        }
        
        if (!config || typeof config !== 'object') {
          logger.error('Invalid configuration data for write', {
            category: 'settings',
            data: {
              handler: 'write-config',
              config,
              configType: typeof config,
              serverPath
            }
          });
          throw new Error('Invalid configuration data');
        }
        
        const configPath = path.join(serverPath, '.minecraft-core.json');
        
        logger.info('Writing configuration to file', {
          category: 'settings',
          data: {
            handler: 'write-config',
            configPath,
            configData: {
              version: config.version,
              fabric: config.fabric,
              port: config.port,
              maxRam: config.maxRam,
              autoRestart: config.autoRestart
            }
          }
        });

        const normalizedConfig = writeServerConfig(serverPath, config);
        const duration = Date.now() - startTime;

        logger.info('Configuration file written successfully', {
          category: 'performance',
          data: {
            handler: 'write-config',
            duration,
            success: true,
            configPath,
            configSize: JSON.stringify(normalizedConfig).length
          }
        });
        
        return { success: true, config: normalizedConfig };
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to write config: ${err.message}`, {
          category: 'settings',
          data: {
            handler: 'write-config',
            errorType: err.constructor.name,
            duration,
            serverPath,
            hasConfig: !!config
          }
        });
        return { success: false, error: err.message };
      }
    },
    'update-config': async (_e, { serverPath, updates }) => {
      const startTime = Date.now();
      
      logger.debug('Updating configuration file', {
        category: 'settings',
        data: {
          handler: 'update-config',
          serverPath,
          hasUpdates: !!updates,
          updateKeys: updates ? Object.keys(updates) : [],
          sender: _e.sender.id
        }
      });

      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          logger.error('Invalid server path for config update', {
            category: 'settings',
            data: {
              handler: 'update-config',
              serverPath,
              pathExists: serverPath ? fs.existsSync(serverPath) : false
            }
          });
          throw new Error('Invalid server path');
        }
        
        if (!updates || typeof updates !== 'object') {
          logger.error('Invalid update data for config update', {
            category: 'settings',
            data: {
              handler: 'update-config',
              updates,
              updatesType: typeof updates,
              serverPath
            }
          });
          throw new Error('Invalid update data');
        }
        
        const configPath = path.join(serverPath, '.minecraft-core.json');
        const previousConfig = readServerConfig(serverPath) || {};
        const updatedConfig = updateServerConfig(serverPath, updates);
        
        logger.info('Applying configuration updates', {
          category: 'settings',
          data: {
            handler: 'update-config',
            previousConfig: {
              version: previousConfig.version,
              loader: previousConfig.loader || null,
              loaderVersion: previousConfig.loaderVersion || previousConfig.fabric || null,
              fabric: previousConfig.fabric,
              port: previousConfig.port,
              maxRam: previousConfig.maxRam
            },
            updates: {
              version: updates.version,
              loader: updates.loader || null,
              loaderVersion: updates.loaderVersion || updates.fabric || null,
              fabric: updates.fabric,
              port: updates.port,
              maxRam: updates.maxRam
            },
            configPath
          }
        });

        // Perform server version cleanup if versions changed
        const versionChanged = updates.version && updates.version !== previousConfig.version;
        const previousLoaderVersion = previousConfig.loaderVersion || previousConfig.fabric || null;
        const nextLoaderVersion = updates.loaderVersion || updates.fabric || null;
        const loaderChanged =
          (updates.loader && updates.loader !== previousConfig.loader) ||
          (nextLoaderVersion && nextLoaderVersion !== previousLoaderVersion);
        
        if (versionChanged || loaderChanged) {
          logger.info('Version changes detected, performing cleanup', {
            category: 'settings',
            data: {
              handler: 'update-config',
              versionChanged,
              loaderChanged,
              oldVersion: previousConfig.version,
              newVersion: updates.version,
              oldLoader: previousConfig.loader || null,
              newLoader: updates.loader || null,
              oldLoaderVersion: previousLoaderVersion,
              newLoaderVersion: nextLoaderVersion,
              oldFabric: previousConfig.fabric,
              newFabric: updates.fabric
            }
          });

          await cleanupOldServerVersions(serverPath, previousConfig, updatedConfig);
        }

        const duration = Date.now() - startTime;

        logger.info('Configuration updated successfully', {
          category: 'performance',
          data: {
            handler: 'update-config',
            duration,
            success: true,
            configPath,
            versionChanged,
            loaderChanged,
            updatedKeys: Object.keys(updates)
          }
        });
        
        return { success: true, config: updatedConfig };
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to update config: ${err.message}`, {
          category: 'settings',
          data: {
            handler: 'update-config',
            errorType: err.constructor.name,
            duration,
            serverPath,
            hasUpdates: !!updates
          }
        });
        return { success: false, error: err.message };
      }
    }
  };
}

/**
 * Clean up old server version files after a version update
 * @param {string} serverPath - Path to the server directory
 * @param {object} oldConfig - Previous configuration for comparison
 */
function resolveConfigLoader(config = {}) {
  return config.loader || (config.fabric ? 'fabric' : 'vanilla');
}

function resolveConfigLoaderVersion(config = {}) {
  return config.loaderVersion || config.fabric || null;
}

function buildVersionDirectoryCandidates(config = {}) {
  const version = config.version || null;
  const loader = resolveConfigLoader(config);
  const loaderVersion = resolveConfigLoaderVersion(config);
  const candidates = new Set();

  if (!version) {
    return candidates;
  }

  candidates.add(version);

  if (loader === 'fabric' && loaderVersion) {
    candidates.add(`fabric-loader-${loaderVersion}-${version}`);
    candidates.add(`${version}-fabric${loaderVersion}`);
  }

  if (loader === 'forge' && loaderVersion) {
    candidates.add(`${version}-forge-${loaderVersion}`);
  }

  return candidates;
}

async function cleanupOldServerVersions(serverPath, oldConfig, nextConfig = {}) {
  const startTime = Date.now();
  const oldLoader = resolveConfigLoader(oldConfig);
  const oldLoaderVersion = resolveConfigLoaderVersion(oldConfig);
  const protectedVersionEntries = buildVersionDirectoryCandidates(nextConfig);
  
  logger.info('Starting server version cleanup', {
    category: 'storage',
    data: {
      function: 'cleanupOldServerVersions',
      serverPath,
      oldVersion: oldConfig.version,
      oldLoader,
      oldLoaderVersion,
      nextVersion: nextConfig.version || null,
      nextLoader: resolveConfigLoader(nextConfig),
      nextLoaderVersion: resolveConfigLoaderVersion(nextConfig)
    }
  });

  try {
    const filesToCleanup = [];
    // Files that typically contain version information and should be cleaned up
    const serverFiles = fs.readdirSync(serverPath);
    
    logger.debug('Scanning server directory for cleanup', {
      category: 'storage',
      data: {
        function: 'cleanupOldServerVersions',
        serverPath,
        fileCount: serverFiles.length
      }
    });
    
    // Clean up old version-specific files
    for (const file of serverFiles) {
      const filePath = path.join(serverPath, file);
      const stat = fs.lstatSync(filePath);
      
      if (stat.isFile()) {
        // Clean up version-specific downloaded vanilla server jars
        if (file.startsWith('minecraft_server.') && file.endsWith('.jar')) {
          const versionMatch = file.match(/minecraft_server\.(.+)\.jar/);
          if (versionMatch && oldConfig.version && versionMatch[1] === oldConfig.version) {
            filesToCleanup.push({ file, reason: `Old Minecraft server JAR (${oldConfig.version})` });
          }
        }

        // Clean up Fabric installer artifacts that are known to be replaceable.
        if (oldLoader === 'fabric' && file.endsWith('.jar') && file.includes('fabric-installer')) {
          if (oldLoaderVersion && file.includes(oldLoaderVersion) && !protectedVersionEntries.has(file.replace(/\.jar$/i, ''))) {
            filesToCleanup.push({ file, reason: `Old Fabric installer (${oldLoaderVersion})` });
          }
        }
        
        // Clean up old server backups that might have version info
        if (file.startsWith('server_backup_') && (file.includes(oldConfig.version) || (oldLoaderVersion && file.includes(oldLoaderVersion)))) {
          filesToCleanup.push({ file, reason: `Old version backup` });
        }
        
        // Clean up old logs that might be version-specific
        if (file.startsWith('latest.log') || file.startsWith('debug.log')) {
          // Skip - these are current logs
        } else if (file.endsWith('.log') && stat.mtime < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {
          // Old log files (older than 7 days)
          filesToCleanup.push({ file, reason: 'Old log file' });
        }      } else if (stat.isDirectory()) {
        // Keep libraries untouched. Loader installers manage these layouts and
        // aggressive cleanup can break Forge/Fabric runtimes.

        // Clean up exact old version directories without touching the current loader runtime.
        if (file === 'versions' && oldConfig.version) {
          const versionDir = path.join(serverPath, file);
          try {
            const versionDirContents = fs.readdirSync(versionDir);
            const oldCandidates = buildVersionDirectoryCandidates(oldConfig);
            for (const versionFile of versionDirContents) {
              if (oldCandidates.has(versionFile) && !protectedVersionEntries.has(versionFile)) {
                // Mark the entire version subdirectory for deletion
                filesToCleanup.push({ 
                  file: path.join(file, versionFile), 
                  reason: `Old version directory (${versionFile})`,
                  isDirectory: true
                });
              }
            }
          } catch {
            // Ignore directory read errors
          }
        }
      }    }
    
    // Delete identified files and directories
    logger.info('Cleaning up old server files', {
      category: 'storage',
      data: {
        function: 'cleanupOldServerVersions',
        filesToCleanup: filesToCleanup.map(f => ({ file: f.file, reason: f.reason })),
        cleanupCount: filesToCleanup.length
      }
    });

    let successCount = 0;
    let errorCount = 0;

    for (const { file, isDirectory, reason } of filesToCleanup) {
      try {
        const filePath = path.join(serverPath, file);
        
        logger.debug(`Deleting ${isDirectory ? 'directory' : 'file'}: ${file}`, {
          category: 'storage',
          data: {
            function: 'cleanupOldServerVersions',
            file,
            filePath,
            isDirectory: !!isDirectory,
            reason
          }
        });

        if (isDirectory) {
          // Delete directory recursively
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          // Delete file
          fs.unlinkSync(filePath);
        }
        
        successCount++;
      } catch (deleteError) {
        errorCount++;
        logger.warn(`Failed to delete ${isDirectory ? 'directory' : 'file'}: ${file}`, {
          category: 'storage',
          data: {
            function: 'cleanupOldServerVersions',
            file,
            isDirectory: !!isDirectory,
            reason,
            error: deleteError.message,
            errorType: deleteError.constructor.name
          }
        });
      }
    }

    const duration = Date.now() - startTime;

    logger.info('Server version cleanup completed', {
      category: 'performance',
      data: {
        function: 'cleanupOldServerVersions',
        duration,
        totalFiles: filesToCleanup.length,
        successCount,
        errorCount,
        serverPath
      }
    });
    
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`Error during server version cleanup: ${error.message}`, {
      category: 'storage',
      data: {
        function: 'cleanupOldServerVersions',
        errorType: error.constructor.name,
        duration,
        serverPath,
        oldVersion: oldConfig.version,
        oldLoader,
        oldLoaderVersion
      }
    });
    // Don't throw - cleanup is not critical for functionality
  }
}

// Export the function directly
module.exports = { createConfigHandlers };
