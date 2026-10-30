// Auto-restart service
const fs = require('fs');
const path = require('path');
const { safeSend } = require('../utils/safe-send.cjs');
const eventBus = require('../utils/event-bus.cjs');
const appStore = require('../utils/app-store.cjs');
const {
  readServerConfig,
  updateServerConfig,
  getDefaultServerConfig
} = require('../utils/config-manager.cjs');
const { ModpackError } = require('./modpacks/errors.cjs');
const {
  LIVE_SERVER_FOLDER_MESSAGE,
  probeLiveServerFolder
} = require('./modpack-lifecycle/live-server-folder-probe.cjs');

// Load initial auto-restart state from persistent store
const storedAutoRestart = appStore.get('autoRestart') || { enabled: false, delay: 10, maxCrashes: 3 };

// Auto-restart state
let autoRestartEnabled = storedAutoRestart.enabled;
let autoRestartDelay = storedAutoRestart.delay; // Default delay in seconds
let autoRestartTimer = null;
let pendingAutoRestartPath = null;
let serverCrashCount = 0;
let maxCrashesBeforeDisable = storedAutoRestart.maxCrashes;
let listenersInitialized = false;
const recoveryHolds = new Map();

function applyAutoRestartState(source = {}) {
  const defaults = getDefaultServerConfig().autoRestart || { enabled: false, delay: 10, maxCrashes: 3 };
  autoRestartEnabled = typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled;
  autoRestartDelay = typeof source.delay === 'number' ? source.delay : defaults.delay;
  maxCrashesBeforeDisable = typeof source.maxCrashes === 'number' ? source.maxCrashes : defaults.maxCrashes;
}

function serverPathKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(value.trim()).normalize('NFC').toLocaleLowerCase('en-US');
}

function restartTargetPath(restartInfo) {
  const serverInfo = restartInfo?.serverInfo;
  if (typeof serverInfo?.targetPath === 'string' && serverInfo.targetPath.trim()) return serverInfo.targetPath.trim();
  if (typeof serverInfo?.jar === 'string' && serverInfo.jar.trim()) return path.dirname(serverInfo.jar);
  return null;
}

function initializeAutoRestartListeners() {
  if (listenersInitialized) return false;
  eventBus.on('server-crashed', handleServerCrash);
  eventBus.on('server-normal-exit', handleNormalExit);
  eventBus.on('server-started', handleServerStarted);
  listenersInitialized = true;
  return true;
}

function disposeAutoRestartListeners() {
  if (!listenersInitialized) return false;
  eventBus.removeListener('server-crashed', handleServerCrash);
  eventBus.removeListener('server-normal-exit', handleNormalExit);
  eventBus.removeListener('server-started', handleServerStarted);
  listenersInitialized = false;
  cancelAutoRestart();
  return true;
}

function isRecoveryHeld(serverPath) {
  const key = serverPathKey(serverPath);
  return key ? recoveryHolds.has(key) : recoveryHolds.size > 0;
}

function beginRecoveryHold({ serverPath, operationId } = {}) {
  const key = serverPathKey(serverPath);
  if (!key || typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) {
    throw new TypeError('Recovery hold is invalid');
  }
  const current = recoveryHolds.get(key);
  if (current && current !== operationId) throw new Error('A different recovery operation already holds this server');
  recoveryHolds.set(key, operationId);
  if (pendingAutoRestartPath === key) cancelAutoRestart();
  return Object.freeze({ held: true, operationId, serverPath });
}

function restoreRecoveryAutoRestart({ serverPath, operationId, enabled } = {}) {
  const key = serverPathKey(serverPath);
  if (!key || typeof operationId !== 'string' || recoveryHolds.get(key) !== operationId || typeof enabled !== 'boolean') {
    throw new TypeError('Recovery hold does not match');
  }
  const defaults = getDefaultServerConfig();
  const config = readServerConfig(serverPath, defaults);
  const current = config?.autoRestart || defaults.autoRestart || { enabled: false, delay: 10, maxCrashes: 3 };
  const preserved = {
    enabled,
    delay: typeof current.delay === 'number' ? current.delay : 10,
    maxCrashes: typeof current.maxCrashes === 'number' ? current.maxCrashes : 3
  };
  if (current.enabled !== enabled) {
    updateServerConfig(serverPath, { autoRestart: preserved }, defaults);
  }
  applyAutoRestartState(preserved);
  recoveryHolds.delete(key);
  return Object.freeze({ restored: true, enabled, serverPath });
}

