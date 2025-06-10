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
function createServerHandlers(win) {
  return {
    "start-server": (_e, { targetPath, port, maxRam }) => {
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

        // Share server path with renderer through preload script
        if (win && win.webContents) {
          win.webContents.send("update-server-path", targetPath);
        }

        initFromServerConfig(targetPath);
        cancelAutoRestart();
        return startMinecraftServer(targetPath, port, maxRam);
    },

    "stop-server": () => {
      cancelAutoRestart();
      return stopMinecraftServer();
    },

    "kill-server": () => {
      cancelAutoRestart();
      return killMinecraftServer();
    },

    "send-command": (_e, { command }) => {
      if (!command || typeof command !== "string") {
        throw new Error("Invalid command");
      }
      return sendServerCommand(command);
    },
    "get-server-status": () => {
      const state = getServerState();
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
    },
  };
}

module.exports = { createServerHandlers };
