const { contextBridge, ipcRenderer } = require('electron');

let ipcChannelsLogged = false;
const listenerMap = new Map();

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // Add file path handling for dropped files
  invoke: (channel, ...args) => {
  
    
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
      'search-modrinth-matches',
      'get-modrinth-project-details',
      'search-modrinth-manual',
      'set-mod-pending-confirmation',
      'get-mod-pending-confirmation',
      'get-all-pending-confirmations',
      'get-all-confirmed-matches',
      'reset-matching-decision',
      'confirm-modrinth-match',
      'reject-modrinth-match',
      'get-mod-matching-status',
      'clear-mod-matching-data',
      'install-mod',
      'install-mod-with-fallback',
      'download-mod-from-server',
      'download-mod-from-fallback',
      'calculate-file-checksum',
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
      'backups:calculate-sizes',
      'backups:watch-size-changes',
      'backups:get-retention-settings',
      'backups:save-retention-settings',
      'backups:apply-retention-policy',
      'backups:validate-retention-policy',
      'backups:preview-retention-policy',
      'backups:get-size-cache-stats',
      'backups:invalidate-size-cache',
      'backups:check-size-alerts',
      'backups:get-performance-metrics',
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
    'set-management-server-external-host',
    'get-management-server-host-info',
      // Minecraft launcher channels
      'minecraft-auth',
      'minecraft-load-auth',
      'minecraft-save-auth',
      'minecraft-check-refresh-auth',
      'minecraft-clear-auth',
      'minecraft-download-mods',
      'minecraft-launch',
      'minecraft-stop',
      'minecraft-launcher-status',
      'minecraft-check-mods',
      'minecraft-check-client',
      'minecraft-check-client-sync',
      'minecraft-download-client',
      'minecraft-clear-client',
      'minecraft-clear-client-full',
      'minecraft-clear-assets',
      'minecraft-reset-launcher',
      'minecraft-get-status',
      'toggle-client-mod',      'delete-client-mod',      'minecraft-remove-unmanaged-mods',
      'get-download-preferences', 'set-download-preferences',
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
      // Server Java management channels
      'server-java-check-requirements',
      'server-java-ensure',
      'server-java-get-path',
      'server-java-get-available-versions',
      'server-java-is-available',
      // App settings channels
      'save-app-settings',
      'get-app-settings',
      'get-app-version',
      'check-for-updates',
      'set-window-size',
      'open-app-settings',
      // Update system channels
      'download-update',
      'install-update',
      'ignore-update',
      'remind-later',
      'set-auto-install',
      'get-update-status',
      'start-periodic-checks',
      'stop-periodic-checks',
      'check-for-specific-version',
      'download-specific-version',
      'get-current-version',
      'install-specific-version',
      'check-file-exists',
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
      // Logger channels
      'logger-get-logs',
      'logger-get-stats',
      'logger-clear-logs',
      'logger-export-logs',
      'logger-update-config',
      'logger-get-config',
      'logger-export-crash-report',
      'logger-add-log',
      'logger-search-logs',
      'logger-get-instances',
      'logger-get-categories',
      'logger-open-window',
      'logger-close-window',
      'logger-save-settings',
      'logger-get-settings',
      'logger-new-log',
      'logger-logs-cleared',
      'set-current-instance',
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
      'backup-size-changed',
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
      'server-java-download-progress',
      'app-close-request',
      // App settings events
      'open-app-settings-modal',
      // Update system events
      'update-checking-for-update',
      'update-available',
      'update-not-available',
      'update-error',
      'update-download-progress',
      'update-downloaded',
      'update-ignored',
      // Specific version download events
      'specific-version-download-progress',
      'specific-version-download-complete',
      'specific-version-download-error',
      // Debug console events
      'debug-log',
      'logger-new-log',
      'logger-logs-cleared',
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
      'backup-size-changed',
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
      'server-java-download-progress',
      'app-close-request',
      // Update system events
      'update-checking-for-update',
      'update-available',
      'update-not-available',
      'update-error',
      'update-download-progress',
      'update-downloaded',
      'update-ignored',
      // Specific version download events
      'specific-version-download-progress',
      'specific-version-download-complete',
      'specific-version-download-error',
      // Debug console events
      'debug-log',
      'logger-new-log',
      'logger-logs-cleared',
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
      'backup-size-changed',
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
      'server-java-download-progress',
      'app-close-request',
      // Update system events
      'update-checking-for-update',
      'update-available',
      'update-not-available',
      'update-error',
      'update-download-progress',
      'update-downloaded',
      'update-ignored',
      // Specific version download events
      'specific-version-download-progress',
      'specific-version-download-complete',
      'specific-version-download-error',
      // Debug console events
      'debug-log',
      'logger-new-log',
      'logger-logs-cleared',
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
