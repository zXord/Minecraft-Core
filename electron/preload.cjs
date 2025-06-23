const { contextBridge, ipcRenderer } = require('electron');

let ipcChannelsLogged = false;
const listenerMap = new Map();

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // Add file path handling for dropped files
  invoke: (channel, ...args) => {
    // Log all requested channels for debugging
    
    const validChannels = [
      'select-mod-files',
      'handle-dropped-files', 
      'get-dropped-file-paths',
      'save-temp-file',      'direct-add-mod',
      'list-mods',
      'add-mod',
      'delete-mod',      'update-mod',
      'update-config',
      'search-mods',
      'install-mod',
      'install-client-mod',
      'get-mod-versions',
      'get-mod-info',
      'get-version-info',
      'get-installed-mod-info',
      'get-client-installed-mod-info',
      'get-project-info',
      'extract-jar-dependencies',
      'analyze-mod-from-url',
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
      'get-last-banned-player',
      // Folder and dialog operations
      'open-folder',
      'open-folder-direct',
      'show-confirmation-dialog',
      // World management
      'delete-world',
      // Repair operations
      'repair-health',
      'set-server-path',      // Server properties management
      'read-server-properties',
      'write-server-properties',
      'generate-server-properties',
      'restore-backup-properties',
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
      // Disabled mods management
      'save-disabled-mods',
      'get-disabled-mods',
      'check-mod-compatibility',
      'check-disabled-mod-updates',
      'enable-and-update-mod',
      // Management server channels
      'start-management-server',
      'stop-management-server',
      'get-management-server-status',
      'update-management-server-path',
      // Minecraft launcher channels
      'minecraft-auth',
      'minecraft-load-auth',
      'minecraft-save-auth',
      'minecraft-check-refresh-auth',
      'minecraft-download-mods',
      'minecraft-launch',
      'minecraft-stop',
      'minecraft-launcher-status',
      'minecraft-check-mods',
      'minecraft-check-client',
      'minecraft-check-client-sync',
      'minecraft-download-client',
      'minecraft-clear-client',
      'minecraft-get-status',      'toggle-client-mod',      'delete-client-mod',      'minecraft-remove-unmanaged-mods',
      'minecraft-remove-server-managed-mods',
      'minecraft-acknowledge-dependency',
      'load-expected-mod-state',
      // Manual mod management channels
      'check-manual-mods',
      'remove-manual-mods',
      'get-manual-mods-detailed',
      'check-manual-mod-updates',
      'toggle-manual-mod',      'update-manual-mod',
      'download-client-mod-version-updates',
      'clear-client-mod-cache',
      // Application lifecycle
      'app-close-response',
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
      // Application lifecycle events
      'app-close-request',
    ];

    if (!ipcChannelsLogged) {
      ipcChannelsLogged = true;
    }

    if (validChannels.includes(channel)) {
      // Only log failed channels, not successful ones
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
      'app-close-request',
    ];
    if (validChannels.includes(channel)) {
      // Wrap the listener so we can remove it later
      const wrapped = (_event, ...args) => listener(...args);
      if (!listenerMap.has(channel)) {
        listenerMap.set(channel, new Map());
      }
      listenerMap.get(channel).set(listener, wrapped);
      ipcRenderer.on(channel, wrapped);
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
      'app-close-request',
    ];
    if (validChannels.includes(channel)) {
      const map = listenerMap.get(channel);
      const wrapped = map && map.get(listener);
      if (wrapped) {
        ipcRenderer.removeListener(channel, wrapped);
        map.delete(listener);
        if (map.size === 0) {
          listenerMap.delete(channel);
        }
      }
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
      'app-close-request',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
      listenerMap.delete(channel);
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
  open: (folderPath) => ipcRenderer.invoke('open-folder', folderPath)
});
