// IPC handlers for the Electron app
const { ipcMain } = require('electron');
const fs = require('fs');
const { registerIpcHandlers, registeredHandlers } = require('./utils/ipc-helpers.cjs');
const appStore = require('./utils/app-store.cjs');

// Import modular IPC handler creators
const { createServerHandlers } = require('./ipc/server-handlers.cjs');
const { createFileHandlers } = require('./ipc/file-handlers.cjs');
const { createPlayerHandlers, initializePlayerIpMap } = require('./ipc/player-handlers.cjs');
const { createInstallHandlers } = require('./ipc/install-handlers.cjs');
const { createSettingsHandlers } = require('./ipc/settings-handlers.cjs');
const { createModHandlers } = require('./ipc/mod-handlers.cjs');
const { createConfigHandlers } = require('./ipc/config-handlers.cjs');
const { createServerPropertiesHandlers } = require('./ipc/server-properties-handlers.cjs');
const { createBackupHandlers, loadBackupManager } = require('./ipc/backup-handlers.cjs');
const { createManagementServerHandlers } = require('./ipc/management-server-handlers.cjs');
const { createMinecraftLauncherHandlers } = require('./ipc/minecraft-launcher-handlers.cjs');

// Import auto-restart services for the one remaining handler
const {
  setAutoRestartOptions,
  getAutoRestartState
} = require('./services/auto-restart.cjs');

// This was preventing debug messages from appearing in minecraft launcher methods

/**
 * Set up all IPC handlers
 * 
 * @param {Electron.BrowserWindow} win - The main application window
 */
function setupIpcHandlers(win) {
  if (!win) {
    return;
  }

  // Initialize track registered handler names
  registeredHandlers.clear();
    
    // Get all handler modules
    const fileHandlers = createFileHandlers(win);
    const modHandlers = createModHandlers(win);
    const serverPropertiesHandlers = createServerPropertiesHandlers(win);
    const installHandlers = createInstallHandlers(win);
    const configHandlers = createConfigHandlers(win);
    const playerHandlers = createPlayerHandlers(win);
    const serverHandlers = createServerHandlers(win);
    const settingsHandlers = createSettingsHandlers(win);
    const backupHandlers = createBackupHandlers(win);
    const managementServerHandlers = createManagementServerHandlers(win);
    const minecraftLauncherHandlers = createMinecraftLauncherHandlers(win);
    
    // Initialize backup manager
    loadBackupManager(win);
    
    // Loop through each handler object and register the handlers
    [
      backupHandlers,
      fileHandlers,
      modHandlers,
      serverPropertiesHandlers,
      installHandlers,
      configHandlers,
      playerHandlers,
      serverHandlers,
      settingsHandlers,
      managementServerHandlers,
      minecraftLauncherHandlers
    ].forEach(handlers => {
      if (!handlers) return;
    
      Object.entries(handlers).forEach(([channel, handler]) => {
        // Skip if handler is not a function
        if (typeof handler !== 'function') {
          return;
        }
        
        // Check for existing handler to avoid duplicates
        if (registeredHandlers.has(channel)) {
          // Remove existing handler to prevent conflicts
          ipcMain.removeHandler(channel);
          registeredHandlers.delete(channel);
        }
        
        // Register handler (removed verbose logging)
        ipcMain.handle(channel, handler);
        registeredHandlers.add(channel);
      });
    });
    
    // Setup direct event listeners for progress reporting
    win.webContents.on('did-finish-load', () => {
      // Setup a function to safely forward progress events to the renderer
      const forwardProgressEvent = (channel, data) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(channel, data);
        }
      };
      
      // Listen for global progress events and forward them
      const events = require('events');
      const globalEvents = new events.EventEmitter();
      
      // Setup global event listeners
      globalEvents.on('minecraft-server-progress', (data) => {
        forwardProgressEvent('minecraft-server-progress', data);
      });
      
      globalEvents.on('fabric-install-progress', (data) => {
        forwardProgressEvent('fabric-install-progress', data);
      });
      
      globalEvents.on('install-log', (line) => {
        forwardProgressEvent('install-log', line);
      });
      
      // Store event emitter on global scope for use in other modules
      global.progressEvents = globalEvents;
    });
    
    // Register auto-restart handlers
    registerIpcHandlers({
      'get-auto-restart': () => getAutoRestartState(),
      'set-auto-restart': (_e, options) => setAutoRestartOptions(options)
    });
      // delete-instance handler is registered in settings-handlers.cjs
    
    // Initialize player-IP map with the last server path
    const lastServerPath = appStore.get('lastServerPath');
    if (lastServerPath && fs.existsSync(lastServerPath)) {
      initializePlayerIpMap(lastServerPath);
    }
    
  
}

module.exports = { setupIpcHandlers };
