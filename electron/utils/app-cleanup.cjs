// Application cleanup utilities
const { ipcMain } = require('electron');
const { safeSend } = require('./safe-send.cjs');
const process = require('process');
let isQuitting = false;

/**
 * Clear all application intervals and timers
 */
function clearAllIntervals() {
  
  try {
    // Clear server manager intervals
    const { clearIntervals: clearServerIntervals } = require('../services/server-manager.cjs');
    clearServerIntervals();
    
    // Clear management server intervals
    const { getManagementServer } = require('../services/management-server.cjs');
    const managementServer = getManagementServer();
    if (managementServer && managementServer.stopClientCleanup) {
      managementServer.stopClientCleanup();
    }
    
    // Clear backup intervals
    const { clearBackupIntervals } = require('../ipc/backup-handlers.cjs');
    clearBackupIntervals();
  } catch {
    // Backup service cleanup failed - non-critical
  }
}

/**
 * Complete application cleanup
 */
async function performCompleteCleanup() {
  
  try {
    // 1. Stop metrics reporting
    const { stopMetricsReporting } = require('../services/system-metrics.cjs');
    stopMetricsReporting();
    
    // 2. Clear all intervals
    clearAllIntervals();
    
    // 3. Kill Minecraft server if running
    const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
    const serverProcess = getServerProcess();
    if (serverProcess) {
      killMinecraftServer();
    }
    
  } catch {
    // Cleanup failed - non-critical
  }
}

function setupAppCleanup(app, win) {
  // Handle window close event to ensure server is stopped before app quits
  if (win) {
    win.on('close', async (e) => {
      if (!isQuitting) {
        e.preventDefault();
        
        // Import modules here to avoid circular dependencies
        const { getServerProcess } = require('../services/server-manager.cjs');
        const serverProcess = getServerProcess();

        if (serverProcess) {
          // Send a request to the renderer to ask the user
          const userConfirmed = await new Promise(resolve => {
            const handler = (_event, response) => {
              resolve(response);
              ipcMain.removeHandler('app-close-response');
            };
            ipcMain.handle('app-close-response', handler);
            safeSend('app-close-request');
          });

          if (userConfirmed) {
            try {
              await performCompleteCleanup();
              isQuitting = true;
              win.close();
            } catch {
              // Cleanup failed, but still quit
              isQuitting = true;
              win.close();
            }
          }
        } else {
          // No server running, just do cleanup
          try {
            await performCompleteCleanup();
          } catch {
            // Cleanup failed - non-critical
          }
          
          isQuitting = true;
          win.close();
        }
      }
    });
  }
  
  // Ensure all processes are cleaned up on quit
  app.on('quit', async () => {
    await performCompleteCleanup();
  });
  
  // Also handle SIGINT and SIGTERM signals (e.g. Ctrl+C in terminal)
  const signals = ['SIGINT', 'SIGTERM'];
  signals.forEach(signal => {
    process.on(signal, async () => {
      
      
      try {
        await performCompleteCleanup();
        
        // Allow a small delay for cleanup before exiting
        setTimeout(() => {
          process.exit(0);
        }, 1500);
      } catch {
        // Exit with error code if cleanup fails
        process.exit(1);
      }
    });
  });
}

module.exports = { setupAppCleanup, performCompleteCleanup, clearAllIntervals };
