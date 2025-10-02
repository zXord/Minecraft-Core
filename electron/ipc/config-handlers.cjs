// Config IPC handlers
const fs = require('fs');
const path = require('path');
const { getLoggerHandlers } = require('./logger-handlers.cjs');
const { resolveServerLoader } = require('../utils/server-loader.cjs');

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

        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        
        // Enrich config with detected loader information if not present
        if (!config.loaderVersion) {
          try {
            const { loader, loaderVersion } = resolveServerLoader(serverPath);
            if (loader && !config.loader) {
              config.loader = loader;
            }
            if (loaderVersion) {
              config.loaderVersion = loaderVersion;
            }
          } catch (loaderError) {
            logger.warn('Failed to detect loader version', {
              category: 'settings',
              data: {
                handler: 'read-config',
                errorMessage: loaderError.message
              }
            });
          }
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

        // Write the config file
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        const duration = Date.now() - startTime;

        logger.info('Configuration file written successfully', {
          category: 'performance',
          data: {
            handler: 'write-config',
            duration,
            success: true,
            configPath,
            configSize: JSON.stringify(config).length
          }
        });
        
        return { success: true };
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
        let config = {};
        let previousConfig = {};

        // Read existing config if it exists
        if (fs.existsSync(configPath)) {
          logger.debug('Reading existing config for update', {
            category: 'storage',
            data: {
              handler: 'update-config',
              configPath,
              fileExists: true
            }
          });

          try {
            const content = fs.readFileSync(configPath, 'utf-8');
            config = JSON.parse(content);
            previousConfig = { ...config }; // Store previous state for cleanup
            
            logger.debug('Existing config loaded for update', {
              category: 'settings',
              data: {
                handler: 'update-config',
                existingKeys: Object.keys(config),
                previousVersion: previousConfig.version,
                previousFabric: previousConfig.fabric
              }
            });
          } catch (parseError) {
            logger.warn('Failed to parse existing config for update, using empty config', {
              category: 'settings',
              data: {
                handler: 'update-config',
                configPath,
                parseError: parseError.message
              }
            });
            // Continue with empty config
          }
        } else {
          logger.debug('No existing config file found for update', {
            category: 'settings',
            data: {
              handler: 'update-config',
              configPath,
              fileExists: false
            }
          });
        }

        // Update with new values
        const updatedConfig = { ...config, ...updates };
        
        logger.info('Applying configuration updates', {
          category: 'settings',
          data: {
            handler: 'update-config',
            previousConfig: {
              version: previousConfig.version,
              fabric: previousConfig.fabric,
              port: previousConfig.port,
              maxRam: previousConfig.maxRam
            },
            updates: {
              version: updates.version,
              fabric: updates.fabric,
              port: updates.port,
              maxRam: updates.maxRam
            },
            configPath
          }
        });

        // Write back to file
        fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
        
        // Perform server version cleanup if versions changed
        const versionChanged = updates.version && updates.version !== previousConfig.version;
        const fabricChanged = updates.fabric && updates.fabric !== previousConfig.fabric;
        
        if (versionChanged || fabricChanged) {
          logger.info('Version changes detected, performing cleanup', {
            category: 'settings',
            data: {
              handler: 'update-config',
              versionChanged,
              fabricChanged,
              oldVersion: previousConfig.version,
              newVersion: updates.version,
              oldFabric: previousConfig.fabric,
              newFabric: updates.fabric
            }
          });

          await cleanupOldServerVersions(serverPath, previousConfig);
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
            fabricChanged,
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
async function cleanupOldServerVersions(serverPath, oldConfig) {
  const startTime = Date.now();
  
  logger.info('Starting server version cleanup', {
    category: 'storage',
    data: {
      function: 'cleanupOldServerVersions',
      serverPath,
      oldVersion: oldConfig.version,
      oldFabric: oldConfig.fabric
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
        // Clean up old server JARs with various naming patterns
        if (file.endsWith('.jar')) {
          // Patterns: minecraft_server.1.21.1.jar, server.jar (but check dates), fabric-server-*.jar, etc.
          if (file.includes('minecraft_server') || file.includes('fabric-server') || file.includes('server-launch')) {
            // Check if this file contains the old version or is older than expected
            if (oldConfig.version && (file.includes(oldConfig.version) || file.includes(oldConfig.version.replace('.', '_')))) {
              filesToCleanup.push({ file, reason: `Old Minecraft server JAR (${oldConfig.version})` });
            }
          }
          
          // Clean up old fabric installer JARs
          if (file.includes('fabric-installer') || file.includes('fabric-loader')) {
            if (oldConfig.fabric && (file.includes(oldConfig.fabric) || file.includes(oldConfig.fabric.replace('.', '_')))) {
              filesToCleanup.push({ file, reason: `Old Fabric installer (${oldConfig.fabric})` });
            }
          }
        }
          // Clean up version-specific downloaded files
        if (file.startsWith('minecraft_server.') && file.endsWith('.jar')) {
          const versionMatch = file.match(/minecraft_server\.(.+)\.jar/);
          if (versionMatch && oldConfig.version && versionMatch[1] === oldConfig.version) {
            filesToCleanup.push({ file, reason: `Old Minecraft server JAR (${oldConfig.version})` });
          }
        }
        
        // Clean up server JAR files with version in name (various patterns)
        if (file.endsWith('.jar') && oldConfig.version) {
          // Pattern: server-1.21.3.jar, fabric-server-mc.1.21.3-loader.0.16.9-launcher.1.0.2.jar, etc.
          if (file.includes(oldConfig.version.replace(/\./g, '\\.')) || 
              file.includes(oldConfig.version.replace(/\./g, '-')) ||
              file.includes(`mc.${oldConfig.version}`) ||
              file.includes(`mc${oldConfig.version}`)) {
            filesToCleanup.push({ file, reason: `Old server JAR with version (${oldConfig.version})` });
          }
        }
        
        // NOTE: Do NOT clean up fabric-server-launch.jar - it's the current launcher file needed to run the server
        // Only clean up version-specific fabric server JARs that contain old version numbers
        if (file.includes('fabric-server') && file.endsWith('.jar') && file !== 'fabric-server-launch.jar') {
          // Only delete fabric server JARs that contain the old MC version
          if (oldConfig.version && (file.includes(oldConfig.version) || file.includes(`mc.${oldConfig.version}`) || file.includes(`mc${oldConfig.version}`))) {
            filesToCleanup.push({ file, reason: `Old Fabric server JAR with version (${oldConfig.version})` });
          }
        }
        
        // Clean up old server backups that might have version info
        if (file.startsWith('server_backup_') && (file.includes(oldConfig.version) || file.includes(oldConfig.fabric))) {
          filesToCleanup.push({ file, reason: `Old version backup` });
        }
        
        // Clean up old logs that might be version-specific
        if (file.startsWith('latest.log') || file.startsWith('debug.log')) {
          // Skip - these are current logs
        } else if (file.endsWith('.log') && stat.mtime < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {
          // Old log files (older than 7 days)
          filesToCleanup.push({ file, reason: 'Old log file' });
        }      } else if (stat.isDirectory()) {
        // Clean up libraries directory if it exists (Fabric libraries)
        if (file === 'libraries') {
          // Fabric creates version-specific library structures
          // We could clean this up but it's safer to leave it for manual cleanup
        }
          // Clean up version-specific directories
        if (file === 'versions' && oldConfig.version) {
          const versionDir = path.join(serverPath, file);
          try {
            const versionDirContents = fs.readdirSync(versionDir);
            for (const versionFile of versionDirContents) {
              if (versionFile === oldConfig.version || versionFile.includes(oldConfig.version)) {
                // Mark the entire version subdirectory for deletion
                filesToCleanup.push({ 
                  file: path.join(file, versionFile), 
                  reason: `Old version directory (${oldConfig.version})`,
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
        oldFabric: oldConfig.fabric
      }
    });
    // Don't throw - cleanup is not critical for functionality
  }
}

// Export the function directly
module.exports = { createConfigHandlers };
