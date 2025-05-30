// IPC handlers for the Electron app
const { ipcMain, dialog } = require('electron');
const path = require('path');
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

// Removed the global console.log override that was suppressing debug messages
// This was preventing debug messages from appearing in minecraft launcher methods

/**
 * Set up all IPC handlers
 * 
 * @param {Electron.BrowserWindow} win - The main application window
 */
function setupIpcHandlers(win) {
  console.log('💡 setupIpcHandlers CALLED');
  if (!win) {
    console.error('Cannot setup IPC handlers: No window provided');
    return;
  }

  try {
    console.log('💡 Setting up all IPC handlers...');
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
          console.warn(`Handler for channel '${channel}' is not a function`);
          return;
        }
        
        // Check for existing handler to avoid duplicates
        if (registeredHandlers.has(channel)) {
          // Remove existing handler to prevent conflicts
          console.log(`Removing existing handler for channel: ${channel}`);
          ipcMain.removeHandler(channel);
          registeredHandlers.delete(channel);
        }
        
        // Register handler
        console.log(`Registering IPC handler for channel: ${channel}`);
        ipcMain.handle(channel, handler);
        registeredHandlers.add(channel);
      });
    });
    
    // Setup direct event listeners for progress reporting
    // This ensures that even if the handler doesn't get registered properly,
    // we still have a way to report progress
    win.webContents.on('did-finish-load', () => {
      console.log('Renderer loaded, setting up progress event forwarders');
      
      // Setup a function to safely forward progress events to the renderer
      const forwardProgressEvent = (channel, data) => {
        if (win && !win.isDestroyed()) {
          console.log(`Forwarding progress event on channel ${channel}:`, data);
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
    
    // Ensure the delete-instance handler is directly registered
    if (!registeredHandlers.has('delete-instance')) {
      console.log('Manually registering delete-instance handler');
      const { rm } = require('fs/promises');
      
      ipcMain.handle('delete-instance', async (_e, { id, deleteFiles }) => {
        try {
          console.log(`Deleting instance ${id} (deleteFiles: ${deleteFiles})`);
          
          if (!id) {
            return { success: false, error: 'Invalid instance ID' };
          }
          
          const instances = appStore.get('instances') || [];
          const inst = instances.find(i => i.id === id);
          
          if (!inst) {
            return { success: false, error: 'Instance not found' };
          }
          
          const remaining = instances.filter(i => i.id !== id);
          appStore.set('instances', remaining);
          
          // also clear lastServerPath if it was the deleted one
          if (inst.path && appStore.get('lastServerPath') === inst.path) {
            console.log('Clearing lastServerPath as it matched deleted instance');
            appStore.set('lastServerPath', null);
          }
          
          // optionally delete directory
          if (deleteFiles && inst.path) {
            try {
              console.log(`Deleting server directory: ${inst.path}`);
              await rm(inst.path, { recursive: true, force: true });
              console.log('Server directory deleted successfully');
            } catch (err) {
              console.error('Failed to delete folder:', err);
              return { 
                success: true, 
                instances: remaining,
                warning: `Instance removed but could not delete server files: ${err.message}`
              };
            }
          }
          
          return { success: true, instances: remaining };
        } catch (err) {
          console.error('Error deleting instance:', err);
          return { success: false, error: err.message };
        }
      });
      
      registeredHandlers.add('delete-instance');
    }
    
    // Initialize player-IP map with the last server path
    const lastServerPath = appStore.get('lastServerPath');
    if (lastServerPath && fs.existsSync(lastServerPath)) {
      console.log('Initializing player-IP map with last server path:', lastServerPath);
      initializePlayerIpMap(lastServerPath);
    }
    
    console.log('All IPC handlers successfully registered');
  } catch (error) {
    console.error('Failed to setup IPC handlers:', error);
  }
}

module.exports = { setupIpcHandlers };
