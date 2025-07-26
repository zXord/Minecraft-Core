// Server management IPC handlers
const {
  startMinecraftServer,
  stopMinecraftServer,
  killMinecraftServer,
  sendServerCommand,
  getServerState,
} = require("../services/server-manager.cjs");
const {
  cancelAutoRestart,
  initFromServerConfig,
} = require("../services/auto-restart.cjs");
const fs = require("fs");
const appStore = require("../utils/app-store.cjs");
const { getLoggerHandlers } = require("./logger-handlers.cjs");

const logger = getLoggerHandlers();
function createServerHandlers(win) {
  logger.info('Server handlers initialized', {
    category: 'server',
    data: { handler: 'createServerHandlers', hasWindow: !!win }
  });

  return {
    "start-server": async (_e, { targetPath, port, maxRam }) => {
      const startTime = Date.now();
      
      logger.info('Server start requested', {
        category: 'server',
        data: {
          handler: 'start-server',
          targetPath,
          port: port || 25565,
          maxRam: maxRam || 4,
          sender: _e.sender.id
        }
      });

      try {
        // Validate server path
        if (!targetPath || !fs.existsSync(targetPath)) {
          logger.error('Invalid server path provided', {
            category: 'server',
            data: {
              handler: 'start-server',
              targetPath,
              pathExists: targetPath ? fs.existsSync(targetPath) : false
            }
          });
          throw new Error("Invalid server path");
        }

        // Validate parameters
        if (port && (typeof port !== "number" || port < 1 || port > 65535)) {
          logger.error('Invalid port number provided', {
            category: 'server',
            data: {
              handler: 'start-server',
              port,
              portType: typeof port
            }
          });
          throw new Error("Invalid port number");
        }

        if (maxRam && (typeof maxRam !== "number" || maxRam <= 0)) {
          logger.error('Invalid memory allocation provided', {
            category: 'server',
            data: {
              handler: 'start-server',
              maxRam,
              ramType: typeof maxRam
            }
          });
          throw new Error("Invalid memory allocation");
        }

        logger.debug('Server parameters validated successfully', {
          category: 'server',
          data: {
            handler: 'start-server',
            validatedPort: port || 25565,
            validatedRam: maxRam || 4
          }
        });

        // Save server path to persistent store
        appStore.set("lastServerPath", targetPath);
        logger.debug('Server path saved to store', {
          category: 'storage',
          data: {
            handler: 'start-server',
            key: 'lastServerPath',
            path: targetPath
          }
        });

        // Save port and maxRam settings while preserving existing auto-start
        const currentSettings = appStore.get("serverSettings") || {
          port: 25565,
          maxRam: 4,
          autoStartMinecraft: false,
          autoStartManagement: false,
        };

        const newSettings = {
          ...currentSettings,
          port: port || 25565,
          maxRam: maxRam || 4,
        };

        appStore.set("serverSettings", newSettings);
        logger.debug('Server settings updated', {
          category: 'settings',
          data: {
            handler: 'start-server',
            previousSettings: currentSettings,
            newSettings: newSettings
          }
        });

        // Share server path with renderer through preload script
        if (win && win.webContents) {
          win.webContents.send("update-server-path", targetPath);
          logger.debug('Server path sent to renderer', {
            category: 'core',
            data: {
              handler: 'start-server',
              targetPath,
              windowId: win.id
            }
          });
        }

        logger.debug('Initializing auto-restart configuration', {
          category: 'server',
          data: {
            handler: 'start-server',
            targetPath
          }
        });
        initFromServerConfig(targetPath);
        cancelAutoRestart();

        logger.info('Starting Minecraft server', {
          category: 'server',
          data: {
            handler: 'start-server',
            targetPath,
            port: port || 25565,
            maxRam: maxRam || 4
          }
        });

        const result = await startMinecraftServer(targetPath, port, maxRam);
        const duration = Date.now() - startTime;

        logger.info('Server start completed', {
          category: 'performance',
          data: {
            handler: 'start-server',
            success: true,
            duration,
            result: typeof result
          }
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Server start failed: ${error.message}`, {
          category: 'server',
          data: {
            handler: 'start-server',
            errorType: error.constructor.name,
            duration,
            targetPath,
            port: port || 25565,
            maxRam: maxRam || 4
          }
        });
        throw error;
      }
    },

    "stop-server": async (_e) => {
      const startTime = Date.now();
      
      logger.info('Server stop requested', {
        category: 'server',
        data: {
          handler: 'stop-server',
          sender: _e.sender.id
        }
      });

      try {
        logger.debug('Cancelling auto-restart', {
          category: 'server',
          data: { handler: 'stop-server' }
        });
        cancelAutoRestart();

        logger.info('Stopping Minecraft server', {
          category: 'server',
          data: { handler: 'stop-server' }
        });

        const result = await stopMinecraftServer();
        const duration = Date.now() - startTime;

        logger.info('Server stop completed', {
          category: 'performance',
          data: {
            handler: 'stop-server',
            success: true,
            duration,
            result: typeof result
          }
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Server stop failed: ${error.message}`, {
          category: 'server',
          data: {
            handler: 'stop-server',
            errorType: error.constructor.name,
            duration
          }
        });
        throw error;
      }
    },

    "kill-server": async (_e) => {
      const startTime = Date.now();
      
      logger.warn('Server kill requested', {
        category: 'server',
        data: {
          handler: 'kill-server',
          sender: _e.sender.id
        }
      });

      try {
        logger.debug('Cancelling auto-restart before kill', {
          category: 'server',
          data: { handler: 'kill-server' }
        });
        cancelAutoRestart();

        logger.warn('Force killing Minecraft server', {
          category: 'server',
          data: { handler: 'kill-server' }
        });

        const result = await killMinecraftServer();
        const duration = Date.now() - startTime;

        logger.warn('Server kill completed', {
          category: 'performance',
          data: {
            handler: 'kill-server',
            success: true,
            duration,
            result: typeof result
          }
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Server kill failed: ${error.message}`, {
          category: 'server',
          data: {
            handler: 'kill-server',
            errorType: error.constructor.name,
            duration
          }
        });
        throw error;
      }
    },

    "send-command": async (_e, { command }) => {
      const startTime = Date.now();
      
      logger.debug('Server command requested', {
        category: 'server',
        data: {
          handler: 'send-command',
          command: command ? command.substring(0, 100) : null, // Truncate long commands
          commandLength: command ? command.length : 0,
          sender: _e.sender.id
        }
      });

      try {
        // Validate command
        if (!command || typeof command !== "string") {
          logger.error('Invalid command provided', {
            category: 'server',
            data: {
              handler: 'send-command',
              command,
              commandType: typeof command
            }
          });
          throw new Error("Invalid command");
        }

        logger.info('Sending command to server', {
          category: 'server',
          data: {
            handler: 'send-command',
            command: command.substring(0, 50), // Log first 50 chars for security
            commandLength: command.length
          }
        });

        const result = await sendServerCommand(command);
        const duration = Date.now() - startTime;

        logger.debug('Server command completed', {
          category: 'performance',
          data: {
            handler: 'send-command',
            success: true,
            duration,
            commandLength: command.length
          }
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Server command failed: ${error.message}`, {
          category: 'server',
          data: {
            handler: 'send-command',
            errorType: error.constructor.name,
            duration,
            commandLength: command ? command.length : 0
          }
        });
        throw error;
      }
    },
    "get-server-status": (_e) => {
      const startTime = Date.now();
      
      logger.debug('Server status requested', {
        category: 'server',
        data: {
          handler: 'get-server-status',
          sender: _e.sender.id
        }
      });

      try {
        const state = getServerState();
        const serverSettings = appStore.get("serverSettings") || {
          port: 25565,
          maxRam: 4,
          autoStartMinecraft: false,
          autoStartManagement: false,
        };

        const statusResponse = {
          isRunning: state.isRunning,
          serverSettings,
          status: state.isRunning ? "running" : "stopped",
          serverStartMs: state.serverStartMs || null,
          playersInfo: state.playersInfo || { online: 0, max: 0, list: [] },
        };

        const duration = Date.now() - startTime;

        logger.debug('Server status retrieved', {
          category: 'performance',
          data: {
            handler: 'get-server-status',
            success: true,
            duration,
            isRunning: state.isRunning,
            playerCount: statusResponse.playersInfo.online,
            maxPlayers: statusResponse.playersInfo.max
          }
        });

        return statusResponse;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`Server status retrieval failed: ${error.message}`, {
          category: 'server',
          data: {
            handler: 'get-server-status',
            errorType: error.constructor.name,
            duration
          }
        });
        throw error;
      }
    },
  };
}

module.exports = { createServerHandlers };
