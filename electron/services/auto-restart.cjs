// Auto-restart service
const fs = require('fs');
const path = require('path');
const { safeSend } = require('../utils/safe-send.cjs');
const eventBus = require('../utils/event-bus.cjs');
const appStore = require('../utils/app-store.cjs');

// Load initial auto-restart state from persistent store
const storedAutoRestart = appStore.get('autoRestart') || { enabled: false, delay: 10, maxCrashes: 3 };

// Auto-restart state
let autoRestartEnabled = storedAutoRestart.enabled;
let autoRestartDelay = storedAutoRestart.delay; // Default delay in seconds
let autoRestartTimer = null;
let serverCrashCount = 0;
let maxCrashesBeforeDisable = storedAutoRestart.maxCrashes;

// Set up event listeners
eventBus.on('server-crashed', handleServerCrash);
eventBus.on('server-normal-exit', handleNormalExit);
eventBus.on('server-started', handleServerStarted);

/**
 * Schedule an auto-restart for a crashed server
 * 
 * @param {object} restartInfo - Information about the server that crashed
 */
function scheduleAutoRestart(restartInfo) {
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
    return;
  }
  
  const seconds = autoRestartDelay;
  safeSend('server-log', `[INFO] Server will auto-restart in ${seconds} seconds. Crash count: ${serverCrashCount}/${maxCrashesBeforeDisable}`);
  
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
  }
  
  autoRestartTimer = setTimeout(() => {
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
          eventBus.emit('request-server-start', {
            targetPath: targetPathToRestart,
            port: portToRestart,
            maxRam: maxRamToRestart
          });
          safeSend('server-log', `[INFO] Auto-restart request sent`);
        }, 2000);
      } else {
        safeSend('server-log', `[ERROR] Cannot auto-restart: invalid server path ${targetPathToRestart}`);
      }
    } catch (restartErr) {
      console.error('Error during auto-restart:', restartErr);
      safeSend('server-log', `[ERROR] Auto-restart failed: ${restartErr.message}`);
    }
  }, seconds * 1000);
}

/**
 * Cancel any pending auto-restart timer
 */
function cancelAutoRestart() {
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
    safeSend('server-log', `[INFO] Auto-restart canceled`);
  }
}

/**
 * Reset the crash counter
 */
function resetCrashCount() {
  serverCrashCount = 0;
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
    console.log(`Auto-restart enabled set to: ${autoRestartEnabled}`);
  }
  
  if (typeof options.delay === 'number' && options.delay >= 5 && options.delay <= 300) {
    autoRestartDelay = options.delay;
  }
  
  if (typeof options.maxCrashes === 'number' && options.maxCrashes >= 1 && options.maxCrashes <= 10) {
    maxCrashesBeforeDisable = options.maxCrashes;
  }
    // Save settings to the app-level persistent store
  try {
    appStore.set('autoRestart', {
      enabled: autoRestartEnabled,
      delay: autoRestartDelay,
      maxCrashes: maxCrashesBeforeDisable
    });
  } catch (err) {
    console.error('Error saving auto-restart settings to app store:', err);
  }
    // Also save these settings to the server's config file
  // First try targetPath if provided, otherwise use lastServerPath 
  const targetPath = options.targetPath || appStore.get('lastServerPath');
  if (targetPath) {
    try {
      const configPath = path.join(targetPath, '.minecraft-core.json');
      const config = fs.existsSync(configPath) 
        ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) 
        : {};
      
      config.autoRestart = {
        enabled: autoRestartEnabled,
        delay: autoRestartDelay,
        maxCrashes: maxCrashesBeforeDisable
      };
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (err) {
      console.error('Error saving auto-restart settings:', err);
    }
  }
  
  // Reset crash count when enabling
  if (options.enabled) {
    serverCrashCount = 0;
  }
  
  const state = getAutoRestartState();
  
  // Notify the renderer of the change
  safeSend('auto-restart-status', state);
  
  return state;
}

/**
 * Get the current auto-restart configuration
 * 
 * @returns {object} The current auto-restart state
 */
function getAutoRestartState() {
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
  console.log('Server crash detected, auto-restart enabled:', autoRestartEnabled);
  
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
  if (!serverPath) return;
  
  try {
    const configPath = path.join(serverPath, '.minecraft-core.json');
    
    if (fs.existsSync(configPath)) {
      let config;
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (parseErr) {
        console.error('Error parsing server config:', parseErr);
        return;
      }
      
      if (config && config.autoRestart) {
        if (typeof config.autoRestart.enabled === 'boolean') {
          autoRestartEnabled = config.autoRestart.enabled;
        }
        
        if (typeof config.autoRestart.delay === 'number') {
          autoRestartDelay = config.autoRestart.delay;
        }
        
        if (typeof config.autoRestart.maxCrashes === 'number') {
          maxCrashesBeforeDisable = config.autoRestart.maxCrashes;
        }
        
        try {
          appStore.set('autoRestart', {
            enabled: autoRestartEnabled,
            delay: autoRestartDelay,
            maxCrashes: maxCrashesBeforeDisable
          });
        } catch (storeErr) {
          console.error('Error saving to app store:', storeErr);
        }
      }
    }
  } catch (err) {
    console.error('Error loading auto-restart settings from server config:', err);
  }
}

module.exports = {
  cancelAutoRestart,
  setAutoRestartOptions,
  getAutoRestartState,
  resetCrashCount,
  initFromServerConfig
};
