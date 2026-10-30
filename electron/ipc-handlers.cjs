// IPC handlers for the Electron app
const electron = require('electron');
const { ipcMain } = electron;
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
const { createModpackHandlers, createUnavailableModpackHandlers } = require('./ipc/modpack-handlers.cjs');
const { createClientPackHandlers, createUnavailableClientPackHandlers } = require('./ipc/client-pack-handlers.cjs');
const { createManagementSessionHandlers } = require('./ipc/management-session-handlers.cjs');
const { createServerMutationPolicy } = require('./services/server-mutation-policy.cjs');

// Import auto-restart services for the one remaining handler
const {
  setAutoRestartOptions,
  getAutoRestartState
} = require('./services/auto-restart.cjs');

const START_MINIMIZED_ARGUMENT = '--start-minimized';

function runningServersForRelaunch() {
  try {
    const { getAllServerStates, getServerState } = require('./services/server-manager.cjs');
    const allStates = typeof getAllServerStates === 'function' ? getAllServerStates() : [];
    const states = Array.isArray(allStates) && allStates.length > 0
      ? allStates
      : [typeof getServerState === 'function' ? getServerState() : null];
    return states.filter(state => state && state.isRunning);
  } catch {
    return [];
  }
}

/**
 * Startup health for the degraded-mode banner, plus its Restart and Open log
 * folder actions. Registered without the server mutation policy: none of them
 * writes server files.
 */
function createStartupHandlers({ startup = null, getApp, getShell } = {}) {
  return {
    'startup:get-health': () => (typeof startup?.getHealth === 'function' ? startup.getHealth() : null),
    'startup:relaunch': () => {
      // A restart must not stop a server or interrupt work without the user's say.
      if (runningServersForRelaunch().length > 0) {
        return { success: false, error: 'Stop your running servers, then restart Minecraft Core.' };
      }
      const activeWork = typeof startup?.listActiveWork === 'function' ? startup.listActiveWork() : [];
      if (activeWork.length > 0) {
        return { success: false, error: 'Minecraft Core is still finishing a change. Wait for it to finish, then restart.' };
      }
      const app = getApp();
      // The user asked for the restart, so the new instance shows its window
      // even when this one came from a login start with --start-minimized.
      app.relaunch({ args: process.argv.slice(1).filter(argument => argument !== START_MINIMIZED_ARGUMENT) });
      app.quit();
      return { success: true };
    },
    'startup:open-logs': async () => {
      try {
        const logDirectory = require('path').join(getApp().getPath('userData'), 'logs');
        const failure = await getShell().openPath(logDirectory);
        return failure ? { success: false, error: 'The log folder could not be opened.' } : { success: true };
      } catch {
        return { success: false, error: 'The log folder could not be opened.' };
      }
    }
  };
}


/**
 * Set up all IPC handlers
 * 
 * @param {Electron.BrowserWindow} win - The main application window
 */
