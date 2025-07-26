const { dialog, app } = require('electron');
const modFileManager = require('./mod-utils/mod-file-manager.cjs');
const { createServerModHandlers } = require('./mod-handlers/server-mod-handlers.cjs');
const { createClientModHandlers } = require('./mod-handlers/client-mod-handlers.cjs');
const { createModInfoHandlers } = require('./mod-handlers/mod-info-handlers.cjs');
const { createManualModHandlers } = require('./mod-handlers/manual-mod-handlers.cjs');
const { createModrinthMatchingHandlers } = require('./mod-handlers/modrinth-matching-handlers.cjs');
const { getLoggerHandlers } = require('./logger-handlers.cjs');

const logger = getLoggerHandlers();

function createModHandlers(win) {
  logger.info('Mod handlers initialized', {
    category: 'mods',
    data: { handler: 'createModHandlers', hasWindow: !!win }
  });

  const generalHandlers = {
    'select-mod-files': async () => {
      const startTime = Date.now();
      
      logger.debug('Mod file selection dialog requested', {
        category: 'mods',
        data: { handler: 'select-mod-files' }
      });

      try {
        const result = await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Mod Files', extensions: ['jar'] }],
          title: 'Select Mod Files',
          defaultPath: app.getPath('downloads')
        });

        const duration = Date.now() - startTime;

        if (result.canceled) {
          logger.debug('Mod file selection cancelled by user', {
            category: 'mods',
            data: { 
              handler: 'select-mod-files',
              duration,
              cancelled: true
            }
          });
          return [];
        }

        logger.info('Mod files selected successfully', {
          category: 'mods',
          data: {
            handler: 'select-mod-files',
            duration,
            fileCount: result.filePaths.length,
            files: result.filePaths.map(path => path.split(/[/\\]/).pop()) // Log filenames only
          }
        });

        return result.filePaths;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Mod file selection failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'select-mod-files',
            errorType: error.constructor.name,
            duration
          }
        });
        throw error;
      }
    },

    'get-dropped-file-paths': async (_e, fileIdentifiers) => {
      const startTime = Date.now();
      
      logger.debug('Processing dropped file identifiers', {
        category: 'mods',
        data: {
          handler: 'get-dropped-file-paths',
          inputType: typeof fileIdentifiers,
          isArray: Array.isArray(fileIdentifiers),
          inputLength: fileIdentifiers ? fileIdentifiers.length : 0,
          sender: _e.sender.id
        }
      });

      try {
        if (!fileIdentifiers || !Array.isArray(fileIdentifiers) || !fileIdentifiers.length) {
          logger.debug('No valid file identifiers provided', {
            category: 'mods',
            data: {
              handler: 'get-dropped-file-paths',
              duration: Date.now() - startTime,
              emptyResult: true
            }
          });
          return [];
        }

        const validPaths = fileIdentifiers.filter(f => f && f.path).map(f => f.path);
        const duration = Date.now() - startTime;

        logger.info('Dropped file paths processed', {
          category: 'mods',
          data: {
            handler: 'get-dropped-file-paths',
            duration,
            inputCount: fileIdentifiers.length,
            validPathCount: validPaths.length,
            paths: validPaths.map(path => path.split(/[/\\]/).pop()) // Log filenames only
          }
        });

        return validPaths;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Processing dropped file paths failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'get-dropped-file-paths',
            errorType: error.constructor.name,
            duration,
            inputType: typeof fileIdentifiers
          }
        });
        throw error;
      }
    },

    'handle-dropped-files': async (_e, files) => {
      const startTime = Date.now();
      
      logger.debug('Handling dropped files', {
        category: 'mods',
        data: {
          handler: 'handle-dropped-files',
          inputType: typeof files,
          isArray: Array.isArray(files),
          inputLength: files ? files.length : 0,
          sender: _e.sender.id
        }
      });

      try {
        if (!files || !files.length) {
          logger.debug('No files provided to handle', {
            category: 'mods',
            data: {
              handler: 'handle-dropped-files',
              duration: Date.now() - startTime,
              emptyResult: true
            }
          });
          return [];
        }

        let filePaths = [];
        
        if (Array.isArray(files)) {
          if (files[0] && typeof files[0] === 'object') {
            filePaths = files.map(file => file.path || '').filter(Boolean);
            logger.debug('Processed object-type file array', {
              category: 'mods',
              data: {
                handler: 'handle-dropped-files',
                inputCount: files.length,
                validPathCount: filePaths.length,
                processingType: 'object-array'
              }
            });
          } else if (typeof files[0] === 'string') {
            filePaths = files;
            logger.debug('Processed string-type file array', {
              category: 'mods',
              data: {
                handler: 'handle-dropped-files',
                pathCount: filePaths.length,
                processingType: 'string-array'
              }
            });
          }
        } else if (typeof files === 'object' && files.path) {
          filePaths = [files.path];
          logger.debug('Processed single file object', {
            category: 'mods',
            data: {
              handler: 'handle-dropped-files',
              processingType: 'single-object',
              hasPath: !!files.path
            }
          });
        }

        const duration = Date.now() - startTime;

        logger.info('Dropped files handled successfully', {
          category: 'mods',
          data: {
            handler: 'handle-dropped-files',
            duration,
            resultCount: filePaths.length,
            files: filePaths.map(path => path.split(/[/\\]/).pop()) // Log filenames only
          }
        });

        return filePaths;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Handling dropped files failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'handle-dropped-files',
            errorType: error.constructor.name,
            duration,
            inputType: typeof files
          }
        });
        throw error;
      }
    },

    'save-temp-file': async (_e, { name, buffer }) => {
      const startTime = Date.now();
      
      logger.debug('Saving temporary mod file', {
        category: 'mods',
        data: {
          handler: 'save-temp-file',
          fileName: name,
          bufferSize: buffer ? buffer.length : 0,
          hasBuffer: !!buffer,
          sender: _e.sender.id
        }
      });

      try {
        // Validate parameters
        if (!name || typeof name !== 'string') {
          logger.error('Invalid file name provided for temp file', {
            category: 'mods',
            data: {
              handler: 'save-temp-file',
              name,
              nameType: typeof name
            }
          });
          throw new Error('Invalid file name');
        }

        if (!buffer) {
          logger.error('No buffer provided for temp file', {
            category: 'mods',
            data: {
              handler: 'save-temp-file',
              fileName: name,
              hasBuffer: !!buffer
            }
          });
          throw new Error('No file buffer provided');
        }

        logger.info('Saving temporary file', {
          category: 'storage',
          data: {
            handler: 'save-temp-file',
            fileName: name,
            fileSize: buffer.length
          }
        });

        const result = await modFileManager.saveTemporaryFile({ name, buffer });
        const duration = Date.now() - startTime;

        logger.info('Temporary file saved successfully', {
          category: 'performance',
          data: {
            handler: 'save-temp-file',
            duration,
            fileName: name,
            fileSize: buffer.length,
            success: true,
            resultType: typeof result
          }
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Saving temporary file failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'save-temp-file',
            errorType: error.constructor.name,
            duration,
            fileName: name,
            bufferSize: buffer ? buffer.length : 0
          }
        });
        throw error;
      }
    },

    'direct-add-mod': async (_e, { serverPath, fileName, buffer }) => {
      const startTime = Date.now();
      
      logger.debug('Direct mod addition requested', {
        category: 'mods',
        data: {
          handler: 'direct-add-mod',
          serverPath,
          fileName,
          bufferSize: buffer ? buffer.length : 0,
          hasBuffer: !!buffer,
          sender: _e.sender.id
        }
      });

      try {
        // Validate parameters
        if (!serverPath || typeof serverPath !== 'string') {
          logger.error('Invalid server path provided for direct mod add', {
            category: 'mods',
            data: {
              handler: 'direct-add-mod',
              serverPath,
              serverPathType: typeof serverPath
            }
          });
          throw new Error('Invalid server path');
        }

        if (!fileName || typeof fileName !== 'string') {
          logger.error('Invalid file name provided for direct mod add', {
            category: 'mods',
            data: {
              handler: 'direct-add-mod',
              fileName,
              fileNameType: typeof fileName,
              serverPath
            }
          });
          throw new Error('Invalid file name');
        }

        if (!buffer) {
          logger.error('No buffer provided for direct mod add', {
            category: 'mods',
            data: {
              handler: 'direct-add-mod',
              fileName,
              serverPath,
              hasBuffer: !!buffer
            }
          });
          throw new Error('No file buffer provided');
        }

        logger.info('Adding mod directly to server', {
          category: 'mods',
          data: {
            handler: 'direct-add-mod',
            serverPath,
            fileName,
            fileSize: buffer.length
          }
        });

        const result = await modFileManager.directAddMod({ serverPath, fileName, buffer });
        const duration = Date.now() - startTime;

        logger.info('Mod added directly to server successfully', {
          category: 'performance',
          data: {
            handler: 'direct-add-mod',
            duration,
            serverPath,
            fileName,
            fileSize: buffer.length,
            success: true,
            resultType: typeof result
          }
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Direct mod addition failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'direct-add-mod',
            errorType: error.constructor.name,
            duration,
            serverPath,
            fileName,
            bufferSize: buffer ? buffer.length : 0
          }
        });
        throw error;
      }
    }
  };

  return {
    ...generalHandlers,
    ...createModInfoHandlers(),
    ...createServerModHandlers(win),
    ...createClientModHandlers(win),
    ...createManualModHandlers(),
    ...createModrinthMatchingHandlers(),
  };
}

module.exports = { createModHandlers };
