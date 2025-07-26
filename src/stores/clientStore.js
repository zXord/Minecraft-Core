import { writable } from 'svelte/store';
import logger from '../utils/logger.js';

// Load initial state from localStorage if available
function loadInitialState() {
  const defaultState = {
    connectionStatus: 'disconnected',
    managementServerStatus: 'unknown',
    minecraftServerStatus: 'unknown',
    activeTab: 'play',
    lastKnownMinecraftVersion: null,
    versionChangeDetected: false,
    clientModVersionUpdates: null,
    // App version compatibility
    clientAppVersion: null,
    serverAppVersion: null,
    appVersionCompatible: true,
    appVersionMismatch: false
  };

  try {
    const stored = localStorage.getItem('clientState');
    if (stored) {
      const parsedState = JSON.parse(stored);
      // Merge with defaults to ensure all properties exist
      return { ...defaultState, ...parsedState };
    }
  } catch (err) {
    logger.error('Failed to load client state from localStorage', {
      category: 'store',
      data: {
        store: 'clientStore',
        function: 'loadInitialState',
        errorMessage: err.message
      }
    });
  }

  return defaultState;
}

export const clientState = writable(loadInitialState());

// Persist state changes to localStorage
function persistState(state) {
  try {
    const serializedState = JSON.stringify(state);
    localStorage.setItem('clientState', serializedState);
    
    logger.debug('Client state persisted to localStorage', {
      category: 'storage',
      data: {
        store: 'clientStore',
        function: 'persistState',
        stateSize: serializedState.length,
        stateKeys: Object.keys(state)
      }
    });
  } catch (err) {
    logger.error('Failed to persist client state to localStorage', {
      category: 'storage',
      data: {
        store: 'clientStore',
        function: 'persistState',
        errorType: err.constructor.name,
        errorMessage: err.message,
        stateKeys: Object.keys(state || {})
      }
    });
    
    // Attempt to clear corrupted state and retry with default
    try {
      localStorage.removeItem('clientState');
      logger.warn('Cleared corrupted client state from localStorage', {
        category: 'storage',
        data: {
          store: 'clientStore',
          function: 'persistState',
          action: 'cleared_corrupted_state'
        }
      });
    } catch (clearErr) {
      logger.error('Failed to clear corrupted client state', {
        category: 'storage',
        data: {
          store: 'clientStore',
          function: 'persistState',
          clearErrorType: clearErr.constructor.name,
          clearErrorMessage: clearErr.message
        }
      });
    }
  }
}

export function setConnectionStatus(status) {
  logger.info('Setting client connection status', {
    category: 'store',
    data: {
      store: 'clientStore',
      function: 'setConnectionStatus',
      newStatus: status
    }
  });
  
  clientState.update(s => {
    const oldStatus = s.connectionStatus;
    const newState = { ...s, connectionStatus: status };
    
    if (oldStatus !== status) {
      logger.info('Client connection status changed', {
        category: 'store',
        data: {
          store: 'clientStore',
          function: 'setConnectionStatus',
          oldStatus,
          newStatus: status
        }
      });
    }
    
    persistState(newState);
    return newState;
  });
}

export function setManagementServerStatus(status) {
  logger.info('Setting management server status', {
    category: 'client',
    data: {
      store: 'clientStore',
      function: 'setManagementServerStatus',
      newStatus: status
    }
  });
  
  clientState.update(s => {
    const oldStatus = s.managementServerStatus;
    const newState = { ...s, managementServerStatus: status };
    
    if (oldStatus !== status) {
      logger.info('Management server status changed', {
        category: 'client',
        data: {
          store: 'clientStore',
          function: 'setManagementServerStatus',
          oldStatus,
          newStatus: status
        }
      });
    }
    
    persistState(newState);
    return newState;
  });
}

export function setMinecraftServerStatus(status) {
  logger.info('Setting Minecraft server status', {
    category: 'server',
    data: {
      store: 'clientStore',
      function: 'setMinecraftServerStatus',
      newStatus: status
    }
  });
  
  clientState.update(s => {
    const oldStatus = s.minecraftServerStatus;
    const newState = { ...s, minecraftServerStatus: status };
    
    if (oldStatus !== status) {
      logger.info('Minecraft server status changed', {
        category: 'server',
        data: {
          store: 'clientStore',
          function: 'setMinecraftServerStatus',
          oldStatus,
          newStatus: status
        }
      });
    }
    
    persistState(newState);
    return newState;
  });
}

