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
const { createClientModHandlers } = require('./ipc/mod-handlers/client-mod-handlers.cjs');
const { createConfigHandlers } = require('./ipc/config-handlers.cjs');
const { createServerPropertiesHandlers } = require('./ipc/server-properties-handlers.cjs');
const { createBackupHandlers, loadBackupManager } = require('./ipc/backup-handlers.cjs');
const { createManagementServerHandlers } = require('./ipc/management-server-handlers.cjs');
const { createBrowserPanelHandlers } = require('./ipc/browser-panel-handlers.cjs');
const { createMinecraftLauncherHandlers } = require('./ipc/minecraft-launcher-handlers.cjs');
const { createServerJavaHandlers } = require('./ipc/server-java-handlers.cjs');
const { createAppSettingsHandlers } = require('./ipc/app-settings-handlers.cjs');
const { createUpdateHandlers } = require('./ipc/update-handlers.cjs');
const { createMetricsHandlers } = require('./ipc/metrics-handlers.cjs');
const { getLoggerHandlers } = require('./ipc/logger-handlers.cjs');
const { createErrorMonitoringHandlers } = require('./ipc/error-monitoring-handlers.cjs');
const { createUtilityHandlers } = require('./ipc/utility-handlers.cjs');
const { createModAvailabilityHandlers } = require('./ipc/mod-availability-handlers.cjs');
const { createModpackHandlers } = require('./ipc/modpack-handlers.cjs');
const { createServerMutationPolicy } = require('./services/server-mutation-policy.cjs');

// Import auto-restart services for the one remaining handler
const {
  setAutoRestartOptions,
  getAutoRestartState
} = require('./services/auto-restart.cjs');



/**
 * Set up all IPC handlers
 * 
 * @param {Electron.BrowserWindow} win - The main application window
 */