function hasPendingAutoRestart(serverPath = null) {
  if (!autoRestartTimer) return false;
  const key = serverPathKey(serverPath);
  return key ? pendingAutoRestartPath === key : true;
}

/**
 * Schedule an auto-restart for a crashed server
 * 
 * @param {object} restartInfo - Information about the server that crashed
 */
function scheduleAutoRestart(restartInfo) {
  const requestedPath = restartTargetPath(restartInfo);
  const requestedKey = serverPathKey(requestedPath);
  if (requestedKey && recoveryHolds.has(requestedKey)) return false;
  serverCrashCount++;
  
  if (serverCrashCount >= maxCrashesBeforeDisable) {
    safeSend('server-log', `[WARNING] Server crashed ${serverCrashCount} times. Auto-restart has been disabled.`);
    autoRestartEnabled = false;
    safeSend('auto-restart-status', { 
      enabled: false,
      delay: autoRestartDelay,
      maxCrashes: maxCrashesBeforeDisable,
      crashCount: serverCrashCount
    });
    return false;
  }
  
  const seconds = autoRestartDelay;
  safeSend('server-log', `[INFO] Server will auto-restart in ${seconds} seconds. Crash count: ${serverCrashCount}/${maxCrashesBeforeDisable}`);
  
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
  }
  pendingAutoRestartPath = requestedKey;
  
  autoRestartTimer = setTimeout(() => {
    autoRestartTimer = null;
    const scheduledKey = pendingAutoRestartPath;
    pendingAutoRestartPath = null;
    if (scheduledKey && recoveryHolds.has(scheduledKey)) return;
    safeSend('server-log', `[INFO] Auto-restarting server now...`);
    safeSend('server-status', 'restarting');
    
    try {
      let targetPathToRestart, portToRestart, maxRamToRestart;
      
      if (restartInfo && restartInfo.serverInfo) {
        targetPathToRestart = restartInfo.serverInfo.targetPath;
        
        if (!targetPathToRestart && restartInfo.serverInfo.jar) {
          targetPathToRestart = path.dirname(restartInfo.serverInfo.jar);
        }
        
        portToRestart = restartInfo.serverInfo.port || 25565;
        maxRamToRestart = restartInfo.serverInfo.maxRam || 4;
        
        if (!targetPathToRestart) {
          const lastServerPath = appStore.get('lastServerPath');
          if (lastServerPath) {
            if (fs.existsSync(lastServerPath)) {
              targetPathToRestart = lastServerPath;
              safeSend('server-log', `[INFO] Using last known server path: ${targetPathToRestart}`);
            } else {
              safeSend('server-log', `[WARNING] Stored server path not found: ${lastServerPath}`);
            }
          }
        }

        if (!targetPathToRestart) {
          const possiblePath = path.join(process.cwd(), 'test');
          if (fs.existsSync(possiblePath)) {
            targetPathToRestart = possiblePath;
            safeSend('server-log', `[INFO] Using fallback server path: ${targetPathToRestart}`);
          }
        }
      } else {
        safeSend('server-log', `[WARNING] Server info missing during auto-restart`);
      }
      
      if (!targetPathToRestart) {
        safeSend('server-log', `[ERROR] Auto-restart failed: Server path is missing`);
        return;
      }
      
      if (!portToRestart) {
        portToRestart = 25565;
        safeSend('server-log', `[WARNING] Using default port 25565 for auto-restart`);
      }
      
      if (!maxRamToRestart) {
        maxRamToRestart = 4;
        safeSend('server-log', `[WARNING] Using default RAM 4GB for auto-restart`);
      }
      
      if (targetPathToRestart && fs.existsSync(targetPathToRestart)) {
        safeSend('server-log', `[INFO] Auto-restarting server at ${targetPathToRestart} with port ${portToRestart} and RAM ${maxRamToRestart}GB`);
        
        setTimeout(() => {
          if (isRecoveryHeld(targetPathToRestart)) return;
          const requestAccepted = eventBus.emit('request-server-start', {
            targetPath: targetPathToRestart,
            port: portToRestart,
            maxRam: maxRamToRestart
          });
          if (requestAccepted) {
            safeSend('server-log', `[INFO] Auto-restart request sent`);
          } else {
            safeSend('server-log', `[ERROR] Auto-restart failed: no server start handler is registered`);
          }
        }, 2000);
      } else {
        safeSend('server-log', `[ERROR] Cannot auto-restart: invalid server path ${targetPathToRestart}`);
      }
    } catch (restartErr) {
      safeSend('server-log', `[ERROR] Auto-restart failed: ${restartErr.message}`);
    }
  }, seconds * 1000);
  return true;
}