export function setActiveTab(tab) {
  logger.debug('Setting active tab', {
    category: 'ui',
    data: {
      store: 'clientStore',
      function: 'setActiveTab',
      newTab: tab
    }
  });
  
  clientState.update(s => {
    const oldTab = s.activeTab;
    const newState = { ...s, activeTab: tab };
    
    if (oldTab !== tab) {
      logger.info('Active tab changed', {
        category: 'ui',
        data: {
          store: 'clientStore',
          function: 'setActiveTab',
          oldTab,
          newTab: tab
        }
      });
    }
    
    persistState(newState);
    return newState;
  });
}

export function setMinecraftVersion(version) {
  logger.info('Setting Minecraft version', {
    category: 'store',
    data: {
      store: 'clientStore',
      function: 'setMinecraftVersion',
      newVersion: version
    }
  });
  
  clientState.update(s => {
    const versionChanged = s.lastKnownMinecraftVersion && s.lastKnownMinecraftVersion !== version;
    const newState = { 
      ...s, 
      lastKnownMinecraftVersion: version,
      versionChangeDetected: versionChanged,
      // Clear previous version update info when version changes
      clientModVersionUpdates: versionChanged ? null : s.clientModVersionUpdates
    };
    
    if (versionChanged) {
      logger.info('Minecraft version changed - version change detected', {
        category: 'store',
        data: {
          store: 'clientStore',
          function: 'setMinecraftVersion',
          oldVersion: s.lastKnownMinecraftVersion,
          newVersion: version,
          clearedModUpdates: !!s.clientModVersionUpdates
        }
      });
    }
    
    persistState(newState);
    return newState;
  });
}

export function setClientModVersionUpdates(updates) {
  logger.info('Setting client mod version updates', {
    category: 'mods',
    data: {
      store: 'clientStore',
      function: 'setClientModVersionUpdates',
      hasUpdates: !!updates,
      updateCount: updates ? Object.keys(updates).length : 0
    }
  });
  
  clientState.update(s => {
    const hadUpdates = !!s.clientModVersionUpdates;
    const hasUpdates = !!updates;
    const newState = { ...s, clientModVersionUpdates: updates };
    
    if (hadUpdates !== hasUpdates) {
      logger.info('Client mod version updates status changed', {
        category: 'mods',
        data: {
          store: 'clientStore',
          function: 'setClientModVersionUpdates',
          hadUpdates,
          hasUpdates,
          updateCount: updates ? Object.keys(updates).length : 0
        }
      });
    }
    
    persistState(newState);
    return newState;
  });
}

export function clearVersionChangeDetected() {
  logger.debug('Clearing version change detected flag', {
    category: 'client',
    data: {
      store: 'clientStore',
      function: 'clearVersionChangeDetected'
    }
  });
  
  clientState.update(s => {
    const wasDetected = s.versionChangeDetected;
    const newState = { ...s, versionChangeDetected: false };
    
    if (wasDetected) {
      logger.info('Version change detected flag cleared', {
        category: 'client',
        data: {
          store: 'clientStore',
          function: 'clearVersionChangeDetected',
          previouslyDetected: wasDetected
        }
      });
    }
    
    persistState(newState);
    return newState;
  });
}

export function setAppVersions(clientVersion, serverVersion) {
  const compatible = clientVersion === serverVersion;
  const mismatch = clientVersion && serverVersion && !compatible;
  
  logger.info('Setting app versions and compatibility', {
    category: 'store',
    data: {
      store: 'clientStore',
      function: 'setAppVersions',
      clientVersion,
      serverVersion,
      compatible,
      mismatch
    }
  });
  
  clientState.update(s => {
    const newState = { 
      ...s, 
      clientAppVersion: clientVersion,
      serverAppVersion: serverVersion,
      appVersionCompatible: compatible,
      appVersionMismatch: mismatch
    };
    
    if (mismatch) {
      logger.warn('App version mismatch detected', {
        category: 'store',
        data: {
          store: 'clientStore',
          function: 'setAppVersions',
          clientVersion,
          serverVersion
        }
      });
    }
    
    persistState(newState);
    return newState;
  });
}

