// Installation and download IPC handlers
const fs = require('fs');
const path = require('path');
const {
  downloadMinecraftServer,
  installFabric
} = require('../services/download-manager.cjs');
const { ServerJavaManager } = require('../services/server-java-manager.cjs');
const { getLoggerHandlers } = require('./logger-handlers.cjs');

const logger = getLoggerHandlers();

/**
 * Create installation and download IPC handlers
 * 
 * @param {object} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createInstallHandlers(win) {
  logger.info('Install handlers initialized', {
    category: 'core',
    data: { handler: 'createInstallHandlers' }
  });

  return {
    'check-java': async () => {
      const startTime = Date.now();

      logger.debug('IPC handler invoked', {
        category: 'core',
        data: {
          handler: 'check-java',
          operation: 'java_detection'
        }
      });

      try {
        const { exec } = require('child_process');

        logger.debug('Starting Java version check', {
          category: 'core',
          data: {
            handler: 'check-java',
            operation: 'exec_java_version',
            command: 'java -version'
          }
        });

        return new Promise((resolve) => {
          exec('java -version', (error, stdout, stderr) => {
            const duration = Date.now() - startTime;

            if (error) {
              logger.warn('Java not found or not accessible', {
                category: 'core',
                data: {
                  handler: 'check-java',
                  operation: 'java_detection',
                  duration,
                  installed: false,
                  errorType: error.constructor.name,
                  errorMessage: error.message
                }
              });
              resolve({ installed: false, error: error.message });
              return;
            }

            // Java outputs version to stderr by default
            const output = stderr || stdout;
            const version = output.split('\n')[0].trim();

            logger.info('Java detection completed successfully', {
              category: 'core',
              data: {
                handler: 'check-java',
                operation: 'java_detection',
                duration,
                installed: true,
                version,
                outputSource: stderr ? 'stderr' : 'stdout'
              }
            });

            resolve({
              installed: true,
              version
            });
          });
        });
      } catch (err) {
        const duration = Date.now() - startTime;

        logger.error(`Java check failed: ${err.message}`, {
          category: 'core',
          data: {
            handler: 'check-java',
            operation: 'java_detection',
            duration,
            errorType: err.constructor.name,
            installed: false
          }
        });

        return { installed: false, error: err.message };
      }
    },

    'download-minecraft-server': async (_e, { mcVersion, targetPath }) => {
      const startTime = Date.now();

      logger.debug('IPC handler invoked', {
        category: 'core',
        data: {
          handler: 'download-minecraft-server',
          sender: _e.sender.id,
          parameters: {
            mcVersion: mcVersion !== undefined,
            targetPath: targetPath !== undefined
          }
        }
      });

      try {
        // Parameter validation with logging
        logger.debug('Starting parameter validation', {
          category: 'core',
          data: {
            handler: 'download-minecraft-server',
            operation: 'validation',
            mcVersion: mcVersion,
            mcVersionType: typeof mcVersion,
            targetPath: targetPath,
            targetPathExists: targetPath ? fs.existsSync(targetPath) : false
          }
        });

        if (!mcVersion || typeof mcVersion !== 'string') {
          logger.error('Parameter validation failed', {
            category: 'core',
            data: {
              handler: 'download-minecraft-server',
              validation: 'mcVersion',
              value: mcVersion,
              type: typeof mcVersion,
              valid: false,
              errorReason: !mcVersion ? 'missing' : 'invalid_type'
            }
          });
          throw new Error('Invalid Minecraft version');
        }

        if (!targetPath || !fs.existsSync(targetPath)) {
          logger.error('Parameter validation failed', {
            category: 'storage',
            data: {
              handler: 'download-minecraft-server',
              validation: 'targetPath',
              value: targetPath,
              exists: targetPath ? fs.existsSync(targetPath) : false,
              valid: false,
              errorReason: !targetPath ? 'missing' : 'path_not_exists'
            }
          });
          throw new Error('Invalid target directory');
        }

        logger.info('Starting Minecraft server download', {
          category: 'network',
          data: {
            handler: 'download-minecraft-server',
            operation: 'download_start',
            mcVersion,
            targetPath,
            targetPathExists: true
          }
        });

        const result = await downloadMinecraftServer(mcVersion, targetPath);
        const duration = Date.now() - startTime;

        logger.info('Minecraft server download completed', {
          category: 'network',
          data: {
            handler: 'download-minecraft-server',
            operation: 'download_complete',
            duration,
            mcVersion,
            targetPath,
            success: result === true,
            resultType: typeof result
          }
        });

        return result;
      } catch (err) {
        const duration = Date.now() - startTime;

        logger.error(`Minecraft server download failed: ${err.message}`, {
          category: 'network',
          data: {
            handler: 'download-minecraft-server',
            operation: 'download_failed',
            duration,
            mcVersion,
            targetPath,
            errorType: err.constructor.name,
            errorMessage: err.message
          }
        });

        return { success: false, error: err.message };
      }
    },

    'download-and-install-fabric': async (_e, { path: targetPath, mcVersion, fabricVersion }) => {
      const startTime = Date.now();

      logger.debug('IPC handler invoked', {
        category: 'core',
        data: {
          handler: 'download-and-install-fabric',
          sender: _e.sender.id,
          parameters: {
            targetPath: targetPath !== undefined,
            mcVersion: mcVersion !== undefined,
            fabricVersion: fabricVersion !== undefined
          }
        }
      });

      try {
        // Parameter validation with logging
        logger.debug('Starting parameter validation', {
          category: 'core',
          data: {
            handler: 'download-and-install-fabric',
            operation: 'validation',
            targetPath: targetPath,
            targetPathExists: targetPath ? fs.existsSync(targetPath) : false,
            mcVersion: mcVersion,
            mcVersionType: typeof mcVersion,
            fabricVersion: fabricVersion,
            fabricVersionType: typeof fabricVersion
          }
        });

        if (!targetPath || !fs.existsSync(targetPath)) {
          logger.error('Parameter validation failed', {
            category: 'storage',
            data: {
              handler: 'download-and-install-fabric',
              validation: 'targetPath',
              value: targetPath,
              exists: targetPath ? fs.existsSync(targetPath) : false,
              valid: false,
              errorReason: !targetPath ? 'missing' : 'path_not_exists'
            }
          });
          throw new Error('Invalid target directory');
        }

        if (!mcVersion || typeof mcVersion !== 'string') {
          logger.error('Parameter validation failed', {
            category: 'core',
            data: {
              handler: 'download-and-install-fabric',
              validation: 'mcVersion',
              value: mcVersion,
              type: typeof mcVersion,
              valid: false,
              errorReason: !mcVersion ? 'missing' : 'invalid_type'
            }
          });
          throw new Error('Invalid Minecraft version');
        }

        if (!fabricVersion || typeof fabricVersion !== 'string') {
          logger.error('Parameter validation failed', {
            category: 'core',
            data: {
              handler: 'download-and-install-fabric',
              validation: 'fabricVersion',
              value: fabricVersion,
              type: typeof fabricVersion,
              valid: false,
              errorReason: !fabricVersion ? 'missing' : 'invalid_type'
            }
          });
          throw new Error('Invalid Fabric version');
        }

        logger.info('Starting Fabric installation', {
          category: 'mods',
          data: {
            handler: 'download-and-install-fabric',
            operation: 'fabric_install_start',
            targetPath,
            mcVersion,
            fabricVersion
          }
        });

        await installFabric(targetPath, mcVersion, fabricVersion);
        const duration = Date.now() - startTime;

        logger.info('Fabric installation completed successfully', {
          category: 'mods',
          data: {
            handler: 'download-and-install-fabric',
            operation: 'fabric_install_complete',
            duration,
            targetPath,
            mcVersion,
            fabricVersion,
            success: true
          }
        });

        return { success: true };
      } catch (err) {
        const duration = Date.now() - startTime;

        logger.error(`Fabric installation failed: ${err.message}`, {
          category: 'mods',
          data: {
            handler: 'download-and-install-fabric',
            operation: 'fabric_install_failed',
            duration,
            targetPath,
            mcVersion,
            fabricVersion,
            errorType: err.constructor.name,
            errorMessage: err.message
          }
        });

        if (win && win.webContents) {
          logger.debug('Sending install error to frontend', {
            category: 'core',
            data: {
              handler: 'download-and-install-fabric',
              operation: 'error_notification',
              windowExists: true,
              errorMessage: err.message
            }
          });
          win.webContents.send('install-error', err.message);
        } else {
          logger.warn('Cannot send install error - window not available', {
            category: 'core',
            data: {
              handler: 'download-and-install-fabric',
              operation: 'error_notification',
              windowExists: false,
              errorMessage: err.message
            }
          });
        }

        return { success: false, error: err.message };
      }
    },

    'check-health': async (_e, targetPath) => {
      const startTime = Date.now();

      logger.debug('IPC handler invoked', {
        category: 'core',
        data: {
          handler: 'check-health',
          sender: _e.sender.id,
          targetPath: targetPath
        }
      });

      try {
        // Parameter validation
        logger.debug('Starting health check validation', {
          category: 'storage',
          data: {
            handler: 'check-health',
            operation: 'validation',
            targetPath: targetPath,
            targetPathExists: targetPath ? fs.existsSync(targetPath) : false
          }
        });

        if (!targetPath || !fs.existsSync(targetPath)) {
          logger.error('Health check validation failed', {
            category: 'storage',
            data: {
              handler: 'check-health',
              validation: 'targetPath',
              value: targetPath,
              exists: targetPath ? fs.existsSync(targetPath) : false,
              valid: false,
              errorReason: !targetPath ? 'missing' : 'path_not_exists'
            }
          });
          throw new Error('Invalid target directory');
        }

        const missing = [];
        const files = ['server.jar', 'fabric-installer.jar', 'fabric-server-launch.jar'];

        logger.debug('Starting server files health check', {
          category: 'storage',
          data: {
            handler: 'check-health',
            operation: 'file_check',
            targetPath,
            filesToCheck: files,
            fileCount: files.length
          }
        });

        // Check for missing server files
        files.forEach(file => {
          const filePath = path.join(targetPath, file);
          const exists = fs.existsSync(filePath);

          logger.debug('File health check result', {
            category: 'storage',
            data: {
              handler: 'check-health',
              operation: 'file_check',
              fileName: file,
              filePath,
              exists,
              missing: !exists
            }
          });

          if (!exists) {
            missing.push(file);
          }
        });

        // Check Java requirements
        logger.debug('Starting Java requirements check', {
          category: 'core',
          data: {
            handler: 'check-health',
            operation: 'java_requirements_check',
            targetPath
          }
        });

        try {
          // Read server configuration to get Minecraft version
          const configPath = path.join(targetPath, '.minecraft-core.json');

          logger.debug('Checking server configuration', {
            category: 'storage',
            data: {
              handler: 'check-health',
              operation: 'config_check',
              configPath,
              configExists: fs.existsSync(configPath)
            }
          });

          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

            logger.debug('Server configuration loaded', {
              category: 'storage',
              data: {
                handler: 'check-health',
                operation: 'config_loaded',
                configPath,
                hasVersion: !!config.version,
                version: config.version
              }
            });

            if (config.version) {
              const serverJavaManager = new ServerJavaManager(targetPath);
              const javaRequirements = serverJavaManager.getJavaRequirementsForMinecraft(config.version);

              logger.debug('Java requirements determined', {
                category: 'core',
                data: {
                  handler: 'check-health',
                  operation: 'java_requirements',
                  mcVersion: config.version,
                  requiredJavaVersion: javaRequirements.requiredJavaVersion,
                  needsDownload: javaRequirements.needsDownload
                }
              });

              if (javaRequirements.needsDownload) {
                const javaRequirement = `Java ${javaRequirements.requiredJavaVersion} (for Minecraft ${config.version})`;
                missing.push(javaRequirement);

                logger.info('Java requirement missing', {
                  category: 'core',
                  data: {
                    handler: 'check-health',
                    operation: 'java_missing',
                    mcVersion: config.version,
                    requiredJavaVersion: javaRequirements.requiredJavaVersion,
                    requirement: javaRequirement
                  }
                });
              }
            }
          }
        } catch (javaCheckError) {
          logger.warn(`Could not check Java requirements: ${javaCheckError.message}`, {
            category: 'core',
            data: {
              handler: 'check-health',
              operation: 'java_requirements_check',
              errorType: javaCheckError.constructor.name,
              errorMessage: javaCheckError.message,
              targetPath
            }
          });
        }

        const duration = Date.now() - startTime;

        logger.info('Health check completed', {
          category: 'core',
          data: {
            handler: 'check-health',
            operation: 'health_check_complete',
            duration,
            targetPath,
            totalMissing: missing.length,
            missingItems: missing,
            filesChecked: files.length,
            javaCheckPerformed: true
          }
        });

        return missing;
      } catch (err) {
        const duration = Date.now() - startTime;

        logger.error(`Health check failed: ${err.message}`, {
          category: 'core',
          data: {
            handler: 'check-health',
            operation: 'health_check_failed',
            duration,
            targetPath,
            errorType: err.constructor.name,
            errorMessage: err.message
          }
        });

        throw err;
      }
    },

    'repair-health': async (_e, { targetPath, mcVersion, fabricVersion }) => {
      const startTime = Date.now();

      logger.debug('IPC handler invoked', {
        category: 'core',
        data: {
          handler: 'repair-health',
          sender: _e.sender.id,
          parameters: {
            targetPath: targetPath !== undefined,
            mcVersion: mcVersion !== undefined,
            fabricVersion: fabricVersion !== undefined
          }
        }
      });

      try {
        // Parameter validation with logging
        logger.debug('Starting repair parameter validation', {
          category: 'core',
          data: {
            handler: 'repair-health',
            operation: 'validation',
            targetPath: targetPath,
            targetPathExists: targetPath ? fs.existsSync(targetPath) : false,
            mcVersion: mcVersion,
            mcVersionType: typeof mcVersion,
            fabricVersion: fabricVersion,
            fabricVersionType: typeof fabricVersion
          }
        });

        if (!targetPath || !fs.existsSync(targetPath)) {
          logger.error('Repair parameter validation failed', {
            category: 'storage',
            data: {
              handler: 'repair-health',
              validation: 'targetPath',
              value: targetPath,
              exists: targetPath ? fs.existsSync(targetPath) : false,
              valid: false,
              errorReason: !targetPath ? 'missing' : 'path_not_exists'
            }
          });
          throw new Error('Invalid target directory');
        }

        if (!mcVersion || typeof mcVersion !== 'string') {
          logger.error('Repair parameter validation failed', {
            category: 'core',
            data: {
              handler: 'repair-health',
              validation: 'mcVersion',
              value: mcVersion,
              type: typeof mcVersion,
              valid: false,
              errorReason: !mcVersion ? 'missing' : 'invalid_type'
            }
          });
          throw new Error('Invalid Minecraft version');
        }

        if (!fabricVersion || typeof fabricVersion !== 'string') {
          logger.error('Repair parameter validation failed', {
            category: 'core',
            data: {
              handler: 'repair-health',
              validation: 'fabricVersion',
              value: fabricVersion,
              type: typeof fabricVersion,
              valid: false,
              errorReason: !fabricVersion ? 'missing' : 'invalid_type'
            }
          });
          throw new Error('Invalid Fabric version');
        }

        logger.info('Starting repair health process', {
          category: 'core',
          data: {
            handler: 'repair-health',
            operation: 'repair_start',
            targetPath,
            mcVersion,
            fabricVersion
          }
        });

        const files = ['server.jar', 'fabric-installer.jar', 'fabric-server-launch.jar'];

        logger.debug('Analyzing files for repair', {
          category: 'storage',
          data: {
            handler: 'repair-health',
            operation: 'file_analysis',
            targetPath,
            filesToCheck: files,
            fileCount: files.length
          }
        });

        const toRepair = files.filter(f => {
          const filePath = path.join(targetPath, f);
          const exists = fs.existsSync(filePath);

          logger.debug('File repair analysis result', {
            category: 'storage',
            data: {
              handler: 'repair-health',
              operation: 'file_analysis',
              fileName: f,
              filePath,
              exists,
              needsRepair: !exists
            }
          });

          return !exists;
        });

        logger.info('File repair analysis completed', {
          category: 'storage',
          data: {
            handler: 'repair-health',
            operation: 'file_analysis_complete',
            totalFiles: files.length,
            filesToRepair: toRepair.length,
            repairList: toRepair
          }
        });

        // Check Java requirements
        logger.debug('Starting Java requirements analysis', {
          category: 'core',
          data: {
            handler: 'repair-health',
            operation: 'java_analysis',
            targetPath,
            mcVersion
          }
        });

        const serverJavaManager = new ServerJavaManager(targetPath);
        const javaRequirements = serverJavaManager.getJavaRequirementsForMinecraft(mcVersion);
        const needsJava = javaRequirements.needsDownload;

        logger.info('Java requirements analysis completed', {
          category: 'core',
          data: {
            handler: 'repair-health',
            operation: 'java_analysis_complete',
            mcVersion,
            requiredJavaVersion: javaRequirements.requiredJavaVersion,
            needsJava,
            needsDownload: javaRequirements.needsDownload
          }
        });

        if (toRepair.length === 0 && !needsJava) {
          const duration = Date.now() - startTime;

          logger.info('No repairs needed - system healthy', {
            category: 'core',
            data: {
              handler: 'repair-health',
              operation: 'repair_complete',
              duration,
              targetPath,
              mcVersion,
              fabricVersion,
              repairsNeeded: false,
              javaNeeded: false
            }
          });

          if (win && win.webContents) {
            logger.debug('Sending repair completion status to frontend', {
              category: 'core',
              data: {
                handler: 'repair-health',
                operation: 'frontend_notification',
                status: 'done',
                windowExists: true
              }
            });
            win.webContents.send('repair-status', 'done');
          } else {
            logger.warn('Cannot send repair status - window not available', {
              category: 'core',
              data: {
                handler: 'repair-health',
                operation: 'frontend_notification',
                status: 'done',
                windowExists: false
              }
            });
          }
          return [];
        }

        // Repair Java first if needed
        if (needsJava) {
          const javaStartTime = Date.now();

          logger.info('Starting Java installation for repair', {
            category: 'core',
            data: {
              handler: 'repair-health',
              operation: 'java_install_start',
              mcVersion,
              requiredJavaVersion: javaRequirements.requiredJavaVersion,
              targetPath
            }
          });

          if (win && win.webContents) {
            logger.debug('Sending Java install status to frontend', {
              category: 'core',
              data: {
                handler: 'repair-health',
                operation: 'frontend_notification',
                message: `Installing Java ${javaRequirements.requiredJavaVersion}`,
                windowExists: true
              }
            });
            win.webContents.send('repair-log', `🔧 Installing Java ${javaRequirements.requiredJavaVersion}...`);
          }

          try {
            const javaResult = await serverJavaManager.ensureJavaForMinecraft(
              mcVersion,
              (progress) => {
                logger.debug('Java installation progress update', {
                  category: 'performance',
                  data: {
                    handler: 'repair-health',
                    operation: 'java_install_progress',
                    progress: progress.progress || 0,
                    speed: progress.speed || '0 MB/s',
                    mcVersion
                  }
                });

                // Send progress updates
                if (win && win.webContents) {
                  win.webContents.send('repair-progress', {
                    percent: progress.progress || 0,
                    speed: progress.speed || '0 MB/s'
                  });
                }
              }
            );

            const javaDuration = Date.now() - javaStartTime;

            if (javaResult.success) {
              logger.info('Java installation completed successfully', {
                category: 'core',
                data: {
                  handler: 'repair-health',
                  operation: 'java_install_complete',
                  duration: javaDuration,
                  mcVersion,
                  requiredJavaVersion: javaRequirements.requiredJavaVersion,
                  success: true
                }
              });

              if (win && win.webContents) {
                win.webContents.send('repair-log', `✔ Java ${javaRequirements.requiredJavaVersion} installed`);
              }
            } else {
              logger.error('Java installation failed', {
                category: 'core',
                data: {
                  handler: 'repair-health',
                  operation: 'java_install_failed',
                  duration: javaDuration,
                  mcVersion,
                  requiredJavaVersion: javaRequirements.requiredJavaVersion,
                  error: javaResult.error,
                  success: false
                }
              });

              if (win && win.webContents) {
                win.webContents.send('repair-log', `❌ Error installing Java: ${javaResult.error}`);
              }
              throw new Error(`Java installation failed: ${javaResult.error}`);
            }
          } catch (javaErr) {
            const javaDuration = Date.now() - javaStartTime;

            logger.error(`Java installation exception: ${javaErr.message}`, {
              category: 'core',
              data: {
                handler: 'repair-health',
                operation: 'java_install_exception',
                duration: javaDuration,
                mcVersion,
                requiredJavaVersion: javaRequirements.requiredJavaVersion,
                errorType: javaErr.constructor.name,
                errorMessage: javaErr.message
              }
            });

            if (win && win.webContents) {
              win.webContents.send('repair-log', `❌ Error installing Java: ${javaErr.message}`);
            }
            throw javaErr;
          }
        }

        // Repair server files
        logger.info('Starting server files repair process', {
          category: 'storage',
          data: {
            handler: 'repair-health',
            operation: 'files_repair_start',
            filesToRepair: toRepair,
            fileCount: toRepair.length,
            targetPath,
            mcVersion,
            fabricVersion
          }
        });

        for (let i = 0; i < toRepair.length; i++) {
          const file = toRepair[i];
          const fileStartTime = Date.now();

          logger.info(`Starting repair of file: ${file}`, {
            category: 'storage',
            data: {
              handler: 'repair-health',
              operation: 'file_repair_start',
              fileName: file,
              fileIndex: i + 1,
              totalFiles: toRepair.length,
              targetPath
            }
          });

          if (win && win.webContents) {
            logger.debug('Sending file repair status to frontend', {
              category: 'core',
              data: {
                handler: 'repair-health',
                operation: 'frontend_notification',
                fileName: file,
                message: `Repairing ${file}`,
                windowExists: true
              }
            });
            win.webContents.send('repair-log', `🔧 Repairing ${file}...`);
          }

          if (file === 'server.jar') {
            try {
              logger.debug('Starting Minecraft server download for repair', {
                category: 'network',
                data: {
                  handler: 'repair-health',
                  operation: 'server_download_start',
                  fileName: file,
                  mcVersion,
                  targetPath,
                  progressChannel: 'repair-progress'
                }
              });

              await downloadMinecraftServer(mcVersion, targetPath, 'repair-progress');

              const fileDuration = Date.now() - fileStartTime;

              logger.info('Minecraft server download completed for repair', {
                category: 'network',
                data: {
                  handler: 'repair-health',
                  operation: 'server_download_complete',
                  fileName: file,
                  duration: fileDuration,
                  mcVersion,
                  targetPath,
                  success: true
                }
              });

              if (win && win.webContents) {
                win.webContents.send('repair-log', '✔ server.jar downloaded');
              }
            } catch (downloadErr) {
              const fileDuration = Date.now() - fileStartTime;

              logger.error(`Server download failed during repair: ${downloadErr.message}`, {
                category: 'network',
                data: {
                  handler: 'repair-health',
                  operation: 'server_download_failed',
                  fileName: file,
                  duration: fileDuration,
                  mcVersion,
                  targetPath,
                  errorType: downloadErr.constructor.name,
                  errorMessage: downloadErr.message
                }
              });

              if (win && win.webContents) {
                win.webContents.send('repair-log', `❌ Error downloading server.jar: ${downloadErr.message}`);
              }
              throw downloadErr;
            }
          } else if (file.includes('fabric')) {
            try {
              logger.debug('Starting Fabric installation for repair', {
                category: 'mods',
                data: {
                  handler: 'repair-health',
                  operation: 'fabric_install_start',
                  fileName: file,
                  targetPath,
                  mcVersion,
                  fabricVersion
                }
              });

              await installFabric(targetPath, mcVersion, fabricVersion);

              const fileDuration = Date.now() - fileStartTime;

              logger.info('Fabric installation completed for repair', {
                category: 'mods',
                data: {
                  handler: 'repair-health',
                  operation: 'fabric_install_complete',
                  fileName: file,
                  duration: fileDuration,
                  targetPath,
                  mcVersion,
                  fabricVersion,
                  success: true
                }
              });
            } catch (fabricErr) {
              const fileDuration = Date.now() - fileStartTime;

              logger.error(`Fabric installation failed during repair: ${fabricErr.message}`, {
                category: 'mods',
                data: {
                  handler: 'repair-health',
                  operation: 'fabric_install_failed',
                  fileName: file,
                  duration: fileDuration,
                  targetPath,
                  mcVersion,
                  fabricVersion,
                  errorType: fabricErr.constructor.name,
                  errorMessage: fabricErr.message
                }
              });

              if (win && win.webContents) {
                win.webContents.send('repair-log', `❌ Error installing Fabric: ${fabricErr.message}`);
              }
              throw fabricErr;
            }
          }

          // Verify file was actually created
          const filePath = path.join(targetPath, file);
          const fileExists = fs.existsSync(filePath);
          const fileDuration = Date.now() - fileStartTime;

          logger.info('File repair verification completed', {
            category: 'storage',
            data: {
              handler: 'repair-health',
              operation: 'file_repair_verification',
              fileName: file,
              filePath,
              duration: fileDuration,
              exists: fileExists,
              repairSuccess: fileExists
            }
          });

          if (fileExists) {
            if (win && win.webContents) {
              win.webContents.send('repair-log', `✔ ${file} repaired`);
            }
          } else {
            logger.error('File repair verification failed', {
              category: 'storage',
              data: {
                handler: 'repair-health',
                operation: 'file_repair_failed',
                fileName: file,
                filePath,
                duration: fileDuration,
                exists: false,
                repairSuccess: false
              }
            });

            if (win && win.webContents) {
              win.webContents.send('repair-log', `❌ Failed to repair ${file}`);
            }
          }
        }

        const duration = Date.now() - startTime;
        const repairedItems = [...toRepair];
        if (needsJava) {
          repairedItems.push(`Java ${javaRequirements.requiredJavaVersion}`);
        }

        logger.info('Repair health process completed successfully', {
          category: 'core',
          data: {
            handler: 'repair-health',
            operation: 'repair_complete',
            duration,
            targetPath,
            mcVersion,
            fabricVersion,
            totalRepaired: repairedItems.length,
            repairedItems,
            javaRepaired: needsJava,
            filesRepaired: toRepair.length,
            success: true
          }
        });

        if (win && win.webContents) {
          logger.debug('Sending repair completion status to frontend', {
            category: 'core',
            data: {
              handler: 'repair-health',
              operation: 'frontend_notification',
              status: 'done',
              windowExists: true,
              repairedCount: repairedItems.length
            }
          });
          win.webContents.send('repair-status', 'done');
        } else {
          logger.warn('Cannot send repair completion status - window not available', {
            category: 'core',
            data: {
              handler: 'repair-health',
              operation: 'frontend_notification',
              status: 'done',
              windowExists: false,
              repairedCount: repairedItems.length
            }
          });
        }

        return repairedItems;
      } catch (err) {
        const duration = Date.now() - startTime;

        logger.error(`Repair health process failed: ${err.message}`, {
          category: 'core',
          data: {
            handler: 'repair-health',
            operation: 'repair_failed',
            duration,
            targetPath,
            mcVersion,
            fabricVersion,
            errorType: err.constructor.name,
            errorMessage: err.message,
            stack: err.stack
          }
        });

        if (win && win.webContents) {
          logger.debug('Sending repair error status to frontend', {
            category: 'core',
            data: {
              handler: 'repair-health',
              operation: 'frontend_error_notification',
              errorMessage: err.message,
              windowExists: true
            }
          });
          win.webContents.send('repair-log', `❌ Error: ${err.message}`);
          win.webContents.send('repair-status', 'error');
        } else {
          logger.warn('Cannot send repair error status - window not available', {
            category: 'core',
            data: {
              handler: 'repair-health',
              operation: 'frontend_error_notification',
              errorMessage: err.message,
              windowExists: false
            }
          });
        }

        throw err;
      }
    }
  };
}

module.exports = { createInstallHandlers };
