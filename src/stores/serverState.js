// Server state store
import { writable } from 'svelte/store';

// Create the server state store with default values
export const serverState = writable({
  status: 'Stopped',
  logs: [],
  cpuLoad: 0,
  memUsedMB: 0,
  maxRamMB: 0,
  uptime: '0h 0m 0s',
  port: 25565,
  maxRam: 4,
});

// Helper functions to update specific parts of the server state
export function updateServerMetrics(metrics) {
  serverState.update(state => {
    // Only update metrics if server is running or if explicitly zeroing them out
    if (state.status === 'Running' || 
        (metrics.cpuPct === 0 && metrics.memUsedMB === 0 && metrics.uptime === '0h 0m 0s')) {
      return {
        ...state,
        cpuLoad: metrics.cpuPct,
        memUsedMB: metrics.memUsedMB,
        maxRamMB: metrics.maxRamMB || (state.maxRam * 1024),
        uptime: metrics.uptime
      };
    }
    return state;
  });
}

// Performance optimization: batch log updates
const MAX_LOGS = 200;
let pendingLogs = [];
let updateTimeout = null;

// Ensure addServerLog efficiently handles log updates
export function addServerLog(logLine) {
  if (!logLine) return;
  
  // Add to pending logs
  pendingLogs.push(logLine);
  
  // If we have too many pending logs or no timeout is scheduled, process them
  if (pendingLogs.length >= 10 || !updateTimeout) {
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }
    
    // Schedule update for next frame
    updateTimeout = setTimeout(() => {
      if (pendingLogs.length === 0) return;
      
      // Update logs in batch
      serverState.update(state => {
        // Ensure we don't exceed our max logs limit
        const allLogs = [...state.logs, ...pendingLogs];
        const logs = allLogs.slice(-MAX_LOGS);
        
        // Clear pending logs
        pendingLogs = [];
        updateTimeout = null;
        
        return { ...state, logs };
      });
    }, 16); // ~60fps
  }
}

export function clearServerLogs() {
  pendingLogs = [];
  if (updateTimeout) {
    clearTimeout(updateTimeout);
    updateTimeout = null;
  }
  serverState.update(state => ({ ...state, logs: [] }));
}

export function updateServerStatus(status) {
  if (!status) return;
  serverState.update(state => ({ ...state, status }));
}