export function clearAppVersions() {
  logger.info('Clearing app versions', {
    category: 'client',
    data: {
      store: 'clientStore',
      function: 'clearAppVersions'
    }
  });
  
  clientState.update(s => {
    const hadVersions = s.clientAppVersion || s.serverAppVersion;
    const hadMismatch = s.appVersionMismatch;
    const newState = { 
      ...s, 
      clientAppVersion: null,
      serverAppVersion: null,
      appVersionCompatible: true,
      appVersionMismatch: false
    };
    
    if (hadVersions || hadMismatch) {
      logger.info('App versions cleared', {
        category: 'client',
        data: {
          store: 'clientStore',
          function: 'clearAppVersions',
          hadVersions,
          hadMismatch
        }
      });
    }
    
    persistState(newState);
    return newState;
  });
}

// Function to validate and fix state inconsistencies
export function validateAndFixClientState() {
  logger.debug('Validating client state for inconsistencies', {
    category: 'client',
    data: {
      store: 'clientStore',
      function: 'validateAndFixClientState'
    }
  });
  
  clientState.update(s => {
    let hasInconsistencies = false;
    const fixes = [];
    let newState = { ...s };
    
    // Check for invalid connection status
    const validConnectionStatuses = ['connected', 'disconnected', 'connecting', 'error'];
    if (!validConnectionStatuses.includes(s.connectionStatus)) {
      hasInconsistencies = true;
      fixes.push(`Invalid connectionStatus: ${s.connectionStatus} -> disconnected`);
      newState.connectionStatus = 'disconnected';
    }
    
    // Check for invalid server statuses
    const validServerStatuses = ['unknown', 'starting', 'running', 'stopping', 'stopped', 'error'];
    if (!validServerStatuses.includes(s.managementServerStatus)) {
      hasInconsistencies = true;
      fixes.push(`Invalid managementServerStatus: ${s.managementServerStatus} -> unknown`);
      newState.managementServerStatus = 'unknown';
    }
    
    if (!validServerStatuses.includes(s.minecraftServerStatus)) {
      hasInconsistencies = true;
      fixes.push(`Invalid minecraftServerStatus: ${s.minecraftServerStatus} -> unknown`);
      newState.minecraftServerStatus = 'unknown';
    }
    
    // Check for invalid active tab
    const validTabs = ['play', 'mods', 'settings', 'console', 'backups'];
    if (!validTabs.includes(s.activeTab)) {
      hasInconsistencies = true;
      fixes.push(`Invalid activeTab: ${s.activeTab} -> play`);
      newState.activeTab = 'play';
    }
    
    // Check for inconsistent version change detection
    if (s.versionChangeDetected && !s.lastKnownMinecraftVersion) {
      hasInconsistencies = true;
      fixes.push('Version change detected without known version -> cleared');
      newState.versionChangeDetected = false;
    }
    
    // Check for inconsistent app version compatibility
    if (s.clientAppVersion && s.serverAppVersion) {
      const shouldBeCompatible = s.clientAppVersion === s.serverAppVersion;
      const shouldHaveMismatch = !shouldBeCompatible;
      
      if (s.appVersionCompatible !== shouldBeCompatible) {
        hasInconsistencies = true;
        fixes.push(`Inconsistent appVersionCompatible: ${s.appVersionCompatible} -> ${shouldBeCompatible}`);
        newState.appVersionCompatible = shouldBeCompatible;
      }
      
      if (s.appVersionMismatch !== shouldHaveMismatch) {
        hasInconsistencies = true;
        fixes.push(`Inconsistent appVersionMismatch: ${s.appVersionMismatch} -> ${shouldHaveMismatch}`);
        newState.appVersionMismatch = shouldHaveMismatch;
      }
    } else if (s.appVersionMismatch || !s.appVersionCompatible) {
      // If we don't have both versions, there shouldn't be a mismatch
      hasInconsistencies = true;
      fixes.push('App version mismatch without both versions -> reset to compatible');
      newState.appVersionCompatible = true;
      newState.appVersionMismatch = false;
    }
    
    if (hasInconsistencies) {
      logger.warn('Client state inconsistencies detected and fixed', {
        category: 'client',
        data: {
          store: 'clientStore',
          function: 'validateAndFixClientState',
          inconsistencyCount: fixes.length,
          fixes
        }
      });
      
      persistState(newState);
      return newState;
    } else {
      logger.debug('Client state validation passed - no inconsistencies found', {
        category: 'client',
        data: {
          store: 'clientStore',
          function: 'validateAndFixClientState'
        }
      });
    }
    
    return s;
  });
}

