import { writable } from 'svelte/store';

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
  } catch (error) {
    // TODO: Add proper logging - Failed to load client state from localStorage
  }

  return defaultState;
}

export const clientState = writable(loadInitialState());

// Persist state changes to localStorage
function persistState(state) {
  try {
    localStorage.setItem('clientState', JSON.stringify(state));
  } catch (error) {
    // TODO: Add proper logging - Failed to persist client state to localStorage
  }
}

export function setConnectionStatus(status) {
  clientState.update(s => {
    const newState = { ...s, connectionStatus: status };
    persistState(newState);
    return newState;
  });
}

export function setManagementServerStatus(status) {
  clientState.update(s => {
    const newState = { ...s, managementServerStatus: status };
    persistState(newState);
    return newState;
  });
}

export function setMinecraftServerStatus(status) {
  clientState.update(s => {
    const newState = { ...s, minecraftServerStatus: status };
    persistState(newState);
    return newState;
  });
}

export function setActiveTab(tab) {
  clientState.update(s => {
    const newState = { ...s, activeTab: tab };
    persistState(newState);
    return newState;
  });
}

export function setMinecraftVersion(version) {
  clientState.update(s => {
    const versionChanged = s.lastKnownMinecraftVersion && s.lastKnownMinecraftVersion !== version;
    const newState = { 
      ...s, 
      lastKnownMinecraftVersion: version,
      versionChangeDetected: versionChanged,
      // Clear previous version update info when version changes
      clientModVersionUpdates: versionChanged ? null : s.clientModVersionUpdates
    };
    persistState(newState);
    return newState;
  });
}

export function setClientModVersionUpdates(updates) {
  clientState.update(s => {
    const newState = { ...s, clientModVersionUpdates: updates };
    persistState(newState);
    return newState;
  });
}

export function clearVersionChangeDetected() {
  clientState.update(s => {
    const newState = { ...s, versionChangeDetected: false };
    persistState(newState);
    return newState;
  });
}

export function setAppVersions(clientVersion, serverVersion) {
  clientState.update(s => {
    const compatible = clientVersion === serverVersion;
    const mismatch = clientVersion && serverVersion && !compatible;
    
    const newState = { 
      ...s, 
      clientAppVersion: clientVersion,
      serverAppVersion: serverVersion,
      appVersionCompatible: compatible,
      appVersionMismatch: mismatch
    };
    persistState(newState);
    return newState;
  });
}

export function clearAppVersions() {
  clientState.update(s => {
    const newState = { 
      ...s, 
      clientAppVersion: null,
      serverAppVersion: null,
      appVersionCompatible: true,
      appVersionMismatch: false
    };
    persistState(newState);
    return newState;
  });
}

// Function to clear persisted state
export function clearPersistedClientState() {
  try {
    localStorage.removeItem('clientState');
  } catch (error) {
    // TODO: Add proper logging - Failed to clear persisted client state
  }
}