/**
 * Cancel any pending auto-restart timer
 */
function cancelAutoRestart() {
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
    pendingAutoRestartPath = null;
    safeSend('server-log', `[INFO] Auto-restart canceled`);
  }
}

/**
 * Reset the crash counter
 */
function resetCrashCount() {
  serverCrashCount = 0;
}

function persistAutoRestartState(targetPath) {
  if (targetPath) {
    updateServerConfig(targetPath, {
      autoRestart: {
        enabled: autoRestartEnabled,
        delay: autoRestartDelay,
        maxCrashes: maxCrashesBeforeDisable
      }
    }, getDefaultServerConfig());
    return;
  }

  appStore.set('autoRestart', {
    enabled: autoRestartEnabled,
    delay: autoRestartDelay,
    maxCrashes: maxCrashesBeforeDisable
  });
}

/**
 * Configure the auto-restart settings
 * 
 * @param {object} options - Configuration options
 * @returns {object} The updated auto-restart state
 */
function setAutoRestartOptions(options) {
  if (typeof options.enabled === 'boolean') {
    autoRestartEnabled = options.enabled;
  }
  
  if (typeof options.delay === 'number' && options.delay >= 5 && options.delay <= 300) {
    autoRestartDelay = options.delay;
  }
  
  if (typeof options.maxCrashes === 'number' && options.maxCrashes >= 1 && options.maxCrashes <= 10) {
    maxCrashesBeforeDisable = options.maxCrashes;
  }

  const targetPath = typeof options.targetPath === 'string' && options.targetPath.trim()
    ? options.targetPath.trim()
    : null;
  persistAutoRestartState(targetPath);
  
  // Reset crash count when enabling
  if (options.enabled) {
    serverCrashCount = 0;
  }
  
  const state = getAutoRestartState(targetPath);
  
  // Notify the renderer of the change
  safeSend('auto-restart-status', state);
  
  return state;
}

/**
 * Get the current auto-restart configuration
 * 
 * @returns {object} The current auto-restart state
 */
function getAutoRestartState(targetPath = null) {
  if (targetPath) {
    initFromServerConfig(targetPath);
  }
  return {
    enabled: autoRestartEnabled, 
    delay: autoRestartDelay,
    maxCrashes: maxCrashesBeforeDisable,
    crashCount: serverCrashCount 
  };
}

/**
 * Handler for server crash events
 * 
 * @param {object} restartInfo - Information about the server that crashed
 */
function handleServerCrash(restartInfo) {
  const targetPath = restartTargetPath(restartInfo);
  if (targetPath && isRecoveryHeld(targetPath)) {
    safeSend('server-log', `[INFO] Auto-restart is suspended while server recovery is active.`);
    return;
  }
  if (autoRestartEnabled) {
    // Handle auto-restart logic
    scheduleAutoRestart(restartInfo);
  } else {
    safeSend('server-log', `[INFO] Auto-restart is disabled. Server will not be restarted automatically.`);
  }
}

/**
 * Handler for normal server exit events
 * (No longer resets crash count to preserve across auto-restarts)
 */
function handleNormalExit() {
  cancelAutoRestart();
}

/**
 * Handler for server start events
 * (No longer resets crash count here to preserve count across auto-restarts)
 */
function handleServerStarted() {
  // intentionally left blank to preserve crashCount
}

/**
 * Initialize auto-restart settings from server config file
 * This allows per-server settings to override app-level defaults
 * 
 * @param {string} serverPath - Path to the server directory
 */
function initFromServerConfig(serverPath) {
  if (!serverPath) {
    applyAutoRestartState(storedAutoRestart);
    return;
  }

  const config = readServerConfig(serverPath, getDefaultServerConfig());
  applyAutoRestartState(config?.autoRestart || getDefaultServerConfig().autoRestart);
}

// The in-memory stop only covers servers this app started. A server started
// elsewhere (run.bat, another launcher, or one that outlived an app crash
// without an armed watchdog) still holds its world lock; lifecycle and recovery
// operations must not copy or swap the folder under it.
async function assertNoLiveServerInFolder(request, liveFolderProbe) {
  let evidence = null;
  let cause;
  try {
    evidence = await liveFolderProbe(request?.serverPath);
  } catch (error) {
    cause = error;
  }
  if (evidence?.live === false) return;
  throw new ModpackError('SERVER_RUNNING', LIVE_SERVER_FOLDER_MESSAGE, {
    cause,
    details: typeof request?.instanceId === 'string' ? { serverId: request.instanceId } : undefined,
    retryable: true
  });
}

