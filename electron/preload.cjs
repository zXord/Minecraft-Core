console.log('=== ROOT/PRELOAD.CJS IS LOADED ===');
const { contextBridge, ipcRenderer } = require('electron');

console.log('Loading preload.cjs with server-properties channels - v1');

// Global shared state - accessible from all renderer processes
let serverPath = '';

// Add an IPC handler to update serverPath
ipcRenderer.on('update-server-path', (_evt, path) => {
  serverPath = path;
});

// Add handler for server settings updates
ipcRenderer.on('restore-server-settings', (_evt, settings) => {
  // Just pass it through to the renderer process
  // No need to store it here as we use the app store for persistence
});

// Add handler for server status updates
ipcRenderer.on('server-status', (_evt, status) => {
  // Relays to the renderer process via the exposed API
});

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // Add file path handling for dropped files
  invoke: (channel, ...args) => {
    // Log all requested channels for debugging
    console.log('Requested IPC channel:', channel);
    
    const validChannels = [
      'select-mod-files',
      'handle-dropped-files', 
      'get-dropped-file-paths',
      'save-temp-file',
      'direct-add-mod',
      'list-mods',
      'add-mod',
      'delete-mod',
      'search-mods',
      'install-mod',
      'get-mod-versions',
      'get-version-info',
      'get-installed-mod-info',
      'get-project-info',
      'select-folder',
      'get-last-server-path',
      'read-config',
      'save-version-selection',
      'write-eula',
      'start-server',
      'stop-server',
      'kill-server',
      'send-command',
      'download-minecraft-server',
      'download-and-install-fabric',
      'check-health',      
      'update-settings',
      'get-settings',
      'save-instances',
      'get-instances',
      'rename-instance',
      'delete-instance',
      'get-auto-restart',
      'set-auto-restart',
      'save-client-config',
      // Player management channels
      'read-players',
      'add-player',
      'remove-player',
      'get-server-status',
      // Folder and dialog operations
      'open-folder',
      'open-folder-direct',
      'show-confirmation-dialog',
      // World management
      'delete-world',
      // Repair operations
      'repair-health',
      'set-server-path',
      // Server properties management
      'read-server-properties',
      'write-server-properties',
      'generate-server-properties',
      'backups:create',
      'backups:list',
      'backups:delete',
      'backups:rename',
      'backups:restore',
      'backups:configure-automation',
      'backups:get-automation-settings',
      'backups:run-immediate-auto',
      'backups:safe-create',
      'save-mod-categories',
      'get-mod-categories',
      'move-mod-file',
      // Management server channels
      'start-management-server',
      'stop-management-server',
      'get-management-server-status',
      'update-management-server-path',
      // Minecraft launcher channels
      'minecraft-auth',
      'minecraft-load-auth',
      'minecraft-save-auth',
      'minecraft-download-mods',
      'minecraft-launch',
      'minecraft-stop',
      'minecraft-launcher-status',
      'minecraft-check-mods',
      'minecraft-check-client',
      'minecraft-download-client',
      'minecraft-clear-client',
      'toggle-client-mod',
      // Management server events
      'management-server-status',
      'management-server-path-updated',
      // Minecraft launcher events
      'launcher-auth-success',
      'launcher-auth-error',
      'launcher-download-start',
      'launcher-download-progress',
      'launcher-download-complete',
      'launcher-launch-start',
      'launcher-launch-progress',
      'launcher-launch-success',
      'launcher-launch-error',
      'launcher-minecraft-closed',
      'launcher-minecraft-stopped',
      'launcher-client-download-start',
      'launcher-client-download-progress',
      'launcher-client-download-complete',
      'launcher-client-download-error',
    ];

    // Debug: print validChannels at runtime
    console.log('Valid IPC channels at runtime:', validChannels);

    if (validChannels.includes(channel)) {
      console.log('invoke: validChannels =', validChannels, 'channel =', channel);
      // For dropped files, we need special handling
      if (channel === 'handle-dropped-files') {
        // Just forward the files directly to the main process
        // The main process will extract the paths
        return ipcRenderer.invoke(channel, args[0]);
      }
      return ipcRenderer.invoke(channel, ...args);
    }
    
    // Reject un-whitelisted channels
    return Promise.reject(new Error(`Channel not allowed: ${channel}`));
  },
  on: (channel, listener) => {
    const validChannels = [
      'server-log', 
      'server-status', 
      'metrics-update', 
      'download-progress',
      'player-update',
      'install-error',
      'update-server-path',
      'restore-server-settings',
      'minecraft-server-progress',
      'fabric-install-progress',
      'install-log',
      'repair-progress',
      'repair-log',
      'auto-restart-status',
      'mod-install-progress',
      'setup-progress',
      'backup-notification',
      // Management server events
      'management-server-status',
      'management-server-path-updated',
      // Minecraft launcher events
      'launcher-auth-success',
      'launcher-auth-error',
      'launcher-download-start',
      'launcher-download-progress',
      'launcher-download-complete',
      'launcher-launch-start',
      'launcher-launch-progress',
      'launcher-launch-success',
      'launcher-launch-error',
      'launcher-minecraft-closed',
      'launcher-minecraft-stopped',
      'launcher-client-download-start',
      'launcher-client-download-progress',
      'launcher-client-download-complete',
      'launcher-client-download-error',
    ];
    if (validChannels.includes(channel)) {
      // Correctly pass the event and arguments to the listener
      ipcRenderer.on(channel, (event, ...args) => listener(...args));
    }
  },
  removeListener: (channel, listener) => {
    const validChannels = [
      'server-log', 
      'server-status', 
      'metrics-update', 
      'download-progress',
      'player-update',
      'install-error',
      'update-server-path',
      'restore-server-settings',
      'minecraft-server-progress',
      'fabric-install-progress',
      'install-log',
      'repair-progress',
      'repair-log',
      'auto-restart-status',
      'mod-install-progress',
      'setup-progress',
      'backup-notification',
      // Management server events
      'management-server-status',
      'management-server-path-updated',
      // Minecraft launcher events
      'launcher-auth-success',
      'launcher-auth-error',
      'launcher-download-start',
      'launcher-download-progress',
      'launcher-download-complete',
      'launcher-launch-start',
      'launcher-launch-progress',
      'launcher-launch-success',
      'launcher-launch-error',
      'launcher-minecraft-closed',
      'launcher-minecraft-stopped',
      'launcher-client-download-start',
      'launcher-client-download-progress',
      'launcher-client-download-complete',
      'launcher-client-download-error',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeListener(channel, listener);
    }
  },
  removeAllListeners: (channel) => {
    const validChannels = [
      'server-log', 
      'server-status', 
      'metrics-update', 
      'download-progress',
      'player-update',
      'install-error',
      'update-server-path',
      'restore-server-settings',
      'minecraft-server-progress',
      'fabric-install-progress',
      'install-log',
      'repair-progress',
      'repair-log',
      'auto-restart-status',
      'mod-install-progress',
      'setup-progress',
      'backup-notification',
      // Management server events
      'management-server-status',
      'management-server-path-updated',
      // Minecraft launcher events
      'launcher-auth-success',
      'launcher-auth-error',
      'launcher-download-start',
      'launcher-download-progress',
      'launcher-download-complete',
      'launcher-launch-start',
      'launcher-launch-progress',
      'launcher-launch-success',
      'launcher-launch-error',
      'launcher-minecraft-closed',
      'launcher-minecraft-stopped',
      'launcher-client-download-start',
      'launcher-client-download-progress',
      'launcher-client-download-complete',
      'launcher-client-download-error',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  }
});

// Expose server path getter
contextBridge.exposeInMainWorld('serverPath', {
  get: () => ipcRenderer.invoke('get-last-server-path'),
  set: (path) => ipcRenderer.invoke('set-server-path', path)
});

// Add direct folder opening function
contextBridge.exposeInMainWorld('folderOpener', {
  open: (folderPath) => {
    console.log('[Preload] Folder opener called for path:', folderPath);
    return ipcRenderer.invoke('open-folder', folderPath);
  }
}); 