function setupIpcHandlers(win, dependencies = {}) {
  if (!win) {
    return;
  }
  if ((dependencies.modpacks?.clientPackService || dependencies.modpacks?.clientPackIntegration) &&
      typeof dependencies.clientPackLaunchOptions?.beginManagedLaunch !== 'function') {
    throw new Error('Matching client services require main-owned launch authority');
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
    createUnavailableModpackHandlers,
    createClientPackHandlers,
    createUnavailableClientPackHandlers,
    createManagementSessionHandlers,
    createStartupHandlers,
    ...(ipcDependencies.handlerFactories || {})
  };

  // Initialize track registered handler names
  registeredHandlers.clear();
    const serverMutationPolicy = dependencies.serverMutationPolicy || createServerMutationPolicy({
      coordinator: dependencies.serverMutationCoordinator,
      getClientPackIntegration: dependencies.modpacks ? () => dependencies.modpacks.clientPackIntegration : null,
      // Read-only classification through the state observer; without one, the
      // strict repository (which refuses more) still decides.
      getModpackStateRepository: dependencies.modpacks
        ? () => dependencies.modpacks.stateObserver || dependencies.modpacks.stateRepository
        : null,
      getInstances: () => store.get('instances') || []
    });
    // Get all handler modules
    const fileHandlers = handlerFactories.createFileHandlers(win, {
      assertServerDestination: dependencies.modpacks ? async clientPath => {
        const integration = dependencies.modpacks.clientPackIntegration;
        if (!integration?.assertServerDestination) throw new Error('Matching client ownership services are not ready');
        return integration.assertServerDestination(clientPath);
      } : null
    });
    const modHandlers = handlerFactories.createModHandlers(win);
    const clientModHandlers = handlerFactories.createClientModHandlers(win);
    const serverPropertiesHandlers = handlerFactories.createServerPropertiesHandlers();
    const installHandlers = handlerFactories.createInstallHandlers(win);
    const configHandlers = handlerFactories.createConfigHandlers();
    const playerHandlers = handlerFactories.createPlayerHandlers();
    const serverHandlers = handlerFactories.createServerHandlers(win);
    const settingsHandlers = handlerFactories.createSettingsHandlers({
      invalidateManagementSession: clientId => dependencies.modpacks?.managementSessionBroker?.invalidate(clientId)
    });
    const backupHandlers = handlerFactories.createBackupHandlers({
      getModpackStateRepository: dependencies.modpacks ? () => dependencies.modpacks.stateRepository : null
    });
    const managementServerHandlers = handlerFactories.createManagementServerHandlers(win);
  const browserPanelHandlers = handlerFactories.createBrowserPanelHandlers(win);
    const minecraftLauncherHandlers = handlerFactories.createMinecraftLauncherHandlers(win, dependencies.clientPackLaunchOptions || {});
    const serverJavaHandlers = handlerFactories.createServerJavaHandlers(win);
    const appSettingsHandlers = handlerFactories.createAppSettingsHandlers();
    const updateHandlers = handlerFactories.createUpdateHandlers(win, {
      updaterEnabled: ipcDependencies.updaterEnabled !== false
    });
    const metricsHandlers = handlerFactories.createMetricsHandlers();
    const errorMonitoringHandlers = handlerFactories.createErrorMonitoringHandlers(win);
  const utilityHandlers = handlerFactories.createUtilityHandlers(win);
  const modAvailabilityHandlers = handlerFactories.createModAvailabilityHandlers({
    startWatcher: ipcDependencies.nativeNotificationsEnabled !== false
  });
  // Modpack services that did not start (degraded startup) keep every modpack
  // and client pack channel registered, answered by the degraded fallbacks.
  const startupHealth = typeof dependencies.startup?.getHealth === 'function' ? dependencies.startup.getHealth() : null;
  const modpacksDegraded = Boolean(dependencies.modpacks && startupHealth) && startupHealth.modpackServices !== 'ready';
  const degradedModpacks = modpacksDegraded ? dependencies.modpacks.degraded || null : null;
  let modpackHandlers = null;
  if (modpacksDegraded) {
    modpackHandlers = handlerFactories.createUnavailableModpackHandlers({
      readServerState: degradedModpacks?.readServerState || null,
      listRecovery: degradedModpacks?.listRecovery || null
    });
  } else if (dependencies.modpacks) {
    modpackHandlers = handlerFactories.createModpackHandlers(dependencies.modpacks);
  }
  let clientPackIpc = null;
  if (modpacksDegraded) {
    clientPackIpc = handlerFactories.createUnavailableClientPackHandlers({
      readClientState: degradedModpacks?.readClientState || null
    });
  } else if (dependencies.modpacks?.clientPackService && dependencies.modpacks?.companionService) {
    clientPackIpc = handlerFactories.createClientPackHandlers(dependencies.modpacks);
  }
  if (clientPackIpc) {
    dependencies.registerClientPackIpcDisposer?.(() => clientPackIpc.dispose());
    win.once?.('closed', () => { void clientPackIpc.dispose().catch(() => {}); });
  }
  const managementSessionIpc = dependencies.modpacks?.managementSessionBroker && dependencies.modpacks?.resolveClientByPath
    ? handlerFactories.createManagementSessionHandlers({ win, broker: dependencies.modpacks.managementSessionBroker,
      resolveClientByPath: dependencies.modpacks.resolveClientByPath }) : null;
  if (managementSessionIpc) {
    dependencies.registerClientPackIpcDisposer?.(() => managementSessionIpc.dispose());
    win.once?.('closed', () => { void managementSessionIpc.dispose().catch(() => {}); });
  }
  // The matching pack requirement friends read from this host's servers: the
  // companion service, or the degraded per-server answer.
  const companionResolver = dependencies.modpacks?.companionResolver;
  if (typeof companionResolver === 'function') {
    require('./services/management-server.cjs').configureClientModpackResolver(companionResolver);
  }
  const startupHandlers = handlerFactories.createStartupHandlers({
    startup: dependencies.startup || null,
    getApp: () => ipcDependencies.app || electron.app,
    getShell: () => ipcDependencies.shell || electron.shell
  });
    
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
  clientPackIpc?.handlers,
  managementSessionIpc?.handlers,
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
    
    // Register app settings and startup handlers (no server writers among them)
    Object.entries({ ...appSettingsHandlers, ...startupHandlers }).forEach(([channel, handler]) => {
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
