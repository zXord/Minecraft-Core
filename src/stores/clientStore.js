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
    clientModVersionUpdates: null
  };

  try {
    const stored = localStorage.getItem('clientState');
    if (stored) {
      const parsedState = JSON.parse(stored);
      // Merge with defaults to ensure all properties exist
      return { ...defaultState, ...parsedState };
    }
  } catch (error) {
    console.warn('Failed to load client state from localStorage:', error);
  }

  return defaultState;
}

export const clientState = writable(loadInitialState());

// Persist state changes to localStorage
function persistState(state) {
  try {
    localStorage.setItem('clientState', JSON.stringify(state));
  } catch (error) {
    console.warn('Failed to persist client state to localStorage:', error);
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

// Debug function to clear persisted state (for testing)
export function clearPersistedClientState() {
  try {
    localStorage.removeItem('clientState');
    console.log('Cleared persisted client state from localStorage');
  } catch (error) {
    console.warn('Failed to clear persisted client state:', error);
  }
}
