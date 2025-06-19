import { writable } from 'svelte/store';

export const clientState = writable({
  connectionStatus: 'disconnected',
  managementServerStatus: 'unknown',
  minecraftServerStatus: 'unknown',
  activeTab: 'play',
  lastKnownMinecraftVersion: null,
  versionChangeDetected: false,
  clientModVersionUpdates: null
});

export function setConnectionStatus(status) {
  clientState.update(s => ({ ...s, connectionStatus: status }));
}

export function setManagementServerStatus(status) {
  clientState.update(s => ({ ...s, managementServerStatus: status }));
}

export function setMinecraftServerStatus(status) {
  clientState.update(s => ({ ...s, minecraftServerStatus: status }));
}

export function setActiveTab(tab) {
  clientState.update(s => ({ ...s, activeTab: tab }));
}

export function setMinecraftVersion(version) {
  clientState.update(s => {
    const versionChanged = s.lastKnownMinecraftVersion && s.lastKnownMinecraftVersion !== version;
    return { 
      ...s, 
      lastKnownMinecraftVersion: version,
      versionChangeDetected: versionChanged,
      // Clear previous version update info when version changes
      clientModVersionUpdates: versionChanged ? null : s.clientModVersionUpdates
    };
  });
}

export function setClientModVersionUpdates(updates) {
  clientState.update(s => ({ ...s, clientModVersionUpdates: updates }));
}

export function clearVersionChangeDetected() {
  clientState.update(s => ({ ...s, versionChangeDetected: false }));
}