// Function to synchronize client configuration with server
export function synchronizeClientConfiguration(serverConfig) {
  logger.info('Synchronizing client configuration with server', {
    category: 'client',
    data: {
      store: 'clientStore',
      function: 'synchronizeClientConfiguration',
      hasServerConfig: !!serverConfig,
      configKeys: serverConfig ? Object.keys(serverConfig) : []
    }
  });
  
  try {
    clientState.update(s => {
      const changes = [];
      let newState = { ...s };
      
      if (serverConfig) {
        // Synchronize app versions if provided
        if (serverConfig.serverAppVersion && serverConfig.serverAppVersion !== s.serverAppVersion) {
          changes.push(`serverAppVersion: ${s.serverAppVersion} -> ${serverConfig.serverAppVersion}`);
          newState.serverAppVersion = serverConfig.serverAppVersion;
        }
        
        // Update compatibility based on synchronized versions
        if (newState.clientAppVersion && newState.serverAppVersion) {
          const compatible = newState.clientAppVersion === newState.serverAppVersion;
          const mismatch = !compatible;
          
          if (newState.appVersionCompatible !== compatible) {
            changes.push(`appVersionCompatible: ${newState.appVersionCompatible} -> ${compatible}`);
            newState.appVersionCompatible = compatible;
          }
          
          if (newState.appVersionMismatch !== mismatch) {
            changes.push(`appVersionMismatch: ${newState.appVersionMismatch} -> ${mismatch}`);
            newState.appVersionMismatch = mismatch;
          }
        }
        
        // Synchronize Minecraft version if provided
        if (serverConfig.minecraftVersion && serverConfig.minecraftVersion !== s.lastKnownMinecraftVersion) {
          const versionChanged = s.lastKnownMinecraftVersion && s.lastKnownMinecraftVersion !== serverConfig.minecraftVersion;
          changes.push(`lastKnownMinecraftVersion: ${s.lastKnownMinecraftVersion} -> ${serverConfig.minecraftVersion}`);
          newState.lastKnownMinecraftVersion = serverConfig.minecraftVersion;
          
          if (versionChanged) {
            changes.push(`versionChangeDetected: ${s.versionChangeDetected} -> true`);
            newState.versionChangeDetected = true;
            newState.clientModVersionUpdates = null; // Clear mod updates on version change
          }
        }
      }
      
      if (changes.length > 0) {
        logger.info('Client configuration synchronized with server', {
          category: 'client',
          data: {
            store: 'clientStore',
            function: 'synchronizeClientConfiguration',
            changeCount: changes.length,
            changes
          }
        });
        
        persistState(newState);
        return newState;
      } else {
        logger.debug('Client configuration already synchronized - no changes needed', {
          category: 'client',
          data: {
            store: 'clientStore',
            function: 'synchronizeClientConfiguration'
          }
        });
      }
      
      return s;
    });
  } catch (error) {
    logger.error(`Failed to synchronize client configuration: ${error.message}`, {
      category: 'client',
      data: {
        store: 'clientStore',
        function: 'synchronizeClientConfiguration',
        errorType: error.constructor.name,
        hasServerConfig: !!serverConfig
      }
    });
    throw error;
  }
}

// Function to clear persisted state
export function clearPersistedClientState() {
  logger.info('Clearing persisted client state', {
    category: 'storage',
    data: {
      store: 'clientStore',
      function: 'clearPersistedClientState'
    }
  });
  
  try {
    localStorage.removeItem('clientState');
    logger.info('Persisted client state cleared successfully', {
      category: 'storage',
      data: {
        store: 'clientStore',
        function: 'clearPersistedClientState'
      }
    });
  } catch (err) {
    logger.error('Failed to clear persisted client state', {
      category: 'storage',
      data: {
        store: 'clientStore',
        function: 'clearPersistedClientState',
        errorType: err.constructor.name,
        errorMessage: err.message
      }
    });
  }
}
