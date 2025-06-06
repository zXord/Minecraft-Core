import { writable } from 'svelte/store';

export const clientState = writable({
  connectionStatus: 'disconnected',
  managementServerStatus: 'unknown',
  minecraftServerStatus: 'unknown',
  activeTab: 'play'
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
