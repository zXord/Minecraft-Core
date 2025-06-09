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
const appStore = require("../utils/app-store.cjs");

/**
 * Create server management IPC handlers
 *
 * @param {BrowserWindow} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createServerHandlers(win) {
  return {
    "start-server": (_e, { targetPath, port, maxRam }) => {
      try {
        if (!targetPath || !fs.existsSync(targetPath)) {
          throw new Error("Invalid server path");
        }

        // Validate parameters
        if (port && (typeof port !== "number" || port < 1 || port > 65535)) {
          throw new Error("Invalid port number");
        }

        if (maxRam && (typeof maxRam !== "number" || maxRam <= 0)) {
          throw new Error("Invalid memory allocation");
        }

        // Save server path to persistent store
        appStore.set("lastServerPath", targetPath);

        // Save port and maxRam settings while preserving existing auto-start
        try {
          const currentSettings = appStore.get("serverSettings") || {
            port: 25565,
            maxRam: 4,
            autoStartMinecraft: false,
            autoStartManagement: false,
          };

          appStore.set("serverSettings", {
            ...currentSettings,
            port: port || 25565,
            maxRam: maxRam || 4,
          });
        } catch (err) {
        }

        // Share server path with renderer through preload script
        if (win && win.webContents) {
          win.webContents.send("update-server-path", targetPath);
        }

        // Load auto-restart settings from server config
        initFromServerConfig(targetPath);

        // Ensure there's no stale auto-restart timer
        cancelAutoRestart();

        return startMinecraftServer(targetPath, port, maxRam);
      } catch (err) {
        throw err;
      }
    },

    "stop-server": () => {
      try {
        // Cancel any pending auto-restart
        cancelAutoRestart();
        return stopMinecraftServer();
      } catch (err) {
        throw err;
      }
    },

    "kill-server": () => {
      try {
        // Cancel any pending auto-restart
        cancelAutoRestart();
        return killMinecraftServer();
      } catch (err) {
        throw err;
      }
    },

    "send-command": (_e, { command }) => {
      try {
        if (!command || typeof command !== "string") {
          throw new Error("Invalid command");
        }

        return sendServerCommand(command);
      } catch (err) {
        throw err;
      }
    },
    "get-server-status": () => {
      try {
        const state = getServerState();
        // Get server settings from app store
        const serverSettings = appStore.get("serverSettings") || {
          port: 25565,
          maxRam: 4,
          autoStartMinecraft: false,
          autoStartManagement: false,
        };

        return {
          isRunning: state.isRunning,
          serverSettings,
          status: state.isRunning ? "running" : "stopped",
          serverStartMs: state.serverStartMs || null,
          playersInfo: state.playersInfo || { online: 0, max: 0, list: [] },
        };
      } catch (err) {
        throw err;
      }
    },
  };
}

module.exports = { createServerHandlers };
