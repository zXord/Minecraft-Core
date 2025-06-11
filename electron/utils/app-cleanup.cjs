// Application cleanup utilities
const { ipcMain } = require('electron');
const { safeSend } = require('./safe-send.cjs');
const process = require('process');
let isQuitting = false;

function setupAppCleanup(app, win) {
  // Handle window close event to ensure server is stopped before app quits
  if (win) {
    win.on('close', async (e) => {
      if (!isQuitting) {
        e.preventDefault();
        
        // Import modules here to avoid circular dependencies
        const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
        const { stopMetricsReporting } = require('../services/system-metrics.cjs');
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
              // Stop metrics reporting before closing
              stopMetricsReporting();
              
              killMinecraftServer();
              await new Promise(resolve => setTimeout(resolve, 500));
              isQuitting = true;
              win.close();
            } catch (err) {
              console.error(err);
              isQuitting = true;
              win.close();
            }
          }
        } else {
          // Stop metrics reporting even if no server is running
          stopMetricsReporting();
          
          isQuitting = true;
          win.close();
        }
      }
    });
  }
  
  // Ensure all processes are cleaned up on quit
  app.on('quit', () => {
    try {
      // Import modules here to avoid circular dependencies
      const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
      const { stopMetricsReporting } = require('../services/system-metrics.cjs');
      
      // Stop metrics reporting
      stopMetricsReporting();
      
      const serverProcess = getServerProcess();
      if (serverProcess) {
        killMinecraftServer();
      }
    } catch (err) {
      console.error(err);
    }
  });
  
  // Also handle SIGINT and SIGTERM signals (e.g. Ctrl+C in terminal)
  const signals = ['SIGINT', 'SIGTERM'];
  signals.forEach(signal => {
    process.on(signal, () => {
      try {
        // Import modules here to avoid circular dependencies
        const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
        const { stopMetricsReporting } = require('../services/system-metrics.cjs');
        
        // Stop metrics reporting
        stopMetricsReporting();
        
        const serverProcess = getServerProcess();
        if (serverProcess) {
          killMinecraftServer();
        }
        
        // Allow a small delay for cleanup before exiting
        setTimeout(() => {
          process.exit(0);
        }, 500);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });
  });
}

module.exports = { setupAppCleanup };
