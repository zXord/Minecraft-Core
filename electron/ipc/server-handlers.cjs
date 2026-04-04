const fs = require('fs');
const {
  startMinecraftServer,
  stopMinecraftServer,
  killMinecraftServer,
  sendServerCommand,
  getServerState,
  getAllServerStates
} = require('../services/server-manager.cjs');
const { getLoggerHandlers } = require('./logger-handlers.cjs');
const { readServerConfig, getDefaultServerConfig } = require('../utils/config-manager.cjs');
const { validateServerPorts } = require('../utils/port-validator.cjs');
const appStore = require('../utils/app-store.cjs');

const logger = getLoggerHandlers();
const DEFAULT_SERVER_SETTINGS = {
  port: 25565,
  maxRam: 4,
  managementPort: 8080,
  autoStartMinecraft: false,
  autoStartManagement: false
};

function coerceNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getServerDefaults(serverPath) {
  return readServerConfig(serverPath, getDefaultServerConfig({
    port: DEFAULT_SERVER_SETTINGS.port,
    maxRam: DEFAULT_SERVER_SETTINGS.maxRam,
    managementPort: DEFAULT_SERVER_SETTINGS.managementPort,
    autoStartMinecraft: DEFAULT_SERVER_SETTINGS.autoStartMinecraft,
    autoStartManagement: DEFAULT_SERVER_SETTINGS.autoStartManagement
  })) || getDefaultServerConfig(DEFAULT_SERVER_SETTINGS);
}

function createServerHandlers() {
  return {
    'start-server': async (_event, payload = {}) => {
      const targetPath = payload.targetPath;
      const instanceId = payload.instanceId || null;

      if (!targetPath || !fs.existsSync(targetPath)) {
        return { success: false, error: 'Invalid server path', code: 'INVALID_SERVER_PATH' };
      }

      const config = getServerDefaults(targetPath);
      const port = coerceNumber(payload.port, coerceNumber(config.port, 25565));
      const maxRam = coerceNumber(payload.maxRam, coerceNumber(config.maxRam, 4));
      if (port < 1 || port > 65535) {
        return { success: false, error: 'Invalid Minecraft port', code: 'INVALID_MINECRAFT_PORT' };
      }

      if (maxRam <= 0) {
        return { success: false, error: 'Invalid memory allocation', code: 'INVALID_MAX_RAM' };
      }

      const portValidation = await validateServerPorts({
        instanceId,
        serverPath: targetPath,
        minecraftPort: port
      });

      if (!portValidation.valid) {
        return {
          success: false,
          error: portValidation.errors[0].message,
          code: 'PORT_CONFLICT',
          details: portValidation.errors
        };
      }

      appStore.set('lastServerPath', targetPath);
      return startMinecraftServer({
        instanceId,
        targetPath,
        port,
        maxRam
      });
    },

    'stop-server': async (_event, payload = {}) => {
      const stopped = stopMinecraftServer({ instanceId: payload.instanceId || null, targetPath: payload.targetPath || null });
      return { success: !!stopped };
    },

    'kill-server': async (_event, payload = {}) => {
      const killed = killMinecraftServer({ instanceId: payload.instanceId || null, targetPath: payload.targetPath || null });
      return { success: !!killed };
    },

    'send-command': async (_event, payload = {}) => {
      if (!payload.command || typeof payload.command !== 'string') {
        return { success: false, error: 'Invalid command' };
      }

      const sent = sendServerCommand(
        { instanceId: payload.instanceId || null, targetPath: payload.targetPath || null },
        payload.command
      );
      return { success: !!sent };
    },

    'get-server-status': (_event, payload = {}) => {
      const selector = payload && typeof payload === 'object'
        ? { instanceId: payload.instanceId || null, targetPath: payload.targetPath || null }
        : { instanceId: null, targetPath: null };
      const state = getServerState(selector);
      const settings = state.targetPath ? getServerDefaults(state.targetPath) : getDefaultServerConfig();

      return {
        instanceId: state.instanceId,
        isRunning: state.isRunning,
        status: state.status || (state.isRunning ? 'running' : 'stopped'),
        serverStartMs: state.serverStartMs || null,
        playersInfo: state.playersInfo || { count: 0, names: [] },
        serverSettings: {
          port: coerceNumber(settings.port, 25565),
          maxRam: coerceNumber(settings.maxRam, 4),
          managementPort: coerceNumber(settings.managementPort, 8080),
          autoStartMinecraft: !!settings.autoStartMinecraft,
          autoStartManagement: !!settings.autoStartManagement
        },
        targetPath: state.targetPath || null,
        loader: state.loader || settings.loader || 'vanilla'
      };
    },

    'get-all-server-statuses': () => {
      const savedInstances = (appStore.get('instances') || []).filter((instance) => instance && instance.type === 'server');
      const knownStates = new Map();

      for (const instance of savedInstances) {
        const state = getServerState({
          instanceId: instance.id || null,
          targetPath: instance.path || null
        });
        if (state?.instanceId) {
          knownStates.set(state.instanceId, state);
        }
      }

      for (const state of getAllServerStates()) {
        if (state?.instanceId) {
          knownStates.set(state.instanceId, state);
        }
      }

      return Array.from(knownStates.values()).map((state) => ({
        instanceId: state.instanceId,
        isRunning: state.isRunning,
        status: state.status,
        targetPath: state.targetPath,
        port: state.port,
        loader: state.loader,
        playersInfo: state.playersInfo
      }));
    }
  };
}

module.exports = { createServerHandlers };