function createRecoveryRuntimePolicy({ runtimeController, liveFolderProbe = probeLiveServerFolder } = {}) {
  if (!runtimeController || typeof runtimeController !== 'object' ||
      typeof runtimeController.ensureStopped !== 'function' ||
      typeof runtimeController.adoptValidatedHandoff !== 'function' ||
      typeof liveFolderProbe !== 'function') {
    throw new TypeError('Recovery runtime controller is invalid');
  }
  const adopted = new Map();
  const restored = new Map();
  function normalizeAdoption(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        typeof request.eventId !== 'string' || typeof request.jobId !== 'string' ||
        request.eventId !== `modpack-runtime-handoff:${request.jobId}` ||
        typeof request.instanceId !== 'string' || !request.handoff || typeof request.handoff !== 'object') {
      throw new Error('Validated runtime handoff request is invalid');
    }
    const leasePath = request.handoff.startLease?.serverPath;
    const serverPath = request.serverPath || leasePath;
    const requestedKey = serverPathKey(serverPath);
    const leaseKey = serverPathKey(leasePath);
    if (!requestedKey || !leaseKey || requestedKey !== leaseKey) {
      throw new Error('Validated runtime handoff path is invalid');
    }
    return Object.freeze({ ...request, serverPath });
  }
  return Object.freeze({
    suspend(request) {
      const hold = beginRecoveryHold({ serverPath: request.serverPath, operationId: request.operationId });
      restored.delete(serverPathKey(request.serverPath));
      return hold;
    },
    async ensureStopped(request) {
      const result = await runtimeController.ensureStopped(request);
      if (!result || (result.stopped !== true && result.success !== true && result.alreadyStopped !== true)) {
        throw new Error('Server runtime could not be proven stopped');
      }
      await assertNoLiveServerInFolder(request, liveFolderProbe);
      const requestedPathKey = serverPathKey(request?.serverPath);
      for (const [eventId, prior] of adopted) {
        if (prior.jobId === request?.jobId && prior.instanceId === request?.instanceId &&
            prior.serverPathKey === requestedPathKey) adopted.delete(eventId);
      }
      return result;
    },
    async adoptValidatedHandoff(request) {
      const normalized = normalizeAdoption(request);
      const prior = adopted.get(normalized.eventId);
      if (prior) {
        if (prior.instanceId !== normalized.instanceId || prior.jobId !== normalized.jobId ||
            prior.serverPathKey !== serverPathKey(normalized.serverPath) ||
            prior.processHandle !== normalized.handoff.processHandle || prior.startLease !== normalized.handoff.startLease) {
          throw new Error('Validated runtime handoff identity does not match the prior adoption');
        }
        return prior.result;
      }
      const result = await runtimeController.adoptValidatedHandoff(normalized);
      if (!result || result.adopted !== true) throw new Error('Validated runtime handoff was not adopted');
      const frozen = Object.freeze({ ...result, adopted: true });
      adopted.set(normalized.eventId, Object.freeze({
        instanceId: normalized.instanceId,
        jobId: normalized.jobId,
        processHandle: normalized.handoff.processHandle,
        result: frozen,
        serverPathKey: serverPathKey(normalized.serverPath),
        startLease: normalized.handoff.startLease
      }));
      return frozen;
    },
    restoreAutoRestart(request) {
      const key = serverPathKey(request?.serverPath);
      if (!key || typeof request?.operationId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.operationId) ||
          typeof request?.enabled !== 'boolean') {
        throw new TypeError('Recovery restoration is invalid');
      }
      const prior = restored.get(key);
      if (prior) {
        if (prior.operationId !== request.operationId || prior.enabled !== request.enabled) {
          throw new TypeError('Recovery restoration does not match');
        }
        return prior.result;
      }
      const result = restoreRecoveryAutoRestart({
        serverPath: request.serverPath,
        operationId: request.operationId,
        enabled: request.enabled
      });
      restored.set(key, Object.freeze({
        operationId: request.operationId,
        enabled: request.enabled,
        result
      }));
      return result;
    }
  });
}

module.exports = {
  beginRecoveryHold,
  cancelAutoRestart,
  createRecoveryRuntimePolicy,
  disposeAutoRestartListeners,
  setAutoRestartOptions,
  getAutoRestartState,
  hasPendingAutoRestart,
  initializeAutoRestartListeners,
  isRecoveryHeld,
  resetCrashCount,
  initFromServerConfig,
  restoreRecoveryAutoRestart
};