function setupIpcHandlers(win, dependencies = {}) {
  if (!win) {
    return;
  }

  const store = dependencies.store || appStore;
  const fsApi = dependencies.filesystem?.sync || fs;
  const ipcDependencies = dependencies.ipc || {};
  const ipcMainApi = ipcDependencies.ipcMain || ipcMain;
  const registerHandlers = ipcDependencies.registerIpcHandlers || registerIpcHandlers;
  const backupManagerLoader = ipcDependencies.loadBackupManager || loadBackupManager;
  const initializePlayerMap = ipcDependencies.initializePlayerIpMap || initializePlayerIpMap;
  const handlerFactories = {
    createServerHandlers,
    createFileHandlers,
    createPlayerHandlers,
    createInstallHandlers,
    createSettingsHandlers,
    createModHandlers,
    createClientModHandlers,
    createConfigHandlers,
    createServerPropertiesHandlers,
    createBackupHandlers,
    createManagementServerHandlers,
    createBrowserPanelHandlers,
    createMinecraftLauncherHandlers,
    createServerJavaHandlers,
    createAppSettingsHandlers,
    createUpdateHandlers,
    createMetricsHandlers,
    getLoggerHandlers,
    createErrorMonitoringHandlers,
    createUtilityHandlers,
    createModAvailabilityHandlers,
    createModpackHandlers,
    ...(ipcDependencies.handlerFactories || {})
  };

  // Initialize track registered handler names
  registeredHandlers.clear();
    const serverMutationPolicy = dependencies.serverMutationPolicy || createServerMutationPolicy({
      coordinator: dependencies.serverMutationCoordinator,
      getInstances: () => store.get('instances') || []
    });
    // Get all handler modules
    const fileHandlers = handlerFactories.createFileHandlers(win);
    const modHandlers = handlerFactories.createModHandlers(win);
    const clientModHandlers = handlerFactories.createClientModHandlers(win);
    const serverPropertiesHandlers = handlerFactories.createServerPropertiesHandlers();
    const installHandlers = handlerFactories.createInstallHandlers(win);
    const configHandlers = handlerFactories.createConfigHandlers();
    const playerHandlers = handlerFactories.createPlayerHandlers();
    const serverHandlers = handlerFactories.createServerHandlers(win);
    const settingsHandlers = handlerFactories.createSettingsHandlers();
    const backupHandlers = handlerFactories.createBackupHandlers();
    const managementServerHandlers = handlerFactories.createManagementServerHandlers(win);
  const browserPanelHandlers = handlerFactories.createBrowserPanelHandlers(win);
    const minecraftLauncherHandlers = handlerFactories.createMinecraftLauncherHandlers(win);
    const serverJavaHandlers = handlerFactories.createServerJavaHandlers(win);
    const appSettingsHandlers = handlerFactories.createAppSettingsHandlers();
    const updateHandlers = handlerFactories.createUpdateHandlers(win);
    const metricsHandlers = handlerFactories.createMetricsHandlers();
    const errorMonitoringHandlers = handlerFactories.createErrorMonitoringHandlers(win);
  const utilityHandlers = handlerFactories.createUtilityHandlers(win);
  const modAvailabilityHandlers = handlerFactories.createModAvailabilityHandlers({
    startWatcher: ipcDependencies.nativeNotificationsEnabled !== false
  });
  const modpackHandlers = dependencies.modpacks
    ? handlerFactories.createModpackHandlers(dependencies.modpacks)
    : null;
    
    // Initialize logger handlers (singleton, no creation needed)
    const loggerHandlers = handlerFactories.getLoggerHandlers();
    
    // Log system startup
    loggerHandlers.info('Application IPC handlers initialized', {
      category: 'core',
      data: { handlersLoaded: registeredHandlers.size }
    });
    
    // Test logs removed after initial development testing
    

    

    
    // Initialize backup manager
    backupManagerLoader();    // Loop through each handler object and register the handlers
    [
      backupHandlers,
      fileHandlers,
      modHandlers,
      clientModHandlers,
      serverPropertiesHandlers,
      installHandlers,
      configHandlers,
      playerHandlers,
      serverHandlers,
      settingsHandlers,
      managementServerHandlers,
  browserPanelHandlers,
      minecraftLauncherHandlers,
      serverJavaHandlers,
      updateHandlers,
      metricsHandlers,
  errorMonitoringHandlers,
  utilityHandlers,
  modAvailabilityHandlers,
  modpackHandlers,
      loggerHandlers
    ].forEach((handlers) => {
      if (!handlers) {
        return;
      }
    
      Object.entries(handlers).forEach(([channel, handler]) => {
        // Skip if handler is not a function
        if (typeof handler !== 'function') {
          return;
        }
        
        // Check for existing handler to avoid duplicates
        if (registeredHandlers.has(channel)) {
          // Remove existing handler to prevent conflicts
          ipcMainApi.removeHandler(channel);
          registeredHandlers.delete(channel);
        }
        
        // Ensure handler has the correct signature for ipcMain.handle
        const coordinatedHandler = serverMutationPolicy.wrapHandler(channel, handler);
        const wrappedHandler = (event, ...args) => coordinatedHandler(event, ...args);
        ipcMainApi.handle(channel, wrappedHandler);
        registeredHandlers.add(channel);
      });    });
    
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
    registerHandlers(serverMutationPolicy.wrapHandlers({
      'get-auto-restart': (_e, targetPath) => getAutoRestartState(targetPath),
      'set-auto-restart': (_e, options) => setAutoRestartOptions(options)
    }));
    
    // Register app settings handlers
    Object.entries(appSettingsHandlers).forEach(([channel, handler]) => {
      // Skip if handler is not a function
      if (typeof handler !== 'function') {
        return;
      }
      
      // Check for existing handler to avoid duplicates
      if (registeredHandlers.has(channel)) {
        // Remove existing handler to prevent conflicts
        ipcMainApi.removeHandler(channel);
        registeredHandlers.delete(channel);
      }
      
      // Ensure handler has the correct signature for ipcMain.handle
      const wrappedHandler = (event, ...args) => handler(event, ...args);
      ipcMainApi.handle(channel, wrappedHandler);
      registeredHandlers.add(channel);
    });
      // delete-instance handler is registered in settings-handlers.cjs
    
    // Initialize player-IP map with the last server path
    const lastServerPath = store.get('lastServerPath');
    if (lastServerPath && fsApi.existsSync(lastServerPath)) {
      initializePlayerMap(lastServerPath);
    }
    
  
}

module.exports = { setupIpcHandlers };
