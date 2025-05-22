// Settings state store
import { writable } from 'svelte/store';

// Create the settings store with default values
export const settingsStore = writable({
  // Server configuration
  port: 25565,
  maxRam: 4,
  path: '',
  
  // Minecraft and Fabric versions
  mcVersion: null,
  fabricVersion: null,
  
  // Auto-restart configuration
  autoRestart: {
    enabled: false,
    delay: 10,
    maxCrashes: 3,
    crashCount: 0
  },
  
  // UI state
  isDarkMode: true,
  consoleAutoScroll: true
});

// Helper functions to update parts of the settings
export function updateServerSettings(settings) {
  if (!settings) return;
  
  settingsStore.update(state => ({
    ...state,
    port: settings.port || state.port,
    maxRam: settings.maxRam || state.maxRam,
    path: settings.path || state.path,
  }));
}

export function updateVersions(mcVersion, fabricVersion) {
  settingsStore.update(state => ({
    ...state,
    mcVersion: mcVersion || state.mcVersion,
    fabricVersion: fabricVersion || state.fabricVersion
  }));
}

export function updateAutoRestartSettings(settings) {
  if (!settings) return;
  
  settingsStore.update(state => ({
    ...state,
    autoRestart: {
      ...state.autoRestart,
      enabled: settings.enabled !== undefined ? settings.enabled : state.autoRestart.enabled,
      delay: settings.delay || state.autoRestart.delay,
      maxCrashes: settings.maxCrashes || state.autoRestart.maxCrashes,
      crashCount: settings.crashCount !== undefined ? settings.crashCount : state.autoRestart.crashCount
    }
  }));
}

export function loadSettings(config) {
  if (!config) return;
  
  settingsStore.update(state => ({
    ...state,
    mcVersion: config.version || state.mcVersion,
    fabricVersion: config.fabric || state.fabricVersion,
    autoRestart: {
      ...state.autoRestart,
      enabled: config.autoRestart?.enabled ?? state.autoRestart.enabled,
      delay: config.autoRestart?.delay ?? state.autoRestart.delay,
      maxCrashes: config.autoRestart?.maxCrashes ?? state.autoRestart.maxCrashes
    }
  }));
}
