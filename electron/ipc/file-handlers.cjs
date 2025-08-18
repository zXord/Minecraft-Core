// File and folder IPC handlers
const fs = require('fs');
const path = require('path');
const fsPromises = require('fs/promises');
const { dialog, shell } = require('electron');
const appStore = require('../utils/app-store.cjs');
const { ensureConfigFile } = require('../utils/config-manager.cjs');
const { createZip } = require('../utils/backup-util.cjs');
const { getLoggerHandlers } = require('./logger-handlers.cjs');

const logger = getLoggerHandlers();

/**
 * Create file and folder management IPC handlers
 * 
 * @param {object} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
/**
 * Calculate file checksum using Node.js crypto
 * 
 * @param {string} filePath - Path to the file
 * @param {string} algorithm - Hash algorithm to use
 * @returns {Promise<string>} - Calculated checksum
 */
async function calculateFileChecksum(filePath, algorithm = 'sha1') {
  const crypto = require('crypto');
  const startTime = Date.now();
  
  logger.debug('Starting file checksum calculation', {
    category: 'storage',
    data: {
      function: 'calculateFileChecksum',
      filePath,
      algorithm
    }
  });

  try {
    if (!filePath) {
      throw new Error('File path is required');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    // Validate algorithm
    const supportedAlgorithms = ['sha1', 'sha256', 'md5'];
    if (!supportedAlgorithms.includes(algorithm.toLowerCase())) {
      throw new Error(`Unsupported algorithm: ${algorithm}. Supported: ${supportedAlgorithms.join(', ')}`);
    }

    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);

    return new Promise((resolve, reject) => {
      stream.on('error', (error) => {
        const duration = Date.now() - startTime;
        logger.error(`File stream error during checksum calculation: ${error.message}`, {
          category: 'storage',
          data: {
            function: 'calculateFileChecksum',
            filePath,
            algorithm,
            duration,
            errorType: error.constructor.name
          }
        });
        reject(new Error(`File stream error: ${error.message}`));
      });

      stream.on('data', (chunk) => {
        hash.update(chunk);
      });

      stream.on('end', () => {
        const checksum = hash.digest('hex');
        const duration = Date.now() - startTime;

        logger.info('File checksum calculated successfully', {
          category: 'performance',
          data: {
            function: 'calculateFileChecksum',
            filePath,
            algorithm,
            checksumLength: checksum.length,
            duration,
            success: true
          }
        });

        resolve(checksum);
      });
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`Checksum calculation failed: ${error.message}`, {
      category: 'storage',
      data: {
        function: 'calculateFileChecksum',
        filePath,
        algorithm,
        duration,
        errorType: error.constructor.name
      }
    });
    throw error;
  }
}

function createFileHandlers(win) {
  logger.info('File handlers initialized', {
    category: 'storage',
    data: { handler: 'createFileHandlers', hasWindow: !!win }
  });

  return {
    'get-last-server-path': () => {
      const startTime = Date.now();
      
      logger.debug('Retrieving last server path', {
        category: 'storage',
        data: { handler: 'get-last-server-path' }
      });

      try {
        const serverPath = appStore.get('lastServerPath') || null;
        const serverSettings = appStore.get('serverSettings') || {
          port: 25565,
          maxRam: 4,
          autoStartMinecraft: false,
          autoStartManagement: false
        };

        const result = {
          path: serverPath,
          serverSettings
        };

        const duration = Date.now() - startTime;

        logger.debug('Last server path retrieved', {
          category: 'performance',
          data: {
            handler: 'get-last-server-path',
            duration,
            hasPath: !!serverPath,
            hasSettings: !!serverSettings
          }
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to get last server path: ${error.message}`, {
          category: 'storage',
          data: {
            handler: 'get-last-server-path',
            errorType: error.constructor.name,
            duration
          }
        });
        throw error;
      }
    },
    
    'set-server-path': (_e, path) => {
      const startTime = Date.now();
      
      logger.debug('Setting server path', {
        category: 'storage',
        data: {
          handler: 'set-server-path',
          path,
          sender: _e.sender.id
        }
      });

      if (!path) {
        logger.error('Invalid path provided to set-server-path', {
          category: 'storage',
          data: {
            handler: 'set-server-path',
            path,
            pathType: typeof path
          }
        });
        return { success: false, error: 'Invalid path' };
      }
      
      try {
        // Verify path exists
        if (!fs.existsSync(path)) {
          logger.error('Server path does not exist', {
            category: 'storage',
            data: {
              handler: 'set-server-path',
              path,
              pathExists: false
            }
          });
          return { success: false, error: 'Path does not exist' };
        }
        
        logger.debug('Path validation successful', {
          category: 'storage',
          data: {
            handler: 'set-server-path',
            path,
            pathExists: true
          }
        });

        // Save to persistent store
        appStore.set('lastServerPath', path);
        
        logger.info('Server path saved to store', {
          category: 'storage',
          data: {
            handler: 'set-server-path',
            path,
            storeKey: 'lastServerPath'
          }
        });

        // Notify the renderer
        if (win && win.webContents) {
          win.webContents.send('update-server-path', path);
          logger.debug('Server path update sent to renderer', {
            category: 'core',
            data: {
              handler: 'set-server-path',
              path,
              windowId: win.id
            }
          });
        }

        const duration = Date.now() - startTime;
        
        logger.info('Server path set successfully', {
          category: 'performance',
          data: {
            handler: 'set-server-path',
            duration,
            success: true,
            path
          }
        });
        
        return { success: true, path };
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to set server path: ${err.message}`, {
          category: 'storage',
          data: {
            handler: 'set-server-path',
            errorType: err.constructor.name,
            duration,
            path
          }
        });
        return { success: false, error: err.message };
      }
    },
    
    'update-server-path': (_e, path) => {
      const startTime = Date.now();
      
      logger.debug('Updating server path', {
        category: 'storage',
        data: {
          handler: 'update-server-path',
          path,
          sender: _e.sender.id
        }
      });

      if (!path) {
        logger.error('Invalid path provided to update-server-path', {
          category: 'storage',
          data: {
            handler: 'update-server-path',
            path,
            pathType: typeof path
          }
        });
        return { success: false, error: 'Invalid path' };
      }
      
      try {
        // Verify path exists
        if (!fs.existsSync(path)) {
          logger.error('Server path does not exist for update', {
            category: 'storage',
            data: {
              handler: 'update-server-path',
              path,
              pathExists: false
            }
          });
          return { success: false, error: 'Path does not exist' };
        }
        
        logger.debug('Path validation successful for update', {
          category: 'storage',
          data: {
            handler: 'update-server-path',
            path,
            pathExists: true
          }
        });

        // Save to persistent store
        appStore.set('lastServerPath', path);
        
        logger.info('Server path updated in store', {
          category: 'storage',
          data: {
            handler: 'update-server-path',
            path,
            storeKey: 'lastServerPath'
          }
        });

        // Notify the renderer
        if (win && win.webContents) {
          win.webContents.send('update-server-path', path);
          logger.debug('Server path update notification sent to renderer', {
            category: 'core',
            data: {
              handler: 'update-server-path',
              path,
              windowId: win.id
            }
          });
        }

        const duration = Date.now() - startTime;
        
        logger.info('Server path updated successfully', {
          category: 'performance',
          data: {
            handler: 'update-server-path',
            duration,
            success: true,
            path
          }
        });
        
        return { success: true, path };
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to update server path: ${err.message}`, {
          category: 'storage',
          data: {
            handler: 'update-server-path',
            errorType: err.constructor.name,
            duration,
            path
          }
        });
        return { success: false, error: err.message };
      }
    },
    
    'select-folder': async () => {
      const startTime = Date.now();
      
      logger.debug('Folder selection dialog requested', {
        category: 'storage',
        data: { handler: 'select-folder' }
      });

      try {
        const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        
        if (canceled) {
          logger.debug('Folder selection cancelled by user', {
            category: 'storage',
            data: {
              handler: 'select-folder',
              duration: Date.now() - startTime,
              cancelled: true
            }
          });
          return null;
        }

        const folder = filePaths[0];
        
        logger.info('Folder selected', {
          category: 'storage',
          data: {
            handler: 'select-folder',
            folder,
            folderName: path.basename(folder)
          }
        });

        // Create needed directories
        const requiredDirs = ['mods', 'logs', 'config'];
        
        logger.debug('Creating required directories', {
          category: 'storage',
          data: {
            handler: 'select-folder',
            folder,
            directories: requiredDirs
          }
        });

        try {
          requiredDirs.forEach(dir => {
            const dirPath = path.join(folder, dir);
            fs.mkdirSync(dirPath, { recursive: true });
            logger.debug(`Directory created: ${dir}`, {
              category: 'storage',
              data: {
                handler: 'select-folder',
                directory: dir,
                fullPath: dirPath
              }
            });
          });
        } catch (err) {
          logger.error(`Failed to create directories: ${err.message}`, {
            category: 'storage',
            data: {
              handler: 'select-folder',
              folder,
              directories: requiredDirs,
              errorType: err.constructor.name
            }
          });
          throw new Error(`Failed to create directories: ${err.message}`);
        }
        
        // Ensure config file exists with defaults
        const serverSettings = appStore.get('serverSettings') || {
          port: 25565,
          maxRam: 4,
          autoStartMinecraft: false,
          autoStartManagement: false
        };
        const autoRestart = appStore.get('autoRestart') || { enabled: false, delay: 10, maxCrashes: 3 };
        
        const configData = {
          version: null,
          fabric: null,
          port: serverSettings.port,
          maxRam: serverSettings.maxRam,
          autoRestart: {
            enabled: autoRestart.enabled,
            delay: autoRestart.delay, 
            maxCrashes: autoRestart.maxCrashes
          }
        };

        logger.debug('Creating config file with defaults', {
          category: 'settings',
          data: {
            handler: 'select-folder',
            folder,
            configData: {
              port: configData.port,
              maxRam: configData.maxRam,
              autoRestartEnabled: configData.autoRestart.enabled
            }
          }
        });
        
        ensureConfigFile(folder, configData);
        
        // Save path to persistent store
        appStore.set('lastServerPath', folder);
        
        logger.info('Server path saved to store', {
          category: 'storage',
          data: {
            handler: 'select-folder',
            folder,
            storeKey: 'lastServerPath'
          }
        });

        // Share selected path with renderer through preload script
        if (win && win.webContents) {
          win.webContents.send('update-server-path', folder);
          logger.debug('Selected folder path sent to renderer', {
            category: 'core',
            data: {
              handler: 'select-folder',
              folder,
              windowId: win.id
            }
          });
        }

        const duration = Date.now() - startTime;

        logger.info('Folder selection completed successfully', {
          category: 'performance',
          data: {
            handler: 'select-folder',
            duration,
            success: true,
            folder,
            directoriesCreated: requiredDirs.length
          }
        });

        return folder;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Folder selection failed: ${error.message}`, {
          category: 'storage',
          data: {
            handler: 'select-folder',
            errorType: error.constructor.name,
            duration
          }
        });
        throw error;
      }
    },
    
    'open-folder': async (_e, folderPath) => {
      const startTime = Date.now();
      
      logger.debug('Opening folder in system explorer', {
        category: 'storage',
        data: {
          handler: 'open-folder',
          folderPath,
          sender: _e.sender.id
        }
      });

      try {
        if (!folderPath || !fs.existsSync(folderPath)) {
          logger.error('Invalid or non-existent folder path', {
            category: 'storage',
            data: {
              handler: 'open-folder',
              folderPath,
              pathExists: folderPath ? fs.existsSync(folderPath) : false
            }
          });
          throw new Error('Invalid or non-existent folder path');
        }

        logger.info('Opening folder in system explorer', {
          category: 'storage',
          data: {
            handler: 'open-folder',
            folderPath,
            folderName: path.basename(folderPath)
          }
        });

        await shell.openPath(folderPath);
        const duration = Date.now() - startTime;

        logger.info('Folder opened successfully', {
          category: 'performance',
          data: {
            handler: 'open-folder',
            duration,
            success: true,
            folderPath
          }
        });

        return { success: true };
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to open folder: ${err.message}`, {
          category: 'storage',
          data: {
            handler: 'open-folder',
            errorType: err.constructor.name,
            duration,
            folderPath
          }
        });
        throw new Error(`Failed to open folder: ${err.message}`);
      }
    },
    
    'read-config': (_e, targetPath) => {
      const startTime = Date.now();
      
      logger.debug('Reading configuration file', {
        category: 'settings',
        data: {
          handler: 'read-config',
          targetPath,
          sender: _e.sender.id
        }
      });

      try {
        if (!targetPath) {
          logger.debug('No target path provided for config read', {
            category: 'settings',
            data: {
              handler: 'read-config',
              duration: Date.now() - startTime,
              targetPath
            }
          });
          return null;
        }

        const configPath = path.join(targetPath, '.minecraft-core.json');
        
        if (!fs.existsSync(configPath)) {
          logger.debug('Config file does not exist', {
            category: 'settings',
            data: {
              handler: 'read-config',
              duration: Date.now() - startTime,
              configPath,
              fileExists: false
            }
          });
          return null;
        }

        logger.debug('Reading config file', {
          category: 'storage',
          data: {
            handler: 'read-config',
            configPath,
            fileExists: true
          }
        });

        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);
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
            configKeys: Object.keys(config)
          }
        });

        return config;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to read config file: ${error.message}`, {
          category: 'settings',
          data: {
            handler: 'read-config',
            errorType: error.constructor.name,
            duration,
            targetPath,
            configPath: targetPath ? path.join(targetPath, '.minecraft-core.json') : null
          }
        });
        return null;
      }
    },
    
    'save-version-selection': (_e, { path: targetPath, mcVersion, fabricVersion }) => {
      const startTime = Date.now();
      
      logger.debug('Saving version selection', {
        category: 'settings',
        data: {
          handler: 'save-version-selection',
          targetPath,
          mcVersion,
          fabricVersion,
          sender: _e.sender.id
        }
      });

      if (!targetPath) {
        logger.error('Target path is required for version selection save', {
          category: 'settings',
          data: {
            handler: 'save-version-selection',
            targetPath,
            mcVersion,
            fabricVersion
          }
        });
        throw new Error('Target path is required');
      }
      
      try {
        const configFile = path.join(targetPath, '.minecraft-core.json');
        let config = {};
        
        if (fs.existsSync(configFile)) {
          logger.debug('Reading existing config file', {
            category: 'storage',
            data: {
              handler: 'save-version-selection',
              configFile,
              fileExists: true
            }
          });

          try {
            config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
            logger.debug('Existing config loaded successfully', {
              category: 'settings',
              data: {
                handler: 'save-version-selection',
                existingKeys: Object.keys(config),
                existingVersion: config.version,
                existingFabric: config.fabric
              }
            });
          } catch (parseError) {
            logger.warn('Failed to parse existing config, using empty config', {
              category: 'settings',
              data: {
                handler: 'save-version-selection',
                configFile,
                parseError: parseError.message
              }
            });
            // Continue with empty config
          }
        } else {
          logger.debug('No existing config file found, creating new', {
            category: 'settings',
            data: {
              handler: 'save-version-selection',
              configFile,
              fileExists: false
            }
          });
        }
        
        // Preserve any existing settings and update version info
        const previousVersion = config.version;
        const previousFabric = config.fabric;
        
        config.version = mcVersion;
        config.fabric = fabricVersion;
        
        logger.info('Updating version configuration', {
          category: 'settings',
          data: {
            handler: 'save-version-selection',
            previousVersion,
            newVersion: mcVersion,
            previousFabric,
            newFabric: fabricVersion,
            configFile
          }
        });

        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        const duration = Date.now() - startTime;

        logger.info('Version selection saved successfully', {
          category: 'performance',
          data: {
            handler: 'save-version-selection',
            duration,
            success: true,
            configFile,
            mcVersion,
            fabricVersion
          }
        });

        return true;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to save version selection: ${error.message}`, {
          category: 'settings',
          data: {
            handler: 'save-version-selection',
            errorType: error.constructor.name,
            duration,
            targetPath,
            mcVersion,
            fabricVersion
          }
        });
        throw error;
      }
    },
    
    'write-eula': (_e, { path: targetPath, content }) => {
      const startTime = Date.now();
      
      logger.debug('Writing EULA file', {
        category: 'storage',
        data: {
          handler: 'write-eula',
          targetPath,
          contentLength: content ? content.length : 0,
          hasContent: !!content,
          sender: _e.sender.id
        }
      });

      if (!targetPath || typeof content !== 'string') {
        logger.error('Invalid parameters for writing EULA', {
          category: 'storage',
          data: {
            handler: 'write-eula',
            targetPath,
            targetPathType: typeof targetPath,
            content: content ? content.substring(0, 50) : null,
            contentType: typeof content
          }
        });
        throw new Error('Invalid parameters for writing EULA');
      }

      try {
        const eulaPath = path.join(targetPath, 'eula.txt');
        
        logger.info('Writing EULA file', {
          category: 'storage',
          data: {
            handler: 'write-eula',
            eulaPath,
            contentLength: content.length,
            eulaAccepted: content.includes('eula=true')
          }
        });

        fs.writeFileSync(eulaPath, content);
        const duration = Date.now() - startTime;

        logger.info('EULA file written successfully', {
          category: 'performance',
          data: {
            handler: 'write-eula',
            duration,
            success: true,
            eulaPath,
            contentLength: content.length
          }
        });

        return true;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to write EULA file: ${error.message}`, {
          category: 'storage',
          data: {
            handler: 'write-eula',
            errorType: error.constructor.name,
            duration,
            targetPath,
            contentLength: content ? content.length : 0
          }
        });
        throw error;
      }
    },
    
    'delete-world': async (_event, serverPath) => {
      const startTime = Date.now();
      
      logger.warn('World deletion requested', {
        category: 'storage',
        data: {
          handler: 'delete-world',
          serverPath,
          sender: _event.sender.id
        }
      });

      try {
        if (!serverPath) {
          logger.error('Server path is required for world deletion', {
            category: 'storage',
            data: {
              handler: 'delete-world',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Server path is required');
        }

        logger.warn('Proceeding with world deletion', {
          category: 'storage',
          data: {
            handler: 'delete-world',
            serverPath
          }
        });

        const result = await deleteWorld(serverPath);
        const duration = Date.now() - startTime;

        logger.warn('World deletion completed', {
          category: 'performance',
          data: {
            handler: 'delete-world',
            duration,
            serverPath,
            success: result.success,
            hasBackup: !!result.backup
          }
        });

        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to delete world: ${err.message}`, {
          category: 'storage',
          data: {
            handler: 'delete-world',
            errorType: err.constructor.name,
            duration,
            serverPath
          }
        });
        throw new Error(`Failed to delete world: ${err.message}`);
      }
    },
    
    'show-confirmation-dialog': async (_event, options) => {
      const startTime = Date.now();
      
      logger.debug('Confirmation dialog requested', {
        category: 'ui',
        data: {
          handler: 'show-confirmation-dialog',
          hasOptions: !!options,
          hasWindow: !!win,
          dialogType: options?.type,
          title: options?.title,
          sender: _event.sender.id
        }
      });

      try {
        if (!options || !win) {
          logger.error('Invalid parameters or window not available for dialog', {
            category: 'ui',
            data: {
              handler: 'show-confirmation-dialog',
              hasOptions: !!options,
              hasWindow: !!win,
              optionsType: typeof options
            }
          });
          throw new Error('Invalid parameters or window not available');
        }

        logger.info('Showing confirmation dialog', {
          category: 'ui',
          data: {
            handler: 'show-confirmation-dialog',
            dialogType: options.type,
            title: options.title,
            buttonCount: options.buttons ? options.buttons.length : 0
          }
        });

        const result = await dialog.showMessageBox(win, options);
        const duration = Date.now() - startTime;

        logger.info('Confirmation dialog completed', {
          category: 'performance',
          data: {
            handler: 'show-confirmation-dialog',
            duration,
            response: result.response,
            checkboxChecked: result.checkboxChecked,
            cancelled: false // MessageBoxReturnValue doesn't have cancelled property
          }
        });

        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Failed to show dialog: ${err.message}`, {
          category: 'ui',
          data: {
            handler: 'show-confirmation-dialog',
            errorType: err.constructor.name,
            duration,
            hasOptions: !!options,
            hasWindow: !!win
          }
        });
        throw new Error(`Failed to show dialog: ${err.message}`);
      }
    },

    'calculate-file-checksum': async (_event, { filePath, algorithm = 'sha1' }) => {
      const startTime = Date.now();
      
      logger.debug('File checksum calculation requested', {
        category: 'storage',
        data: {
          handler: 'calculate-file-checksum',
          filePath,
          algorithm,
          sender: _event.sender.id
        }
      });

      try {
        if (!filePath) {
          logger.error('File path is required for checksum calculation', {
            category: 'storage',
            data: {
              handler: 'calculate-file-checksum',
              filePath,
              algorithm
            }
          });
          throw new Error('File path is required');
        }

        const checksum = await calculateFileChecksum(filePath, algorithm);
        const duration = Date.now() - startTime;

        logger.info('File checksum calculation completed successfully', {
          category: 'performance',
          data: {
            handler: 'calculate-file-checksum',
            filePath,
            algorithm,
            checksumLength: checksum.length,
            duration,
            success: true
          }
        });

        return checksum;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`File checksum calculation failed: ${error.message}`, {
          category: 'storage',
          data: {
            handler: 'calculate-file-checksum',
            filePath,
            algorithm,
            duration,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    }
  };
}

/**
 * Delete world folder
 * 
 * @param {string} serverPath - Path to the server directory 
 * @returns {Promise<Object>} - Result with success status
 */
async function deleteWorld(serverPath) {
  const startTime = Date.now();
  
  logger.warn('Starting world deletion process', {
    category: 'storage',
    data: {
      function: 'deleteWorld',
      serverPath
    }
  });

  try {
    if (!serverPath) {
      logger.error('Server path is not provided for world deletion', {
        category: 'storage',
        data: {
          function: 'deleteWorld',
          serverPath,
          serverPathType: typeof serverPath
        }
      });
      throw new Error('Server path is not provided');
    }
    
    // Verify server path exists
    if (!fs.existsSync(serverPath)) {
      logger.error('Server path does not exist for world deletion', {
        category: 'storage',
        data: {
          function: 'deleteWorld',
          serverPath,
          pathExists: false
        }
      });
      throw new Error('Server path does not exist');
    }
    
    const worldPath = path.join(serverPath, 'world');
    const worldNetherPath = path.join(serverPath, 'world_nether');
    const worldEndPath = path.join(serverPath, 'world_the_end');
    
    logger.debug('Checking world folder existence', {
      category: 'storage',
      data: {
        function: 'deleteWorld',
        worldPath,
        worldNetherPath,
        worldEndPath
      }
    });

    // Check if any of the world folders exist
    const worldExists = await fsPromises.access(worldPath).then(() => true).catch(() => false);
    const worldNetherExists = await fsPromises.access(worldNetherPath).then(() => true).catch(() => false);
    const worldEndExists = await fsPromises.access(worldEndPath).then(() => true).catch(() => false);
    
    logger.info('World folder existence check completed', {
      category: 'storage',
      data: {
        function: 'deleteWorld',
        worldExists,
        worldNetherExists,
        worldEndExists,
        totalWorldFolders: [worldExists, worldNetherExists, worldEndExists].filter(Boolean).length
      }
    });

    if (!worldExists && !worldNetherExists && !worldEndExists) {
      logger.warn('No world folders found to delete', {
        category: 'storage',
        data: {
          function: 'deleteWorld',
          serverPath,
          duration: Date.now() - startTime
        }
      });
      return { success: false, error: 'World folders not found' };
    }
    
    // Create a backup before deletion
    const backupPath = path.join(serverPath, 'backups');
    
    logger.info('Creating backup directory', {
      category: 'backup',
      data: {
        function: 'deleteWorld',
        backupPath
      }
    });

    await fsPromises.mkdir(backupPath, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `world-backup-${timestamp}.zip`;
    const backupFilePath = path.join(backupPath, backupFilename);
    
    const foldersToBackup = [
      worldExists ? worldPath : null,
      worldNetherExists ? worldNetherPath : null,
      worldEndExists ? worldEndPath : null
    ].filter(Boolean);
    
    logger.info('Preparing world backup before deletion', {
      category: 'backup',
      data: {
        function: 'deleteWorld',
        backupFilePath,
        foldersToBackup: foldersToBackup.map(f => path.basename(f)),
        folderCount: foldersToBackup.length
      }
    });

    let backupCreated = false;
    if (foldersToBackup.length > 0) {
      try {
        logger.info('Creating world backup zip', {
          category: 'backup',
          data: {
            function: 'deleteWorld',
            backupFilePath,
            folderCount: foldersToBackup.length
          }
        });

        await createZip(foldersToBackup, backupFilePath);
        
        // Check if the backup is a zip file and not a folder
        const stat = fs.existsSync(backupFilePath) ? fs.statSync(backupFilePath) : null;
        const isZip = stat && stat.isFile() && backupFilePath.endsWith('.zip');
        
        if (!isZip) {
          logger.error('Backup was not created as a zip file', {
            category: 'backup',
            data: {
              function: 'deleteWorld',
              backupFilePath,
              fileExists: fs.existsSync(backupFilePath),
              isFile: stat ? stat.isFile() : false,
              isZip
            }
          });
          return { success: false, error: 'Backup was not created as a zip file. World was NOT deleted.' };
        }

        // Write metadata for backup
        const stats = fs.statSync(backupFilePath);
        const metadata = {
          type: 'world-delete',
          timestamp: new Date().toISOString(),
          size: stats.size,
          trigger: 'delete-world'
        };
        
        const metadataPath = backupFilePath.replace('.zip', '.json');
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        
        logger.info('World backup created successfully', {
          category: 'backup',
          data: {
            function: 'deleteWorld',
            backupFilePath,
            backupSize: stats.size,
            metadataPath
          }
        });

        backupCreated = true;
      } catch (backupError) {
        logger.error(`Failed to create world backup: ${backupError.message}`, {
          category: 'backup',
          data: {
            function: 'deleteWorld',
            backupFilePath,
            errorType: backupError.constructor.name,
            folderCount: foldersToBackup.length
          }
        });
        return { success: false, error: 'Failed to create world backup zip. World was NOT deleted.' };
      }
    }
    
    if (!backupCreated) {
      logger.error('No backup was created for world deletion', {
        category: 'backup',
        data: {
          function: 'deleteWorld',
          foldersToBackup: foldersToBackup.length,
          backupPath
        }
      });
      return { success: false, error: 'Failed to create world backup zip. World was NOT deleted.' };
    }
    
    // Delete world folders using fsPromises.rm
    const deletePromises = [];
    const foldersToDelete = [];
    
    if (worldExists) {
      deletePromises.push(fsPromises.rm(worldPath, { recursive: true, force: true }));
      foldersToDelete.push('world');
    }
    if (worldNetherExists) {
      deletePromises.push(fsPromises.rm(worldNetherPath, { recursive: true, force: true }));
      foldersToDelete.push('world_nether');
    }
    if (worldEndExists) {
      deletePromises.push(fsPromises.rm(worldEndPath, { recursive: true, force: true }));
      foldersToDelete.push('world_the_end');
    }

    logger.warn('Deleting world folders', {
      category: 'storage',
      data: {
        function: 'deleteWorld',
        foldersToDelete,
        deleteCount: deletePromises.length,
        backupCreated: backupCreated,
        backupPath: backupCreated ? backupFilePath : null
      }
    });

    await Promise.all(deletePromises);
    const duration = Date.now() - startTime;

    logger.warn('World deletion completed successfully', {
      category: 'performance',
      data: {
        function: 'deleteWorld',
        duration,
        success: true,
        foldersDeleted: foldersToDelete,
        backupCreated: backupCreated,
        backupPath: backupCreated ? backupFilePath : null
      }
    });
    
    return { 
      success: true, 
      backup: backupCreated ? backupFilePath : null 
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    logger.error(`World deletion failed: ${err.message}`, {
      category: 'storage',
      data: {
        function: 'deleteWorld',
        errorType: err.constructor.name,
        duration,
        serverPath
      }
    });
    return { success: false, error: err.message };
  }
}

module.exports = { createFileHandlers };
